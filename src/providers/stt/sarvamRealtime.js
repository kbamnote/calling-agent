/**
 * Sarvam realtime speech-to-text — transcription happens WHILE the caller talks.
 *
 * ── THE MEASUREMENT THIS EXISTS FOR ──────────────────────────────────────────
 * Production, three consecutive turns of one call:
 *
 *     STT 1134ms  ->  2024ms  ->  2526ms
 *
 * Every millisecond of that is the caller sitting in silence after they have
 * finished speaking. The batch driver (stt/sarvam.js) cannot do better by
 * construction: it POSTs the whole utterance and waits, so the clock only
 * starts when the caller stops.
 *
 * This driver streams audio to `saaras:v3-realtime` as it arrives, so by the
 * time the caller stops, the transcript is essentially already written. What is
 * left is finalisation, not transcription.
 *
 * ── IT ALSO GIVES REAL BARGE-IN ──────────────────────────────────────────────
 * `supportsPartials: true`. Interim transcripts mean the pipeline can cut the
 * agent off because the caller said a WORD, not because the line got loud —
 * which is what BARGE_IN_LEVEL has been hand-tuned around, badly, per line.
 *
 * ── HOW IT DIFFERS FROM THE BATCH DRIVER ─────────────────────────────────────
 * `streamsContinuously: true` tells the transport to feed every frame rather
 * than only the frames its own VAD calls speech. Sarvam does its own endpointing
 * here, and gating it with a second VAD would hide the start of words from the
 * model that is trying to recognise them. The transport still withholds audio
 * while the agent is speaking — that is echo, not conversation, and no amount of
 * vendor cleverness makes transcribing your own voice useful.
 *
 * NOT YET EXERCISED AGAINST A LIVE KEY. Opt in with STT_PROVIDER=sarvam_realtime.
 */
const WebSocket = require('ws');
const log = require('../../util/log').make('stt:sarvam-rt');

const ENDPOINT = 'wss://api.sarvam.ai/speech-to-text-realtime/ws';

const MODEL = process.env.SARVAM_RT_MODEL || 'saaras:v3-realtime';
// fast | balanced | simulated. `fast` finalises sooner at some cost in accuracy;
// `balanced` is the vendor default and the safer starting point on a phone line.
const STREAM_TYPE = process.env.SARVAM_RT_STREAM_TYPE || 'balanced';
// Sarvam's own end-of-turn window, in ms. Kept in step with VAD_SILENCE_MS so
// the two do not disagree about when the caller finished — see the transport.
const SILENCE_MS = Number(process.env.VAD_SILENCE_MS) || 380;
// VAD activation threshold, 0-1. Higher ignores more line noise.
const THRESHOLD = process.env.SARVAM_RT_THRESHOLD || '0.3';

function create(config) {
  const key = config.stt.sarvamKey;

  return {
    name: 'sarvam_realtime',
    clientSide: false,
    supportsPartials: true,
    streamsContinuously: true,

    createStream({ language, sampleRate = 16000, onPartial, onFinal, onError }) {
      if (!key) throw new Error('SARVAM_API_KEY is not set');
      // The vendor closes the socket with code 4000 on any other rate rather
      // than resampling, which presents as "the call connects and nobody is
      // ever heard" — so it is caught here instead.
      if (sampleRate !== 8000 && sampleRate !== 16000) {
        throw new Error('Sarvam realtime STT accepts 8000 or 16000 Hz, not ' + sampleRate);
      }

      const params = new URLSearchParams({
        language_code: language || 'hi-IN',
        model: MODEL,
        stream_type: STREAM_TYPE,
        mode: 'transcribe',
        endpointing: 'vad',
        encoding: 'linear16',
        sample_rate: String(sampleRate),
        threshold: THRESHOLD,
        silence_duration_ms: String(SILENCE_MS),
      });

      let ws = null;
      let closed = false;
      let ready = false;
      // Audio that arrived before the socket opened. A phone call does not wait
      // for our handshake, and dropping the first few hundred milliseconds
      // removes the beginning of the caller's first word.
      const pending = [];
      // Sarvam emits one final per utterance; this guards the case where a
      // reconnect or a late duplicate would run the same turn twice.
      let lastFinalIdx = -1;

      function send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      }

      function connect() {
        ws = new WebSocket(ENDPOINT + '?' + params.toString(), {
          headers: { 'API-SUBSCRIPTION-KEY': key },
        });

        ws.on('open', () => {
          ready = true;
          for (const b of pending) send({ event: 'audio_input', audio: b.toString('base64') });
          pending.length = 0;
        });

        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
          if (closed) return;

          switch (msg.event) {
            case 'transcript.partial':
              // Any interim word means the caller is talking. The pipeline uses
              // this to stop the agent mid-sentence.
              if (msg.text && onPartial) onPartial(msg.text);
              break;

            case 'transcript.final': {
              const idx = msg.utterance_idx === undefined ? -1 : msg.utterance_idx;
              if (idx !== -1 && idx === lastFinalIdx) {
                log.warn('ignoring a repeated final for utterance ' + idx);
                break;
              }
              lastFinalIdx = idx;
              const text = String(msg.text || '').trim();
              if (text && onFinal) onFinal(text);
              break;
            }

            case 'error':
              // Sarvam retires model names, and a dead one is an error on every
              // utterance — the agent hears nothing while the call looks fine.
              log.error('sarvam: ' + (msg.code || '') + ' ' + (msg.message || ''));
              if (msg.is_fatal && onError) onError(new Error(msg.message || 'sarvam realtime error'));
              break;

            default:
              break;
          }
        });

        ws.on('error', (e) => {
          log.error('socket:', e.message);
          if (!closed && onError) onError(e);
        });

        ws.on('close', (code) => {
          ready = false;
          if (!closed) log.warn('socket closed mid-call (code ' + code + ')');
        });
      }

      try { connect(); } catch (e) { if (onError) onError(e); }

      return {
        write(pcm) {
          if (closed) return;
          if (!ready) {
            // Bounded: roughly two seconds at 16 kHz. A socket that has not
            // opened by then is not going to.
            if (pending.length < 100) pending.push(pcm);
            return;
          }
          send({ event: 'audio_input', audio: pcm.toString('base64') });
        },

        /**
         * The transport calls this when ITS vad decides the turn ended. With
         * vendor endpointing the final is already on its way, so this only
         * nudges Sarvam to finalise anything it is still holding — it must not
         * close the socket, which stays open for the whole call.
         */
        end() {
          if (!closed) send({ event: 'flush' });
        },

        close() {
          closed = true;
          send({ event: 'end' });
          try { if (ws) ws.close(); } catch (e) { /* already gone */ }
          pending.length = 0;
        },
      };
    },
  };
}

module.exports = { create };
