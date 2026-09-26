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

function create(config) {
  const model = config.llm.model || DEFAULT_MODEL;
  const baseUrl = config.llm.openaiBaseUrl.replace(/\/$/, '');
  const key = config.llm.openaiKey;

  return {
    name: 'openai',
    model,

    async chat({ system, messages, tools = [], maxTokens }) {
      if (!key) throw new Error('OPENAI_API_KEY is not set');

      const body = {
        model,
        messages: toMessages(system, messages),
        max_tokens: maxTokens || config.llm.maxTokens,
        temperature: 0.6,
      };
      if (tools.length) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = 'auto';
      }

      const res = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${detail.slice(0, 400)}`);
      }

      const json = await res.json();
      const choice = (json.choices || [])[0] || {};
      const msg = choice.message || {};

      const toolCalls = (msg.tool_calls || []).map((tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch (e) {
          // A model can emit malformed JSON. Surfacing it as an empty arg set
          // lets the tool layer reject it with a clear message, which the model
          // can then correct — better than crashing the call.
          args = { _parseError: String(tc.function.arguments || '').slice(0, 200) };
        }
        return { id: tc.id, name: tc.function.name, args };
      });

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
