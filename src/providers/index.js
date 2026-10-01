/**
 * Provider registry.
 *
 * The whole reason this file exists is PRD §21: "keep AI orchestration separate
 * from CRM, pricing and payment services. This allows the voice model to change
 * without rewriting business logic." Swapping a vendor should be one line in
 * .env, never a code change — so nothing outside this folder may import a driver
 * directly.
 *
 * Adding a vendor: drop a file in llm/ stt/ or tts/ exporting `create(config)`,
 * add one line to the matching map below. That is the entire integration.
 */
const config = require('../config');
const log = require('../util/log').make('providers');

const LLM = {
  mock: () => require('./llm/mock'),
  gemini: () => require('./llm/gemini'),
  openai: () => require('./llm/openai'),
};

const STT = {
  browser: () => require('./stt/browser'),
  deepgram: () => require('./stt/deepgram'),
  sarvam: () => require('./stt/sarvam'),
  // Whisper on Groq. Metered in AUDIO SECONDS on a quota entirely separate from
  // the model's tokens-per-minute, on the same account and key — so it costs
  // nothing against the limit the conversation is fighting over.
  groq: () => require('./stt/groq'),
  // Sarvam's realtime socket: transcribes WHILE the caller speaks, with interim
  // transcripts. The batch driver above cannot beat it by construction — it
  // cannot start until the caller stops. Opt-in; see stt/sarvamRealtime.js.
  sarvam_realtime: () => require('./stt/sarvamRealtime'),
};

const TTS = {
  browser: () => require('./tts/browser'),
  none: () => require('./tts/none'),
  elevenlabs: () => require('./tts/elevenlabs'),
  sarvam: () => require('./tts/sarvam'),
  // Opt-in. Audio starts coming back mid-sentence instead of after it, which is
  // the largest remaining item in the reply-latency budget — but the protocol
  // has not been exercised against a live key. See tts/sarvamStream.js.
  sarvam_stream: () => require('./tts/sarvamStream'),
  // Indian-language voices built for code-switched Hinglish, ~162ms to first
  // audio. Fixed 24 kHz output, resampled on the way out — see tts/rumik.js.
  rumik: () => require('./tts/rumik'),
};

function pick(map, name, kind, fallback) {
  const loader = map[name];
  if (!loader) {
    // Fail loudly but keep running on the safe default. A typo in .env should not
    // take a service down, and the warning names the valid options.
    log.warn(`unknown ${kind} provider "${name}" — falling back to "${fallback}". Valid: ${Object.keys(map).join(', ')}`);
    return map[fallback]().create(config);
  }
  return loader().create(config);
}

let cached = null;

/**
 * Builds the three drivers once and reuses them. Drivers hold no per-call state —
 * STT opens a fresh stream per call via createStream() — so sharing them across
 * concurrent calls is safe and avoids rebuilding a websocket config per dial.
 */
function get() {
  if (cached) return cached;

  const llm = pick(LLM, config.llm.provider, 'LLM', 'mock');
  const stt = pick(STT, config.stt.provider, 'STT', 'browser');
  let tts = pick(TTS, config.tts.provider, 'TTS', 'none');

  // A standby voice. Every spoken line in the service goes through one driver,
  // so a billing failure on it does not slow calls down — it silences them.
  if (config.tts.fallbackProvider && config.tts.fallbackProvider !== config.tts.provider) {
    const standby = pick(TTS, config.tts.fallbackProvider, 'fallback TTS', 'none');
    tts = require('./tts/withFallback').wrap(tts, standby);
  }

  log.info(`llm=${llm.name}${llm.model ? '(' + llm.model + ')' : ''} stt=${stt.name} tts=${tts.name}`);
  cached = { llm, stt, tts };
  return cached;
}

/** For tests that need a clean slate after changing env. */
function reset() { cached = null; }

module.exports = { get, reset, available: { llm: Object.keys(LLM), stt: Object.keys(STT), tts: Object.keys(TTS) } };
