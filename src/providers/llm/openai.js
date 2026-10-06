/**
 * OpenAI-compatible LLM driver.
 *
 * Works unchanged against OpenAI, Groq, Together, OpenRouter, DeepInfra, and a
 * local Ollama or llama.cpp server — they all speak /chat/completions. Set
 * OPENAI_BASE_URL and you have switched vendor without touching this file.
 *
 * For a local Ollama:
 *   OPENAI_BASE_URL=http://localhost:11434/v1
 *   OPENAI_API_KEY=ollama
 *   LLM_MODEL=qwen2.5:7b-instruct
 */
const DEFAULT_MODEL = 'gpt-4o-mini';

// How long we will sit on a vendor's Retry-After DURING A LIVE CALL.
//
// Groq answers a rate limit with "try again in 8s". Honouring that literally
// produced a nineteen-second turn on a real call — two six-second waits and a
// retry — while the customer held a silent phone. A caller will wait a second;
// they will not wait for a quota window. Past this cap the engine stops
// retrying, says one short line, and lets their next sentence start a fresh
// turn, by which point the window has usually moved on.
const LLM_RETRY_AFTER_CAP = Number(process.env.LLM_RETRY_AFTER_MS) || 1200;
const { retryingFetch } = require('../../util/http');

function toMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if ((m.toolCalls || []).length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        name: m.name,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    }
  }
  return out;
}

/** Shapes one accumulated tool call the way the engine expects. */
function finishToolCall(tc) {
  let args = {};
  try {
    args = JSON.parse(tc.arguments || '{}');
  } catch (e) {
    // A model can emit malformed JSON. Surfacing it as an empty arg set lets the
    // tool layer reject it with a clear message the model can correct — better
    // than crashing the call.
    args = { _parseError: String(tc.arguments || '').slice(0, 200) };
  }
  return { id: tc.id, name: tc.name, args };
}

/**
 * Reads an OpenAI-style SSE body, calling back on each delta.
 *
 * Written by hand rather than pulled from an SDK because this driver has no SDK
 * — it is plain fetch against /chat/completions, which is what lets one file
 * serve OpenAI, Groq, Together, OpenRouter and a local Ollama.
 *
 * `stallMs` matters more than it looks: util/http.js clears its abort timer the
 * moment response HEADERS arrive, so without a guard here a vendor that accepts
 * the request and then stops sending tokens would hang the turn forever, and the
 * caller would hear silence until the call's own duration budget killed it.
 */
async function readStream(res, { onDelta, onFirstToken, onToolCallStart, stallMs }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let text = '';
  let firstTokenSeen = false;
  let finishReason = null;
  let usage = null;
  // Keyed by the `index` the vendor assigns, because arguments arrive as string
  // fragments spread over many deltas and must be reassembled per call.
  const toolCalls = new Map();

  try {
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('LLM stream stalled for ' + stallMs + 'ms')), stallMs,
        )),
      ]);
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });

      // SSE events are separated by a blank line. Anything after the last one is
      // a partial event and stays in the buffer for the next read.
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        for (const rawLine of event.split('\n')) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          let json;
          try { json = JSON.parse(payload); } catch (e) { continue; }

          // Sent on the final chunk when stream_options.include_usage is
          // honoured. Without it the cost ledger would silently record zeros.
          if (json.usage) usage = json.usage;

          const choice = (json.choices || [])[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta || {};
          if (delta.content) {
            if (!firstTokenSeen) { firstTokenSeen = true; if (onFirstToken) onFirstToken(); }
            text += delta.content;
            if (onDelta) onDelta(delta.content, text);
          }
          if ((delta.tool_calls || []).length && !toolCalls.size && onToolCallStart) {
            // The earliest possible signal about what this round is doing. The
            // NAME matters, not just that a tool was called: the engine speaks
            // through a background write and stops dead for a blocking read, and
            // this fragment is the first moment it can tell the two apart.
            const first = delta.tool_calls[0];
            onToolCallStart((first.function && first.function.name) || null);
          }
          for (const tc of delta.tool_calls || []) {
            const i = tc.index === undefined ? 0 : tc.index;
            const cur = toolCalls.get(i) || { id: '', name: '', arguments: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function && tc.function.name) cur.name = tc.function.name;
            if (tc.function && tc.function.arguments) cur.arguments += tc.function.arguments;
            toolCalls.set(i, cur);
          }
        }
      }
    }
  } finally {
    // A stall rejects while the body is still open; without this the socket is
    // held until GC and the connection never returns to the pool.
    try { await reader.cancel(); } catch (e) { /* already closed */ }
  }

  const u = usage || {};
  return {
    text: text.trim(),
    toolCalls: [...toolCalls.values()].filter((t) => t.name).map(finishToolCall),
    usage: {
      in: u.prompt_tokens || 0,
      out: u.completion_tokens || 0,
      cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    },
    finishReason,
  };
}

function create(config) {
  const model = config.llm.model || DEFAULT_MODEL;
  const baseUrl = config.llm.openaiBaseUrl.replace(/\/$/, '');
  const key = config.llm.openaiKey;

  /** The request body, identical either way apart from the streaming flags. */
  function buildBody({ system, messages, tools, maxTokens, stream }) {
    const body = {
      model,
      messages: toMessages(system, messages),
      max_tokens: maxTokens || config.llm.maxTokens,
      temperature: 0.6,
    };

    // gpt-oss reasons before it answers, and Groq's default effort is 'medium'.
    // On a live call that measured 423 OUTPUT tokens for a two-sentence reply
    // and 1466ms before the first token — all of it thinking the caller sits
    // through. This is a check-in call, not a maths problem: there is nothing
    // here worth reasoning about at length.
    //
    // Sent only to models that accept it; an unknown field is a 400 that would
    // take every call down. Set LLM_REASONING_EFFORT=none to stop sending it.
    const effort = process.env.LLM_REASONING_EFFORT || 'low';
    // Qwen3 is a HYBRID reasoning model: left alone it thinks before every
    // reply. On a scripted check-in call that is dead air the caller sits
    // through, and the thinking can land in the spoken content. Groq takes
    // reasoning_effort='none' to switch it off outright, which is what this
    // wants — there is no amount of it worth paying for here.
    if (effort !== 'none') {
      if (/qwen3/i.test(model)) body.reasoning_effort = 'none';
      else if (/gpt-oss|\bo[13]\b|reasoning/i.test(model)) body.reasoning_effort = effort;
    }
    if (tools.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (stream) {
      body.stream = true;
      // Standard OpenAI field, honoured by Groq and the other compatible
      // vendors. A server that ignores it simply returns no usage and the
      // ledger records zeros for that turn; one that REJECTS it 400s, which the
      // engine catches and falls back to a non-streaming call.
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  return {
    name: 'openai',
    model,
    // Read by the engine to decide whether it can overlap synthesis with
    // generation. Nothing outside the driver knows how this vendor streams.
    supportsStreaming: true,

    /**
     * Streaming completion. Same return shape as chat(), so a caller that only
     * wants the finished answer can use either without branching.
     *
     * @param {Function} [o.onFirstToken] fired once, when generation actually
     *   starts — the only honest measure of model latency, since time-to-first-
     *   token and time-to-completion differ by seconds on a long reply.
     * @param {Function} [o.onDelta] (piece, textSoFar) — lets the engine start
     *   synthesising a sentence before the model has written the next one.
     */
    async chatStream({
      system, messages, tools = [], maxTokens, onFirstToken, onDelta, onToolCallStart,
    }) {
      if (!key) throw new Error('OPENAI_API_KEY is not set');

      const res = await retryingFetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(buildBody({ system, messages, tools, maxTokens, stream: true })),
      }, { label: 'LLM(stream)', attempts: 2, timeoutMs: 20000, maxRetryAfterMs: LLM_RETRY_AFTER_CAP });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${detail.slice(0, 400)}`);
      }
      if (!res.body) throw new Error('LLM returned no stream body');

      return readStream(res, { onDelta, onFirstToken, onToolCallStart, stallMs: 15000 });
    },

    async chat({ system, messages, tools = [], maxTokens }) {
      if (!key) throw new Error('OPENAI_API_KEY is not set');

      const res = await retryingFetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(buildBody({ system, messages, tools, maxTokens, stream: false })),
      }, { label: 'LLM', attempts: 3, timeoutMs: 20000, maxRetryAfterMs: LLM_RETRY_AFTER_CAP });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${detail.slice(0, 400)}`);
      }

      const json = await res.json();
      const choice = (json.choices || [])[0] || {};
      const msg = choice.message || {};

      const toolCalls = (msg.tool_calls || []).map((tc) => finishToolCall({
        id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
      }));

      const u = json.usage || {};
      return {
        text: (msg.content || '').trim(),
        toolCalls,
        usage: {
          in: u.prompt_tokens || 0,
          out: u.completion_tokens || 0,
          cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
        },
        finishReason: choice.finish_reason,
      };
    },
  };
}

module.exports = { create, DEFAULT_MODEL };
