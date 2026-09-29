/**
 * Synthesises the model's answer WHILE the model is still writing it.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 * A turn used to run strictly in series:
 *
 *     LLM (all of it)  ->  TTS (all of it)  ->  first audio
 *
 * Both legs are slow and neither needs the other to finish. On real calls the
 * model took ~0.8s and Sarvam took ~2.5s for one reply, so the caller sat in
 * silence for the SUM. Sarvam's latency also scales with input length, so one
 * long request was the worst possible shape.
 *
 * Here each completed sentence goes to TTS the moment it exists, and the audio
 * for sentence one is emitted as soon as it comes back — while sentence two is
 * still being synthesised, and while sentence one is still playing. What the
 * caller waits for stops being (LLM + TTS-of-everything) and becomes
 * (LLM-to-first-sentence + TTS-of-that-sentence).
 *
 * ── WHY IT DOES NOT PLAY UNTIL RELEASED ──────────────────────────────────────
 * Audio is synthesised eagerly but held until the engine calls release(). That
 * is not caution for its own sake: this persona emits narration alongside a tool
 * call — "let me check that for you" — and the engine deliberately does not
 * speak it, because three tool rounds once meant three narrations plus the
 * answer, 34 seconds of the agent talking to itself. Playing chunks the instant
 * they existed would bring that straight back.
 *
 * So the pipe disarms the moment a tool call appears and the engine discards
 * what was speculatively synthesised. The waste is bounded — one sentence, and
 * only when the model narrates before reaching for a tool — and it is counted,
 * so it can be seen rather than guessed at.
 *
 * ── ORDERING ─────────────────────────────────────────────────────────────────
 * Chunks are synthesised CONCURRENTLY and emitted STRICTLY IN ORDER: a finished
 * chunk waits in its slot until every chunk before it has been sent.
 *
 * Synthesising them one after another would be simpler, and it would give the
 * same time-to-first-audio — but every later chunk would then pay the full
 * round-trip of every chunk before it, and a reply's second sentence could
 * arrive after the first has finished playing. The caller hears that as the
 * agent stopping mid-thought. Concurrency costs a reorder buffer, which is the
 * `slots` array, and nothing else: the cap keeps a reply to about three chunks,
 * so this is never more than a handful of requests in flight.
 */
const log = require('../util/log').make('speech');

// Below this a chunk is not worth its own round-trip: the per-request overhead
// dominates the audio it produces, and the seam between two very short pieces
// is audible. It also stops "Rs." or "Mr." — a full stop plus a space — from
// being cut off as a sentence of its own.
const MIN_CHUNK_CHARS = Number(process.env.TTS_MIN_CHUNK_CHARS) || 40;

/**
 * Splits text at the last completed sentence.
 *
 * A decimal ("1.5 lakh") is not a boundary because the full stop is followed by
 * a digit, not whitespace. An abbreviation IS matched, which is what
 * MIN_CHUNK_CHARS is there to absorb.
 *
 * @returns {[string, string]} [complete, remainder]
 */
function splitAtSentence(text) {
  const re = /[.!?।]+["')\]]?(?=\s|$)/g;
  let end = 0;
  let m = re.exec(text);
  while (m !== null) {
    end = m.index + m[0].length;
    m = re.exec(text);
  }
  return [text.slice(0, end), text.slice(end)];
}

/**
 * @param {Object} o
 * @param {Function} o.synth       async ({ text }) => { audio, mime, sampleRate, cached }
 * @param {number}   o.maxChars    hard cap on what may be spoken in one turn
 * @param {Function} [o.onFirstAudio]  fired once, when the first chunk comes back
 * @param {Function} [o.isStale]   () => true to abandon (barge-in, call ended)
 */
function create({ synth, maxChars, onFirstAudio, isStale = () => false } = {}) {
  // How much of the model's cumulative text has been handed over. An INDEX into
  // that text, not a copy of it: deriving the offset from the concatenated
  // chunks would drift the moment trimming changed a length, and the drift shows
  // up as a swallowed or repeated word mid-sentence.
  let consumed = 0;
  let fedChars = 0;           // characters actually sent to TTS, for the cap
  let armed = true;           // false once a tool call appears, or we hit the cap
  let disarmReason = null;
  let wastedChars = 0;
  let firstAudioSeen = false;

  // One slot per chunk, in the order the model produced them. A slot is
  // { text, settled, chunk } — `chunk` is null when that piece failed to
  // synthesise, which is skipped rather than allowed to block the queue.
  const slots = [];
  let emitted = 0;            // how many slots have gone to the transport
  let emit = null;            // set by release()
  const played = [];          // what actually reached the transport, in order

  /**
   * Sends every slot that is ready AND has nothing unfinished before it.
   *
   * The `settled` check is what makes concurrency safe: chunk two can finish
   * first and still cannot overtake chunk one, because the loop stops at the
   * first slot that has not resolved.
   */
  function drain() {
    if (!emit) return;
    while (emitted < slots.length && slots[emitted].settled) {
      const slot = slots[emitted];
      emitted += 1;
      if (isStale()) return;
      if (!slot.chunk) continue;      // synthesis failed; the rest still plays
      played.push(slot.chunk);
      emit(slot.chunk);
    }
  }

  /** Queues one chunk for synthesis. Never awaited by the caller. */
  function enqueue(text) {
    const piece = text.trim();
    if (!piece) return;
    fedChars += piece.length;

    const slot = { text: piece, settled: false, chunk: null };
    slots.push(slot);

    slot.promise = (async () => {
      try {
        if (isStale()) return;
        const res = await synth({ text: piece });
        if (isStale()) return;
        if (res && res.audio && res.audio.length) {
          slot.chunk = { text: piece, ...res };
          if (!firstAudioSeen) { firstAudioSeen = true; if (onFirstAudio) onFirstAudio(); }
        }
      } catch (e) {
        // A failed chunk must not take the turn down. The remaining chunks still
        // play, so the caller hears most of the answer rather than none of it.
        log.error('chunk synthesis failed:', e.message);
      } finally {
        slot.settled = true;
        // The whole point: if the engine has already released, this chunk goes
        // out NOW rather than waiting for the rest of the reply to synthesise.
        drain();
      }
    })();
  }

  /** Every chunk queued so far, however it ended. Never rejects. */
  function allSettled() {
    return Promise.all(slots.map((s) => s.promise));
  }

  return {
    /**
     * Feeds the text produced so far. Safe to call on every delta — only newly
     * COMPLETED sentences are acted on.
     */
    push(textSoFar) {
      if (!armed) return;
      const all = String(textSoFar || '');
      const [complete] = splitAtSentence(all.slice(consumed));
      const piece = complete.trim();
      // Nothing finished yet, or too short to be worth its own round-trip. The
      // remainder is not stored: textSoFar is cumulative, so the next push
      // carries it again.
      if (piece.length < MIN_CHUNK_CHARS) return;

      consumed += complete.length;
      enqueue(piece);

      // The cap is enforced here rather than on the finished text, so a model
      // that rambles stops COSTING TTS at the cap instead of being synthesised
      // in full and then trimmed afterwards.
      if (fedChars >= maxChars) this.disarm('spoken cap');
    },

    /** Stops taking new text. Anything already queued still finishes. */
    disarm(reason) {
      if (!armed) return;
      armed = false;
      disarmReason = reason;
    },

    get armed() { return armed; },
    get reason() { return disarmReason; },
    /** Characters handed to TTS so far — what a discard would have wasted. */
    get fedChars() { return fedChars; },

    /**
     * The engine has decided this round is a real answer: play it.
     *
     * Emits what is already synthesised, feeds the trailing fragment, and keeps
     * emitting each remaining chunk as it completes. Resolves once every chunk
     * has been through.
     *
     * The tail matters: a reply's last sentence has no trailing space, and
     * plenty of replies do not end in punctuation at all, so without it the
     * final clause would be synthesised by nobody and the answer would stop
     * mid-thought.
     */
    async release(emitFn, finalText) {
      emit = emitFn;
      drain();

      if (armed && fedChars < maxChars) {
        const all = String(finalText || '');
        const tail = all.slice(consumed).trim();
        if (tail) {
          consumed = all.length;
          enqueue(tail);
        }
      }
      await allSettled();
      drain();
      return played;
    },

    /** Waits for in-flight work without feeding or emitting anything. */
    async settle() {
      await allSettled();
      return slots.filter((s) => s.chunk).map((s) => s.chunk);
    },

    /** Called when the round turned out to be a tool call after all. */
    discard() {
      wastedChars = fedChars;
      this.disarm('discarded');
      emit = null;
      emitted = slots.length;   // nothing further may escape to the transport
      return wastedChars;
    },

    stats() {
      const ok = slots.filter((s) => s.chunk);
      return {
        chunks: ok.length,
        queued: slots.length,
        emitted: played.length,
        fedChars,
        wastedChars,
        cached: ok.filter((s) => s.chunk.cached).length,
      };
    },
  };
}

module.exports = { create, splitAtSentence, MIN_CHUNK_CHARS };
