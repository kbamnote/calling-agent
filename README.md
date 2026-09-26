# Tapify Voice Agent

The voice runtime for the Tapify AI sales calling agent (PRD §19–21).

**It handles conversation and nothing else.** Products, prices, discounts,
dispositions and lead records live in `salescrm-pro`. This service asks; it never
decides. That separation is PRD §33 and it is the reason a hallucinated price is
structurally impossible rather than merely discouraged.

---

## Run it right now

No API keys. No telephony account. No database.

```bash
cd tapify-voice-agent
cp .env.example .env
npm install
npm run chat
```

Type what a customer would say. `/quit` to hang up, `/cost` for the ledger,
`/transcript` to dump the call.

For voice, use your microphone:

```bash
npm run web
```

Then open **http://localhost:5010 in Chrome or Edge**. The page does speech
recognition and speech output itself via the Web Speech API — free, no key, usable
Hindi. If the mic is blocked you can type instead; the conversation is identical.

```bash
npm run doctor        # what is configured, and does every key actually work
npm test              # 44 conversation-engine checks, no keys, no network
```

---

## Why it can be tested for free

| Layer | Free testing | Production |
|---|---|---|
| **STT** | `browser` — Web Speech API in the tester | `sarvam` (Hindi-first, cheapest) or `deepgram` (streaming) |
| **LLM** | `mock` — scripted, zero cost. Or `gemini` on its free tier for a real conversation | `gemini`, or `openai` against any compatible endpoint |
| **TTS** | `browser` in the tester, `none` in the terminal | `sarvam` or `elevenlabs` |
| **Transport** | terminal, or browser mic | telephony media websocket |
| **CRM** | `CRM_ENABLED=false` — in-memory stubs | `salescrm-pro` `/api/agent/*` |

`mock` exercises the whole pipeline — tool calls, the price-refusal path,
dispositions, budgets, the cost ledger — but it is **not** a language model. Use
it to test plumbing. For real conversation quality, get a free key at
https://aistudio.google.com/apikey and set `LLM_PROVIDER=gemini`.

---

## What the code guarantees, not the prompt

A language model is persuadable. These are enforced in `pipeline/conversation.js`
so no customer pressure and no prompt drift can remove them. Each one has a test
in `src/scripts/testConversation.js`.

- **The greeting costs no LLM call and no TTS call.** Pre-rendered, disk-cached.
- **The connect gate.** The STT and LLM sessions do not open until a human has
  actually spoken. A dial that hits voicemail costs telephony seconds and nothing
  else. On a 30% connect rate this removes AI cost from ~70% of dials — it is the
  single largest saving in the system, and `aiEngaged` in the ledger proves it is
  working.
- **A failed price lookup never becomes a spoken number.** The tool result is
  rewritten with an explicit instruction not to state one, plus a suggested
  reply. This is PRD §7's hard rule, enforced outside the prompt.
- **Every call logs an outcome** — even if the model forgets, the turn budget
  runs out, the line drops or the tab closes (PRD §29).
- **Turn and duration budgets are hard.** A confused call is capped, not endless.
- **Opt-out is checked before the greeting** and honoured without a word spoken.
- **Turns are serialised.** Real STT delivers two finals in quick succession;
  overlapping turns would corrupt the message history.
- **Agent turns are length-capped** at a sentence boundary. If that fires often,
  the persona has drifted — fix the prompt, don't raise the cap.

---

## Layout

```
src/
  config.js                 every env var, read once, all with working defaults
  index.js                  picks a transport
  providers/
    index.js                the registry — swapping a vendor is one .env line
    llm/{mock,gemini,openai}.js
    stt/{browser,deepgram,sarvam}.js
    tts/{browser,none,elevenlabs,sarvam}.js
  pipeline/
    conversation.js         the engine: turns, tools, budgets, guarantees
    persona.js              system prompt, objection library, dispositions
    ttsCache.js             content-hash cache — the greeting is free after once
    vad.js                  energy VAD: the connect gate and barge-in
  tools/
    index.js                the 8 tool definitions + dispatcher
    crmClient.js            -> salescrm-pro /api/agent/*
    localStubs.js           in-memory backend for testing (FAKE prices, labelled)
  transport/
    text.js                 terminal
    web.js                  express + ws + the browser tester
    telephony.js            generic media websocket  ⚠ untested
  cost/ledger.js            per-call vendor units and a rupee estimate
  scripts/{doctor,testConversation}.js
public/index.html           the browser tester
```

Nothing outside `providers/` may import a driver directly. That is what keeps
PRD §21's "change the voice model without rewriting business logic" true.

---

## Tools the agent has (PRD §14)

`get_customer_context` · `create_or_update_lead` · `get_product_catalog` ·
`get_price_quote` · `validate_discount` · `schedule_followup` ·
`transfer_to_human` · `log_call_outcome`

Phase 5 adds `create_quote`, `send_whatsapp`, `create_payment_link`,
`get_payment_status` and `create_order`. They are **deliberately not registered
yet** — an unregistered tool cannot be hallucinated into existence, whereas a
registered-but-stubbed one gets called and half-works.

`get_product_catalog` returns **no prices**, matching the CRM's
`/api/catalog/for-agent` projection. The agent cannot read a number off a list;
it must call the pricing engine. PRD §18.

---

## Wiring the CRM

**The CRM side is built** (`/api/agent/*` in `salescrm-pro`, Phase 2). To run
against it:

```bash
CRM_ENABLED=true
CRM_BASE_URL=https://crm-api.tapify.co.in
AGENT_SERVICE_KEY=<same value as AGENT_SERVICE_KEY on the CRM>
```

Set the same key on the CRM. It is the agent's OWN key, not `CRM_SERVICE_KEY` —
the two bridges are separate so a leak on one does not open the other. Unset on
the CRM side means `/api/agent/*` refuses everything, by design. The key must
never reach a browser.

`npm run doctor` confirms the CRM is reachable before you dial anything.

With `CRM_ENABLED=false` the same tools answer from in-memory stubs, so
conversation work never needs a database.

### What lands in the CRM

A call writes, in order: an opt-out check before the greeting, a lead (merged,
never overwritten), a price from the engine, a discount check, a follow-up parsed
from the customer's own words, a handoff assigned to a named person who gets
notified, and an outcome carrying the transcript, the tool trail and the cost
ledger. Qualification is scored server-side from what actually happened — a
customer who triggered a price lookup scores for buying intent — and a qualified
lead pings managers immediately.

---

## Wiring telephony

`transport/telephony.js` **has never run against a live phone line.** It is
written to the shape Exotel Voice Streaming, Plivo Audio Streams and a raw SIP
media bridge all share — a websocket carrying base64 audio frames in JSON — but
expect to adjust frame field names, sample rate and the answer webhook once you
have credentials. Everything it depends on is tested through the other two
transports, so the risk is confined to that one file.

1. Point the provider's stream/answer URL at `wss://<host>/media`
2. Point its status callback at `POST https://<host>/telephony/status`
3. Set `TELEPHONY_PROVIDER`, and switch `STT_PROVIDER` / `TTS_PROVIDER` to
   server-side drivers — the `browser` drivers refuse to start here, because
   there is no browser on a phone line.

**Prefer per-second billing.** Most dials are short dead ends, so a per-minute
pulse can quadruple the telephony bill on exactly the calls that produce nothing.

---

## Before any outbound dialing

PRD §19 asks the dev team to validate the telecom setup. Concretely: in India,
automated promotional voice calls at scale fall under TRAI's TCCCPA —
telemarketer/DLT registration and DND scrubbing — and cold-dialling scraped lists
is the exposed case.

Start with **inbound**, **Meta Lead Ads leads** (`Lead.fbLeadId` in the CRM proves
consent) and **follow-ups on form submissions**. That is also the cheapest traffic
per qualified lead, so compliance and cost point the same way here. Cold outbound
is a decision for after the registration is in hand.

---

## Cost

`cost/ledger.js` records telephony seconds, STT seconds, TTS characters and LLM
tokens per call, and estimates rupees from the rates in `.env`.

**Those rates are planning estimates, not vendor quotes.** Replace them with
contracted numbers before anyone reports the figures upward. The estimate is for
steering — which campaign is wasteful, is the greeting gate working — never for
accounting.

Three numbers worth watching: `aiEngaged` (did this dial cost any AI at all),
`ttsCacheRate` (how much agent speech was free) and `llmTokensCached` (how much
of the prompt was not re-billed).

---

## See also

`../salescrm-pro/AI_SALES_AGENT.md` — the phase plan, the CRM-side pricing engine,
and the setup steps for the catalogue.
