/**
 * Putting a caller through to a real person.
 *
 * ── HOW PLIVO DOES IT ───────────────────────────────────────────────────────
 * A live call is transferred by POSTing to the call's own URL with a new answer
 * URL for the leg. Plivo fetches that URL and runs whatever XML it returns — so
 * the transfer is two halves: this module asks for it, and the /telephony/dial
 * endpoint answers with the <Dial> that actually rings the person.
 *
 * When they answer, the caller and the staff member are talking directly and
 * the agent is out of the call entirely, which is the point.
 *
 * ── WHEN NOBODY PICKS UP ────────────────────────────────────────────────────
 * The <Dial> carries a <Redirect> after it, so a ring-out comes BACK to the
 * agent rather than dropping the caller. A receptionist whose colleague is busy
 * takes a message; one who hangs up on you is worse than no receptionist.
 */
const config = require('../config');
const log = require('../util/log').make('xfer');

// How long a staff member's phone rings before the caller comes back to the
// agent. Long enough to reach a pocket, short enough that nobody waits.
const RING_SECONDS = Number(process.env.TRANSFER_RING_SECONDS) || 25;

function basicAuth() {
  return 'Basic ' + Buffer.from(config.plivo.authId + ':' + config.plivo.authToken).toString('base64');
}

/**
 * @param {string} callUuid   the LIVE call, from the provider's start event
 * @param {string} toPhone    10 digits
 * @param {string} publicUrl  this service's public origin
 * @param {string} callerId   shown to the staff member — the CUSTOMER's number,
 *   so they can ring back if the line drops. Showing the office number instead
 *   makes every transferred call look identical.
 */
async function transfer({ callUuid, toPhone, publicUrl, callerId }) {
  if (!config.plivo.authId || !config.plivo.authToken) {
    return { ok: false, reason: 'Plivo is not configured' };
  }
  if (!callUuid) return { ok: false, reason: 'no live call to transfer' };

  const dialUrl = publicUrl.replace(/\/$/, '') + '/telephony/dial'
    + '?to=' + encodeURIComponent(toPhone)
    + (callerId ? '&callerId=' + encodeURIComponent(callerId) : '');

  const url = 'https://api.plivo.com/v1/Account/' + config.plivo.authId
    + '/Call/' + encodeURIComponent(callUuid) + '/';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuth() },
    // aleg: the caller's own leg. It is the one we are streaming to, and the
    // one that has to end up talking to a person.
    body: JSON.stringify({ legs: 'aleg', aleg_url: dialUrl, aleg_method: 'GET' }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log.error('transfer refused:', res.status, JSON.stringify(body).slice(0, 200));
    return { ok: false, reason: 'Plivo ' + res.status };
  }
  log.info('transferring ' + callUuid + ' to ' + toPhone);
  return { ok: true };
}

/** The XML Plivo fetches once the transfer is accepted. */
function dialXml({ to, callerId, publicUrl }) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const number = to.length === 10 ? '+91' + to : to;
  // <Redirect> runs when the dial fails or times out, which is how the caller
  // gets back to the agent instead of hearing the line go dead.
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Response>\n'
    + '  <Dial timeout="' + RING_SECONDS + '"'
    + (callerId ? ' callerId="' + esc(callerId.length === 10 ? '+91' + callerId : callerId) + '"' : '')
    + '>\n'
    + '    <Number>' + esc(number) + '</Number>\n'
    + '  </Dial>\n'
    + '  <Redirect>' + esc(publicUrl.replace(/\/$/, '') + '/telephony/answer?campaign=reception&transferFailed=1')
    + '</Redirect>\n'
    + '</Response>';
}

module.exports = { transfer, dialXml, RING_SECONDS };
