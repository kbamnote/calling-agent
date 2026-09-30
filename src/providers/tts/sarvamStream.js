/**
 * Sarvam AI streaming TTS — audio starts coming back while the sentence is
 * still being synthesised.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The REST driver (tts/sarvam.js) has to synthesise a whole sentence before it
 * returns a single byte: roughly 600ms of fixed overhead plus ~8ms per
 * character, so a 70-character opening costs ~1.1s of silence. Measured against
 * the rest of the turn that is the largest single item left in the reply-latency
 * budget.
 *
 * This driver talks to `wss://api.sarvam.ai/text-to-speech/ws`, which returns
 * audio progressively. The first piece arrives after the model has buffered
 * `min_buffer_size` characters rather than after the whole sentence, which is
 * what takes time-to-first-audio from "the length of the sentence" down to
 * roughly a fixed cost.
 *
 * ── NOT YET EXERCISED AGAINST A LIVE KEY ─────────────────────────────────────
 * The protocol here is written from Sarvam's published WebSocket documentation.
 * It is NOT the default — set TTS_PROVIDER=sarvam_stream to opt in, and check
 * /diagnostics before putting it on a real call. tts/sarvam.js is untouched and
 * remains the default.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * It does not cache. The REST driver's on-disk cache is what makes the greeting
 * and the holding lines free, and those go through `say()`, which uses whichever
 * driver is configured — so a deployment using this one trades that saving for
 * latency. The greeting is pre-rendered during ring time either way
 * (telephony/dialer.js), so the line that matters most is still instant.
 */
const WebSocket = require('ws');
const log = require('../../util/log').make('tts:sarvam-ws');
const { stripWavHeader } = require('../../util/wav');

const ENDPOINT = 'wss://api.sarvam.ai/text-to-speech/ws';

const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL || 'bulbul:v3';
const SARVAM_PACE = Number(process.env.SARVAM_PACE) || 1.15;

// How much text Sarvam buffers before it starts synthesising. This IS the
// time-to-first-audio knob: lower starts sooner, too low and prosody suffers
// because the model is guessing at a phrase it has not finished reading.
const MIN_BUFFER = Number(process.env.SARVAM_MIN_BUFFER) || 25;

// A sentence that produces no audio at all within this window is a dead socket,
// not a slow one. Without it a silent server would hold the turn open until the
// call's own duration budget ended it.
const FIRST_AUDIO_TIMEOUT_MS = Number(process.env.SARVAM_WS_TIMEOUT_MS) || 8000;

// ── CONNECTION POOL ─────────────────────────────────────────────────────────
// Sarvam's docs are explicit that one socket handles many conversions: send the
// config once, then stream text. Opening a fresh one per sentence would put a
// TCP and TLS handshake in front of every reply — on the order of 100-300ms to
// India — which is a large slice of the very latency this driver exists to
// remove. So sockets are kept warm and handed back after each sentence.
//
// Keyed on language and sample rate because the config is sent ONCE per socket;
// a socket configured for 16 kHz Hindi cannot serve an 8 kHz request.
const POOL_MAX = Number(process.env.SARVAM_WS_POOL) || 4;
const POOL_IDLE_MS = Number(process.env.SARVAM_WS_IDLE_MS) || 45000;

/** @type {Array<{key:string, ws:Object, timer:Object}>} */
const idle = [];

function dropIdle(entry) {
  const i = idle.indexOf(entry);
  if (i !== -1) idle.splice(i, 1);
  clearTimeout(entry.timer);
  try { entry.ws.close(); } catch (e) { /* already gone */ }
}

/** Hands a socket back, or closes it if the pool is full or it is unhealthy. */
function release(key, ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (idle.length >= POOL_MAX) { try { ws.close(); } catch (e) { /* noop */ } return; }

  const entry = { key, ws, timer: null };
  // Vendors drop idle sockets without warning, and a half-dead one is worse
  // than no socket at all — it fails mid-call instead of at connect time.
  entry.timer = setTimeout(() => dropIdle(entry), POOL_IDLE_MS);
  if (entry.timer.unref) entry.timer.unref();
  ws.once('close', () => dropIdle(entry));
  idle.push(entry);
}

function takeIdle(key) {
  for (let i = idle.length - 1; i >= 0; i -= 1) {
    const entry = idle[i];
    if (entry.key !== key) continue;
    idle.splice(i, 1);
    clearTimeout(entry.timer);
    if (entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.removeAllListeners('close');
      return entry.ws;
    }
    try { entry.ws.close(); } catch (e) { /* already gone */ }
  }
  return null;
}

function create(config) {
  const key = config.tts.sarvamKey;
  const speaker = config.tts.voice || 'priya';

  /** Opens a socket and sends the one-time config. Resolves when it is usable. */
  function connect(language, sampleRate) {
    return new Promise((resolve, reject) => {
      const url = ENDPOINT + '?model=' + encodeURIComponent(SARVAM_TTS_MODEL)
        + '&send_completion_event=true';
      const ws = new WebSocket(url, { headers: { 'api-subscription-key': key } });

      const onFail = (e) => reject(e instanceof Error ? e : new Error('sarvam ws closed during connect'));
      ws.once('error', onFail);
      ws.once('close', onFail);

      ws.once('open', () => {
        ws.off('error', onFail);
        ws.off('close', onFail);
        // linear16 because the wire wants raw PCM end to end, and the sample
        // rate MUST match the transport or the voice plays at the wrong speed.
        ws.send(JSON.stringify({
          type: 'config',
          data: {
            language_code: language,
            speaker,
            model: SARVAM_TTS_MODEL,
            pace: SARVAM_PACE,
            output_audio_codec: 'linear16',
            speech_sample_rate: String(sampleRate),
            min_buffer_size: MIN_BUFFER,
          },
        }));
        resolve(ws);
      });
    });
  }

  return {
    name: 'sarvam_stream',
    clientSide: false,
    // Read by pipeline/speechPipe.js, which hands over an onChunk callback and
    // plays each piece as it lands instead of waiting for the sentence.
    supportsStreamingSynth: true,

    /**
     * @param {Function} [o.onChunk] called with each { audio, mime, sampleRate }
     *   as it arrives. Without it this behaves like the REST driver and returns
     *   the whole sentence at once, so it is safe anywhere that one is.
     * @returns raw PCM — NOT a WAV file. See util/wav.js for why.
     */
    async synth({ text, language = 'hi-IN', sampleRate = 8000, onChunk }) {
      if (!key) throw new Error('SARVAM_API_KEY is not set');

      const poolKey = language + '@' + sampleRate + '@' + speaker;
      const ws = takeIdle(poolKey) || await connect(language, sampleRate);

      return new Promise((resolve, reject) => {
        const parts = [];
        let settled = false;

        const cleanup = () => {
          clearTimeout(timer);
          ws.off('message', onMessage);
          ws.off('error', onError);
          ws.off('close', onClose);
        };

        const finish = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) {
            // A socket that failed mid-sentence is not fit to be reused.
            try { ws.close(); } catch (e) { /* already gone */ }
            return reject(err);
          }
          // Only ever released after a clean completion event. Handing back a
          // socket with audio still in flight would leak the tail of one
          // sentence into the next one's reply.
          release(poolKey, ws);
          const audio = Buffer.concat(parts);
          log.debug('streamed', text.length, 'chars ->', audio.length, 'bytes PCM @', sampleRate);
          return resolve({ audio, mime: 'audio/L16', sampleRate, chars: text.length });
        };

        const timer = setTimeout(
          () => finish(new Error('Sarvam TTS websocket produced no audio in ' + FIRST_AUDIO_TIMEOUT_MS + 'ms')),
          FIRST_AUDIO_TIMEOUT_MS,
        );

        function onMessage(raw) {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

          if (msg.type === 'audio' && msg.data && msg.data.audio) {
            // Sarvam may put a RIFF header on the first piece. Left in place it
            // plays as a click followed by nothing.
            const buf = stripWavHeader(Buffer.from(msg.data.audio, 'base64')).pcm;
            if (!buf.length) return;
            parts.push(buf);
            if (onChunk) onChunk({ audio: buf, mime: 'audio/L16', sampleRate });
            return;
          }
          if (msg.type === 'event' && msg.data && msg.data.event_type === 'final') {
            return finish();
          }
          if (msg.type === 'error') {
            const d = msg.data || {};
            // Sarvam retires model versions and speaker names together, and both
            // are an error on EVERY synthesis — the agent simply goes mute. The
            // message names the replacement, so it is surfaced verbatim.
            return finish(new Error('Sarvam TTS ' + (d.code || '') + ': ' + (d.message || 'unknown')));
          }
        }

        const onError = (e) => finish(e);
        // A close without a final event still resolves if audio arrived: a
        // truncated sentence is better than a silent turn.
        const onClose = () => (parts.length
          ? finish()
          : finish(new Error('Sarvam TTS websocket closed before any audio')));

        ws.on('message', onMessage);
        ws.once('error', onError);
        ws.once('close', onClose);

        try {
          ws.send(JSON.stringify({ type: 'text', data: { text } }));
          // Without the flush the server waits for more text that is never
          // coming, and the sentence's tail is never synthesised.
          ws.send(JSON.stringify({ type: 'flush' }));
        } catch (e) {
          finish(e);
        }
      });
    },
  };
}

module.exports = { create };
