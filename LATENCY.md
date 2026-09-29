# Conversational latency

The number this document is about:

> **end of the caller's speech → first byte of the agent's audio**

Not "how long the LLM took". That is the silence a caller sits in, and it starts
when they stop talking — not when we finish transcribing them.

---

## How to read it on a live call

Every turn writes one line:

```
b4d4c1#t3 reply in 2190ms [transcript 640ms, llm_first_token 910ms, llm_done 1380ms, tts_first_audio 2185ms, audio_out 2190ms, chunks=2]
```

`b4d4c1#t3` is the correlation id — last six of the call id, then the turn
number. Every stage is milliseconds from end-of-speech. A turn over 2500ms is
tagged `<-- SLOW`.

The same object is emitted as a `latency` session event, so a future dashboard
can consume it without parsing logs.

**Nothing from the conversation is logged here.** No transcript, no number, no
tool arguments, no keys. It is a stopwatch. Call content already lives in the
CRM behind its own access control and does not belong in an application log
nobody audits.

---

## What was changed

| Change | Where | Effect |
|---|---|---|
| **Writes no longer block the reply** | `tools/index.js`, `pipeline/conversation.js` | removes a CRM round-trip **and a whole second model call** from any turn that logs |
| Independent reads dispatched in parallel | `pipeline/conversation.js` | three lookups cost one round-trip, not three |
| Short-acknowledgement first chunk | `pipeline/speechPipe.js`, `persona.js` | the opener is ~23 chars, so it synthesises in ~0.8s instead of ~1.4s |
| End-of-turn window 500ms → 380ms | `transport/telephony.js` | 120ms off every turn |
| Holding line only when genuinely waiting | `pipeline/conversation.js` | "ek second sir" stops landing in front of answers the agent already had |
| Streaming synthesis support | `pipeline/speechPipe.js`, `providers/tts/sarvamStream.js` | audio can start mid-sentence (opt-in) |
| Per-leg instrumentation | `pipeline/turnClock.js` | STT / LLM-first-token / TTS-first-audio / tool time, each measured separately |
| Streaming LLM (SSE) | `providers/llm/openai.js` | reply starts arriving at first token instead of at completion |
| Sentence-level TTS, overlapped with generation | `pipeline/speechPipe.js` | synthesis of sentence 1 runs while the model writes sentence 2 |
| Concurrent synthesis, strictly ordered emission | `pipeline/speechPipe.js` | sentence 2 no longer waits on sentence 1's round-trip |
| Per-turn stopwatch | `pipeline/turnClock.js` | the caller-facing number is measured, not inferred |
| Honest zero point | `transport/telephony.js` | measured from end-of-speech, not from the transcript |
| Early `engage()` | `transport/telephony.js` | the CRM lookup overlaps the STT round-trip on turn 1 |
| Duplicate-transcript guard | `transport/telephony.js` | one utterance can never become two turns |
| Stream stall guard + fallback | `providers/llm/openai.js`, `pipeline/conversation.js` | a silent vendor costs latency, never the call |
| Filler suppressed on streamed turns | `pipeline/conversation.js` | the holding line no longer queues in front of a fast answer |
| Real `clearTimeout` on the filler | `pipeline/conversation.js` | a stale holding line cannot fire over the next turn |
| `TTS_CACHE_DIR` | `pipeline/ttsCache.js` | the cache can survive a deploy on a mounted volume |

No provider was changed. No environment variable was renamed. No paid service
was added. `LLM_STREAMING=false` restores the previous blocking behaviour.

---

## Where things stand against the 0.5–1.0s target

**Not there yet, and the reason is measurable rather than mysterious.** On the
shipped configuration a reply now starts at **~2.35s**, down from ~3.12s. The
two changes that would take it to ~1.46s are both vendor swaps that cost money,
and neither is switched on by default.

```
  shipped default           (Sarvam REST TTS, Sarvam batch STT)    2346ms
  + TTS_PROVIDER=sarvam_stream                                     1818ms
  + streaming STT too       (STT_PROVIDER=deepgram)                1460ms
```

Even at 1460ms the target is not met, because four things happen in series and
three of them belong to vendors:

| | ms | Whose |
|---|---|---|
| VAD end-of-turn window | 380 | ours — tunable, see below |
| STT | 80–450 | vendor |
| LLM to first finished sentence | ~400 | vendor (TTFT dominates) |
| TTS to first audio | 280–800 | vendor |

Reaching 1.0s reliably needs a streaming STT, a streaming TTS, **and** a lower
end-of-turn window — roughly 250ms, which starts cutting people off mid-sentence
on Hinglish. That is a product decision about how often the agent may interrupt
someone, not a code change.

---

## Measured

`npm run test:latency`

**The pipeline is real** — the actual engine, speech pipe, turn clock and
serialisation. **The vendors are simulated**, by drivers that sleep instead of
making a network call. That is deliberate: a harness that dialled Groq and
Sarvam would measure their load that afternoon, cost money per run, and give a
different answer every time, so it could never tell you whether a *code* change
helped.

Simulated timings, calibrated from this deployment's production logs:

| | |
|---|---|
| LLM | 350ms to first token, then 11ms/token (Groq `openai/gpt-oss-120b` measured ~790ms for a two-sentence reply) |
| TTS | 600ms + 8ms/char (Sarvam `bulbul:v3` measured ~2.5s for a full 240-char reply) |
| STT | 450ms (Sarvam `saaras:v3` is a **batch** endpoint — it cannot start until the caller stops) |

Three scenarios, each run twice — once with the old strictly-sequential
behaviour, once as shipped:

```
── plain answer, no tools ──
  before   3124ms    stt 452  llm→1st 564  llm 564  tts→1st 1419
  after    2346ms    stt 450  llm→1st 361  llm 697  tts→1st  803
  SAVED 778ms (25%)

── Google Business connect issue (writes a query + feedback) ──
  before   3984ms    stt 450  llm→1st 566  llm 566  tts→1st 1405  tools 315
  after    2818ms    stt 450  llm→1st 351  llm 666  tts→1st  973  tools   —
  SAVED 1166ms (29%)

── six-turn conversation ──
  before   mean 2640ms   best 2510ms   worst 3113ms
  after    mean 2080ms   best 1948ms   worst 2348ms
  SAVED 560ms per turn
```

Three things to read out of that table:

- **`tools —` on the "after" row of the Google Business case.** The CRM
  round-trip has left the critical path entirely: the reply is spoken while the
  query and the feedback are written.
- **`tts→1st` halves**, from ~1.4s to ~0.8s. That is the short-acknowledgement
  first chunk: a 23-character opener synthesises in a fraction of the time a
  full reply does, and the rest is synthesised behind it while it plays.
- **`llm` gets longer while `llm→1st` gets shorter.** Streaming does not make
  the model faster; it makes the wait start earlier. That is the whole trick.

The six-turn run deliberately uses a **different reply on every turn**. An
earlier version repeated one sentence, the on-disk TTS cache served turns two
onward in 4ms, and both arms looked equally fast — the improvement was real and
the benchmark was hiding it.

**These are not end-to-end call measurements and must not be quoted as such.**
For real numbers, read the `reply in NNNms` lines off a live call.

The harness fails the build if any scenario stops improving, so a regression
that un-overlaps the pipeline cannot land quietly.

---

## Where the remaining time goes

On the streaming run, 2203ms breaks down as roughly:

| | ms | Can it be removed? |
|---|---|---|
| VAD trailing silence | 500 | Tunable, with a real cost — see below |
| STT round-trip | 450 | Only by switching to a streaming STT |
| LLM to first complete sentence | ~510 | Prompt is already modest; see below |
| TTS of that sentence | ~1180 | Vendor floor + length |

### 1. Batch STT — ~450ms, the largest single remaining item

`SARVAM_STT_MODEL=saaras:v3` is a batch endpoint. The request cannot even begin
until the caller stops talking, so its entire round-trip is dead air.

**The driver for the alternative already exists and is already streaming.**
`providers/stt/deepgram.js` is a websocket driver with interim results
(`supportsPartials: true`). Switching `STT_PROVIDER=deepgram` would:

- remove most of the 450ms — the transcript is essentially ready when speech ends;
- enable transcript-driven barge-in (the pipeline currently falls back to its own
  energy VAD, which is why `BARGE_IN_LEVEL` needs hand-tuning per line);
- **cost more, in USD, and read Hindi/Hinglish less well than Sarvam**, which is
  why Sarvam was chosen in the first place.

This was **not** done, because it is a provider switch with a cost and quality
trade-off that is a business decision, not a performance one. Deepgram's Nova
models are billed per minute of audio in USD against Sarvam's INR pricing; the
Hinglish accuracy difference needs a side-by-side on real call recordings before
anyone commits.

### 2. VAD trailing silence — 500ms, tunable

`VAD_SILENCE_MS=500` is how long we wait after the caller goes quiet before
deciding they have finished. It is now correctly counted in the reported latency
(it previously was not), so tuning it will show up in the number.

Lowering it to 350ms would take 150ms off every turn — **and would start cutting
people off mid-sentence**, because real speech dips below threshold between
clauses. That trade is worth making only against recordings of real calls on the
lines you actually dial, not in the abstract.

### 3. TTS — ~1180ms for the first sentence, the vendor floor

Sarvam is ~600ms of fixed overhead plus ~8ms per character. Shorter first
sentences are therefore materially faster. Two options, neither taken:

- **Split the first chunk at a clause boundary** (comma) when the opening
  sentence is long. Gets audio out sooner; risks an audible seam, because each
  chunk is synthesised with its own prosody.
- **`TTS_MIN_CHUNK_CHARS`** (default 40) already governs this. Lowering it
  chunks more aggressively, with the same seam risk.

### 4. HTTP connection reuse — unmeasured, worth doing

Node's built-in `fetch` pools connections with a **4-second** keep-alive. Gaps
between turns in a real conversation are usually longer than that, so most turns
pay a fresh TLS handshake to `api.sarvam.ai` and `api.groq.com` — on the order
of 100-200ms, on the critical path, twice per turn.

Node does not expose its bundled undici to userland, so fixing this needs the
`undici` package as a dependency (MIT, the same library Node already embeds — no
new service, no cost):

```js
const { setGlobalDispatcher, Agent } = require('undici');
setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000 }));
```

Not done here because it adds a dependency and the benefit is estimated rather
than measured. It is the cheapest remaining win and should be measured next.

### 5. Prompt size — measured, not the bottleneck

| | chars | ~tokens |
|---|---|---|
| `sales` system prompt | 4,485 | ~1,120 |
| `client_feedback` system prompt | 5,985 | ~1,500 |
| `sales` tool schemas | 3,829 | ~960 |
| `client_feedback` tool schemas | 2,903 | ~730 |

~2,200 input tokens on a feedback turn. Prefill at that size is tens of
milliseconds on Groq — it is not what makes turns slow, and trimming the persona
to chase it would risk the behaviour the prompt exists to guarantee. Left alone
deliberately.

Worth knowing: the prompt and tool schemas are resent on **every tool round**,
and Groq does not offer prompt caching. Three tool rounds is three prefills. The
`MAX_TOOL_ROUNDS` cap and the identical-tool-call guard already bound this.

### 6. Provider region

The service runs on Railway. If its region is not close to Groq and Sarvam's
endpoints, every one of the four round-trips per turn pays the difference. Worth
checking against the deployment's actual region — cross-region RTT of 80ms
becomes ~320ms per turn here.

---

## Cost note

Synthesis is **speculative**: a sentence is sent to TTS before the engine knows
whether the round is a real answer or a tool call. When it turns out to be a tool
call the audio is discarded, because this persona narrates before reaching for a
tool ("ek minute sir, main check karta hoon") and the engine deliberately does
not speak that.

The waste is bounded to one sentence, and only on rounds where the model narrates
first — the pipe disarms on the first tool-call fragment in the stream. It is
logged at debug (`discarded N speculatively synthesised chars`) and counted in
`pipe.stats().wastedChars`, so it can be seen rather than guessed at.

Discarded audio is still written to the TTS cache, so a repeated narration line
costs nothing the second time.

---

## Knobs

| Variable | Default | What it does |
|---|---|---|
| `LLM_STREAMING` | `true` | Stream replies. `false` restores blocking behaviour. |
| `TOOLS_BACKGROUND` | `true` | Let write tools run while the agent speaks. `false` restores sequential. |
| `TTS_MIN_FIRST_CHUNK_CHARS` | `12` | How short the first spoken sentence may be. Lower = audio sooner. |
| `TTS_MIN_CHUNK_CHARS` | `40` | Smallest *later* chunk worth its own round-trip. |
| `TTS_CACHE_DIR` | `.cache/tts` | Point at a mounted volume to survive deploys. |
| `VAD_SILENCE_MS` | `380` | Trailing silence that ends a turn. Counted in the latency report. |
| `THINKING_FILLER_MS` | `1800` | Ceiling on silence before a holding line. `0` disables it. |
| `SARVAM_MIN_BUFFER` | `25` | Streaming TTS only: chars buffered before audio starts. |
| `SIM_*` | see harness | Simulated vendor timings for `npm run test:latency`. |

---

## The tool change, in detail

This is where most of the saving on a real feedback call comes from, so it is
worth being precise about what is now allowed to happen late.

**Blocking** — the agent cannot say anything useful until these return, so it
waits: `get_client_status`, `get_customer_context`, `get_product_catalog`,
`get_price_quote`, `validate_discount`, `transfer_to_human`, `log_call_outcome`.

**Background** — the agent already knows what it is about to say; the result only
decides whether a row landed: `log_client_feedback`, `raise_client_query`,
`create_or_update_lead`, `schedule_followup`.

A tool is blocking unless there is a clear reason it is not. Getting that wrong
in the safe direction costs latency; getting it wrong the other way makes the
agent speak before it knows a price or a customer's history, which is the one
failure this service exists to prevent.

Safety properties, all enforced in code:

- A background failure is logged and **cannot** interrupt the conversation — it
  would otherwise reject the turn chain and drop the call over a note that did
  not save.
- `end()` awaits every outstanding write, so a call cannot hang up with a
  customer's feedback still in flight.
- The identical-call guard still applies, so a looping model cannot fire the
  same write twice inside a turn.
- The model is told, in the persona, to put the reply in the *same* turn as the
  write. If it emits a tool call with no text, the engine still goes back for a
  real answer rather than leaving the caller in silence.
