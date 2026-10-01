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
const turnClock = require('./turnClock');
const speechPipe = require('./speechPipe');
const tools = require('../tools');
const ledgerFactory = require('../cost/ledger');
const log = require('../util/log').make('call');

// A voice turn longer than this is a monologue whatever the prompt said. Trimmed
// at a sentence boundary rather than mid-word. If this fires often, the persona
// has drifted — fix the prompt, don't raise the cap.
// Roughly two spoken sentences. The model is TOLD one sentence under 25 words
// and does not reliably obey — measured at ~344 output tokens per turn against a
// ~35 token instruction. A prompt is advice; this is the guarantee. Anything
// longer is trimmed at a sentence boundary and logged as persona drift.
const MAX_SPOKEN_CHARS = 240;

// Tool rounds allowed inside ONE customer turn. Three covers
// catalogue -> price -> answer. More than that and the model is looping, which
// costs money and leaves the customer listening to silence.
const MAX_TOOL_ROUNDS = 3;

// Messages kept in the window sent to the model. OFF by default, and that is
// the deliberate choice — trimming the history LOSES tokens on Groq.
//
// Groq caches automatically on an exact PREFIX match, and cached tokens do not
// count against the rate limit. Appending to the conversation keeps that prefix
// intact, so from the second round of a call onward the system prompt and the
// tool schemas — around 1,900 tokens, by far the bulk of a request — are free.
// Dropping messages off the FRONT changes the prefix on every call, misses the
// cache every time, and turns 1,900 free tokens back into 1,900 charged ones.
// The trimming is strictly worse than the growth it was meant to prevent.
//
// Set LLM_HISTORY_WINDOW on a vendor that does NOT do prefix caching, where the
// arithmetic goes the other way.
const HISTORY_WINDOW = Number(process.env.LLM_HISTORY_WINDOW) || 0;

/**
 * Is this the vendor saying "too fast", rather than "broken"?
 *
 * Matched on the status the driver puts in the message, plus the vendor wording,
 * because these come back as plain Errors from three different drivers and only
 * the text is common to all of them.
 */
function isRateLimited(e) {
  const m = String((e && e.message) || '');
  return /\b429\b/.test(m) || /rate[_ ]?limit|too many requests|quota/i.test(m);
}

// How long a turn may stay silent before the agent says something short to hold
// the line. Measured on real calls a turn runs 2.5-5s, and silence that long on
// a phone reads as a dropped call. Set to 0 to disable.
// Raised from 1400ms. It is no longer covering the same gap: a streamed turn
// commits to its answer at `llm_done` and marks the turn as spoken there, which
// on measured timings lands around 1.3s — so a 1400ms window fired "ek second
// sir" a fraction of a second before answers the agent already had, on turn
// after turn. At 1800ms a normal turn never reaches it and a genuinely stalled
// one still does.
//
// This is the ceiling on silence, not a pacing device. If it fires often,
// something downstream is slow and THAT is the thing to fix.
const THINKING_FILLER_MS = Number(process.env.THINKING_FILLER_MS) || 1800;

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

  const campaign = o.campaign || 'sales';
  // Known up front on an outbound campaign call — we chose to dial this person,
  // so the greeting can use their name instead of "sir".
  const greetingName = o.clientName || '';
  // The dialer already cleared this number against the do-not-contact list, so
  // repeating the CRM round-trip here would only add silence between pickup and
  // the first word. Set by the answer endpoint, and only for outbound.
  const optOutChecked = Boolean(o.optOutChecked) && direction === 'outbound';
  // Only this campaign's tools are ever shown to the model — a tool it cannot
  // see is a tool it cannot be talked into using.
  const toolDefs = tools.definitionsFor(campaign);
  let systemPrompt = persona.buildSystemPrompt({ direction, campaign });
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
  // Whether this turn has produced real speech yet, so the holding line is
  // never spoken on top of an answer that already arrived.
  let spokeThisTurn = false;
  // Per-turn stage timings. On a phone line latency IS the product, so every
  // turn reports where its seconds went rather than leaving it to guesswork.
  let turnTimer = null;
  // The customer-facing stopwatch: end-of-speech to first audio. Separate from
  // turnTimer because that one measures OUR stages, and the two disagree by the
  // whole STT round-trip — see pipeline/turnClock.js.
  let clock = null;
  // Turns are processed strictly one at a time; see customerSaid().
  let turnChain = Promise.resolve();
  // True while handleTurn() is running. end() uses this to avoid awaiting the
  // very chain it was called from, which would deadlock.
  let insideTurn = false;
  let silenceTimer = null;
  let budgetTimer = null;
  // Write tools still running while the agent talks. Awaited once at end(), so
  // a call cannot hang up with a customer's feedback still in flight.
  const backgroundWork = [];
  // One holding line per turn at most, wherever it was armed from.
  let fillerArmed = false;
  // Whether ANY audio reached the transport during this turn. Not the same as
  // spokeThisTurn, which only says the engine believed it had something to say.
  let audioThisTurn = false;
  // The holding line's timer. Session-scoped so it can be genuinely CANCELLED
  // when the turn produces an answer — checking a flag at fire time leaves it
  // armed, and a stale one fires "ek minute" over the top of the next turn.
  let fillerTimer = null;
  let derivedDisposition = 'connected_needs_info';

  const dispatch = tools.createDispatcher({
    callId,
    phone,
    campaign,
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
  /**
   * Strips anything that is machinery rather than speech.
   *
   * A live call ended with the agent reading this at a customer:
   *
   *   "धन्यवाद, सर! ... log_call_outcome({"disposition":"connected_interested",
   *    "summary":"Customer reports card and website are working fine..."
   *
   * The model wrote a tool call as plain TEXT instead of calling the tool. The
   * engine had no reason to doubt it, handed it to TTS, and Sarvam rejected the
   * JSON with "Input texts must contain at least one character from the allowed
   * languages" — so the customer got silence where their answer should have been.
   *
   * The tool still does not run: this only stops the caller hearing the attempt.
   * A model doing this is a prompt problem, so it is logged loudly rather than
   * quietly cleaned up.
   */
  function stripMachinery(text, { quiet = false } = {}) {
    let out = String(text || '');
    const before = out;

    // `tool_name({...` — with or without a closing brace, because the model
    // often runs out of tokens mid-JSON and the fragment is what gets spoken.
    out = out.replace(/\b[a-z_]{4,40}\s*\(\s*\{[\s\S]*$/i, '');
    out = out.replace(/\b[a-z_]{4,40}\s*\(\s*\{[\s\S]*?\}\s*\)/gi, '');
    // A bare JSON object or fenced block that made it into the reply.
    out = out.replace(/```[\s\S]*?(```|$)/g, '');
    out = out.replace(/\{\s*"[\s\S]*$/, '');

    out = out.replace(/\s+/g, ' ').trim();
    if (!quiet && out !== before.replace(/\s+/g, ' ').trim()) {
      clog.warn('stripped a tool call the model wrote as speech:',
        before.slice(0, 120).replace(/\s+/g, ' '));
    }
    return out;
  }

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
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.filler] true for the short holding line. It must not
   *   count as the turn having produced an answer, or the real reply that
   *   follows would be suppressed as "already spoke".
   */
  async function say(text, { filler = false } = {}) {
    if (ended || !text) return;
    const mine = speakToken;
    const spoken = capSpoken(stripMachinery(text));

    // The model wrote a tool call and NOTHING else, so stripping it left an
    // empty string. Carrying on would record a blank agent line and hand ""
    // to the synthesiser; returning here leaves the turn with no audio, which
    // is exactly the state ensureSomethingWasHeard() exists to rescue.
    if (!spoken) {
      clog.warn('the reply was entirely machinery — nothing left to say');
      return;
    }

    // Never say the same thing twice in a row. A model that emits text alongside
    // a tool call, then emits it again on the next round, would otherwise repeat
    // itself at the customer — which sounds broken and burns TTS characters for
    // the privilege.
    const lastLine = transcript[transcript.length - 1];
    if (lastLine && lastLine.role === 'agent' && lastLine.text === spoken) {
      clog.debug('suppressed an immediate repeat');
      return;
    }

    if (!filler) spokeThisTurn = true;
    record('agent', spoken);
    if (o.onAgentText) o.onAgentText(spoken);

    if (tts.textOnly || tts.clientSide) {
      // The client or the terminal renders it; no server-side synthesis, so no
      // TTS cost at all on the free testing path.
      ledger.tts(spoken.length, { cached: true });
      return;
    }

    try {
      const ttsStart = Date.now();
      if (clock && !filler) clock.mark('tts_start');
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
      if (turnTimer) turnTimer.ttsMs += Date.now() - ttsStart;
      if (clock && !filler) clock.mark('tts_first_audio');
      ledger.tts(spoken.length, { cached: Boolean(res.cached) });
      emitAudio(res, { filler });
    } catch (e) {
      // A TTS outage must not kill the call: the text is already recorded, and a
      // transport that can render text (the tester) still shows it.
      clog.error('TTS failed:', e.message);
    }
  }

  /**
   * Hands one synthesised chunk to the transport and holds the hang-up clock.
   *
   * Shared by the fixed lines (say) and the streamed answer (speakChunks) so
   * there is exactly one place that knows how long a buffer takes to play. The
   * hang-up clock ACCUMULATES from whichever is later — the end of what is
   * already queued, or now — because utterances queue behind one another on the
   * wire. Taking max(speakingUntil, now + playMs) instead under-counts as soon
   * as more than one is queued, and the clock then fires mid-sentence.
   */
  function emitAudio(res, { filler = false } = {}) {
    if (!res || !res.audio || !res.audio.length || !o.onAgentAudio) return;
    // The moment the customer's silence actually ends. Marked here, at the last
    // point we control, rather than when synthesis finished.
    if (clock) clock.mark('audio_out');
    // Proof the caller heard an ANSWER. Deliberately not set by the holding
    // line: a turn whose only output was "ek second sir" has not answered
    // anybody, and counting it here let a real call end with the agent having
    // said nothing else at all.
    if (!filler) audioThisTurn = true;
    o.onAgentAudio(res.audio, res.mime);
    const rate = res.sampleRate || audioSampleRate;
    const playMs = Math.round((res.audio.length / (rate * 2)) * 1000);
    speakingUntil = Math.max(speakingUntil, Date.now()) + playMs;
    resetSilenceTimer();
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
    // for a call nobody answered. WHICH context depends on the campaign — a
    // feedback call needs their product usage, not their lead history.
    if (!phone) return;

    if (campaign === 'client_feedback') {
      const status = await dispatch('get_client_status', { phone });
      if (status.ok) {
        systemPrompt = persona.buildSystemPrompt({ direction, campaign, client: status });
        clog.info(status.isClient
          ? 'client: ' + (status.name || phone) + ', app ' + (status.appInstalled ? 'installed' : 'NOT installed')
            + ', ' + status.health
          : 'number is not a known Tapify client');
      }
      return;
    }

    const ctx = await dispatch('get_customer_context', { phone });
    if (ctx.ok && ctx.known) {
      systemPrompt = persona.buildSystemPrompt({
        direction,
        campaign,
        customer: ctx,
        history: ctx.history,
      });
      clog.info('known customer:', ctx.company || ctx.name);
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
  async function handleTurn(text, speechEndAt, sttStartAt) {
    if (ended) return;
    const said = String(text || '').trim();
    if (!said) return;

    lastCustomerAt = Date.now();
    turnTimer = { start: Date.now(), llmMs: 0, ttsMs: 0, toolMs: 0, bgToolMs: 0, llmCalls: 0 };
    clock = turnClock.create({ callId, turn: turns + 1, speechEndAt });
    // The transcription request went out when the transport closed the
    // utterance; if it did not tell us, the best available answer is end-of-
    // speech itself, which makes the STT leg read as the full wait.
    clock.mark('stt_start', sttStartAt || speechEndAt);
    clock.mark('transcript');

    // Hold the line if this turn is slow. Only ever fires once per turn, so a
    // fast turn is untouched.
    //
    // spokeThisTurn is reset FIRST: arming the timer before clearing the flag
    // leaves a window in which the previous turn's answer still counts as this
    // turn's, and the holding line is skipped on a turn that needed it.
    spokeThisTurn = false;
    audioThisTurn = false;
    fillerArmed = false;
    if (fillerTimer) clearTimeout(fillerTimer);
    fillerTimer = null;
    // Armed for the turn as a whole: a ceiling on how long the caller may sit in
    // silence, whatever is slow. armFiller() is called again before a blocking
    // tool, where it is a no-op if this one is already running.
    armFiller();
    // Deliberately NOT restarting the hang-up clock here. customerSaid() stopped
    // it for the duration of this turn and restarts it once we have replied —
    // re-arming at the top would put the timeout back in front of the LLM call,
    // which is exactly the race that dropped a caller while Gemini was retrying.
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
      let pipe = null;
      const llmStart = Date.now();
      try {
        ({ res, pipe } = await runRound());
      } catch (e) {
        clog.error('LLM failed:', e.message);

        // A RATE LIMIT IS NOT A BROKEN MODEL. Groq's free tier allows 8000
        // tokens a minute, and a normal call runs into that around the sixth
        // turn — at which point the old code handed a perfectly happy customer
        // to a human and hung up on them, blaming "AI runtime error".
        //
        // The quota refills on a clock, so the right move is to stay on the
        // line: say one short thing and let this turn go. The customer's next
        // sentence starts a fresh turn, by which time the window has moved on.
        if (isRateLimited(e)) {
          clog.warn('rate limited — holding the line rather than ending the call');
          if (clock) clock.note('rateLimited', true);
          await say(persona.busyLineText());
          return;
        }

        // Anything else genuinely is a broken model, and that is not something
        // to improvise through.
        await say(persona.handoffText());
        await dispatch('transfer_to_human', { reason: 'AI runtime error: ' + e.message, urgency: 'callback' });
        derivedDisposition = 'human_handoff';
        await end('llm_error');
        return;
      }
      if (turnTimer) { turnTimer.llmMs += Date.now() - llmStart; turnTimer.llmCalls += 1; }
      if (clock) clock.mark('llm_done');
      // Surfaced per turn because it is the difference between a call that
      // finishes and a call that dies on a 429: tokens the vendor served from
      // its prefix cache do not count against the rate limit. If this stays 0
      // after the first round, something is changing the prefix and the whole
      // system prompt is being charged for on every single request.
      if (clock && res.usage) {
        clock.note('in', res.usage.in || 0).note('cached', res.usage.cached || 0);
      }
      ledger.llm(res.usage);

      // A round that has to WAIT for a tool cannot speak yet, so whatever the
      // pipe speculatively synthesised was narration the engine does not speak.
      // Drop it, and say so — silently paying for discarded audio is how a cost
      // regression hides. A round with only background writes keeps its audio:
      // that text is the answer, and it goes out while the writes run.
      if (pipe && (res.toolCalls || []).some(
        (tc) => !config.llm.backgroundTools || tools.isBlocking(tc.name),
      )) {
        const wasted = pipe.discard();
        if (wasted) clog.debug('discarded ' + wasted + ' speculatively synthesised chars (blocking tool round)');
      }

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
              // The same window as the normal path, not the raw array. Sending a
              // different set of messages here would present the vendor with a
              // different prefix and throw away the cache for the rest of the call.
              messages: recentMessages(),
              tools: toolDefs,
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
          await speakAnswer(res.text, pipe);
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
      // NOT spoken. Text the model emits alongside a tool call is narration —
      // "let me check that for you", "I'll look at our packages" — and it fires
      // on EVERY tool round. Three rounds meant three narrations plus the real
      // answer: four synthesis calls, 14 seconds of TTS, and 34 seconds of the
      // agent talking at a customer who had asked one question. It reads as the
      // bot talking to itself.
      //
      // The silence it used to cover is now handled by the cached holding line
      // (persona.thinkingText), which costs nothing and says one short thing
      // once. Only the FINAL reply is spoken.
      // Drop the ones the model is repeating verbatim before deciding anything
      // else: a looping model must not make a turn look like it needs a blocking
      // round when every call in it is a duplicate.
      const fresh = [];
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
        fresh.push(tc);
      }

      const canDefer = config.llm.backgroundTools;
      const blocking = canDefer ? fresh.filter((tc) => tools.isBlocking(tc.name)) : fresh;
      const background = canDefer ? fresh.filter((tc) => !tools.isBlocking(tc.name)) : [];

      // ── SPEAK NOW, WRITE AFTERWARDS ──────────────────────────────────────
      // Every tool in this round is a write whose result the agent does not
      // need, and it already wrote the sentence that answers the customer. Make
      // them wait for a CRM round-trip and a second model call to hear it, and
      // the reply lands three seconds late for no benefit at all.
      //
      // So: say it, and let the writes run while it plays.
      if (!blocking.length && background.length && res.text) {
        for (const tc of background) {
          messages.push({
            role: 'tool', toolCallId: tc.id, name: tc.name,
            content: { ok: true, queued: true, note: 'Recorded. Continue the conversation.' },
          });
        }
        runInBackground(background);
        await speakAnswer(res.text, pipe);
        return;
      }

      // A round with nothing to say and only writes to do still has to reach the
      // model again for the actual reply, but the writes need not delay it.
      if (background.length) {
        for (const tc of background) {
          messages.push({
            role: 'tool', toolCallId: tc.id, name: tc.name,
            content: { ok: true, queued: true, note: 'Recorded. Continue the conversation.' },
          });
        }
        runInBackground(background);
      }

      if (!blocking.length) continue;

      // A terminal tool has its OWN spoken line waiting behind it — the handoff
      // sentence, or the sign-off. Holding the line first just means the caller
      // hears "ek second sir" and then, immediately, the real line: two
      // utterances back to back where one was wanted. That is exactly what a
      // live call did before a handoff.
      if (blocking.every((tc) => tc.name === 'transfer_to_human' || tc.name === 'log_call_outcome')) {
        if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
      } else {
        armFiller();
      }

      // SIGN OFF WHILE THE OUTCOME IS BEING WRITTEN, not after it.
      //
      // log_call_outcome is a write. The goodbye is a fixed line, already in
      // cache, and depends on nothing the CRM hands back — so making the caller
      // listen to silence for the round-trip buys nothing at all. Measured at
      // 1259ms of dead air in front of a line we already had.
      //
      // Still AWAITED below before the call ends, so the outcome cannot be lost.
      const signOff = blocking.some((tc) => tc.name === 'log_call_outcome')
        ? say(persona.closingText()).catch((e) => clog.error('sign-off failed:', e.message))
        : null;

      // Reads the model asked for together are independent of one another, so
      // they go out together. Three catalogue/context lookups in series is three
      // round-trips of silence where one would do.
      const toolStart = Date.now();
      const results = await Promise.all(blocking.map(async (tc) => {
        let result = await dispatch(tc.name, tc.args);
        return guardCommercialFailure(tc.name, result);
      }));
      if (turnTimer) turnTimer.toolMs += Date.now() - toolStart;
      if (clock) clock.note('toolMs', Date.now() - toolStart);
      if (signOff) await signOff;

      for (let i = 0; i < blocking.length; i += 1) {
        const tc = blocking[i];
        const result = results[i];
        messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: result });

        // Terminal tools: these END the call, so nothing after them matters.
        if (tc.name === 'log_call_outcome' && result.ok) {
          outcomeLogged = true;
          derivedDisposition = (tc.args && tc.args.disposition) || derivedDisposition;
          // Already spoken, concurrently with this write — see signOff above.
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
   * The slice of the conversation actually sent to the model.
   *
   * Every round resends the whole history, so an untrimmed conversation costs
   * more tokens on turn ten than on turn one for no benefit — a check-in call
   * turns on what was said in the last minute, not the first. On a rate-limited
   * tier that growth is what eventually kills the call: one real call spent
   * 16,000 input tokens over six turns and died on a 429.
   *
   * Trimming is NOT a simple slice. An assistant turn that carries tool calls
   * and the tool results that answer it are one unit — send a `tool` message
   * whose assistant turn was dropped and the vendor rejects the whole request,
   * which would take the call down mid-sentence. So the window is walked back
   * to the nearest safe boundary: a `user` message, which never depends on
   * anything before it.
   */
  function recentMessages() {
    if (!HISTORY_WINDOW || messages.length <= HISTORY_WINDOW) return messages;

    let start = messages.length - HISTORY_WINDOW;
    while (start > 0 && messages[start].role !== 'user') start -= 1;
    if (start <= 0) return messages;

    clog.debug('history trimmed to last ' + (messages.length - start) + ' of ' + messages.length);
    return messages.slice(start);
  }

  /**
   * Arms the holding line, for a wait that is actually happening.
   *
   * The old version set this timer at the top of EVERY turn, so any turn slower
   * than 1.4s got "ek second sir" whether or not the agent was waiting for
   * anything — and with streaming, most turns are slower than 1.4s only because
   * TTS takes that long, by which point the answer is already on its way. The
   * result was a holding line in front of a reply the agent already had.
   *
   * Now it is armed at exactly one place: after the engine has decided it must
   * block on a tool result before it can say anything.
   */
  function armFiller() {
    if (THINKING_FILLER_MS <= 0 || fillerArmed || spokeThisTurn) return;
    fillerArmed = true;
    if (fillerTimer) clearTimeout(fillerTimer);
    fillerTimer = setTimeout(() => {
      if (!ended && !spokeThisTurn) say(persona.thinkingText(), { filler: true }).catch(() => {});
    }, THINKING_FILLER_MS);
    if (fillerTimer.unref) fillerTimer.unref();
  }

  /**
   * Runs write tools without making the customer wait for them.
   *
   * The agent is already speaking by the time these land, so a failure here has
   * nowhere to go in the conversation and must not be allowed to surface as one:
   * an exception escaping this would reject the turn chain and take the call
   * down over a note that did not save. They are logged, counted, and awaited
   * once at end() so a call cannot hang up with its feedback still in flight.
   */
  function runInBackground(calls) {
    for (const tc of calls) {
      clog.debug('background: ' + tc.name);
      const p = (async () => {
        const started = Date.now();
        try {
          const result = await dispatch(tc.name, tc.args);
          if (!result.ok) clog.warn('background ' + tc.name + ' failed: ' + (result.error || '?'));
          if (tc.name === 'log_call_outcome' && result.ok) outcomeLogged = true;
        } catch (e) {
          clog.error('background ' + tc.name + ' threw:', e.message);
        } finally {
          if (turnTimer) turnTimer.bgToolMs += Date.now() - started;
        }
      })();
      backgroundWork.push(p);
    }
  }

  /**
   * One model round, streamed where the driver supports it.
   *
   * Streaming is not just a faster way to get the same string: it is what lets
   * synthesis of sentence one overlap generation of sentence two, which is where
   * most of the saving in this file comes from. The pipe it returns holds
   * whatever audio was produced along the way.
   *
   * Falls back to a single blocking request if the driver cannot stream, if
   * streaming is switched off, or if the stream fails — a vendor having a bad
   * day must cost latency, never the call.
   */
  async function runRound() {
    const ask = {
      system: systemPrompt,
      messages: recentMessages(),
      tools: toolDefs,
      maxTokens: config.llm.maxTokens,
    };

    if (clock) clock.mark('llm_start');

    if (!config.llm.streaming || !talk.llm.chatStream || !talk.llm.supportsStreaming) {
      const res = await talk.llm.chat(ask);
      // Without streaming there is no first token to observe — the whole reply
      // arrives at once, so both marks land together and the report says so
      // rather than implying a time-to-first-token nobody measured.
      if (clock) { clock.mark('llm_first_token'); clock.mark('llm_done'); }
      return { res, pipe: null };
    }

    const mine = speakToken;
    const pipe = speechPipe.create({
      maxChars: MAX_SPOKEN_CHARS,
      // Barge-in and hang-up both invalidate work in flight. Checked here as
      // well as at emission so a cancelled turn stops PAYING for synthesis, not
      // just stops playing it.
      isStale: () => ended || mine !== speakToken,
      onFirstAudio: () => { if (clock) clock.mark('tts_first_audio'); },
      synth: (opts) => {
        if (clock) clock.mark('tts_start');
        return tts.synth({ ...opts, language: config.stt.language, sampleRate: audioSampleRate });
      },
    });

    // A transport with no audio out (the terminal, the browser tester rendering
    // text) must not synthesise anything at all.
    const canSynth = !tts.textOnly && !tts.clientSide && Boolean(o.onAgentAudio);

    try {
      const res = await talk.llm.chatStream({
        ...ask,
        onFirstToken: () => { if (clock) clock.mark('llm_first_token'); },
        onDelta: (piece, textSoFar) => {
          if (!canSynth) return;
          // Sanitised on the way in, quietly: a half-written tool call arrives
          // over many deltas and warning on each one would bury the log.
          pipe.push(stripMachinery(textSoFar, { quiet: true }));
        },
        // The first tool-call fragment names the tool, and the name decides
        // whether this round can still speak. A BLOCKING tool means the answer
        // depends on a result we do not have, so stop synthesising immediately —
        // that keeps the waste to at most the one sentence the model narrated
        // before reaching for it. A background write is the opposite case: the
        // text IS the answer, so keep going and it plays while the write runs.
        onToolCallStart: (name) => {
          if (!name || !config.llm.backgroundTools || tools.isBlocking(name)) {
            pipe.disarm('blocking tool');
          }
        },
      });
      return { res, pipe: canSynth ? pipe : null };
    } catch (e) {
      pipe.disarm('stream failed');
      clog.warn('LLM stream failed (' + e.message.slice(0, 120) + ') — retrying without streaming');
      const res = await talk.llm.chat(ask);
      if (clock) clock.mark('llm_first_token');
      return { res, pipe: null };
    }
  }

  /**
   * Speaks the model's answer, preferring audio the pipe already synthesised.
   *
   * The fallback is not dead code: it runs on every non-streaming provider, on
   * a reply too short to have crossed the chunk threshold, and any time the pipe
   * was disarmed. It must stay byte-for-byte equivalent to the fast path from
   * the caller's point of view — the only difference is who paid for the audio
   * and when.
   */
  async function speakAnswer(text, pipe) {
    // Cleaned ONCE, here, so the tail the pipe is about to synthesise is the
    // same sanitised string the dedupe check and the transcript see.
    const clean = stripMachinery(text);
    if (!pipe) { await say(clean); return; }

    const spoken = capSpoken(clean);
    const lastLine = transcript[transcript.length - 1];
    if (lastLine && lastLine.role === 'agent' && lastLine.text === spoken) {
      clog.debug('suppressed an immediate repeat');
      pipe.discard();
      return;
    }

    // Set before the first chunk plays, which SUPPRESSES the holding line for a
    // streamed turn. Deliberate: the filler earns its place when the answer is
    // four seconds away, but streaming brings the first audio inside the
    // filler's own window, and a holding line played first would queue the real
    // answer behind two seconds of "ek minute" — slower than saying nothing.
    // Tool rounds, which are the slow case, never reach here and keep the filler.
    spokeThisTurn = true;

    const ttsStart = Date.now();
    const chunks = await pipe.release((c) => {
      // billChars, not text.length — see speechPipe. Falls back for any driver
      // that returns a whole utterance in one piece.
      ledger.tts(c.billChars === undefined ? c.text.length : c.billChars, { cached: Boolean(c.cached) });
      emitAudio(c);
    }, clean);
    if (turnTimer) turnTimer.ttsMs += Date.now() - ttsStart;

    const st = pipe.stats();
    if (clock) clock.note('chunks', st.chunks).note('cachedChunks', st.cached);

    // The pipe covers only what it was fed and what actually came back. A reply
    // under the chunk threshold, or one that arrived after it disarmed, still
    // has to be spoken — saying nothing here would be dead air.
    const heard = chunks.length ? pipe.spokenText() : '';
    if (!heard) { await say(clean); return; }

    // Recorded ONCE, from the pipe rather than from `text`, so the transcript
    // says what the caller will HEAR: one row per reply, and nothing claimed for
    // a sentence whose synthesis failed and never played.
    record('agent', heard);
    if (o.onAgentText) o.onAgentText(heard);
  }

  /**
   * Last line of defence: the turn produced words but the caller heard nothing.
   *
   * A production turn logged `NEVER SPOKE, chunks=0` — the model answered, TTS
   * rejected the text, and the customer got silence with no sign anything was
   * wrong. Silence is the one outcome a phone call cannot recover from, because
   * the caller assumes the line dropped and hangs up.
   *
   * So the turn is not finished until audio has actually been handed to the
   * transport. If it has not, a pre-rendered line goes out instead: it is
   * cached, it cannot itself fail for the reason the real reply just did, and it
   * invites the caller to speak again rather than leaving them guessing.
   */
  async function ensureSomethingWasHeard() {
    if (ended || audioThisTurn || !o.onAgentAudio) return;
    if (tts.textOnly || tts.clientSide) return;

    clog.error('the turn produced no audio — speaking a fallback rather than leaving silence');
    if (clock) clock.note('silentTurn', true);
    emit('silent_turn', { turn: turns });

    // Deliberately NOT routed through say(): its repeat-suppression and cap are
    // about conversational quality, and this is about the line not going dead.
    try {
      const line = persona.busyLineText();
      const res = await tts.synth({
        text: line,
        language: config.stt.language,
        sampleRate: audioSampleRate,
      });
      emitAudio(res);
      // The caller HEARD this, so the record has to say so. Without it the
      // transcript shows a turn where the agent said nothing — which is the
      // very thing this function exists to prevent, just moved from the phone
      // line into the CRM.
      record('agent', line);
      if (o.onAgentText) o.onAgentText(line);
    } catch (e) {
      clog.error('even the fallback line could not be synthesised:', e.message);
    }
  }

  /**
   * Public entry for a customer utterance. Serialises turns onto one chain so
   * they are always processed in the order they were heard, however fast they
   * arrive. Awaiting the returned promise waits for THIS turn to finish.
   *
   * @param {number} [o.speechEndAt] ms epoch the caller stopped talking. Only
   *   the transport knows this, and without it the latency report silently
   *   starts its clock after the VAD window and the STT round-trip — a third of
   *   the wait, hidden.
   */
  function customerSaid(text, { speechEndAt, sttStartAt } = {}) {
    turnChain = turnChain
      .then(async () => {
        insideTurn = true;
        // The hang-up clock measures the CUSTOMER's silence. While we are
        // working on their turn the silence is ours, so stop counting: a slow
        // or retrying vendor would otherwise trip the timeout and drop a caller
        // who is simply waiting for an answer. The duration budget still caps
        // the call, so this cannot hang forever.
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        try {
          await handleTurn(text, speechEndAt, sttStartAt);
          // Checked INSIDE the try, before the timings are reported, so a turn
          // that produced no audio still gets a voice on the line.
          await ensureSomethingWasHeard();
        } finally {
          insideTurn = false;
          // The turn is over: the holding line has nothing left to hold.
          if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
          if (turnTimer) {
            const total = Date.now() - turnTimer.start;
            // Two numbers, and they are not the same number. This one is where
            // OUR seconds went; the clock line below is what the CALLER sat
            // through, which also includes the VAD's trailing-silence window and
            // the STT round-trip that happened before we were even told.
            clog.info('turn took ' + total + 'ms'
              + ' [llm ' + turnTimer.llmMs + 'ms x' + turnTimer.llmCalls
              + ', tools ' + turnTimer.toolMs + 'ms'
              + ', tts ' + turnTimer.ttsMs + 'ms]'
              + (total > 4000 ? '  <-- SLOW' : ''));
            turnTimer = null;
          }
          if (clock) {
            const reply = clock.responseMs();
            clog.info(clock.line() + (reply !== null && reply > 2500 ? '  <-- SLOW' : ''));
            emit('latency', clock.toJSON());
            clock = null;
          }
          if (!ended) resetSilenceTimer();
        }
      })
      .catch((e) => { clog.error('turn failed:', e.stack || e.message); });
    return turnChain;
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
    if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }

    // Writes that were deliberately not waited for DURING the call are waited
    // for at the end of it. Speaking over them is the point; losing a customer's
    // feedback because the line closed a moment later is not. They already
    // swallow their own failures, so this cannot throw.
    if (backgroundWork.length) await Promise.all(backgroundWork).catch(() => {});

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

    // The whole conversation, in the log. Judging "was that a good call?" from
    // timings and a disposition is guesswork — you have to read what was
    // actually said. Set LOG_TRANSCRIPT=false to turn it off on a busy line.
    if (String(process.env.LOG_TRANSCRIPT || 'true') !== 'false' && transcript.length) {
      const lines = transcript.map((t) => '    ' + (t.role === 'agent' ? 'AGENT   ' : 'CALLER  ') + t.text);
      clog.info('transcript (' + transcript.length + ' lines):\n' + lines.join('\n'));
    }
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

    // Opt-out is checked before a single word is spoken (PRD §18, §25) — unless
    // the dialer already checked it, before the phone even rang, which is both
    // stricter and faster.
    if (phone && !optOutChecked) {
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

    const greeting = persona.greetingText({ direction, campaign, name: greetingName });
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
    // Exposed so a transport can open the AI session the moment its VAD hears a
    // human, rather than waiting for the transcript. The CRM lookup inside then
    // overlaps the STT round-trip instead of queueing behind it, which takes a
    // whole round-trip off the FIRST reply — the one a caller judges the agent
    // on. Idempotent, so calling it early costs nothing if it is called again.
    engage,
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
