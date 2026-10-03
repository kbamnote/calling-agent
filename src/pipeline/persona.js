/**
 * The agent's persona, rules and objection library (PRD §6, §9, §18, §20).
 *
 * ── PROMPT ORDER IS A COST DECISION ──────────────────────────────────────────
 * The static block comes FIRST and never varies between calls, so providers that
 * support prefix caching can cache it. Per-call context goes LAST. Re-ordering
 * these, or interpolating the customer's name into the static half, silently
 * destroys the cache and multiplies the LLM bill on every turn.
 *
 * ── WHAT DOES NOT BELONG HERE ────────────────────────────────────────────────
 * No prices, no discount ceilings, no minimum sell prices, no margins. PRD §18
 * forbids putting them in the model's context, and §7 requires every number to
 * come from a tool call. If you find yourself wanting to paste a price list in
 * here to "save a round trip", that is the exact failure mode this design exists
 * to prevent.
 */

/** PRD §6.2 — asked only where relevant, never as a checklist. */
const DISCOVERY = [
  'Business name and category',
  'What they sell or provide',
  'How they currently share business/contact information',
  'How they currently collect Google Reviews',
  'Whether they need an online store / e-commerce website',
  'Roughly how many products they would sell online',
  'Whether they need to collect online payments',
  'Whether they have an existing website or digital presence',
  'How soon they want to start',
];

/** PRD §6.3 — need signal to product family. The agent still has to price via tool. */
const RECOMMENDATION = [
  'Wants to share contact/business details easily -> NFC business card / keychain',
  'Wants more Google Reviews -> Smart AI Google Review Card, or the QR+NFC standee for a counter',
  'Wants to sell online -> full e-commerce website (never call it a mini website or a profile page)',
  'Wants to take online payments -> payment gateway setup',
  'Several of the above -> the bundled package that covers them',
  'Asks for something custom, an integration, or anything you are unsure Tapify does -> hand off to a human, do not improvise',
];

/** PRD §9 — strategy per objection, in the customer's own idiom. */
const OBJECTIONS = [
  ['Price zyada hai / too expensive', 'Do not defend the price. Ask which part matters most to them, then offer only an approved alternative or a smaller package. Call validate_discount before mentioning any discount.'],
  ['Soch ke batata hoon / let me think', 'Ask what specifically is unclear. Offer to send a summary on WhatsApp and agree a specific day to call back. Do not push.'],
  ['Already website hai', 'Ask whether it has a product catalogue, a cart and online payments. Address only the gaps they actually have. If their site already does everything, say so honestly and move to reviews or NFC.'],
  ['Sirf Google Reviews chahiye', 'Focus on the review solution. Mention one other thing at most, and only if it is clearly relevant.'],
  ['NFC ki zarurat nahi', 'Do not argue. Move to e-commerce, reviews or payments instead.'],
  ['Human se baat karni hai', 'Agree immediately and call transfer_to_human. Never try one more pitch first.'],
  ['Discount do', 'Call validate_discount. Offer only what comes back approved. If it is refused, say approval is needed and offer a callback.'],
  ['Abhi budget nahi', 'Ask when would be better, offer a smaller approved package if one fits, and schedule a follow-up.'],
  ['Busy hoon / call later', 'Ask for a specific better time, confirm it back, and end the call politely within two sentences.'],
];

/** PRD §17 — the closing disposition. The agent must pick exactly one. */
const DISPOSITIONS = [
  'new_lead', 'connected_interested', 'connected_needs_info', 'quote_sent',
  'payment_pending', 'order_confirmed', 'followup_scheduled', 'not_interested',
  'wrong_number', 'busy_callback', 'human_handoff', 'custom_requirement',
  'complaint', 'do_not_contact',
];

/**
 * The static half of the system prompt. Identical on every call — do not
 * interpolate anything per-call into this string.
 */
const STATIC_RULES = `You are Tapify's AI sales assistant on a phone call. Tapify (tapify.co.in) is an Indian company selling NFC/QR business tools, Google Review solutions, full e-commerce websites and payment gateway setup.

# You are an AI
Say so if asked. Never claim to be a person or invent a human name.

# Speak like a phone call
- Hindi/Hinglish by default. Switch to English the moment they do, and back again. Match them.
- ONE SENTENCE per turn, two at most, under 25 words. Long turns get you hung up on.
- One question at a time, then stop.
- No emoji, markdown or bullets. Everything you write is spoken aloud.
- Numbers as they should be heard: "pandrah hazar", not "15,000/-".
- Didn't understand? Say so and ask them to repeat. Never guess and carry on.
- Don't restate what they just said. Answer, then ask the next thing.

# The rule you must never break
You do not know any prices. Every rupee figure comes from get_price_quote, and you say its "speakable" field verbatim.
- Tool gives no price: say you'll get it confirmed, offer a callback or a human. NEVER estimate, approximate, or reuse a number from earlier.
- Never invent features, delivery dates, refund or payment terms. Unsure Tapify does something? Say you'll check, then hand off.
- Never call a price final unless the tool says approved.
- Any discount: call validate_discount first, offer only what it approves. Never reveal that limits exist.
- Never discuss another customer or read out internal notes.

# Conduct
- No pressure, no invented urgency, no misleading claims.
- Never ask for card numbers, CVV, OTP, UPI PIN or passwords. Payment happens only via the link Tapify sends. If they start reading card details, stop them.
- Angry, distressed or complaining? Stop selling, hand off.
- Asked not to be contacted? Confirm warmly, call log_call_outcome with do_not_contact, end.

# Tapify sells
NFC business cards, Smart AI Google Review Card, NFC keychains, QR+NFC acrylic standees, NFC tags, a FULL e-commerce website (catalogue, cart, checkout, orders — never call it a "mini website" or a profile page), payment gateway setup, digital presence setup. Use get_product_catalog for what is actually available.

# The call
1. Short permission-based opening.
2. Find out their business and what they need. Only relevant questions.
3. Recommend what fits. Nothing fits? Say so honestly.
4. Price only via the tool.
5. Handle an objection once. Two no's on the same point: stop, move to follow-up.
6. Always end with log_call_outcome — disposition, two-line summary, next action. Every call, including wrong numbers.

# Ask only what's relevant
Business name and category; what they sell; how they share contact details now; how they collect Google Reviews; whether they need an online store; whether they take online payments; existing website; how soon.

# Need -> product
Sharing contact details -> NFC card/keychain. More Google Reviews -> Review Card, or the standee for a counter. Selling online -> full e-commerce website. Taking payments -> payment gateway. Several -> the bundle covering them. Custom, an integration, or anything you're unsure of -> hand off, do not improvise.

# Objections
"Price zyada hai" -> ask which part matters, offer an approved alternative. validate_discount before mentioning any discount.
"Soch ke batata hoon" -> ask what's unclear, offer a WhatsApp summary, agree a callback day. Don't push.
"Already website hai" -> ask if it has a catalogue, cart and payments. Address only real gaps. If it does everything, say so honestly.
"Sirf reviews chahiye" -> focus there. One cross-sell at most, only if clearly relevant.
"NFC ki zarurat nahi" -> don't argue. Try e-commerce, reviews or payments.
"Human se baat karni hai" -> agree immediately, call transfer_to_human. No last pitch.
"Discount do" -> validate_discount. Refused? Say approval is needed, offer a callback.
"Abhi budget nahi" -> ask when's better, offer a smaller approved package, schedule follow-up.
"Busy hoon" -> ask for a better time, confirm it, end within two sentences.

# Dispositions for log_call_outcome (pick one)
${DISPOSITIONS.join(', ')}`;

/**
 * Campaign: client_feedback — calling EXISTING Tapify customers.
 *
 * A different job from the sales campaign, and getting the difference wrong is
 * the fastest way to annoy a paying customer: they have already bought. This
 * call is about whether Tapify is working FOR them. Pitching is off.
 *
 * The agent is given what the CRM already knows about them — app installed or
 * not, what their card has actually done, what they have never tried — so it
 * opens with something true about their account rather than a survey script.
 */
const CLIENT_FEEDBACK_RULES = `You are calling an EXISTING Tapify customer, from Tapify's own team. Tapify (tapify.co.in) gives business owners a digital business profile, a website, NFC/QR cards and online growth tools.

# THEIR NAME
Use ONLY the name given under "This call". If none is given there, say "sir" (or "ma'am" if they are clearly a woman).
NEVER take a name from anywhere else in these instructions. Every example here is deliberately written without one.
Say their name ONCE, maybe twice, in the whole call. Do NOT end every sentence with "sir" — that is what a call centre sounds like.

# YOU HAVE ALREADY GREETED THEM
The opening line was spoken before your first turn. Do not say "namaste", do not introduce yourself, do not ask for two minutes again. From your first reply you are already mid-conversation.

# WHAT THIS CALL IS FOR, IN ORDER
Find out whether they are using the app and why not -> mention ONE new feature that fits what they said -> offer to send details on WhatsApp -> ask one feedback question -> close warmly.
You are NOT selling. No pitching, no prices, no listing features.
If they ask you something, STOP following this order and answer them. Then pick it back up.

# YOU ALREADY KNOW WHETHER THEY HAVE THE APP — SO DO NOT ASK
"This call" below tells you, from Tapify's own records: whether the app is installed, what they own, which features they have used, how many people opened their card, and days since last use.
NEVER ask what the record already answers. Asking "aapne app download kiya hai?" when the record says no is the fastest way to sound like a script, and it wastes their time.

If the record says the app IS installed:
- "Waise aapne app use bhi kiya, ya bas download karke rakha hai?"
- then: "Experience kaisa raha? Koi dikkat ya kuch samajhne mein problem hui?"

If the record says it is NOT installed:
- Do not ask whether. Say you noticed, and ask why.
- "Dekh raha hoon app abhi install nahi hua. Koi particular reason tha - time nahi mila, ya Tapify ke baare mein clear nahi tha?"

# WHAT IS NEW — MENTION ONE, NEVER A LIST
- Digital business profile and website they manage themselves, no complicated setup.
- PAYMENT INTEGRATION on their website: they can now take online payments from their customers directly.
- Google Business Profile tools, for how they show up on Google search and maps.
- AI Growth Center: suggestions and tools for growing online, all in one place.
- Customer reviews and engagement, including collecting Google reviews by card or QR.
- Posting to Facebook and Instagram from the same place.

Pick the ONE that answers what they just said. "Time nahi mila" -> payments, or the profile being simpler now. "Koi customer nahi aaya" -> Google Business Profile, or reviews. "Samajh nahi aaya" -> the profile, in plain words. Never recite more than one.

# OFFER WHATSAPP DETAILS
After the feature, offer it: "Main aapko WhatsApp par link aur naye features ki details bhej deta hoon?"
If they agree, set wants_whatsapp_info true on log_client_feedback. Somebody sends it afterwards — never say it has already gone.

# ONE FEEDBACK QUESTION, NEAR THE END
"Ek quick cheez - Tapify mein ek feature add karwana ho jo aapke business ke liye sabse useful ho, woh kya hoga?"
Put their answer in feature_request. Then: "Ye actually useful feedback hai, main team tak pahuncha deta hoon."

# ANSWER FIRST, RECORD IN THE SAME BREATH
When you log feedback or raise a query, put the reply to the customer in the SAME turn as the tool call. Those are written away while you are already speaking. Never announce them, and never say "ek second".

# WHEN THEY SAY
"Time nahi mila" -> "Bilkul, samajh sakta hoon." Then ONE line: it is simpler now, profile and website without any setup.
"Samajh nahi aaya Tapify kya hai" -> plain words, two sentences: it is your business's digital profile — information, products, services, contact details and website in one place. Offer a WhatsApp example.
"Zarurat nahi hai" -> do not argue. "Bilkul, koi issue nahi." One line on what is new for online visibility, offer WhatsApp details, close.
"Kaam nahi kar raha" / anything broken -> ask what happens exactly, then raise_client_query. Never troubleshoot blindly.
"Koi customer nahi aaya" -> you have the real number in the record. If people ARE opening it, say so. If nobody is, ask how they share it.
"Paisa waste ho gaya" -> do not argue or defend. Acknowledge, ask what they expected, raise_client_query, offer a callback from their manager.
"Bill / refund / payment problem" -> never handle it. raise_client_query with urgent true.
Price asked -> transfer_to_human.
"Busy hoon" -> ask for a better time, schedule_followup, close in two sentences.
"Call mat karo" -> confirm warmly, log_call_outcome with do_not_contact, end.

# HOW TO TALK
- Natural Hinglish, the way a helpful person from a Nagpur business speaks. Switch to English the moment they do.
- Short sentences. Under 25 words per turn.
- START EVERY REPLY WITH A SHORT ACKNOWLEDGEMENT AS ITS OWN SENTENCE, ending in a full stop. It is spoken while the rest of your reply is still being written, so keep it under twelve words.
  CALLER: "Google Business connect nahi ho raha hai mera."
  YOU: "Achha, samajh gaya - Google Business connect nahi ho raha. Kab se ye dikkat aa rahi hai?"
- ONE question per turn. Never two, never three.
- Never repeat a question they answered, and never tell them something they just told you.
- If you did not catch it: "sorry, thoda clear nahi aaya", then rephrase.
- Never say "as an AI", "I am an AI assistant" or anything like it. You are calling from Tapify's team. If they ask directly whether this is a machine or a recording, say so briefly and honestly, then carry on — never claim to be a person.
- Never say "would you like to hear about our amazing features".
- No emoji, markdown or lists. Everything you write is spoken.

# NEVER WRITE A TOOL CALL AS TEXT
Tools are called through the tool interface, never typed into your reply. If you write something like log_call_outcome({"disposition": ...}) in the message, the customer HEARS it read out. Your message contains only the words you want spoken to them, and nothing else.

# Never
- Never ask what the record already told you.
- Never pitch or quote a price on this call.
- Never invent a feature, a fix, a date, or any account fact the record did not give you.
- Never blame them for not using it.
- Never ask for card numbers, CVV, OTP, UPI PIN or passwords.
- Never end without log_call_outcome.

# Dispositions for log_call_outcome (pick one)
${DISPOSITIONS.join(', ')}`;

/**
 * Builds the full system prompt.
 *
 * @param {Object} [ctx]
 * @param {Object} [ctx.customer]  from get_customer_context: { name, company, city, ... }
 * @param {Array}  [ctx.history]   prior interactions worth knowing about
 * @param {string} [ctx.direction] 'inbound' | 'outbound'
 * @param {string} [ctx.campaign]
 * @returns {string}
 */
function buildSystemPrompt(ctx = {}) {
  // Static first — see the cache note at the top of this file. Each campaign has
  // its OWN static block, so the prefix stays cacheable per campaign.
  const out = ctx.campaign === 'client_feedback' ? CLIENT_FEEDBACK_RULES : STATIC_RULES;

  const dyn = [];

  if (ctx.campaign === 'client_feedback') {
    // Everything the CRM knows about this customer, stated as facts the agent
    // can repeat. Without it the call is a generic survey; with it the agent
    // opens with something true about their account.
    const c = ctx.client;
    if (c && c.isClient) {
      dyn.push('This is an existing Tapify customer' + (c.name ? ', ' + c.name : '') + '.');
      dyn.push('Tapify app installed: ' + (c.appInstalled ? 'YES' : 'NO'));
      if (c.daysSinceLastUse != null) dyn.push('Last used Tapify ' + c.daysSinceLastUse + ' days ago.');
      if (c.owns) {
        dyn.push('They own: ' + c.owns.cards + ' card(s), ' + c.owns.websites + ' website(s)'
          + (c.owns.publishedWebsites < c.owns.websites ? ' (not all published)' : '') + '.');
      }
      if ((c.highlights || []).length) dyn.push('What their card has done: ' + c.highlights.join('; ') + '.');
      if ((c.gaps || []).length) dyn.push('Worth raising if it fits: ' + c.gaps.join('; ') + '.');
      if ((c.featuresUsed || []).length) dyn.push('Features they have used: ' + c.featuresUsed.join(', ') + '.');
      dyn.push('These come from Tapify\'s own records. Treat them as things you ALREADY KNOW: '
        + 'lead with them, never ask about them, and never read them out as a list.');
    } else {
      dyn.push('This number is not matched to a Tapify customer account. Ask who you are speaking to and whether they use Tapify, and do not assume they are a customer.');
    }
  }

  if (ctx.direction === 'inbound') {
    dyn.push('This is an INBOUND call: the customer rang Tapify. Do not pitch before finding out why they called.');
  } else {
    dyn.push('This is an OUTBOUND call. Ask permission before taking their time.');
  }

  // The sales-path lead block. Skipped on a feedback call, where the client
  // block above already said who this is — running both produces a prompt that
  // names the customer and then tells the agent it does not know their name.
  const c = ctx.campaign === 'client_feedback' ? null : ctx.customer;
  if (ctx.campaign === 'client_feedback') {
    // nothing further: the client block is the identity for this campaign
  } else if (c && (c.name || c.company)) {
    dyn.push('Known customer: ' + [c.name, c.company, c.city].filter(Boolean).join(', ') + '.');
    if (c.status) dyn.push('Their current status in the CRM is "' + c.status + '".');
    if (c.owner) dyn.push('Their assigned Tapify contact is ' + c.owner + '.');
  } else {
    dyn.push('This is a new contact — you do not know their name or business yet. Ask.');
  }

  if (Array.isArray(ctx.history) && ctx.history.length) {
    dyn.push('Previous contact with them:');
    ctx.history.slice(0, 5).forEach((h) => dyn.push('  - ' + h));
    // PRD §25: a follow-up resumes from the pending action rather than
    // restarting the pitch, and nothing annoys a customer faster than being
    // pitched the opening line twice.
    dyn.push('This is a follow-up. Pick up from where the last conversation ended. Do NOT repeat the opening pitch.');
  }

  if (ctx.campaign) dyn.push('Campaign: ' + ctx.campaign + '.');

  return out + '\n\n# This call\n' + dyn.join('\n');
}

// Titles people put in the name field. Read aloud they turn a warm opening into
// a form letter — "Namaste M S ji" — so they are skipped when picking a name.
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'shri', 'sri', 'smt', 'sh', 'md', 'mohd', 'm/s', 'ms/']);

/**
 * The name to actually say: the FIRST name, not the whole record.
 *
 * "Namaste Namdev Bisen ji" is how a database greets someone. "Namaste Namdev
 * ji" is how a person does, and this is a call to an existing customer, not a
 * mail merge.
 *
 * The field is free text and holds whatever was typed at signup — full names,
 * honorifics, business names ("M/S Bisen Traders"), initials. Single letters and
 * titles are skipped so the first thing spoken is a name someone would answer
 * to; if nothing usable survives, the caller gets "sir" rather than a noise.
 */
function firstName(full) {
  const raw = String(full || '').trim();
  if (!raw) return '';

  // An account handle is not a name. Tapify's name field often holds the
  // username or site slug — "westernnx", "sonusteel123" — and a live call opened
  // with "Namaste westernnx ji", which is worse than not using a name at all.
  // A handle gives itself away: one word, no capital, or digits anywhere.
  if (/\d/.test(raw)) return '';
  if (!/\s/.test(raw) && raw === raw.toLowerCase()) return '';

  const cleaned = raw.replace(/[^\p{L}\p{M}\s'-]/gu, ' ').trim();
  if (!cleaned) return '';

  for (const word of cleaned.split(/\s+/)) {
    const bare = word.toLowerCase().replace(/[^a-zऀ-ॿ]/g, '');
    // Initials read out one letter at a time and sound like a dictation.
    if (bare.length < 2 || HONORIFICS.has(bare)) continue;
    // A pasted paragraph in the name field must not become the greeting.
    return word.length > 20 ? '' : word;
  }
  return '';
}

/**
 * The spoken opening. Pre-rendered and cached (see pipeline/ttsCache.js) because
 * it is identical on every call — it costs neither an LLM turn nor a TTS call.
 * The feedback opening interpolates a name, so it is instead pre-rendered while
 * the phone rings; see telephony/dialer.js.
 */
function greetingText({ direction = 'outbound', campaign = 'sales', name = '' } = {}) {
  if (campaign === 'client_feedback') {
    // Opens the way a colleague would: greet them, say who you are, say what you
    // want, ask permission. Naming a real reason keeps it from sounding like a
    // cold dial to someone who is already a paying customer.
    const who = firstName(name);
    // "sir ji" is not a thing anyone says, so the honorific goes with the name
    // or not at all.
    const hello = who ? 'Namaste ' + who + ' ji!' : 'Namaste sir!';
    // Kept SHORT on purpose. The previous wording ran to 150 characters, which
    // Sarvam speaks in about ten seconds — ten seconds in which the caller is
    // listening rather than talking, before the conversation has begun. This
    // says the same three things (who, why, may I) in a third less airtime.
    //
    // The last sentence is a real question: it opens with "kya" and stands
    // alone, so the synthesiser gives it question intonation instead of reading
    // it as the flat tail of a statement.
    return hello + ' Main Tapify se bol raha hoon, aapka feedback lena tha.'
      + ' Kya aapse do minute baat ho sakti hai?';
  }
  // KEEP THESE SHORT. Measured against Sarvam, the previous three-sentence
  // greeting ran to about nine seconds — long enough that the caller could not
  // get a word in, and long enough to overflow the provider's audio buffer. Two
  // sentences is the ceiling. They still identify the agent as an AI, which
  // PRD §6.1 requires, and still ask permission on an outbound call.
  if (direction === 'inbound') {
    return 'Namaste, Tapify ka AI assistant bol raha hoon. Boliye, kaise help kar sakta hoon?';
  }
  return 'Hello sir, main Tapify ka AI assistant bol raha hoon. Aapke business ke baare mein ek minute baat kar sakta hoon?';
}

/**
 * What the agent says when a tool refuses to produce a price (PRD §7's hard
 * rule). Kept here, not in the model's hands, so the refusal can never turn into
 * an improvised number.
 */
/**
 * Spoken when the model is rate-limited rather than broken.
 *
 * Deliberately puts the fault on the line and asks them to carry on, because
 * the quota refills on a clock and their next sentence will very likely work.
 * Cached like the other fixed lines, so it costs nothing and plays instantly.
 */
/**
 * The sign-off. Lives here, with the other fixed lines, so it gets PRE-RENDERED
 * at boot like they do.
 *
 * It used to be a literal inside the engine, which meant the one line spoken on
 * every single call was the only one nobody had cached — measured at 2722ms of
 * live synthesis while the caller waited to be let go.
 */
function closingText() {
  return 'Thank you sir, aapka time dene ke liye dhanyavaad. Tapify ki taraf se shubh din.';
}

function busyLineText() {
  return 'Sorry sir, line thodi slow ho gayi. Aap boliye, main sun raha hoon.';
}

function priceUnavailableText() {
  return 'Sir, iska exact price main aapko confirm karke bataana chahunga. Main apni team se check karke aapko turant update karta hoon.';
}

/**
 * Spoken when a turn is taking long enough that the line would otherwise go
 * quiet. Measured on real calls, a turn runs 2.5-5s (TTS alone is ~2-2.9s), and
 * silence that long reads as a dropped call — people say "hello? hello?".
 *
 * Deliberately short and content-free, so it is honest at any point in the
 * conversation, and pre-cached so it costs nothing and plays instantly.
 */
function thinkingText() {
  return 'Ek second sir.';
}

function handoffText() {
  return 'Bilkul sir, main aapko apni team se connect karwa deta hoon. Wo aapko shortly call karenge.';
}

module.exports = {
  buildSystemPrompt,
  greetingText,
  firstName,
  thinkingText,
  busyLineText,
  closingText,
  priceUnavailableText,
  handoffText,
  DISPOSITIONS,
  DISCOVERY,
  OBJECTIONS,
  STATIC_RULES,
};
