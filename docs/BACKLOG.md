# Backlog

Working document for a semi-autonomous build toward the shadow pilot defined in
[SPEC.md](SPEC.md). **Written for a session with no memory of the conversation that
produced it** — every item carries its own context.

## How this works

**Risk tiers govern how much I do before checking in.**

| Tier | Scope | Working mode |
|:---:|---|---|
| **A** | Plumbing, infrastructure, tooling, docs | I work through the whole sprint, run the gate, report against acceptance criteria |
| **B** | The safety net, escalation, the eCRF write path, anything a participant hears | One item at a time. I build it, prove it, and stop for review before the next |
| **C** | Decisions, credentials, documents needing clinical or regulatory judgement | Ian's. I draft, never decide |

Tier B exists because of measured history, not caution. Four bugs in this codebase reached
"working" and were caught only by running something: a batch tool that made the model
invent answers to unasked questions; a negation layer that disarmed the self-harm rule; an
eval suite that reported all-green during a total outage; stop sequences that leaked
fabricated speech to the loudspeaker. All four were in safety-critical code and all four
arrived disguised as improvements. Reading the diff would not have caught any of them.

**No item starts before its acceptance criterion exists as something runnable.** Where an
item's criterion is a judgement rather than a check, it is Tier C by definition.

**The gate.** `npm run verify` — types, lint, unit tests, and the safety-net floor. Green
before any item is called done. `npm run eval:fast` on anything touching the conversation;
full `npm run eval` at sprint close.

**Status:** `todo` · `wip` · `blocked` · `done` · `dropped` (with a reason)

---

## Sprint 0 — Foundations and change control

*The instrument has to know what it is before anything else is worth building.*

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 0.1 | `npm run verify` gate: types + lint + tests + net-sensitivity floor | A | Command exists, fails on a deliberately broken build | **done** |
| 0.2 | Single pinned-version module: model, voice, TTS, STT, prompt hash | A | One import; no version string elsewhere in the codebase | todo |
| 0.3 | Version manifest written into the audit trail at session open | A | Every session's trail records which instrument produced it | todo |
| 0.4 | Change-control note: what re-qualification a version bump requires | C | Reviewed by Ian | todo |
| 0.5 | Net-sensitivity regression floor in `verify` | A | A pattern change that drops sensitivity fails the gate | **done** |

**Why first.** §7 of the spec turns on being able to say which instrument produced a given
record. Right now a record cannot answer that question, and every later sprint makes the
gap more expensive to close.

---

## Sprint 1 — Durability and recovery

*Nothing else matters if a restart loses a reported adverse event.*
**Blocked on D-1 (database choice).**

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 1.1 | Session store behind a persistence interface | A | Existing tests pass unchanged against the new backing | **done** |
| 1.2 | Database-backed implementation | A | Kill the server mid-call; the session resumes intact | **done** |
| 1.3 | Audit trail persisted append-only | B | Chain verifies across a restart; no update path exists in the schema | **done** |
| 1.4 | Mid-call recovery on redial | B | A dropped call resumes with prior captures present | **done** |
| 1.5 | Idempotency keys on every eCRF write | B | Replaying a turn produces no duplicate event | **done** |
| 1.6 | Retention and legal-hold posture documented | C | Reviewed | **done — [RETENTION.md](RETENTION.md), decided and partly built** |
| 1.7 | **Verbatim provenance check on every eCRF write** | B | A tool call whose verbatim text does not appear in the subject's actual transcript is rejected | **done** |
| 1.8 | Versioned migrations | A | Schema changes are ordered and replayable, not idempotent DDL | **done** |

---

## Sprint 2 — Escalation delivery

*Until this ships, the system records that a coordinator was notified — a claim it cannot
support. This is the hard prerequisite for any call with a real participant.*
**D-2 decided 2026-08-21: email via Resend, acknowledgement by signed link, alarm on non-ack.**

Every item here is Tier B.

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 2.1 | Real delivery to the chosen destination | B | An escalation produces a message a human receives | **done — verified against a real inbox** |
| 2.2 | Acknowledgement tracking | B | Delivery status is on the record; unacknowledged is visibly distinct | **done** |
| 2.3 | Retry, secondary contact, alarm on non-ack | B | Simulated non-ack raises an alarm within SLA | **done — verified live** |
| 2.4 | Locale-aware emergency and crisis numbers | B | Non-US locale yields correct numbers; test covers it | **done** |
| 2.5 | Delivery failure is itself an escalation | B | A failed send is loud, never silent | **done** |
| 2.6 | On-call model and SLA documented | C | Site agreement | **done — [ONCALL.md](ONCALL.md), decided and built** |

---

## Sprint 3 — Safety coverage

*Sensitivity was reported as 51.4% against a 123-utterance corpus. Measured against an
honest 473-utterance one it is **27.0%** — the net did not change, the ruler did. MedDRA is
unavailable, so the lever is the directed screen, which is a script change and not a licence.*

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 3.1 | Extend the screen to stroke, self-harm, severe skin reaction, withdrawal intent | B | Screen covers 100% of signal-bearing corpus topics | **done — 3 of 4 added; self-harm left as an open probe, deliberately** |
| 3.2 | Measure the length/coverage trade-off | B | Turn count per call reported; participant burden explicit | **done** |
| 3.3 | Corpus grown to ≥300 utterances, sourced not invented | B | Coverage per topic reported; no topic under 15 | **done — 473, min 18 per topic** |
| 3.4 | Track net sensitivity over time | A | `measure-net --history` shows the trend | **done** |
| 3.5 | Ongoing fabrication measurement | B | Every eval run reports a fabrication rate, not a pass/fail | **done** |

**Discipline for 3.3:** do not author corpus entries to match the patterns. The corpus is
only useful while it stays an honest sample of speech the net has never seen. Entries
should come from observed simulated-patient output and from clinical phrasebooks, not from
reading the regexes.

---

## Sprint 4 — The ears

*The last free-and-bad component. A misheard symptom is a data-integrity problem, not a UX
annoyance.*
**D-3 decided 2026-08-24: Deepgram Nova (`nova-3-medical`).**

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 4.1 | Streaming recogniser behind the existing interface | A | Swap is config; no call-site changes | **done — server relay, verified end to end locally. The duplex-POST shape is unverified on Vercel: see 4.6** |
| 4.2 | Per-word confidence surfaced | A | Confidence present on every transcript | **done** |
| 4.3 | Low-confidence symptom terms trigger read-back | B | Below threshold, the agent confirms before recording | **detection built; the agent read-back is the remaining half** |
| 4.4 | WebRTC capture with echo cancellation | A | Barge-in works on speakers; echo suppression count stays zero | **built, unverified — needs a browser and a speaker** |
| 4.5 | Transcription accuracy measured on clinical vocabulary | B | Word error rate on a symptom-term set, reported | **done — 0.9% WER, 100% term recall on synthetic speech** |
| 4.6 | Confirm the relay survives the deployment target | A | A preview deployment transcribes a real utterance end to end | **open — the local Node server streams a duplex POST body; whether Vercel's Node functions hand the handler an unterminated request body, or buffer it first, has not been tested. If they buffer, the relay never receives audio and the shape has to change to a WebSocket route. `maxDuration` is now set, and the relay caps its own session below it so the platform cannot kill it mid-stream.** |
| 4.7 | The net does not match past-tense haemoptysis | B | "coughed up blood" escalates the way "coughing up blood" does | **open, found 2026-08-24 — Tier B, not changed without review. Measured, not guessed: real audio through the relay produced "I coughed up blood on Tuesday morning…", and `scanForSafetySignals` returns no bleeding hit for it. `lib/clinical/safety.ts:262` matches `\bcoughing up blood\b` only. The whole utterance still escalated, but on the fever rule — the blood was invisible to the net. Consistent with the 27.0% sensitivity and 0/81 colloquial finding; the general fix is the directed screen, not another tense in the regex.** |

---

## Sprint 5 — Observability and QA

**Baseline conditions are invisible to the deterministic escalation path.** They reach the
model as prose and nothing else, so a red-flag screen item escalates on a truthful answer
about a known condition — a participant whose baseline is "Migraine with aura" answering
yes to sudden numbness and a bad headache. Sprint 3 patched the one instance by wording the
stroke item as a change from baseline, which is how a clinician asks it and is not a fix for
the general case. Anything that escalates deterministically should be able to see what is
already known about the person.


*The pilot's whole purpose is generating evidence. This is the instrumentation that
produces it.*

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 5.1 | Coordinator review queue with per-call replay | A | A coordinator can review a call and its record together | todo |
| 5.2 | Drift monitoring: grade distribution, escalation rate, confidence | A | Weekly trend; a shift is visible | todo |
| 5.3 | Reconciliation export against the existing eDiary | A | Per-participant comparison file | todo |
| 5.4 | Latency measured at p50/p95 | A | N-01 verifiable rather than asserted | todo |
| 5.5 | Review-rate rationale documented | C | Reviewed | todo |

---

## Sprint 6 — Pilot readiness

*Mostly not code. I draft; clinical and regulatory judgement is Ian's.*

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 6.1 | Shadow pilot protocol: scope, endpoints, exit criteria | C | Site and sponsor agreement | todo |
| 6.2 | Data flow and subprocessor map | C | Every hop and its agreement status | todo |
| 6.3 | User requirement specification, traced to SPEC.md | C | Traceability matrix complete | todo |
| 6.4 | Risk assessment in a recognised format | C | Reviewed | todo |
| 6.5 | Consent language covering AI, recording, subprocessors, human alternative | C | IRB submission ready | todo |
| 6.6 | Alternate modality for F-21 | C→A | Design agreed, then built | todo |

---

## Closed — the model speaks as the subject, and stop sequences did not stop it

**Diagnosed and fixed 2026-08-21.**

The agent asks a question and, instead of stopping, writes the answer it expects
and carries on — its reply, another question, another answer. In the worst round
observed, a single turn contained the rest of the call. **Nothing the subject
"said" in that stretch passed through the deterministic safety net, because the
subject never said it.** That round recorded two adverse events and the net never
fired.

`stop_sequences` were the existing defence and they are the wrong shape of
control for this. They match exact strings; the model produces near misses. Four
captured from raw deltas in one six-round run:

```
"...since we last spoke?\n\nuseleven Pretty rough, honestly."
"...since we last spoke?\n\nuseparse_ai_response\nPretty rough,"
"...since we last spoke?\n\nuseKind of a mixed bag."
"...happened again since Saturday night?\n\nusen0, just that once"
```

None is `"\nuser"`, so none stopped anything. Earlier rounds produced `usual`,
`useh`, `useful`, `useard` — the same failure in a different spelling each time,
which is why patching the list kept appearing to work and kept not working.

Two things were wrong beyond the leak itself. The half-matched prefix `use` was
released to the speaker, because the hold-back only knew about exact sequences.
And the fabricated text was pushed into `session.messages` verbatim, so on the
next turn the model read its own invention as established fact — that is how one
invented line became an invented call.

**Fixed structurally, not with a longer list.** Every instance shares a shape: a
blank line, then a new speaker. `lib/agent/turn-boundary.ts` cuts there. The
agent has no legitimate reason to emit a blank line — it is told to speak one or
two sentences with no lists, headings or markdown, and everything it produces is
read aloud, where a blank line means nothing. From the boundary on, the text is
never spoken, never entered into history, and any tool call after it is dropped
unexecuted rather than trusted; the turn then ends, because the next thing that
belongs in the call is the subject answering. Each cut writes a `TURN_TRUNCATED`
audit entry, so the behaviour is observable in production instead of silent.

| | rounds clean |
|---|---|
| before | emergency 2/6 |
| after | **15/15** across all three fast personas, 0 failing assertions |

Across 8 rounds the control fired **6 times** with zero fragments reaching the
speaker. The model still attempts this constantly — the attempts are its
behaviour, and the fix contains them rather than removing them, which is why the
eval now reports the containment count instead of asserting it to zero.

**The first version of this fix was worse than the bug in one respect**, and
review caught it. Matching a bare `\n\n` meant a turn that merely ended with a
blank line before its tool calls — *"Let me note that down."* then
`record_adverse_event` — was read as a fabrication, so the adverse event was
dropped unexecuted and the audit trail recorded an invention that never happened.
A guard against losing the record was losing the record. The rule now requires
content after the blank line. Five smaller faults came with it: `you`, `me` and
`agent` were in the speaker-label list and are ordinary English, so *"Thank
you.\nYou mentioned dizziness earlier"* was cut mid-turn; a tool call sitting
*before* the fabrication was kept in history but never executed, leaving a
`tool_use` with no `tool_result` and a 400 that would end the call rather than
the turn; a turn cut before its first word left the participant in silence with a
placeholder written into history as the agent's own words, where it is now
retried instead; the single-newline variant escaped all three rules; and the
audit entry's `discardedBlocks` was arithmetically always 0.

**Residual, not closed:** roughly 1 round in 5 the agent repeats a question
within one turn (*"And what is your date of birth? And what is your date of
birth?"*). Milder — irritating rather than a data-integrity failure — and a
different mechanism from the above. Worth a look during Sprint 5 observability.

**Instrument fixes that made this findable.** The eval's `did not fabricate
subject speech` check matched role labels (`user:`, `subject:`) and this
fabrication carries none, so it reported *clean* on a transcript full of invented
speech. Added: `asked one question per turn`, which encodes a rule the system
prompt already states; `began every sentence in upper case`, which catches the
leaked residue by position rather than by spelling — the first attempt listed the
known fragments and detected one of five, missing `usual bit rough honestly`,
which had been spoken aloud to a participant; and `VOICE_AGENT_RAW=<file>`, which dumps raw SSE frames and
persona replies — the diagnosis above came straight out of it. `--repeat` also
now prints a round that actually failed rather than whichever ran last; it was
reporting a rate over a passing transcript, so the defect could only be seen by
re-running until it happened to land in the final round.

---

## Narrowed incident — fabricated content reaching the record

**Mitigated 2026-08-20 by item 1.7, not closed.** The guard detects *invention* —
words with no counterpart in the transcript. It is weaker against a quote that
reuses the subject's own vocabulary to mean something they did not say. Two of
those are handled (a dropped negation, a swapped body site or symptom term), but
a determined inversion built only from spoken words can still pass. Coordinator
review remains the actual backstop, and this item should be revisited alongside
the MedDRA vocabulary work in Sprint 3.

Observed during 1.2 verification, 2026-08-20. On the open-ended question turn, the agent
generated a patient reply for itself, then **recorded an adverse event from its own
invention**: `AE-001 Dizziness G2` with verbatim *"the kitchen sort of went sideways on
me"* — words no subject spoke. The safety net then escalated on the fabricated content.

This is the failure mode the project already has three mitigations for — stop sequences, a
prompt rule making ending the turn an explicit action, and stream hold-back of stop-sequence
prefixes. **None of them held.** The leaked fragment was `useh`, meaning the model wrote
`use` followed by ordinary text rather than completing `user`, so no stop sequence matched
and the hold-back correctly released it.

Every existing mitigation guarded the *channel*. `lib/clinical/provenance.ts` guards the
*destination*: before any eCRF write, the `verbatim` text is checked against what the
subject actually said this call, and unfounded content is refused whatever produced it. It
does not need to know why the model went wrong.

Measured separation is wide — the fabricated Dizziness quote scores 0.00, genuine captures
including heavily trimmed ones score 0.80 to 1.00 — so the 0.6 threshold sits in the middle
of a gap rather than on an edge. All four verbatim writers are gated.

**It drops the quote, never the record.** The first version aborted the whole tool call,
which discarded a red-flag screen answer whenever the agent's paraphrase of it scored badly
and paged nobody — silently undoing the correction-escalation fix two commits earlier. The
quote is the doubtful part; the structured answer beside it is still the subject's, and it
is the part with a reporting clock attached.

Refusals are written to the audit trail rather than dropped, because a refused quote is
evidence the model tried to enter unfounded content. Three *distinct* refusals escalate —
deduplicated by text, because the model retries a refused call and identical retries inside
one turn used to page a coordinator about a call that was fine.

Observed working in an eval run: the model fabricated an elaborate reply about headaches and
vision loss, the gate refused the write, and the agent asked the subject to describe the
symptom again instead. Zero adverse events recorded.

Severity was highest in the register. A falsified entry is worse than a missed one — a miss
is a gap, a fabrication is a lie in a regulated record with a participant's name on it.

## Deliberately not in these sprints

- **Telephony (F-22).** The ElevenLabs Agents spike proved the path works and the shim is
  in the repo. It adds a subprocessor hop for participant audio, which needs D-2 and a DPA
  first. Revisit after Sprint 2.
- **Multi-language (F-23).** Each language is a separately validated instrument. Out of
  scope until a single-language pilot has run.
- **MedDRA coding (F-09).** Blocked on a licence nobody currently holds.

## Log

Append one line per sprint close: what shipped, what moved, what the gate said.

| Date | Sprint | Outcome |
|---|---|---|
| 2026-08-24 | 4 | Audio relays through the server rather than the browser. The Deepgram key cannot mint short-lived browser tokens, and the obvious workaround — a long-lived key in a `NEXT_PUBLIC_` variable — hands a paid transcription account to anyone who opens devtools. So the browser streams PCM to us and we stream it to Deepgram, which is the shape a clinical system wants anyway: the audio path stays inside infrastructure that can be audited and covered by an agreement, instead of a browser opening a socket to a third party nobody has a record of. **Request streaming in, SSE out, and no new dependency** — a WebSocket endpoint would have meant a package and a deployment shape this project has not tried, and a streamed POST body with an event-stream response is the same duplex behaviour over plumbing that already works. Verified end to end against the running server with real audio: interims for barge-in, one final, transcript exact, per-word confidence 0.912 surviving the whole path. Capture is now ours too, which is what makes echo cancellation possible at all — the text-level echo filter exists only because the Web Speech API would not accept a constrained stream. `getSettings()` is read back and reported rather than assumed, because asking for AEC is not getting it. **Found by poking it: a client that POSTs two bytes of nonsense held a Deepgram socket open indefinitely** — Deepgram bills by connected time — so the relay now has a flush grace period and a session cap. Capture itself is unverified: it needs a browser, a microphone and a speaker, and none of those exist here. |
| 2026-08-24 | 4 | Third-party review of the relay, eight findings, all confirmed by reading or measurement. **The one that mattered: a long answer reached the agent as its last sentence only.** Deepgram finalizes a continuous utterance in non-overlapping `is_final` segments and marks only the last one `speech_final`; the code treated every non-`speech_final` result as a revisable interim and overwrote it, so each settled segment destroyed the one before it. Proved on the live socket rather than argued from documentation — twelve seconds of speech came back as three segments, and "I coughed up blood on Tuesday morning" was discarded before anything could read it. Running both transcripts through the deterministic net: the tail alone escalates **nothing**; the whole utterance escalates **urgent**. A transcription bug was silently disarming the safety net, which is the same failure shape as sprint 3's — a control that looks present because the part you notice works. Fixed by accumulating settled segments; verified end to end through the real relay with real audio, all five clinical terms surviving. **Also fixed:** the response controller was unreachable from `cancel()`, so a participant closing the tab threw an uncaught `TypeError` out of a WebSocket listener; `stop()` left `running` set, so the microphone could silently never reopen after the agent spoke; a relay that ended early left the microphone live and the worklet filling an unread stream; `supported` tested `AudioWorkletNode` instead of request streaming, so Safari would prompt for a microphone and then fail rather than falling back; `needsConfirmation` compared single words against a list that is mostly phrases, so "passed out" and "chest pain" could never be flagged; the route had no `maxDuration` while capping its own session at an hour; and a dormant, unauthenticated key-minting endpoint was deleted. Sessions now resume when the relay ends while we still want to listen. 254 tests, verify green. **Two things recorded rather than changed:** whether the duplex-POST shape survives Vercel at all (4.6), and that the net does not match past-tense haemoptysis (4.7, Tier B). |
| 2026-08-24 | 4 | Sprint 4 started. D-3: Deepgram `nova-3-medical`. **4.5 first, because a swap without a measurement is a swap you cannot judge:** `scripts/stt-samples.mjs` speaks corpus utterances with the agent's own TTS and transcribes them, `scripts/measure-stt.mjs` scores word error rate *and* clinical-term recall. The second is the number to read — a recogniser that turns "quite tired" into "very tired" scores identically to one that turns "coughed up blood" into "coughed up phlegm", and only one of those loses a reportable event. On synthetic speech: **0.9% WER, 100% clinical term recall**, which is a floor and not a field measurement, since TTS audio is clean and unaccented and the participants are not. The recogniser interface now carries per-word confidence (`Heard`), and the browser recogniser declares `reportsConfidence = false` rather than passing on a number Chrome populates inconsistently. Protocol layer verified by driving the live streaming socket with real audio: interims arrive for barge-in, one final on `speech_final`, transcript exact, lowest word confidence 0.667. **Two things that testing found and reading would not:** a stream ending without `speech_final` emitted no final at all, losing the last thing said — which on a call is the sentence before someone hangs up — so the last interim is now flushed on close; and the confirmation threshold of 0.6 sits just below what clean audio produces, so it will rarely fire until it is re-derived from real recordings. **Blocked:** the Deepgram key lacks `keys:write`, so it cannot mint the short-lived tokens a browser needs. Either grant that scope, or relay audio through this server — which is the better answer for a clinical system anyway, since it keeps the audio path inside infrastructure we control and can audit. |
| 2026-08-24 | 3 | Sprint 3. **The headline is that the safety net was never at 53.9%.** The corpus it was measured against had 123 entries and had partly co-evolved with the regexes; 350 new utterances were generated by a context that had never seen `lib/clinical/safety.ts`, prompted only with a clinical topic and an instruction to speak as a patient. Against that honest 473-entry corpus the net measures **27.0% sensitivity and 91.1% specificity**, not 53.9% and 100%. Nothing about the net changed. The floors in `verify.mjs` were lowered deliberately and the commit says why. 22 of the new quiet entries fire the net — historical, someone else's, denied, hypothetical — and each was read individually before merging: the labels are right and the net is wrong about them, which is a specificity problem the old sample was too easy to reveal. `measure-net --record/--history` tracks the trend in a committed file, because a single number is a fact about today and the trend is what says whether a change helped. The screen went from 6 items to 9 — stroke, severe skin reaction, and intent to stop treatment, the three topics where the net does worst (stroke 5/22, withdrawal 2/21). **Self-harm was left as an open probe on purpose:** the existing comment argues it needs a validated instrument and IRB approval rather than wording an engineer invented, and closing a coverage gap by overriding that would have been worse than leaving it open and saying so. Burden and fabrication are now reported as rates: a completed call is 22 agent turns, 9 of them the screen; the boundary guard cut 1 turn in 22 on that run, 4.5%. **The sharpest number is that the net catches 0 of 81 colloquial signal utterances** — not a low rate, none. It fires on clinical phrasing and on nothing else, which is precisely why the lever is the directed screen rather than more regexes. |
| 2026-08-21 | 2 | Review of 2.6 found eleven, five HIGH, and most of them meant the feature did not work in production at all. **The cron would never have run**: Vercel Cron invokes with GET and sends `Authorization: Bearer $CRON_SECRET`, and both endpoints exported only POST against our own secret — every scheduled run a 405, while the docs claimed scheduling was solved. **The calling-hours gate was on the wrong door**: it guarded `POST /api/session`, which is the console, while the actual telephony shim calls `createSession()` directly — so a real 03:00 phone call still opened a session and escalated into an unwatched inbox, the exact scenario the feature exists to close. The gate moved into `createSession`, so every entry point goes through one door. **A routine deadline landed on the instant the office opened**, so the one-minute sweep paged the backup at 09:01 before anyone had opened their mail; it is the close of the next open day now. **The retry backoff inverted an SLA constant that had stopped applying**, so a failed routine page derived a send time in the future and was never retried. **The digest read `openLadder()`**, which retires an escalation once it has alarmed — precisely the one the digest exists to keep reporting the next morning; it has its own query now. Also caught a latent TDZ bug of my own: the closed-line response referenced `completionId` before its declaration, inside a closure, so it typechecked and would have thrown at runtime. 222 unit tests. |
| 2026-08-21 | 2 | 2.6 decided and built: D-A b, D-B b, D-C b, D-D a+c, D-E c, D-F a. **Sprint 2 complete.** The windows are 15 min / 4 h / next business day, and "next business day" is resolved against the call window rather than a fixed 24 hours — a routine flag raised at 4pm Friday used to fall due Saturday afternoon, pass unseen, and alarm into an empty office. The calling window is the item a participant would notice: outside cover, `POST /api/session` returns 503 with a spoken reopen time, and the check sits at session open rather than at verification because the alternative is asking someone for their date of birth — which lands in the record as free text — and only then telling them to call back. Acknowledgement records a typed name instead of an IP, which is an attestation rather than an authentication and is the honest interim before site SSO. A weekday digest reports anything outstanding and stays silent when nothing is, because a daily all-clear trains people to delete it unread. One-minute sweep cron in `vercel.json`. **Cost of running the sweep against live config while testing: six backup pages, an alarm and a digest to a real inbox**, from escalations my own earlier live tests had left unacknowledged; 11 deliveries retired with an explicit `acknowledged_by` saying so. 216 unit tests. |
| 2026-08-21 | 2 | 2.6 written up as six decisions — [ONCALL.md](ONCALL.md). Two operational gaps surfaced while grounding it, both config rather than code and both load-bearing. **Nothing schedules the sweep**, so the ladder only advances when something calls it: an unacknowledged emergency stays unacknowledged forever and no backup is ever paged. And **nothing restricts when a check-in can happen** — the agent will take a call at 03:00 and escalate into an inbox nobody is watching, which makes "your coordinator has been alerted" true only by luck of the hour. The framing the document leads with is that the ladder is not the safety mechanism: the participant is told to call emergency services in the same breath, and the ladder is how the *site* finds out. So the acknowledgement window is not "time until help arrives", it is the front half of the protocol's 24-hour SAE awareness clock — which makes the numbers derivable rather than a matter of taste. Every factual claim in the document was checked against the code that implements it. |
| 2026-08-21 | 2 | Review of 2.4 found six. **The synthetic flag failed open**: `createSession` set it on the in-memory object but only persisted inside the `resumable: false` branch, so a session created with `synthetic` alone reloaded as false on the next turn and paged a real coordinator. It worked at all only because the eval harness happens to pass both fields — a control that exists to stop real people being paged, held up by a coincidence. Second: resolving the region only from a *verified* subject meant an emergency before verification lost the number entirely — "your local emergency number" where a US participant used to hear 911, at the single most time-critical line the agent speaks, in the scenario `resumeDroppedCall`'s own comment calls routine ("March 11th 1958, sorry, I've been coughing up blood"). The site prefix is spoken before the date of birth and is enough to answer which country, so it is used as a hint for what to *say* and never for what may be written. Third: a suppressed send was filed as `sent` with an audit reason reading "accepted by the delivery provider" — untrue, in the subsystem built to stop exactly that — and the sweeper then walked the ladder on pages nobody sent. It has its own status now and leaves the ladder. **Measured cost of finding this late: six real escalation emails went to a live inbox from eval runs before suppression landed.** 207 unit tests, eval 47/47. |
| 2026-08-21 | 2 | 2.4 done. The agent told every participant to call 911 and, in a crisis, to text 988 — both US numbers, on a roster that now has a UK site. A wrong emergency number costs someone the seconds that matter most; a wrong crisis line is worse than silence, because they will dial it and it will not answer. Rules carry `{{EMERGENCY_NUMBER}}` and `{{CRISIS_LINE}}` placeholders and stay country-free; substitution happens once, where the subject is known. **An unknown country gets "your local emergency number" rather than a guess** — 112 covers the EU and the UK, but "probably 112" is not a standard a table of numbers people dial while frightened should apply to itself. Found two more instances of the false-notification bug while in there: the self-harm rule still said "you are alerting their study coordinator" (missed when `EMERGENCY_INSTRUCTION` was fixed), and the second of the two broken-turn fallbacks still promised "Your study coordinator will call you". Added a UK emergency persona to the eval, because the instruction being right is a different question from the model complying with it — "call 911" is a strong prior, and the only way to know is to run it. It says 999. **Also stopped the eval paging a real human**: the harness drives the same delivery path the console does, so `eval:fast` had started sending three real escalation emails per run. Eval sessions are marked synthetic and record the page in full without sending it. 204 unit tests, eval 47/47. |
| 2026-08-21 | 2 | Review of 2.3 found twelve, three HIGH. **The dedupe I added to stop double-paging reinstated the false claim the whole sprint removed**: the repeat path passed a literal `delivered: true`, so a subject saying "I still can't breathe" after a *failed* first page had the agent told the coordinator HAD been reached, and may say so. Fourth time a fix has weakened a different control, now recorded as such in CODE_REVIEW.md. Second: the dedupe key sorted the categories while the stored reason joined them in hit order — and hits are ordered by urgency rank, not alphabetically — so any two-rule utterance ("I can't breathe and I passed out") never matched its own duplicate and paged twice anyway; it compares a stored field now instead of a suffix of a sentence built elsewhere. Third: `fail()` hardcoded `tier: "primary"`, so an alarm whose own send failed was filed as a primary attempt, the sweep never saw an alarm row, and it re-alarmed on every pass — a fresh `ESCALATION_ALARM` on a participant's audit trail every minute, forever, plus unbounded row growth. Also: the two-clock bug survived inside `fail()`; only `emergency` got the short send timeout, so an *urgent* rule like "my hands are shaking" bought fifteen seconds of dead air on a live call; a churning sweep reported all zeros while creating failed rows; `MAX_RETRIES` counted the in-call send as a retry; alarmed escalations never left the working set, so every sweep re-read every escalation the study ever produced; `appendAudit` dropped the sealing key; `VOICE_AGENT_URL` — the eval harness's variable, defaulting to localhost — could bypass the production URL guard; and `attempt` was a read-then-write against a unique constraint, so a sweep racing a live call left an audit entry with no delivery row. 194 unit tests. |
| 2026-08-21 | 2 | 2.3 done. The ladder — retry, backup contact, alarm — runs outside the call, because a live call is the wrong place to sit in a backoff loop and noticing silence means waiting. `overdue()` had existed with nothing calling it, so an escalation nobody opened looked exactly like one that had been handled. Three moves, each idempotent: retry a failed send with backoff, page the backup when the primary lets the window close, alarm when the ladder runs out. Everything lands on the participant's audit trail, which meant giving the store an `appendAudit` that the completion lock does not block — a coordinator failing to respond is a fact that arrives *after* the call ends, and a trail that cannot accept it stops being the history of the record exactly when the record gets interesting. Verified live against Neon and a real inbox: primary paged, nothing sent inside the window, backup paged once it closed with "ESCALATED — no response" in the subject, and a second sweep at the same moment paged nobody. **Two clocks again** — `ackDeadline` used `Date.now()` while the sweep judged windows against an injected time, so a backup paged during a sweep got a deadline in a different frame and its window could lapse the instant it was created; the same mistake as reading a database timestamp against an application clock. One clock per pass now. Also added an `orphaned` count: a delivery row whose escalation is not on its session means a page went out for something the record does not contain, and skipping that in silence is what this sweep exists to stop. 189 unit tests. |
| 2026-08-21 | 2 | 2.1 closed against a real inbox. One emergency escalation delivered end to end through Resend — subject line `[ONX-301] EMERGENCY — subject 001-0042 (ESC-001)`, provider id recorded, delivery row `sent`. The message was fed a deliberately hostile reason ("daughter Sarah is driving her to Northlake", plus a date of birth) and none of it travelled: what went out was the coded term and grade. Then the part the review made interesting — a `GET` from a mail-scanner user agent left the record at `acknowledgedAt: null`, and a `POST` from the confirm button recorded `acknowledged` attributed to the clicking address. The alarm survives the scanner and only a human clears it, which is the property the whole sprint exists to create. |
| 2026-08-21 | 2 | Second review of the delivery work found eleven, two HIGH, and the first was a real-world flaw rather than a logic slip: **the acknowledgement link was a side-effecting GET.** Enterprise mail security — SafeLinks, Proofpoint, Mimecast, Gmail prefetch — fetches every URL in an inbound message before a human sees it, so every escalation would have been acknowledged from a scanner's IP within seconds of the send. That disarms the only alarm for "nobody responded to an emergency", and because the first acknowledgement is the one recorded, it would have attributed the response to a robot permanently. GET now renders a button and changes nothing; POST records. Second HIGH: `escalate_to_coordinator`'s `reason` is model free text, prompted by its own schema for "what the coordinator needs to know", screened by nothing — and it was printed into an email under a header promising no verbatim, no names, no transcript. The notification now carries a summary derived only from structured fields: the safety-net category, or the coded terms and grades of the events cited. Also: the deterministic net had no dedupe, so a subject saying "I still can't breathe" after being told to hang up paged the coordinator twice; `everDelivered` counted a `queued` row as delivered, re-stranding the page the retry branch existed to rescue; nothing capped retries, so a failing provider could burn eight tool iterations at 15s each — two minutes of silence on a live call; and delivery was awaited before the safety and state events, leaving the console blind for the whole round-trip. **Deferred to 2.3, deliberately:** a failed safety-net page has no recovery — the model is told not to retry it, `overdue()` excludes failed rows, and nothing polls `overdue()` at all. The one path designed not to depend on model judgment is the one with no fallback when its send fails. 181 unit tests. |
| 2026-08-21 | 2 | D-2 decided: email via Resend, acknowledgement by signed link, alarm on non-ack. 2.1, 2.2 and 2.5 built. The system had been recording `notified: <coordinator>` and telling the participant their coordinator had been alerted while nothing was sent anywhere — the one place it said something untrue to a sick person, at the worst moment. Delivery now happens before the tool returns so the next sentence can be true, the deterministic net delivers its own page rather than depending on the model calling a tool, and the notification carries subject id, urgency, category and a link but no transcript, verbatim or date of birth. **Review then found ten, three HIGH, all on the seams rather than inside the delivery path.** The worst was circular: my delivery-failure signal was yielded as an `error`, and the transport's error handler speaks *"Let me have your study coordinator call you"* — so the fix for "never claim a page that did not happen" caused the system to promise a call. Also: only `transport.send` was guarded, so a database hiccup while queueing threw out of the function entirely and, from the safety-net path, aborted the turn mid-emergency; a duplicate escalation returned "already raised" without checking whether the first one was ever delivered, stranding a page nobody received with no retry and no alarm, because `overdue()` excludes failed rows; the net raised and delivered a page and then told the model to raise another, which the exact-text dedupe would never catch; `EMERGENCY_INSTRUCTION` asserted "you are alerting their study coordinator", so on the failure path the operator message instructed both behaviours at once; a missing public URL was the one setting that failed silently, producing acknowledge buttons pointing at localhost; and `escalation_delivery.subject_id` was a new plaintext store of subject-linked data outside the shredding scheme. Fixing the duplicate branch re-broke the "a duplicate emergency still ends the call" rule, caught by the regression test written when that was first fixed — third time that pattern has recurred. 176 unit tests. |
| 2026-08-21 | 1 | Review of the 1.6 build found ten, two HIGH, both reproduced. **Migration 0003 created `session_key` empty and nothing backfilled it**, so every session written before that deploy became unwritable — and the error announced a destruction that had never happened, because "no key" and "key destroyed" were the same condition. They are separate states now, and a session that predates sealing mints one rather than failing. **The withdrawal refusal returned before `session.subject` was set**, so the key was never bound to the subject — and `shredSubject` finds keys by `subject_id`. The session still held the spoken subject ID and date of birth, which made the participant most likely to ask for erasure the one the shredder silently skipped. Also: `detach()` dropped the sealing key, so the in-memory store wrote plaintext audit entries after the first load while earlier ones were sealed — half-shreddable with nothing saying which half, and the withdrawal tests run entirely on that store; `supersede()` appended entries with no key check, which would have put permanently undestroyable plaintext into a table that rejects DELETE; a bare `catch` reported a tampered ciphertext as *lawfully destroyed under retention*; the bytea hex fallback stripped two backslashes where Postgres emits one, so it always threw; reinstatement erased the withdrawal it reversed, in a subsystem premised on withdrawals being attributable; and the shredded marker was a single object written into array- and string-typed fields, so a shredded record threw `TypeError` on the resume path. One of my own tests was satisfied by a foreign key and never reached the constraint it named. 162 unit tests. |
| 2026-08-21 | 1 | 1.6 decided: D1-b, D2-b, D3-c, D4-a+c, D5-a, D6-b. Two of the six needed code and both are built. **D4-c, crypto-shredding**, had an expiry date on it — the audit hash covers `before`/`after`, and `audit_entry` rejects UPDATE as well as DELETE, so encryption could never have been retrofitted past the triggers without invalidating the chain. Sealing now happens *before* hashing, which is the whole trick: the hash covers ciphertext, so destroying the key leaves a record that still verifies rather than one that looks tampered with. Keys are per **session**, not per subject, because a session exists before anyone identifies themselves and the date of birth is spoken several turns before verification — a subject-keyed scheme would have left the most identifying utterance in the record unsealed. Structured clinical data stays readable; only free text is sealed, which also keeps `record ->> 'resumable'` queryable for the leasing statement. Verified end-to-end against the live database: content unrecoverable, record still present, chain still valid, destruction attributable. **D6-b, withdrawal**: `subject_state` is the first subject-level entity in the schema, and `verify_subject` refuses a withdrawn participant before any clinical question — the earliest enforcement point that exists, since session open has no identity. Prior data is retained, per ICH E6 and EDPB 3/2019. Node's strip-only TypeScript rejected a parameter property that Turbopack accepted happily — the mirror of the bundler regression two commits ago, and only the tests saw it. 157 unit tests. |
| 2026-08-21 | 1 | Closed the two uncontrolled stores of subject content that the 1.6 review turned up, neither of which any retention option would have governed. Raw request-body logging to `.spike-logs` is off unless explicitly enabled and refused in production. The speech cache now writes only the fixed instrument wording — **10 of the 37 cached files were subject-derived**, the agent reading back non-scripted sentences under a filename that is a hash of the text, so they could not have been located again without already knowing the words the subject used; deleted. The allowlist moved into `lib/voice/speech-cache.ts` so it is testable without a build, and it has a test, because re-broadening a cache reads as a performance improvement in a diff. Also wired token accounting into the eval: the runner had been emitting usage on every turn and the harness discarded it, so the only cost in this project that actually accrues was unmeasured. `npm run eval:fast` is **$0.36** at Opus 5 list price, 91% prompt-cache hit on the agent, and 10% of the bill is the personas rather than the system under test. Added `cache_creation_input_tokens` to the usage event so the figure does not quietly undercount. |
| 2026-08-21 | 1 | Review of 1.8 found seven, one critical and it was mine: **the commit did not build.** `migrate.ts` computes its migrations directory from `import.meta.url` at module scope, and stamping the schema version pulled it into every API route's bundle — Turbopack could not resolve it, and had it built, the path would have pointed inside `.next/server` where no `.sql` file is emitted. Types, lint and 140 tests all passed, because they run the sources directly under Node; the bundler was the only check not being run, and I reported "verify green" on the strength of it. `next build` is now a step in the gate, and it costs 3 seconds. The same fix answered the second finding: the version stamp read the highest migration *file in the checkout* rather than the ledger, so every session created between a deploy and its migration step would have claimed a schema the database did not yet have — wrong exactly where the field exists to be right. It now reads `max(version)` from `schema_migration`, cached per process. Also: an advisory lock, because ordered migrations cannot be run concurrently the way an idempotent file could — two runners both saw the same work pending and the loser reported "nothing was applied", which was false; `--status` no longer creates the ledger it claims to only report on; unknown flags are refused rather than falling through to apply, so the `--verify` flag this script had until yesterday no longer silently migrates production; and a connection whose rollback failed is discarded rather than handed back to the pool. Added `npm run db:verify-replay`, which applies the migrations to a throwaway database and diffs it against the live one — currently 28 columns, 7 indexes and 3 triggers identical. |
| 2026-08-21 | 1 | 1.8 done. `schema.sql` is gone; `lib/store/migrations/NNNN_*.sql` is the only source of truth, applied in order and recorded with a checksum. The point is not tidiness — an idempotent file describes where the schema ended up and never how it got there, so a record from last March cannot be tied to the structure that held it. Applied migrations are checksummed and drift halts the runner; `--repair` exists and is deliberate. 0001 is the baseline and is the only file allowed idempotent DDL, since it adopted a database that already existed; a test enforces that on 0002 onward. The scratch-database test fixture now replays migrations rather than reading a second schema file, which is one fewer thing that can drift out of agreement with production. Also stamped `instrument.schemaVersion` on new records: the column was added for exactly this and nothing had ever written to it. **Two bugs of my own, both found by tests rather than by reading:** `pool.query` checks out a connection per call, so my `begin`/`commit` wrapped nothing — the rollback test passed anyway because Postgres wraps a multi-statement simple query in an implicit transaction of its own, and the protection was real but not mine; and the "no idempotent DDL after the baseline" check scanned comment prose, so it failed on 0002's comment explaining that it avoids `if not exists`. 140 unit tests. |
| 2026-08-20 | 1 | Third review of 1.4/1.5 found 11, one HIGH, and it was real: resume decided a call was "dropped" from the absence of `completedAt` alone, so a subject redialling while still connected on the first line had the live call closed under them — and `save()` resolved quietly while it happened. Claiming now requires idleness and happens in one leasing UPDATE, so a concurrent redial skips the row instead of carrying the same record forward twice. The memory store was handing out live references: an emergency recorded on one session appeared inside another that was already locked, with nothing in that record's audit trail to say where it came from. **The Postgres SQL had never been executed by a test** — every suite deleted `DATABASE_URL` — so the memory-store tests were asserting a reimplementation of the control rather than the control. Now covered against a scratch database created and dropped per run, and both SQL controls mutation-tested. 98 unit tests. |
| 2026-08-20 | 1 | 1.4 and 1.5 done. A redial within 2h carries the dropped call's record forward, locks the source so nothing is claimed twice, and brings prior speech so the provenance gate still allows quoting it. Idempotency is on natural keys, not caller-supplied ones — a redialling agent has no memory of a key it generated on the first call. Found and fixed cross-run contamination in the eval harness: personas that stop mid-call looked exactly like dropped lines to the next run. 81 unit tests. |
| 2026-08-20 | 1 | Second review of 1.7 found six more, one HIGH: the gate aborted the whole tool call, so a red-flag "yes" died with a loosely-quoted verbatim and nobody was paged — my own test locked it in. Now screens the field, not the record. Also: short quotes no longer bypass an empty transcript, scoring is per-utterance so a quote cannot be assembled from unrelated turns, a dropped negation is refused, a swapped body site is refused, plurals match singulars, and retries are deduplicated. 72 unit tests. |
| 2026-08-20 | 1 | 1.7 done. Provenance gate on all four verbatim writers; refusals audited, three escalate. Fabrications score 0.00 against genuine captures at 0.80–1.00, so the 0.6 threshold sits in a wide gap. Also fixed all 11 code-review findings, two HIGH — ConText scopes crossed clause boundaries and suppressed four real emergencies; a screen answer corrected no→yes never escalated. lib/ converted to relative imports so the write path is testable without a build. 55 unit tests. |
| 2026-08-20 | 1 | 1.1–1.3 done. Neon provisioned (free, iad1, auth off). Append-only enforced by trigger, verified: UPDATE and DELETE both rejected, cleanup required disabling them. **Postgres reorders JSONB keys**, which broke the hash chain on read-back — fixed with canonical serialisation, three tests added. SIGKILL mid-call then cold restart: subject, 1 AE, 3 escalations, 13 audit entries, chain valid — identical. **Observed a falsified eCRF entry** (see 1.7). |
| 2026-08-20 | 0 | 0.1 and 0.5 done. `npm run verify` runs in ~3.3s and was proven to fail: removing two chest-pain patterns dropped sensitivity to 47.1% and the gate caught it. Floors set at sensitivity ≥50%, specificity =100%. |
