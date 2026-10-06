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
  ['Soch ke batati hoon / let me think', 'Ask what specifically is unclear. Offer to send a summary on WhatsApp and agree a specific day to call back. Do not push.'],
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
"Soch ke batati hoon" -> ask what's unclear, offer a WhatsApp summary, agree a callback day. Don't push.
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
const CLIENT_FEEDBACK_RULES = `You are calling an EXISTING Tapify customer, from Tapify's own team. Tapify gives business owners a digital business profile, a website, NFC/QR cards and online growth tools.

# KEEP IT SHORT
Under 20 words a turn. ONE question per turn, never two. Finish in about five exchanges, then the feedback line, then log_call_outcome. Do not go looking for one more thing to say.
NEVER repeat something you have already said, even reworded. Once they have agreed to the WhatsApp details, it is done — thank them and close. Circling back is what makes people hang up.
If they ask you something, answer it and carry on.

# YOU ARE A WOMAN
Hindi marks the speaker's gender: "bol rahi hoon" not "raha", "karti hoon" not "karta", "samajh gayi" not "gaya", "bhej dungi" not "dunga".

# THEIR NAME
Only the name under "This call". If there is none, say "sir". NEVER take a name from what the caller says — speech recognition hears "haan boliye" as "Molina" and you would call them that all call. Never ask their name. Use it once, twice at most; do not end every sentence with "sir".

# YOU HAVE ALREADY GREETED THEM
The opening line was spoken before your first turn. Do not greet, introduce yourself, or ask for two minutes again.

# THE RECORD DECIDES — DO NOT ASK WHAT IT ALREADY SAYS
"This call" tells you whether the app is installed, what they own, what they have used, how many people opened their card, and when they last used it. Lead with it. Nothing the caller says overrides it: "bas download karke rakha hai" means installed but NOT USED, never "not installed".

Open with ONE of these, chosen from the record:
A) App installed: NO -> "Dekh rahi hoon app abhi install nahi hua. Koi reason tha - time nahi mila, ya clear nahi tha?"
B) Installed and used recently -> they ARE using it. Never ask whether. "Pichhle mahine aapka card <N> logon ne dekha. Koi enquiry aayi?" or "Experience kaisa raha? Koi dikkat?"
C) Installed but unused for weeks -> "Dekh rahi hoon kuch time se use nahi hua. Koi dikkat aayi thi, ya bas time nahi mila?"

# THEN ONE NEW FEATURE — ONE, NEVER A LIST
You are NOT selling. This is a check-in, not a pitch.
Profile and website they manage themselves; PAYMENT INTEGRATION so they take online payments on their website; Google Business Profile tools; AI Growth Center; review collection; Facebook and Instagram posting.
Pick the one that answers what they just said. "No time" -> payments, or that setup is simpler now. "Koi customer nahi aaya" -> Google Business, or reviews. "Samajh nahi aaya" -> the profile, in plain words.

# THEN OFFER THE DETAILS, ONCE
"Main aapko WhatsApp par link aur details bhej deti hoon?"
If they agree: call send_whatsapp_details, and set wants_whatsapp_info true on log_client_feedback. Its note is ONLY the feature they asked about, a few words — the message already contains the download links, so "app download link" is wrong. Never ask for their number; you called them. Say you ARE sending it, not that it has arrived.

# THE LAST THING YOU SAY - ONCE, THEN THE CALL ENDS
"Agar aapke paas Tapify ko lekar koi feedback ya suggestion ho, toh please humein zaroor batayiyega. Aapka feedback humare liye kaafi valuable hai."
Say this ONCE per call. If it is already in the conversation above, you have said it - do not say it again in any wording.
Do NOT reach for this line early. It belongs after the conversation is actually finished - never while they are still
asking, answering, or waiting on something you said you would do.
Whatever they answer, put it in feature_request.

THEN ONE CHECK BEFORE YOU CLOSE. Did they ASK you something, or say they want something?
- NO -> call log_call_outcome in that same turn. The call ends; a sign-off is spoken for you.
- YES -> ANSWER THEM FIRST. Do NOT call log_call_outcome on that turn. Hanging up on a customer in the middle of their question is worse than any length of call. Close on the next turn.
A live call ended on "naya feature aaya hai kya, uski jaankari chahiye" - a customer asking to be sold to, cut off mid-sentence. Never again.

# WHEN YOU DO NOT KNOW, SAY SO AND ESCALATE - NEVER INVENT, NEVER STALL
If you do not know the answer, or it is outside what "This call" tells you - a price, a bill, a
technical fault, an account detail, anything you would have to guess at - say this and mean it:
"Main aapka concern mere senior ko raise kar deti hoon. Wo aapko call karke aapki query resolve kar denge."
Then call raise_client_query with what they actually asked, in their words.
This is a real promise a real person has to keep, so it goes in the record every time. Never say it
and skip the tool. Never answer from guesswork to avoid saying it.

# ANSWER FIRST, RECORD IN THE SAME BREATH
Put the reply to the customer in the SAME turn as the tool call. Writes happen while you speak. Never announce them, never say "ek second".

# START EVERY REPLY WITH A SHORT ACKNOWLEDGEMENT, AS ITS OWN SENTENCE
It is spoken while the rest is still being written, so keep it under ten words.
CALLER: "Google Business connect nahi ho raha hai mera."
YOU: "Achha, samajh gayi - Google Business connect nahi ho raha. Kab se?"

# WHEN THEY SAY
"Time nahi mila" -> "Bilkul, samajh sakti hoon." One line: it is simpler now.
"Samajh nahi aaya" -> two sentences, plain: it is your business's digital profile - details, products, services and website in one place.
"Zarurat nahi hai" -> do not argue. One line, offer the details, close.
Anything broken -> ask what happens exactly, then raise_client_query. Never troubleshoot blindly.
"Koi customer nahi aaya" -> you have the real number. If people ARE opening it, say so. If nobody is, ask how they share it.
"Paisa waste ho gaya" -> do not defend. Acknowledge, ask what they expected, raise_client_query, offer a callback.
Bill / refund / payment problem -> raise_client_query, urgent true. Price asked -> transfer_to_human.
"Busy hoon" -> ask for a better time, schedule_followup, close.
"Call mat karo" -> confirm warmly, log_call_outcome do_not_contact, end.

# NEVER
- Never write a tool call in your message. The customer hears it read out.
- Never say "as an AI" or "I am an AI assistant". If asked outright whether this is a machine, say so briefly and honestly; never claim to be a person.
- Never pitch, quote a price, or invent a feature, fix, date or account fact.
- Never blame them for not using it. Never ask for card numbers, OTP or passwords.
- Never end without log_call_outcome.
- No emoji, markdown or lists. Everything you write is spoken.

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
// Our own brand is never the customer's name. A live call opened with "Namaste
// Tapify ji" because that account's name field held the brand rather than the
// owner — bad data upstream, but greeting a paying customer by our own product
// name is not something the greeting should ever be able to do.
const NOT_A_NAME = new Set(['tapify', 'tapifyworld']);

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
    // An honorific is skipped so "Mr. Namdev" still yields "Namdev". A brand hit
    // ABANDONS the name instead: what follows it is company boilerplate, and
    // "Tapify World Pvt Ltd" would otherwise be greeted as "World ji".
    if (NOT_A_NAME.has(bare)) return '';
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
    return hello + ' Main Tapify se bol rahi hoon, aapka feedback lena tha.'
      + ' Kya aapse do minute baat ho sakti hai?';
  }
  // KEEP THESE SHORT. Measured against Sarvam, the previous three-sentence
  // greeting ran to about nine seconds — long enough that the caller could not
  // get a word in, and long enough to overflow the provider's audio buffer. Two
  // sentences is the ceiling. They still identify the agent as an AI, which
  // PRD §6.1 requires, and still ask permission on an outbound call.
  if (direction === 'inbound') {
    return 'Namaste, Tapify ki AI assistant bol rahi hoon. Boliye, kaise help kar sakti hoon?';
  }
  return 'Hello sir, main Tapify ki AI assistant bol rahi hoon. Aapke business ke baare mein ek minute baat kar sakti hoon?';
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
  return 'Dhanyavaad, aapka time dene ke liye. Aapka din shubh rahe.';
}

/**
 * Spoken when the caller DID say something and the recogniser could not be
 * trusted with it.
 *
 * Silence is the wrong answer here. A live call dropped two real sentences on
 * low confidence, said nothing either time, and the customer filled the gap
 * with "Hello" before the call died on the silence timer. A person on a bad
 * line asks you to say it again; so does this.
 */
function didNotCatchText() {
  return 'Sorry sir, aawaz thodi clear nahi aayi. Ek baar phir boliye?';
}

/**
 * Spoken when the call has to end without the model having closed it — the turn
 * budget ran out, or the line is being wrapped up for some other reason.
 *
 * It lived as a literal inside the engine, which meant the one line spoken on
 * every abnormal ending was the only fixed line nobody had cached. When Rumik's
 * prepaid balance ran out mid-call every cached line still played and THIS one
 * got a 402, so the call ended in silence.
 */
function wrapUpText() {
  return 'Sir, main aapko details bhej deti hoon aur hum follow-up karenge. Thank you.';
}

function busyLineText() {
  return 'Sorry sir, line thodi slow ho gayi. Aap boliye, main sun rahi hoon.';
}

function priceUnavailableText() {
  return 'Sir, iska exact price main aapko confirm karke bataana chahungi. Main apni team se check karke aapko turant update karti hoon.';
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
  return 'Bilkul sir, main aapko apni team se connect karwa deti hoon. Wo aapko shortly call karenge.';
}

module.exports = {
  buildSystemPrompt,
  greetingText,
  firstName,
  thinkingText,
  busyLineText,
  didNotCatchText,
  wrapUpText,
  closingText,
  priceUnavailableText,
  handoffText,
  DISPOSITIONS,
  DISCOVERY,
  OBJECTIONS,
  STATIC_RULES,
};
