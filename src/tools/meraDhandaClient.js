/**
 * The MeraDhanda side of the receptionist.
 *
 * A separate client from tools/crmClient.js on purpose: that one talks to the
 * Tapify sales CRM about Tapify's customers, this one talks to a print shop's
 * own system about their jobs. Same agent, two different businesses, and
 * nothing either of them knows should leak into the other's calls.
 *
 * Authenticated by a MeraDhanda API key, which carries the tenant — so the
 * number that was dialled decides whose jobs the agent can see, and it cannot
 * be talked into looking at anybody else's.
 */
const config = require('../config');
const log = require('../util/log').make('md');

const TIMEOUT_MS = Number(process.env.MERADHANDA_TIMEOUT_MS) || 6000;

function configured() {
  return Boolean(config.meraDhanda.baseUrl && config.meraDhanda.apiKey);
}

async function call(path) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(config.meraDhanda.baseUrl + '/api/v1/reception' + path, {
      headers: { Authorization: 'Bearer ' + config.meraDhanda.apiKey },
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('MeraDhanda ' + res.status + ': ' + text.slice(0, 160));
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Who is ringing and what their jobs are doing.
 *
 * Never throws: a receptionist whose computer is down still answers the phone
 * and still takes a message. An unknown caller and an unreachable system look
 * the same from the agent's side, which is the right amount of difference.
 */
async function caller(phone) {
  if (!configured()) return { known: false, jobs: [] };
  try {
    return await call('/caller?phone=' + encodeURIComponent(phone));
  } catch (e) {
    log.warn('caller lookup failed:', e.message);
    return { known: false, jobs: [], unavailable: true };
  }
}

/**
 * Who the agent may offer to put a caller through to.
 *
 * Only people with a mobile on their MeraDhanda user record — offering to
 * connect somebody and then having no number to ring is worse than not
 * offering. Adding a person is adding their number there, not a deploy here.
 */
async function staff() {
  if (!configured()) return [];
  try {
    const r = await call('/staff');
    return (r && r.staff) || [];
  } catch (e) {
    log.warn('staff directory failed:', e.message);
    return [];
  }
}

/**
 * The person a caller just asked for, by the name they said.
 *
 * Four outcomes, because they are four different sentences on a phone call:
 * found (a number to ring), ambiguous (ask which one), not_found, no_number.
 */
async function lookup(name) {
  if (!configured()) return { status: 'not_found' };
  try {
    return await call('/lookup?name=' + encodeURIComponent(name));
  } catch (e) {
    log.warn('staff lookup failed:', e.message);
    return { status: 'not_found', unavailable: true };
  }
}

/** Files what the caller wanted as a task somebody will see. */
async function message(body) {
  if (!configured()) return { ok: false };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(config.meraDhanda.baseUrl + '/api/v1/reception/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.meraDhanda.apiKey,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('MeraDhanda ' + res.status + ': ' + text.slice(0, 160));
    return JSON.parse(text);
  } catch (e) {
    // The caller was told their message would be passed on. If this failed,
    // the call log is the only record — so say so loudly rather than returning
    // a quiet false that reads like "nobody wanted anything".
    log.error('MESSAGE NOT SAVED:', e.message);
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { caller, staff, lookup, message, configured };
