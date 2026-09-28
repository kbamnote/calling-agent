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

// 20 ms frames. Sample rate is per-codec: a provider dictates it, we do not.
const FRAME_MS = 20;

// The CEILING for the adaptive threshold, not a fixed one. Across real calls on
// a single number the noise floor ranged from 0.0026 to 0.046, so the VAD learns
// each line's floor and sits a ratio above it — this just stops it from ever
// demanding more than this much signal. See pipeline/vad.js.
const VAD_MIN_THRESHOLD = Number(process.env.VAD_THRESHOLD) || 0.004;
const VAD_SPEECH_MS = Number(process.env.VAD_SPEECH_MS) || 200;

// Trailing silence that ends an utterance. Every millisecond here is dead air
// the customer sits through before anything starts happening. Too short and a
// mid-sentence pause gets transcribed as two fragments.
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS) || 500;

// The ABSOLUTE level required to interrupt the agent mid-sentence. Not adaptive,
// deliberately — see pipeline/vad.js. On this number, line noise measured
// 0.006-0.05 and real speech 0.18-0.27, so 0.08 sits cleanly between them.
// Raise it if the agent still gets cut off; lower it if interrupting feels hard.
const BARGE_IN_LEVEL = Number(process.env.BARGE_IN_LEVEL) || 0.08;

// Barge-in demands MORE confidence than the connect gate, deliberately. Opening
// STT on a marginal signal costs nothing; cutting the agent off mid-greeting on
// a breath or a line click is heard by the customer as the agent losing its
// train of thought. So interrupting needs sustained speech, not a single onset.
const BARGE_IN_MS = Number(process.env.BARGE_IN_MS) || 500;

// How long after the agent's audio finishes we keep treating the line as
// "agent speaking". Covers the provider's own playout lag, so the tail of the
// agent's voice echoing back does not read as the customer talking.
const ECHO_TAIL_MS = Number(process.env.ECHO_TAIL_MS) || 400;

// Outbound audio pacing. CHUNK_MS is how much audio rides in one websocket
// message; LEAD_MS is how far ahead of real-time playback we are willing to get.
// LEAD_MS is the safety margin against the provider's jitter buffer: raise it and
// speech starts faster but risks an overflow (and a ClearedAudio that truncates
// the sentence); lower it and a slow network can starve playback into a stutter.
const CHUNK_MS = Number(process.env.AUDIO_CHUNK_MS) || 100;
const LEAD_MS = Number(process.env.AUDIO_LEAD_MS) || 1200;

/**
 * Provider frame shapes. Add a provider by adding an entry — nothing else in this
 * file should need to change.
 *
 * Each codec declares:
 *   sampleRate   Hz of the PCM we send and receive
 *   contentType  what goes in the Stream XML / playAudio event
 *   decode(msg)  -> Buffer of 16-bit PCM, or null if this message is not audio
 *   encode(buf, ctx) -> the JSON string that plays that PCM back
 *   clear(ctx)   -> JSON string that drops the provider's queued audio, or null
 *
 * ONLY LINEAR PCM IS SUPPORTED. mu-law would need a codec table on both sides,
 * and every provider here offers L16, so there is no reason to carry that.
 */
const CODECS = {
  /** Twilio-shaped: media in, media out. Kept as the fallback for SIP bridges. */
  generic: {
    sampleRate: 8000,
    contentType: 'audio/x-l16;rate=8000',
    // A raw SIP bridge has no jitter buffer of its own, so frames must go out
    // in real time.
    paced: true,
    decode: (msg) => (msg.event === 'media' && msg.media && msg.media.payload
      ? Buffer.from(msg.media.payload, 'base64') : null),
    encode: (buf) => JSON.stringify({ event: 'media', media: { payload: buf.toString('base64') } }),
    isStart: (msg) => msg.event === 'start',
    isStop: (msg) => msg.event === 'stop',
    callIdOf: (msg) => (msg.start && (msg.start.callSid || msg.start.call_id)) || msg.callSid || null,
    fromOf: (msg) => (msg.start && (msg.start.from || msg.start.caller)) || null,
    clear: () => JSON.stringify({ event: 'clear' }),
  },

  /**
   * Plivo Audio Streaming.
   * https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-reference
   *
   * Three things differ from the Twilio-shaped default, and each one is silent
   * breakage if you get it wrong:
   *   • audio goes back as `playAudio` carrying contentType + sampleRate, NOT as
   *     a `media` event;
   *   • interrupting is `clearAudio` and it needs the streamId;
   *   • the start event has NO caller number — only callId, streamId, accountId
   *     and tracks. The number is carried on the websocket URL instead, put
   *     there by the answer endpoint below. Without it the agent cannot check
   *     the opt-out list or load the customer's history.
   *
   * L16 at 16 kHz: explicitly supported, and it keeps the VAD, STT and TTS on
   * plain PCM end to end with no transcoding anywhere.
   */
  plivo: {
    sampleRate: 16000,
    contentType: 'audio/x-l16;rate=16000',
    // Plivo BUFFERS what you send and plays it out itself — that is precisely
    // why clearAudio exists. Hand-pacing frames at 20ms with setTimeout fights
    // that buffer: Node's timers overshoot, so audio is fed slower than real
    // time and the caller hears it lag and stutter. Send it as fast as the
    // socket takes it and let Plivo do the timing.
    paced: false,
    decode: (msg) => (msg.event === 'media' && msg.media && msg.media.payload
      ? Buffer.from(msg.media.payload, 'base64') : null),
    encode: (buf) => JSON.stringify({
      event: 'playAudio',
      media: {
        contentType: 'audio/x-l16',
        sampleRate: 16000,
        payload: buf.toString('base64'),
      },
    }),
    isStart: (msg) => msg.event === 'start',
    // Plivo documents no stop event — the socket simply closes.
    isStop: (msg) => msg.event === 'stop',
    callIdOf: (msg) => (msg.start && (msg.start.callId || msg.start.streamId)) || null,
    streamIdOf: (msg) => (msg.start && msg.start.streamId) || msg.streamId || null,
    fromOf: () => null,
    clear: (ctx) => (ctx && ctx.streamId
      ? JSON.stringify({ event: 'clearAudio', streamId: ctx.streamId })
      : null),
  },
};

// Exotel's Voice Streaming is Twilio-shaped. UNVERIFIED — check its docs before
// the first call, the same way Plivo's had to be checked.
CODECS.exotel = CODECS.generic;

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

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The public origin this service is reachable at.
 *
 * Derived from the proxy headers rather than configured, because the platform
 * assigns the hostname and a hard-coded one silently breaks on every rename.
 * PUBLIC_URL overrides it when you are behind something that does not set them.
 */
function publicOrigin(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return proto + '://' + host;
}

/**
 * Mounts the provider's HTTP endpoints onto an existing express app.
 *
 * /telephony/answer is what the provider fetches when a call arrives. It returns
 * XML telling the provider to open a bidirectional audio stream back to /media.
 * The caller's number is appended to that websocket URL, because Plivo's start
 * event does not carry it and without it the agent cannot check the opt-out list
 * or recognise an existing customer.
 */
function mountHttp(app) {
  const answer = (req, res) => {
    const codec = CODECS[config.telephony.provider] || CODECS.generic;
    const params = { ...req.query, ...req.body };

    // Plivo posts From/To/CallUUID/Direction; casing varies by provider.
    const from = params.From || params.from || params.CallerName || '';
    const to = params.To || params.to || '';
    const callId = params.CallUUID || params.CallSid || params.callId || '';
    const direction = (params.Direction || params.direction || 'inbound').includes('out')
      ? 'outbound' : 'inbound';

    const origin = publicOrigin(req);
    const wsBase = origin.replace(/^http/, 'ws') + '/media';
    // Campaign and name ride on the query string we set when placing the call
    // (or default for an inbound one), because Plivo's start event carries
    // neither and the conversation needs both before the customer speaks.
    const campaign = params.campaign || params.Campaign || 'sales';
    const name = params.name || params.Name || '';
    const wsUrl = wsBase + '?from=' + encodeURIComponent(from)
      + '&direction=' + encodeURIComponent(direction)
      + '&campaign=' + encodeURIComponent(campaign)
      + (name ? '&name=' + encodeURIComponent(name) : '')
      + (callId ? '&callId=' + encodeURIComponent(callId) : '');

    log.info('answer: call', callId || '(no id)', 'from', from || '(unknown)', 'to', to, '->', wsBase);

    // keepCallAlive keeps the leg up once the stream ends; without it the call
    // drops the moment the agent stops speaking.
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<Response>\n'
      + '  <Stream bidirectional="true" keepCallAlive="true"'
      + ' contentType="' + codec.contentType + '"'
      + ' statusCallbackUrl="' + xmlEscape(origin + '/telephony/status') + '">'
      + xmlEscape(wsUrl)
      + '</Stream>\n'
      + '</Response>';

    res.type('text/xml').send(xml);
  };

  // Providers differ on the verb, so accept both rather than debugging a 405
  // from a call that already hung up.
  app.get('/telephony/answer', answer);
  app.post('/telephony/answer', answer);

  app.all('/telephony/status', (req, res) => {
    const p = { ...req.query, ...req.body };
    log.info('status:', p.CallUUID || p.callId || '', p.Event || p.event || '',
      p.CallStatus || p.status || '', p.Duration ? p.Duration + 's' : '');
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
  const sampleRate = codec.sampleRate;

  let session = null;
  let stt = null;
  const vad = vadFactory.create({
    frameMs: FRAME_MS,
    minThreshold: VAD_MIN_THRESHOLD,
    speechMs: VAD_SPEECH_MS,
    silenceMs: VAD_SILENCE_MS,
    bargeInLevel: BARGE_IN_LEVEL,
    bargeInMs: BARGE_IN_MS,
  });
  let outQueue = Promise.resolve();
  let frames = 0;
  let lastFrameAt = 0;
  let mediaWatchdog = null;
  // Bumped whenever audio is cut short. An in-flight send checks it between
  // chunks and abandons the rest, so a barge-in actually stops the agent instead
  // of pausing it.
  let playbackGeneration = 0;
  // Whether the STT stream has been opened for this call. Tracked here rather
  // than read back off the VAD — see the connect gate below for why.
  let sttOpened = false;
  // Consecutive frames of speech, for the barge-in threshold below.
  // When the agent's queued audio finishes playing. Everything arriving on the
  // inbound track before then is largely the agent's own voice coming back.
  let agentSpeakingUntil = 0;
  // Plivo needs this on every clearAudio. Captured from the start event.
  const ctx = { streamId: null };

  const url = new URL(req.url, 'http://localhost');
  // The answer endpoint puts the caller's number here, because Plivo's start
  // event does not carry one.
  let phone = url.searchParams.get('from') || '';
  const direction = url.searchParams.get('direction') || 'inbound';
  const urlCallId = url.searchParams.get('callId') || '';
  const campaign = url.searchParams.get('campaign') || 'sales';
  const clientName = url.searchParams.get('name') || '';

  /**
   * Streams one agent utterance to the provider.
   *
   * ── THE TWO WAYS THIS GOES WRONG ─────────────────────────────────────────
   * Too slow, and the caller hears the voice lag and stutter — which is what
   * cumulative setTimeout pacing does, because Node's timers overshoot and the
   * error compounds over hundreds of frames.
   *
   * Too fast, and the provider's jitter buffer overflows. Plivo answers that
   * with a `ClearedAudio` event and drops the REST of the utterance, so the
   * caller hears the agent start a sentence and get cut off mid-way. A 9-second
   * greeting dumped in one go is ~305 KB, and that is exactly what happened.
   *
   * So: send a burst up front so speech STARTS immediately, then feed at real
   * time while staying a bounded distance ahead of playback. Scheduled against a
   * wall clock, so it cannot drift.
   */
  function sendAudio(buf) {
    const bytesPerMs = (sampleRate * 2) / 1000;
    const chunkBytes = Math.round(bytesPerMs * CHUNK_MS);
    const myGeneration = playbackGeneration;

    // The agent is "speaking" from now until this audio has played out, plus a
    // tail for the provider's own playout lag.
    const playMs = Math.round((buf.length / (sampleRate * 2)) * 1000);
    agentSpeakingUntil = Math.max(agentSpeakingUntil, Date.now()) + playMs;

    outQueue = outQueue.then(async () => {
      const startedAt = Date.now();
      let queuedMs = 0;

      for (let i = 0; i < buf.length; i += chunkBytes) {
        // Abandoned: the customer interrupted, or the line went away. Sending the
        // remainder would have the agent talk over them.
        if (ws.readyState !== ws.OPEN || myGeneration !== playbackGeneration) return;

        ws.send(codec.encode(buf.subarray(i, i + chunkBytes), ctx));
        queuedMs += CHUNK_MS;

        // How far ahead of real-time playback we now are.
        const ahead = queuedMs - (Date.now() - startedAt);
        if (ahead > LEAD_MS) {
          await new Promise((r) => setTimeout(r, ahead - LEAD_MS));
        }
      }
    }).catch((e) => log.error('audio send failed:', e.message));
  }

  /**
   * Drops whatever the provider still has queued — what makes barge-in instant.
   * Also abandons anything we are still streaming, or we would simply refill the
   * buffer we just asked it to empty.
   */
  function sendClear() {
    playbackGeneration += 1;
    // Nothing of ours is playing any more, so stop suppressing the inbound track
    // — otherwise a genuine barge-in would be ignored for the rest of the tail.
    agentSpeakingUntil = 0;
    if (ws.readyState !== ws.OPEN || !codec.clear) return;
    const msg = codec.clear(ctx);
    if (msg) ws.send(msg);
  }

  function openStt() {
    if (stt) return;
    stt = t.stt.createStream({
      language: config.stt.language,
      sampleRate,
      onPartial: () => {
        // Any interim word means the customer is talking: cut the agent off.
        if (session) session.interrupt();
        sendClear();
      },
      onFinal: (text) => { if (session && text.trim()) session.customerSaid(text).catch((e) => log.error(e.message)); },
      onError: (e) => log.error('stt:', e.message),
    });
  }

  /**
   * The provider quietly ceasing to send inbound audio is invisible from the
   * logs — the call just sits there until the silence timer kills it, looking
   * exactly like a caller who said nothing. Say it out loud instead.
   */
  function startMediaWatchdog() {
    if (mediaWatchdog) return;
    mediaWatchdog = setInterval(() => {
      if (!lastFrameAt) return;
      const gap = Date.now() - lastFrameAt;
      if (gap > 3000) {
        log.warn('no inbound audio for ' + Math.round(gap / 1000) + 's after ' + frames
          + ' frames — the provider stopped streaming the caller');
        lastFrameAt = Date.now();   // warn once per gap, not every tick
      }
    }, 2000);
  }

  async function begin(callId) {
    session = createSession({
      callId,
      phone,
      direction,
      campaign,
      clientName,
      // The single source of truth for the audio rate on this call: the codec.
      audioSampleRate: sampleRate,
      onAgentAudio: (buf) => sendAudio(buf),
      onEvent: (event, data) => {
        if (event === 'tool' && !data.result.ok) log.warn('tool', data.name, 'failed:', data.result.error);
      },
      hangup: () => { try { ws.close(); } catch (e) { /* line already gone */ } },
    });
    startMediaWatchdog();
    await session.start();
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (codec.isStart(msg)) {
      if (codec.streamIdOf) ctx.streamId = codec.streamIdOf(msg);
      phone = codec.fromOf(msg) || phone;
      const mediaFormat = msg.start && msg.start.mediaFormat;
      if (msg.start) log.info('provider start: ' + JSON.stringify(msg.start).slice(0, 400));
      if (mediaFormat && mediaFormat.sampleRate && mediaFormat.sampleRate !== sampleRate) {
        // The provider is sending a different rate than the codec assumes. The
        // VAD thresholds and every frame boundary are wrong from here on, so say
        // so loudly rather than letting it sound like a bad microphone.
        log.error('provider stream is ' + mediaFormat.sampleRate + 'Hz but the '
          + config.telephony.provider + ' codec expects ' + sampleRate + 'Hz —'
          + ' fix contentType in the answer XML');
      }
      log.info('stream start: call', codec.callIdOf(msg) || urlCallId, 'from', phone || '(unknown)');
      await begin(codec.callIdOf(msg) || urlCallId || 'tel_' + Date.now());
      return;
    }
    // Not audio and not a lifecycle event we act on — but worth seeing once,
    // because an unrecognised event is how a protocol mismatch first shows up.
    if (['dtmf', 'playedStream', 'clearedAudio'].includes(msg.event)) {
      log.debug('provider event:', msg.event);
      return;
    }
    if (codec.isStop(msg)) {
      if (session && !session.ended) await session.end('provider stop');
      return;
    }

    const pcm = codec.decode(msg);
    if (!pcm || !session) return;
    frames += 1;

    lastFrameAt = Date.now();
    const agentSpeaking = Date.now() < agentSpeakingUntil + ECHO_TAIL_MS;
    const v = vad.push(pcm, { agentSpeaking });

    // The connect gate failing silently is the worst failure mode here: the call
    // sounds fine, the caller talks, and nothing happens. So report what is
    // actually arriving — frame size tells us the encoding is right, and the
    // level tells us whether the VAD threshold is wrong or the audio is silent.
    if (frames === 1) {
      log.info('first media frame: ' + pcm.length + ' bytes'
        + ' (expected ' + ((sampleRate * 2 * FRAME_MS) / 1000) + ' for ' + FRAME_MS + 'ms @ ' + sampleRate + 'Hz)');
    }
    if (frames % 100 === 0) {
      const s = vad.stats();
      log.info('inbound: ' + frames + ' frames (' + Math.round(frames * FRAME_MS / 1000) + 's)'
        + ', peak level ' + vad.peak().toFixed(4)
        + ', speech ' + (vad.everSpoke() ? 'DETECTED' : 'not yet')
        + ', stt ' + (sttOpened ? 'open' : 'CLOSED')
        + ' [floor ' + s.noiseFloor + ' peak ' + s.recentPeak + ' -> threshold ' + s.effective
        + ', bargeIn>=' + s.bargeBar
        + ', loud ' + s.loudFrames + ' frames, longest run ' + s.maxRun + '/' + s.needRun
        + (Date.now() < agentSpeakingUntil + ECHO_TAIL_MS ? ', AGENT SPEAKING' : '') + ']');
    }

    // THE CONNECT GATE. Until a human is heard, no STT stream is opened and no
    // LLM turn happens — the dial costs telephony seconds only. Removing this is
    // the most expensive change anyone could make to this service.
    //
    // Gated on OUR OWN flag, not vad.everSpoke(): push() flips that the instant
    // it sees onset, so `!vad.everSpoke()` is already false by the time we test
    // it and the branch never runs. That shut the gate permanently — inbound
    // audio arrived, the VAD saw speech, and STT was never opened, so the call
    // sat there until the silence timeout killed it.
    if (!sttOpened) {
      if (!v.onset) return;
      sttOpened = true;
      log.info('human detected after ' + frames * FRAME_MS + 'ms (level '
        + v.level.toFixed(3) + ') — opening STT');
      openStt();
    }

    // Barge-in uses the VAD's STRICT absolute signal, never the permissive one.
    // A false positive here cancels the agent's reply and clears the provider's
    // buffer, so the caller hears nothing while the logs look healthy — that is
    // how ten spurious clears in one call made a working agent appear mute.
    if (v.bargeIn && session) {
      log.info('barge-in at level ' + v.level.toFixed(3)
        + (agentSpeaking ? ' (while speaking)' : '') + ' — stopping the agent');
      session.interrupt();
      if (!t.stt.supportsPartials) sendClear();
    }
    if (stt) {
      // Do NOT feed the transcriber while the agent is speaking: the inbound
      // track carries the agent's own voice back through the caller's handset,
      // and transcribing that makes the agent answer itself.
      if (!agentSpeaking) {
        stt.write(pcm);
        session.ledger.stt(FRAME_MS / 1000);
        if (v.end) stt.end();
      }
    }
  });

  ws.on('close', async () => {
    if (mediaWatchdog) clearInterval(mediaWatchdog);
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
    log.info('telephony transport on :' + config.port
      + '  answer=/telephony/answer  media=ws /media  status=/telephony/status');
    log.warn('this transport has never run against a live line — verify frame format and sample rate with your provider');
    config.warnings().forEach((w) => log.warn(w));
  });

  return server;
}

module.exports = { run, enabled, assertReady, mountHttp, handleMedia, publicOrigin, CODECS, FRAME_MS };
