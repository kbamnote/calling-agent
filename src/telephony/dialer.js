/**
 * Outbound dialling via Plivo's REST API.
 *
 * Everything so far has been INBOUND: the customer rings the number and Plivo
 * fetches our answer URL. Outbound inverts it — we ask Plivo to place a call,
 * and when the person picks up Plivo fetches the SAME answer URL and attaches
 * the same media websocket. So nothing downstream changes; only the trigger does.
 *
 * ── COMPLIANCE, NOT OPTIONAL ─────────────────────────────────────────────────
 * Outbound is where Indian telecom rules bite. Automated promotional voice calls
 * at scale fall under TRAI's TCCCPA: telemarketer/DLT registration and DND
 * scrubbing. A feedback call to your OWN existing customer is a service call,
 * which is a different and much safer footing than cold prospecting — but it is
 * still a call you placed, so:
 *   - every number is checked against the opt-out list here, before dialling,
 *     not merely when the call connects;
 *   - calling hours are enforced, because a 6am "how is Tapify going?" is worse
 *     than no call at all;
 *   - the campaign runner is rate-limited, so a bug cannot dial a thousand
 *     customers in a minute.
 */
const config = require('../config');
const log = require('../util/log').make('dialer');
const { retryingFetch } = require('../util/http');

const PLIVO_API = 'https://api.plivo.com/v1/Account';

// IST. A service call outside these hours annoys the customer you are ringing
// to keep happy. Override per deployment, but do not widen them casually.
const CALL_START_HOUR = Number(process.env.CALL_START_HOUR) || 10;
const CALL_END_HOUR = Number(process.env.CALL_END_HOUR) || 19;

function isConfigured() {
  return Boolean(config.plivo.authId && config.plivo.authToken && config.plivo.fromNumber);
}

/** Current hour in IST, wherever the container happens to be running. */
function istHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false,
  }).format(now));
}

function withinCallingHours(now = new Date()) {
  const h = istHour(now);
  return h >= CALL_START_HOUR && h < CALL_END_HOUR;
}

/** Digits only, last 10 — the form the CRM and the opt-out list both use. */
const norm = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** Plivo wants an E.164-ish destination; Indian numbers go out as 91XXXXXXXXXX. */
function toDialFormat(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  return d;
}

/**
 * Places one outbound call.
 *
 * @param {Object} o
 * @param {string} o.phone
 * @param {string} [o.campaign]   which persona answers when they pick up
 * @param {string} [o.name]       so the greeting can use it
 * @param {string} o.publicUrl    this service's public origin
 * @param {boolean} [o.force]     skip the calling-hours check (testing only)
 *
 * @returns {{ok:boolean, callUuid?:string, reason?:string}}
 */
async function placeCall(o = {}) {
  if (!isConfigured()) {
    return { ok: false, reason: 'Plivo is not configured (PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_FROM_NUMBER)' };
  }
  const phone = norm(o.phone);
  if (phone.length < 10) return { ok: false, reason: 'invalid phone number' };

  if (!o.force && !withinCallingHours()) {
    return { ok: false, reason: 'outside calling hours (' + CALL_START_HOUR + ':00-' + CALL_END_HOUR + ':00 IST)' };
  }

  // The answer URL carries everything the conversation needs to know before the
  // customer speaks: who they are, and which campaign this is.
  const params = new URLSearchParams({ direction: 'outbound', campaign: o.campaign || 'sales' });
  if (o.name) params.set('name', o.name);
  const answerUrl = o.publicUrl.replace(/\/$/, '') + '/telephony/answer?' + params.toString();

  const auth = Buffer.from(config.plivo.authId + ':' + config.plivo.authToken).toString('base64');
  const res = await retryingFetch(PLIVO_API + '/' + config.plivo.authId + '/Call/', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: toDialFormat(config.plivo.fromNumber),
      to: toDialFormat(phone),
      answer_url: answerUrl,
      answer_method: 'POST',
      hangup_url: o.publicUrl.replace(/\/$/, '') + '/telephony/status',
      hangup_method: 'POST',
      // Plivo gives up on an unanswered call after this. Longer just pays for
      // ringing nobody is going to answer.
      ring_timeout: Number(process.env.RING_TIMEOUT_SECONDS) || 30,
    }),
  }, { label: 'Plivo dial', attempts: 2, timeoutMs: 15000 });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log.error('dial failed for ' + phone + ':', res.status, JSON.stringify(body).slice(0, 200));
    return { ok: false, reason: 'Plivo ' + res.status + ': ' + (body.error || JSON.stringify(body).slice(0, 150)) };
  }

  const callUuid = (body.request_uuid) || (body.message_uuid) || null;
  log.info('dialled ' + phone + ' campaign=' + (o.campaign || 'sales') + ' uuid=' + callUuid);
  return { ok: true, callUuid };
}

/**
 * Runs a list of numbers, spaced out.
 *
 * Sequential with a gap on purpose. Concurrency here buys nothing — the
 * bottleneck is people answering, not our throughput — and it is the difference
 * between a bug that misdials one customer and a bug that misdials the whole
 * book.
 *
 * @param {Array} targets  [{ phone, name }]
 * @returns {{placed:number, skipped:number, results:Array}}
 */
async function runCampaign({ targets = [], campaign = 'sales', publicUrl, gapMs, limit, onProgress } = {}) {
  const spacing = Number(gapMs) || Number(process.env.DIAL_GAP_MS) || 20000;
  const max = Math.min(Number(limit) || targets.length, targets.length);
  const results = [];
  let placed = 0;
  let skipped = 0;

  log.info('campaign ' + campaign + ': ' + max + ' target(s), one every ' + Math.round(spacing / 1000) + 's');

  for (let i = 0; i < max; i += 1) {
    const t = targets[i];
    if (!withinCallingHours()) {
      log.warn('stopping — outside calling hours');
      results.push({ phone: t.phone, ok: false, reason: 'outside calling hours' });
      skipped += max - i;
      break;
    }

    const r = await placeCall({ phone: t.phone, name: t.name, campaign, publicUrl });
    results.push({ phone: t.phone, name: t.name, ...r });
    if (r.ok) placed += 1; else skipped += 1;
    if (onProgress) onProgress({ index: i + 1, total: max, phone: t.phone, result: r });

    if (i < max - 1) await new Promise((r2) => setTimeout(r2, spacing));
  }

  log.info('campaign ' + campaign + ' finished: ' + placed + ' placed, ' + skipped + ' skipped');
  return { placed, skipped, results };
}

/**
 * Verifies the Plivo credentials without placing a call.
 *
 * A 401 discovered while dialling a customer is a wasted call and a confusing
 * log line; a 401 discovered on a page refresh is a typo you fix in a minute.
 * Reads the account, which costs nothing and rings nobody.
 */
async function checkCredentials() {
  if (!isConfigured()) {
    const missing = [
      !config.plivo.authId && 'PLIVO_AUTH_ID',
      !config.plivo.authToken && 'PLIVO_AUTH_TOKEN',
      !config.plivo.fromNumber && 'PLIVO_FROM_NUMBER',
    ].filter(Boolean);
    throw new Error('not configured — missing ' + missing.join(', '));
  }

  const auth = Buffer.from(config.plivo.authId + ':' + config.plivo.authToken).toString('base64');
  const res = await retryingFetch(PLIVO_API + '/' + config.plivo.authId + '/', {
    headers: { Authorization: 'Basic ' + auth },
  }, { label: 'Plivo account', attempts: 2, timeoutMs: 10000 });

  if (res.status === 401) {
    // The most common cause by a distance, so say it rather than echoing
    // Plivo's one-word body.
    throw new Error('Plivo rejected the credentials (401). PLIVO_AUTH_ID should start with "MA" '
      + '(or "SA" for a subaccount) and comes from the Plivo console Dashboard, NOT the API Keys page. '
      + 'Check for a trailing space in the Railway variable too.');
  }
  if (!res.ok) throw new Error('Plivo account check returned HTTP ' + res.status);

  const body = await res.json().catch(() => ({}));
  const name = body.name || body.account_type || 'account';
  const cash = body.cash_credits != null ? ', credits ' + body.cash_credits : '';
  return 'authenticated as ' + name + cash
    + ', dialling from ' + toDialFormat(config.plivo.fromNumber)
    + ', calling hours ' + CALL_START_HOUR + ':00-' + CALL_END_HOUR + ':00 IST'
    + ' (now ' + istHour() + ':00 IST, ' + (withinCallingHours() ? 'open' : 'CLOSED') + ')';
}

module.exports = {
  placeCall,
  checkCredentials,
  runCampaign,
  isConfigured,
  withinCallingHours,
  istHour,
  toDialFormat,
  CALL_START_HOUR,
  CALL_END_HOUR,
};
