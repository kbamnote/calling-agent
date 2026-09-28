/**
 * Voice activity detection over 16-bit PCM.
 *
 * ── WHY THIS IS NOT ONE THRESHOLD ────────────────────────────────────────────
 * Energy alone cannot separate line noise at 0.006 from quiet speech at 0.008.
 * Measured on one real phone number, across calls, the noise floor ranged from
 * 0.0026 to 0.046 and speech from 0.008 to 0.27 — the ranges overlap. Any single
 * tuned threshold is therefore wrong on some calls, which is exactly how this
 * behaved before: set low it heard noise everywhere, set high it went deaf.
 *
 * So the detector does not try to answer one question. It answers three, each
 * with the sensitivity its consequences deserve:
 *
 *   speech / onset / end   Permissive. Used to open the STT stream and to cut
 *                          utterances for the transcriber. A false positive
 *                          costs a wasted API call; a false negative costs a
 *                          missed sentence. Adaptive, tuned to be forgiving.
 *
 *   bargeIn                STRICT, and deliberately an ABSOLUTE level. Used only
 *                          to interrupt the agent mid-sentence. A false positive
 *                          here is catastrophic and invisible: it cancels the
 *                          agent's reply, clears the provider's audio buffer,
 *                          and the caller hears nothing at all while the logs
 *                          show a perfectly healthy conversation. That bug cost
 *                          six live calls to find. Missing a real barge-in just
 *                          means the customer waits a second — vastly cheaper.
 *
 * The permissive decision uses two criteria together, which is what makes it
 * robust where a lone threshold was not:
 *   1. absolute-ish — above the learned noise floor by a ratio
 *   2. relative     — a meaningful fraction of the loudest thing heard recently
 * Noise passes (1) on a hissy line but never passes (2), because noise is never
 * a quarter as loud as the speech on the same line.
 *
 * The floor itself is a low PERCENTILE over a rolling window, not a moving
 * average. An average collapses toward zero on lines that carry true digital
 * silence between words, which pins the threshold at its minimum and lets every
 * hiss through — the failure that produced ten false barge-ins in one call.
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
 * @param {number} [o.frameMs]        nominal frame duration
 * @param {number} [o.speechMs]       speech needed to declare onset
 * @param {number} [o.silenceMs]      trailing silence that ends an utterance
 * @param {number} [o.hangoverMs]     dip tolerated while building onset evidence
 * @param {number} [o.minThreshold]   absolute floor for the permissive decision
 * @param {number} [o.noiseRatio]     how far above the noise floor speech must sit
 * @param {number} [o.peakFraction]   fraction of the recent peak speech must reach
 * @param {number} [o.windowMs]       rolling window for the floor percentile
 * @param {number} [o.percentile]     which percentile of the window is "the floor"
 * @param {number} [o.bargeInLevel]   ABSOLUTE level required to interrupt the agent
 * @param {number} [o.bargeInMs]      how long that level must be sustained
 * @param {number} [o.echoGuard]      multiplier on bargeInLevel while the agent
 *                                    is speaking, since the inbound track then
 *                                    carries the agent's own voice back
 * @param {number} [o.maxUtteranceMs] force-close a segment that never ends
 */
function create({
  frameMs = 20,
  speechMs = 200,
  silenceMs = 700,
  hangoverMs = 150,
  minThreshold = 0.004,
  noiseRatio = 5,
  peakFraction = 0.22,
  windowMs = 4000,
  percentile = 0.25,
  bargeInLevel = 0.08,
  bargeInMs = 500,
  echoGuard = 2.0,
  maxUtteranceMs = 15000,
} = {}) {
  const speechFramesNeeded = Math.max(1, Math.round(speechMs / frameMs));
  const silenceFramesNeeded = Math.max(1, Math.round(silenceMs / frameMs));
  const hangoverFrames = Math.max(1, Math.round(hangoverMs / frameMs));
  const bargeInFrames = Math.max(1, Math.round(bargeInMs / frameMs));
  const maxUtteranceFrames = Math.max(1, Math.round(maxUtteranceMs / frameMs));
  const windowFrames = Math.max(10, Math.round(windowMs / frameMs));

  // Rolling window of recent levels, for the floor percentile.
  const window = new Float64Array(windowFrames);
  let windowCount = 0;
  let windowNext = 0;
  let cachedFloor = 0;
  let sinceFloorCalc = 0;

  // Decaying peak. Falls slowly so one loud sentence keeps informing the
  // relative criterion through the quiet parts that follow it.
  let recentPeak = 0;

  let speechRun = 0;
  let silenceRun = 0;
  let quietRun = 0;
  let bargeRun = 0;
  let inSpeech = false;
  let everSpoke = false;
  let peak = 0;
  let loudFrames = 0;
  let maxRun = 0;

  function floorNow() {
    if (windowCount === 0) return 0;
    const sorted = Array.from(window.subarray(0, windowCount)).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))];
  }

  function thresholdNow() {
    // Whichever criterion is STRICTER wins. On a hissy line the relative one
    // binds; on a quiet line with quiet speech the floor one does.
    return Math.max(minThreshold, cachedFloor * noiseRatio, recentPeak * peakFraction);
  }

  return {
    /**
     * @param {Buffer} pcm
     * @param {Object} [ctx]
     * @param {boolean} [ctx.agentSpeaking] true while the agent's audio is
     *   playing. Raises the barge-in bar, because the inbound track then carries
     *   the agent's own voice back through the caller's handset.
     *
     * @returns {{level, speech, onset, end, bargeIn, threshold}}
     */
    push(pcm, ctx = {}) {
      const level = rms(pcm);
      if (level > peak) peak = level;

      window[windowNext] = level;
      windowNext = (windowNext + 1) % windowFrames;
      if (windowCount < windowFrames) windowCount += 1;

      // Recomputing a percentile every frame is wasteful and the floor does not
      // move that fast; every 250ms is plenty.
      sinceFloorCalc += 1;
      if (sinceFloorCalc >= Math.max(1, Math.round(250 / frameMs))) {
        cachedFloor = floorNow();
        sinceFloorCalc = 0;
      }

      recentPeak = level > recentPeak ? level : recentPeak * 0.9995;

      const threshold = thresholdNow();
      const loud = level >= threshold;

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
          // Nobody talks this long without a pause. A segment running past it is
          // a stuck state, not an utterance — close it so the transcriber gets
          // its audio and detection restarts clean.
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
          // Real speech dips below any threshold between syllables and on
          // unvoiced consonants. Resetting the run on the first quiet frame
          // means onset never fires, even at several times the threshold — only
          // a sustained gap should reset it.
          speechRun = 0;
        }
      }

      // ── BARGE-IN ───────────────────────────────────────────────────────────
      // Absolute and strict, and stricter still while the agent is speaking.
      // Nothing adaptive here on purpose: the adaptive path is what let noise
      // masquerade as speech, and the cost of being wrong is the whole call.
      const bargeBar = bargeInLevel * (ctx.agentSpeaking ? echoGuard : 1);
      let bargeIn = false;
      if (level >= bargeBar) {
        bargeRun += 1;
        if (bargeRun === bargeInFrames) bargeIn = true;
      } else {
        bargeRun = 0;
      }

      return { level, speech: inSpeech, onset, end, bargeIn, threshold };
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
        noiseFloor: Number(cachedFloor.toFixed(5)),
        recentPeak: Number(recentPeak.toFixed(4)),
        effective: Number(thresholdNow().toFixed(5)),
        bargeBar: Number(bargeInLevel.toFixed(3)),
      };
    },

    reset() {
      speechRun = 0; silenceRun = 0; quietRun = 0; bargeRun = 0; inSpeech = false;
    },
  };
}

module.exports = { create, rms };
