/**
 * Tool layer — the agent's ONLY way to touch the real world (PRD §14).
 *
 * Two hard rules govern this file:
 *
 * 1. NOTHING HERE DECIDES A COMMERCIAL FACT. Prices, discounts, dispositions and
 *    lead records all come from the CRM. This module shapes arguments, dispatches,
 *    and shapes results back. If you are tempted to compute a price here as a
 *    fallback when the CRM is unreachable, don't — return the failure and let the
 *    agent escalate. That is the behaviour PRD §7 demands.
 *
 * 2. A TOOL NEVER THROWS AT THE MODEL. Every failure comes back as
 *    { ok: false, error, escalate? } so the agent can say "let me get that
 *    confirmed" and hand off, instead of the call dying mid-sentence.
 *
 * Phase 5 adds create_quote, send_whatsapp, create_payment_link,
 * get_payment_status and create_order. They are deliberately NOT registered yet:
 * an unregistered tool cannot be hallucinated into existence, whereas a
 * registered-but-stubbed one will be called and will half-work.
 */
const config = require('../config');
const log = require('../util/log').make('tools');
const crmClient = require('./crmClient');
const localStubs = require('./localStubs');

/**
 * Schemas are terse on purpose. Every word here is resent on every turn of every
 * call, so a chatty description is a line item on the bill.
 */
const DEFINITIONS = [
  {
    name: 'get_customer_context',
    description: 'Look up an existing customer or lead by phone before or during the call. Returns their name, business, status and recent history if Tapify has dealt with them before.',
    parameters: {
      type: 'object',
      properties: { phone: { type: 'string', description: 'Phone number, any format' } },
      required: ['phone'],
    },
  },
  {
    name: 'create_or_update_lead',
    description: 'Save or update what you learned about this business: name, company, city, category, what they need, budget sense, urgency. Call this as soon as you know the business name and category, and again if something important changes.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string' },
        name: { type: 'string', description: 'Contact person name' },
        company: { type: 'string' },
        city: { type: 'string' },
        business_type: { type: 'string', description: 'e.g. restaurant, jeweller, clinic' },
        needs: {
          type: 'array',
          description: 'What they actually need',
          items: {
            type: 'string',
            enum: ['digital_identity', 'google_reviews', 'online_selling', 'online_payments', 'physical_branding', 'customer_engagement', 'promotions'],
          },
        },
        existing_website: { type: 'boolean' },
        urgency: { type: 'string', enum: ['immediate', 'this_week', 'this_month', 'later', 'unknown'] },
        notes: { type: 'string', description: 'Anything a human would want to know before calling them' },
      },
      required: ['phone'],
    },
  },
  {
    name: 'get_product_catalog',
    description: 'What Tapify currently sells, with features and limitations. Use this to recommend and to answer "can it do X?". It returns NO prices — use get_price_quote for any number.',
    parameters: {
      type: 'object',
      properties: {
        needs: { type: 'array', description: 'Optional: narrow to what matches these needs', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'get_price_quote',
    description: 'The ONLY source of a price. Returns a "speakable" sentence you must say verbatim. If it returns ok:false you have no price — tell the customer you will confirm it and offer a callback or a human. Never estimate.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Product or package codes from get_product_catalog',
          items: {
            type: 'object',
            properties: { code: { type: 'string' }, qty: { type: 'number' } },
            required: ['code'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'validate_discount',
    description: 'Check whether a discount is allowed BEFORE you mention it. Offer only what comes back approved. Never reveal the limit itself, and never offer anything if allowed is false.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { code: { type: 'string' }, qty: { type: 'number' } },
            required: ['code'],
          },
        },
        requested_percent: { type: 'number', description: 'Percent the customer is asking for' },
        requested_amount: { type: 'number', description: 'Or the rupee amount they asked to come down by' },
      },
      required: ['items'],
    },
  },
  {
    name: 'schedule_followup',
    description: 'Agree a specific time to call back and record it. Use whenever the customer is busy, wants to think, or asks you to call later.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string' },
        when: { type: 'string', description: 'When to call back, as the customer said it: "tomorrow", "Monday morning", "after 5pm", or a date' },
        reason: { type: 'string' },
        note: { type: 'string', description: 'What the next caller should pick up from' },
      },
      required: ['when'],
    },
  },
  {
    name: 'transfer_to_human',
    description: 'Hand the conversation to a human. Use immediately when the customer asks for one, is angry, raises a complaint or a refund, wants something custom, or when you are not certain Tapify can do what they need.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        urgency: { type: 'string', enum: ['now', 'callback'], description: 'now = connect or call straight back; callback = schedule it' },
        summary: { type: 'string', description: 'What the human needs to know: requirement, objections, anything quoted' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'log_call_outcome',
    description: 'Close the call. EVERY call ends with this, including wrong numbers and instant refusals. Pick exactly one disposition.',
    parameters: {
      type: 'object',
      properties: {
        disposition: {
          type: 'string',
          enum: ['new_lead', 'connected_interested', 'connected_needs_info', 'quote_sent', 'payment_pending', 'order_confirmed', 'followup_scheduled', 'not_interested', 'wrong_number', 'busy_callback', 'human_handoff', 'custom_requirement', 'complaint', 'do_not_contact'],
        },
        summary: { type: 'string', description: 'Two lines: what they need and where it stands' },
        next_action: { type: 'string' },
        opt_out: { type: 'boolean', description: 'True only if they asked not to be contacted again' },
      },
      required: ['disposition', 'summary'],
    },
  },
];

/** snake_case from the model -> the camelCase the CRM speaks. */
function camel(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = camel(v);
  }
  return out;
}

/**
 * Builds a dispatcher bound to one call.
 *
 * @param {Object} ctx
 * @param {string} ctx.callId
 * @param {string} ctx.phone
 * @param {Object} ctx.ledger    cost ledger for this call
 * @param {Function} [ctx.onEvent]  (name, args, result) => void — for the transcript
 */
function createDispatcher(ctx) {
  const backend = config.crm.enabled ? crmClient : localStubs;
  if (!config.crm.enabled) {
    log.warn('CRM_ENABLED=false — tools are answered by in-memory STUBS with FAKE prices. Never judge pricing behaviour from these.');
  }

  /**
   * @returns {Promise<Object>} always an object; { ok: false, error } on failure.
   */
  async function dispatch(name, rawArgs = {}) {
    const started = Date.now();
    const args = camel(rawArgs);
    const handler = backend[name];

    let result;
    if (!handler) {
      // Includes the Phase 5 tools if a model invents them. Naming what IS
      // available lets the agent recover in the same turn.
      result = {
        ok: false,
        error: `Tool "${name}" is not available. Available: ${DEFINITIONS.map((d) => d.name).join(', ')}.`,
      };
    } else {
      try {
        result = await handler({ ...args, phone: args.phone || ctx.phone }, ctx);
        if (result && result.ok === undefined) result = { ok: true, ...result };
      } catch (e) {
        log.error(name, 'failed:', e.message);
        // `escalate` is the signal the pipeline turns into a handoff. A tool the
        // agent depends on being down is a human's problem, not a reason to
        // improvise at the customer.
        result = { ok: false, error: e.message, escalate: true };
      }
    }

    const ms = Date.now() - started;
    log.debug(name, JSON.stringify(args).slice(0, 200), '->', result.ok ? 'ok' : 'FAIL', ms + 'ms');
    if (ctx.ledger) ctx.ledger.toolCall(name, ms, result.ok);
    if (ctx.onEvent) ctx.onEvent(name, args, result, ms);
    return result;
  }

  return dispatch;
}

module.exports = { DEFINITIONS, createDispatcher, camel };
