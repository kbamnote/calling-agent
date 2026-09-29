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
  'speech_end',       // the caller stopped talking (t0)
  'stt_start',        // the transcription request went out
  'transcript',       // STT handed back text  (a.k.a. STT_final)
  'llm_start',        // the model request went out
  'llm_first_token',  // the model began producing the answer
  'llm_done',         // the model finished it
  'tts_start',        // the first chunk was handed to the synthesiser
  'tts_first_audio',  // the first synthesised chunk came back
  'audio_out',        // the first byte reached the transport  <-- what they hear
];

/**
 * The four legs, each measured from where it actually began.
 *
 * Reported separately from the running totals because "LLM at 900ms" and "the
 * LLM took 450ms" are different claims, and only the second one tells you which
 * leg to go and fix.
 */
const LEGS = {
  stt: ['stt_start', 'transcript'],
  llm_first_token: ['llm_start', 'llm_first_token'],
  llm_total: ['llm_start', 'llm_done'],
  tts_first_audio: ['tts_start', 'tts_first_audio'],
};

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

    /**
     * Records a stage. First write wins — `tts_first_audio` must mean FIRST.
     *
     * `at` backdates a stage that happened somewhere we were not watching, such
     * as the STT request going out in the transport before the engine had a
     * clock at all. Without it that leg silently reads as zero.
     */
    mark(name, at) {
      if (!marks.has(name)) marks.set(name, at || Date.now());
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

    /** How long each leg itself took, as opposed to when it finished. */
    legs() {
      const out = {};
      for (const [name, [from, to]] of Object.entries(LEGS)) {
        const a = marks.get(from);
        const b = marks.get(to);
        out[name] = a !== undefined && b !== undefined ? b - a : null;
      }
      // Tool time is accumulated by the engine, which is the only place that
      // knows which calls were blocking and which ran in the background.
      out.tool = extra.toolMs === undefined ? null : extra.toolMs;
      return out;
    },

    /**
     * One line, ordered by when each stage happened, with the headline first so
     * it survives being grepped out of a noisy log.
     */
    line() {
      const total = this.responseMs();
      const l = this.legs();
      // Per-leg durations, not cumulative offsets: this line is read when
      // something is slow, and the first question is always "slow WHERE".
      const parts = [
        'stt ' + (l.stt === null ? '?' : l.stt) + 'ms',
        'llm→1st ' + (l.llm_first_token === null ? '?' : l.llm_first_token) + 'ms',
        'llm ' + (l.llm_total === null ? '?' : l.llm_total) + 'ms',
        'tts→1st ' + (l.tts_first_audio === null ? '?' : l.tts_first_audio) + 'ms',
      ];
      if (l.tool !== null) parts.push('tools ' + l.tool + 'ms');
      for (const [k, v] of Object.entries(extra)) {
        if (k !== 'toolMs') parts.push(k + '=' + v);
      }
      return id + ' reply in ' + (total === null ? 'NEVER SPOKE' : total + 'ms')
        + (estimated ? ' (from transcript, no speech-end mark)' : '')
        + ' [' + parts.join(', ') + ']';
    },

    /** Machine-readable, for the latency harness and any future dashboard. */
    toJSON() {
      const out = {
        id, callId, turn, responseMs: this.responseMs(), estimated, legs: this.legs(), ...extra,
      };
      for (const s of STAGES) out[s] = this.at(s);
      return out;
    },
  };
}

module.exports = { create, STAGES, LEGS };
