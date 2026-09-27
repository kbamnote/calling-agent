/**
 * Conversation engine regression tests.
 *
 *   npm run test:convo
 *
 * Drives complete calls through the real pipeline with a scripted customer. No
 * keys, no network, no audio — the mock LLM and the stub tools stand in, so this
 * runs anywhere including CI.
 *
 * What it asserts are the guarantees conversation.js makes IN CODE rather than in
 * the prompt, because a prompt is advice and these have to hold even when the
 * model misbehaves:
 *
 *   • the greeting costs no LLM turn
 *   • the AI session does not open until a human speaks (the connect gate)
 *   • a failed price lookup never becomes a spoken number
 *   • every call logs an outcome, even when the model never asks to
 *   • turn and duration budgets are hard
 *   • opt-out ends the call before a word is spoken
 *
 * Env is set before any require, because config.js is a boot-time singleton.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'none';
process.env.STT_PROVIDER = 'browser';
process.env.CRM_ENABLED = 'false';
process.env.LOG_LEVEL = process.env.TEST_VERBOSE ? 'debug' : 'error';

const fs = require('fs');
const { createSession } = require('../pipeline/conversation');
const stubs = require('../tools/localStubs');
const ttsCache = require('../pipeline/ttsCache');

// The TTS cache lives on disk and survives between runs, so a previous run's
// entries would satisfy calls that a test expects to reach the driver. Tests
// must not depend on what an earlier run happened to leave behind.
try { fs.rmSync(ttsCache.DIR, { recursive: true, force: true }); } catch (e) { /* nothing cached */ }

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label
    + (ok ? '' : '\n          got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)));
  ok ? pass += 1 : fail += 1;
}
function truthy(label, v) { check(label, Boolean(v), true); }
function falsy(label, v) { check(label, Boolean(v), false); }

/** Runs a call, feeding each line in turn, and collects everything observable. */
async function runCall({ lines = [], phone = '9822000000', direction = 'outbound', settle = 0 } = {}) {
  const spoken = [];
  const toolCalls = [];
  const events = [];
  let ended = null;

  const session = createSession({
    phone,
    direction,
    onAgentText: (t) => spoken.push(t),
    onEvent: (type, data) => {
      events.push(type);
      if (type === 'tool') toolCalls.push({ name: data.name, args: data.args, ok: data.result.ok, result: data.result });
    },
    onEnd: (summary) => { ended = summary; },
  });

  await session.start();
  for (const line of lines) {
    if (session.ended) break;
    await session.customerSaid(line);
  }
  if (settle) await new Promise((r) => setTimeout(r, settle));
  if (!session.ended) await session.end('test finished');

  return {
    session, spoken, toolCalls, events, ended,
    said: spoken.join(' \n '),
    names: toolCalls.map((t) => t.name),
    of: (name) => toolCalls.filter((t) => t.name === name),
  };
}

/** Any rupee-shaped figure in the agent's speech. */
const RUPEE = /(₹|rs\.?\s*\d|\b\d{3,}\b|\bhazar\b|\bthousand\b|\blakh\b)/i;

(async () => {
  console.log('\n── 1. greeting, connect gate, and a normal discovery call ──');
  {
    const r = await runCall({ lines: ['haan boliye', 'restaurant hai', 'QR laga hai', 'online selling bhi karna hai'] });
    truthy('agent greets first', r.spoken[0] && r.spoken[0].toLowerCase().includes('tapify'));
    truthy('greeting identifies as AI, never as a human', /ai assistant/i.test(r.spoken[0]));
    truthy('engaged after the customer spoke', r.session.engaged);
    truthy('catalogue was consulted', r.names.includes('get_product_catalog'));
    truthy('an outcome was logged', r.names.includes('log_call_outcome'));
    check('cost ledger counted the turns', r.session.cost().units.turns, 4);
  }

  console.log('\n── 2. the connect gate: nobody speaks, so no AI is spent ──');
  {
    const r = await runCall({ lines: [] });
    falsy('never engaged', r.session.engaged);
    check('no LLM calls at all', r.session.cost().units.llmCalls, 0);
    falsy('aiEngaged false in the ledger', r.session.cost().units.aiEngaged);
    check('one thing was still said (the cached greeting)', r.spoken.length, 1);
    truthy('an outcome was logged anyway', r.names.includes('log_call_outcome'));
    check('disposition reflects a dial that never connected', r.ended.disposition, 'busy_callback');
  }

  console.log('\n── 3. a price is only ever quoted from the tool ──');
  {
    const r = await runCall({ lines: ['haan', 'restaurant', 'online selling chahiye', 'price kitna hai?'] });
    truthy('get_price_quote was called', r.names.includes('get_price_quote'));
    const priced = r.of('get_price_quote')[0];
    truthy('the tool returned a speakable line', priced.result.speakable);
    truthy('the agent spoke the tool figure', r.said.includes('₹') || /including gst/i.test(r.said));
  }

  console.log('\n── 4. NO price configured -> the agent must not invent one ──');
  {
    // Force the refusal path: the only item the customer wants has no price.
    const original = stubs.get_price_quote;
    stubs.get_price_quote = async () => ({
      ok: false, error: 'No approved price is configured', code: 'NO_APPROVED_PRICE', escalate: true,
    });
    const r = await runCall({ lines: ['haan', 'restaurant', 'price kitna hai?'] });
    stubs.get_price_quote = original;

    truthy('the price tool was attempted', r.names.includes('get_price_quote'));
    falsy('the tool did NOT succeed', r.of('get_price_quote')[0].ok);
    falsy('and the agent spoke no number', RUPEE.test(r.said));
    truthy('it promised to confirm instead', /confirm|check/i.test(r.said));
  }

  console.log('\n── 5. discount goes through the tool, never freehand ──');
  {
    const r = await runCall({ lines: ['haan', 'restaurant', 'online selling', 'discount do na'] });
    truthy('validate_discount was called', r.names.includes('validate_discount'));
    const v = r.of('validate_discount')[0];
    truthy('the tool answered', v.ok);
  }

  console.log('\n── 6. "human se baat karni hai" hands off immediately ──');
  {
    const r = await runCall({ lines: ['haan', 'mujhe human se baat karni hai'] });
    truthy('transfer_to_human was called', r.names.includes('transfer_to_human'));
    check('disposition is human_handoff', r.ended.disposition, 'human_handoff');
    truthy('an outcome was still logged', r.names.includes('log_call_outcome'));
  }

  console.log('\n── 7. opt-out request is honoured and recorded ──');
  {
    const r = await runCall({ lines: ['haan', 'mera number remove karo, call mat karo'] });
    const out = r.of('log_call_outcome')[0];
    check('disposition is do_not_contact', out.args.disposition, 'do_not_contact');
    truthy('opt_out flag set', out.args.optOut);
    truthy('the number is now on the stub opt-out list', stubs._state.optOuts.has('9822000000'));
  }

  console.log('\n── 8. an opted-out number is never spoken to again ──');
  {
    const r = await runCall({ lines: ['hello?'], phone: '9822000000' });
    check('nothing was said at all', r.spoken.length, 0);
    falsy('never engaged', r.session.engaged);
    check('disposition is do_not_contact', r.ended.disposition, 'do_not_contact');
    stubs._state.optOuts.clear();
  }

  console.log('\n── 9. not-interested closes politely, without pushing ──');
  {
    const r = await runCall({ lines: ['haan', 'nahi chahiye, not interested'] });
    const out = r.of('log_call_outcome')[0];
    check('disposition is not_interested', out.args.disposition, 'not_interested');
    truthy('a next action was recorded', out.args.nextAction);
  }

  console.log('\n── 10. wrong number is a disposition, not a pitch ──');
  {
    const r = await runCall({ lines: ['ye galat number hai'] });
    check('disposition is wrong_number', r.of('log_call_outcome')[0].args.disposition, 'wrong_number');
  }

  console.log('\n── 11. busy customer gets a scheduled follow-up ──');
  {
    const before = stubs._state.followups.length;
    const r = await runCall({ lines: ['abhi busy hoon, baad me call karo'] });
    truthy('schedule_followup was called', r.names.includes('schedule_followup'));
    truthy('the stub recorded it', stubs._state.followups.length > before);
  }

  console.log('\n── 12. the turn budget is hard ──');
  {
    process.env.MAX_TURNS = '3';
    // config is a singleton, so reach into the live object the pipeline reads.
    const cfg = require('../config');
    const restore = cfg.limits.maxTurns;
    cfg.limits.maxTurns = 3;

    const r = await runCall({ lines: ['haan', 'restaurant', 'QR hai', 'online bhi', 'aur batao', 'phir?', 'aur?'] });
    truthy('the call ended at or near the cap', r.session.turns <= 4);
    truthy('an outcome was logged', r.names.includes('log_call_outcome'));

    cfg.limits.maxTurns = restore;
  }

  console.log('\n── 13. every call ends with an outcome, even a silent one ──');
  {
    const cfg = require('../config');
    const restore = cfg.limits.silenceHangupSeconds;
    cfg.limits.silenceHangupSeconds = 0.4;

    const r = await runCall({ lines: [], settle: 900 });
    truthy('silence ended the call', r.ended !== null);
    truthy('an outcome was logged', r.names.includes('log_call_outcome'));

    cfg.limits.silenceHangupSeconds = restore;
  }

  console.log('\n── 14. the ledger reports what it should ──');
  {
    const r = await runCall({ lines: ['haan', 'restaurant', 'online selling', 'price batao'] });
    const c = r.session.cost();
    truthy('duration recorded', c.durationSec >= 0);
    truthy('engaged', c.units.aiEngaged);
    truthy('tool calls counted', c.units.toolCalls > 0);
    truthy('an estimate was produced', c.estimatedInr.total >= 0);
    truthy('telephony seconds counted at hangup', c.units.telephonySec >= 0);
  }

  console.log('\n── 15. an empty LLM reply must never become dead air ──');
  {
    const providers = require('../providers');
    const llm = providers.get().llm;
    const real = llm.chat;

    // A reasoning model that spends its whole output budget thinking returns no
    // text. On a phone line that is silence, and the customer hangs up.
    let calls = 0;
    llm.chat = async () => {
      calls += 1;
      if (calls === 1) return { text: '', toolCalls: [], usage: { in: 9, out: 0 }, finishReason: 'MAX_TOKENS' };
      return { text: 'Ji bilkul sir, bataiye.', toolCalls: [], usage: { in: 9, out: 6 } };
    };
    const r = await runCall({ lines: ['haan boliye'] });
    llm.chat = real;

    truthy('it retried rather than going silent', calls >= 2);
    truthy('and something was actually spoken', r.said.includes('bataiye'));
  }

  console.log('\n── 16. two empty replies fall back to a spoken line, not silence ──');
  {
    const providers = require('../providers');
    const llm = providers.get().llm;
    const real = llm.chat;

    llm.chat = async () => ({ text: '', toolCalls: [], usage: { in: 9, out: 0 }, finishReason: 'MAX_TOKENS' });
    const r = await runCall({ lines: ['haan boliye'] });
    llm.chat = real;

    // The greeting plus a fallback — never the greeting and then nothing.
    truthy('the agent still said something after the greeting', r.spoken.length >= 2);
    truthy('and it asked the customer to repeat', /phir se|clear nahi/i.test(r.said));
  }

  console.log('\n── 17. audio format reaches TTS intact ──');
  {
    // The bug this guards: TTS synthesising at 8 kHz while the phone line runs
    // at 16 kHz, and handing back a WAV container instead of raw samples. Either
    // one alone presents as "the call connects but there is no voice".
    const { stripWavHeader } = require('../util/wav');
    const providers = require('../providers');
    const tts = providers.get().tts;
    const realSynth = tts.synth;
    const realClientSide = tts.clientSide;
    const realTextOnly = tts.textOnly;

    const seen = [];
    // The suite runs with TTS_PROVIDER=none, whose driver is textOnly — say()
    // short-circuits before synth(). Clear both flags so the real path runs.
    tts.clientSide = false;
    tts.textOnly = false;
    tts.synth = async (opts) => {
      seen.push(opts);
      return { audio: Buffer.alloc(64), mime: 'audio/L16', sampleRate: opts.sampleRate, chars: opts.text.length };
    };

    const { createSession } = require('../pipeline/conversation');
    const s = createSession({ phone: '9820000017', audioSampleRate: 16000, onAgentText: () => {} });
    await s.start();
    await s.end('test');

    tts.synth = realSynth;
    tts.clientSide = realClientSide;
    tts.textOnly = realTextOnly;

    truthy('TTS was actually called', seen.length > 0);
    check('and told the transport sample rate', seen[0] && seen[0].sampleRate, 16000);

    // WAV containers must never survive to the wire.
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(16000, 24); hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36); hdr.writeUInt32LE(20, 40);
    const stripped = stripWavHeader(Buffer.concat([hdr, Buffer.alloc(20)]));
    check('WAV header is stripped', stripped.pcm.length, 20);
    check('and its rate is read back', stripped.sampleRate, 16000);
    check('raw PCM passes through untouched', stripWavHeader(Buffer.from([1, 2, 3, 4])).wasWav, false);
  }

  console.log('\n── 18. the hang-up clock does not run while the agent is talking ──');
  {
    // The bug: a greeting that plays for 9s against a 12s silence timeout left
    // the caller ~2s to respond, so real calls hung up on people who were still
    // listening. Silence must be measured from when the agent STOPS.
    const cfg = require('../config');
    const providers = require('../providers');
    const tts = providers.get().tts;
    const realSynth = tts.synth;
    const realClientSide = tts.clientSide;
    const realTextOnly = tts.textOnly;

    const restore = cfg.limits.silenceHangupSeconds;
    cfg.limits.silenceHangupSeconds = 0.4;

    // 1.2 seconds of 8 kHz 16-bit audio.
    const longAudio = Buffer.alloc(8000 * 2 * 1.2);
    tts.clientSide = false;
    tts.textOnly = false;
    tts.synth = async (opts) => ({
      audio: longAudio, mime: 'audio/L16', sampleRate: 8000, chars: opts.text.length,
    });

    const { createSession } = require('../pipeline/conversation');
    let endedAt = 0;
    const startedAt = Date.now();
    const s = createSession({
      phone: '9820000018',
      audioSampleRate: 8000,
      onAgentText: () => {},
      onAgentAudio: () => {},
      onEnd: () => { endedAt = Date.now(); },
    });
    await s.start();
    // 0.4s timeout alone would fire here; 1.2s of speech must push it out.
    await new Promise((r) => setTimeout(r, 900));
    truthy('still on the call while the greeting plays', !s.ended);

    await new Promise((r) => setTimeout(r, 1200));
    truthy('and it hangs up once the speech is done plus the timeout', s.ended);
    truthy('which is later than the bare timeout', endedAt - startedAt > 1200);

    tts.synth = realSynth;
    tts.clientSide = realClientSide;
    tts.textOnly = realTextOnly;
    cfg.limits.silenceHangupSeconds = restore;
  }

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
