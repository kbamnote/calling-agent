/**
 * CRM client — every tool handler, talking to salescrm-pro's /api/agent/*.
 *
 * Auth is the service-key pattern the CRM already uses for its PHP bridge
 * (see backend/src/middleware/serviceAuth.js): a shared secret header proves the
 * caller is this service. It must never reach a browser.
 *
 * Timeouts are short and deliberate. A customer is waiting on the line, so a slow
 * CRM has to become a spoken "let me confirm that" within a couple of seconds
 * rather than dead air. Failing fast is the correct behaviour here.
 */
const config = require('../config');
const log = require('../util/log').make('crm');

const TIMEOUT_MS = 4000;
// The price path gets slightly longer: it is the one call where a retry-free
// failure directly costs a sale.
const PRICE_TIMEOUT_MS = 6000;

async function call(path, { method = 'POST', body, timeout = TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(config.crm.baseUrl + '/api/agent' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': config.crm.serviceKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { error: text.slice(0, 300) }; }

    if (!res.ok) {
      // 422 is the pricing engine refusing — a normal, expected answer that
      // carries a machine-readable `code`, not a transport failure.
      if (res.status === 422) return { ok: false, error: json.error, code: json.code, details: json.details, escalate: true };
      throw new Error('CRM ' + res.status + ': ' + (json.error || text.slice(0, 200)));
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('CRM did not respond in time');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  async get_customer_context({ phone }) {
    const r = await call('/context', { body: { phone } });
    return { ok: true, ...r };
  },

  async create_or_update_lead(args, ctx) {
    const r = await call('/lead', { body: { ...args, callId: ctx.callId, source: 'ai_agent' } });
    return { ok: true, leadId: r.leadId, created: r.created };
  },

  async get_product_catalog({ needs }) {
    const qs = needs && needs.length ? '?needs=' + encodeURIComponent(needs.join(',')) : '';
    const r = await call('/catalog' + qs, { method: 'GET' });
    return { ok: true, items: r.items || r };
  },

  async get_price_quote({ items }, ctx) {
    const r = await call('/price', {
      body: { items, callId: ctx.callId },
      timeout: PRICE_TIMEOUT_MS,
    });
    if (r.ok === false) return r;
    return {
      ok: true,
      // `speakable` is the whole point: the engine formats the number so the
      // agent cannot reformat, round or "simplify" it on the way out.
      speakable: r.speakable,
      grandTotal: r.grandTotal,
      approved: r.approved,
      validUntil: r.validUntil,
    };
  },

  async validate_discount({ items, requestedPercent, requestedAmount }, ctx) {
    const r = await call('/discount/validate', {
      body: { items, requestedPercent, requestedAmount, callId: ctx.callId },
    });
    if (r.ok === false) return r;
    // Only the outcome crosses back. maxAllowedPercent and the rule name stay on
    // the server: PRD §18 forbids putting internal limits in the model's context,
    // and a model that knows the ceiling will eventually recite it.
    return {
      ok: true,
      allowed: r.allowed,
      approvedPercent: r.approvedPercent,
      requiresApproval: r.requiresApproval,
    };
  },

  async schedule_followup(args, ctx) {
    const r = await call('/followup', { body: { ...args, callId: ctx.callId } });
    return { ok: true, followupId: r.followupId, scheduledFor: r.scheduledFor };
  },

  async transfer_to_human(args, ctx) {
    const r = await call('/handoff', { body: { ...args, callId: ctx.callId, phone: args.phone || ctx.phone } });
    return { ok: true, assignedTo: r.assignedTo, mode: r.mode };
  },

  async log_call_outcome(args, ctx) {
    const r = await call('/call/outcome', {
      body: {
        ...args,
        callId: ctx.callId,
        phone: ctx.phone,
        transcript: ctx.transcript ? ctx.transcript() : undefined,
        toolEvents: ctx.toolEvents ? ctx.toolEvents() : undefined,
        cost: ctx.ledger ? ctx.ledger.snapshot() : undefined,
      },
      // The closing write must not be lost to a 4s timeout — it is the record of
      // the entire call.
      timeout: 10000,
    });
    log.info('outcome logged:', args.disposition);
    return { ok: true, callId: r.callId };
  },

  /** Not model-callable: the pipeline checks this itself before dialling. */
  async check_opt_out({ phone }) {
    const r = await call('/optout/check', { body: { phone } });
    return { ok: true, optedOut: Boolean(r.optedOut), reason: r.reason };
  },
};
