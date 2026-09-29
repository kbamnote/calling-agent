/**
 * Scripted "LLM" — no key, no network, no cost.
 *
 * This is NOT a language model and does not pretend to be one. It is a
 * deterministic state machine that walks a realistic discovery → recommend →
 * price → object → close path and calls the same tools a real model would, so
 * you can exercise and debug the entire pipeline — turn-taking, barge-in, tool
 * dispatch, the price-refusal path, dispositions, the cost ledger — before
 * spending a rupee or waiting on an account.
 *
 * Use it to test PLUMBING. Never use it to judge conversation quality, and never
 * ship it: `config.warnings()` says so at boot for exactly that reason.
 *
 * It derives its state from the conversation so far rather than holding its own,
 * which means it behaves identically whether the transport is text, browser or a
 * phone line.
 */

const HAS = (s, ...words) => words.some((w) => s.includes(w));

/** Which tools have already returned in this conversation. */
function toolsDone(messages) {
  const done = new Set();
  for (const m of messages) if (m.role === 'tool') done.add(m.name);
  return done;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return String(messages[i].content || '').toLowerCase();
  }
  return '';
}

/** The most recent tool result for `name`, or null. */
function lastToolResult(messages, name) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'tool' && messages[i].name === name) return messages[i].content;
  }
  return null;
}

function countAssistantTurns(messages) {
  return messages.filter((m) => m.role === 'assistant' && m.content).length;
}

// Simulated per-token pacing, so the streaming orchestration is exercised
// rather than handed a whole reply at once. 0 (the default) replays instantly,
// which keeps the plumbing tests fast; the latency harness raises it to model a
// real vendor's token rate.
const MOCK_TOKEN_MS = Number(process.env.MOCK_LLM_TOKEN_MS) || 0;
const MOCK_TTFT_MS = Number(process.env.MOCK_LLM_TTFT_MS) || 0;

function create(config) {
  return {
    name: 'mock',
    model: 'scripted',
    supportsStreaming: true,

    /**
     * Replays the scripted answer as deltas.
     *
     * Deliberately routed through chat() rather than written twice: a mock whose
     * streaming path could disagree with its non-streaming one would hide the
     * class of bug this exists to catch.
     */
    async chatStream(o) {
      const res = await this.chat(o);
      if (MOCK_TTFT_MS) await new Promise((r) => setTimeout(r, MOCK_TTFT_MS));

      // A real vendor puts the tool-call fragments at the head of the stream,
      // before any narration. Mirrored here so the engine's "stop synthesising,
      // this is a tool round" path is exercised by the plumbing tests.
      if (res.toolCalls && res.toolCalls.length && o.onToolCallStart) {
        o.onToolCallStart(res.toolCalls[0].name);
      }

      // Split so whitespace rides with its word — reassembling the deltas must
      // reproduce the text exactly, or sentence detection drifts downstream.
      const pieces = (res.text || '').match(/\S+\s*/g) || [];
      let sent = '';
      for (let i = 0; i < pieces.length; i += 1) {
        if (i === 0 && o.onFirstToken) o.onFirstToken();
        sent += pieces[i];
        if (o.onDelta) o.onDelta(pieces[i], sent);
        if (MOCK_TOKEN_MS) await new Promise((r) => setTimeout(r, MOCK_TOKEN_MS));
      }
      return res;
    },

    async chat({ messages }) {
      const said = lastUserText(messages);
      const done = toolsDone(messages);
      const turns = countAssistantTurns(messages);
      const usage = { in: 0, out: 0, cached: 0 };
      const reply = (text, toolCalls = []) => ({ text, toolCalls, usage });
      const call = (name, args = {}) => ({ id: 'mock_' + name + '_' + Date.now(), name, args });

      // ── Absolute priorities, checked before anything else ──────────────────
      // These mirror PRD §11's handoff rules: they must win over whatever stage
      // the script thinks it is at.

      if (HAS(said, 'do not contact', 'mat karo call', 'call mat', 'remove my number', 'dnd', 'block')) {
        return reply(
          'Bilkul sir, main aapka number list se hata deta hoon. Aage se call nahi aayega. Thank you.',
          [call('log_call_outcome', {
            disposition: 'do_not_contact',
            summary: 'Customer asked not to be contacted again.',
            next_action: 'Add to do-not-contact list. No further promotional contact.',
            opt_out: true,
          })],
        );
      }

      if (HAS(said, 'human', 'insaan', 'manager', 'kisi aadmi', 'real person', 'baat karni hai team')) {
        return reply(
          'Bilkul sir, main aapko apni team se connect karwa deta hoon.',
          [call('transfer_to_human', { reason: 'Customer explicitly asked for a human', urgency: 'now' })],
        );
      }

      if (HAS(said, 'complaint', 'shikayat', 'cheat', 'fraud', 'paisa wapas', 'refund')) {
        return reply(
          'Sir, mujhe khed hai. Main ise turant apni team ko forward kar raha hoon, wo aapse baat karenge.',
          [call('transfer_to_human', { reason: 'Complaint or refund issue raised', urgency: 'now' })],
        );
      }

      if (HAS(said, 'wrong number', 'galat number', 'ye kiska number')) {
        return reply(
          'Sorry sir, galti se call lag gaya. Aapka time lene ke liye maafi chahta hoon.',
          [call('log_call_outcome', { disposition: 'wrong_number', summary: 'Wrong number.', next_action: 'Mark number invalid.' })],
        );
      }

      if (HAS(said, 'not interested', 'nahi chahiye', 'interest nahi', 'mat bhejo', 'no thanks')) {
        return reply(
          'Koi baat nahi sir, aapka time dene ke liye dhanyavaad. Zarurat pade to Tapify yaad rakhiye.',
          [call('log_call_outcome', {
            disposition: 'not_interested',
            summary: 'Customer not interested at this time.',
            next_action: 'No follow-up for 90 days.',
          })],
        );
      }

      if (HAS(said, 'busy', 'baad me', 'later', 'abhi time nahi')) {
        return reply(
          'Koi dikkat nahi sir. Main kal isi time call kar leta hoon, theek rahega?',
          [call('schedule_followup', { when: 'tomorrow', reason: 'Customer was busy', note: 'Call back same time tomorrow.' })],
        );
      }

      // ── Discount path — must go through the tool (PRD §8) ──────────────────
      if (HAS(said, 'discount', 'kam karo', 'kuch kam', 'offer', 'best price', 'last price')) {
        if (!done.has('validate_discount')) {
          return reply('', [call('validate_discount', { items: [{ code: 'PKG_BUSINESS', qty: 1 }], requested_percent: 10 })]);
        }
        const v = lastToolResult(messages, 'validate_discount') || {};
        if (v.allowed) {
          return reply(`Sir, main aapke liye ${v.approvedPercent} percent tak kar sakta hoon. Ye approved offer hai.`);
        }
        return reply('Sir, isse aage ka discount mujhe approval lena padega. Main check karke aapko update karta hoon — tab tak baaki details WhatsApp par bhej deta hoon?');
      }

      // ── Price path — never a number of its own (PRD §7) ────────────────────
      if (HAS(said, 'price', 'kitna', 'kitne ka', 'rate', 'cost', 'charge', 'paisa')) {
        if (!done.has('get_price_quote')) {
          return reply('', [call('get_price_quote', { items: [{ code: 'PKG_BUSINESS', qty: 1 }] })]);
        }
        const p = lastToolResult(messages, 'get_price_quote') || {};
        if (p.speakable) return reply(`${p.speakable} Main poori details WhatsApp par bhej deta hoon?`);
        // The refusal branch. This is the single most important behaviour to
        // test, because a real model under pressure is exactly where an invented
        // price would come from.
        return reply('Sir, iska exact price main confirm karke bataana chahunga. Main team se check karke turant update karta hoon.');
      }

      // ── Discovery / recommendation walk ────────────────────────────────────
      if (HAS(said, 'haan', 'yes', 'ok', 'theek', 'bolo', 'boliye') && turns <= 1) {
        return reply('Thank you sir. Aapka business kis category mein hai?');
      }

      if (!done.has('get_product_catalog') && turns >= 2) {
        return reply('', [call('get_product_catalog', {})]);
      }

      if (HAS(said, 'restaurant', 'hotel', 'shop', 'store', 'dukan', 'clinic', 'salon', 'jewell', 'medical')) {
        // Save what was just learned. A real model is told to do this as soon as
        // it knows the business, and the plumbing test is worthless if it never
        // exercises the write that every later call depends on.
        if (!done.has('create_or_update_lead')) {
          const type = ['restaurant', 'hotel', 'clinic', 'salon', 'medical']
            .find((t) => said.includes(t)) || 'shop';
          return reply('Samajh gaya sir. Aap Google Reviews collect karne ke liye abhi QR ya koi card use karte hain?', [
            call('create_or_update_lead', { business_type: type, needs: ['google_reviews'] }),
          ]);
        }
        return reply('Samajh gaya sir. Aap Google Reviews collect karne ke liye abhi QR ya koi card use karte hain?');
      }

      if (HAS(said, 'qr', 'review', 'google')) {
        return reply('Theek hai. Tapify ka NFC aur QR review solution se customer ka review dena bahut easy ho jaata hai. Aap online selling bhi karna chahte hain, ya sirf reviews ka solution chahiye?');
      }

      if (HAS(said, 'online', 'website', 'ecommerce', 'selling', 'bechna', 'payment')) {
        return reply(
          'Perfect sir. Tapify full e-commerce website aur payment gateway bhi provide karta hai — catalogue, cart, checkout, sab kuch. Main aapke requirement ke hisaab se package check karta hoon.',
          [call('create_or_update_lead', {
            needs: ['google_reviews', 'online_selling'],
            existing_website: false,
            notes: 'Wants Google reviews and an online store.',
          })],
        );
      }

      // ── Wrap-up: the turn budget was hit, or the script ran out of path ────
      if (turns >= 6) {
        if (!done.has('log_call_outcome')) {
          return reply(
            'Sir, main aapko poori details WhatsApp par bhej deta hoon aur kal follow-up karta hoon. Thank you for your time.',
            [call('log_call_outcome', {
              disposition: 'connected_needs_info',
              summary: 'Discussed Tapify NFC and e-commerce options. Customer wants details before deciding.',
              next_action: 'Send details on WhatsApp and follow up tomorrow.',
            })],
          );
        }
        return reply('Thank you sir, aapka din shubh rahe.');
      }

      return reply('Sir, thoda detail mein bataiye — aap apne customers ko business details kaise share karte hain abhi?');
    },
  };
}

module.exports = { create };
