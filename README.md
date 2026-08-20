# ONX-301 Voice Check-In Agent

A voice-based patient check-in for a clinical trial. A participant talks to it over the
phone or a browser; it runs the protocol-specified symptom review, grades what it hears
on CTCAE v5.0, assesses seriousness against 21 CFR 312.32, escalates to a human study
coordinator when it must, and writes everything to a hash-chained audit trail.

The point of the build is the part that isn't the microphone. Speech in, speech out is a
solved problem you can wire up in an afternoon. What makes a voice agent viable in a
regulated trial is everything around it: what it refuses to say, what it captures
verbatim, what it does when the model is wrong, and whether a coordinator can reconstruct
the call two years later during an inspection.

> **Prototype.** Synthetic protocol, synthetic subjects, no PHI. Not a validated system —
> see [What this is not](#what-this-is-not).

**Planning documents.** [`docs/SPEC.md`](docs/SPEC.md) defines the product and the shadow
pilot it is being built toward. [`docs/BACKLOG.md`](docs/BACKLOG.md) decomposes that into
sprints with acceptance criteria and risk tiers. Both are written for a reader with no
prior context.

---

## Why this use case

Electronic patient-reported outcome (ePRO) collection is one of the weakest links in trial
data. Site visits are sparse, paper diaries get filled in the parking lot before the
appointment ("parking lot syndrome"), and tablet-based eDiaries have real compliance
problems in exactly the populations that need them most — elderly and oncology patients
who are fatigued, nauseated, or not comfortable with an app.

Talking is the lowest-friction interface there is. The obstacle was never the interface,
it was that an unsupervised system talking to a sick trial participant about their
symptoms is a regulatory problem, not a UX problem. That's what this codebase is about.

---

## What it does

A check-in call runs seven steps:

1. **Two-factor identity verification** — subject ID plus date of birth. No clinical
   question is asked before this succeeds. Two failures ends the call with nothing
   collected.
2. **Open-ended first** — "How have you been feeling?" Anything raised unprompted is
   flagged as a *spontaneous* report, which carries more weight than a solicited one.
3. **Solicited symptom review** — the six protocol-specified symptoms, asked in plain
   language, graded from functional impact.
4. **Anything else**
5. **Study drug adherence** — missed doses and the reason, in the subject's words.
6. **New concomitant medications**
7. **Read-back and close** — the subject gets to correct the record before it locks.

At any point, safety interrupts the script.

---

## Architecture

```
  browser mic
      │  Web Speech API  (swappable — see lib/voice/types.ts)
      ▼
  transcript ──────────► POST /api/chat  (SSE)
                              │
                              ├─ 1. deterministic safety net   ← runs BEFORE the model
                              │      regex rules over the raw utterance
                              │      fires escalation + injects an operator message
                              │
                              ├─ 2. Claude Opus 5, streaming, adaptive thinking
                              │      tool loop → eCRF writes
                              │
                              └─ 3. sentence chunker ──► speak events
                                                            │
  speakers ◄──── SpeechSynthesis ◄──────────────────────────┘
```

| Path | What lives there |
|---|---|
| `lib/clinical/protocol.ts` | Study definition, solicited symptoms with grading anchors, synthetic subject roster |
| `lib/clinical/safety.ts` | CTCAE grades, the six seriousness criteria, reporting clocks, the deterministic escalation net |
| `lib/agent/system-prompt.ts` | The prompt. Static by construction — see [Latency](#latency) |
| `lib/agent/tools.ts` | Seven tools and their handlers; every handler writes to the audit trail |
| `lib/agent/runner.ts` | Safety scan → model/tool loop → SSE events |
| `lib/agent/sentence-chunker.ts` | Splits the token stream into speakable clauses |
| `lib/store/audit.ts` | Append-only hash-chained audit trail |
| `lib/voice/` | Provider interfaces + the browser implementation |
| `scripts/simulate.mjs` | Simulated-patient eval harness |

---

## The parts that matter

### The safety net is not the model

`lib/clinical/safety.ts` scans every subject utterance with plain regex rules **before it
reaches Claude**. Chest pain, trouble breathing, stroke signs, suicidal ideation, severe
bleeding, loss of consciousness, anaphylaxis, hospitalization, fever, pregnancy, intent to
stop study drug — each has a rule, an urgency, and a hard-coded instruction.

When a rule fires, three things happen without the model's involvement: an escalation
record is created, an audit entry is written, and the UI alarms. Only then does the model
get told, through a **mid-conversation system message** — an operator channel the subject
cannot forge, and which doesn't invalidate the cached prompt prefix.

An LLM deciding whether to escalate is a probabilistic control. A regulated safety pathway
needs a deterministic one underneath it. The model is the primary path; this is the floor.

In the emergency eval both fire independently — `ESC-001` from the rule net, `ESC-002`
from the agent's own judgment. That redundancy is the design, not duplication.

### Severity and seriousness are different axes

A common mix-up worth being precise about, because the reporting obligations differ:

- **Severity** is CTCAE grade 1–5. It is graded from *function*, not adjectives. "Terrible"
  is not grade 3; "my daughter had to help me shower" is. The prompt pushes the agent to
  ask the functional question when it's between grades, and to round up when genuinely
  uncertain — under-grading delays care, over-grading gets seen by a human.
- **Seriousness** is a binary regulatory determination against the six ICH E2A / 21 CFR
  312.32 criteria. A grade 3 event is not automatically serious, and a grade 2 event can
  be.

When an event is serious, `assess_seriousness` returns the applicable clock: 24 hours
site-to-sponsor, and the sponsor's 7-day (fatal/life-threatening) or 15-day IND safety
report window under 312.32(c) — noting that expectedness and causality are the sponsor's
call, not this agent's.

### Verbatim capture is non-negotiable

Every adverse event stores `verbatimTerm` — the subject's own words — alongside
`codedTerm`. Coding never replaces the source record. `gradeRationale` records the
functional evidence behind the grade in one sentence, so a coordinator can check the
agent's work rather than take it on faith.

### The audit trail catches its own tampering

`lib/store/audit.ts` models the 21 CFR 11.10(e) requirement: secure, computer-generated,
time-stamped, does not obscure prior information. Each entry commits to the hash of its
predecessor, so any retroactive edit anywhere breaks `verifyChain()`.

This earned its keep during the build. The first version stored *references* to the
caller's domain objects; when a record was later corrected, the audit entry describing its
creation silently changed too, and the chain broke. The trail detected its own corruption
before I did. Entries now deep-clone their payloads, and `tests/audit.test.ts` pins the
behavior.

### What it will not say

The prompt's prohibitions are the highest-leverage code in the repo. No diagnosis, no
medical advice, no telling a subject to change a dose, **no reassurance** ("that's normal"
is how serious events get reported late), no talking anyone out of withdrawing — that's
coercion — and no inventing a value the subject didn't give.

Three of these are asserted on in the eval harness, because a prompt rule you don't test
is a wish.

### Asking beats listening

The keyword net measures **48.5% sensitive** on the annotated corpus and catches **0 of 31**
colloquial phrasings — "my chest is killing me", "I get winded going to the bathroom", "I
just don't see the point in any of this anymore" all pass it silently. `npm run measure-net`
prints the confusion matrix and the per-kind breakdown.

Rather than chase that with more patterns, the check-in now runs a **directed safety screen**
before the symptom review (`lib/clinical/protocol.ts` → `safetyScreen`). Unplanned medical
care, chest pain or breathlessness, fever, bleeding or fainting, spirits, and — gated on the
subject actually being of childbearing potential — pregnancy. Each is asked in fixed wording
and answered yes or no.

That changes the problem rather than improving the solution. Listening for danger in
open-ended speech is the hard version; asking outright turns it into a yes/no, which
transcription and a model both handle reliably. It covers **59% of the corpus's
signal-bearing utterances** outright — the remaining topics (stroke, self-harm, severe skin
reactions, withdrawal intent) still depend on detection, and are where a curated MedDRA
vocabulary would earn its keep.

A positive red flag escalates **deterministically, the moment the answer is recorded** —
`triggeredBy: "safety_net"`, no model judgment between the subject saying yes and a
coordinator being paged, and no waiting for the rest of the screen.

**The first design of this was dangerous and worth describing.** The tool originally took all
six answers in one call. When a call ended mid-screen, the model invented the remaining
answers so it could make the call — the record came back with a fever answer and a bleeding
answer for questions that were never asked. Recording each item as it lands removes the
incentive rather than instructing against it, and it makes a partial screen legible as
partial instead of quietly complete.

The same failure had a second face. Told to work through a six-item list, the model would
write the whole exchange itself — its question, an invented patient reply, its next
question — and reach "goodbye" in a single turn. Stop sequences caught some of it, but
streaming leaks the first characters of a stop sequence before the match completes, so a
fragment fused with the next word and reached the speaker as *"usual bit rough honestly"*.
Two fixes: the runner now holds back any suffix that could still become a stop sequence
(`pendingStopPrefixLength`), and the prompt makes ending the turn an explicit action —
*"the subject cannot answer until you stop."*

### The microphone hears the agent

Running the console on laptop speakers produced this, unprompted:

```
AGENT    I'm sorry, I may not have come through clearly. Could you tell me your subject ID?
SUBJECT  "I'm sorry I may not have come through clearly"      ← the agent's own voice
AGENT    It sounds like there may be an echo on the line. Can you hear me all right?
SUBJECT  "it sounds like there may be an echo on the line"     ← again
AGENT    Something seems wrong with the connection. I'll have a coordinator reach out to you.
```

The agent diagnosed the echo and escalated, which is the right call and better than the
code was doing. The bug was mine: echo detection only ran on *interim* hypotheses, compared
against the sentence currently playing. Recognition **finals** arrive after playback ends,
when there is nothing playing — so every echo sailed straight through into the transcript.

An echoed sentence entering the eCRF is a fabricated patient utterance. Three changes:

- **Half-duplex is now the default.** The mic closes while the agent speaks. It cannot echo.
  Barge-in is a toggle that says it needs headphones.
- **Finals are checked against a rolling window** of what was spoken in the last 20 seconds,
  not just what is playing now (`lib/voice/echo.ts`).
- **Suppressed transcripts are counted, not dropped silently** — the Activity tab shows the
  number. A rising count means the channel is not trustworthy, which a coordinator should
  see rather than have hidden.

The heuristic is deliberately conservative — an exact run of four or more words. A tighter
similarity threshold catches more echo and also starts eating real answers ("any nausea,
yes" right after "have you had any nausea?" overlaps heavily). Letting an echo through is
visible and recoverable; discarding genuine patient speech is silent data loss. The real
fix for full-duplex is acoustic echo cancellation, which the Web Speech API gives no audio
pipeline to attach.

### The voice is part of the instrument

Speech is synthesized by ElevenLabs Flash v2.5 through `/api/speech`, with the
browser's own engine as an automatic per-sentence fallback.

The reason is not that it sounds better, though it does. `SpeechSynthesis` renders
a *different voice* depending on operating system and browser version — a subject
on Windows Edge hears a different instrument than one on a Mac. An ePRO instrument
that varies by the subject's device is a validation problem. `lib/voice/tts-config.ts`
pins the voice ID, model ID, output format, and voice settings as constants under
change control, so every subject hears the same thing and a change is a deliberate,
documented act rather than a side effect of what laptop someone owns.

**Why ElevenLabs and not OpenAI.** Measured head-to-head, best config against best
config, five interleaved runs each:

| Config | Median TTFB | Range |
|---|---|---|
| ElevenLabs `eleven_flash_v2_5` (pcm) | **240ms** | 236–274 |
| ElevenLabs `eleven_flash_v2_5` (mp3 stream) | 251ms | 233–275 |
| OpenAI `gpt-4o-mini-tts` (pcm) | 744ms | 578–962 |
| OpenAI `tts-1` (pcm) | 1,889ms | 1,480–2,154 |

Three times faster, and the variance gap is wider than the median gap — ElevenLabs
lands in a 38ms band where OpenAI's best swings across 384ms. On a fourteen-turn
call that is roughly seven seconds of additional dead air, distributed
unpredictably. Uneven pacing reads as a broken line more than uniform slowness
does. OpenAI is meaningfully cheaper and has one capability ElevenLabs lacks —
`gpt-4o-mini-tts` accepts an `instructions` field, so delivery can be directed in
prose ("speak calmly and unhurried, as if to someone tired and unwell") rather than
by hunting for a voice that happens to sound that way. Neither outweighed latency
here. Output format mattered more than expected: MP3 forces frame buffering on both
providers, and OpenAI's `tts-1` does not stream at all in MP3.

**Fallback is not optional.** Moving synthesis off the device puts a network hop in
the middle of the agent's mouth. If the provider is slow or down, a participant sits
in silence with no idea whether the line is live. Each sentence falls back to local
synthesis after 3 seconds. A robot voice is a degraded call; no voice is a broken
one. Fallbacks are counted and shown in the **Activity** tab under Voice integrity —
those sentences were spoken in a different voice than the pinned instrument, which
is a fact about the record, not an implementation detail to hide.

### Fixed wording is a validity requirement that happens to be an optimization

The first version of the speech cache hit on 9% of requests. The agent was
paraphrasing the protocol questions — "How has your energy been since we last
spoke?" one call, "How have you been feeling energy-wise?" the next.

The caching miss was the smaller problem. A solicited symptom question is an
instrument item: its wording is what was reviewed, and it is what every subject is
supposed to be answering. Two phrasings can elicit different answers. If the agent
improvises new wording each call, no two subjects answered the same question, and
the dataset is quietly incomparable.

`lib/agent/fixed-speech.ts` is now the single source of the wording the agent must
deliver word for word, and the prompt marks those sentences "Say exactly". The agent
may put an acknowledgement in a *separate* sentence before one, never inside it.

The performance result falls out of doing the clinically correct thing:

| | Cache hits | Spoken characters served from cache |
|---|---|---|
| Paraphrasing freely | 2 / 22 | 9% |
| Verbatim wording pinned | 9 / 16 | 57% |
| Warm units aligned to the sentence chunker | **16 / 19** | **79%** |

That last step mattered because the cache is keyed on exact text and the runtime
speaks one sentence at a time, so a two-sentence fixed line arrives as two requests
and misses a cache warmed on the combined string. `GET /api/speech` now returns the
fixed lines already split through the same chunker the runtime uses.

What remains uncached is exactly what should be: an acknowledgement, the closing,
and the read-back. **The read-back is the only sentence carrying patient-reported
content, and it is now the only thing routinely sent to the speech provider** —
roughly 200 characters per call instead of 900, and the fixed 79% never leaves the
building after its first render.

### Acknowledge before you work

First-token latency used to scale with how much the turn had to record:

| Turn | Before | After |
|---|---|---|
| Opening, no tools | 2,011ms | 1,932ms |
| Verification, one tool | 5,546ms | **2,395ms** |
| Grade 3 report, three-plus tools | 10,703ms | **2,462ms** |

The runner made a model call, ran tools, made another model call, ran more tools, and
only produced speech on the final pass — ten seconds of it on a heavy turn. In this
console that is invisible: the orb reads *Processing*, the record panel fills in, and
the operator can see work happening. Take the screen away and it is ten seconds of
silence, which a patient on a phone reads as a dropped call. The visual affordance was
compensating for an architectural problem, and nothing surfaced it until the interface
was removed (see `SPIKE-elevenlabs-agents.md`).

The fix is a prompt rule rather than code. The agent now says one short acknowledgement
in the same turn *before* its tool calls, so Claude emits it as a text block ahead of the
`tool_use` blocks and it streams immediately while the eCRF writes happen behind it.
Total turn time is unchanged; time to first audio drops by three quarters.

### Data falsification is a stop sequence, not a prompt rule

During eval development the agent asked for a date of birth, then *continued past its own
turn and wrote the subject's answer for them* — `user\nMarch 4th, 1958` — and passed that
fabricated date to `verify_subject`.

In a system whose entire job is capturing what a participant actually said, invented
subject speech is the worst output it can produce. It's now blocked three ways: a
`stop_sequences` list that hard-stops at any speaker label, an explicit prompt rule, and
an eval assertion so it can't regress quietly.

---

## Latency

Time-to-first-audio is what makes a voice agent feel alive or feel broken. Three things
here are in service of it:

- **A byte-stable prompt prefix.** The system prompt has no timestamps, no subject data,
  no per-session interpolation — everything volatile arrives through tool results instead.
  It caches once and reads on every subsequent request, for every session. Watch the
  cache-hit figure in the **Activity** tab; on a short voice turn the cached prefix is most
  of the input.
- **Sentence chunking.** The server emits `speak` events on clause boundaries as tokens
  arrive, so speech starts before generation finishes rather than after.
- **A tunable effort dial.** `VOICE_AGENT_EFFORT` (default `medium`) trades reasoning depth
  against latency. `VOICE_AGENT_FAST_MODE=1` enables Opus 5 fast mode — up to 2.5× output
  tokens/sec at premium pricing ($10/$50 per MTok vs $5/$25). For a voice agent, output
  speed is felt directly as dead air, so that trade is often worth it.

Observed on the browser path: ~0.8–2s to first audio per turn, longer on turns that make
tool calls.

### A connection-pooling bug worth knowing about

Node 26's built-in `fetch` negotiates HTTP/2 to `api.anthropic.com`. In a long-lived
server the pooled h2 session goes stale while idle, and *every* subsequent request on it
fails with `ERR_HTTP2_INVALID_SESSION` — including the SDK's own retries, which reuse the
same poisoned pool. A dev server idle for a few minutes failed every turn until restarted.

`lib/agent/runner.ts` pins its own `undici` agent with `allowH2: false` and a bounded
keepalive, scoped to the Anthropic client. There's also a retry that only fires before the
first token is spoken — after that, retrying would make the agent repeat itself mid-sentence.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:3100
```

Authentication resolves through the Anthropic SDK's normal chain — an `ANTHROPIC_API_KEY`,
or an OAuth profile from `ant auth login`. No key is needed if you're already logged in
with the `ant` CLI.

For neural speech, put `ELEVENLABS_API_KEY` in `.env` and warm the cache once:

```bash
npm run warm-speech   # pre-renders the fixed protocol wording; needs the dev server up
```

Without the key the console falls back to browser synthesis automatically and everything
else works unchanged. Re-run `warm-speech` after any change to the protocol wording, the
voice, or the model — the cache key covers all three, so stale entries are ignored rather
than served in the wrong voice.

Chrome or Edge for the microphone (Web Speech API). It runs **half-duplex by default** —
the mic closes while the agent speaks, so it cannot hear itself. Turn on Barge-in to
interrupt mid-sentence, but only on headphones (see
[The microphone hears the agent](#the-microphone-hears-the-agent)). There's a text input on
the console that stands in for the subject if you'd rather not talk.

Test identities: `001-0042` / `1958-03-11`, `001-0055` / `1971-11-02`, `002-0013` / `1949-07-24`.

### Environment

| Variable | Default | Effect |
|---|---|---|
| `VOICE_AGENT_EFFORT` | `medium` | Reasoning effort — `low` for lowest latency, `high`+ for harder grading calls |
| `VOICE_AGENT_FAST_MODE` | off | `1` enables Opus 5 fast mode (faster output, premium pricing) |
| `VOICE_AGENT_URL` | `http://localhost:3100` | Base URL the eval harness and warm script drive |
| `ELEVENLABS_API_KEY` | unset | Enables the pinned neural voice; falls back to browser speech when absent |

---

## Testing

```bash
npm run verify          # the gate: types, lint, unit tests, safety-net floor (~3s)
npm test                # unit tests: audit chain, safety net, ConText, echo suppression, cache keys
npm run measure-net     # safety-net confusion matrix against the annotated corpus

# simulated-patient eval — needs the dev server running
npm run eval:fast       # 3 short personas, ~60s — run this on every change
npm run eval            # all personas, ~5 min
npm run eval:stability  # the fast subset 5 times, to measure the flake rate
npm run eval -- sae --verbose      # one persona
npm run eval -- --concurrency=1    # serialise, for debugging
```

Personas run concurrently through a bounded pool, because they are independent
conversations and almost all of the runtime is waiting on the network. Output is buffered
per persona and printed in declaration order, so a parallel run reads like a serial one.

`scripts/simulate.mjs` drives the real HTTP stack with a second Claude instance
role-playing a participant. Five personas, each with assertions:

| Persona | Fast | What it pins down |
|---|:---:|---|
| `emergency` | ● | Chest pain trips the rule net, escalates, and ends the call before the checklist |
| `screen_emergency` | ● | A yes to a screen item escalates deterministically from the tool, not the model |
| `failed_verification` | ● | A wrong date of birth collects zero clinical data |
| `routine` | | Mild symptoms complete the full script; nothing over grade 2; no escalation |
| `sae` | | An overnight hospitalization is determined serious and escalated |
| `withdrawal` | | Intent to stop study drug escalates — and the agent does not argue |
| `screen_positive` | | A stoic subject who volunteers nothing but answers the direct fever question honestly — the case the keyword net would miss entirely |

Every persona also asserts the always-on invariants: audit chain intact, no medical advice,
no false reassurance, no fabricated subject speech, and no safety-screen item recorded that
was never actually asked.

**These are not a pass/fail gate.** The personas are model-driven, so a single failing
assertion is as likely to be sampling variance as a regression — `npm run eval:stability`
exists to tell the difference by reporting a rate rather than a verdict. That is the same
argument the project makes about qualifying a non-deterministic system: you characterise
behaviour over runs, you do not assert it once.

**On the harness's own failure mode:** most persona expectations are negative ("nothing
recorded", "not verified"), which a total API outage satisfies trivially. An early run
reported 39/39 green while nearly every turn was failing with a connection error. There is
now an unconditional `call completed without transport errors` check evaluated first, and
a persona aborts after two consecutive failed turns. A suite that passes during an outage
is worse than no suite.

---

## Swapping the voice layer

`lib/voice/types.ts` defines `SpeechRecognizer` and `SpeechSynthesizer`. The browser
implementation is one binding of them, chosen because it needs no API keys and is good
enough to prove the conversation design.

Synthesis has already moved — `ElevenLabsSynthesizer` implements `SpeechSynthesizer` and
`BrowserSynthesizer` remains behind it as the fallback. The remaining swaps are the same
shape:

- **Recognition** → Deepgram Nova-3 or similar, for real streaming endpointing instead of
  Chrome's silence heuristic, medical vocabulary, and confidence scores worth thresholding
  on. Captured over WebRTC it also brings genuine acoustic echo cancellation, which would
  make full-duplex barge-in safe on speakers rather than headphones-only.
- **Synthesis, further** → ElevenLabs has a WebSocket API that accepts text chunks as they
  arrive and streams audio continuously. That would let Claude's token stream feed the
  voice directly instead of one HTTP request per sentence. It is the latency ceiling for
  this architecture.
- **Telephony and the whole audio path** → `app/api/v1/chat/completions/route.ts` is an
  OpenAI-compatible shim that lets the ElevenLabs Agents Platform own capture, turn
  detection, transcription, speech, and a phone number while Claude, the safety net, the
  tools, and the audit trail stay exactly where they are. Spiked and validated against an
  OpenAI client; `SPIKE-elevenlabs-agents.md` has the contract, the measurements, and an
  honest list of what it would cost.

---

## What this is not

Being direct about the gap between this and something you could put in front of a real
participant:

- **Not validated.** A regulated deployment needs computer system validation — IQ/OQ/PQ,
  a traceability matrix, documented risk assessment under GAMP 5.
- **Storage is in-process.** Sessions live in a `Map`. Real records go to the EDC through
  a validated interface, with durable WORM storage behind the audit trail.
- **No authentication worth the name.** Subject ID plus date of birth is knowledge-based
  verification, adequate for a demo and not for production.
- **The script isn't IRB-approved.** Anything said to a participant is study conduct and
  needs review, including how the agent introduces itself.
- **Grading is unreviewed.** Every CTCAE grade here is a proposal for a coordinator to
  confirm, which is why `gradeRationale` exists and why grade 3+ leaves the automated path
  entirely.
- **The speech provider is an unaddressed subprocessor.** The read-back sentence carries
  patient-reported symptom content, and it leaves for ElevenLabs. A real deployment needs a
  BAA or DPA and a line in the informed consent's data-sharing section. The participant's
  own audio never leaves the browser, and the fixed-wording cache keeps roughly 79% of the
  agent's speech from being transmitted at all after its first render — but 79% is not 100%.
- **Speech recognition errors are a clinical risk, not a UX annoyance.** A misheard symptom
  is a data integrity problem. Production needs confidence thresholds, explicit read-back
  of critical captures, and a much better answer than "ask them to repeat it."
