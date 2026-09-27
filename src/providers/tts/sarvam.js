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

const ENDPOINT = 'https://api.sarvam.ai/text-to-speech';
const MAX_CHARS = 450;

// Sarvam deprecates model versions and retires speaker names with them, and both
// are a 400 on EVERY synthesis — the agent goes mute. The API names the valid
// replacement in its error, which /diagnostics surfaces verbatim.
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL || 'bulbul:v3';

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
    clientSide: false,

    async synth({ text, language = 'hi-IN' }) {
      if (!key) throw new Error('SARVAM_API_KEY is not set');

      const parts = [];
      for (const piece of chunk(text)) {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: [piece],
            target_language_code: language,
            speaker,
            model: SARVAM_TTS_MODEL,
            speech_sample_rate: 8000,
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error('Sarvam TTS ' + res.status + ': ' + detail.slice(0, 300));
        }
        const json = await res.json();
        for (const b64 of json.audios || []) parts.push(Buffer.from(b64, 'base64'));
      }
      log.debug('synthesised', text.length, 'chars in', parts.length, 'part(s)');
      return { audio: Buffer.concat(parts), mime: 'audio/wav', chars: text.length };
    },
  };
}

module.exports = { create };
