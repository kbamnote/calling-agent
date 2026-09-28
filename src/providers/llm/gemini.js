/**
 * Google Gemini LLM driver.
 *
 * Uses plain fetch against the v1beta REST API rather than the SDK, to keep this
 * service's dependency list to three packages. Gemini is the default recommended
 * provider because its free tier is enough to test a real Hinglish conversation
 * without a card on file.
 *
 * Contract (shared by every driver in this folder):
 *   chat({ system, messages, tools, maxTokens })
 *     -> { text, toolCalls: [{ id, name, args }], usage: { in, out, cached } }
 */
// Google retires model aliases, and a retired one is a hard 404 on every turn —
// the agent cannot speak at all. Override with LLM_MODEL without touching code;
// /diagnostics reports the exact replacement Google names in the error.
const DEFAULT_MODEL = 'gemini-3.8-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const { retryingFetch } = require('../../util/http');

/**
 * Gemini accepts an OpenAPI-flavoured subset of JSON Schema and rejects the
 * request outright on keys it does not know (`additionalProperties`, `$schema`,
 * `default`). Strip rather than pass through.
 */
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['additionalProperties', '$schema', 'default', 'examples', 'title'].includes(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

/**
 * Our neutral message list -> Gemini `contents`.
 *
 * ── THOUGHT SIGNATURES ───────────────────────────────────────────────────────
 * A reasoning model returns an opaque `thoughtSignature` alongside each
 * functionCall, and REQUIRES it back when that call is replayed in the history.
 * Reconstructing the part by hand drops it, and the next turn fails with
 * "Function call is missing a thought_signature" — so tool use works for exactly
 * one turn and then the conversation dies.
 *
 * Rather than trying to mirror every field Google may add, the assistant turn is
 * replayed VERBATIM from the parts the model gave us (`m.raw`). Reconstruction
 * is only a fallback for history that predates this, or from another provider.
 */
function toContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      if (m.raw && Array.isArray(m.raw.parts) && m.raw.parts.length) {
        contents.push({ role: 'model', parts: m.raw.parts });
        continue;
      }
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls || []) {
        const part = { functionCall: { name: tc.name, args: tc.args || {} } };
        // Both spellings seen in the wild; echo back whichever we were given.
        if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
        parts.push(part);
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      // A tool result is delivered as a user-role functionResponse part.
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: m.name,
            // Gemini requires an object here; primitives are rejected.
            response: (m.content && typeof m.content === 'object') ? m.content : { result: m.content },
          },
        }],
      });
    }
  }
  return contents;
}

function create(config) {
  const model = config.llm.model || DEFAULT_MODEL;
  const key = config.llm.geminiKey;

  return {
    name: 'gemini',
    model,

    async chat({ system, messages, tools = [], maxTokens }) {
      if (!key) throw new Error('GEMINI_API_KEY is not set');

      const body = {
        contents: toContents(messages),
        generationConfig: {
          maxOutputTokens: maxTokens || config.llm.maxTokens,
          // Low but not zero: a sales conversation that says the identical
          // sentence every call sounds like an IVR. The guardrails live in the
          // prompt and the tools, not in the temperature.
          temperature: 0.6,
        },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (tools.length) {
        body.tools = [{
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: cleanSchema(t.parameters),
          })),
        }];
      }

      // Retried: a 503 "high demand" mid-call is a hiccup, not a reason to
      // abandon the conversation.
      const res = await retryingFetch(
        `${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { label: 'Gemini', attempts: 3, timeoutMs: 20000 },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${detail.slice(0, 400)}`);
      }

      const json = await res.json();
      const cand = (json.candidates || [])[0];
      const parts = (cand && cand.content && cand.content.parts) || [];

      let text = '';
      const toolCalls = [];
      parts.forEach((p, i) => {
        if (p.text) text += p.text;
        if (p.functionCall) {
          toolCalls.push({
            id: 'gm_' + Date.now() + '_' + i,
            name: p.functionCall.name,
            args: p.functionCall.args || {},
            thoughtSignature: p.thoughtSignature || p.thought_signature,
          });
        }
      });

      const u = json.usageMetadata || {};
      return {
        text: text.trim(),
        toolCalls,
        // The model's own parts, replayed verbatim on the next turn so nothing
        // Google attaches to them (thought signatures today, whatever comes
        // next) is lost in translation.
        raw: { parts },
        usage: {
          in: u.promptTokenCount || 0,
          out: u.candidatesTokenCount || 0,
          cached: u.cachedContentTokenCount || 0,
        },
        finishReason: cand && cand.finishReason,
      };
    },
  };
}

module.exports = { create, DEFAULT_MODEL };
