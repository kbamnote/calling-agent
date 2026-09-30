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
    // Read by pipeline/speechPipe.js, which then hands over an onChunk callback
    // and plays each piece as it lands instead of waiting for the sentence.
    supportsStreamingSynth: true,

    /**
     * @param {Function} [o.onChunk] called with each { audio, mime, sampleRate }
     *   as it arrives off the wire. Without it this behaves like any batch
     *   driver and returns the whole sentence at once.
     */
    async synth({ text, sampleRate = 8000, format, onChunk }) {
      const fmt = format || ('pcm_' + sampleRate);
      if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
      const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + voice
        + '/stream?output_format=' + encodeURIComponent(fmt);

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

      // ── READ IT AS IT ARRIVES ────────────────────────────────────────────
      // This endpoint streams raw PCM, and the driver used to call
      // res.arrayBuffer() on it — which waits for the LAST byte. It asked for a
      // stream and then threw the entire benefit away, turning a model with
      // roughly 75ms to first byte into one that takes as long as the sentence.
      if (onChunk && res.body) {
        const reader = res.body.getReader();
        const parts = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          const buf = Buffer.from(value);
          parts.push(buf);
          onChunk({ audio: buf, mime: 'audio/L16', sampleRate });
        }
        const audio = Buffer.concat(parts);
        log.debug('streamed', text.length, 'chars ->', audio.length, 'bytes in', parts.length, 'chunks');
        return { audio, mime: 'audio/L16', sampleRate, chars: text.length };
      }

      const audio = Buffer.from(await res.arrayBuffer());
      log.debug('synthesised', text.length, 'chars ->', audio.length, 'bytes');
      return { audio, mime: 'audio/L16', sampleRate, chars: text.length };
    },
  };
}

module.exports = { create, DEFAULT_VOICE };
