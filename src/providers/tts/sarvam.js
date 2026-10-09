/**
 * Sarvam AI TTS — Indian voices, cheapest for Hindi. Recommended for production.
 *
 * Sarvam returns base64 WAV per request and caps input length, so long agent
 * turns are split on sentence boundaries and concatenated. In practice the
 * persona keeps turns to one or two sentences, so the split rarely fires — if it
 * fires often, the prompt has drifted and the agent is monologuing.
 *
 * NOT YET EXERCISED AGAINST A LIVE KEY.
 */
const log = require('../../util/log').make('tts:sarvam');
const { joinPcm } = require('../../util/wav');

const ENDPOINT = 'https://api.sarvam.ai/text-to-speech';
const MAX_CHARS = 450;
const { retryingFetch } = require('../../util/http');

// Sarvam deprecates model versions and retires speaker names with them, and both
// are a 400 on EVERY synthesis — the agent goes mute. The API names the valid
// replacement in its error, which /diagnostics surfaces verbatim.
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL || 'bulbul:v3';

// Sarvam's default delivery is slow for a phone call: 463 characters of reply
// ran to roughly 38 seconds of airtime on a real call, about 9s per turn. A
// modest lift reads as brisk and businesslike rather than rushed. 1.0 is the
// vendor default; above ~1.3 it starts to sound clipped.
const SARVAM_PACE = Number(process.env.SARVAM_PACE) || 1.15;

/** Splits on sentence ends, never mid-word, keeping each piece under the cap. */
function chunk(text) {
  if (text.length <= MAX_CHARS) return [text];
  const out = [];
  let buf = '';
  for (const part of text.split(/(?<=[.!?।])\s+/)) {
    if ((buf + ' ' + part).trim().length > MAX_CHARS && buf) { out.push(buf.trim()); buf = part; }
    else buf = (buf + ' ' + part).trim();
  }
  if (buf) out.push(buf);
  return out;
}

function create(config) {
  const key = config.tts.sarvamKey;
  // bulbul:v3 speakers (the API lists them in its 400 when you get one wrong):
  //   female — ritu, priya, neha, pooja, simran, kavya, ishita, shreya, roopa, ana
  //   male   — aditya, ashutosh, rahul, rohan, amit, dev, ratan, varun, manan,
  //            sumit, kabir, aayan, shubh, advait
  // Speaker names are tied to the MODEL VERSION: a v2 name on v3 is a 400 on
  // every synthesis and the agent goes mute. Override with TTS_VOICE.
  const speaker = config.tts.voice || 'priya';

  return {
    name: 'sarvam',
    // Which voice this is, for the cache key. Without it the key does not change
    // when the speaker does, and every pre-warmed line keeps playing in the old
    // voice while new replies come back in the new one.
    voiceId: SARVAM_TTS_MODEL + '/' + speaker,
    clientSide: false,

    /**
     * @param {number} [o.sampleRate]  MUST match the transport. Telephony passes
     *   the provider's rate; getting this wrong plays the voice at the wrong
     *   speed, or silently not at all.
     * @returns raw PCM — NOT a WAV file. See util/wav.js for why.
     */
    async synth({ text, language = 'hi-IN', sampleRate = 8000 }) {
      if (!key) throw new Error('SARVAM_API_KEY is not set');

      const parts = [];
      for (const piece of chunk(text)) {
        const res = await retryingFetch(ENDPOINT, {
          method: 'POST',
          headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: [piece],
            target_language_code: language,
            speaker,
            model: SARVAM_TTS_MODEL,
            speech_sample_rate: sampleRate,
            pace: SARVAM_PACE,
          }),
        }, { label: 'Sarvam TTS', attempts: 3, timeoutMs: 15000 });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error('Sarvam TTS ' + res.status + ': ' + detail.slice(0, 300));
        }
        const json = await res.json();
        for (const b64 of json.audios || []) parts.push(Buffer.from(b64, 'base64'));
      }
      // Sarvam returns a WAV container per piece. The wire wants raw samples, and
      // concatenating the containers would bury a RIFF header mid-sentence.
      const { pcm, sampleRate: actual } = joinPcm(parts);
      if (actual && actual !== sampleRate) {
        log.warn('asked for ' + sampleRate + 'Hz but Sarvam returned ' + actual + 'Hz —'
          + ' the voice will play at the wrong speed');
      }
      log.debug('synthesised', text.length, 'chars ->', pcm.length, 'bytes PCM @', actual || sampleRate, 'Hz');
      return { audio: pcm, mime: 'audio/L16', sampleRate: actual || sampleRate, chars: text.length };
    },
  };
}

module.exports = { create };
