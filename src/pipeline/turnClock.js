/**
 * Per-turn latency instrument.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * On a phone line, latency IS the product. A turn that takes four seconds is not
 * "a bit slow", it is a caller saying "hello? are you there?" over the top of an
 * answer that was already on its way.
 *
 * The engine used to report one aggregate per turn (llm / tools / tts), which
 * says where the time went but NOT what the customer actually experienced. The
 * number that matters is the one below:
 *
 *     end-of-speech  ->  first audio on the wire
 *
 * That is the silence they sit through, and it starts when they stop talking —
 * not when we finish transcribing them. Everything before `transcript` is ours
 * too (the VAD's trailing-silence window, the STT round-trip), and measuring
 * from the transcript would quietly hide a third of the wait.
 *
 * ── WHAT IS DELIBERATELY NOT RECORDED ────────────────────────────────────────
 * No transcript text, no customer number, no API keys, no tool arguments. This
 * is a stopwatch, not a second transcript — call recordings already live in the
 * CRM behind its own access control, and duplicating conversation content into
 * the application log would put it somewhere nobody is auditing.
 */

/** Marks worth a name of their own, in the order a healthy turn hits them. */
const STAGES = [
  'speech_end',       // the VAD saw the utterance finish (t0)
  'transcript',       // STT handed back text
  'llm_first_token',  // the model began producing the answer
  'llm_done',         // the model finished it
  'tts_first_audio',  // the first synthesised chunk came back
  'audio_out',        // the first byte reached the transport  <-- what they hear
];

/**
 * @param {Object} o
 * @param {string} o.callId
 * @param {number} o.turn                 1-based turn number within the call
 * @param {number} [o.speechEndAt]        ms epoch the caller stopped speaking.
 *   Supplied by the transport, which is the only layer that knows. Defaults to
 *   now, which is right for text transports where there is no speech at all.
 */
function create({ callId, turn, speechEndAt } = {}) {
  const t0 = speechEndAt || Date.now();
  // Correlates every line of one turn across the transport, the engine and the
  // providers. Short on purpose — it is read in a tail, not parsed.
  const id = String(callId || 'call').slice(-6) + '#t' + (turn || 0);
  const marks = new Map();
  const extra = {};

  // A transport that could not tell us when speech ended gets a clock that still
  // works; the report says so rather than quietly reporting from the wrong zero.
  const estimated = !speechEndAt;

  return {
    id,
    t0,
    estimated,

    /** Records a stage. First write wins — `tts_first_audio` must mean FIRST. */
    mark(name) {
      if (!marks.has(name)) marks.set(name, Date.now());
      return this;
    },

    /** Free-form counters that belong on the same line (chunks, rounds, cached). */
    note(key, value) { extra[key] = value; return this; },

    /** ms from end-of-speech to `name`, or null if that stage never happened. */
    at(name) {
      const v = marks.get(name);
      return v === undefined ? null : v - t0;
    },

    /** THE number: end-of-speech to first audio. null if the turn never spoke. */
    responseMs() { return this.at('audio_out'); },

    /**
     * One line, ordered by when each stage happened, with the headline first so
     * it survives being grepped out of a noisy log.
     */
    line() {
      const total = this.responseMs();
      const parts = [];
      for (const s of STAGES) {
        if (s === 'speech_end') continue;
        const v = this.at(s);
        if (v !== null) parts.push(s + ' ' + v + 'ms');
      }
      for (const [k, v] of Object.entries(extra)) parts.push(k + '=' + v);
      return id + ' reply in ' + (total === null ? 'NEVER SPOKE' : total + 'ms')
        + (estimated ? ' (from transcript, no speech-end mark)' : '')
        + ' [' + parts.join(', ') + ']';
    },

    /** Machine-readable, for the latency harness and any future dashboard. */
    toJSON() {
      const out = { id, callId, turn, responseMs: this.responseMs(), estimated, ...extra };
      for (const s of STAGES) out[s] = this.at(s);
      return out;
    },
  };
}

module.exports = { create, STAGES };
