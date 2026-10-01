/**
 * A second voice, for when the first one stops answering.
 *
 * ── THE FAILURE THIS EXISTS FOR ──────────────────────────────────────────────
 * Sarvam returned `402: Credits exhausted` mid-session. Every line this service
 * speaks goes through one TTS driver — the greeting, every reply, and the
 * emergency line that ensureSomethingWasHeard() falls back on. So a billing
 * failure does not degrade the call, it ENDS it: the customer is dialled, the
 * line connects, and nobody ever says anything.
 *
 * A campaign would keep dialling through that, burning telephony credit on
 * calls that cannot speak, and the CRM would record them all as "connected".
 *
 * Slower audio is better than no audio. With TTS_FALLBACK_PROVIDER set, a hard
 * failure on the primary costs the caller some latency instead of the call.
 *
 * ── WHY IT WILL NOT FALL BACK MID-SENTENCE ───────────────────────────────────
 * Once a chunk has reached the transport the caller is already hearing words.
 * Re-synthesising from the top would replay them, so a failure AFTER audio has
 * been emitted is passed straight through — the speech pipe treats it as a
 * failed chunk and moves on, which is the right behaviour: the caller hears a
 * gap, not a stutter.
 */
const log = require('../../util/log').make('tts:fallback');

/**
 * @param {Object} primary   the configured driver
 * @param {Object} fallback  the standby driver, or null to disable
 */
function wrap(primary, fallback) {
  // Nothing to fall back to, or nothing to fall back FROM — the browser and
  // text transports render their own audio and never call synth().
  if (!fallback || !primary || primary.clientSide || primary.textOnly) return primary;
  if (fallback.clientSide || fallback.textOnly) {
    log.warn('TTS_FALLBACK_PROVIDER=' + fallback.name + ' renders client-side and cannot stand in on a phone call — ignoring it.');
    return primary;
  }

  let announced = false;

  return {
    ...primary,
    name: primary.name + ' (fallback: ' + fallback.name + ')',
    // If EITHER can stream, the pipe should offer an onChunk callback; a driver
    // that cannot use it simply returns the whole utterance instead.
    supportsStreamingSynth: Boolean(primary.supportsStreamingSynth || fallback.supportsStreamingSynth),

    async synth(opts) {
      let emitted = false;
      const watched = opts.onChunk
        ? (part) => { emitted = true; opts.onChunk(part); }
        : undefined;

      try {
        return await primary.synth({ ...opts, onChunk: watched });
      } catch (e) {
        if (emitted) throw e;   // already speaking; see the note above

        // Loud the first time, quiet after. A credit outage fails on EVERY
        // utterance, and a screaming log on each one buries the call it is
        // trying to explain.
        if (!announced) {
          announced = true;
          log.error('PRIMARY TTS (' + primary.name + ') FAILED — falling back to '
            + fallback.name + ' for the rest of this process. Reason: ' + e.message.slice(0, 200));
        } else {
          log.warn('primary TTS still failing, using ' + fallback.name);
        }

        return fallback.synth(opts);
      }
    },
  };
}

module.exports = { wrap };
