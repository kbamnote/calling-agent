/**
 * Configuration — one place, read once at boot.
 *
 * Every value has a default that works with no keys, no CRM and no telephony
 * account, because a voice agent you cannot run locally is a voice agent nobody
 * will iterate on.
 */
require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

const config = {
  port: num(process.env.PORT, 5010),
  logLevel: process.env.LOG_LEVEL || 'info',
  env: process.env.NODE_ENV || 'development',
  // Gates the browser tester. Starting a call from it spends LLM and TTS budget,
  // so a deployed instance must not leave that open to anyone who finds the URL.
  // Required in production; optional on localhost.
  testerToken: process.env.TESTER_TOKEN || '',
  // Public origin, for the websocket URL the answer XML hands the provider.
  // Normally derived from the proxy headers — set this only when you are behind
  // something that does not send them.
  publicUrl: process.env.PUBLIC_URL || '',

  llm: {
    provider: process.env.LLM_PROVIDER || 'mock',
    model: process.env.LLM_MODEL || '',
    // Reasoning models spend output tokens THINKING before they write a word,
    // so a budget tuned for the spoken answer alone returns nothing at all
    // (finishReason MAX_TOKENS) — dead air on a call. The persona still keeps
    // replies to a sentence or two; this is headroom, not permission to ramble.
    maxTokens: num(process.env.LLM_MAX_TOKENS, 800),
    // Stream the reply so synthesis can start on the first finished sentence
    // instead of waiting for the last one. Worth several seconds per turn — see
    // pipeline/speechPipe.js. Set false to fall back to one blocking request;
    // the engine also falls back on its own if a stream errors, so this is a
    // switch for diagnosing a vendor, not a safety net.
    streaming: bool(process.env.LLM_STREAMING, true),
    // Let write tools (feedback, queries, lead updates) run while the agent is
    // already speaking, instead of making the caller wait for a CRM round-trip
    // and a second model call to hear a reply the agent had all along. Set false
    // to restore the old strictly-sequential behaviour — which is also how the
    // benchmark measures what this is worth. See tools/index.js BLOCKING_TOOLS.
    backgroundTools: bool(process.env.TOOLS_BACKGROUND, true),
    geminiKey: process.env.GEMINI_API_KEY || '',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },

  stt: {
    provider: process.env.STT_PROVIDER || 'browser',
    language: process.env.STT_LANGUAGE || 'hi-IN',
    deepgramKey: process.env.DEEPGRAM_API_KEY || '',
    sarvamKey: process.env.SARVAM_API_KEY || '',
    // Whisper on Groq reuses OPENAI_API_KEY and OPENAI_BASE_URL's host; this is
    // only for pointing at a different OpenAI-compatible transcription server.
    groqBaseUrl: process.env.GROQ_STT_BASE_URL || '',
  },

  tts: {
    provider: process.env.TTS_PROVIDER || 'browser',
    voice: process.env.TTS_VOICE || '',
    elevenLabsKey: process.env.ELEVENLABS_API_KEY || '',
    sarvamKey: process.env.SARVAM_API_KEY || '',
    rumikKey: process.env.RUMIK_API_KEY || '',
    // A standby voice, used only when the primary hard-fails. Worth setting:
    // Sarvam answered `402 Credits exhausted` mid-session, and with one driver
    // that is a dialled call where nobody ever speaks.
    fallbackProvider: process.env.TTS_FALLBACK_PROVIDER || '',
  },

  crm: {
    enabled: bool(process.env.CRM_ENABLED, false),
    baseUrl: (process.env.CRM_BASE_URL || 'http://localhost:5000').replace(/\/$/, ''),
    serviceKey: process.env.AGENT_SERVICE_KEY || '',
  },

  limits: {
    // A BACKSTOP, not the thing that ends calls. Cut to 8 when the model
    // would not close on its own; now that the close is governed properly
    // the budget started cutting GOOD calls instead — one ended at 87s on
    // "mujhe nahi pata kaise add karna hai?", an engaged customer asking
    // for help. A hard limit has to stay hard, so it is raised rather than
    // made conditional.
    maxTurns: num(process.env.MAX_TURNS, 12),
    maxCallSeconds: num(process.env.MAX_CALL_SECONDS, 300),
    silenceHangupSeconds: num(process.env.SILENCE_HANGUP_SECONDS, 12),
    greetingGate: bool(process.env.GREETING_GATE, true),
  },

  telephony: {
    provider: process.env.TELEPHONY_PROVIDER || 'none',
    webhookSecret: process.env.TELEPHONY_WEBHOOK_SECRET || '',
  },

  // Outbound dialling. Separate from the inbound stream credentials because
  // placing a call needs the REST API, which inbound never touches.
  plivo: {
    authId: process.env.PLIVO_AUTH_ID || '',
    authToken: process.env.PLIVO_AUTH_TOKEN || '',
    fromNumber: process.env.PLIVO_FROM_NUMBER || '',
  },

  // Planning estimates for the cost ledger. NOT vendor quotes — replace with
  // contracted rates before anyone reports these numbers upward.
  rates: {
    telephonyPerMin: num(process.env.RATE_TELEPHONY_INR_PER_MIN, 0.45),
    sttPerMin: num(process.env.RATE_STT_INR_PER_MIN, 0.60),
    ttsPer1kChars: num(process.env.RATE_TTS_INR_PER_1K_CHARS, 1.20),
    llmPer1kIn: num(process.env.RATE_LLM_INR_PER_1K_IN, 0.02),
    llmPer1kOut: num(process.env.RATE_LLM_INR_PER_1K_OUT, 0.08),
  },
};

/**
 * Problems worth knowing about at boot rather than mid-call. Returned rather
 * than thrown: a missing production key must not stop someone testing with mocks.
 */
config.warnings = () => {
  const w = [];
  if (config.llm.provider === 'gemini' && !config.llm.geminiKey) {
    w.push('LLM_PROVIDER=gemini but GEMINI_API_KEY is empty — get a free key at https://aistudio.google.com/apikey');
  }
  if (config.llm.provider === 'openai' && !config.llm.openaiKey) {
    w.push('LLM_PROVIDER=openai but OPENAI_API_KEY is empty');
  }
  if (config.stt.provider === 'deepgram' && !config.stt.deepgramKey) w.push('STT_PROVIDER=deepgram but DEEPGRAM_API_KEY is empty');
  if (config.stt.provider.startsWith('sarvam') && !config.stt.sarvamKey) {
    w.push('STT_PROVIDER=' + config.stt.provider + ' but SARVAM_API_KEY is empty');
  }
  if (config.stt.provider === 'sarvam_realtime') {
    w.push('STT_PROVIDER=sarvam_realtime — transcribes while the caller speaks, but this protocol has not been run against a live key. Check /diagnostics before a real call.');
  }
  if (config.stt.provider === 'groq' && !config.llm.openaiKey) {
    w.push('STT_PROVIDER=groq but OPENAI_API_KEY is empty — Whisper on Groq uses the same key as the model');
  }
  if (config.tts.provider === 'elevenlabs' && !config.tts.elevenLabsKey) w.push('TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is empty');
  if (config.tts.provider.startsWith('sarvam') && !config.tts.sarvamKey) {
    w.push('TTS_PROVIDER=' + config.tts.provider + ' but SARVAM_API_KEY is empty');
  }
  if (config.tts.provider === 'rumik' && !config.tts.rumikKey) {
    w.push('TTS_PROVIDER=rumik but RUMIK_API_KEY is empty');
  }
  if (config.tts.provider === 'rumik') {
    w.push('TTS_PROVIDER=rumik — 24kHz output, resampled to the transport rate. Measured 840ms to first audio from an asia-southeast region, against 4096ms for the SAME code and settings from the previous region. If this ever reads slow again, check where the service is deployed before changing anything in the code.');
  }
  if (config.tts.provider === 'sarvam_stream') {
    w.push('TTS_PROVIDER=sarvam_stream — the newer websocket path. Re-check /diagnostics after changing SARVAM_TTS_MODEL, TTS_VOICE or the sample rate; Sarvam retires model and speaker names together and the socket rejects the config rather than the text.');
  }
  if (config.crm.enabled && !config.crm.serviceKey) {
    w.push('CRM_ENABLED=true but AGENT_SERVICE_KEY is empty — the CRM will reject every tool call');
  }
  if (config.llm.provider === 'mock') {
    w.push('LLM_PROVIDER=mock — scripted replies, not a real conversation. Fine for plumbing, not for judging quality.');
  }
  if (config.env === 'production' && !config.testerToken) {
    w.push('TESTER_TOKEN is not set — the browser tester is DISABLED in production. Set it to enable /?t=<token>.');
  }
  if (config.telephony.provider !== 'none'
      && (config.plivo.authId || config.plivo.authToken || config.plivo.fromNumber)
      && !(config.plivo.authId && config.plivo.authToken && config.plivo.fromNumber)) {
    w.push('Plivo outbound is half-configured — PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN and PLIVO_FROM_NUMBER are all required to place calls.');
  }
  if (config.env === 'production' && config.llm.provider === 'mock') {
    w.push('Running the MOCK llm in production — the agent will read scripted lines, not converse.');
  }
  return w;
};

module.exports = config;
