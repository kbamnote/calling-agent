/**
 * Energy-based voice activity detection over 16-bit PCM.
 *
 * Deliberately simple — no model, no native dependency. It has two jobs, and
 * neither needs to be clever:
 *
 *   1. THE CONNECT GATE. Do not open the STT or LLM session until a human has
 *      actually spoken. Most dials reach ringing, voicemail or silence, and
 *      opening the AI on those is the single biggest avoidable cost in the system.
 *
 *   2. BARGE-IN. The instant the customer starts talking, stop the agent. A bot
 *      that talks over you is the fastest way to be hung up on.
 *
 * Utterance segmentation is left to the STT vendor where it streams (Deepgram
 * endpointing). For batch vendors (Sarvam) this also closes the utterance, which
 * is why `silenceMs` is configurable.
 */

/** RMS amplitude of a little-endian 16-bit PCM buffer, normalised to 0..1. */
function rms(buf) {
  if (!buf || buf.length < 2) return 0;
  const n = Math.floor(buf.length / 2);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * @param {Object} [o]
 * @param {number} [o.threshold]   RMS above which a frame counts as speech.
 *                                 0.02 suits a phone line; a quiet laptop mic
 *                                 may need 0.01. Too low and line hiss reads as
 *                                 speech, which defeats the connect gate.
 * @param {number} [o.speechMs]    consecutive speech needed to declare onset.
 *                                 Keeps a cough or a click from opening the AI.
 * @param {number} [o.silenceMs]   trailing silence that ends an utterance.
 * @param {number} [o.frameMs]     nominal frame duration for the counters.
 */
function create({
  threshold = 0.02, speechMs = 200, silenceMs = 700, frameMs = 20, hangoverMs = 150,
  adaptive = true, noiseRatio = 5, minThreshold = 0.004, maxUtteranceMs = 15000,
} = {}) {
  const speechFramesNeeded = Math.max(1, Math.round(speechMs / frameMs));
  const silenceFramesNeeded = Math.max(1, Math.round(silenceMs / frameMs));
  // How long a dip below the threshold is tolerated while we are still building
  // evidence of onset.
  const hangoverFrames = Math.max(1, Math.round(hangoverMs / frameMs));
  // Nobody speaks for this long without a pause. A segment that runs past it is
  // a stuck state, not an utterance — close it so the transcriber gets its audio
  // and the detector starts again from a clean slate.
  const maxUtteranceFrames = Math.max(1, Math.round(maxUtteranceMs / frameMs));

  let speechRun = 0;
  let silenceRun = 0;
  let quietRun = 0;
  let inSpeech = false;
  let everSpoke = false;
  let peak = 0;
  let loudFrames = 0;
  let maxRun = 0;
  // Running estimate of the line's own noise, learned from non-speech frames.
  let noiseFloor = null;

  return {
    /**
     * @returns {{speech:boolean, onset:boolean, end:boolean, level:number}}
     *   onset — speech just started (fire barge-in / open the gate here)
     *   end   — the utterance just finished
     */
    push(pcm) {
      const level = rms(pcm);
      if (level > peak) peak = level;

      // ── ADAPTIVE THRESHOLD ───────────────────────────────────────────────
      // Measured across real calls on one number, the noise floor ranged from
      // 0.0026 to 0.046 — a 15x spread depending on handset, network and
      // surroundings. A fixed threshold cannot serve that: set for the noisy
      // call it goes deaf on the quiet one, set for the quiet call it opens the
      // gate on hiss. So learn the floor from the line itself and sit a fixed
      // ratio above it. `adaptive: false` pins it, for tests and for a line
      // whose level is genuinely known.
      //
      // Updated on EVERY frame, including while we believe speech is happening.
      // Gating it on `!inSpeech` deadlocks: a line humming just above the
      // threshold latches inSpeech, the floor then stops learning, and the VAD
      // reports continuous speech for the rest of the call — 383 consecutive
      // "speech" frames on a line that was only buzzing.
      //
      // Falls fast, rises very slowly. So a hum pulls the floor up to meet it
      // within a second or two and stops counting as speech, while a genuine
      // long utterance barely moves it.
      if (adaptive) {
        if (noiseFloor === null) noiseFloor = level;
        else if (level < noiseFloor) noiseFloor = noiseFloor * 0.9 + level * 0.1;
        else noiseFloor = noiseFloor * 0.9995 + level * 0.0005;
      }
      const effective = adaptive
        ? Math.max(minThreshold, Math.min(threshold, (noiseFloor || 0) * noiseRatio))
        : threshold;
      const loud = level >= effective;

      let onset = false;
      let end = false;

      if (loud) {
        speechRun += 1;
        loudFrames += 1;
        if (speechRun > maxRun) maxRun = speechRun;
        silenceRun = 0;
        quietRun = 0;
        if (!inSpeech && speechRun >= speechFramesNeeded) {
          inSpeech = true;
          onset = true;
          everSpoke = true;
        } else if (inSpeech && speechRun >= maxUtteranceFrames) {
          // Force the segment closed. See maxUtteranceFrames above.
          inSpeech = false;
          end = true;
          speechRun = 0;
        }
      } else {
        silenceRun += 1;
        quietRun += 1;
        if (inSpeech) {
          if (silenceRun >= silenceFramesNeeded) {
            inSpeech = false;
            end = true;
          }
        } else if (quietRun > hangoverFrames) {
          // HANGOVER. Real speech dips below the threshold constantly — between
          // syllables, on unvoiced consonants, at the end of a word. Resetting
          // the run on the first quiet frame means the counter never reaches the
          // onset requirement, so a caller talking at four times the threshold
          // still registers as silence. Only a sustained gap resets it.
          speechRun = 0;
        }
      }

      return { speech: inSpeech, onset, end, level };
    },

    /** True once a human has been heard at all — the connect gate's question. */
    everSpoke() { return everSpoke; },
    peak() { return peak; },

    /**
     * Why onset has or has not fired. "Loud frames seen but the longest run was
     * only 4 of the 10 needed" explains a stuck connect gate instantly; a peak
     * level on its own does not.
     */
    stats() {
      return {
        loudFrames,
        maxRun,
        needRun: speechFramesNeeded,
        noiseFloor: noiseFloor === null ? null : Number(noiseFloor.toFixed(5)),
        effective: Number((adaptive
          ? Math.max(minThreshold, Math.min(threshold, (noiseFloor || 0) * noiseRatio))
          : threshold).toFixed(5)),
      };
    },

    reset() {
      speechRun = 0; silenceRun = 0; inSpeech = false;
    },
  };
}

module.exports = { create, rms };
