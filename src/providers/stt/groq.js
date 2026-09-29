/**
 * Groq Whisper speech-to-text.
 *
 * ── WHY THIS IS WORTH HAVING ─────────────────────────────────────────────────
 * Two reasons, and the first is the one that matters.
 *
 * 1. IT DOES NOT SHARE THE LLM'S RATE LIMIT. Groq meters audio separately, in
 *    audio-seconds rather than tokens: 7,200 seconds an hour on the free tier,
 *    which is two hours of speech per hour. Transcription therefore costs
 *    nothing against the 8,000 tokens-per-minute the conversation is fighting
 *    over, on the SAME account and the SAME API key that already runs the model.
 *
 * 2. It is fast. Groq's whole proposition is inference speed, and the STT
 *    round-trip currently sits on the critical path between the caller finishing
 *    a sentence and the agent starting one.
 *
 * ── WHY IT IS NOT THE DEFAULT ────────────────────────────────────────────────
 * Sarvam's saaras:v3 is built for Indian languages and code-mixed Hinglish;
 * Whisper is a general multilingual model that happens to be good at Hindi.
 * Which one hears "Google Business connect nahi ho raha hai mera" correctly is a
 * question about your callers' accents and your line quality, and the only
 * honest way to settle it is to run both against recordings of real calls.
 *
 * Set STT_PROVIDER=groq to try it. The free tier also allows only 20 requests a
 * minute, which is roughly three or four simultaneous calls — fine for testing,
 * worth checking before a campaign.
 *
 * NOT YET EXERCISED AGAINST A LIVE KEY.
 */
const log = require('../../util/log').make('stt:groq');
const { retryingFetch } = require('../../util/http');

// Same host and key as the LLM: OPENAI_BASE_URL already points at Groq, so the
// path is derived from it rather than hardcoded, and a self-hosted OpenAI-
// compatible server with a Whisper endpoint works unchanged.
const DEFAULT_BASE = 'https://api.groq.com/openai/v1';

// turbo is the faster of the two and the right default for a phone line; plain
// whisper-large-v3 is a little more accurate on hard audio.
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';

/** Minimal 44-byte RIFF header so raw PCM can be posted as a WAV. */
function wavHeader({ dataLength, sampleRate = 8000, channels = 1, bitsPerSample = 16 }) {
  const buf = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
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
  const key = config.llm.openaiKey;
  const base = (config.stt.groqBaseUrl || DEFAULT_BASE).replace(/\/$/, '');

  return {
    name: 'groq',
    clientSide: false,
    // Whisper is a batch model: there are no interim results, so the pipeline
    // drives barge-in from its own energy VAD. Same contract as Sarvam.
    supportsPartials: false,

    createStream({ language, sampleRate = 8000, onFinal, onError }) {
      if (!key) throw new Error('OPENAI_API_KEY (your Groq key) is not set');

      let chunks = [];
      let closed = false;

      async function flush() {
        if (!chunks.length) return;
        const pcm = Buffer.concat(chunks);
        chunks = [];

        // Under ~0.3s of audio is a cough or a line click, not speech. Posting
        // it wastes a request against a 20/minute limit and usually comes back
        // as a hallucinated word.
        if (pcm.length < sampleRate * 2 * 0.3) return;

        try {
          const wav = Buffer.concat([wavHeader({ dataLength: pcm.length, sampleRate }), pcm]);
          const form = new FormData();
          form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
          form.append('model', GROQ_STT_MODEL);
          // Two letters, not a locale: Whisper wants 'hi', not 'hi-IN'.
          if (language) form.append('language', String(language).slice(0, 2));
          form.append('response_format', 'json');
          // Whisper invents fluent-sounding sentences out of silence and line
          // noise when it is allowed to sample. On a phone call that arrives as
          // the customer having said something they did not say.
          form.append('temperature', '0');

          const res = await retryingFetch(base + '/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key },
            body: form,
          }, { label: 'Groq STT', attempts: 3, timeoutMs: 15000, maxRetryAfterMs: 6000 });

          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error('Groq STT ' + res.status + ': ' + detail.slice(0, 300));
          }
          const json = await res.json();
          const text = (json.text || '').trim();
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
