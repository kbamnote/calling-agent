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

  console.log('\n── 19. the VAD fires on real speech, not on a clean tone ──');
  {
    // The bug: onset required N CONSECUTIVE frames above the threshold, and the
    // run reset on the first quiet one. Real speech dips below the threshold
    // constantly — between syllables, on unvoiced consonants — so a caller
    // talking at four times the threshold registered as silence and the connect
    // gate stayed shut for the whole call.
    const vadFactory = require('../pipeline/vad');
    const frame = (amp) => {
      const b = Buffer.alloc(640);
      for (let i = 0; i < 320; i += 1) b.writeInt16LE(Math.round(Math.sin(i / 4) * amp * 32767), i * 2);
      return b;
    };
    const onsetMs = (pattern) => {
      const v = vadFactory.create({ frameMs: 20, threshold: 0.05, speechMs: 200 });
      let at = null;
      pattern.forEach((amp, i) => {
        const r = v.push(frame(amp));
        if (r.onset && at === null) at = i * 20;
      });
      return at;
    };

    truthy('continuous speech fires onset', onsetMs(Array(40).fill(0.23)) !== null);

    // Five frames of sound, three of near-silence — what a spoken word looks like.
    const gappy = [];
    for (let i = 0; i < 60; i += 1) gappy.push(i % 8 < 5 ? 0.23 : 0.01);
    const gappyOnset = onsetMs(gappy);
    truthy('speech with syllable gaps fires onset', gappyOnset !== null);
    truthy('and quickly — within 500ms', gappyOnset !== null && gappyOnset < 500);

    check('line noise does NOT open the gate', onsetMs(Array(200).fill(0.04)), null);
    check('nor does silence', onsetMs(Array(200).fill(0)), null);
  }

  console.log('\n── 20. the VAD adapts to each line\'s noise floor ──');
  {
    // Measured across real calls on ONE number, the noise floor ranged from
    // 0.0026 to 0.046 — a 15x spread. A fixed threshold set for the noisy call
    // goes deaf on the quiet one; set for the quiet call it opens the gate on
    // hiss. So the floor is learned per call.
    const vadFactory = require('../pipeline/vad');
    const frame = (amp) => {
      const b = Buffer.alloc(640);
      for (let i = 0; i < 320; i += 1) b.writeInt16LE(Math.round(Math.sin(i / 4) * amp * 32767), i * 2);
      return b;
    };
    /** 2s of line noise to learn from, then speech with syllable gaps. */
    const callOnset = (noise, speech) => {
      const v = vadFactory.create({ frameMs: 20, threshold: 0.05, speechMs: 200 });
      for (let i = 0; i < 100; i += 1) v.push(frame(noise));
      let at = null;
      for (let i = 0; i < 80; i += 1) {
        const r = v.push(frame(i % 8 < 5 ? speech : noise));
        if (r.onset && at === null) at = i * 20;
      }
      return at;
    };

    truthy('noisy line, loud speech', callOnset(0.04, 0.23) !== null);
    truthy('quiet line, quiet speech', callOnset(0.0026, 0.02) !== null);
    truthy('very quiet speaker', callOnset(0.0005, 0.008) !== null);

    // The saving that pays for the whole design still has to hold: a line with
    // nothing but noise must never open the gate, however quiet the line is.
    const noiseOnly = vadFactory.create({ frameMs: 20, threshold: 0.05, speechMs: 200 });
    let fired = false;
    for (let i = 0; i < 400; i += 1) {
      if (noiseOnly.push(frame(0.04 + (i % 7) * 0.002)).onset) fired = true;
    }
    falsy('a noise-only line never opens the gate', fired);
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

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
