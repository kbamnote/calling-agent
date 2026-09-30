/**
 * Sample-rate conversion for 16-bit little-endian mono PCM.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Rumik's raw PCM is fixed at 24 kHz — there is no sample-rate parameter — and
 * Plivo's stream is 16 kHz. Send 24 kHz samples down a 16 kHz pipe and the voice
 * plays 50% fast and a semitone and a half high: unmistakably wrong, and wrong
 * in a way no error surfaces.
 *
 * ── WHY IT IS STATEFUL ───────────────────────────────────────────────────────
 * A streaming synthesiser hands back audio in chunks, and 24:16 is a 3:2 ratio —
 * so a chunk almost never contains a whole number of output samples. Converting
 * each chunk independently drops the remainder and restarts the read position at
 * zero, which puts a discontinuity at every chunk boundary. On a phone line that
 * is heard as a click every few hundred milliseconds. The leftover samples and
 * the fractional read position therefore carry across calls to push().
 *
 * ── THE QUALITY TRADE ────────────────────────────────────────────────────────
 * This is linear interpolation, not a windowed-sinc filter. Going from 24 kHz to
 * 16 kHz moves the Nyquist limit from 12 kHz to 8 kHz, so anything above 8 kHz
 * folds back as aliasing. Linear interpolation attenuates the top of the band
 * rather than removing it. For speech on a telephone — already band-limited, and
 * with almost no energy above 8 kHz — that is inaudible, and it costs a couple
 * of multiplies per sample instead of a filter bank on the hot path.
 */

/**
 * @param {number} fromRate  the rate the audio arrives at
 * @param {number} toRate    the rate the transport needs
 * @returns {{push: (Buffer) => Buffer, reset: () => void, needed: boolean}}
 */
function create(fromRate, toRate) {
  // Same rate is the common case (every other driver), so it costs nothing.
  if (!fromRate || !toRate || fromRate === toRate) {
    return { push: (buf) => buf, reset: () => {}, needed: false };
  }

  const step = fromRate / toRate;
  let pending = new Int16Array(0);
  // Where in `pending` the next output sample reads from. Fractional, and kept
  // across chunks — this is the whole point of the module.
  let pos = 0;
  // A websocket frame can end in the MIDDLE of a sample. Dropping that odd byte
  // shifts every following byte by one, so the high and low halves of every
  // subsequent sample swap and the audio becomes full-scale noise. It has to be
  // carried into the next chunk.
  let oddByte = null;

  /** Read as int16 one at a time: a Buffer from a socket may start at an odd
   *  byte offset, and a typed-array view over that throws. */
  function toSamples(buf) {
    let src = buf;
    if (oddByte !== null) {
      src = Buffer.concat([oddByte, buf]);
      oddByte = null;
    }
    const n = Math.floor(src.length / 2);
    if (src.length % 2) oddByte = src.subarray(n * 2);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i += 1) out[i] = src.readInt16LE(i * 2);
    return out;
  }

  return {
    needed: true,

    push(buf) {
      if (!buf || !buf.length) return Buffer.alloc(0);

      const incoming = toSamples(buf);
      const merged = new Int16Array(pending.length + incoming.length);
      merged.set(pending, 0);
      merged.set(incoming, pending.length);

      // How many output samples this chunk can produce without reading past the
      // end. The last input sample is held back because interpolation needs the
      // one after it — it arrives in the next chunk.
      const count = merged.length < 2 ? 0 : Math.max(0, Math.ceil((merged.length - 1 - pos) / step));
      const out = Buffer.alloc(count * 2);

      let written = 0;
      while (pos + 1 < merged.length) {
        const i = Math.floor(pos);
        const frac = pos - i;
        const v = merged[i] * (1 - frac) + merged[i + 1] * frac;
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), written * 2);
        written += 1;
        pos += step;
      }

      // Keep only what a later sample might still need, and rebase the position
      // so it cannot grow without bound over a long utterance.
      const consumed = Math.floor(pos);
      pending = merged.slice(consumed);
      pos -= consumed;

      return written * 2 === out.length ? out : out.subarray(0, written * 2);
    },

    /** Between utterances, so one sentence's tail cannot bleed into the next. */
    reset() {
      pending = new Int16Array(0);
      pos = 0;
      oddByte = null;
    },
  };
}

module.exports = { create };
