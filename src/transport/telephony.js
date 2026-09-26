/**
 * Telephony transport — real phone calls over a bidirectional media websocket.
 *
 * ⚠ UNTESTED. There is no telephony account yet, so this is written to the shape
 * that Exotel Voice Streaming, Plivo Audio Streams and a plain SIP media bridge
 * all share — a websocket carrying base64 audio frames in JSON — but it has never
 * run against a live line. Treat it as a reviewed starting point, not working
 * code: expect to adjust frame field names, sample rate and the answer webhook
 * once you have credentials. Everything it depends on (the conversation engine,
 * the tools, the guardrails, the ledger) IS tested via the text and web
 * transports, so the risk is confined to this file.
 *
 * Why a generic adapter instead of an Exotel SDK: PRD §19 leaves the provider
 * open, and the per-second-billing decision that saves the most money may push
 * you to a raw SIP trunk later. `frameCodec` and `decodeFrame`/`encodeFrame` are
 * the only places a provider difference should land.
 *
 * ── SET-UP SKETCH ────────────────────────────────────────────────────────────
 *   1. Point the provider's "stream" or "answer" URL at  wss://<host>/media
 *   2. Point its status callback at                      POST https://<host>/telephony/status
 *   3. Set STT_PROVIDER and TTS_PROVIDER to server-side drivers (deepgram /
 *      sarvam / elevenlabs). The `browser` drivers CANNOT work here — there is no
 *      browser on a phone line — and the transport refuses to start if they are set.
 */
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('../config');
const providers = require('../providers');
const { createSession } = require('../pipeline/conversation');
const vadFactory = require('../pipeline/vad');
const log = require('../util/log').make('tel');

// Telephony is 8 kHz, 16-bit, mono, 20 ms frames unless a provider says otherwise.
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;

/**
 * Provider frame shapes. Add a provider by adding an entry — nothing else in this
 * file should need to change.
 */
const CODECS = {
  generic: {
    decode: (msg) => (msg.event === 'media' && msg.media && msg.media.payload
      ? Buffer.from(msg.media.payload, 'base64') : null),
    encode: (buf) => JSON.stringify({ event: 'media', media: { payload: buf.toString('base64') } }),
    isStart: (msg) => msg.event === 'start',
    isStop: (msg) => msg.event === 'stop',
    callIdOf: (msg) => (msg.start && (msg.start.callSid || msg.start.call_id)) || msg.callSid || null,
    fromOf: (msg) => (msg.start && (msg.start.from || msg.start.caller)) || null,
    // Tells the provider to drop any audio it has queued — what makes barge-in
    // sound instant rather than "the bot finished its sentence first".
    clear: () => JSON.stringify({ event: 'clear' }),
  },
};
CODECS.exotel = CODECS.generic;
CODECS.plivo = CODECS.generic;

/** True when a telephony provider is configured at all. */
function enabled() {
  return config.telephony.provider && config.telephony.provider !== 'none';
}

/**
 * Throws if the speech drivers cannot work on a phone line. Called before the
 * media socket is exposed rather than on the first call, so a misconfigured
 * deploy fails at boot instead of mid-conversation with a customer.
 */
function assertReady() {
  const t = providers.get();
  if (t.stt.clientSide || t.tts.clientSide) {
    throw new Error(
      'STT_PROVIDER/TTS_PROVIDER are set to "browser", which cannot work on a phone line. '
      + 'Use deepgram or sarvam for STT and elevenlabs or sarvam for TTS.',
    );
  }
}

/** Mounts the provider's status callback onto an existing express app. */
function mountHttp(app) {
  app.post('/telephony/status', (req, res) => {
    log.info('status callback:', JSON.stringify(req.body).slice(0, 300));
    res.json({ ok: true });
  });
}

/**
 * The /media websocket connection handler.
 *
 * Returned as a function rather than bound to its own server, so the deployed
 * process can serve the tester and the phone line from ONE http server — which
 * is what a single Railway service gives you.
 */
function handleMedia(ws, req) {
  const t = providers.get();
  const codec = CODECS[config.telephony.provider] || CODECS.generic;

  let session = null;
  let stt = null;
  const vad = vadFactory.create({ frameMs: FRAME_MS });
  let outQueue = Promise.resolve();
  let frames = 0;

  const url = new URL(req.url, 'http://localhost');
  let phone = url.searchParams.get('from') || '';
  const direction = url.searchParams.get('direction') || 'inbound';

  function sendAudio(buf) {
    // Paced at real time: dumping a whole utterance at once overruns the
    // provider's jitter buffer and the customer hears clipped speech.
    const bytesPerFrame = (SAMPLE_RATE * 2 * FRAME_MS) / 1000;
    outQueue = outQueue.then(async () => {
      for (let i = 0; i < buf.length; i += bytesPerFrame) {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(codec.encode(buf.subarray(i, i + bytesPerFrame)));
        await new Promise((r) => setTimeout(r, FRAME_MS));
      }
    });
  }

  function openStt() {
    if (stt) return;
    stt = t.stt.createStream({
      language: config.stt.language,
      sampleRate: SAMPLE_RATE,
      onPartial: () => {
        // Any interim word means the customer is talking: cut the agent off.
        if (session) session.interrupt();
        if (ws.readyState === ws.OPEN && codec.clear) ws.send(codec.clear());
      },
      onFinal: (text) => { if (session && text.trim()) session.customerSaid(text).catch((e) => log.error(e.message)); },
      onError: (e) => log.error('stt:', e.message),
    });
  }

  async function begin(callId) {
    session = createSession({
      callId,
      phone,
      direction,
      onAgentAudio: (buf) => sendAudio(buf),
      onEvent: (event, data) => {
        if (event === 'tool' && !data.result.ok) log.warn('tool', data.name, 'failed:', data.result.error);
      },
      hangup: () => { try { ws.close(); } catch (e) { /* line already gone */ } },
    });
    await session.start();
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (codec.isStart(msg)) {
      phone = codec.fromOf(msg) || phone;
      await begin(codec.callIdOf(msg) || 'tel_' + Date.now());
      return;
    }
    if (codec.isStop(msg)) {
      if (session && !session.ended) await session.end('provider stop');
      return;
    }

    const pcm = codec.decode(msg);
    if (!pcm || !session) return;
    frames += 1;

    const v = vad.push(pcm);

    // THE CONNECT GATE. Until a human is heard, no STT stream is opened and no
    // LLM turn happens — the dial costs telephony seconds only. Removing this is
    // the most expensive change anyone could make to this service.
    if (!vad.everSpoke()) {
      if (!v.onset) return;
      log.info('human detected after', frames * FRAME_MS, 'ms');
      openStt();
    }

    if (v.onset && session) session.interrupt();
    if (stt) {
      stt.write(pcm);
      session.ledger.stt(FRAME_MS / 1000);
      if (v.end) stt.end();
    }
  });

  ws.on('close', async () => {
    if (stt) stt.close();
    if (session && !session.ended) await session.end('line closed');
  });
  ws.on('error', (e) => log.error('media socket:', e.message));
}

/**
 * Standalone mode — telephony only, its own server. `npm run web` serves both
 * surfaces from one process and is what a deploy should use; this stays for
 * running the phone line in isolation.
 */
function run() {
  assertReady();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.get('/health', (req, res) => res.json({ ok: true, provider: config.telephony.provider }));
  mountHttp(app);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/media' });
  wss.on('connection', handleMedia);

  server.listen(config.port, () => {
    log.info('telephony transport on :' + config.port + '  media=ws://…/media  status=POST /telephony/status');
    log.warn('this transport has never run against a live line — verify frame format and sample rate with your provider');
    config.warnings().forEach((w) => log.warn(w));
  });

  return server;
}

module.exports = { run, enabled, assertReady, mountHttp, handleMedia, CODECS, SAMPLE_RATE, FRAME_MS };
