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
function create({ threshold = 0.02, speechMs = 200, silenceMs = 700, frameMs = 20 } = {}) {
  const speechFramesNeeded = Math.max(1, Math.round(speechMs / frameMs));
  const silenceFramesNeeded = Math.max(1, Math.round(silenceMs / frameMs));

  let speechRun = 0;
  let silenceRun = 0;
  let inSpeech = false;
  let everSpoke = false;
  let peak = 0;

  return {
    /**
     * @returns {{speech:boolean, onset:boolean, end:boolean, level:number}}
     *   onset — speech just started (fire barge-in / open the gate here)
     *   end   — the utterance just finished
     */
    push(pcm) {
      const level = rms(pcm);
      if (level > peak) peak = level;
      const loud = level >= threshold;

      let onset = false;
      let end = false;

      if (loud) {
        speechRun += 1;
        silenceRun = 0;
        if (!inSpeech && speechRun >= speechFramesNeeded) {
          inSpeech = true;
          onset = true;
          everSpoke = true;
        }
      } else {
        silenceRun += 1;
        speechRun = 0;
        if (inSpeech && silenceRun >= silenceFramesNeeded) {
          inSpeech = false;
          end = true;
        }
      }

      return { speech: inSpeech, onset, end, level };
    },

    /** True once a human has been heard at all — the connect gate's question. */
    everSpoke() { return everSpoke; },
    peak() { return peak; },

    reset() {
      speechRun = 0; silenceRun = 0; inSpeech = false;
    },
  };
}

module.exports = { create, rms };
