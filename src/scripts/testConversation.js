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
const tools = require('../tools');
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
    // And it puts the fault on the LINE, not on the caller. On a live call this
    // fallback was spoken to someone who had just said "haan theek hai, bhej
    // dijiye" — a model schema failure, which they had nothing to do with.
    truthy('and it blames the line, not the caller', /line thodi slow/i.test(r.said));
    falsy('it does not tell them they were unclear', /aapki baat.*clear nahi/i.test(r.said));
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

  console.log('\n── 19. VAD: real speech is heard on every line we have seen ──');
  {
    // Driven by levels MEASURED on real calls to this number, not invented ones.
    // The noise and speech ranges overlap across calls, which is precisely why a
    // single tuned threshold kept failing.
    const vadFactory = require('../pipeline/vad');
    const frame = (amp) => {
      const b = Buffer.alloc(640);
      for (let i = 0; i < 320; i += 1) b.writeInt16LE(Math.round(Math.sin(i / 4) * amp * 32767), i * 2);
      return b;
    };
    const PROFILES = [
      ['noisy line', 0.046, 0.27],
      ['noisy line 2', 0.041, 0.23],
      ['quiet line', 0.0026, 0.02],
      ['hissy line', 0.006, 0.21],
      ['loud line', 0.0524, 0.2694],
      ['very quiet speaker', 0.0005, 0.008],
    ];
    /** Noise for 6s, then speech with syllable gaps. */
    const run = (noise, speech) => {
      const v = vadFactory.create({ frameMs: 20 });
      let onset = null;
      let falseBarge = 0;
      for (let i = 0; i < 900; i += 1) {
        const talking = i >= 300 && (i - 300) % 8 < 5;
        const r = v.push(frame(talking ? speech : noise));
        if (r.onset && onset === null) onset = i * 20;
        if (r.bargeIn && !talking) falseBarge += 1;
      }
      return { onset, falseBarge };
    };

    for (const [label, noise, speech] of PROFILES) {
      const r = run(noise, speech);
      truthy(label + ': speech opens the gate', r.onset !== null);
      truthy(label + ': and promptly', r.onset !== null && r.onset - 6000 < 600);
      check(label + ': noise NEVER interrupts the agent', r.falseBarge, 0);
    }
  }

  console.log('\n── 20. VAD: a line nobody is talking on must never interrupt ──');
  {
    // THE bug that made a working agent appear mute: false barge-ins cancelled
    // every generated reply and cleared the provider's buffer, so the caller
    // heard only the cached greeting while the logs showed a healthy call.
    const vadFactory = require('../pipeline/vad');
    const frame = (amp) => {
      const b = Buffer.alloc(640);
      for (let i = 0; i < 320; i += 1) b.writeInt16LE(Math.round(Math.sin(i / 4) * amp * 32767), i * 2);
      return b;
    };
    const bargeInsOn = (level, ctx) => {
      const v = vadFactory.create({ frameMs: 20 });
      let n = 0;
      for (let i = 0; i < 900; i += 1) if (v.push(frame(level), ctx).bargeIn) n += 1;
      return n;
    };

    for (const noise of [0.0005, 0.0026, 0.006, 0.041, 0.046, 0.0524]) {
      check('noise at ' + noise + ' never interrupts', bargeInsOn(noise), 0);
    }
    check('digital silence never interrupts', bargeInsOn(0), 0);

    // Echo guard: the agent's own voice returning through the caller's handset
    // must not be mistaken for the caller trying to interrupt.
    for (const echo of [0.05, 0.08, 0.10, 0.12]) {
      check('echo at ' + echo + ' does not cut the agent off',
        bargeInsOn(echo, { agentSpeaking: true }), 0);
    }
    // ...but a customer genuinely talking over the agent still gets through.
    truthy('a real interruption is still honoured', bargeInsOn(0.27, { agentSpeaking: true }) > 0);
  }


  console.log('\n── 21. a transient vendor failure does not end the call ──');
  {
    // Gemini answered one turn with 503 "experiencing high demand" and the call
    // was abandoned. On a phone line a blip is a hiccup, not a failure — the
    // customer is mid-sentence and a retry is invisible to them.
    const { retryingFetch } = require('../util/http');
    const realFetch = global.fetch;

    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls < 3) return new Response('{"error":"overloaded"}', { status: 503 });
      return new Response('{"ok":true}', { status: 200 });
    };
    const res = await retryingFetch('https://example.test/x', {}, { label: 'test', attempts: 3, baseDelayMs: 5 });
    check('retried through the 503s', calls, 3);
    check('and succeeded', res.status, 200);

    // A 400 is our bug — a deprecated model, a bad speaker name. Retrying it
    // just wastes the caller's time three times over.
    calls = 0;
    global.fetch = async () => { calls += 1; return new Response('{"detail":"deprecated"}', { status: 400 }); };
    const bad = await retryingFetch('https://example.test/x', {}, { label: 'test', attempts: 3, baseDelayMs: 5 });
    check('a 400 is returned immediately', calls, 1);
    check('with its status intact', bad.status, 400);

    // Giving up must still hand back a readable body, not a thrown blank.
    calls = 0;
    global.fetch = async () => { calls += 1; return new Response('{"error":"still down"}', { status: 503 }); };
    const givenUp = await retryingFetch('https://example.test/x', {}, { label: 'test', attempts: 2, baseDelayMs: 5 });
    check('it stops after the configured attempts', calls, 2);
    check('and surfaces the real status', givenUp.status, 503);
    truthy('with the vendor body readable', (await givenUp.text()).includes('still down'));

    global.fetch = realFetch;
  }

  console.log('\n── 22. Gemini thought signatures survive a tool round trip ──');
  {
    // Gemini 3.x returns an opaque thoughtSignature with each functionCall and
    // requires it back when that call is replayed. Rebuilding the part by hand
    // drops it, so tool use worked for exactly ONE turn and the next call 400'd
    // with "Function call is missing a thought_signature".
    const gemini = require('../providers/llm/gemini');
    const realFetch = global.fetch;
    const sent = [];

    global.fetch = async (url, opts) => {
      sent.push(JSON.parse(opts.body));
      if (sent.length === 1) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'get_product_catalog', args: {} },
                thoughtSignature: 'SIG-ABC-123',
              }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Theek hai sir.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 },
      }), { status: 200 });
    };

    const driver = gemini.create({ llm: { geminiKey: 'k', model: 'gemini-3.8-flash', maxTokens: 100 } });
    const first = await driver.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });

    check('the signature is captured off the functionCall', first.toolCalls[0].thoughtSignature, 'SIG-ABC-123');
    truthy('and the raw parts are kept', first.raw && first.raw.parts.length === 1);

    // Replay the turn the way the conversation engine does.
    await driver.chat({
      system: 's',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls, raw: first.raw },
        { role: 'tool', name: 'get_product_catalog', content: { ok: true, items: [] } },
      ],
      tools: [],
    });

    const replayed = sent[1].contents.find((c) => c.role === 'model');
    truthy('the model turn was replayed', replayed);
    check('with the signature intact', replayed.parts[0].thoughtSignature, 'SIG-ABC-123');
    check('and the function call itself', replayed.parts[0].functionCall.name, 'get_product_catalog');

    // Without raw (other providers, older history) it must still reconstruct.
    sent.length = 0;
    global.fetch = async (url, opts) => {
      sent.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
    };
    await driver.chat({
      system: 's',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ name: 'x', args: {}, thoughtSignature: 'SIG-FALLBACK' }] },
      ],
      tools: [],
    });
    const rebuilt = sent[0].contents.find((c) => c.role === 'model');
    check('the fallback path also carries it', rebuilt.parts[0].thoughtSignature, 'SIG-FALLBACK');

    global.fetch = realFetch;
  }

  console.log('\n── 23. a slow vendor must not trip the hang-up clock ──');
  {
    // Gemini returned 503 and retried; the retry outlived the 12s silence
    // timeout and the call was dropped on a caller who was simply waiting.
    // Silence means the CUSTOMER is quiet, not that we are busy.
    const cfg = require('../config');
    const providers = require('../providers');
    const llm = providers.get().llm;
    const real = llm.chat;
    const restore = cfg.limits.silenceHangupSeconds;
    cfg.limits.silenceHangupSeconds = 0.3;

    llm.chat = async () => {
      await new Promise((r) => setTimeout(r, 900));   // slower than the timeout
      return { text: 'Ji sir, bataiye.', toolCalls: [], usage: { in: 5, out: 4 } };
    };

    const r = await runCall({ lines: ['haan boliye'] });
    llm.chat = real;
    cfg.limits.silenceHangupSeconds = restore;

    truthy('the slow reply still reached the caller', r.said.includes('bataiye'));
    falsy('and the call was not dropped mid-think', r.ended && r.ended.reason === 'silence');
  }

  console.log('\n── 24. a slow turn holds the line instead of going silent ──');
  {
    // Measured on real calls a turn runs 2.5-5s, most of it TTS. Silence that
    // long on a phone reads as a dropped call and people say "hello? hello?".
    const providers = require('../providers');
    const llm = providers.get().llm;
    const real = llm.chat;

    llm.chat = async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return { text: 'Ji sir, aapka business kis category mein hai?', toolCalls: [], usage: { in: 5, out: 8 } };
    };
    const slow = await runCall({ lines: ['haan boliye'] });
    llm.chat = real;

    truthy('a holding line was spoken while the turn ran', /ek second/i.test(slow.said));
    truthy('and the real answer still arrived', /kis category/i.test(slow.said));
    const order = slow.spoken.findIndex((t) => /ek second/i.test(t));
    const answer = slow.spoken.findIndex((t) => /kis category/i.test(t));
    truthy('in that order', order !== -1 && answer !== -1 && order < answer);

    // A fast turn must not get one — that would just sound padded.
    llm.chat = async () => ({ text: 'Ji bilkul sir.', toolCalls: [], usage: { in: 5, out: 4 } });
    const fast = await runCall({ lines: ['haan boliye'] });
    llm.chat = real;
    falsy('a fast turn is left alone', /ek second/i.test(fast.said));
  }

  console.log('\n── 25. the call\'s own number always wins over the model\'s ──');
  {
    // A model handed "unknown" to get_customer_context, the CRM rejected it with
    // "phone is required", and the agent lost the customer's history and
    // escalated. The number we are connected to is never in doubt.
    const stubs = require('../tools/localStubs');
const tools = require('../tools');
    const seen = [];
    const realCtx = stubs.get_customer_context;
    stubs.get_customer_context = async (args) => { seen.push(args.phone); return { ok: true, known: false }; };

    const dispatch = tools.createDispatcher({ callId: 'c', phone: '9876543210' });
    await dispatch('get_customer_context', { phone: 'unknown' });
    await dispatch('get_customer_context', { phone: '' });
    await dispatch('get_customer_context', {});
    stubs.get_customer_context = realCtx;

    check('a junk value is ignored', seen[0], '9876543210');
    check('an empty value is ignored', seen[1], '9876543210');
    check('a missing value is filled in', seen[2], '9876543210');
  }

  console.log('\n── 26. the agent speaks ONCE per turn, not once per tool round ──');
  {
    // On a real call the model emitted narration alongside every tool call.
    // Three rounds meant three narrations plus the answer: 14s of TTS and 34s
    // of the agent talking at a customer who asked one question.
    const providers = require('../providers');
    const llm = providers.get().llm;
    const real = llm.chat;

    let call = 0;
    llm.chat = async () => {
      call += 1;
      if (call === 1) {
        return {
          text: 'Ek minute sir, main aapke liye packages check karta hoon.',
          toolCalls: [{ id: 't1', name: 'get_product_catalog', args: {} }],
          usage: { in: 5, out: 12 },
        };
      }
      if (call === 2) {
        return {
          text: 'Ji main abhi price bhi dekh leta hoon.',
          toolCalls: [{ id: 't2', name: 'get_price_quote', args: { items: [{ code: 'PKG_KIT', qty: 1 }] } }],
          usage: { in: 5, out: 10 },
        };
      }
      return { text: 'Tapify Kit aapke liye sahi rahega.', toolCalls: [], usage: { in: 5, out: 8 } };
    };

    const r = await runCall({ lines: ['packages batao'] });
    llm.chat = real;

    truthy('the final answer was spoken', /sahi rahega/i.test(r.said));
    falsy('the first narration was NOT spoken', /packages check karta/i.test(r.said));
    falsy('nor the second', /price bhi dekh/i.test(r.said));
    // Greeting + at most a holding line + the one real answer.
    truthy('the agent did not monologue', r.spoken.length <= 3);
  }

  console.log('\n── 27. an over-long reply is trimmed, not spoken in full ──');
  {
    const providers = require('../providers');
    const llm = providers.get().llm;
    const real = llm.chat;

    const rambling = 'Sir dekhiye Tapify ke paas bahut saare options hain. '.repeat(12);
    llm.chat = async () => ({ text: rambling, toolCalls: [], usage: { in: 5, out: 300 } });
    const r = await runCall({ lines: ['batao'] });
    llm.chat = real;

    const spokenReply = r.spoken.find((t) => /bahut saare options/i.test(t));
    truthy('something was still said', spokenReply);
    truthy('but capped well below the model output', spokenReply && spokenReply.length <= 260);
    truthy('and cut at a sentence boundary', spokenReply && /[.!?]$/.test(spokenReply.trim()));
  }

  console.log('\n── 28. the feedback campaign is a different call, not the sales pitch ──');
  {
    const persona = require('../pipeline/persona');

    const salesTools = tools.definitionsFor('sales').map((d) => d.name);
    const fbTools = tools.definitionsFor('client_feedback').map((d) => d.name);

    // The customer already bought. Handing a feedback call the pricing tools is
    // handing it a way to start selling to someone who rang to complain.
    falsy('feedback call cannot quote a price', fbTools.includes('get_price_quote'));
    falsy('nor offer a discount', fbTools.includes('validate_discount'));
    // Their usage is not a TOOL any more. engage() fetches it once and builds it
    // into the system prompt, so offering it to the model only bought a second
    // LLM round and a CRM hop in front of the first reply — on a rate-limited
    // tier, enough tokens to end the call.
    falsy('their usage is not offered as a tool', fbTools.includes('get_client_status'));
    truthy('and log what they said', fbTools.includes('log_client_feedback'));
    truthy('and escalate a question', fbTools.includes('raise_client_query'));
    truthy('sales still has its pricing tools', salesTools.includes('get_price_quote'));
    falsy('and does not get the feedback tools', salesTools.includes('log_client_feedback'));

    const fbPrompt = persona.buildSystemPrompt({
      campaign: 'client_feedback',
      direction: 'outbound',
      client: {
        isClient: true, name: 'Ramesh', appInstalled: false, daysSinceLastUse: 34,
        owns: { cards: 1, websites: 1, publishedWebsites: 0 },
        highlights: ['42 people opened their card this month'],
        gaps: ['has not installed the Tapify app'],
        featuresUsed: ['vcard'],
      },
    });
    truthy('the prompt says they are an existing customer', /existing Tapify customer/i.test(fbPrompt));
    truthy('and states the app status as a fact', /app installed: NO/i.test(fbPrompt));
    truthy('and gives their real numbers', /42 people opened/i.test(fbPrompt));
    truthy('and forbids pitching', /NOT selling|not sell/i.test(fbPrompt));
    // The contradiction bug: the sales block used to run too and claim we do
    // not know who they are, right under their name.
    falsy('it does NOT also claim they are a new contact', /new contact — you do not know their name/i.test(fbPrompt));

    // A number that is not a customer must not be treated as one.
    const stranger = persona.buildSystemPrompt({ campaign: 'client_feedback', client: { isClient: false } });
    truthy('an unknown number is flagged as not a customer', /not matched to a Tapify customer/i.test(stranger));
  }

  console.log('\n── 29. a feedback call actually runs ──');
  {
    const providers = require('../providers');
    const llm = providers.get().llm;
    const real = llm.chat;

    let n = 0;
    llm.chat = async ({ tools: given }) => {
      n += 1;
      if (n === 1) {
        // The feedback tools must reach the model — proves they are wired, not
        // just listed. get_client_status must NOT: the engine fetched it before
        // this turn and it is already in the system prompt.
        truthy('the feedback tools reached the model',
          given.some((t) => t.name === 'log_client_feedback'));
        falsy('and the account lookup is not among them',
          given.some((t) => t.name === 'get_client_status'));
        return {
          text: 'App install karne se enquiries seedha aapke phone par aayengi.',
          toolCalls: [{ id: 'g2', name: 'log_client_feedback', args: { using_app: false, not_using_reason: 'time nahi mila' } }],
          usage: { in: 5, out: 9 },
        };
      }
      return { text: 'Theek hai sir, dhanyavaad.', toolCalls: [], usage: { in: 5, out: 5 } };
    };

    const spoken = [];
    const toolCalls = [];
    const { createSession } = require('../pipeline/conversation');
    const s = createSession({
      phone: '9820000029',
      campaign: 'client_feedback',
      direction: 'outbound',
      clientName: 'Ramesh',
      onAgentText: (t) => spoken.push(t),
      onEvent: (type, data) => { if (type === 'tool') toolCalls.push(data.name); },
    });
    await s.start();
    await s.customerSaid('haan boliye');
    await s.end('test');
    llm.chat = real;

    truthy('the greeting uses their name', /Ramesh/i.test(spoken[0] || ''));
    truthy('and says why we are calling', /feedback lena tha/i.test(spoken[0] || ''));
    truthy('and asks permission as a real question', /Kya aapse do minute baat ho sakti hai\?$/.test(spoken[0] || ''));
    // Fetched by the engine on the way in, not by the model on the way through.
    truthy('their status was fetched anyway', toolCalls.includes('get_client_status'));
    truthy('their feedback was recorded', toolCalls.includes('log_client_feedback'));
    truthy('an outcome was logged', toolCalls.includes('log_call_outcome'));
  }

  console.log('\n── 30. the dialer refuses to be dangerous ──');
  {
    const dialer = require('../telephony/dialer');

    check('91 is added to a 10-digit number', dialer.toDialFormat('9370339841'), '919370339841');
    check('a formatted number is normalised', dialer.toDialFormat('+91 93703 39841'), '919370339841');
    check('a leading zero is handled', dialer.toDialFormat('09370339841'), '919370339841');

    // Without credentials it must refuse, not throw or half-dial.
    const noCreds = await dialer.placeCall({ phone: '9370339841', publicUrl: 'https://x.test' });
    falsy('no credentials means no call', noCreds.ok);
    truthy('and it says why', /not configured/i.test(noCreds.reason));

    const badNumber = await dialer.placeCall({ phone: '123', publicUrl: 'https://x.test' });
    falsy('a short number is rejected', badNumber.ok);

    truthy('calling hours are bounded', dialer.CALL_START_HOUR >= 8 && dialer.CALL_END_HOUR <= 21);

    // The window is half-open: the END hour is already closed. A live dial at
    // 19:0x IST returned 409 and looked like a fault until someone read this.
    const at = (iso) => dialer.withinCallingHours(new Date(iso));
    falsy('an hour before the window is closed', at('2026-10-06T03:30:00Z'));   // 09:00 IST
    truthy('the start hour itself is open', at('2026-10-06T04:30:00Z'));        // 10:00 IST
    truthy('mid-afternoon is open', at('2026-10-06T10:00:00Z'));                // 15:30 IST
    falsy('the END hour is already closed', at('2026-10-06T13:30:00Z'));        // 19:00 IST
  }

  console.log('\n── 30b. a campaign never has more calls up than the TTS account allows ──');
  {
    // The campaign used to pace on the dial GAP alone, which is not a
    // concurrency limit — it only says how soon the next dial goes out. With a
    // 68s median call against a 20s gap that quietly ran three to five calls at
    // once. The TTS account allows FOUR concurrent requests and one speaking
    // call uses up to three, so that was over the line every time.
    const live = require('../telephony/liveCalls');
    const dialer = require('../telephony/dialer');

    check('the default is one call at a time', dialer.MAX_CONCURRENT_CALLS, 1);

    // Waits for the call to actually END, not for a timer to expire.
    live.opened();
    const t0 = Date.now();
    setTimeout(() => live.closed(), 300);
    const freed = await live.waitForSlot(1, { graceMs: 20, timeoutMs: 3000, pollMs: 20 });
    truthy('it waits for a live call to hang up', freed && Date.now() - t0 >= 280);

    // Nobody picked up, so no socket ever opened. The campaign must not stall
    // on a number that never rang through.
    const t1 = Date.now();
    truthy('an unanswered number does not stall the run',
      await live.waitForSlot(1, { graceMs: 20, timeoutMs: 3000, pollMs: 20 })
      && Date.now() - t1 < 250);

    // And a call that never closes must not freeze the campaign for ever.
    live.opened();
    const gaveUp = await live.waitForSlot(1, { graceMs: 10, timeoutMs: 120, pollMs: 20 });
    falsy('a stuck call times out rather than blocking for ever', gaveUp);
    live.closed();
    check('the counter does not drift', live.count(), 0);
  }

  console.log('\n── 31. an opted-out number is never dialled ──');
  {
    // The list used to be checked only after the customer picked up, so their
    // phone still rang and was then hung up on in silence. Checking it here also
    // takes the CRM round-trip out from between pickup and the first word.
    const dialer = require('../telephony/dialer');
    const config = require('../config');
    const stubs = require('../tools/localStubs');

    const saved = { ...config.plivo };
    Object.assign(config.plivo, { authId: 'MATEST', authToken: 'tok', fromNumber: '918888888888' });

    stubs._state.optOuts.add('9370339841');
    // force skips the calling-hours gate, so this passes at any hour.
    const blocked = await dialer.placeCall({ phone: '9370339841', publicUrl: 'https://x.test', force: true });
    falsy('the dial is refused before Plivo is ever called', blocked.ok);
    truthy('and it says the number opted out', /do-not-contact/i.test(blocked.reason || ''));
    // The CRM offers an admin "call anyway" prompt off the refusal CODE, so this
    // one must never be able to read as the forceable kind.
    check('with a code that is not the forceable one', blocked.code, 'do_not_contact');

    Object.assign(config.plivo, saved);
  }

  console.log('\n── 32. the greeting is not held up by a repeat opt-out check ──');
  {
    const stubs = require('../tools/localStubs');

    // Same opted-out number, but the dialer has already cleared it. The session
    // must trust that and speak, or the flag buys nothing.
    const spoken = [];
    const s = createSession({
      phone: '9370339841',
      direction: 'outbound',
      optOutChecked: true,
      onAgentText: (t) => spoken.push(t),
    });
    await s.start();
    truthy('the agent greets without re-checking', spoken.length > 0);
    await s.end('test');

    // And with no flag, the safety net is still there.
    const spoken2 = [];
    const s2 = createSession({
      phone: '9370339841',
      direction: 'outbound',
      onAgentText: (t) => spoken2.push(t),
    });
    await s2.start();
    check('without the flag an opted-out number is still not spoken to', spoken2.length, 0);

    // The flag is outbound-only: an inbound call was never dialled by us, so
    // nothing checked it and claiming otherwise would skip the list entirely.
    const spoken3 = [];
    const s3 = createSession({
      phone: '9370339841',
      direction: 'inbound',
      optOutChecked: true,
      onAgentText: (t) => spoken3.push(t),
    });
    await s3.start();
    check('and it cannot be used to skip the check on an inbound call', spoken3.length, 0);

    stubs._state.optOuts.delete('9370339841');
  }

  console.log('\n── 33. sentences are cut where a sentence ends ──');
  {
    const { splitAtSentence } = require('../pipeline/speechPipe');

    check('a finished sentence is taken',
      splitAtSentence('Haan sir. Aur')[0], 'Haan sir.');
    check('and the unfinished remainder is left behind',
      splitAtSentence('Haan sir. Aur')[1], ' Aur');
    check('the Hindi danda counts as an ending',
      splitAtSentence('Theek hai। Aage')[0], 'Theek hai।');
    // The one that would break a price read aloud: a decimal is not a sentence.
    check('a decimal is not a boundary',
      splitAtSentence('Price 1.5 lakh hai')[0], '');
    check('nothing complete yields nothing',
      splitAtSentence('Sir main aapko')[0], '');
    check('a question mark ends a sentence',
      splitAtSentence('Kaise hain? Main')[0], 'Kaise hain?');
  }

  console.log('\n── 34. the speech pipe overlaps synthesis with generation ──');
  {
    const speechPipe = require('../pipeline/speechPipe');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Chunk one is made DELIBERATELY the slowest, so anything that emitted in
    // completion order rather than queue order would show up here as scrambled
    // audio — which on a call is a reply whose sentences arrive back to front.
    const delays = { 1: 120, 2: 10, 3: 10 };
    let n = 0;
    const started = [];
    const pipe = speechPipe.create({
      maxChars: 1000,
      synth: async ({ text }) => {
        n += 1;
        const mine = n;
        started.push(mine);
        await sleep(delays[mine] || 10);
        return { audio: Buffer.alloc(16), mime: 'audio/L16', sampleRate: 8000, text };
      },
    });

    const reply = 'Pehla vaakya yahan poora ho gaya hai bilkul. '
      + 'Doosra vaakya bhi yahan poora ho gaya hai. '
      + 'Teesra vaakya bhi ab yahan par poora hua.';

    // Fed the way a stream feeds it: cumulative, a word at a time.
    let sofar = '';
    for (const w of reply.match(/\S+\s*/g)) { sofar += w; pipe.push(sofar); }

    check('every sentence was queued before the reply finished', started.length, 3);

    const out = [];
    const chunks = await pipe.release((c) => out.push(c.text), reply);
    check('all three chunks were emitted', out.length, 3);
    truthy('the first sentence went out first', out[0].startsWith('Pehla'));
    truthy('the second went out second', out[1].startsWith('Doosra'));
    truthy('the slowest-first ordering held', out[2].startsWith('Teesra'));
    check('release returns exactly what was played', chunks.length, out.length);
  }

  console.log('\n── 35. a tool round never speaks its narration ──');
  {
    const speechPipe = require('../pipeline/speechPipe');
    let synths = 0;
    const pipe = speechPipe.create({
      maxChars: 1000,
      synth: async ({ text }) => {
        synths += 1;
        return { audio: Buffer.alloc(16), mime: 'audio/L16', sampleRate: 8000, text };
      },
    });

    pipe.push('Ek minute sir, main aapke liye ye check karta hoon abhi. ');
    check('the narration was speculatively synthesised', synths, 1);

    // The vendor reveals mid-stream that this is a tool call after all.
    pipe.disarm('tool call');
    pipe.push('Aur ye doosra vaakya bhi yahan poora ho gaya hai. ');
    check('nothing more is synthesised once disarmed', synths, 1);

    const wasted = pipe.discard();
    truthy('the wasted characters are counted, not hidden', wasted > 0);

    const out = [];
    await pipe.release((c) => out.push(c.text), 'irrelevant');
    check('and a discarded round plays nothing at all', out.length, 0);
  }

  console.log('\n── 36. a barge-in stops the agent paying for speech ──');
  {
    const speechPipe = require('../pipeline/speechPipe');
    let stale = false;
    let synths = 0;
    const pipe = speechPipe.create({
      maxChars: 1000,
      isStale: () => stale,
      synth: async ({ text }) => {
        synths += 1;
        return { audio: Buffer.alloc(16), mime: 'audio/L16', sampleRate: 8000, text };
      },
    });

    pipe.push('Pehla vaakya yahan par poora ho gaya hai bilkul sahi. ');
    check('the first chunk was synthesised', synths, 1);

    // The customer interrupts. Work already paid for must not reach the wire.
    stale = true;
    const out = [];
    await pipe.release((c) => out.push(c.text), 'Pehla vaakya yahan par poora ho gaya hai bilkul sahi.');
    check('an interrupted turn plays nothing', out.length, 0);
  }

  console.log('\n── 37. a stalled LLM stream falls back instead of hanging ──');
  {
    // util/http.js clears its abort timer the moment response HEADERS arrive, so
    // a vendor that accepts the request and then goes quiet has no timeout of
    // its own. Without the reader's stall guard the caller would hear silence
    // until the call's duration budget killed it minutes later.
    const providers = require('../providers');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const real = providers.get;
    const base = real();

    let fellBack = false;
    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: true,
        async chatStream() { await sleep(50); throw new Error('LLM stream stalled for 15000ms'); },
        async chat(o) { fellBack = true; return base.llm.chat(o); },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const said = [];
    const s = fresh.createSession({
      callId: 'stall_test', phone: '9820000031', onAgentText: (t) => said.push(t),
    });
    await s.start();
    await s.customerSaid('haan boliye');
    await s.end('test');

    truthy('the stream failure fell back to a blocking call', fellBack);
    truthy('and the customer still got an answer', said.length > 1);

    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];
  }

  console.log('\n── 36b. a tool call written as text is never spoken ──');
  {
    // From a live call. The model typed the tool call into its REPLY instead of
    // calling it, the engine handed the whole thing to TTS, and Sarvam rejected
    // the JSON with "Input texts must contain at least one character from the
    // allowed languages" — so the customer got silence where the answer should
    // have been, and the turn logged NEVER SPOKE.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();

    const leak = 'धन्यवाद, सर! Aapko koi aur madad chahiye to bataiye. '
      + 'log_call_outcome({"disposition":"connected_interested","summary":"Customer is happy."';

    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat() { return { text: leak, toolCalls: [], usage: { in: 5, out: 40 } }; },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const said = [];
    const s = fresh.createSession({
      callId: 'leak_test', phone: '9820000081', campaign: 'client_feedback',
      onAgentText: (t) => said.push(t),
    });
    await s.start();
    await s.customerSaid('haan sab theek hai');
    await s.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];

    const spoken = said.join(' ');
    falsy('the tool name is not read out', /log_call_outcome/.test(spoken));
    falsy('nor its JSON', /disposition|\{"/.test(spoken));
    truthy('but the real sentence still reaches the customer', /madad chahiye/.test(spoken));
    // A stripped reply must not become an empty one — that is the dead air the
    // guard exists to prevent.
    truthy('and something was actually said', spoken.trim().length > 10);
  }

  console.log('\n── 36h. an optional tool parameter may be null ──');
  {
    // The single worst moment of a live call came from here. The model called
    // log_client_feedback with not_using_reason: null — correct, for a customer
    // who IS using the app — and Groq rejected the whole generation:
    //
    //   `/not_using_reason`: expected string, but got null
    //
    // Empty reply, retry, same 400, fallback line. The customer had just said
    // "haan theek hai, bhej dijiye" and was asked to repeat themselves.
    const tools = require('../tools');

    for (const campaign of ['client_feedback', 'sales']) {
      for (const def of tools.definitionsFor(campaign)) {
        const props = def.parameters.properties || {};
        const required = new Set(def.parameters.required || []);
        const offenders = Object.entries(props)
          .filter(([name, spec]) => !required.has(name) && typeof spec.type === 'string')
          .map(([name]) => name);
        check(campaign + '/' + def.name + ': every optional field accepts null',
          offenders, []);
      }
    }

    // Required fields stay strict — a missing phone or disposition is a real
    // error and must not be silently acceptable as null.
    const q = tools.definitionsFor('client_feedback').find((d) => d.name === 'raise_client_query');
    check('but a required field is still strictly typed', q.parameters.properties.question.type, 'string');
  }

  console.log('\n── 36g. the agent speaks as a woman, because the voice is one ──');
  {
    // Hindi marks the speaker's gender on the verb. The configured voice is
    // female (TTS_VOICE=siya), so "bol raha hoon" is a man's sentence read in a
    // woman's voice — instantly audible, and it was live for several calls.
    //
    // The prompt EXAMPLES matter as much as the fixed lines: the model copies
    // their gender into everything it improvises.
    const persona = require('../pipeline/persona');
    const MASCULINE = /(raha hoon|deta hoon|karta hoon|sakta hoon|chahta hoon|batata hoon|samajh gaya|chahunga|karunga|dunga|bataunga|ka AI assistant)/i;

    const lines = {
      greeting: persona.greetingText({ campaign: 'client_feedback', name: 'Xyz' }),
      'sales inbound': persona.greetingText({ direction: 'inbound' }),
      'sales outbound': persona.greetingText({ direction: 'outbound' }),
      thinking: persona.thinkingText(),
      busy: persona.busyLineText(),
      closing: persona.closingText(),
      handoff: persona.handoffText(),
      noPrice: persona.priceUnavailableText(),
    };
    for (const [name, line] of Object.entries(lines)) {
      falsy('the ' + name + ' line is in the feminine', MASCULINE.test(line));
    }

    const prompt = persona.buildSystemPrompt({
      direction: 'outbound',
      campaign: 'client_feedback',
      client: { isClient: true, name: 'X', appInstalled: false },
    });
    // ...excluding the rule itself, which has to QUOTE the masculine forms in
    // order to forbid them.
    // The gender RULE has to quote the masculine forms in order to forbid them,
    // so both its heading and the line of examples under it are excluded.
    const body = prompt.split('\n')
      .filter((l) => !/YOU ARE A WOMAN|Hindi marks the speaker/.test(l))
      .join('\n');
    falsy('and so is every example in the prompt', MASCULINE.test(body));
    truthy('which the prompt also states outright', /YOU ARE A WOMAN/.test(prompt));
  }

  console.log('\n── 36f. the feedback call follows the agreed script ──');
  {
    const persona = require('../pipeline/persona');
    const tools = require('../tools');
    const prompt = persona.buildSystemPrompt({
      direction: 'outbound',
      campaign: 'client_feedback',
      client: { isClient: true, name: 'X', appInstalled: false, health: 'quiet' },
    });

    // The ONE thing this call is supposed to produce besides a record: a
    // customer who agreed to be sent the details.
    truthy('it offers to send details on WhatsApp', /WhatsApp par link/i.test(prompt));
    truthy('and asks for feedback once, in the agreed wording', /zaroor batayiyega/i.test(prompt));

    // Payment integration is new and is the reason this script was rewritten.
    truthy('payment integration is among the features it may raise',
      /PAYMENT INTEGRATION/i.test(prompt));
    truthy('but it is told to mention only ONE', /ONE, NEVER A LIST/i.test(prompt));

    // The script must NOT ask what the record already answers — the whole point
    // of giving the agent the account.
    truthy('it is forbidden from asking whether the app is installed',
      /DO NOT ASK WHAT IT ALREADY SAYS/i.test(prompt));

    // "Don't repeatedly say sir."
    truthy('it is told not to end every sentence with sir',
      /do not end every sentence with "sir"/i.test(prompt));

    // The two new fields have to exist on the tool, or the agent has nowhere to
    // put the answers and the call produces nothing actionable.
    const fb = tools.definitionsFor('client_feedback').find((d) => d.name === 'log_client_feedback');
    truthy('the tool can record a WhatsApp opt-in', Boolean(fb.parameters.properties.wants_whatsapp_info));
    truthy('and the feature they asked for', Boolean(fb.parameters.properties.feature_request));
    // It is a write, so it must not make the caller wait for the CRM.
    falsy('and recording it does not block the reply', tools.isBlocking('log_client_feedback'));
  }

  console.log('\n── 36e. a reply that is ONLY a tool call still gets answered ──');
  {
    // A live call, turn 2. The model wrote log_call_outcome({...}) and nothing
    // else. Stripping it correctly left an empty string — and the engine then
    // recorded a blank agent line, synthesised "", and finished the turn having
    // said only the holding line. The caller heard "Ek second sir." and then
    // twelve seconds of silence, and the call died there.
    //
    // Two faults: an all-machinery reply was treated as a reply, and the
    // holding line counted as proof the caller had been answered.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();

    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat() {
          return {
            text: 'log_call_outcome({"disposition":"connected_interested","summary":"Customer is happy."',
            toolCalls: [],
            usage: { in: 5, out: 30 },
          };
        },
      },
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          // Sarvam's real behaviour: empty input is not audio.
          if (!String(text || '').trim()) throw new Error('Sarvam TTS 400: empty input');
          return { audio: Buffer.alloc(640), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const said = [];
    const events = [];
    const s = fresh.createSession({
      callId: 'allmachinery_test', phone: '9820000111', campaign: 'client_feedback',
      audioSampleRate: 8000,
      onAgentText: (t) => said.push(t),
      onAgentAudio: () => {},
      onEvent: (type) => events.push(type),
    });
    await s.start();
    await s.customerSaid('achha lag raha hai');
    await s.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];

    const spoken = said.join(' | ');
    falsy('the tool call is not read out', /log_call_outcome/.test(spoken));
    falsy('and no blank line is recorded as a reply',
      s.transcript().some((t) => t.role === 'agent' && !t.text.trim()));
    truthy('the empty reply is caught, not passed off as spoken',
      events.includes('silent_turn'));
    truthy('and the caller is actually said something to',
      /line thodi slow|samajh|sorry|boliye/i.test(spoken));
  }

  console.log('\n── 36c-ii. the other tool-call shape, markdown, and a repeat with a reply between ──');
  {
    // All three faults came from one live campaign call. The customer heard
    // "(send_whatsapp_details){note: ..." read out, because the stripper only
    // knew `name({...` and the model wrote `(name){...}`; heard "**AI Growth
    // Center**" complete with asterisks; and was asked the same feedback
    // question twice, because repeat-suppression compared only the PREVIOUS
    // transcript row and their own answer sat between the two copies.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();

    const replies = [
      'Theek hai sir. (send_whatsapp_details){note: "AI Growth Center guide"}',
      'Hamara **AI Growth Center** aapke liye useful rahega.',
      'Agar aapke paas Tapify ko lekar koi feedback ya suggestion ho, toh please humein zaroor batayiyega.',
      // The same line once more, one en-dash and one stop apart: a byte
      // comparison misses it even when the two rows ARE adjacent.
      'Agar aapke paas Tapify ko lekar koi feedback ya suggestion ho \u2013 toh please humein zaroor batayiyega!',
    ];

    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat() {
          return { text: replies.shift() || 'Ji sir.', toolCalls: [], usage: { in: 5, out: 20 } };
        },
      },
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          if (!String(text || '').trim()) throw new Error('empty input');
          return { audio: Buffer.alloc(640), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const said = [];
    const s = fresh.createSession({
      callId: 'repeat_test', phone: '9820000222', campaign: 'client_feedback',
      audioSampleRate: 8000,
      onAgentText: (t) => said.push(t),
      onAgentAudio: () => {},
    });
    await s.start();
    await s.customerSaid('haan bhejo');
    await s.customerSaid('kya hai wo');
    await s.customerSaid('theek hai');
    await s.customerSaid('social media');
    await s.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];

    const spoken = said.join(' | ');
    falsy('(tool_name){...} is not read out', /send_whatsapp_details/.test(spoken));
    truthy('but the sentence in front of it still is', /Theek hai sir/.test(spoken));
    falsy('markdown emphasis does not reach the synthesiser', spoken.includes('**'));
    truthy('and the words inside it survive', /AI Growth Center/.test(spoken));
    check('the feedback line is spoken once, not once per wording',
      said.filter((t) => /zaroor batayiyega/i.test(t)).length, 1);
    falsy('and suppressing it does not summon the holding line instead',
      /line thodi slow/i.test(spoken));
  }

  console.log('\n── 36c-iii. a reasoning model thinking out loud is never spoken ──');
  {
    // Qwen3 and friends are HYBRID reasoning models. Asked for no thinking they
    // comply; ignored or misconfigured, the monologue lands in the content and
    // goes straight to the synthesiser. The UNCLOSED case is the dangerous one:
    // a reply that hits the token budget mid-thought never emits the closing
    // tag, so everything after it is internal monologue.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();
    const replies = [
      '<think>She asked about the app. Lead with the record.</think>Ji sir, boliye.',
      'Theek hai sir. <think>Now I should ask about the feature and then wrap',
    ];
    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat() {
          return { text: replies.shift() || 'Ji sir.', toolCalls: [], usage: { in: 5, out: 20 } };
        },
      },
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          if (!String(text || '').trim()) throw new Error('empty input');
          return { audio: Buffer.alloc(640), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const said = [];
    const s2 = fresh.createSession({
      callId: 'think_test', phone: '9820000333', campaign: 'client_feedback',
      audioSampleRate: 8000,
      onAgentText: (t) => said.push(t),
      onAgentAudio: () => {},
    });
    await s2.start();
    await s2.customerSaid('haan boliye');
    await s2.customerSaid('theek hai');
    await s2.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];

    const spoken = said.join(' | ');
    falsy('no think tag reaches the synthesiser', /<think>/i.test(spoken));
    falsy('and neither does what was inside it', /Lead with the record/i.test(spoken));
    truthy('the real answer survives', /Ji sir, boliye/.test(spoken));
    falsy('an unclosed think block takes the rest with it',
      /Now I should ask about the feature/i.test(spoken));
    truthy('but what came before it is still said', /Theek hai sir/.test(spoken));
  }

  console.log('\n── 36c-iv. the call does not hang up on a customer mid-question ──');
  {
    // A live call ended on "to main app kahan se download karun?" — a client
    // who had never installed the app asking exactly how to, cut off and logged
    // as connected_needs_info. The persona forbids it; this is the part that
    // cannot be ignored.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();

    // The model tries to close on EVERY turn. The first attempt lands on a
    // question and must be refused; the second lands on "theek hai" and must go
    // through, or a call could never end.
    let round = 0;
    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat() {
          round += 1;
          return {
            text: round === 1 ? '' : 'Theek hai sir.',
            toolCalls: [{
              id: 'tc' + round,
              name: 'log_call_outcome',
              args: { disposition: 'connected_interested', summary: 'done' },
            }],
            usage: { in: 5, out: 20 },
          };
        },
      },
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          if (!String(text || '').trim()) throw new Error('empty input');
          return { audio: Buffer.alloc(640), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const ended = [];
    const s3 = fresh.createSession({
      callId: 'noclose_test', phone: '9820000444', campaign: 'client_feedback',
      audioSampleRate: 8000,
      onAgentText: () => {},
      onAgentAudio: () => {},
      hangup: () => ended.push('hangup'),
    });
    await s3.start();

    await s3.customerSaid('to main app kahan se download karun?');
    check('a question does not end the call', ended.length, 0);

    await s3.customerSaid('achha theek hai');
    truthy('but the call can still end once they are done', ended.length > 0);

    await s3.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];
  }

  console.log('\n── 36c-v. a dropped transcript asks the caller to repeat, not nothing ──');
  {
    // A live call dropped two REAL sentences on confidence ("Ok." at 0.44, a
    // whole Hindi sentence at 0.56), said nothing either time, and the customer
    // put "Hello" into the gap before the call died on the silence timer.
    // Silence is not an acceptable answer to someone who just spoke.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();
    const spoken = [];
    providers.get = () => ({
      ...base,
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          if (!String(text || '').trim()) throw new Error('empty input');
          return { audio: Buffer.alloc(640), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const s4 = fresh.createSession({
      callId: 'repeat_ask', phone: '9820000555', campaign: 'client_feedback',
      audioSampleRate: 8000,
      onAgentText: (t) => spoken.push(t),
      onAgentAudio: () => {},
    });
    await s4.start();
    spoken.length = 0;

    await s4.didNotCatch();
    truthy('the caller is asked to say it again', /phir boliye/i.test(spoken.join(' ')));
    truthy('and it is in the transcript, because they heard it',
      s4.transcript().some((t) => t.role === 'agent' && /phir boliye/i.test(t.text)));

    // Shares the holding line's budget: a genuinely bad line must not turn into
    // the agent saying this over and over.
    await s4.didNotCatch();
    const before = spoken.length;
    await s4.didNotCatch();
    check('past the apology cap it goes quiet instead', spoken.length, before);

    await s4.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];
  }

  console.log('\n── 36c-vi. every fixed line the engine can speak is pre-cached ──');
  {
    // When Rumik's prepaid balance ran out mid-call, every PRE-WARMED line kept
    // playing from cache and the one uncached line — the wrap-up, which lived as
    // a literal inside the engine rather than in persona — got a 402. The call
    // ended in silence on the exact sentence the customer was waiting for.
    //
    // So: anything the ENGINE can decide to say, as opposed to anything the
    // model writes, has to come from persona and has to be in the warm list.
    const persona = require('../pipeline/persona');
    const engineLines = [
      'thinkingText', 'busyLineText', 'didNotCatchText',
      'closingText', 'wrapUpText', 'handoffText', 'priceUnavailableText',
    ];
    const warmed = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'transport', 'web.js'), 'utf8');

    for (const name of engineLines) {
      truthy(name + ' is a persona line, not a literal in the engine',
        typeof persona[name] === 'function' && persona[name]().length > 0);
      truthy(name + ' is pre-warmed, so it survives a dead TTS balance',
        warmed.includes('persona.' + name + '()'));
    }
  }

  console.log('\n── 36c-vii. the answers block covers what customers actually ask ──');
  {
    // Built from 60 real calls, where 80% ended "needs info". These are the
    // themes by volume — if one silently falls out of the persona, the agent
    // goes back to escalating a question it could have answered.
    const persona = require('../pipeline/persona');
    const fb = persona.buildSystemPrompt({
      direction: 'outbound', campaign: 'client_feedback',
      client: { isClient: true, name: 'X' },
    });

    const asked = {
      'app download (47 mentions, the top theme)': /download karun|Play Store/i,
      'what is new (20)': /Naya kya aaya hai/i,
      'how to add products (14)': /Products kaise add/i,
      'their own numbers (13)': /Kitne logon ne dekha/i,
      'login trouble': /sign in nahi mila|Login nahi ho raha/i,
      'when will the callback come': /Senior kab call karenge/i,
      'send someone to my office': /office bhej dijiye/i,
      'I already have a website': /Pehle se website hai/i,
    };
    for (const [label, rx] of Object.entries(asked)) {
      truthy('the agent has an answer for: ' + label, rx.test(fb));
    }

    // The one that was escalated to a human thirteen times instead of answered.
    truthy('and it is told the view count is already in its own prompt',
      /THE NUMBER IS ALREADY IN/i.test(fb));

    // An office visit is DEMAND, not a complaint: agree, then capture the time
    // so somebody can actually go. Thirteen callers asked and all it did was
    // file a note saying the team would be in touch.
    truthy('an office visit is agreed to, not deflected',
      /bhej\s*deti hoon/i.test(fb) && /SAY YES/.test(fb));
    truthy('and the agent asks what time to send them',
      /Kis time pe bhejna hai/i.test(fb));
    truthy('the time they give is recorded, in their own words',
      /schedule_followup with "when" in THEIR OWN WORDS/i.test(fb));
    truthy('but it never invents a date or names the person',
      /Never invent a date, never name the person/i.test(fb));
    // She is a woman all call; "bhej deta hoon" here would break it in the one
    // sentence the customer is most likely to repeat back.
    falsy('and she does not slip into the male form', /bhej\s*deta h/i.test(fb));

    // Reference material must not leak into the cold-outreach persona.
    const sales = persona.buildSystemPrompt({ direction: 'outbound', campaign: 'sales' });
    falsy('none of it leaks into the sales persona', /Products kaise add/i.test(sales));
  }

  console.log('\n── 36c-viii. being talked over is recorded as being talked over ──');
  {
    // Stopping is only half of it. The reply is RECORDED before it is spoken, so
    // a caller who cuts the agent off after two words still leaves a history
    // saying the whole sentence was delivered — and the agent then answers them
    // as though everything before the interruption had landed.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();
    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat() {
          return {
            text: 'Dekh rahi hoon app abhi install nahi hua, koi reason tha?',
            toolCalls: [], usage: { in: 5, out: 20 },
          };
        },
      },
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          // Long enough that the session still believes it is speaking.
          return { audio: Buffer.alloc(sampleRate * 2 * 3), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const s5 = fresh.createSession({
      callId: 'cutoff_test', phone: '9820000666', campaign: 'client_feedback',
      audioSampleRate: 8000,
      onAgentText: () => {},
      onAgentAudio: () => {},
    });
    await s5.start();
    await s5.customerSaid('haan boliye');

    // The caller talks over it.
    s5.interrupt();

    const agentLines = s5.transcript().filter((t) => t.role === 'agent');
    const last = agentLines[agentLines.length - 1];
    truthy('the transcript says where it was cut off', /cut off here/i.test(last.text));

    // Twice must not stack two notes onto one line.
    s5.interrupt();
    const again = s5.transcript().filter((t) => t.role === 'agent').pop();
    check('and says it once, not once per barge-in',
      (again.text.match(/cut off here/gi) || []).length, 1);

    await s5.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];

    // And the persona has to say what to DO about it.
    const persona = require('../pipeline/persona');
    const prompt = persona.buildSystemPrompt({
      direction: 'outbound', campaign: 'client_feedback', client: { isClient: true, name: 'X' },
    });
    truthy('the agent is told to answer them, not finish its own sentence',
      /IF YOU WERE CUT OFF/.test(prompt) && /Answer WHAT THEY SAID/.test(prompt));
  }

  console.log('\n── 36d. the goodbye does not wait for the CRM write ──');
  {
    // Production turn 2: "reply in 6735ms [... tools 1259ms, tts→1st 2722ms]".
    // Both were avoidable. log_call_outcome is a WRITE and the goodbye depends
    // on nothing it returns, yet the caller sat through the round-trip; and the
    // goodbye was the one fixed line in the whole service nobody had cached.
    const providers = require('../providers');
    const persona = require('../pipeline/persona');
    const tools = require('../tools');
    const real = providers.get;
    const base = real();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let spokeAt = null;
    let toolDoneAt = null;
    const t0 = Date.now();

    const realDispatcher = tools.createDispatcher;
    tools.createDispatcher = () => async (name) => {
      if (name === 'log_call_outcome') {
        await sleep(400);                 // a slow CRM, as measured
        toolDoneAt = Date.now() - t0;
      }
      return { ok: true };
    };

    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat() {
          return {
            text: '',
            toolCalls: [{ id: 'o1', name: 'log_call_outcome', args: { disposition: 'connected_interested', summary: 's', next_action: 'n' } }],
            usage: { in: 5, out: 5 },
          };
        },
      },
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          if (spokeAt === null) spokeAt = Date.now() - t0;
          return { audio: Buffer.alloc(320), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const said = [];
    const s = fresh.createSession({
      callId: 'signoff_test', phone: '9820000101', campaign: 'client_feedback',
      audioSampleRate: 8000,
      onAgentText: (t) => said.push(t),
      onAgentAudio: () => {},
    });
    await s.start();
    await s.customerSaid('nahi, koi dikkat nahi hai');
    await s.end('test');

    providers.get = real;
    tools.createDispatcher = realDispatcher;
    delete require.cache[require.resolve('../pipeline/conversation')];

    truthy('the goodbye was spoken', said.some((t) => /dhanyavaad/i.test(t)));
    truthy('the CRM write did happen', toolDoneAt !== null);
    truthy('and the caller heard the goodbye BEFORE it finished', spokeAt < toolDoneAt);

    // It must also be a line the warm-up can pre-render, or it costs a live
    // synthesis on every single call that ends properly.
    check('the goodbye is a fixed line the warm-up can cache',
      persona.closingText(), persona.closingText());
    truthy('and it is exported for the boot warm-up',
      typeof persona.closingText === 'function');
  }

  console.log('\n── 36c. a turn never ends in silence, even when TTS refuses ──');
  {
    // Production turn 3: "reply in NEVER SPOKE, chunks=0". The model answered,
    // Sarvam rejected the text, and the caller got nothing — with no sign
    // anything had gone wrong. Silence is the one outcome a phone call cannot
    // recover from, because the caller assumes the line dropped.
    //
    // Driven with the real utterances from that call.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();

    let refusals = 0;
    providers.get = () => ({
      ...base,
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          // Sarvam's actual 400 on text it will not read.
          if (!/line thodi slow/.test(text)) {
            refusals += 1;
            throw new Error('Sarvam TTS 400: Input texts must contain at least '
              + 'one character from the allowed languages.');
          }
          return { audio: Buffer.alloc(640), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const audio = [];
    const events = [];
    const s = fresh.createSession({
      callId: 'silent_test',
      phone: '9820000091',
      campaign: 'client_feedback',
      audioSampleRate: 8000,
      onAgentAudio: (buf) => audio.push(buf.length),
      onEvent: (type) => events.push(type),
    });
    await s.start();

    const REAL_TURNS = [
      'हाँ, ठीक चल रहा है।',
      'Google Business connect नहीं हो रहा है मेरा।',
      'हाँ, चाहिए।',
      'थैंक यू।',
    ];
    const before = audio.length;
    for (const line of REAL_TURNS) await s.customerSaid(line);
    await s.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];

    truthy('TTS did refuse the replies', refusals > 0);
    truthy('the failure is reported, not swallowed', events.includes('silent_turn'));
    // A fallback on the turns that would otherwise have been silent — but NOT
    // on every one of them forever. A live call apologised six times in a row
    // and the customer stopped answering questions to ask why the line was bad.
    const spokenFallbacks = audio.length - before;
    truthy('the first silent turns are covered', spokenFallbacks >= 2);
    truthy('but it stops apologising rather than saying it every turn',
      spokenFallbacks < REAL_TURNS.length);
  }

  console.log('\n── 37a. the request prefix stays stable, so Groq can cache it ──');
  {
    // THE fix for the 429 that killed a live call. Groq caches on an exact
    // PREFIX match and cached tokens do not count against the rate limit, so
    // from the second round onward the ~1,900 tokens of system prompt and tool
    // schemas are free — but ONLY if nothing shifts the front of the request.
    // Trimming history off the front, which an earlier version did, changes the
    // prefix every call and turns those free tokens back into charged ones.
    const providers = require('../providers');
    const persona = require('../pipeline/persona');
    const real = providers.get;
    const base = real();

    const seen = [];
    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat(o) {
          seen.push({ system: o.system, messages: o.messages.slice() });
          return base.llm.chat(o);
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const s = fresh.createSession({
      callId: 'cache_test', phone: '9820000071', campaign: 'client_feedback',
    });
    await s.start();
    for (const line of ['haan boliye', 'restaurant hai mera', 'qr lagaya hua hai', 'koi customer nahi aaya']) {
      await s.customerSaid(line);
    }
    await s.end('test');
    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];

    truthy('several rounds were sent', seen.length >= 3);

    // The system prompt is the largest single block and must be byte-identical.
    const systems = new Set(seen.map((r) => r.system));
    check('the system prompt never changes mid-call', systems.size, 1);

    // Every request must EXTEND the previous one, never drop from its front.
    let extendsCleanly = true;
    for (let i = 1; i < seen.length; i += 1) {
      const prev = seen[i - 1].messages;
      const now = seen[i].messages;
      if (now.length < prev.length) { extendsCleanly = false; break; }
      for (let j = 0; j < prev.length; j += 1) {
        if (JSON.stringify(now[j]) !== JSON.stringify(prev[j])) { extendsCleanly = false; break; }
      }
      if (!extendsCleanly) break;
    }
    truthy('each request extends the last rather than re-cutting the front', extendsCleanly);

    // And the prompt must be long enough to be cacheable at all — Groq's
    // minimum is 128-1024 tokens depending on the model.
    const approxTokens = Math.round(seen[0].system.length / 4);
    truthy('the prompt is above the minimum cacheable length', approxTokens > 1024);
    void persona;
  }

  console.log('\n── 37b. a rate limit holds the line instead of ending the call ──');
  {
    // From a live call: Groq's free tier answered 429 on the sixth turn, and the
    // engine handed a perfectly happy customer to a human and hung up, blaming
    // "AI runtime error". The quota refills on a clock — the call must survive.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();

    let calls = 0;
    providers.get = () => ({
      ...base,
      llm: {
        ...base.llm,
        supportsStreaming: false,
        chatStream: undefined,
        async chat(o) {
          calls += 1;
          if (calls === 1) {
            throw new Error('LLM 429: {"error":{"message":"Rate limit reached for model '
              + '`openai/gpt-oss-120b` ... tokens per minute (TPM): Limit 8000","code":"rate_limit_exceeded"}}');
          }
          return base.llm.chat(o);
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const said = [];
    const seenTools = [];
    const s = fresh.createSession({
      callId: 'ratelimit_test',
      phone: '9820000061',
      campaign: 'client_feedback',
      onAgentText: (t) => said.push(t),
      onEvent: (type, data) => { if (type === 'tool') seenTools.push(data.name); },
    });
    await s.start();
    await s.customerSaid('haan boliye');

    falsy('the call is still up', s.ended);
    truthy('and something was said rather than dead air', said.length > 1);
    truthy('it blames the line, not the customer', /line thodi slow/i.test(said.join(' ')));
    falsy('nobody was handed to a human over a quota',
      seenTools.includes('transfer_to_human'));

    // The next thing they say must work, because the window has moved on.
    await s.customerSaid('theek hai boliye');
    falsy('the call survived to the next turn', s.ended);
    await s.end('test');

    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];
  }

  console.log('\n── 38. a streaming synthesiser plays audio mid-sentence ──');
  {
    // The REST driver returns a whole sentence at once; the websocket driver
    // hands it back in pieces. The pipe must play the head slot's pieces as they
    // arrive, while still never letting sentence two overtake sentence one.
    const speechPipe = require('../pipeline/speechPipe');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const out = [];
    let firstAudioAt = null;
    const t0 = Date.now();

    const pipe = speechPipe.create({
      maxChars: 1000,
      onFirstAudio: () => { firstAudioAt = Date.now() - t0; },
      synth: async ({ text, onChunk }) => {
        // Three pieces, 30ms apart — the shape a streaming vendor produces.
        for (let i = 0; i < 3; i += 1) {
          await sleep(30);
          onChunk({ audio: Buffer.alloc(8), mime: 'audio/L16', sampleRate: 8000 });
        }
        return { audio: Buffer.alloc(24), mime: 'audio/L16', sampleRate: 8000, text };
      },
    });

    const reply = 'Pehla vaakya yahan poora ho gaya hai bilkul. Doosra vaakya bhi poora hua.';
    // Fed cumulatively, a word at a time, the way a token stream feeds it.
    // Handing over the whole reply at once would queue both sentences as ONE
    // chunk, because splitAtSentence takes every completed sentence it can see.
    let sofar = '';
    for (const w of reply.match(/\S+\s*/g)) { sofar += w; pipe.push(sofar); }

    const played = await pipe.release((p) => out.push(p.text), reply);
    check('every piece of every sentence was played', out.length, 6);
    truthy('the first piece arrived before the sentence finished', firstAudioAt !== null && firstAudioAt < 90);
    truthy('sentence one played entirely before sentence two',
      out.slice(0, 3).every((t) => t.startsWith('Pehla'))
      && out.slice(3).every((t) => t.startsWith('Doosra')));
    check('release reports the pieces it played', played.length, 6);
    // Six pieces, but only two sentences were spoken — the transcript must say
    // two, or one reply lands in the CRM repeated six times.
    check('the transcript counts sentences, not pieces', pipe.spokenText(), reply.replace(/\s+/g, ' ').trim());
    check('and so do the stats', pipe.stats().chunks, 2);
  }

  console.log('\n── 39. the feedback call opens on a first name ──');
  {
    // "Namaste Namdev Bisen ji" is how a database greets someone. The name field
    // is free text and holds whatever was typed at signup, so the greeting has
    // to survive full names, titles, business names and initials without ever
    // reading a noise at a paying customer.
    const persona = require('../pipeline/persona');

    check('a full name is cut to the first name', persona.firstName('Namdev Bisen'), 'Namdev');
    check('a single name is left alone', persona.firstName('Namdev'), 'Namdev');
    check('a title is skipped', persona.firstName('Mr. Namdev Bisen'), 'Namdev');
    check('so is a Hindi honorific', persona.firstName('Shri Ramesh Chandra Gupta'), 'Ramesh');
    check('a business prefix does not become the name', persona.firstName('M/S Bisen Traders'), 'Bisen');
    check('initials are skipped, not spelled out', persona.firstName('A B Verma'), 'Verma');
    check('an empty field yields nothing', persona.firstName('   '), '');
    check('and so does a pasted paragraph', persona.firstName('x'.repeat(40)), '');

    // From a live call: Tapify's name field held the account handle, and the
    // agent opened with "Namaste westernnx ji". A handle is not a name and must
    // never be spoken — "sir" is better.
    check('an account handle is refused', persona.firstName('westernnx'), '');
    // A live call greeted a paying customer as "Namaste Tapify ji" because that
    // account's name field held the brand instead of the owner.
    check('our own brand is never the name', persona.firstName('Tapify'), '');
    check('and it takes the company boilerplate with it',
      persona.firstName('Tapify World Pvt Ltd'), '');
    check('a real first name still survives all of it',
      persona.firstName('Mr. Namdev Bisen'), 'Namdev');
    check('so is one with digits', persona.firstName('sonusteel123'), '');
    check('so is a slug', persona.firstName('western-nx'), '');
    // ...without refusing an ordinary single-word name.
    check('a properly cased single name still works', persona.firstName('Namdev'), 'Namdev');
    check('and a lowercase full name is still usable', persona.firstName('namdev bisen'), 'namdev');

    const named = persona.greetingText({ campaign: 'client_feedback', direction: 'outbound', name: 'Namdev Bisen' });
    check('the opening is the agreed wording', named,
      'Namaste Namdev ji! Main Tapify se bol rahi hoon, aapka feedback lena tha.'
      + ' Kya aapse do minute baat ho sakti hai?');
    // 150 characters was ten seconds of airtime the caller could only listen to.
    truthy('and it is short enough to not be a monologue', named.length < 125);
    truthy('it ends on the question, so the synthesiser lifts it',
      /sakti hai\?$/.test(named));
    falsy('the surname is not read out', /Bisen/.test(named));

    // "Namaste sir ji" is not a thing anyone says.
    const anon = persona.greetingText({ campaign: 'client_feedback', direction: 'outbound' });
    truthy('an unknown caller is greeted as sir', /^Namaste sir!/.test(anon));
    falsy('without a stray honorific', /sir ji/.test(anon));

    const prompt = persona.buildSystemPrompt({ direction: 'outbound', campaign: 'client_feedback' });

    // A live call opened "Namaste westernnx ji" and then, one turn later, said
    // "Namaste Namdev ji" — two different names, neither of them the customer's.
    // The second came out of a worked example in this very prompt: the model
    // read a name written there and used it as if it were real. So the prompt
    // must contain NO usable name at all, and must say where the name comes from.
    falsy('the prompt contains no name the model could lift',
      /\b(Namdev|Ramesh|Kunal|Suresh)\b/.test(prompt));
    truthy('and it says the name comes only from the call record',
      /Only the name under "This call"/i.test(prompt));
    // And it must not re-introduce itself, which the same call also did.
    truthy('the model is told it has already greeted them',
      /ALREADY GREETED|already greeted/i.test(prompt));
    // The script says never to VOLUNTEER it — "as an AI", "I am an AI
    // assistant" — because it makes a check-in call sound like a robocall.
    // That is not the same as being allowed to deny it, and the line between
    // the two is the whole of the honesty rule.
    truthy('the agent is told not to announce itself as an AI',
      /Never say "as an AI"/i.test(prompt));
    truthy('but it must answer honestly if asked outright',
      /asked outright whether this is a machine[\s\S]{0,120}never claim to be a person/i.test(prompt));
  }

  console.log('\n── 40. the OpenAI-compatible stream is parsed correctly ──');
  {
    // The only code here that cannot be exercised without a vendor key, so it
    // gets driven with real Groq/OpenAI-shaped frames instead — including the
    // classic parser killer: a network chunk that ends in the MIDDLE of an SSE
    // event. Get that wrong and it works perfectly in testing, then drops words
    // at random on a live call.
    const openai = require('../providers/llm/openai');
    const cfg = { llm: { model: 'test', openaiBaseUrl: 'https://x.test/v1', openaiKey: 'k', maxTokens: 100 } };
    const driver = openai.create(cfg);

    const ev = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
    const body = [
      ev({ choices: [{ delta: { role: 'assistant' } }] }),
      ev({ choices: [{ delta: { content: 'Namaste sir. ' } }] }),
      ev({ choices: [{ delta: { content: 'Main Tapify se.' } }] }),
      ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_price_quote', arguments: '{"items":' } }] } }] }),
      ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '[{"code":"NFC_CARD"}]}' } }] }, finish_reason: 'tool_calls' }] }),
      ev({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 34 } }),
      'data: [DONE]\n\n',
    ].join('');

    // Deliberately nasty boundaries: 7 bytes at a time slices almost every event.
    const realFetch = global.fetch;
    global.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (let i = 0; i < body.length; i += 7) controller.enqueue(enc.encode(body.slice(i, i + 7)));
        controller.close();
      },
    }), { status: 200 });

    let firstTokens = 0;
    let toolStarts = 0;
    const deltas = [];
    const res = await driver.chatStream({
      system: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'get_price_quote', description: 'd', parameters: {} }],
      onFirstToken: () => { firstTokens += 1; },
      onToolCallStart: () => { toolStarts += 1; },
      onDelta: (piece, soFar) => deltas.push(soFar),
    });
    global.fetch = realFetch;

    check('the text is reassembled across chunk boundaries', res.text, 'Namaste sir. Main Tapify se.');
    check('onFirstToken fires exactly once', firstTokens, 1);
    check('deltas are cumulative', deltas[deltas.length - 1], 'Namaste sir. Main Tapify se.');
    check('one tool call came back', res.toolCalls.length, 1);
    check('with its name', res.toolCalls[0].name, 'get_price_quote');
    // The arguments arrived as two fragments and must be glued before parsing.
    check('and arguments reassembled from fragments',
      res.toolCalls[0].args, { items: [{ code: 'NFC_CARD' }] });
    check('onToolCallStart fires once, on the first fragment', toolStarts, 1);
    check('usage is captured for the cost ledger', res.usage, { in: 120, out: 34, cached: 0 });
    check('the finish reason survives', res.finishReason, 'tool_calls');
  }

  console.log('\n── 41. a streamed reply is spoken once, in order ──');
  {
    // End to end through the real engine with audio enabled: the mock LLM streams
    // its scripted reply, the pipe chunks it, and the transport must receive the
    // pieces in order with the transcript recording the reply exactly once.
    const providers = require('../providers');
    const real = providers.get;
    const base = real();
    const heard = [];
    providers.get = () => ({
      ...base,
      tts: {
        name: 'sim',
        clientSide: false,
        textOnly: false,
        async synth({ text, sampleRate = 8000 }) {
          return { audio: Buffer.alloc(320), mime: 'audio/L16', sampleRate, text };
        },
      },
    });

    delete require.cache[require.resolve('../pipeline/conversation')];
    const fresh = require('../pipeline/conversation');
    const said = [];
    const s = fresh.createSession({
      callId: 'stream_e2e',
      phone: '9820000051',
      audioSampleRate: 8000,
      onAgentText: (t) => said.push(t),
      onAgentAudio: (buf) => heard.push(buf.length),
    });
    await s.start();
    await s.customerSaid('mujhe online selling bhi karni hai website ke saath');
    await s.end('test');

    truthy('audio reached the transport', heard.length > 0);
    const agentLines = s.transcript().filter((t) => t.role === 'agent');
    const dupes = agentLines.filter((l, i) => i > 0 && l.text === agentLines[i - 1].text);
    check('no reply is recorded twice', dupes.length, 0);
    check('the transcript has one row per reply, not one per chunk',
      agentLines.length, said.length);

    providers.get = real;
    delete require.cache[require.resolve('../pipeline/conversation')];
  }

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
