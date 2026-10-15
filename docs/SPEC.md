# ONX-301 Voice Check-In — Product Specification

**Status:** draft · **Target:** shadow pilot readiness · **Owner:** Ian Jones

> ONX-301 is a synthetic protocol with an invented roster; no real participants are involved. The "shadow pilot" below is a hypothetical next stage, not one that is planned or running.

This document is written for a reader with no memory of how the prototype was built.
Everything it asserts is traceable to `README.md`, the design record, or a measurement
that can be re-run.

---

## 1. What this is

A voice agent that conducts the between-visit symptom check-in for participants on an
interventional oncology trial. A participant speaks; the system captures structured
adverse-event data, grades it, recognises safety signals, escalates to a human, and
produces a record a regulator could reconstruct.

**It is a data collection instrument with judgement. It is not a decision maker.** Every
grade it assigns is a proposal a coordinator confirms. That boundary is load-bearing:
the entire validation argument in §7 depends on it, and inverting it makes the system a
categorically harder regulatory problem.

## 2. The target: a shadow pilot

Not "production" — that is too far away to plan against. The concrete target is a
**shadow pilot**, and every requirement in this document exists because the pilot needs it.

**Shadow pilot definition**

| | |
|---|---|
| Scope | One site, 10–20 consented participants, 8 weeks |
| Mode | Runs **alongside** the existing eDiary, not instead of it |
| Regulatory weight | **None.** No output is used for any regulatory decision, disposition, or safety report |
| Review | 100% of calls reviewed by a coordinator within 24 hours |
| Comparison | Every captured event reconciled against what the participant recorded in the existing eDiary |

**Why shadow first.** It generates performance evidence on real participants without the
agent being on the hook for a single reportable decision. It converts the hardest question
in §7 — how do you qualify a non-deterministic instrument — from an argument into a
dataset. Skipping it means validating against synthetic personas and hoping.

**Pilot exit criteria** — what would justify moving toward a real deployment:

- Agreement between agent-captured events and eDiary-captured events, measured and
  characterised, with disagreements categorised by cause
- Zero missed safety signals in coordinator review, or every miss explained and closed
- Escalation delivery acknowledged within SLA on 100% of escalations
- Participant completion rate at or above the existing eDiary baseline
- No data-integrity incident: no fabricated content, no lost record, no broken audit chain

## 3. Users and what they need

| User | What they need from it |
|---|---|
| **Participant** | To be heard, briefly, without a tablet. To not be interrogated. To reach a person when something is wrong. To not be given medical advice by a machine. |
| **Study coordinator** | To trust what lands in their queue. To see *why* the agent graded something, not just the grade. To be paged reliably and know the page arrived. To review a call quickly. |
| **Data manager** | Structured, coded, reconcilable data with verbatim source preserved. |
| **Sponsor safety** | Reportable events surfaced within the clock, with a reconstructable trail. |

The coordinator is the primary user of the *output*. The participant is the primary user
of the *interaction*. When those conflict — a longer call that produces better data — the
participant's tolerance is the binding constraint, because a call they abandon produces no
data at all.

## 4. Functional requirements

Requirements are numbered for traceability from the backlog. **P** = pilot-blocking.

### 4.1 Identity and consent
- **F-01 (P)** Two-factor verification before any clinical question. Current subject ID +
  date of birth is knowledge-based and insufficient; the pilot needs a stronger factor.
- **F-02 (P)** No clinical data collected on verification failure.
- **F-03 (P)** The agent identifies itself as automated, unprompted, at call open.

### 4.2 Data capture
- **F-04 (P)** Verbatim participant wording preserved alongside every coded term.
- **F-05 (P)** CTCAE v5.0 grade with a written rationale citing functional evidence.
- **F-06 (P)** Seriousness assessed against 21 CFR 312.32 criteria with the applicable clock.
- **F-07 (P)** Protocol instrument wording delivered verbatim, pinned and change-controlled.
- **F-08 (P)** Adherence and concomitant medications captured.
- **F-09** MedDRA-backed coding. *Blocked on licence; free-text coded term is the interim.*

### 4.3 Safety
- **F-10 (P)** A deterministic control detects safety signals independently of the model.
- **F-11 (P)** Directed safety screen before the symptom review, covering every topic the
  protocol treats as reportable. *Nine of the ten signal topics are covered — stroke, severe
  skin reactions and withdrawal intent were added in sprint 3. Self-harm is deliberately left
  as an open probe rather than a red-flag item, because screening for it needs a validated
  instrument and IRB approval rather than wording an engineer invented. The "59%" this line
  claimed was three sprints out of date.*
- **F-12 (P)** Positive red flags escalate deterministically, without model judgement.
  *Raised deterministically since sprint 3 and **delivered** to a human only since
  2026-08-27: for the whole life of the feature the escalation existed on the record and
  reached nobody, because delivery was a step the producer had to remember and this one did
  not. See sprint 7.*
- **F-13 (P)** Escalations are **delivered**, acknowledged, retried, and alarm on non-ack.
  *Delivered by email (Resend) with an acknowledgement link, retry, backup contact, alarm
  sweep and daily digest since 2026-08-27. Email is the only channel.*
- **F-14 (P)** Locale-appropriate emergency and crisis numbers.
- **F-15 (P)** The agent gives no medical advice, no diagnosis, and no reassurance.
- **F-16 (P)** Never fabricates participant speech or an unasked answer.

### 4.4 Record integrity
- **F-17 (P)** Append-only, tamper-evident audit trail retained beyond the application's life.
- **F-18 (P)** Records survive process restart; a call interrupted mid-capture loses nothing.
- **F-19 (P)** Writes are idempotent; a redial does not duplicate a reported event.
- **F-20** Reconciliation export for comparison against the existing eDiary.

### 4.5 Accessibility and reach
- **F-21 (P)** An alternate modality for participants who cannot use a voice channel.
  Hearing loss, dysarthria, and treatment-related cognitive impairment are all in-population.
- **F-22** Telephony, so a participant can dial rather than open a browser.
- **F-23** Additional languages. Each is a separately validated instrument, not a translation.

## 5. Non-functional requirements

| | Requirement | Current |
|---|---|---|
| **N-01 (P)** | Time to first audio under 2s at p50, under 4s at p95 | **Missed, and now measured rather than felt.** The first sentence leaves the server at 5.2s p50 on subject turns — before synthesis has begun, so time to first *audio* is later still. The "~2.5s p50" this row used to claim was optimistic by roughly 2x. Measured with `scripts/latency.mjs` over 19 turns of eval calls; unchanged when run serially, so it is not a concurrency artifact. Turns that acknowledge before calling tools reach 3.5s p50 and turns that do not reach 5.5s — **1.96s of the wait is the acknowledge-before-tools rule being broken**, which happens on every verification turn. The final leg, dispatch to audible, is browser-only and still unmeasured: see 4.4. |
| **N-02 (P)** | A provider outage degrades audibly, never to silence | Speech falls back; the model does not |
| **N-03 (P)** | Zero fabricated content reaching the record or the speaker | Guarded three ways; no ongoing measurement |
| **N-04 (P)** | Safety-net sensitivity measured and tracked over time | 25.7% / 90.3% specificity on a 523-utterance corpus as of the last recorded measurement (`npm run measure-net`); trend in `docs/net-history.jsonl` |
| **N-05 (P)** | Participant speech is not transmitted to a subprocessor without disclosure | **Not met, and understated here until 2026-08-27.** This row described the agent's read-back text reaching ElevenLabs. Since sprint 4 the participant's **raw audio** — every word they say, as 16 kHz PCM — streams to Deepgram on every call. Two processors, no subprocessor disclosure anywhere in the repository, and no consent language covering either (6.2, 6.5). |
| **N-06** | Concurrency for one site's weekly cadence (~20 calls/week) | Untested |

## 6. Explicit non-goals for the pilot

Naming these prevents scope drift and makes the plan honest.

- **Not** replacing the eDiary. Shadow only.
- **Not** producing regulatory-grade data. No pilot output feeds a safety report.
- **Not** multi-site or multi-language.
- **Not** a validated system. The pilot generates evidence *toward* validation.
- **Not** autonomous disposition. A human confirms everything.
- **Not** MedDRA-coded, unless a licence appears.

## 7. The validation argument

The question a quality unit asks first: *how do you validate something non-deterministic?*

You do not validate the model. You validate the **system of controls around it**, and you
bound what the model is trusted to decide alone. Three moves:

That is the argument. **The system does not yet make it**, and this section previously
claimed it did. Corrected 2026-08-27 after the full audit; the three moves are stated here
as the target, each with what is actually true underneath it.

1. **Safety-critical decisions should leave the model.** Anything with a reporting clock
   attached should be decided by a deterministic control with a specification and a test
   suite.

   *Today:* two deterministic controls exist and both now deliver — the regex net
   (`lib/clinical/safety.ts`) and the directed screen. The net measures **25.7% sensitivity**
   (last recorded measurement) and catches **0 of 81** colloquial signal utterances. The screen only fires on the nine
   questions it asks. Everything else — a symptom volunteered in the open question, anything
   phrased in a way no rule matches — reaches a coordinator **only if the model chooses to
   call `escalate_to_coordinator`**. Grade 3+ and a positive seriousness determination, the
   two things §7.1 names as having a clock, now page a coordinator deterministically when
   the model records them. *(Corrected: this line used to say they produced an instruction
   string and nothing else, which was true when it was written.)* The grade and the
   seriousness call themselves are still the model's.

   So the honest statement is the one `scripts/measure-net.mjs` already prints in its own
   footer: **the net is a floor, not a ceiling — the model is the primary detector.** The
   deterministic controls bound the worst case; they do not carry the case.

2. **The model proposes; a human disposes.** Every grade is a recommendation with a written
   rationale.

   *Today:* true for the record — a coordinator reviews it. "Grade 3+ leaves the automated
   path entirely" was never implemented as stated; what the code does is page a
   coordinator deterministically for any event recorded at grade 3 or above, given the
   grade the model recorded. A grade the model gets wrong is still wrong.

3. **The output space is constrained where it can be.** Verbatim instrument wording, strict
   tool schemas, a turn-boundary guard, and a provenance gate that refuses to record a quote
   the participant did not say.

   *Today:* this one holds, and it is the strongest of the three. Stop sequences were tried
   and found to leak on near-misses; the structural guard that replaced them cuts the turn
   instead, and the provenance gate escalates on repeated fabrication.

**What would have to change for (1) to be true.** Either a deterministic consequence for
grade 3+ and for a positive seriousness determination, so the two clocked decisions do not
depend on the model acting — or an explicit, documented decision that the model *is* the
primary detector, with the validation argument rebuilt around characterising it statistically
rather than around bounding it. The first is a sprint. The second is a different regulatory
conversation, and it is the one this system is actually having.

Both are defensible. Claiming the first while doing the second is not, and that is what this
section did.

**The consequence to plan for:** if a pinned model version changes, the instrument has
changed. A provider silently upgrading behind the same name is an uncontrolled change to a
validated system mid-study. Model, voice, and transcription identifiers must be pinned to
exact versions, recorded in every session's audit trail, and changed only under change
control with re-qualification evidence.

## 8. Risk register

Ordered by consequence, not likelihood.

| Risk | Consequence | Current mitigation | Gap |
|---|---|---|---|
| Missed safety signal | Participant harm; delayed reporting | Model + net + screen + human review | Net at 25.7% and **0 of 81 colloquial**; screen covers 9 topics, self-harm by open probe only |
| Escalation not delivered | Participant harm; record claims otherwise | Email delivery before the tool returns; agent told not to claim a failed page; retry, backup and alarm sweep | Email only; no paging or EHR channel |
| Fabricated content in the record | Data falsification | Stop sequences, per-item tools, hold-back | No ongoing measurement |
| Lost record mid-call | Reportable event disappears | Postgres store; dropped-call resume | In-memory fallback when no database is configured |
| Misheard symptom | Wrong data, silently | None | Confidence thresholds needed |
| Model version drift | Instrument changed mid-study | None | **Sprint 0** |
| Subprocessor exposure | Undisclosed PHI transfer | Fixed-wording cache reduces volume | BAA/DPA required |

## 9. Decisions needed

| # | Decision | Owner | Blocks |
|---|---|---|---|
| D-1 | Database and hosting | Ian | Sprint 1 |
| D-2 | Escalation destination and on-call model | Ian + site | Sprint 2 |
| D-3 | Streaming STT provider | Ian | Sprint 4 |
| D-4 | Second authentication factor | Ian + site | F-01 |
| D-5 | Alternate modality for F-21 | Ian + site | Pilot scope |
| D-6 | MedDRA licence availability | Sponsor | F-09 |
