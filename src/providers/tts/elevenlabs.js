/**
 * ElevenLabs TTS — best quality, highest cost.
 *
 * Uses the Flash model: latency matters more than fidelity on a sales call, and
 * Flash is both the fastest and the cheapest tier. Output is requested as 8 kHz
 * mu-law-adjacent PCM because that is what telephony wants; the browser tester
 * resamples.
 *
 * NOT YET EXERCISED AGAINST A LIVE KEY.
 */
const log = require('../../util/log').make('tts:elevenlabs');

// A multilingual default voice. Override with TTS_VOICE once someone has
// listened to a few and picked one that sounds right in Hinglish.
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

function create(config) {
  const key = config.tts.elevenLabsKey;
  const voice = config.tts.voice || DEFAULT_VOICE;

  return {
    name: 'elevenlabs',
    clientSide: false,

    async synth({ text, format = 'pcm_8000' }) {
      if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
      const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + voice
        + '/stream?output_format=' + encodeURIComponent(format);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error('ElevenLabs ' + res.status + ': ' + detail.slice(0, 300));
      }
      const audio = Buffer.from(await res.arrayBuffer());
      log.debug('synthesised', text.length, 'chars ->', audio.length, 'bytes');
      return { audio, mime: 'audio/L16', chars: text.length };
    },
  };
}

module.exports = { create, DEFAULT_VOICE };
