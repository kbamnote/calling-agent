/**
 * Rumik Silk TTS — Indian-language voices, built for the way these callers
 * actually speak.
 *
 * 22 Indic languages in both native and romanized script, with code-switched
 * synthesis — Hinglish is a first-class case rather than something the model
 * tolerates. Published time to first audio is ~162ms, against the 1253-1953ms
 * this service has measured from Sarvam.
 *
 * ── THE SAMPLE-RATE PROBLEM ──────────────────────────────────────────────────
 * Rumik's raw PCM is FIXED at 24 kHz. There is no sample-rate parameter, and
 * Plivo's stream is 16 kHz. Sent straight through, the voice plays 50% fast.
 * So every chunk goes through util/resample.js on the way out — statefully,
 * because 24:16 is a 3:2 ratio and a per-chunk conversion would leave a click
 * at every boundary.
 *
 * Their `mulaw`/`alaw` outputs are 8 kHz and would avoid the resampling, but
 * this transport is linear PCM end to end (see transport/telephony.js) and a
 * companded codec would need a decode table on both sides for no benefit.
 *
 * ── TWO DELIVERY MODES ───────────────────────────────────────────────────────
 * REST returns the whole utterance as one binary body — simple, one round trip,
 * but no audio until synthesis finishes.
 *
 * Streaming needs TWO round trips: mint a one-shot session over HTTPS, then
 * connect a websocket with the token it returns. That is more handshakes, but
 * audio starts arriving mid-sentence, which is the entire point. It is the
 * default; set RUMIK_STREAM=false to fall back to REST if the sockets misbehave.
 *
 * NOT YET EXERCISED AGAINST A LIVE KEY.
 */
const WebSocket = require('ws');
const log = require('../../util/log').make('tts:rumik');
const { retryingFetch } = require('../../util/http');
const resample = require('../../util/resample');

const API = 'https://silk-api.rumik.ai/v1/tts';
const WS_CONNECT = API + '/ws-connect';

// Rumik's raw PCM is 24 kHz and cannot be changed.
const NATIVE_RATE = 24000;

// `mulberry` is the faster of the two and steered by a natural-language voice
// description; `muga` is more expressive and takes inline tone tags. Speed wins
// on a sales call.
const MODEL = process.env.RUMIK_MODEL || 'mulberry';
// Indian-sounding presets: ira, siya, aisha, zoya (female), adam, theo (male).
const SPEAKER = process.env.RUMIK_SPEAKER || 'siya';
// EMPTY by default, deliberately. `mulberry` can be steered EITHER by a preset
// speaker OR by a natural-language description — and a description makes it
// design a voice on every single request, which is work nobody is waiting for
// when the voice is the same on every call anyway. Measured 3747ms to first
// audio with one set. Set RUMIK_DESCRIPTION only to audition voices.
const DESCRIPTION = process.env.RUMIK_DESCRIPTION || '';

const USE_STREAM = String(process.env.RUMIK_STREAM || 'true').toLowerCase() !== 'false';
const FIRST_AUDIO_TIMEOUT_MS = Number(process.env.RUMIK_TIMEOUT_MS) || 8000;

function create(config) {
  const key = config.tts.rumikKey;

  /** The body both delivery modes share. */
  function body(text, audioFormat) {
    const out = { model: MODEL, text, speaker: SPEAKER };
    if (audioFormat) out.audio_format = audioFormat;
    // Numbers, dates and currency read as words rather than digits — which is
    // what you want spoken, and exactly wrong to leave off on a sales call.
    out.normalization = true;
    if (MODEL === 'mulberry' && DESCRIPTION) out.description = DESCRIPTION;
    return out;
  }

  /** One binary body, all at once. */
  async function synthRest(text, rate) {
    const res = await retryingFetch(API, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body(text, 'pcm')),
    }, { label: 'Rumik TTS', attempts: 2, timeoutMs: 15000, maxRetryAfterMs: 6000 });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error('Rumik TTS ' + res.status + ': ' + detail.slice(0, 300));
    }
    const raw = Buffer.from(await res.arrayBuffer());
    const rs = resample.create(NATIVE_RATE, rate);
    const audio = rs.push(raw);
    log.debug('rest', text.length, 'chars ->', audio.length, 'bytes PCM @', rate);
    return { audio, mime: 'audio/L16', sampleRate: rate, chars: text.length };
  }

  /** Mint a session, then take the audio off a websocket as it is produced. */
  async function synthStream(text, rate, onChunk) {
    const t0 = Date.now();
    const minted = await retryingFetch(WS_CONNECT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      // audio_format omitted: the websocket's default IS raw 24 kHz PCM.
      body: JSON.stringify(body(text, null)),
    }, { label: 'Rumik session', attempts: 2, timeoutMs: 10000, maxRetryAfterMs: 6000 });

    if (!minted.ok) {
      const detail = await minted.text().catch(() => '');
      throw new Error('Rumik session ' + minted.status + ': ' + detail.slice(0, 300));
    }
    const session = await minted.json();
    if (!session.ws_url || !session.token) throw new Error('Rumik session returned no ws_url/token');
    const mintMs = Date.now() - t0;

    return new Promise((resolve, reject) => {
      // Fresh per utterance: the token is single-use, and so is the resampler's
      // carried state — one sentence's remainder must not lead the next.
      const rs = resample.create(NATIVE_RATE, rate);
      const parts = [];
      let settled = false;
      let ws;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (ws) ws.close(); } catch (e) { /* already gone */ }
        if (err) return reject(err);
        const audio = Buffer.concat(parts);
        log.debug('streamed', text.length, 'chars ->', audio.length, 'bytes PCM @', rate);
        return resolve({ audio, mime: 'audio/L16', sampleRate: rate, chars: text.length });
      };

      const timer = setTimeout(
        () => finish(new Error('Rumik produced no audio in ' + FIRST_AUDIO_TIMEOUT_MS + 'ms')),
        FIRST_AUDIO_TIMEOUT_MS,
      );

      try {
        ws = new WebSocket(session.ws_url + '?token=' + encodeURIComponent(session.token));
      } catch (e) {
        return finish(e);
      }

      let openMs = null;
      let firstAudioMs = null;
      ws.on('open', () => {
        openMs = Date.now() - t0;
        ws.send(JSON.stringify({ text }));
      });

      ws.on('message', (raw, isBinary) => {
        // Audio arrives as binary frames; anything textual is control.
        if (isBinary || Buffer.isBuffer(raw) === false || raw[0] !== 0x7b) {
          const converted = rs.push(Buffer.from(raw));
          if (!converted.length) return;
          if (firstAudioMs === null) {
            firstAudioMs = Date.now() - t0;
            // At INFO because this is the number the whole switch turns on, and
            // it splits into three stages that fail for entirely different
            // reasons: a slow mint is Rumik generating before it streams, a slow
            // open is network, a slow gap after open is the model itself.
            log.info('first audio ' + firstAudioMs + 'ms'
              + ' [mint ' + mintMs + 'ms, ws open ' + openMs + 'ms, synth '
              + (firstAudioMs - openMs) + 'ms]'
              + ' model=' + MODEL + ' speaker=' + SPEAKER
              + (DESCRIPTION ? ' +description' : ''));
          }
          parts.push(converted);
          if (onChunk) onChunk({ audio: converted, mime: 'audio/L16', sampleRate: rate });
          return;
        }
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.type === 'done') return finish();
        if (msg.error) {
          return finish(new Error('Rumik ' + (msg.code || 'error')
            + (msg.recoverable === false ? ' (not recoverable)' : '')));
        }
      });

      ws.on('error', (e) => finish(e));
      // A close without `done` still resolves if audio arrived: a truncated
      // sentence is better than a silent turn.
      ws.on('close', () => (parts.length
        ? finish()
        : finish(new Error('Rumik websocket closed before any audio'))));
    });
  }

  return {
    name: 'rumik',
    clientSide: false,
    // WHICH VOICE THIS IS, for the cache key.
    //
    // The cache keys on name + voice + text. The speaker is read from the
    // environment in here, and nothing passes it to synth(), so without this the
    // key did not change when RUMIK_SPEAKER did — and every pre-warmed line
    // (the greeting, the sign-off, the fillers) kept playing in the OLD voice
    // while new replies came back in the new one. A call that changes voice
    // halfway through is worse than either voice.
    //
    // The model belongs in it too: mulberry and muga do not sound alike.
    voiceId: MODEL + '/' + SPEAKER + (DESCRIPTION ? '/custom' : ''),
    // Read by pipeline/speechPipe.js, which hands over an onChunk callback and
    // plays each piece as it lands instead of waiting for the sentence.
    supportsStreamingSynth: USE_STREAM,

    /**
     * @param {Function} [o.onChunk] called with each { audio, mime, sampleRate }
     *   already converted to the transport's rate.
     * @returns raw PCM — NOT a WAV container. See util/wav.js for why.
     */
    async synth({ text, sampleRate = 8000, onChunk }) {
      if (!key) throw new Error('RUMIK_API_KEY is not set');
      if (!String(text || '').trim()) throw new Error('nothing to synthesise');
      if (USE_STREAM && onChunk) return synthStream(text, sampleRate, onChunk);
      return synthRest(text, sampleRate);
    },
  };
}

module.exports = { create, NATIVE_RATE };
