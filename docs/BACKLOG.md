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
| 1.3 | Audit trail persisted append-only | B | Chain verifies across a restart; no update path exists in the schema | **done — needs review** |
| 1.4 | Mid-call recovery on redial | B | A dropped call resumes with prior captures present | **done** |
| 1.5 | Idempotency keys on every eCRF write | B | Replaying a turn produces no duplicate event | **done** |
| 1.6 | Retention and legal-hold posture documented | C | Reviewed | todo |
| 1.7 | **Verbatim provenance check on every eCRF write** | B | A tool call whose verbatim text does not appear in the subject's actual transcript is rejected | **done** |
| 1.8 | Versioned migrations | A | Schema changes are ordered and replayable, not idempotent DDL | todo |

---

## Sprint 2 — Escalation delivery

*Until this ships, the system records that a coordinator was notified — a claim it cannot
support. This is the hard prerequisite for any call with a real participant.*
**Blocked on D-2 (destination and on-call model).**

Every item here is Tier B.

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 2.1 | Real delivery to the chosen destination | B | An escalation produces a message a human receives | todo |
| 2.2 | Acknowledgement tracking | B | Delivery status is on the record; unacknowledged is visibly distinct | todo |
| 2.3 | Retry, secondary contact, alarm on non-ack | B | Simulated non-ack raises an alarm within SLA | todo |
| 2.4 | Locale-aware emergency and crisis numbers | B | Non-US locale yields correct numbers; test covers it | todo |
| 2.5 | Delivery failure is itself an escalation | B | A failed send is loud, never silent | todo |
| 2.6 | On-call model and SLA documented | C | Site agreement | todo |

---

## Sprint 3 — Safety coverage

*Sensitivity is 51.4% and four reportable topics are unscreened. MedDRA is unavailable, so
the lever is the directed screen — which is a script change, not a licence.*

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 3.1 | Extend the screen to stroke, self-harm, severe skin reaction, withdrawal intent | B | Screen covers 100% of signal-bearing corpus topics | todo |
| 3.2 | Measure the length/coverage trade-off | B | Turn count per call reported; participant burden explicit | todo |
| 3.3 | Corpus grown to ≥300 utterances, sourced not invented | B | Coverage per topic reported; no topic under 15 | todo |
| 3.4 | Track net sensitivity over time | A | `measure-net --history` shows the trend | todo |
| 3.5 | Ongoing fabrication measurement | B | Every eval run reports a fabrication rate, not a pass/fail | todo |

**Discipline for 3.3:** do not author corpus entries to match the patterns. The corpus is
only useful while it stays an honest sample of speech the net has never seen. Entries
should come from observed simulated-patient output and from clinical phrasebooks, not from
reading the regexes.

---

## Sprint 4 — The ears

*The last free-and-bad component. A misheard symptom is a data-integrity problem, not a UX
annoyance.*
**Blocked on D-3 (STT provider).**

| ID | Item | Tier | Criterion | Status |
|---|---|:---:|---|---|
| 4.1 | Streaming recogniser behind the existing interface | A | Swap is config; no call-site changes | todo |
| 4.2 | Per-word confidence surfaced | A | Confidence present on every transcript | todo |
| 4.3 | Low-confidence symptom terms trigger read-back | B | Below threshold, the agent confirms before recording | todo |
| 4.4 | WebRTC capture with echo cancellation | A | Barge-in works on speakers; echo suppression count stays zero | todo |
| 4.5 | Transcription accuracy measured on clinical vocabulary | B | Word error rate on a symptom-term set, reported | todo |

---

## Sprint 5 — Observability and QA

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

| | emergency persona, rounds clean |
|---|---|
| before | 2/6 |
| after | 5/6, and 4/5 on a separate 5-round run |

Across 8 rounds the control fired **6 times** with zero fragments reaching the
speaker. The model still attempts this constantly — the attempts are its
behaviour, and the fix contains them rather than removing them, which is why the
eval now reports the containment count instead of asserting it to zero.

**Residual, not closed:** roughly 1 round in 5 the agent repeats a question
within one turn (*"And what is your date of birth? And what is your date of
birth?"*). Milder — irritating rather than a data-integrity failure — and a
different mechanism from the above. Worth a look during Sprint 5 observability.

**Instrument fixes that made this findable.** The eval's `did not fabricate
subject speech` check matched role labels (`user:`, `subject:`) and this
fabrication carries none, so it reported *clean* on a transcript full of invented
speech. Added: `asked one question per turn`, which encodes a rule the system
prompt already states; `spoke no role-label fragment`, which catches the leaked
residue directly; and `VOICE_AGENT_RAW=<file>`, which dumps raw SSE frames and
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
| 2026-08-20 | 1 | Third review of 1.4/1.5 found 11, one HIGH, and it was real: resume decided a call was "dropped" from the absence of `completedAt` alone, so a subject redialling while still connected on the first line had the live call closed under them — and `save()` resolved quietly while it happened. Claiming now requires idleness and happens in one leasing UPDATE, so a concurrent redial skips the row instead of carrying the same record forward twice. The memory store was handing out live references: an emergency recorded on one session appeared inside another that was already locked, with nothing in that record's audit trail to say where it came from. **The Postgres SQL had never been executed by a test** — every suite deleted `DATABASE_URL` — so the memory-store tests were asserting a reimplementation of the control rather than the control. Now covered against a scratch database created and dropped per run, and both SQL controls mutation-tested. 98 unit tests. |
| 2026-08-20 | 1 | 1.4 and 1.5 done. A redial within 2h carries the dropped call's record forward, locks the source so nothing is claimed twice, and brings prior speech so the provenance gate still allows quoting it. Idempotency is on natural keys, not caller-supplied ones — a redialling agent has no memory of a key it generated on the first call. Found and fixed cross-run contamination in the eval harness: personas that stop mid-call looked exactly like dropped lines to the next run. 81 unit tests. |
| 2026-08-20 | 1 | Second review of 1.7 found six more, one HIGH: the gate aborted the whole tool call, so a red-flag "yes" died with a loosely-quoted verbatim and nobody was paged — my own test locked it in. Now screens the field, not the record. Also: short quotes no longer bypass an empty transcript, scoring is per-utterance so a quote cannot be assembled from unrelated turns, a dropped negation is refused, a swapped body site is refused, plurals match singulars, and retries are deduplicated. 72 unit tests. |
| 2026-08-20 | 1 | 1.7 done. Provenance gate on all four verbatim writers; refusals audited, three escalate. Fabrications score 0.00 against genuine captures at 0.80–1.00, so the 0.6 threshold sits in a wide gap. Also fixed all 11 code-review findings, two HIGH — ConText scopes crossed clause boundaries and suppressed four real emergencies; a screen answer corrected no→yes never escalated. lib/ converted to relative imports so the write path is testable without a build. 55 unit tests. |
| 2026-08-20 | 1 | 1.1–1.3 done. Neon provisioned (free, iad1, auth off). Append-only enforced by trigger, verified: UPDATE and DELETE both rejected, cleanup required disabling them. **Postgres reorders JSONB keys**, which broke the hash chain on read-back — fixed with canonical serialisation, three tests added. SIGKILL mid-call then cold restart: subject, 1 AE, 3 escalations, 13 audit entries, chain valid — identical. **Observed a falsified eCRF entry** (see 1.7). |
| 2026-08-20 | 0 | 0.1 and 0.5 done. `npm run verify` runs in ~3.3s and was proven to fail: removing two chest-pain patterns dropped sensitivity to 47.1% and the gate caught it. Floors set at sensitivity ≥50%, specificity =100%. |
