/**
 * The conversation engine — one instance per call.
 *
 * Transport-agnostic on purpose: it receives customer TEXT and emits agent TEXT
 * plus optional audio. Whether that text came from a terminal, a browser mic or a
 * phone line is the transport's problem, which is what lets the same brain be
 * tested for free and then put on a real call unchanged.
 *
 * ── WHAT THIS FILE GUARANTEES, REGARDLESS OF THE MODEL ───────────────────────
 * A language model is persuadable. These are enforced in code so no amount of
 * customer pressure or prompt drift can remove them:
 *
 *   • The greeting costs no LLM and no TTS call (pre-rendered + cached).
 *   • The AI session does not open until a human has spoken (the connect gate) —
 *     the largest single cost saving in the system.
 *   • A failed price lookup NEVER becomes a spoken number. The tool result is
 *     rewritten with an explicit instruction not to state one.
 *   • Every call ends with log_call_outcome, even if the model forgets, the line
 *     drops, or the turn budget runs out (PRD §29).
 *   • Turn and duration budgets are hard. A confused call is capped, not endless.
 *   • Opt-out is checked before the greeting and honoured immediately.
 */
const config = require('../config');
const providers = require('../providers');
const persona = require('./persona');
const ttsCache = require('./ttsCache');
const tools = require('../tools');
const ledgerFactory = require('../cost/ledger');
const log = require('../util/log').make('call');

// A voice turn longer than this is a monologue whatever the prompt said. Trimmed
// at a sentence boundary rather than mid-word. If this fires often, the persona
// has drifted — fix the prompt, don't raise the cap.
const MAX_SPOKEN_CHARS = 420;

// Tool rounds allowed inside ONE customer turn. Three covers
// catalogue -> price -> answer. More than that and the model is looping, which
// costs money and leaves the customer listening to silence.
const MAX_TOOL_ROUNDS = 3;

/**
 * @param {Object} o
 * @param {string} o.callId
 * @param {string} [o.phone]
 * @param {'inbound'|'outbound'} [o.direction]
 * @param {string} [o.campaignId]
 * @param {Function} [o.onAgentText]   (text) => void
 * @param {Function} [o.onAgentAudio]  (buffer, mime) => void
 * @param {Function} [o.onEvent]       (type, data) => void — transcript/tool/UI feed
 * @param {Function} [o.hangup]        () => void — ask the transport to close the line
 */
function createSession(o = {}) {
  const callId = o.callId || 'call_' + Date.now();
  const phone = o.phone || '';
  const direction = o.direction || 'outbound';
  const talk = providers.get();
  const tts = ttsCache.wrap(talk.tts);
  // 8 kHz unless the transport says otherwise. The browser and text transports
  // ignore it; telephony sets it from the provider's codec.
  const audioSampleRate = o.audioSampleRate || 8000;
  const ledger = ledgerFactory.create({ callId, direction, campaignId: o.campaignId });
  const clog = log.child(callId.slice(-6));

  const messages = [];          // neutral format, see providers/llm/*
  const transcript = [];        // [{ at, role, text }]
  const toolEvents = [];

  let systemPrompt = persona.buildSystemPrompt({ direction });
  let turns = 0;
  let ended = false;
  let outcomeLogged = false;
  let engaged = false;          // has the AI session been opened at all?
  let speakToken = 0;           // bumped on barge-in to drop in-flight speech
  let startedAt = Date.now();
  let lastCustomerAt = null;
  // Wall-clock time the agent's queued audio finishes playing. The hang-up clock
  // is always measured from here, never from now — see resetSilenceTimer().
  let speakingUntil = 0;
  // Turns are processed strictly one at a time; see customerSaid().
  let turnChain = Promise.resolve();
  // True while handleTurn() is running. end() uses this to avoid awaiting the
  // very chain it was called from, which would deadlock.
  let insideTurn = false;
  let silenceTimer = null;
  let budgetTimer = null;
  let derivedDisposition = 'connected_needs_info';

  const dispatch = tools.createDispatcher({
    callId,
    phone,
    ledger,
    transcript: () => transcript,
    // Exposed so log_call_outcome can ship the tool trail with the call. The CRM
    // scores qualification partly from WHICH tools ran — a customer who triggered
    // a price lookup showed buying intent — so dropping this silently
    // under-qualifies every lead.
    toolEvents: () => toolEvents,
    onEvent: (name, args, result, ms) => {
      toolEvents.push({ at: new Date(), name, args, ok: result.ok, ms });
      emit('tool', { name, args, result, ms });
    },
  });

  function emit(type, data) {
    if (o.onEvent) {
      try { o.onEvent(type, data); } catch (e) { clog.warn('onEvent threw:', e.message); }
    }
  }

  function record(role, text) {
    transcript.push({ at: new Date(), role, text });
    emit('transcript', { role, text });
  }

  /** Trims to the last sentence end under the cap. */
  function capSpoken(text) {
    if (text.length <= MAX_SPOKEN_CHARS) return text;
    const cut = text.slice(0, MAX_SPOKEN_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('। '));
    const out = lastStop > 80 ? cut.slice(0, lastStop + 1) : cut;
    clog.warn('agent turn was', text.length, 'chars — trimmed to', out.length, '(persona drift?)');
    return out;
  }

  /**
   * Speaks one agent turn. Silently drops if a barge-in happened while TTS was in
   * flight — playing audio the customer already interrupted is worse than saying
   * nothing.
   */
  async function say(text, { cacheableOnly = false } = {}) {
    if (ended || !text) return;
    const mine = speakToken;
    const spoken = capSpoken(text.trim());

    // Never say the same thing twice in a row. A model that emits text alongside
    // a tool call, then emits it again on the next round, would otherwise repeat
    // itself at the customer — which sounds broken and burns TTS characters for
    // the privilege.
    const lastLine = transcript[transcript.length - 1];
    if (lastLine && lastLine.role === 'agent' && lastLine.text === spoken) {
      clog.debug('suppressed an immediate repeat');
      return;
    }

    record('agent', spoken);
    if (o.onAgentText) o.onAgentText(spoken);

    if (tts.textOnly || tts.clientSide) {
      // The client or the terminal renders it; no server-side synthesis, so no
      // TTS cost at all on the free testing path.
      ledger.tts(spoken.length, { cached: true });
      return;
    }

    try {
      const res = await tts.synth({
        text: spoken,
        language: config.stt.language,
        // MUST match the transport. Telephony passes its provider's rate; a
        // mismatch plays the voice at the wrong speed or produces silence, and
        // presents as "the call connects but nobody speaks".
        sampleRate: audioSampleRate,
      });
      if (mine !== speakToken || ended) {
        clog.debug('dropping speech — interrupted');
        return;
      }
      ledger.tts(spoken.length, { cached: Boolean(res.cached) });
      if (res.audio && o.onAgentAudio) {
        o.onAgentAudio(res.audio, res.mime);
        // Hold the hang-up clock for as long as this audio actually plays.
        // Utterances queue behind one another, so extend from whichever is later.
        const rate = res.sampleRate || audioSampleRate;
        const playMs = Math.round((res.audio.length / (rate * 2)) * 1000);
        speakingUntil = Math.max(speakingUntil, Date.now() + playMs);
        resetSilenceTimer();
      }
    } catch (e) {
      // A TTS outage must not kill the call: the text is already recorded, and a
      // transport that can render text (the tester) still shows it.
      clog.error('TTS failed:', e.message);
    }
  }

  /** Barge-in: the customer started talking. */
  function interrupt() {
    speakToken += 1;
    emit('interrupt', {});
  }

  /**
   * Restarts the hang-up clock, always allowing for audio still playing.
   *
   * Without this the clock runs while the agent is mid-sentence, so a long
   * greeting eats most of the window and the call drops on a customer who was
   * still listening. Deriving the allowance from `speakingUntil` rather than an
   * argument means it cannot be lost by a later bare reset — which is exactly
   * what start() used to do straight after speaking the greeting.
   */
  function resetSilenceTimer() {
    const extraMs = Math.max(0, speakingUntil - Date.now());
    if (silenceTimer) clearTimeout(silenceTimer);
    if (ended) return;
    silenceTimer = setTimeout(() => {
      clog.info('silence for', config.limits.silenceHangupSeconds + 's — ending');
      derivedDisposition = engaged ? 'connected_needs_info' : 'busy_callback';
      end('silence');
    }, config.limits.silenceHangupSeconds * 1000 + extraMs);
  }

  /**
   * Opens the AI session. Called on the FIRST human utterance, not at dial time —
   * this is the connect gate, and it is why a dial that hits voicemail costs
   * telephony seconds and nothing else.
   */
  async function engage() {
    if (engaged) return;
    engaged = true;
    ledger.engaged();
    clog.info('engaged — human speech detected');
    emit('engaged', {});

    // Context is fetched now, for the same reason: no point loading CRM history
    // for a call nobody answered.
    if (phone) {
      const ctx = await dispatch('get_customer_context', { phone });
      if (ctx.ok && ctx.known) {
        systemPrompt = persona.buildSystemPrompt({
          direction,
          customer: ctx,
          history: ctx.history,
          campaign: o.campaignId,
        });
        clog.info('known customer:', ctx.company || ctx.name);
      }
    }
  }

  /**
   * Rewrites a failed price/discount result into something the model cannot turn
   * into a number. PRD §7's hard rule, enforced outside the prompt because a
   * prompt is advice and this has to be a guarantee.
   */
  function guardCommercialFailure(name, result) {
    if (result.ok) return result;
    if (name === 'get_price_quote') {
      return {
        ok: false,
        error: result.error || 'No approved price available',
        instruction: 'You do NOT have a price. Do not state, estimate, approximate or hint at any amount. Tell the customer you will get it confirmed, and offer either a callback or to connect them to a colleague.',
        suggested_reply: persona.priceUnavailableText(),
      };
    }
    if (name === 'validate_discount') {
      return {
        ok: false,
        error: result.error || 'Discount could not be validated',
        instruction: 'You may NOT offer any discount. Do not mention a percentage or an amount. Say approval is needed and offer a callback.',
      };
    }
    return result;
  }

  /**
   * One customer utterance -> zero or more tool calls -> one spoken reply.
   *
   * Never call this directly — go through customerSaid(), which serialises turns.
   * Two of these running at once interleave their LLM calls and push tool results
   * into `messages` out of order, which corrupts the conversation irrecoverably.
   * Real STT absolutely does deliver two finals in quick succession.
   */
  async function handleTurn(text) {
    if (ended) return;
    const said = String(text || '').trim();
    if (!said) return;

    lastCustomerAt = Date.now();
    resetSilenceTimer();
    await engage();

    record('customer', said);
    messages.push({ role: 'user', content: said });
    turns += 1;
    ledger.turn();

    // Budget check BEFORE spending an LLM call: once we are at the cap the reply
    // is a wrap-up, and a wrap-up does not need the model.
    if (turns > config.limits.maxTurns) {
      clog.info('turn budget reached (' + config.limits.maxTurns + ')');
      await wrapUp('turn budget reached');
      return;
    }

    const seen = new Set();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      let res;
      try {
        res = await talk.llm.chat({
          system: systemPrompt,
          messages,
          tools: tools.DEFINITIONS,
          maxTokens: config.llm.maxTokens,
        });
      } catch (e) {
        clog.error('LLM failed:', e.message);
        // The model being down is not something to improvise through.
        await say(persona.handoffText());
        await dispatch('transfer_to_human', { reason: 'AI runtime error: ' + e.message, urgency: 'callback' });
        derivedDisposition = 'human_handoff';
        await end('llm_error');
        return;
      }
      ledger.llm(res.usage);

      if (!res.toolCalls || !res.toolCalls.length) {
        // An empty reply with no tool call is DEAD AIR on a phone line — the
        // customer hears nothing and hangs up. It happens when a reasoning model
        // spends the whole output budget thinking (finishReason MAX_TOKENS), so
        // retry once with room to actually answer before falling back.
        if (!res.text) {
          clog.warn('empty LLM reply (finish=' + (res.finishReason || '?') + ') — retrying with a larger budget');
          let retry = null;
          try {
            retry = await talk.llm.chat({
              system: systemPrompt,
              messages,
              tools: tools.DEFINITIONS,
              maxTokens: config.llm.maxTokens * 4,
            });
            ledger.llm(retry.usage);
          } catch (e) {
            clog.error('retry failed:', e.message);
          }

          if (retry && retry.toolCalls && retry.toolCalls.length) {
            res = retry;
          } else if (retry && retry.text) {
            messages.push({ role: 'assistant', content: retry.text, raw: retry.raw });
            await say(retry.text);
            return;
          } else {
            // Still nothing. Say something human rather than leaving silence,
            // and keep the turn alive so the customer can repeat themselves.
            clog.error('LLM produced no reply twice — speaking a filler');
            await say('Sorry sir, aapki baat thodi clear nahi aayi. Ek baar phir se bataiye?');
            return;
          }
        } else {
          messages.push({ role: 'assistant', content: res.text, raw: res.raw });
          await say(res.text);
          return;
        }
      }

      // `raw` carries the provider's own representation of this turn so it can
      // be replayed verbatim. Gemini requires its thought signatures back with
      // each functionCall, and rebuilding the parts by hand drops them — tool
      // use then works for exactly one turn and the next call 400s.
      messages.push({
        role: 'assistant', content: res.text || '', toolCalls: res.toolCalls, raw: res.raw,
      });
      // Anything the model said alongside a tool call is spoken now, so the
      // customer is not left in silence while the tool runs.
      if (res.text) await say(res.text);

      for (const tc of res.toolCalls) {
        const fingerprint = tc.name + ':' + JSON.stringify(tc.args || {});
        if (seen.has(fingerprint)) {
          // A model that re-calls an identical tool is looping. Say so plainly in
          // the result rather than paying for the same call again.
          messages.push({
            role: 'tool', toolCallId: tc.id, name: tc.name,
            content: { ok: false, error: 'You already called this with identical arguments in this turn. Use the earlier result and reply to the customer.' },
          });
          continue;
        }
        seen.add(fingerprint);

        let result = await dispatch(tc.name, tc.args);
        result = guardCommercialFailure(tc.name, result);
        messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: result });

        // Terminal tools: these END the call, so nothing after them matters.
        if (tc.name === 'log_call_outcome' && result.ok) {
          outcomeLogged = true;
          derivedDisposition = (tc.args && (tc.args.disposition || tc.args.disposition)) || derivedDisposition;
          // Give the model one short turn to sign off politely, then hang up.
          const bye = await closingLine();
          if (bye) await say(bye);
          await end('outcome_logged');
          return;
        }
        if (tc.name === 'transfer_to_human' && result.ok) {
          await say(persona.handoffText());
          derivedDisposition = 'human_handoff';
          await wrapUp('handed off to a human', 'human_handoff');
          return;
        }
      }
    }

    // Out of tool rounds with nothing said. Rather than another paid round, close
    // the turn with something honest.
    clog.warn('tool rounds exhausted without a reply');
    await say('Sir, ek minute — main ye confirm karke aapko batata hoon.');
  }

  /**
   * Public entry for a customer utterance. Serialises turns onto one chain so
   * they are always processed in the order they were heard, however fast they
   * arrive. Awaiting the returned promise waits for THIS turn to finish.
   */
  function customerSaid(text) {
    turnChain = turnChain
      .then(async () => {
        insideTurn = true;
        try { await handleTurn(text); } finally { insideTurn = false; }
      })
      .catch((e) => { clog.error('turn failed:', e.stack || e.message); });
    return turnChain;
  }

  /** A short sign-off that costs no LLM call. */
  async function closingLine() {
    return 'Thank you sir, aapka time dene ke liye dhanyavaad. Tapify ki taraf se shubh din.';
  }

  /**
   * Ends the call properly: speak a wrap-up, make sure an outcome exists, hang up.
   * Used by the budget paths and by handoff.
   */
  async function wrapUp(why, disposition) {
    if (ended) return;
    clog.info('wrapping up:', why);
    if (disposition) derivedDisposition = disposition;
    if (!outcomeLogged) {
      await say('Sir, main aapko details bhej deta hoon aur hum follow-up karenge. Thank you.');
    }
    await end(why);
  }

  /**
   * Terminal. Guarantees an outcome is recorded even when the model never called
   * log_call_outcome — PRD §29 requires every conversation to have an outcome and
   * a next action, and "the line dropped" is not an exemption.
   */
  async function end(reason = 'ended') {
    if (ended) return;
    // A hangup that lands mid-turn waits for that turn to finish, so the outcome
    // is logged against the complete conversation rather than half of it. Skipped
    // when end() was itself called from inside a turn, which would deadlock.
    if (!insideTurn) await turnChain.catch(() => {});
    if (ended) return;
    ended = true;
    if (silenceTimer) clearTimeout(silenceTimer);
    if (budgetTimer) clearTimeout(budgetTimer);

    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    ledger.telephony(durationSec);

    // A dial nobody answered is not "needs more information". Settle the
    // disposition on `derivedDisposition` itself rather than on a local, so the
    // value we log, emit and hand to onEnd cannot disagree — an outcome that
    // reads one way in the CRM and another in the transcript is worse than none.
    // An explicit opt-out survives: it was set deliberately and outranks this.
    if (!engaged && derivedDisposition !== 'do_not_contact') {
      derivedDisposition = 'busy_callback';
    }

    if (!outcomeLogged) {
      const summary = engaged
        ? 'Call ended (' + reason + ') after ' + turns + ' customer turn(s). ' + lastAgentGist()
        : 'Dial did not reach a conversation (' + reason + ').';
      const r = await dispatch('log_call_outcome', {
        disposition: derivedDisposition,
        summary,
        next_action: engaged ? 'Review transcript and follow up.' : 'Retry at a different time.',
      });
      outcomeLogged = Boolean(r.ok);
      if (!r.ok) clog.error('could not log the outcome — transcript kept in memory only');
    }

    const snapshot = ledger.snapshot();
    clog.info(ledger.line());
    emit('end', { reason, disposition: derivedDisposition, transcript, toolEvents, cost: snapshot });

    if (o.onEnd) {
      try { await o.onEnd({ reason, disposition: derivedDisposition, transcript, toolEvents, cost: snapshot }); }
      catch (e) { clog.warn('onEnd threw:', e.message); }
    }
    if (o.hangup) {
      try { o.hangup(); } catch (e) { /* line already gone */ }
    }
  }

  function lastAgentGist() {
    const last = [...transcript].reverse().find((t) => t.role === 'customer');
    return last ? 'Last customer input: "' + last.text.slice(0, 120) + '".' : '';
  }

  /**
   * Opens the call. The greeting is spoken from cache and costs no LLM turn — on
   * dials that never become conversations, this is the only thing that happens.
   */
  async function start() {
    startedAt = Date.now();
    clog.info('start', direction, phone || '(no number)');
    emit('start', { callId, direction, phone });

    // Opt-out is checked before a single word is spoken (PRD §18, §25).
    if (phone) {
      const oo = await dispatch('check_opt_out', { phone });
      if (oo.ok && oo.optedOut) {
        clog.warn('number is opted out — ending without speaking');
        derivedDisposition = 'do_not_contact';
        await end('opt_out');
        return;
      }
    }

    // Hard duration budget, independent of turns.
    budgetTimer = setTimeout(() => {
      clog.info('duration budget reached (' + config.limits.maxCallSeconds + 's)');
      wrapUp('duration budget reached');
    }, config.limits.maxCallSeconds * 1000);

    const greeting = persona.greetingText({ direction });
    if (config.limits.greetingGate) {
      // Spoken, but the AI session stays shut until we hear a human back.
      await say(greeting);
    } else {
      await engage();
      await say(greeting);
    }
    // The greeting is part of the conversation as far as the model is concerned,
    // even though no model produced it.
    messages.push({ role: 'assistant', content: greeting });

    resetSilenceTimer();
  }

  return {
    callId,
    start,
    customerSaid,
    interrupt,
    end,
    get ended() { return ended; },
    get engaged() { return engaged; },
    get turns() { return turns; },
    transcript: () => transcript,
    cost: () => ledger.snapshot(),
    ledger,
  };
}

module.exports = { createSession, MAX_SPOKEN_CHARS, MAX_TOOL_ROUNDS };
