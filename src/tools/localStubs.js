/**
 * In-memory tool backend for local testing — CRM_ENABLED=false.
 *
 * ⚠ EVERY PRICE IN THIS FILE IS FAKE. They are deliberately flat, obviously-round
 * placeholder numbers, not Tapify's prices and not a guess at them. They exist so
 * the conversation can reach the price stage while the real catalogue is still
 * unpriced (see salescrm-pro/AI_SALES_AGENT.md — the seed ships priceless on
 * purpose). Never judge pricing behaviour, margins or discount policy from these,
 * and never copy them into the real catalogue.
 *
 * Everything written here lives in a Map and dies with the process. `_stub: true`
 * is stamped on every result so a confused transcript is traceable to this file.
 */
const log = require('../util/log').make('stubs');

// Placeholder rupee figures. Fake. See the warning above.
const STUB_CATALOG = [
  {
    code: 'NFC_CARD', name: 'NFC Business Card', type: 'product', unit: 'piece',
    pitch: 'A premium business card that shares your full business profile on a tap.',
    features: ['Tap to share on Android and iPhone', 'Printed QR fallback', 'Profile editable any time'],
    limitations: ['Needs an internet connection to open the profile'],
    needs: ['digital_identity'], stubPrice: 1500,
  },
  {
    code: 'REVIEW_CARD', name: 'Smart AI Google Review Card', type: 'product', unit: 'piece',
    pitch: 'Customers tap and land straight on your Google review box, with the words already drafted.',
    features: ['One tap to the Google review screen', 'AI-suggested review text', 'Review tracking'],
    limitations: ['Needs a verified Google Business Profile', 'Google decides whether a review is published'],
    needs: ['google_reviews'], stubPrice: 2000,
  },
  {
    code: 'NFC_STANDEE', name: 'QR + NFC Acrylic Standee', type: 'product', unit: 'piece',
    pitch: 'A counter standee customers tap while they are still in front of you.',
    features: ['Acrylic counter build', 'NFC and printed QR', 'Points at reviews, profile or store'],
    limitations: ['Indoor counter use only'],
    needs: ['google_reviews', 'physical_branding'], stubPrice: 2500,
  },
  {
    code: 'ECOM_SITE', name: 'Full E-commerce Website', type: 'product', unit: 'site',
    pitch: 'A complete online store with your own catalogue, cart, checkout and order management.',
    features: ['Product catalogue', 'Cart and checkout', 'Order management', 'Mobile-first design'],
    limitations: ['Content supplied by the business during onboarding', 'Custom integrations quoted separately'],
    needs: ['online_selling', 'customer_engagement'], stubPrice: 25000,
  },
  {
    code: 'PAY_GATEWAY', name: 'Payment Gateway Setup', type: 'product', unit: 'site',
    pitch: 'Take online payments — UPI, cards, netbanking — into your own account.',
    features: ['UPI, cards, netbanking', 'Settles to the business account'],
    limitations: ['Business must complete the provider KYC', 'Provider sets the transaction charges'],
    needs: ['online_payments'], stubPrice: 5000,
  },
  {
    code: 'PKG_KIT', name: 'Tapify Kit', type: 'package', unit: 'set',
    pitch: 'The complete tap-to-share kit: business card, review card, keyring, standee and NFC tags.',
    features: ['All five kit items', 'Tapify digital profile', 'Google review flow'],
    limitations: ['No e-commerce website or payment gateway'],
    needs: ['digital_identity', 'google_reviews', 'physical_branding'], stubPrice: 8000,
  },
  {
    code: 'PKG_BUSINESS', name: 'Tapify Business', type: 'package', unit: 'set',
    pitch: 'The Tapify Kit plus a full e-commerce website.',
    features: ['Everything in the Tapify Kit', 'Full e-commerce website', 'Order management'],
    limitations: ['Payment gateway quoted separately'],
    needs: ['digital_identity', 'google_reviews', 'online_selling'], stubPrice: 30000,
  },
  {
    code: 'PKG_COMPLETE', name: 'Tapify Complete', type: 'package', unit: 'set',
    pitch: 'Everything: the kit, the website, online payments and your digital presence set up for you.',
    features: ['Everything in Tapify Business', 'Online payments', 'Google / Instagram / Facebook setup'],
    limitations: ['Third-party and gateway charges not included'],
    needs: ['digital_identity', 'google_reviews', 'online_selling', 'online_payments'], stubPrice: 40000,
  },
  // Present precisely so the NO-PRICE path can be tested. Leave it priceless.
  {
    code: 'CUSTOM_INTEGRATION', name: 'Custom Integration', type: 'product', unit: 'set',
    pitch: 'Custom development and third-party integrations.',
    features: [], limitations: ['Scoped and quoted by a human'],
    needs: [], stubPrice: null, quotable: false,
  },
];

const GST = 18;
const leads = new Map();
const followups = [];
const outcomes = [];
const optOuts = new Set();

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const norm = (p) => String(p || '').replace(/\D/g, '').slice(-10);

module.exports = {
  async get_customer_context({ phone }) {
    const lead = leads.get(norm(phone));
    if (!lead) return { ok: true, known: false, _stub: true };
    return {
      ok: true,
      known: true,
      name: lead.name,
      company: lead.company,
      city: lead.city,
      status: lead.status || 'new',
      history: lead.history || [],
      _stub: true,
    };
  },

  async create_or_update_lead(args) {
    const key = norm(args.phone);
    const existing = leads.get(key) || { history: [] };
    const lead = { ...existing, ...args, phone: key, updatedAt: new Date() };
    leads.set(key, lead);
    log.info('lead saved:', key, lead.company || lead.name || '(unnamed)', lead.needs || []);
    return { ok: true, leadId: 'stub_' + key, created: !existing.updatedAt, _stub: true };
  },

  async get_product_catalog({ needs }) {
    let items = STUB_CATALOG;
    if (needs && needs.length) {
      const wanted = new Set(needs);
      const matched = items.filter((i) => i.needs.some((n) => wanted.has(n)));
      if (matched.length) items = matched;
    }
    // Prices are stripped, exactly as the real /api/catalog/for-agent strips
    // them — the agent must not be able to read a number off the catalogue.
    return {
      ok: true,
      items: items.map(({ stubPrice, ...rest }) => ({ ...rest, quotable: rest.quotable !== false })),
      _stub: true,
    };
  },

  async get_price_quote({ items }) {
    if (!Array.isArray(items) || !items.length) return { ok: false, error: 'No items given' };

    let subtotal = 0;
    const names = [];
    for (const line of items) {
      const item = STUB_CATALOG.find((i) => i.code === String(line.code || '').toUpperCase());
      if (!item) return { ok: false, error: 'Unknown item ' + line.code, escalate: true };
      if (item.stubPrice == null) {
        // The important branch. Mirrors the real engine's NO_APPROVED_PRICE so
        // the agent's refusal wording gets exercised in testing.
        return {
          ok: false,
          error: 'No approved price is configured for ' + item.name,
          code: 'NO_APPROVED_PRICE',
          escalate: true,
          _stub: true,
        };
      }
      const qty = Number(line.qty || 1);
      subtotal += item.stubPrice * qty;
      names.push(qty > 1 ? qty + ' ' + item.name : item.name);
    }

    const tax = Math.round((subtotal * GST) / 100);
    const total = subtotal + tax;
    log.warn('STUB PRICE returned:', inr(total), '— fake number, see localStubs.js');

    return {
      ok: true,
      speakable: names.join(' plus ') + ' comes to ' + inr(total) + ' including GST of ' + inr(tax) + '.',
      grandTotal: total,
      approved: true,
      validUntil: new Date(Date.now() + 7 * 864e5).toISOString(),
      _stub: true,
    };
  },

  async validate_discount({ requestedPercent = 0, requestedAmount = 0 }) {
    // A flat 5% ceiling, chosen only to make both branches reachable in testing.
    // The real engine derives this from DiscountRule tiers and the minimum-sell
    // floor, and fails closed when no rule matches.
    const CEILING = 5;
    const asked = requestedPercent || (requestedAmount ? 100 : 0);
    const allowed = asked > 0 && asked <= CEILING;
    return {
      ok: true,
      allowed,
      approvedPercent: allowed ? asked : null,
      requiresApproval: !allowed,
      _stub: true,
    };
  },

  async schedule_followup(args) {
    followups.push({ ...args, at: new Date() });
    log.info('follow-up scheduled:', args.when, '-', args.reason || '');
    return { ok: true, followupId: 'stub_fu_' + followups.length, scheduledFor: args.when, _stub: true };
  },

  async transfer_to_human(args) {
    log.info('HANDOFF requested:', args.urgency || 'callback', '-', args.reason);
    return { ok: true, assignedTo: 'Stub BDO', mode: args.urgency === 'now' ? 'connect' : 'callback', _stub: true };
  },

  async log_call_outcome(args, ctx) {
    outcomes.push({ ...args, callId: ctx && ctx.callId, at: new Date() });
    if (args.optOut) optOuts.add(norm(args.phone || (ctx && ctx.phone)));
    log.info('OUTCOME:', args.disposition, '|', args.summary);
    if (args.nextAction) log.info('NEXT:', args.nextAction);
    return { ok: true, callId: (ctx && ctx.callId) || 'stub', _stub: true };
  },

  async check_opt_out({ phone }) {
    return { ok: true, optedOut: optOuts.has(norm(phone)), _stub: true };
  },

  /** Test-only accessors, so a harness can assert on what the agent recorded. */
  _state: { leads, followups, outcomes, optOuts, catalog: STUB_CATALOG },
};
