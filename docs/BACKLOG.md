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
| 1.4 | Mid-call recovery on redial | B | A dropped call resumes with prior captures present | todo |
| 1.5 | Idempotency keys on every eCRF write | B | Replaying a turn produces no duplicate event | todo |
| 1.6 | Retention and legal-hold posture documented | C | Reviewed | todo |
| 1.7 | **Verbatim provenance check on every eCRF write** | B | A tool call whose verbatim text does not appear in the subject's actual transcript is rejected | **todo — priority** |
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

## Open incident — fabricated content reaching the record

Observed during 1.2 verification, 2026-08-20. On the open-ended question turn, the agent
generated a patient reply for itself, then **recorded an adverse event from its own
invention**: `AE-001 Dizziness G2` with verbatim *"the kitchen sort of went sideways on
me"* — words no subject spoke. The safety net then escalated on the fabricated content.

This is the failure mode the project already has three mitigations for — stop sequences, a
prompt rule making ending the turn an explicit action, and stream hold-back of stop-sequence
prefixes. **None of them held.** The leaked fragment was `useh`, meaning the model wrote
`use` followed by ordinary text rather than completing `user`, so no stop sequence matched
and the hold-back correctly released it.

Every existing mitigation guards the *channel*. Item 1.7 guards the *destination*: before
any eCRF write, check that the `verbatim` text the tool was given actually appears in
something the subject said this call. A deterministic provenance check would have rejected
the Dizziness entry regardless of why the model produced it, which is the difference between
guarding a route and guarding the record.

Severity: highest in the register. A falsified entry is worse than a missed one — a miss is
a gap, a fabrication is a lie in a regulated record with a participant's name on it.

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
| 2026-08-20 | 1 | 1.1–1.3 done. Neon provisioned (free, iad1, auth off). Append-only enforced by trigger, verified: UPDATE and DELETE both rejected, cleanup required disabling them. **Postgres reorders JSONB keys**, which broke the hash chain on read-back — fixed with canonical serialisation, three tests added. SIGKILL mid-call then cold restart: subject, 1 AE, 3 escalations, 13 audit entries, chain valid — identical. **Observed a falsified eCRF entry** (see 1.7). |
| 2026-08-20 | 0 | 0.1 and 0.5 done. `npm run verify` runs in ~3.3s and was proven to fail: removing two chest-pain patterns dropped sensitivity to 47.1% and the gate caught it. Floors set at sensitivity ≥50%, specificity =100%. |
