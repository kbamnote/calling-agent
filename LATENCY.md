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

Result on a 161-character, two-sentence reply:

```
  stage             blocking   streaming
  transcript         452ms      450ms
  llm_first_token   1148ms      817ms
  llm_done          1148ms     1313ms
  tts_first_audio      —      2202ms
  audio_out         3054ms     2203ms

  audio chunks reached the transport at
    blocking   3054ms
    streaming  2203ms, 2619ms

  END-OF-SPEECH TO FIRST AUDIO
    blocking   3054ms
    streaming  2203ms
    saved      851ms  (28%)
```

The second row matters as much as the first. With sequential synthesis chunk 2
would have landed around 3500ms — after chunk 1 finished playing in the
simulation, which a caller hears as the agent stopping mid-thought. Concurrent
synthesis puts it at 2619ms.

**These are not end-to-end call measurements and must not be quoted as such.**
For real numbers, read the `reply in NNNms` lines off a live call.

The harness fails the build if streaming is not faster, so a regression that
un-overlaps the pipeline cannot land quietly.

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
| `TTS_MIN_CHUNK_CHARS` | `40` | Smallest chunk worth its own TTS round-trip. |
| `TTS_CACHE_DIR` | `.cache/tts` | Point at a mounted volume to survive deploys. |
| `VAD_SILENCE_MS` | `500` | Trailing silence that ends a turn. Now counted in the latency report. |
| `THINKING_FILLER_MS` | `1400` | Holding line. Suppressed on streamed turns; still covers tool rounds. |
| `SIM_*` | see harness | Simulated vendor timings for `npm run test:latency`. |
