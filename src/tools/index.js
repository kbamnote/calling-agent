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
    description: 'Look up this caller in the CRM: name, business, status, recent history.',
    parameters: {
      type: 'object',
      properties: { phone: { type: 'string', description: 'Phone number' } },
      required: ['phone'],
    },
  },
  {
    name: 'create_or_update_lead',
    description: 'Save what you learned about this business. Call as soon as you know the name and category, and again when something important changes.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string' },
        name: { type: 'string', description: 'Contact person' },
        company: { type: 'string' },
        city: { type: 'string' },
        business_type: { type: 'string', description: 'e.g. restaurant, jeweller' },
        needs: {
          type: 'array',
          description: 'What they need',
          items: {
            type: 'string',
            enum: ['digital_identity', 'google_reviews', 'online_selling', 'online_payments', 'physical_branding', 'customer_engagement', 'promotions'],
          },
        },
        existing_website: { type: 'boolean' },
        urgency: { type: 'string', enum: ['immediate', 'this_week', 'this_month', 'later', 'unknown'] },
        notes: { type: 'string', description: 'Notes for the next human caller' },
      },
      required: ['phone'],
    },
  },
  {
    name: 'get_product_catalog',
    description: 'What Tapify sells, with features and limitations. Returns NO prices.',
    parameters: {
      type: 'object',
      properties: {
        needs: { type: 'array', description: 'Narrow to these needs', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'get_price_quote',
    description: 'The ONLY source of a price. Say its "speakable" verbatim. ok:false means you have NO price: offer to confirm, never estimate.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Codes from get_product_catalog',
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
    description: 'Check a discount BEFORE mentioning it. Offer only what is approved. Never reveal that a limit exists.',
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
        requested_percent: { type: 'number', description: 'Percent asked for' },
        requested_amount: { type: 'number', description: 'Or the rupee amount' },
      },
      required: ['items'],
    },
  },
  {
    name: 'schedule_followup',
    description: 'Record an agreed callback time. Use when they are busy, want to think, or ask you to call later.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string' },
        when: { type: 'string', description: 'As they said it: "kal subah", "after 5pm", a date' },
        reason: { type: 'string' },
        note: { type: 'string', description: 'What to pick up from' },
      },
      required: ['when'],
    },
  },
  {
    name: 'transfer_to_human',
    description: 'Hand off to a human: they ask, they are angry, a complaint or refund, anything custom, or you are unsure Tapify can do it.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        urgency: { type: 'string', enum: ['now', 'callback'], description: 'now = connect straight away' },
        summary: { type: 'string', description: 'Requirement, objections, anything quoted' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'log_call_outcome',
    description: 'Close the call. EVERY call ends with this. Pick one disposition.',
    parameters: {
      type: 'object',
      properties: {
        disposition: {
          type: 'string',
          enum: ['new_lead', 'connected_interested', 'connected_needs_info', 'quote_sent', 'payment_pending', 'order_confirmed', 'followup_scheduled', 'not_interested', 'wrong_number', 'busy_callback', 'human_handoff', 'custom_requirement', 'complaint', 'do_not_contact'],
        },
        summary: { type: 'string', description: 'What they need and where it stands' },
        next_action: { type: 'string' },
        opt_out: { type: 'boolean', description: 'Only if they asked never to be called again' },
      },
      required: ['disposition', 'summary'],
    },
  },
  {
    name: 'get_client_status',
    description: 'What this Tapify customer owns, whether they installed the app, what their card has actually done for them, and what they have never used. Call this FIRST on a feedback call.',
    parameters: {
      type: 'object',
      properties: { phone: { type: 'string' } },
    },
  },
  {
    name: 'log_client_feedback',
    description: 'Record what they said, whether they want the WhatsApp details, and any feature they asked for.',
    parameters: {
      type: 'object',
      properties: {
        using_app: { type: 'boolean', description: 'Have they installed and used the app' },
        not_using_reason: { type: 'string', description: 'In their words, why not' },
        satisfaction: { type: 'string', enum: ['happy', 'neutral', 'unhappy'] },
        feedback: { type: 'string', description: 'What they actually said, briefly' },
        wants_whatsapp_info: { type: 'boolean', description: 'They agreed to be sent the app link and new-feature details on WhatsApp' },
        feature_request: { type: 'string', description: 'The one feature they said would be most useful for their business' },
      },
    },
  },
  {
    name: 'send_whatsapp_details',
    description: 'Send the app link and details on WhatsApp. Call it the moment they agree. Goes out while you speak — say you ARE sending it.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Only the feature they asked about, a few words. The links are already in the message, so "app download link" is wrong.',
        },
      },
    },
  },
  {
    name: 'raise_client_query',
    description: 'Anything you could not answer, anything broken, any billing question. Goes to their account manager. Never guess instead.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What they asked, in their words' },
        context: { type: 'string', description: 'Anything that helps whoever picks this up' },
        urgent: { type: 'boolean', description: 'True for billing, refunds, or an angry customer' },
      },
      required: ['question'],
    },
  },
];

/**
 * Which tools each campaign gets.
 *
 * Scoped deliberately rather than handing every tool to every call. A
 * customer-success call has no business quoting a price — the customer already
 * bought, and a tool the model cannot see is a tool it cannot be talked into
 * using. It also keeps the schema block (resent on every turn) smaller.
 */
const CAMPAIGN_TOOLS = {
  sales: [
    'get_customer_context', 'create_or_update_lead', 'get_product_catalog',
    'get_price_quote', 'validate_discount', 'schedule_followup',
    'transfer_to_human', 'log_call_outcome',
  ],
  // get_client_status is deliberately ABSENT. The engine fetches it once, in
  // engage(), and builds the customer's record straight into the system prompt
  // under "This call" — so offering it as a tool bought nothing and cost a
  // great deal: the model called it on turn one anyway, which meant a second
  // LLM round before it could speak, a CRM round-trip in front of the first
  // reply, the tool's schema in every request, and its whole JSON result
  // sitting in the history for the rest of the call. On a Groq free tier that
  // is a meaningful share of the token budget the call died on.
  client_feedback: [
    'log_client_feedback', 'raise_client_query', 'send_whatsapp_details',
    'schedule_followup', 'transfer_to_human', 'log_call_outcome',
  ],
};

/**
 * Tools whose RESULT the agent needs before it can say anything useful.
 *
 * Everything not listed here is a write — the agent already knows what it is
 * about to say, and the CRM round-trip only decides whether a row landed. Making
 * the customer listen to silence while that happens is the difference between
 * an agent that answers in a second and one that answers in three:
 *
 *   customer: "Google Business connect nahi ho raha hai mera."
 *   agent:    "Achha Namdev ji, samajh gaya..."   <- spoken NOW
 *             raise_client_query + log_client_feedback run while it plays
 *
 * Getting this list wrong in the safe direction (calling something blocking
 * when it need not be) costs latency. Getting it wrong the other way makes the
 * agent speak before it knows a price or a customer's history, which is the one
 * failure this whole service is built to prevent — so a tool is blocking unless
 * there is a clear reason it is not.
 */
const BLOCKING_TOOLS = new Set([
  // Reads. The answer IS the tool result.
  'get_customer_context',
  'get_client_status',
  'get_product_catalog',
  'get_price_quote',
  'validate_discount',
  // Terminal. These end the call, so nothing may overtake them.
  'transfer_to_human',
  'log_call_outcome',
]);

/**
 * Writes that may run while the agent is already speaking.
 *
 * All three are idempotent-by-construction on the CRM side (the lead upsert is
 * keyed on the phone number; feedback and queries are appended per call), and
 * the engine's identical-call guard stops a looping model firing the same one
 * twice within a turn. A failure here is logged and must never interrupt the
 * conversation — a dropped note is worth less than a dropped customer.
 */
function isBlocking(name) {
  return BLOCKING_TOOLS.has(name);
}

/** The tool definitions a campaign may use. Unknown campaign falls back to sales. */
/**
 * Lets an OPTIONAL parameter be null, which is what models actually send.
 *
 * A live call died on this. The model called log_client_feedback with
 * `not_using_reason: null` — a sensible thing to send for "they ARE using it" —
 * and Groq rejected the whole generation:
 *
 *   tool call validation failed: `/not_using_reason`: expected string, but got null
 *
 * The engine saw an empty reply, retried, got the same 400, and fell back to
 * "Sorry sir, aapki baat thodi clear nahi aayi" — asking a customer who had
 * just said "haan theek hai bhej dijiye" to repeat themselves. The caller hears
 * an agent that cannot follow a plain yes.
 *
 * A field that is not in `required` is one the model may legitimately have
 * nothing for, so the schema now says so. Applied to every tool rather than the
 * one that happened to fail, because the next model will pick a different field.
 */
function allowNulls(def) {
  const props = (def.parameters && def.parameters.properties) || {};
  const required = new Set((def.parameters && def.parameters.required) || []);
  const widened = {};

  for (const [name, spec] of Object.entries(props)) {
    if (required.has(name) || !spec || Array.isArray(spec.type) || !spec.type) {
      widened[name] = spec;
      continue;
    }
    widened[name] = { ...spec, type: [spec.type, 'null'] };
  }
  return { ...def, parameters: { ...def.parameters, properties: widened } };
}

function definitionsFor(campaign) {
  const allowed = CAMPAIGN_TOOLS[campaign] || CAMPAIGN_TOOLS.sales;
  return DEFINITIONS.filter((d) => allowed.includes(d.name)).map(allowNulls);
}

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
        error: `Tool "${name}" is not available on this call. Available: `
          + definitionsFor(ctx.campaign).map((d) => d.name).join(', ') + '.',
      };
    } else {
      try {
        // The CALL's number always wins over whatever the model supplied.
        // Models hand back placeholders here — "unknown", the business name, a
        // half-remembered number — and the CRM then rejects the lookup with
        // "phone is required", so the agent loses the customer's history and
        // falls back to escalating. The number we are actually connected to is
        // never in doubt, so only trust the model's value if ours is missing.
        const digits = (v) => String(v || '').replace(/\D/g, '');
        const phone = digits(ctx.phone).length >= 10
          ? ctx.phone
          : (digits(args.phone).length >= 10 ? args.phone : ctx.phone);
        result = await handler({ ...args, phone }, ctx);
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

module.exports = {
  DEFINITIONS, definitionsFor, CAMPAIGN_TOOLS, createDispatcher, camel, isBlocking, BLOCKING_TOOLS,
};
