/**
 * Latency harness — measures end-of-speech to first audio, the only number a
 * caller experiences.
 *
 *   npm run test:latency
 *
 * ── WHAT IS REAL HERE AND WHAT IS NOT ────────────────────────────────────────
 * The PIPELINE is real: the actual conversation engine, the actual speech pipe,
 * the actual turn clock, the actual barge-in and turn serialisation.
 *
 * The VENDORS are simulated, by drivers that sleep for a configurable time
 * instead of making a network call. That is a deliberate trade: a harness that
 * dialled Groq and Sarvam would measure their load that afternoon, would cost
 * money per run, and would give a different answer every time — so it could
 * never tell you whether a CODE change helped. These numbers isolate the
 * orchestration, which is the thing this harness is for.
 *
 * The simulated timings are calibrated from production logs on this deployment
 * (see LATENCY.md). They are NOT vendor SLAs and must never be quoted as
 * measured end-to-end call latency — for that, read the `reply in NNNms` lines
 * the turn clock writes on real calls.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.CRM_ENABLED = 'false';
process.env.THINKING_FILLER_MS = process.env.THINKING_FILLER_MS || '0';

const fs = require('fs');
const os = require('os');
const path = require('path');

// A COLD cache, in a throwaway directory, before anything loads ttsCache.
//
// This is not tidiness. Both arms of the comparison synthesise the same reply,
// so on the second run the on-disk cache served it in 4ms and the harness
// cheerfully reported that streaming was SLOWER than blocking. A benchmark that
// silently measures its own previous run is worse than no benchmark.
process.env.TTS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tapify-lat-'));

const providers = require('../providers');
const config = require('../config');

// ── Simulated vendor timings, calibrated from this deployment's logs ─────────
// LLM: Groq openai/gpt-oss-120b measured ~790ms for a two-sentence reply.
const LLM_TTFT_MS = Number(process.env.SIM_LLM_TTFT_MS) || 350;
const LLM_TOKEN_MS = Number(process.env.SIM_LLM_TOKEN_MS) || 11;
// TTS: Sarvam bulbul:v3 measured ~2.5s for a full 240-character reply. Latency
// scales with input length, which is precisely why one long request is the
// worst shape and why chunking wins.
const TTS_BASE_MS = Number(process.env.SIM_TTS_BASE_MS) || 600;
const TTS_PER_CHAR_MS = Number(process.env.SIM_TTS_PER_CHAR_MS) || 8;
// STT: Sarvam saaras:v3 is a BATCH endpoint — the request cannot start until
// the caller has stopped talking, so this sits squarely on the critical path.
const STT_MS = Number(process.env.SIM_STT_MS) || 450;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A two-sentence reply of the length the persona actually produces. */
const REPLY = 'Sir, aapke business ke liye Tapify ka NFC review card sabse sahi rahega. '
  + 'Isse customer ek tap mein Google review de deta hai aur aapki rating tezi se badhti hai.';

function fakeLlm({ streaming }) {
  return {
    name: 'sim',
    model: 'sim',
    supportsStreaming: streaming,

    async chat() {
      const tokens = REPLY.split(/\s+/).length;
      await sleep(LLM_TTFT_MS + tokens * LLM_TOKEN_MS);
      return { text: REPLY, toolCalls: [], usage: { in: 0, out: 0, cached: 0 } };
    },

    async chatStream({ onFirstToken, onDelta }) {
      await sleep(LLM_TTFT_MS);
      const pieces = REPLY.match(/\S+\s*/g) || [];
      let sent = '';
      for (let i = 0; i < pieces.length; i += 1) {
        if (i === 0 && onFirstToken) onFirstToken();
        sent += pieces[i];
        if (onDelta) onDelta(pieces[i], sent);
        await sleep(LLM_TOKEN_MS);
      }
      return { text: REPLY, toolCalls: [], usage: { in: 0, out: 0, cached: 0 } };
    },
  };
}

function fakeTts() {
  return {
    name: 'sim',
    clientSide: false,
    textOnly: false,
    async synth({ text, sampleRate = 8000 }) {
      await sleep(TTS_BASE_MS + text.length * TTS_PER_CHAR_MS);
      // One second of silence per chunk — the engine only measures its length.
      return {
        audio: Buffer.alloc(sampleRate * 2), mime: 'audio/L16', sampleRate, chars: text.length,
      };
    },
  };
}

/**
 * Runs one turn through the real engine and returns the turn clock's report.
 *
 * `speechEndAt` is backdated by STT_MS so the measurement starts where the
 * caller's silence starts, not where our code happens to be handed a transcript
 * — measuring from the transcript would hide the batch STT round-trip, which is
 * a real and unavoidable part of the wait.
 */
async function runTurn({ streaming }) {
  // Cold for EVERY arm, not just the first: both arms synthesise the same reply,
  // so without this the second one reads its answer off the first one's cache
  // and the comparison measures nothing.
  fs.rmSync(process.env.TTS_CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.TTS_CACHE_DIR, { recursive: true });

  providers.reset();
  config.llm.streaming = streaming;
  const sim = { llm: fakeLlm({ streaming }), stt: { name: 'sim' }, tts: fakeTts() };
  const realGet = providers.get;
  providers.get = () => sim;

  // Required AFTER the stub is in place: the engine resolves its drivers once,
  // at session construction.
  delete require.cache[require.resolve('../pipeline/conversation')];
  const { createSession } = require('../pipeline/conversation');

  let report = null;
  let zero = 0;
  const audioAt = [];             // ms from end-of-speech to each chunk
  const session = createSession({
    callId: 'lat_' + (streaming ? 'stream' : 'block'),
    phone: '9820000001',
    direction: 'outbound',
    audioSampleRate: 8000,
    onAgentAudio: () => { if (zero) audioAt.push(Date.now() - zero); },
    onEvent: (type, data) => { if (type === 'latency') report = data; },
  });

  await session.start();
  await sleep(STT_MS);            // the batch STT round-trip
  zero = Date.now() - STT_MS;
  await session.customerSaid('mujhe google review ke liye kuch chahiye', { speechEndAt: zero });
  await session.end('harness');

  providers.get = realGet;
  return { ...report, audioAt };
}

function fmt(n) { return n === null || n === undefined ? '   —' : String(n).padStart(4) + 'ms'; }

(async () => {
  console.log('\nLatency harness — simulated vendors, real pipeline');
  console.log('  LLM   ' + LLM_TTFT_MS + 'ms to first token + ' + LLM_TOKEN_MS + 'ms/token');
  console.log('  TTS   ' + TTS_BASE_MS + 'ms + ' + TTS_PER_CHAR_MS + 'ms/char');
  console.log('  STT   ' + STT_MS + 'ms (batch — cannot start until speech ends)');
  console.log('  reply ' + REPLY.length + ' chars\n');

  // Blocking first, so the "before" number is produced by the same code path the
  // service falls back to when a vendor cannot stream.
  const before = await runTurn({ streaming: false });
  const after = await runTurn({ streaming: true });

  const rows = [
    ['transcript', before.transcript, after.transcript],
    ['llm_first_token', before.llm_first_token, after.llm_first_token],
    ['llm_done', before.llm_done, after.llm_done],
    ['tts_first_audio', before.tts_first_audio, after.tts_first_audio],
    ['audio_out', before.audio_out, after.audio_out],
  ];

  console.log('  stage             blocking   streaming');
  for (const [name, b, a] of rows) {
    console.log('  ' + name.padEnd(18) + fmt(b) + '     ' + fmt(a));
  }

  const b = before.responseMs;
  const a = after.responseMs;
  const saved = b - a;
  const pct = Math.round((saved / b) * 100);

  console.log('\n  audio chunks reached the transport at');
  console.log('    blocking   ' + before.audioAt.join('ms, ') + 'ms');
  console.log('    streaming  ' + after.audioAt.join('ms, ') + 'ms');

  console.log('\n  END-OF-SPEECH TO FIRST AUDIO');
  console.log('    blocking   ' + b + 'ms');
  console.log('    streaming  ' + a + 'ms   (' + after.chunks + ' chunks)');
  console.log('    saved      ' + saved + 'ms  (' + pct + '%)\n');

  // A regression here means the pipeline stopped overlapping synthesis with
  // generation — the whole point of speechPipe. Fail the run rather than print
  // a worse number and let it pass unnoticed.
  if (saved <= 0) {
    console.log('FAILED: streaming was not faster. The speech pipe is not overlapping.');
    process.exit(1);
  }
  console.log('OK — streaming is ' + saved + 'ms faster on this scenario.\n');
  try { fs.rmSync(process.env.TTS_CACHE_DIR, { recursive: true, force: true }); } catch (e) { /* temp */ }
})().catch((e) => { console.error(e); process.exit(1); });
