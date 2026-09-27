/**
 * Sarvam AI STT — Indian, Hindi-first, the cheapest per minute for Hinglish.
 * The recommended production driver for these calls.
 *
 * Sarvam's speech-to-text is a BATCH endpoint, so this driver buffers PCM until
 * the pipeline's VAD declares the utterance finished, then posts one WAV. That
 * costs a little latency versus a streaming vendor, and it means interim results
 * do not exist — so barge-in here is driven by the pipeline's own energy VAD
 * rather than by partial transcripts. `supportsPartials: false` tells the
 * pipeline to do exactly that.
 *
 * NOT YET EXERCISED AGAINST A LIVE KEY.
 */
const log = require('../../util/log').make('stt:sarvam');

const ENDPOINT = 'https://api.sarvam.ai/speech-to-text';

// Sarvam deprecates model versions, and a dead one is a 400 on EVERY utterance —
// the agent hears nothing at all while the call looks perfectly healthy. The API
// names its replacement in the error; /diagnostics now round-trips TTS into STT
// so that surfaces before a call rather than during one.
const SARVAM_STT_MODEL = process.env.SARVAM_STT_MODEL || 'saaras:v3';

/** Minimal 44-byte RIFF header so raw PCM can be posted as a WAV. */
function wavHeader({ dataLength, sampleRate = 8000, channels = 1, bitsPerSample = 16 }) {
  const buf = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);            // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);             // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLength, 40);
  return buf;
}

function create(config) {
  const key = config.stt.sarvamKey;

  return {
    name: 'sarvam',
    clientSide: false,
    supportsPartials: false,

    createStream({ language, sampleRate = 8000, onFinal, onError }) {
      if (!key) throw new Error('SARVAM_API_KEY is not set');

      let chunks = [];
      let closed = false;

      async function flush() {
        if (!chunks.length) return;
        const pcm = Buffer.concat(chunks);
        chunks = [];

        // Under ~0.3s of audio is a cough or a line click, not speech. Posting it
        // wastes a request and usually comes back as a hallucinated word.
        if (pcm.length < sampleRate * 2 * 0.3) return;

        try {
          const wav = Buffer.concat([wavHeader({ dataLength: pcm.length, sampleRate }), pcm]);
          const form = new FormData();
          form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
          form.append('model', SARVAM_STT_MODEL);
          form.append('language_code', language || 'hi-IN');

          const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'api-subscription-key': key },
            body: form,
          });
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error('Sarvam ' + res.status + ': ' + detail.slice(0, 300));
          }
          const json = await res.json();
          const text = (json.transcript || '').trim();
          if (text && !closed) onFinal && onFinal(text);
        } catch (e) {
          log.error('transcription failed:', e.message);
          onError && onError(e);
        }
      }

      return {
        write(pcm) { if (!closed) chunks.push(pcm); },
        end() { return flush(); },
        close() { closed = true; chunks = []; },
      };
    },
  };
}

module.exports = { create };
