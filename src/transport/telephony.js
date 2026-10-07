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
const liveCalls = require('../telephony/liveCalls');
const recorder = require('../telephony/recorder');
const recordingStore = require('../telephony/recordingStore');

// 20 ms frames. Sample rate is per-codec: a provider dictates it, we do not.
const FRAME_MS = 20;

// The CEILING for the adaptive threshold, not a fixed one. Across real calls on
// a single number the noise floor ranged from 0.0026 to 0.046, so the VAD learns
// each line's floor and sits a ratio above it — this just stops it from ever
// demanding more than this much signal. See pipeline/vad.js.
const VAD_MIN_THRESHOLD = Number(process.env.VAD_THRESHOLD) || 0.004;
const VAD_SPEECH_MS = Number(process.env.VAD_SPEECH_MS) || 200;

// Trailing silence that ends an utterance. Every millisecond here is dead air
// the customer sits through before anything starts happening, and it is the
// FIRST item in the reply-latency budget — nothing downstream can begin until
// it expires.
//
// 380ms, down from 500ms. The floor is set by how long a speaker pauses WITHIN
// a sentence: Hindi and Hinglish run to roughly 150-300ms between clauses, and
// a window inside that band chops one sentence into two fragments, which reads
// to the model as the customer interrupting themselves. 380ms clears the top of
// that band with margin; the VAD's own hangover (pipeline/vad.js) absorbs the
// shorter dips between syllables and unvoiced consonants.
//
// Raise it if callers are being cut off mid-sentence — that symptom is worth
// more than the 120ms. Do not lower it without listening to real recordings
// from the lines you actually dial.
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS) || 380;

// The ABSOLUTE level required to interrupt the agent mid-sentence. Not adaptive,
// deliberately — see pipeline/vad.js. On this number, line noise measured
// 0.006-0.05 and real speech 0.18-0.27, so 0.08 sits cleanly between them.
// Raise it if the agent still gets cut off; lower it if interrupting feels hard.
const BARGE_IN_LEVEL = Number(process.env.BARGE_IN_LEVEL) || 0.08;

// Barge-in demands MORE confidence than the connect gate, deliberately. Opening
// STT on a marginal signal costs nothing; cutting the agent off mid-greeting on
// a breath or a line click is heard by the customer as the agent losing its
// train of thought. So interrupting needs sustained speech, not a single onset.
const BARGE_IN_MS = Number(process.env.BARGE_IN_MS) || 300;

// How much HARDER it is to interrupt the agent than to be heard in silence.
//
// It was 2.0, which put the bar at 0.16 while the agent spoke — and measured
// across real calls, customers peak at 0.15 to 0.27. So interrupting worked
// only for the loudest of them, and the agent talked over everyone else.
//
// The guard exists because the agent's own voice comes back on the inbound
// track. Measured, that echo runs 0.015 to 0.033 — so 1.25 still leaves the bar
// (0.10) three times above the worst echo seen, and well under the quietest
// customer.
const ECHO_GUARD = Number(process.env.ECHO_GUARD) || 1.25;

// How long after the agent's audio finishes we keep treating the line as
// "agent speaking". Covers the provider's own playout lag, so the tail of the
// agent's voice echoing back does not read as the customer talking.
// After the last audio has played out, before the line is actually cut. The
// provider has its own playout lag, and hanging up on the final syllable reads
// as a dropped call rather than a goodbye.
const HANGUP_TAIL_MS = Number(process.env.HANGUP_TAIL_MS) || 700;

// A ceiling on that wait. agentSpeakingUntil is derived from how much audio was
// queued, so a bug there could otherwise hold a paid line open indefinitely.
const MAX_HANGUP_WAIT_MS = Number(process.env.MAX_HANGUP_WAIT_MS) || 12000;

const ECHO_TAIL_MS = Number(process.env.ECHO_TAIL_MS) || 400;

// Gain on the agent's own voice, because Rumik has no volume control and a
// phone line flatters a hot signal. 1.0 is untouched; 1.4 to 1.8 is the useful
// range. Past the point where peaks clip it stops sounding louder and starts
// sounding broken, so the limiter below is not optional.
const TTS_GAIN = Number(process.env.TTS_GAIN) || 1;

// Outbound audio pacing. CHUNK_MS is how much audio rides in one websocket
// message; LEAD_MS is how far ahead of real-time playback we are willing to get.
// LEAD_MS is the safety margin against the provider's jitter buffer: raise it and
// speech starts faster but risks an overflow (and a ClearedAudio that truncates
// the sentence); lower it and a slow network can starve playback into a stutter.
// Frames of run-up kept before confirmed speech, so the transcriber never gets
// audio that starts mid-word. 15 x 20ms = 300ms, comfortably more than the
// VAD_SPEECH_MS it takes to decide something is speech.
const PREROLL_FRAMES = Number(process.env.STT_PREROLL_FRAMES) || 15;

// How recently our own VAD must have heard a voice for a transcript to count as
// something the caller actually said. Generous, because a streaming recogniser
// finalises a little after the words stop — this is here to reject text
// invented out of pure line noise, not to second-guess real speech.
const JUNK_WINDOW_MS = Number(process.env.STT_JUNK_WINDOW_MS) || 4000;

// Below this, the recogniser is guessing. A live call turned "boliye" into
// "Vei dici?" and "haan" into "Si, dice." — real speech, confidently acted on,
// and the conversation followed the guess instead of the customer. Dropping a
// doubtful turn costs one beat of silence, which the caller answers by simply
// repeating themselves; acting on it costs the call.
// 0 turns the check off, for a provider that reports no confidence.
const MIN_CONFIDENCE = process.env.STT_MIN_CONFIDENCE === undefined
  ? 0.35 : Number(process.env.STT_MIN_CONFIDENCE);

// The languages these calls are actually in. nova-3's multilingual mode picks
// from a fixed candidate set that includes Spanish and Italian, and on noisy
// Indian phone audio it reaches for them — which is where "Vei dici?" came
// from. Hinglish code-switching is why `multi` is worth keeping, so rather than
// giving that up, anything it claims is NEITHER Hindi NOR English is dropped.
// Empty disables the check.
const STT_LANGUAGES = (process.env.STT_LANGUAGES === undefined ? 'hi,en' : process.env.STT_LANGUAGES)
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

/**
 * Why this transcript is not a turn, or null if it is one.
 *
 * Pure and exported because every rule here came from a live call going wrong,
 * and a rule that can only be exercised by standing up a websocket does not get
 * exercised.
 *
 * @param {boolean} o.heardVoice  did the energy VAD see voice behind this text?
 * @returns {string|null}
 */
function transcriptRejection({ text, meta = {}, heardVoice }) {
  if (!String(text || '').trim()) return 'empty';

  // A phone line is noisy and a multilingual recogniser will always find SOME
  // word in noise. One real call produced "Oh, no, you want.", "Exacto." and
  // "Ya vi Jaime." — none of it spoken. Each became a turn, the model had
  // nothing to answer, and the caller heard "line thodi slow ho gayi" six times.
  // Length alone is not enough — "haan" and "ji" are real answers.
  if (!heardVoice) return 'no voice behind it';

  // Somebody DID speak — the rest is about whether we heard them right.
  if (MIN_CONFIDENCE > 0 && typeof meta.confidence === 'number'
      && meta.confidence < MIN_CONFIDENCE) {
    return 'confidence ' + meta.confidence.toFixed(2) + ' < ' + MIN_CONFIDENCE;
  }

  const langs = meta.languages || [];
  if (STT_LANGUAGES.length && langs.length) {
    // Tags may carry a region ("hi-latn", "en-in"), so match the primary
    // subtag. ONE recognised language is enough: a code-switched Hinglish
    // utterance is correctly tagged with several, and demanding all of them
    // would throw away the normal case.
    const ok = langs.some((l) => STT_LANGUAGES.includes(String(l).split('-')[0]));
    if (!ok) return 'language ' + langs.join('/') + ', expected ' + STT_LANGUAGES.join('/');
  }
  return null;
}

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

    // WHICH END IS THE CUSTOMER depends on the direction, and getting it wrong
    // is silent: on an outbound call Plivo sends From = OUR number and
    // To = the person we rang. Using From for both made the agent look ITSELF
    // up in the CRM — so a real customer came back "not a known Tapify client",
    // the opt-out check ran against our own number, and any feedback would have
    // been logged against nobody.
    const customer = direction === 'outbound' ? (to || from) : (from || to);

    const origin = publicOrigin(req);
    const wsBase = origin.replace(/^http/, 'ws') + '/media';
    // Campaign and name ride on the query string we set when placing the call
    // (or default for an inbound one), because Plivo's start event carries
    // neither and the conversation needs both before the customer speaks.
    const campaign = params.campaign || params.Campaign || 'sales';
    const name = params.name || params.Name || '';
    // The dialer sets this after checking the do-not-contact list, so the
    // session does not repeat a CRM round-trip between pickup and the greeting.
    // Outbound only: an inbound call was never dialled by us, so nothing checked it.
    const ooChecked = direction === 'outbound' && (params.ooChecked === '1');
    const wsUrl = wsBase + '?from=' + encodeURIComponent(customer)
      + '&direction=' + encodeURIComponent(direction)
      + '&campaign=' + encodeURIComponent(campaign)
      + (name ? '&name=' + encodeURIComponent(name) : '')
      + (ooChecked ? '&ooChecked=1' : '')
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
/**
 * Encodes a finished call and files it where the CRM can play it.
 *
 * Every step is allowed to fail without anything else noticing. A recording is
 * a nice-to-have attached to a call that has already happened and already been
 * logged — losing one must never surface as a failed call, and must never be
 * retried in a way that holds a line open.
 */
async function storeRecording(tape, callId) {
  if (!recordingStore.configured()) {
    log.warn('recording is on but no Cloudinary account is configured — nothing stored');
    return;
  }
  const mp3 = await tape.finish();
  if (!mp3) return;                       // under a second of audio is not a call

  const url = await recordingStore.upload(mp3, callId);
  if (!url) return;

  if (!config.crm.enabled || !config.crm.serviceKey) return;
  const res = await fetch(config.crm.baseUrl + '/api/agent/call/recording', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': config.crm.serviceKey },
    body: JSON.stringify({ callId, url, bytes: mp3.length, seconds: Math.round(tape.seconds()) }),
  });
  if (!res.ok) log.warn('CRM would not record the recording URL: HTTP ' + res.status);
}

/**
 * Multiplies PCM16 by `gain`, clamped at the limits rather than wrapping.
 *
 * Int16 overflow does not get quieter, it wraps to the opposite sign — which is
 * heard as a harsh crackle on exactly the loudest syllables. Clamping turns the
 * same overdrive into ordinary clipping, which is merely less pleasant.
 */
function amplify(buf, gain) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = Math.round(buf.readInt16LE(i) * gain);
    out.writeInt16LE(v > 32767 ? 32767 : (v < -32768 ? -32768 : v), i);
  }
  return out;
}

function handleMedia(ws, req) {
  // Counted from here, not from the dial: a number that is still ringing is not
  // yet using a TTS slot, and a call that is never answered must not hold one.
  liveCalls.opened();
  const t = providers.get();

  // OFF unless switched on deliberately. Recording a customer who was not told
  // they are being recorded is not a default anything should ship with — the
  // greeting has to say so first. See RECORDING_ENABLED in .env.example.
  let tape = null;
  const codec = CODECS[config.telephony.provider] || CODECS.generic;
  const sampleRate = codec.sampleRate;

  let session = null;
  // Hoisted, because the CLOSE handler needs it and the start handler is where
  // it becomes known. A block-scoped copy inside the start handler crashed the
  // whole process at hangup — not just the call, the process — and took a live
  // conversation down with it.
  let callId = '';
  let stt = null;
  const vad = vadFactory.create({
    frameMs: FRAME_MS,
    minThreshold: VAD_MIN_THRESHOLD,
    speechMs: VAD_SPEECH_MS,
    silenceMs: VAD_SILENCE_MS,
    bargeInLevel: BARGE_IN_LEVEL,
    bargeInMs: BARGE_IN_MS,
    echoGuard: ECHO_GUARD,
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
  // When the VAD saw the current utterance finish. This is the zero point of the
  // latency the caller actually experiences: everything after it — the STT
  // round-trip included — is silence they are sitting through.
  let speechEndAt = 0;
  // When the transcription request actually went out, so the STT leg is measured
  // against the vendor rather than against our own end-of-turn window.
  let sttStartAt = 0;
  // The last frame the caller was actually heard speaking on. This, not our
  // VAD's end-of-turn decision, is when their speech really stopped — and a
  // STREAMING transcriber often hands back the final BEFORE our VAD has made
  // that decision, in which case the v.end timestamps still belong to the
  // PREVIOUS turn. One live call reported "stt 19010ms" next to a real 249ms for
  // exactly that reason: a stale zero, not a slow vendor.
  let lastVoiceAt = 0;
  // A rolling run-up of the frames just before speech was confirmed. The VAD
  // needs VAD_SPEECH_MS of sound before it will call something speech, and those
  // frames ARE the start of the word — without them the transcriber is handed
  // audio beginning mid-syllable.
  const preRoll = [];
  // Reused zero-filled frame, so the agent's turn costs no allocations.
  let silentFrame = null;
  // A transcriber that streams does its own endpointing and needs every frame;
  // a batch one is posted an utterance at a time and must NOT be handed the
  // silence between them. The two are fed differently below.
  const sttContinuous = Boolean(t.stt.streamsContinuously);
  // Guards against one utterance being turned into two turns. Reset on the next
  // end-of-speech, so a genuine second utterance is never swallowed.
  let utteranceHandled = false;
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
  const clientId = url.searchParams.get('clientId') || '';
  const optOutChecked = url.searchParams.get('ooChecked') === '1';

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
    // Louder BEFORE anything else sees it, so the recording is what the caller
    // actually heard rather than the raw synthesiser output.
    if (TTS_GAIN !== 1) buf = amplify(buf, TTS_GAIN);
    // The recorder queues this the same way the line does — see recorder.agent.
    if (tape) tape.agent(buf);
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
    // Whatever was queued past this moment is never played, so it must not be in
    // the recording either.
    if (tape) tape.interrupted();
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
        // An interim word means the caller is talking — but that is only a
        // reason to act if the agent is MID-SENTENCE. Firing regardless sent a
        // clearAudio on every partial (ten in a row on one live call, Plivo
        // echoing ClearedAudio back each time) and, far worse, bumped the
        // speak token — which silently cancels the reply currently being
        // synthesised FOR THIS TURN. The caller interrupts nothing and loses
        // their answer.
        if (Date.now() >= agentSpeakingUntil + ECHO_TAIL_MS) return;
        if (session) session.interrupt();
        sendClear();
      },
      onFinal: (text, meta = {}) => {
        if (!session || !text.trim()) return;

        // ── IGNORE WHAT THE LINE COUGHED UP ─────────────────────────────────
        const reject = transcriptRejection({
          text,
          meta,
          heardVoice: lastVoiceAt > 0 && (Date.now() - lastVoiceAt) < JUNK_WINDOW_MS,
        });
        if (reject) {
          log.warn('ignoring a transcript: ' + reject + ' — ' + JSON.stringify(text.slice(0, 40)));
          // Noise is not a person, so noise gets silence. But a transcript we
          // threw out for confidence or language means somebody DID speak, and
          // leaving them unanswered is how a live call died: two real sentences
          // dropped, no reply either time, "Hello" into the gap, then the
          // silence timer. Ask them to say it again instead.
          if (reject !== 'no voice behind it' && session.didNotCatch) {
            session.didNotCatch().catch(() => {});
          }
          return;
        }

        // One transcript per utterance. A provider that delivers a final twice —
        // a retry landing after a late first response, or an end() racing a
        // close() — would otherwise run the same turn through the model twice,
        // which costs a second reply spoken over the first.
        // The guard is for BATCH drivers, where a retry or a late response can
        // deliver the same utterance twice. A streaming transcriber emits one
        // final per utterance by design, and blocking its second one would
        // silently drop the rest of the conversation.
        if (!sttContinuous) {
          if (utteranceHandled) {
            log.warn('ignoring a duplicate final transcript for this utterance');
            return;
          }
          utteranceHandled = true;
        }
        // A streaming transcriber decides the turn boundary itself, so our VAD's
        // marks may not have been updated for THIS utterance yet — they can
        // still belong to the previous one. The last frame we actually heard the
        // caller on is the honest zero; fall back to the VAD's view only when
        // there is nothing better.
        const endedAt = sttContinuous
          ? (lastVoiceAt || speechEndAt || Date.now())
          : (speechEndAt || Date.now());

        session.customerSaid(text, {
          speechEndAt: endedAt,
          sttStartAt: sttContinuous ? endedAt : (sttStartAt || endedAt),
        }).catch((e) => log.error(e.message));
      },
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
      clientId,
      optOutChecked,
      // The single source of truth for the audio rate on this call: the codec.
      audioSampleRate: sampleRate,
      onAgentAudio: (buf) => sendAudio(buf),
      onEvent: (event, data) => {
        if (event === 'tool' && !data.result.ok) log.warn('tool', data.name, 'failed:', data.result.error);
      },
      hangup: () => {
        // THE GOODBYE HAS NOT BEEN HEARD YET.
        //
        // say() resolves when the audio is handed to the transport, not when
        // the caller has listened to it — Plivo plays it out in real time, and
        // the closing line is about four seconds long. Closing the socket here,
        // as this used to, dropped the rest of it: one live call logged its
        // outcome at 11:22:39.276 and the stream died at 11:22:39.844, so the
        // customer got 568ms of a four-second sign-off and then silence.
        //
        // agentSpeakingUntil already knows when the queue finishes. Capped, so
        // a playout clock that never advances can still never hold a line open.
        const remaining = Math.max(agentSpeakingUntil - Date.now(), 0);
        const waitMs = Math.min(remaining + HANGUP_TAIL_MS, MAX_HANGUP_WAIT_MS);
        setTimeout(() => {
          try { ws.close(); } catch (e) { /* line already gone */ }
        }, waitMs);
      },
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
      callId = codec.callIdOf(msg) || urlCallId || 'tel_' + Date.now();
      if (config.recording.enabled) {
        tape = recorder.create({ callId, sampleRate });
      }
      await begin(callId);
      return;
    }
    // Not audio and not a lifecycle event we act on — but worth seeing once,
    // because an unrecognised event is how a protocol mismatch first shows up.
    if (msg.event === 'playedStream') {
      // The provider confirming it actually PLAYED what we sent — the only
      // acknowledgement in this pipeline that comes from outside our process.
      // Worth INFO: a turn whose audio we queued but Plivo never played looks
      // identical to a working one in every other log line.
      log.info('playback confirmed by provider'
        + (msg.streamId ? ' (stream ' + msg.streamId + ')' : ''));
      return;
    }
    if (['dtmf', 'clearedAudio'].includes(msg.event)) {
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
    if (tape) tape.customer(pcm);

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
    // The run-up is collected BEFORE the connect gate, which returns on every
    // frame until it hears speech. Collecting it after the gate leaves the
    // buffer empty for the first utterance of the call — exactly the one that
    // matters, because it is the caller's "haan boliye" answering the greeting.
    // One real call clipped that word, Sarvam returned nothing for the clip, and
    // the call ended having taken zero turns.
    if (!sttContinuous && !agentSpeaking && !v.speech && !v.onset) {
      preRoll.push(pcm);
      if (preRoll.length > PREROLL_FRAMES) preRoll.shift();
    }

    if (!sttOpened) {
      if (!v.onset) return;
      sttOpened = true;
      log.info('human detected after ' + frames * FRAME_MS + 'ms (level '
        + v.level.toFixed(3) + ') — opening STT');
      openStt();
      // Open the AI session NOW, on the same signal, instead of waiting for the
      // transcript. engage() fetches the caller's CRM record, and doing it here
      // runs that lookup alongside the STT round-trip rather than after it —
      // worth the whole round-trip on the first reply. Idempotent; the engine
      // calls it again on the turn itself and the second call returns instantly.
      if (session.engage) session.engage().catch((e) => log.warn('early engage failed:', e.message));
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
      // ── A STREAMING TRANSCRIBER MUST NEVER BE STARVED ───────────────────
      // The agent's own voice comes back on the inbound track, so it must not
      // be transcribed — but for a streaming socket, sending NOTHING for the
      // eight seconds the agent talks is worse than sending the echo. Deepgram
      // endpoints on the audio it receives; an eight-second hole leaves its VAD
      // mid-utterance, the stream idles, and the next thing the caller says
      // produces interim transcripts but never a `speech_final`. The call then
      // dies on the silence timer with the customer still talking, which is
      // exactly what a live call did.
      //
      // Silence is the honest answer: it keeps the socket alive and the
      // endpointing coherent, and it cannot be mistaken for anybody speaking.
      if (sttContinuous && agentSpeaking) {
        if (!silentFrame || silentFrame.length !== pcm.length) silentFrame = Buffer.alloc(pcm.length);
        stt.write(silentFrame);
      }

      // Do NOT feed the transcriber the real audio while the agent is speaking:
      // the inbound track carries the agent's own voice back through the
      // caller's handset, and transcribing that makes the agent answer itself.
      if (!agentSpeaking) {
        // ── SEND THE UTTERANCE, NOT THE WHOLE CALL ────────────────────────
        // Every frame used to go to the transcriber, including the long gaps
        // between turns, so each request carried all the silence since the last
        // one. Two things went wrong with that. It made the upload — and the
        // transcription — grow turn after turn: 1.1s, then 2.0s, then 2.5s on
        // one real call, every millisecond of it dead air the caller sat
        // through. And on a call where the caller said one short word after a
        // long pause, the clip was almost entirely silence, Sarvam returned
        // nothing for it, and the call ended having taken zero turns.
        //
        // So only speech is sent, with a short run-up so the first syllable is
        // not clipped — a transcriber handed audio starting mid-word guesses,
        // and guesses in Hinglish are expensive.
        if (v.speech || v.onset) lastVoiceAt = Date.now();

        if (sttContinuous) {
          // A streaming transcriber does its own endpointing and is already
          // listening; gating it with a second VAD would hide the starts of
          // words from the model trying to recognise them. It transcribes as the
          // audio arrives, so there is no buffer to grow either.
          stt.write(pcm);
          session.ledger.stt(FRAME_MS / 1000);
        } else if (v.speech || v.onset) {
          if (preRoll.length) {
            for (const f of preRoll) stt.write(f);
            session.ledger.stt((preRoll.length * FRAME_MS) / 1000);
            preRoll.length = 0;
          }
          stt.write(pcm);
          session.ledger.stt(FRAME_MS / 1000);
        }

        if (v.end) {
          // The caller stopped talking VAD_SILENCE_MS ago — that window is how
          // long we waited to be sure they were finished, and they were sitting
          // in silence for all of it. Backdating is not cosmetic: measure from
          // now and the trailing-silence window becomes invisible, so tuning it
          // would never show up in the number it actually moves.
          speechEndAt = Date.now() - VAD_SILENCE_MS;
          // The transcription request goes out HERE, not when speech ended:
          // the gap between the two is the silence window, and reporting them
          // as one number would blame the vendor for our own wait.
          sttStartAt = Date.now();
          utteranceHandled = false;
          preRoll.length = 0;
          // end() means "no more audio is coming" — true at the end of a call,
          // and true for a batch transcriber that is posted one utterance at a
          // time. It is NOT true at an utterance boundary mid-call, and on a
          // streaming socket it is fatal: Deepgram's CloseStream finalises AND
          // CLOSES. The first turn worked, the socket died, and every later
          // thing the caller said went nowhere until the silence timer ended
          // the call. A streaming transcriber does its own endpointing.
          // A batch transcriber is posted the utterance; a streaming one is
          // asked to finalise what it already has. Neither is closed — see the
          // note on end() in providers/stt/deepgram.js.
          if (sttContinuous) { if (stt.flush) stt.flush(); } else stt.end();
        }
      }
    }
  });

  ws.on('close', async () => {
    liveCalls.closed();
    // AFTER the call, never during: encoding a minute of audio is CPU this
    // process owes to whoever is still on the phone.
    if (tape) {
      const finished = tape;
      tape = null;
      // try/catch AND .catch: a recording is a nice-to-have bolted onto a call
      // that has already happened. Nothing about it may be able to kill the
      // process — this handler runs on every call, including the ones that are
      // still up in other sockets.
      try {
        storeRecording(finished, callId).catch((e) => log.error('recording failed:', e.message));
      } catch (e) {
        log.error('recording failed:', e.message);
      }
    }
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

module.exports = {
  run, enabled, assertReady, mountHttp, handleMedia, publicOrigin,
  transcriptRejection, amplify, CODECS, FRAME_MS,
};
