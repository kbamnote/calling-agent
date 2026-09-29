/**
 * Compares LLM models on the two numbers a phone call cares about.
 *
 *   npm run bench:models
 *   npm run bench:models -- openai/gpt-oss-20b openai/gpt-oss-120b llama-3.3-70b-versatile
 *
 * Unlike testLatency.js, this one makes REAL requests: it is the only way to
 * learn a vendor's actual time-to-first-token, which is the thing that decides
 * whether a smaller model is worth the quality drop. It therefore needs
 * OPENAI_API_KEY (your Groq key) and it spends tokens — a default run is a
 * handful of short completions per model.
 *
 * ── WHAT IT MEASURES AND WHY ─────────────────────────────────────────────────
 * TIME TO FIRST TOKEN is what matters here, not total completion time. The
 * speech pipe starts synthesising at the first completed SENTENCE, so a model
 * that begins writing 200ms sooner puts audio on the line 200ms sooner, whether
 * or not it finishes sooner. Total time only starts to matter once it exceeds
 * the time the first sentence takes to synthesise.
 *
 * It also reports reply LENGTH, because a model that writes twice as much is
 * slower in a way no latency number shows: every extra character is TTS time
 * and airtime the caller sits through.
 */
require('dotenv').config();

const config = require('../config');
const persona = require('../pipeline/persona');
const tools = require('../tools');

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];

const ROUNDS = Number(process.env.BENCH_ROUNDS) || 3;

// Real turns from a feedback call, including the one the brief names. Each is
// run from a clean history so the models see identical input.
const TURNS = [
  'haan boliye',
  'Google Business connect nahi ho raha hai mera',
  'do hafte se try kar raha hoon lekin ho hi nahi raha',
];

const CLIENT = {
  ok: true,
  isClient: true,
  name: 'Namdev Bisen',
  appInstalled: false,
  health: 'slipping',
  views30d: 42,
  lastSeenDays: 34,
};

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function benchOne(model) {
  // The registry caches its drivers, so the model has to be set before the
  // driver is built — and rebuilt for each model under test.
  config.llm.model = model;
  const providers = require('../providers');
  providers.reset();
  const llm = providers.get().llm;

  if (!llm.chatStream) throw new Error(model + ': this driver cannot stream — nothing to measure');

  const system = persona.buildSystemPrompt({
    direction: 'outbound', campaign: 'client_feedback', client: CLIENT,
  });
  const toolDefs = tools.definitionsFor('client_feedback');

  const ttft = [];
  const total = [];
  const lengths = [];
  let failures = 0;

  for (let round = 0; round < ROUNDS; round += 1) {
    for (const said of TURNS) {
      const started = Date.now();
      let firstAt = null;
      try {
        const res = await llm.chatStream({
          system,
          messages: [{ role: 'user', content: said }],
          tools: toolDefs,
          maxTokens: config.llm.maxTokens,
          onFirstToken: () => { firstAt = Date.now() - started; },
        });
        if (firstAt !== null) ttft.push(firstAt);
        total.push(Date.now() - started);
        lengths.push((res.text || '').length);
      } catch (e) {
        failures += 1;
        process.stdout.write('  ! ' + model + ': ' + e.message.slice(0, 110) + '\n');
      }
    }
  }

  const sortedT = [...ttft].sort((a, b) => a - b);
  const sortedA = [...total].sort((a, b) => a - b);
  const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

  return {
    model,
    samples: total.length,
    failures,
    ttftMean: mean(ttft),
    ttftP90: pct(sortedT, 90),
    totalMean: mean(sortedA),
    replyChars: mean(lengths),
  };
}

const cell = (v, w) => String(v === null || v === undefined ? '—' : v).padStart(w);

(async () => {
  if (!config.llm.openaiKey) {
    console.log('\nOPENAI_API_KEY is not set. This benchmark makes real requests —'
      + ' set your Groq key and run it again.\n');
    process.exit(1);
  }
  console.log('\n══ Model benchmark — REAL requests against ' + config.llm.openaiBaseUrl + ' ══');
  console.log('  ' + TURNS.length + ' turns x ' + ROUNDS + ' rounds per model, feedback persona + tools\n');

  const rows = [];
  for (const model of MODELS) {
    process.stdout.write('  measuring ' + model + ' ...');
    try {
      const r = await benchOne(model);
      rows.push(r);
      process.stdout.write(' done\n');
    } catch (e) {
      console.log(' FAILED: ' + e.message.slice(0, 140));
    }
  }

  console.log('\n  model                          TTFT   TTFT p90   total   reply   n   fail');
  for (const r of rows) {
    console.log('  ' + r.model.padEnd(28)
      + cell(r.ttftMean, 6) + cell(r.ttftP90, 10) + cell(r.totalMean, 8)
      + cell(r.replyChars, 8) + cell(r.samples, 4) + cell(r.failures, 6));
  }

  console.log('\n  TTFT is the number that moves reply latency: the speech pipe starts');
  console.log('  synthesising at the first finished SENTENCE, so a model that begins');
  console.log('  writing sooner puts audio on the line sooner even if it finishes later.');
  console.log('  `reply` is average characters — every extra one is TTS time and airtime.');
  console.log('\n  A faster model is only worth it if the conversation holds up. Listen to');
  console.log('  a real call before switching LLM_MODEL on the strength of this table.\n');
})().catch((e) => { console.error(e); process.exit(1); });
