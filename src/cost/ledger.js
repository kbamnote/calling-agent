/**
 * Per-call cost ledger.
 *
 * PRD §26 asks for "AI cost per qualified lead/order", and you cannot report that
 * — or defend the project's economics — from vendor invoices alone, because an
 * invoice cannot tell you which script, campaign or lead source burned the money.
 * So every vendor unit is counted here, per call, as the call happens.
 *
 * The rates in config are PLANNING ESTIMATES, not quotes. `estimatedInr` is for
 * steering (which campaign is wasteful, is the greeting gate working) — never for
 * accounting. Replace the rates with contracted numbers before anyone reports
 * them upward.
 *
 * The three numbers that actually decide whether this is cheaper than a
 * telecaller are surfaced deliberately:
 *   • aiEngaged        — did this dial cost any AI at all? (the greeting gate)
 *   • ttsCacheHits     — how much agent speech was free
 *   • llmTokensCached  — how much of the prompt was not re-billed
 */
const config = require('../config');

function create({ callId, direction = 'outbound', campaignId = null } = {}) {
  const startedAt = Date.now();

  const u = {
    telephonySec: 0,
    sttSec: 0,
    ttsChars: 0,
    ttsCharsCached: 0,
    ttsCacheHits: 0,
    llmTokensIn: 0,
    llmTokensOut: 0,
    llmTokensCached: 0,
    llmCalls: 0,
    toolCalls: 0,
    toolFailures: 0,
    turns: 0,
    // False until human speech is heard. A dial that never engaged the AI should
    // cost telephony seconds and nothing else — if these diverge, the greeting
    // gate is broken and it is the single most expensive bug in the system.
    aiEngaged: false,
  };

  const api = {
    callId,
    direction,
    campaignId,

    engaged() { u.aiEngaged = true; },
    turn() { u.turns += 1; },

    telephony(sec) { u.telephonySec += sec; },
    stt(sec) { u.sttSec += sec; },

    tts(chars, { cached = false } = {}) {
      if (cached) { u.ttsCharsCached += chars; u.ttsCacheHits += 1; }
      else u.ttsChars += chars;
    },

    llm({ in: tin = 0, out = 0, cached = 0 } = {}) {
      u.llmCalls += 1;
      u.llmTokensIn += tin;
      u.llmTokensOut += out;
      u.llmTokensCached += cached;
    },

    toolCall(name, ms, ok) {
      u.toolCalls += 1;
      if (!ok) u.toolFailures += 1;
    },

    /** Rupees, from the planning rates. Steering only. */
    estimate() {
      const r = config.rates;
      const telephony = (u.telephonySec / 60) * r.telephonyPerMin;
      const stt = (u.sttSec / 60) * r.sttPerMin;
      const tts = (u.ttsChars / 1000) * r.ttsPer1kChars;
      // Cached prompt tokens are billed at a fraction; 10% is the common order of
      // magnitude across providers and is close enough for steering.
      const llm = ((u.llmTokensIn - u.llmTokensCached) / 1000) * r.llmPer1kIn
        + (u.llmTokensCached / 1000) * r.llmPer1kIn * 0.1
        + (u.llmTokensOut / 1000) * r.llmPer1kOut;

      const total = telephony + stt + tts + llm;
      const round = (n) => Math.round(n * 10000) / 10000;
      return {
        telephony: round(telephony),
        stt: round(stt),
        tts: round(tts),
        llm: round(llm),
        total: round(total),
      };
    },

    snapshot() {
      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      return {
        callId,
        direction,
        campaignId,
        durationSec,
        units: { ...u },
        estimatedInr: api.estimate(),
        // The cost lever, made visible: what fraction of agent speech was free.
        ttsCacheRate: (u.ttsChars + u.ttsCharsCached) > 0
          ? Math.round((u.ttsCharsCached / (u.ttsChars + u.ttsCharsCached)) * 100)
          : 0,
      };
    },

    /** One line for the end-of-call log. */
    line() {
      const s = api.snapshot();
      if (!u.aiEngaged) {
        return `cost ~₹${s.estimatedInr.total} | ${s.durationSec}s | NOT ENGAGED (greeting gate saved the AI cost)`;
      }
      return `cost ~₹${s.estimatedInr.total} | ${s.durationSec}s | ${u.turns} turns | `
        + `llm ${u.llmTokensIn}/${u.llmTokensOut} (${u.llmTokensCached} cached) | `
        + `tts ${u.ttsChars} chars (${s.ttsCacheRate}% cached) | `
        + `tools ${u.toolCalls}${u.toolFailures ? ' (' + u.toolFailures + ' failed)' : ''}`;
    },
  };

  return api;
}

module.exports = { create };
