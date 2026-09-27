/**
 * TTS cache, keyed by content hash.
 *
 * A large share of what a sales agent says is templated — the greeting, "ek minute
 * le sakta hoon?", the objection openers, the closing line, the price-unavailable
 * sentence. Synthesising those again on every call is paying repeatedly for
 * identical audio, and TTS is the second-largest per-minute line item after
 * telephony.
 *
 * Cached on disk, so the saving survives restarts and deploys. The greeting alone
 * is spoken on 100% of dials.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../util/log').make('ttsCache');

const DIR = path.join(__dirname, '..', '..', '.cache', 'tts');
// Anything longer than this is almost certainly per-customer (a name, a price
// read back) and will never be hit again, so caching it only wastes disk.
const MAX_CACHEABLE_CHARS = 300;

let stats = { hits: 0, misses: 0, writes: 0 };

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* already there */ }
}

/**
 * The sample rate is PART OF THE KEY. Without it, a greeting cached at 8 kHz
 * during a browser session gets served into a 16 kHz phone call and plays at
 * half speed — audio that is wrong in a way no error surfaces.
 */
function keyFor({ text, provider, voice, language, format, sampleRate }) {
  return crypto.createHash('sha256')
    .update([
      provider, voice || '', language || '', format || '', String(sampleRate || ''), text,
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Wraps a TTS driver so synth() checks the cache first.
 *
 * Interpolated text (a customer's name, a price) still works — it simply misses,
 * every time, and is not written back once it exceeds MAX_CACHEABLE_CHARS.
 */
function wrap(driver) {
  if (driver.clientSide || driver.textOnly) return driver;   // nothing to cache
  ensureDir();

  return {
    ...driver,

    async synth(opts) {
      const { text } = opts;
      const cacheable = text && text.length <= MAX_CACHEABLE_CHARS;
      if (!cacheable) return driver.synth(opts);

      const key = keyFor({ ...opts, provider: driver.name, voice: opts.voice || '' });
      const file = path.join(DIR, key + '.bin');

      try {
        const audio = fs.readFileSync(file);
        stats.hits += 1;
        log.debug('hit', key, text.slice(0, 40));
        return { audio, mime: driver.mime || 'audio/L16', chars: text.length, cached: true };
      } catch (e) {
        // Miss, or an unreadable cache entry. Either way, synthesise.
      }

      stats.misses += 1;
      const result = await driver.synth(opts);
      if (result && result.audio) {
        try {
          fs.writeFileSync(file, result.audio);
          stats.writes += 1;
        } catch (e) {
          // A full or read-only disk must not break the call.
          log.warn('could not write cache entry:', e.message);
        }
      }
      return { ...result, cached: false };
    },
  };
}

function getStats() {
  const total = stats.hits + stats.misses;
  return { ...stats, hitRate: total ? Math.round((stats.hits / total) * 100) : 0 };
}

/**
 * Pre-synthesises lines that are spoken on every call, at boot rather than
 * mid-call. Makes the first call of a deploy as fast as the thousandth.
 */
async function warm(driver, lines, opts = {}) {
  if (driver.clientSide || driver.textOnly) return 0;
  let n = 0;
  for (const text of lines) {
    try { await driver.synth({ text, ...opts }); n += 1; } catch (e) {
      log.warn('warm-up failed for a line:', e.message);
    }
  }
  log.info('warmed', n, 'cached line(s)');
  return n;
}

module.exports = { wrap, warm, getStats, keyFor, DIR };
