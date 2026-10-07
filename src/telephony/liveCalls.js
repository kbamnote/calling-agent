/**
 * How many phone calls are up right now.
 *
 * The campaign runner used to pace itself on a timer — one dial every
 * DIAL_GAP_MS, whether or not the previous call had ended. With calls running a
 * 68s median and 153s at the tail, a 20s gap quietly produced three to five
 * SIMULTANEOUS calls. Nobody chose that number; it fell out of the arithmetic.
 *
 * It matters because the TTS provider caps CONCURRENT REQUESTS per account, not
 * requests per minute, and one call uses up to three of them while it speaks.
 * Four concurrent requests is one call. Exceeding it does not queue — synthesis
 * fails mid-sentence and the caller gets silence.
 *
 * So the limit is counted, not estimated: a live call is an open media socket.
 */
const log = require('../util/log').make('live');

let open = 0;
let peak = 0;

function opened() {
  open += 1;
  if (open > peak) peak = open;
  return open;
}

function closed() {
  open = Math.max(0, open - 1);
  return open;
}

function count() { return open; }
function peakSeen() { return peak; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until fewer than `max` calls are live.
 *
 * `graceMs` comes first and is not optional: a number that has just been dialled
 * has no socket yet — the phone is still ringing — so checking the count
 * immediately would read zero and dial again straight away. The grace period is
 * how long a ringing phone is allowed to count as a call.
 *
 * Returns false if it gave up waiting, so the caller can decide; it never throws
 * and never blocks for ever.
 */
async function waitForSlot(max, { graceMs = 15000, timeoutMs = 360000, pollMs = 1000 } = {}) {
  if (max <= 0) return true;
  await sleep(graceMs);

  const until = Date.now() + timeoutMs;
  while (open >= max) {
    if (Date.now() > until) {
      log.warn('still ' + open + ' call(s) live after ' + Math.round(timeoutMs / 1000)
        + 's — carrying on rather than stalling the campaign');
      return false;
    }
    await sleep(pollMs);
  }
  return true;
}

module.exports = { opened, closed, count, peakSeen, waitForSlot };
