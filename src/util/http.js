/**
 * fetch with retries for transient vendor failures.
 *
 * On a phone call a single 503 is not a failure, it is a hiccup — the customer
 * is mid-sentence and a 300ms retry is invisible to them, whereas giving up
 * ends the call. Gemini returned "This model is currently experiencing high
 * demand" once and the whole conversation was abandoned; that is the case this
 * exists for.
 *
 * Only transient conditions are retried. A 400 (deprecated model, bad speaker
 * name, malformed request) is a real bug and retrying it just wastes the
 * caller's time three times over — those must surface immediately.
 */
const log = require('./log').make('http');

// Retryable: rate limits, gateway and overload errors. Deliberately excludes
// 4xx other than 408/429, which mean WE are wrong.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * @param {string} url
 * @param {Object} opts              passed to fetch
 * @param {Object} [cfg]
 * @param {number} [cfg.attempts]    total tries, including the first
 * @param {number} [cfg.baseDelayMs] first backoff; doubles each retry
 * @param {number} [cfg.timeoutMs]   per-attempt timeout
 * @param {string} [cfg.label]       for the log line
 */
async function retryingFetch(url, opts = {}, cfg = {}) {
  const attempts = cfg.attempts || 3;
  const baseDelay = cfg.baseDelayMs || 250;
  const timeoutMs = cfg.timeoutMs || 15000;
  const label = cfg.label || 'request';

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal });
      clearTimeout(timer);

      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;

      // Retryable status. The body is read here because it is the only chance —
      // the response cannot be read twice, and the caller needs it if we give up.
      const body = await res.text().catch(() => '');
      lastError = new Error(label + ' ' + res.status + ': ' + body.slice(0, 300));
      lastError.status = res.status;
      lastError.body = body;

      if (attempt === attempts) {
        // Hand back a synthetic response so the caller's normal error path runs.
        return new Response(body, { status: res.status, statusText: res.statusText });
      }
      // Honour Retry-After when the vendor sends one; it knows better than we do.
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 3000)
        : baseDelay * 2 ** (attempt - 1);
      log.warn(label + ' ' + res.status + ' — retry ' + attempt + '/' + (attempts - 1) + ' in ' + delay + 'ms');
      await new Promise((r) => setTimeout(r, delay));
    } catch (e) {
      clearTimeout(timer);
      lastError = e.name === 'AbortError'
        ? new Error(label + ' timed out after ' + timeoutMs + 'ms')
        : e;
      if (attempt === attempts) throw lastError;
      const delay = baseDelay * 2 ** (attempt - 1);
      log.warn(label + ' failed (' + lastError.message.slice(0, 80) + ') — retry '
        + attempt + '/' + (attempts - 1) + ' in ' + delay + 'ms');
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError || new Error(label + ' failed');
}

module.exports = { retryingFetch, RETRYABLE_STATUS };
