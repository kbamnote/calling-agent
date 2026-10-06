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

    // OUTBOUND flips which end is the customer: Plivo sends From = OUR number
    // and To = the person we rang. Using From for both made the agent look
    // ITSELF up in the CRM, so a real customer came back "not a known client".
    let outXml = '';
    routes['POST /telephony/answer'](
      { query: {}, body: { From: '+918031729919', To: '+919370339841', CallUUID: 'o1', Direction: 'outbound' },
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'voice.example.com' } },
      { type: () => ({ send: (b) => { outXml = b; } }) },
    );
    truthy('an outbound call carries the CUSTOMER, not our own number',
      outXml.includes('from=%2B919370339841'));
    falsy('and never our Plivo number', outXml.includes('from=%2B918031729919'));
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

  console.log('\n── 7. one utterance becomes exactly one turn ──');
  {
    // A batch STT that retries, or an end() racing a close(), can deliver the
    // same final twice. Unguarded that runs the turn through the model twice and
    // the caller hears a second reply talking over the first — and pays for it.
    const stream = sttStreams[sttStreams.length - 1];
    const before = ws.sent.filter((m) => m.event === 'playAudio').length;

    stream.opts.onFinal('haan boliye');
    stream.opts.onFinal('haan boliye');
    await sleep(250);

    check('a repeated final transcript is ignored',
      ws.sent.filter((m) => m.event === 'playAudio').length, before);
  }

  console.log('\n── 7b. a transcript the recogniser is unsure of is not a turn ──');
  {
    // From a live call: "boliye" came back as "Vei dici?" and "haan" as
    // "Si, dice." — nova-3 multilingual reaching for Italian and Spanish on
    // noisy Indian phone audio. Both were acted on, and the conversation
    // followed the guess rather than the customer.
    const { transcriptRejection } = require('../transport/telephony');
    const drops = (text, meta, heardVoice = true) =>
      Boolean(transcriptRejection({ text, meta, heardVoice }));

    truthy('a low-confidence transcript is dropped',
      drops('Vei dici?', { confidence: 0.21, languages: ['it'] }));
    truthy('and so is a CONFIDENT one in a language these calls are never in',
      drops('Si, dice.', { confidence: 0.95, languages: ['es'] }));
    truthy('text with no voice behind it is still dropped',
      drops('Exacto.', { confidence: 0.9, languages: ['es'] }, false));

    // The normal case must survive all three rules.
    falsy('Hinglish tagged with BOTH languages is a turn',
      drops('haan install nahi kiya', { confidence: 0.92, languages: ['hi', 'en'] }));
    falsy('a region-tagged language still matches on its primary subtag',
      drops('haan', { confidence: 0.88, languages: ['hi-latn'] }));
    falsy('and a provider reporting no metadata is not silently muted',
      drops('theek hai bhejiye', {}));
  }

  console.log('\n── 8. the latency clock measures from end of speech ──');
  {
    // The report must start where the CALLER's silence starts. Measuring from
    // the transcript instead would hide the VAD's trailing-silence window and
    // the whole STT round-trip — about a third of the real wait.
    const reports = [];
    const { createSession } = require('../pipeline/conversation');
    const s = createSession({
      callId: 'clock_test',
      phone: '9820000041',
      audioSampleRate: SAMPLE_RATE,
      onAgentAudio: () => {},
      onEvent: (type, data) => { if (type === 'latency') reports.push(data); },
    });
    await s.start();

    const speechEndAt = Date.now() - 900;        // they stopped talking 900ms ago
    await s.customerSaid('haan boliye', { speechEndAt });
    await s.end('test');

    truthy('a latency report was emitted', reports.length > 0);
    const r = reports[0];
    falsy('the zero point is the real one, not an estimate', r.estimated);
    truthy('the transcript stage already includes the wait so far', r.transcript >= 900);
    truthy('first audio is reported after the transcript', r.audio_out >= r.transcript);
    truthy('and the reply time is the caller-facing number', r.responseMs === r.audio_out);
  }

  console.log('\n── 9. the transcriber gets the utterance, not the whole call ──');
  {
    // From a live call: every frame went to the transcriber, including the long
    // gaps between turns, so each request carried all the silence since the last
    // one. Transcription grew turn after turn — 1.1s, 2.0s, 2.5s, all of it dead
    // air the caller sat through — and on one call the clip was so nearly all
    // silence that Sarvam returned nothing and the call took ZERO turns.
    // A FRESH call, so the counts are not inherited from the VAD state the
    // earlier sections left behind.
    const ws2 = fakeSocket();
    telephony.handleMedia(ws2, { url: '/media?from=919822000000&direction=inbound&callId=sim-call-2' });
    ws2.emit('message', JSON.stringify({ ...startEvent, start: { ...startEvent.start, callId: 'sim-call-2', streamId: 'sim-stream-2' } }));
    // Wait out the greeting. Audio arriving while the agent is still speaking is
    // deliberately not transcribed (it is the agent's own voice echoing back),
    // so feeding frames before it finishes would measure the echo guard rather
    // than the utterance trimming this section is about.
    await sleep(1200);
    const streamsBefore = sttStreams.length;

    // Five seconds of silence before anybody speaks must cost nothing at all.
    for (let i = 0; i < 250; i += 1) ws2.emit('message', JSON.stringify(mediaEvent(frame(0))));
    await sleep(80);
    check('250 frames of silence open no transcription at all',
      sttStreams.length, streamsBefore);

    // Now speech: the gate opens, and the run-up goes with it.
    for (let i = 0; i < 40; i += 1) ws2.emit('message', JSON.stringify(mediaEvent(frame(0.3))));
    await sleep(80);
    truthy('speech opens a transcription stream', sttStreams.length > streamsBefore);
    const wrote = sttStreams[sttStreams.length - 1].writes;
    truthy('speech opens the transcriber and is sent', wrote > 0);
    truthy('with a run-up, so the first syllable is not clipped', wrote > 40);
    // A run-up, though — not the five seconds of silence that preceded it.
    truthy('and the run-up is bounded, not the whole call', wrote < 40 + 40);
    ws2.close();
  }

  console.log('\n── 10. a streaming transcriber is never starved ──');
  {
    // A live call died here twice. The transport withheld audio for the eight
    // seconds the agent was speaking, which is right for a batch driver and
    // fatal for a socket: Deepgram endpoints on the audio it receives, so an
    // eight-second hole left its VAD mid-utterance and the next thing the
    // caller said produced interim transcripts but never a speech_final.
    const t2 = providers.get();
    const realCreate = t2.stt.createStream;
    const realPartials = t2.stt.supportsPartials;
    const realContinuous = t2.stt.streamsContinuously;
    t2.stt.supportsPartials = true;
    t2.stt.streamsContinuously = true;

    let streamRef = null;
    t2.stt.createStream = (opts) => {
      const st = { writes: 0, silent: 0, ended: 0, opts };
      streamRef = st;
      st.write = (buf) => {
        st.writes += 1;
        // A frame of pure zeroes is the keep-alive, not the caller.
        if (buf.every ? buf.every((b) => b === 0) : false) st.silent += 1;
      };
      st.end = () => { st.ended += 1; };
      st.close = () => {};
      return st;
    };

    const ws3 = fakeSocket();
    telephony.handleMedia(ws3, { url: '/media?from=919822000000&direction=inbound&callId=sim-call-3' });
    ws3.emit('message', JSON.stringify({ ...startEvent, start: { ...startEvent.start, callId: 'sim-call-3', streamId: 'sim-stream-3' } }));
    await sleep(60);

    // Speech opens the stream, then the agent's greeting plays over the top.
    for (let i = 0; i < 30; i += 1) ws3.emit('message', JSON.stringify(mediaEvent(frame(0.3))));
    await sleep(40);
    const beforeSilence = streamRef ? streamRef.silent : -1;
    // Frames arriving while the agent speaks.
    for (let i = 0; i < 40; i += 1) ws3.emit('message', JSON.stringify(mediaEvent(frame(0.3))));
    await sleep(40);

    truthy('the stream was opened', streamRef !== null);
    truthy('it keeps receiving frames while the agent speaks',
      streamRef && streamRef.silent > beforeSilence);
    truthy('and what it receives then is SILENCE, not the agent echoing back',
      streamRef && streamRef.silent > 0);
    check('and the socket is never closed mid-call', streamRef ? streamRef.ended : -1, 0);

    t2.stt.createStream = realCreate;
    t2.stt.supportsPartials = realPartials;
    t2.stt.streamsContinuously = realContinuous;
    ws3.close();
  }

  console.log('\n── 11. the line closing ends the call ──');
  {
    ws.close();
    await sleep(300);
    truthy('socket closed cleanly', ws.readyState === 3);
  }

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
