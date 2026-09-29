/**
 * Latency benchmark — end-of-speech to first audio, the only number a caller
 * experiences.
 *
 *   npm run test:latency
 *
 * ── WHAT IS REAL HERE AND WHAT IS NOT ────────────────────────────────────────
 * The PIPELINE is real: the actual conversation engine, speech pipe, turn clock,
 * tool dispatcher, barge-in and turn serialisation.
 *
 * The VENDORS are simulated, by drivers that sleep for a configurable time
 * instead of making a network call. That is deliberate: a harness that dialled
 * Groq, Sarvam and the CRM would measure their load that afternoon, cost money
 * per run, and give a different answer every time — so it could never tell you
 * whether a CODE change helped. These numbers isolate the orchestration, which
 * is what this harness is for.
 *
 * The simulated timings are calibrated from this deployment's production logs
 * (see LATENCY.md). They are NOT vendor SLAs and must never be quoted as
 * measured end-to-end call latency — for that, read the `reply in NNNms` lines
 * the turn clock writes on real calls.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.CRM_ENABLED = 'false';

const fs = require('fs');
const os = require('os');
const path = require('path');

// A COLD cache, in a throwaway directory, before anything loads ttsCache.
//
// Not tidiness: every arm synthesises the same reply, so on the second run the
// on-disk cache served it in 4ms and the harness cheerfully reported that
// streaming was SLOWER than blocking. A benchmark that silently measures its
// own previous run is worse than no benchmark.
process.env.TTS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tapify-lat-'));

const providers = require('../providers');
const config = require('../config');

// ── Simulated vendor timings, calibrated from this deployment's logs ─────────
const LLM_TTFT_MS = Number(process.env.SIM_LLM_TTFT_MS) || 350;   // Groq gpt-oss-120b
const LLM_TOKEN_MS = Number(process.env.SIM_LLM_TOKEN_MS) || 11;
const TTS_BASE_MS = Number(process.env.SIM_TTS_BASE_MS) || 600;   // Sarvam bulbul:v3 REST
const TTS_PER_CHAR_MS = Number(process.env.SIM_TTS_PER_CHAR_MS) || 8;
const STT_MS = Number(process.env.SIM_STT_MS) || 450;             // Sarvam saaras:v3 (BATCH)
const CRM_MS = Number(process.env.SIM_CRM_MS) || 300;             // one agent-API round trip
// The VAD's end-of-turn window. Nothing downstream can start until it expires,
// so it belongs in the budget even though no vendor is involved.
const VAD_MS = Number(process.env.VAD_SILENCE_MS) || 380;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Scenarios ────────────────────────────────────────────────────────────────
// Each `reply` is written the way the persona is instructed to write: a short
// acknowledgement as its own sentence, then at most one question.

const PLAIN_REPLY = 'Achha sir, samajh gaya. '
  + 'Tapify ka NFC review card se customer ek tap mein Google review de deta hai.';

// The example from the brief: the customer reports a problem, and the agent
// must answer immediately while the query and the feedback are written away.
const QUERY_REPLY = 'Achha Namdev ji, samajh gaya — Google Business connect nahi ho raha. '
  + 'Kab se ye dikkat aa rahi hai?';

const SCENARIOS = {
  simple: {
    label: 'plain answer, no tools',
    said: 'mujhe google review ke liye kuch chahiye',
    reply: PLAIN_REPLY,
    toolCalls: [],
  },
  googleBusiness: {
    label: 'Google Business connect issue (writes a query + feedback)',
    said: 'Google Business connect nahi ho raha hai mera',
    reply: QUERY_REPLY,
    toolCalls: [
      { id: 'q1', name: 'raise_client_query', args: { topic: 'google_business', summary: 'cannot connect' } },
      { id: 'f1', name: 'log_client_feedback', args: { sentiment: 'negative', summary: 'GBP connect failing' } },
    ],
  },
};

// Turn two onwards. DISTINCT on purpose: the TTS cache is keyed on the text, so
// a benchmark that repeats one reply measures a cache hit from turn two and
// reports both arms as equally fast. Every turn of a real conversation is a
// sentence nobody has synthesised before, and that is what this must model.
const FOLLOW_UPS = [
  'Achha sir, theek hai. Aapke card ko is mahine byalis logon ne dekha hai.',
  'Samajh gaya sir. To enquiry button shayad theek se dikh nahi raha hoga.',
  'Bilkul sir, note kar liya. Aapki website ready hai lekin abhi live nahi hui.',
  'Ji sir, sahi baat hai. Main ise apni technical team tak pahuncha deta hoon.',
  'Theek hai sir, dhanyavaad. Aapko kal tak update mil jayega isske baare mein.',
];

function fakeLlm(scenario, { streaming }) {
  // Turn two onwards just answers, so a six-turn run measures steady state
  // rather than repeating the first turn's tool round six times.
  let call = 0;
  const shape = () => {
    call += 1;
    return call === 1
      ? { text: scenario.reply, toolCalls: scenario.toolCalls }
      : { text: FOLLOW_UPS[(call - 2) % FOLLOW_UPS.length], toolCalls: [] };
  };

  return {
    name: 'sim',
    model: 'sim',
    supportsStreaming: streaming,

    async chat() {
      const s = shape();
      await sleep(LLM_TTFT_MS + (s.text.split(/\s+/).length * LLM_TOKEN_MS));
      return { ...s, usage: { in: 0, out: 0, cached: 0 } };
    },

    async chatStream({ onFirstToken, onDelta, onToolCallStart }) {
      const s = shape();
      await sleep(LLM_TTFT_MS);
      // A real vendor puts tool-call fragments at the head of the stream.
      if (s.toolCalls.length && onToolCallStart) onToolCallStart(s.toolCalls[0].name);
      const pieces = s.text.match(/\S+\s*/g) || [];
      let sent = '';
      for (let i = 0; i < pieces.length; i += 1) {
        if (i === 0 && onFirstToken) onFirstToken();
        sent += pieces[i];
        if (onDelta) onDelta(pieces[i], sent);
        await sleep(LLM_TOKEN_MS);
      }
      return { ...s, usage: { in: 0, out: 0, cached: 0 } };
    },
  };
}

// Sarvam's websocket driver starts returning audio once it has buffered
// min_buffer_size characters, rather than after the whole sentence — so
// time-to-first-audio stops scaling with sentence length.
const TTS_WS_FIRST_MS = Number(process.env.SIM_TTS_WS_FIRST_MS) || 280;

function fakeTts({ streamingSynth } = {}) {
  return {
    name: 'sim',
    clientSide: false,
    textOnly: false,
    supportsStreamingSynth: Boolean(streamingSynth),
    async synth({ text, sampleRate = 8000, onChunk }) {
      const total = TTS_BASE_MS + text.length * TTS_PER_CHAR_MS;
      if (!streamingSynth || !onChunk) {
        await sleep(total);
        return {
          audio: Buffer.alloc(sampleRate * 2), mime: 'audio/L16', sampleRate, chars: text.length,
        };
      }
      // First piece early, the rest paced out across the same total.
      await sleep(TTS_WS_FIRST_MS);
      const pieces = 4;
      for (let i = 0; i < pieces; i += 1) {
        onChunk({ audio: Buffer.alloc((sampleRate * 2) / pieces), mime: 'audio/L16', sampleRate });
        if (i < pieces - 1) await sleep((total - TTS_WS_FIRST_MS) / (pieces - 1));
      }
      return { audio: Buffer.alloc(0), mime: 'audio/L16', sampleRate, chars: text.length };
    },
  };
}

/**
 * Runs a conversation and returns one latency report per turn.
 *
 * `speechEndAt` is backdated by the VAD window plus the STT round-trip, so the
 * measurement starts where the caller's silence starts. Measuring from the
 * transcript instead would hide both, which together are most of a second.
 */
async function run(scenario, {
  streaming, backgroundTools, turns = 1, streamingSynth = false, sttMs = STT_MS,
}) {
  fs.rmSync(process.env.TTS_CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.TTS_CACHE_DIR, { recursive: true });

  providers.reset();
  config.llm.streaming = streaming;
  config.llm.backgroundTools = backgroundTools;

  const sim = {
    llm: fakeLlm(scenario, { streaming }),
    stt: { name: 'sim' },
    tts: fakeTts({ streamingSynth }),
  };
  const realGet = providers.get;
  providers.get = () => sim;

  // Every tool call costs one CRM round-trip, whether it blocks or not. What
  // changes between arms is whether the CALLER waits for it.
  const realDispatcher = require('../tools').createDispatcher;
  require('../tools').createDispatcher = () => async (name) => {
    await sleep(CRM_MS);
    return { ok: true, _sim: name };
  };

  delete require.cache[require.resolve('../pipeline/conversation')];
  const { createSession } = require('../pipeline/conversation');

  const reports = [];
  const session = createSession({
    callId: 'lat',
    phone: '9820000001',
    direction: 'outbound',
    campaign: 'client_feedback',
    audioSampleRate: 8000,
    onAgentAudio: () => {},
    onEvent: (type, data) => { if (type === 'latency') reports.push(data); },
  });

  await session.start();
  for (let i = 0; i < turns; i += 1) {
    await sleep(sttMs);                        // the STT round-trip
    const sttStartAt = Date.now() - sttMs;
    await session.customerSaid(scenario.said, {
      speechEndAt: sttStartAt - VAD_MS,        // the VAD window came before it
      sttStartAt,
    });
  }
  await session.end('harness');

  providers.get = realGet;
  require('../tools').createDispatcher = realDispatcher;
  return reports;
}

/** Mean reply time per arm for the six-turn run, filled in below. */
const got6 = {};

const ms = (n) => (n === null || n === undefined ? '    —' : String(n) + 'ms');
const pad = (s, n) => String(s).padStart(n);

function summarise(reports) {
  const times = reports.map((r) => r.responseMs).filter((n) => n !== null);
  const mean = Math.round(times.reduce((a, b) => a + b, 0) / (times.length || 1));
  return { mean, worst: Math.max(...times), best: Math.min(...times), first: reports[0] };
}

(async () => {
  console.log('\n══ Latency benchmark — simulated vendors, real pipeline ══\n');
  console.log('  VAD end-of-turn window   ' + VAD_MS + 'ms   (nothing can start before this)');
  console.log('  STT  ' + STT_MS + 'ms   batch — cannot start until the caller stops');
  console.log('  LLM  ' + LLM_TTFT_MS + 'ms to first token, then ' + LLM_TOKEN_MS + 'ms/token');
  console.log('  TTS  ' + TTS_BASE_MS + 'ms + ' + TTS_PER_CHAR_MS + 'ms/char');
  console.log('  CRM  ' + CRM_MS + 'ms per tool call\n');

  const arms = [
    { key: 'before', label: 'before  (blocking LLM, sequential tools)', streaming: false, backgroundTools: false },
    { key: 'after', label: 'after   (streamed LLM, deferred writes)', streaming: true, backgroundTools: true },
  ];

  let regression = false;

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    console.log('── ' + scenario.label + ' ──');
    const got = {};
    for (const arm of arms) {
      const reports = await run(scenario, arm);
      got[arm.key] = reports[0];
      const r = reports[0];
      const l = r.legs;
      console.log('  ' + arm.label);
      console.log('    end-of-speech -> first audio   ' + pad(ms(r.responseMs), 8));
      console.log('      stt ' + ms(l.stt) + '  llm->1st ' + ms(l.llm_first_token)
        + '  llm ' + ms(l.llm_total) + '  tts->1st ' + ms(l.tts_first_audio)
        + '  tools ' + ms(l.tool));
    }
    const saved = got.before.responseMs - got.after.responseMs;
    const pct = Math.round((saved / got.before.responseMs) * 100);
    console.log('    SAVED ' + saved + 'ms (' + pct + '%)\n');
    if (saved <= 0) regression = true;
  }

  // The six-turn conversation, steady state.
  console.log('── six-turn conversation ──');
  for (const arm of arms) {
    const reports = await run(SCENARIOS.simple, { ...arm, turns: 6 });
    const s = summarise(reports);
    console.log('  ' + arm.label);
    console.log('    mean ' + ms(s.mean) + '   best ' + ms(s.best) + '   worst ' + ms(s.worst)
      + '   over ' + reports.length + ' turns');
    got6[arm.key] = s.mean;
  }
  console.log('    SAVED ' + (got6.before - got6.after) + 'ms per turn\n');
  if (got6.before - got6.after <= 0) regression = true;

  // ── What the two remaining vendor changes would buy ────────────────────────
  // Neither is switched on by default. Measured here so the decision is made
  // against numbers rather than against a hunch.
  console.log('── the remaining vendor levers (not enabled by default) ──');
  const base = { streaming: true, backgroundTools: true };
  const variants = [
    ['shipped default           (Sarvam REST TTS, Sarvam batch STT)', {}],
    ['+ TTS_PROVIDER=sarvam_stream                                  ', { streamingSynth: true }],
    ['+ streaming STT too       (STT_PROVIDER=deepgram)             ', { streamingSynth: true, sttMs: 80 }],
  ];
  for (const [label, extra] of variants) {
    const reports = await run(SCENARIOS.simple, { ...base, ...extra });
    console.log('  ' + label + '  ' + pad(ms(reports[0].responseMs), 8));
  }
  console.log('\n  Target: 500-1000ms. See LATENCY.md for the trade-offs behind each.\n');

  try { fs.rmSync(process.env.TTS_CACHE_DIR, { recursive: true, force: true }); } catch (e) { /* temp */ }

  if (regression) {
    console.log('FAILED: a scenario got no faster. The pipeline has stopped overlapping.\n');
    process.exit(1);
  }
  console.log('OK — every scenario improved.\n');
})().catch((e) => { console.error(e); process.exit(1); });
