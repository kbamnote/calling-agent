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

  llm: {
    provider: process.env.LLM_PROVIDER || 'mock',
    model: process.env.LLM_MODEL || '',
    maxTokens: num(process.env.LLM_MAX_TOKENS, 220),
    geminiKey: process.env.GEMINI_API_KEY || '',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },

  stt: {
    provider: process.env.STT_PROVIDER || 'browser',
    language: process.env.STT_LANGUAGE || 'hi-IN',
    deepgramKey: process.env.DEEPGRAM_API_KEY || '',
    sarvamKey: process.env.SARVAM_API_KEY || '',
  },

  tts: {
    provider: process.env.TTS_PROVIDER || 'browser',
    voice: process.env.TTS_VOICE || '',
    elevenLabsKey: process.env.ELEVENLABS_API_KEY || '',
    sarvamKey: process.env.SARVAM_API_KEY || '',
  },

  crm: {
    enabled: bool(process.env.CRM_ENABLED, false),
    baseUrl: (process.env.CRM_BASE_URL || 'http://localhost:5000').replace(/\/$/, ''),
    serviceKey: process.env.AGENT_SERVICE_KEY || '',
  },

  limits: {
    maxTurns: num(process.env.MAX_TURNS, 14),
    maxCallSeconds: num(process.env.MAX_CALL_SECONDS, 300),
    silenceHangupSeconds: num(process.env.SILENCE_HANGUP_SECONDS, 12),
    greetingGate: bool(process.env.GREETING_GATE, true),
  },

  telephony: {
    provider: process.env.TELEPHONY_PROVIDER || 'none',
    webhookSecret: process.env.TELEPHONY_WEBHOOK_SECRET || '',
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
  if (config.stt.provider === 'sarvam' && !config.stt.sarvamKey) w.push('STT_PROVIDER=sarvam but SARVAM_API_KEY is empty');
  if (config.tts.provider === 'elevenlabs' && !config.tts.elevenLabsKey) w.push('TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is empty');
  if (config.tts.provider === 'sarvam' && !config.tts.sarvamKey) w.push('TTS_PROVIDER=sarvam but SARVAM_API_KEY is empty');
  if (config.crm.enabled && !config.crm.serviceKey) {
    w.push('CRM_ENABLED=true but AGENT_SERVICE_KEY is empty — the CRM will reject every tool call');
  }
  if (config.llm.provider === 'mock') {
    w.push('LLM_PROVIDER=mock — scripted replies, not a real conversation. Fine for plumbing, not for judging quality.');
  }
  if (config.env === 'production' && !config.testerToken) {
    w.push('TESTER_TOKEN is not set — the browser tester is DISABLED in production. Set it to enable /?t=<token>.');
  }
  if (config.env === 'production' && config.llm.provider === 'mock') {
    w.push('Running the MOCK llm in production — the agent will read scripted lines, not converse.');
  }
  return w;
};

module.exports = config;
