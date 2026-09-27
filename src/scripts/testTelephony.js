/**
 * Telephony transport tests — a simulated phone call, offline.
 *
 *   npm run test:telephony
 *
 * Drives the REAL media handler with Plivo-shaped websocket messages through a
 * fake socket: a start event, then PCM frames of silence and of speech. The
 * speech drivers are stubbed, so no keys, no network, no phone number and no
 * trial credits are involved.
 *
 * This exists because every bug in this file so far has only shown up on a live
 * call, where the feedback loop is minutes long and the symptom is always the
 * same useless sentence — "it connects but nothing happens". Each case below is
 * a bug that actually shipped:
 *
 *   • the connect gate read `vad.everSpoke()`, which push() had already flipped,
 *     so STT was never opened and the call died on the silence timeout;
 *   • a whole utterance was dumped into Plivo's buffer at once, overflowing it
 *     so the greeting cut off mid-sentence;
 *   • audio went out as `media` events instead of `playAudio`, so nothing played.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.STT_PROVIDER = 'sarvam';
process.env.TTS_PROVIDER = 'sarvam';
process.env.SARVAM_API_KEY = 'stub';
process.env.TELEPHONY_PROVIDER = 'plivo';
process.env.CRM_ENABLED = 'false';
process.env.LOG_LEVEL = process.env.TEST_VERBOSE ? 'debug' : 'error';

const { EventEmitter } = require('events');
const config = require('../config');
const providers = require('../providers');
const telephony = require('../transport/telephony');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label
    + (ok ? '' : '\n          got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)));
  ok ? pass += 1 : fail += 1;
}
const truthy = (l, v) => check(l, Boolean(v), true);
const falsy = (l, v) => check(l, Boolean(v), false);

const SAMPLE_RATE = 16000;
const FRAME_BYTES = (SAMPLE_RATE * 2 * 20) / 1000;   // 640

/** One 20ms frame at a given amplitude — 0 is silence, 0.3 is clear speech. */
function frame(amplitude) {
  const buf = Buffer.alloc(FRAME_BYTES);
  if (amplitude > 0) {
    for (let i = 0; i < FRAME_BYTES / 2; i += 1) {
      // A tone, not noise: deterministic, and its RMS is predictable.
      buf.writeInt16LE(Math.round(Math.sin(i / 4) * amplitude * 32767), i * 2);
    }
  }
  return buf;
}

/** A websocket stand-in that records what the transport sent. */
function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.OPEN = 1;
  ws.sent = [];
  ws.send = (raw) => ws.sent.push(JSON.parse(raw));
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  return ws;
}

const startEvent = {
  event: 'start',
  sequenceNumber: 1,
  start: {
    callId: 'sim-call-1',
    streamId: 'sim-stream-1',
    accountId: 'SIM',
    tracks: ['inbound'],
    mediaFormat: { encoding: 'audio/x-l16', sampleRate: SAMPLE_RATE },
  },
};

const mediaEvent = (pcm) => ({
  event: 'media',
  streamId: 'sim-stream-1',
  media: { track: 'inbound', payload: pcm.toString('base64') },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── stub the speech drivers ───────────────────────────────────────────────
  const t = providers.get();
  const sttStreams = [];
  t.stt.supportsPartials = false;
  t.stt.createStream = (opts) => {
    const s = { writes: 0, ended: false, opts };
    sttStreams.push(s);
    s.write = () => { s.writes += 1; };
    // Batch STT: the transcript lands when the utterance ends.
    s.end = () => { s.ended = true; opts.onFinal('haan boliye'); };
    s.close = () => {};
    return s;
  };
  // ~0.5s of audio, so playback timing is realistic without slowing the test.
  t.tts.synth = async ({ text }) => ({
    audio: Buffer.alloc(SAMPLE_RATE * 2 * 0.5),
    mime: 'audio/L16',
    sampleRate: SAMPLE_RATE,
    chars: text.length,
  });
  t.tts.clientSide = false;
  t.tts.textOnly = false;

  console.log('\n── 1. the answer XML Plivo is given ──');
  {
    const routes = {};
    const app = {
      get: (p, h) => { routes['GET ' + p] = h; },
      post: (p, h) => { routes['POST ' + p] = h; },
      all: (p, h) => { routes['ALL ' + p] = h; },
    };
    telephony.mountHttp(app);
    truthy('answer route is mounted for POST', routes['POST /telephony/answer']);

    let xml = '';
    routes['POST /telephony/answer'](
      { query: {}, body: { From: '+919822000000', To: '+918031729919', CallUUID: 'abc', Direction: 'inbound' },
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'voice.example.com' } },
      { type: () => ({ send: (b) => { xml = b; } }) },
    );
    truthy('declares a bidirectional stream', xml.includes('bidirectional="true"'));
    truthy('keeps the call alive after the stream', xml.includes('keepCallAlive="true"'));
    truthy('uses L16 at the codec rate', xml.includes('contentType="audio/x-l16;rate=16000"'));
    truthy('points at wss on the public host', xml.includes('wss://voice.example.com/media'));
    // Plivo's start event carries no caller number, so it must ride on the URL.
    truthy('carries the caller number', xml.includes('from=%2B919822000000'));
    truthy('XML-escapes the query separator', xml.includes('&amp;'));
    falsy('and leaks no raw ampersand', /&(?!amp;)/.test(xml));
  }

  console.log('\n── 2. the greeting plays, and as playAudio ──');
  const ws = fakeSocket();
  {
    telephony.handleMedia(ws, { url: '/media?from=919822000000&direction=inbound&callId=sim-call-1' });
    ws.emit('message', Buffer.from(JSON.stringify(startEvent)));
    await sleep(400);

    const audio = ws.sent.filter((m) => m.event === 'playAudio');
    truthy('audio was sent', audio.length > 0);
    check('as playAudio, not a media event', ws.sent.some((m) => m.event === 'media'), false);
    check('with the codec content type', audio[0].media.contentType, 'audio/x-l16');
    check('and its sample rate', audio[0].media.sampleRate, SAMPLE_RATE);

    // The overflow bug: one message carried ~9s of audio and Plivo cleared it.
    const biggest = Math.max(...audio.map((m) => Buffer.from(m.media.payload, 'base64').length));
    const maxMs = (biggest / (SAMPLE_RATE * 2)) * 1000;
    truthy('no single message carries more than ~200ms of audio (was ~1s)', maxMs <= 200);
  }

  console.log('\n── 3. the connect gate: silence opens nothing ──');
  {
    for (let i = 0; i < 40; i += 1) ws.emit('message', Buffer.from(JSON.stringify(mediaEvent(frame(0)))));
    await sleep(50);
    check('no STT stream for silence', sttStreams.length, 0);
  }

  console.log('\n── 4. ...and speech opens exactly one ──');
  {
    // Speech, then enough trailing silence for the VAD to close the utterance.
    for (let i = 0; i < 30; i += 1) ws.emit('message', Buffer.from(JSON.stringify(mediaEvent(frame(0.3)))));
    await sleep(50);
    check('STT opened on speech', sttStreams.length, 1);
    truthy('and audio is being fed to it', sttStreams[0].writes > 0);
    check('at the codec sample rate', sttStreams[0].opts.sampleRate, SAMPLE_RATE);

    for (let i = 0; i < 60; i += 1) ws.emit('message', Buffer.from(JSON.stringify(mediaEvent(frame(0)))));
    await sleep(50);
    truthy('the utterance was closed so a batch STT can transcribe', sttStreams[0].ended);
    check('still only one STT stream', sttStreams.length, 1);
  }

  console.log('\n── 5. barge-in clears the provider buffer ──');
  {
    const before = ws.sent.filter((m) => m.event === 'clearAudio').length;
    for (let i = 0; i < 30; i += 1) ws.emit('message', Buffer.from(JSON.stringify(mediaEvent(frame(0.3)))));
    await sleep(50);
    const after = ws.sent.filter((m) => m.event === 'clearAudio').length;
    truthy('clearAudio was sent when the caller spoke', after > before);
    const clear = ws.sent.filter((m) => m.event === 'clearAudio').pop();
    check('and it names the stream', clear.streamId, 'sim-stream-1');
  }

  console.log('\n── 6. the transcript reaches the conversation ──');
  {
    // onFinal fired in case 4 — the session should have taken a turn from it.
    await sleep(200);
    truthy('the agent replied to the transcribed speech',
      ws.sent.filter((m) => m.event === 'playAudio').length > 1);
  }

  console.log('\n── 7. the line closing ends the call ──');
  {
    ws.close();
    await sleep(300);
    truthy('socket closed cleanly', ws.readyState === 3);
  }

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
