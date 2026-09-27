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

/** Our neutral message list -> Gemini `contents`. */
function toContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls || []) {
        parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
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

      const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

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
          });
        }
      });

      const u = json.usageMetadata || {};
      return {
        text: text.trim(),
        toolCalls,
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
