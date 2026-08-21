# Retention and legal hold

**Status:** decided 2026-08-21 · **Backlog item:** 1.6 (Tier C) · **Owner:** Ian Jones

The six decisions below are settled. Each one keeps the options it was chosen from,
because a policy that records only the answer cannot be re-argued when the facts change —
and several of these turn on facts (the GDPR legal basis, whether the EU is in scope) that
are still open.

| | Decision | Chosen | Status |
|---|---|---|---|
| **D1** | Records status | **b** — non-source, retained on the trial clock | policy only |
| **D2** | Retention clock | **b** — the sponsor's trial SOP | policy only |
| **D3** | Subject audio | **c** — all of it, pilot only, fixed destruction date | **blocked on 6.2 and 6.5** |
| **D4** | Deletion mechanics | **a** for trial-clock data, **c** for anything with a destruction date | **built** |
| **D5** | Legal hold | **a** — procedural now, **b** with the first purge job | policy only |
| **D6** | Withdrawal | **b** — enforced at verification | **built** |

D3 is not deferred by choice. It needs the data-flow and subprocessor map (6.2) because
subject audio already reaches a third party, and consent language covering recording (6.5)
because it is IRB-facing. Both are yours rather than mine.

Everything below assumes the shadow pilot in `SPEC.md` §2: one site, 10–20 consented
participants, 8 weeks, running alongside the existing eDiary, **no output used for any
regulatory decision, disposition, or safety report.**

---

## 1. What the system actually holds today

Worth establishing before arguing about how long to keep it. The first draft of this
section was wrong in three places, all of them found by review rather than by writing,
and all of them in the same direction: **there is more subject content in more places
than the architecture suggests.**

| Data | Where | Personal? |
|---|---|---|
| Subject ID, site, cohort, study day | `check_in_session.subject_id`, `record` | Pseudonymous identifier |
| **Date of birth, spoken aloud** | `messages`, `record.subjectUtterances`, `audit_entry` | **Directly identifying, free text** |
| Verbatim symptom descriptions | `record.adverseEvents[].verbatimTerm`, `messages` | Free text, potentially identifying |
| Full conversation transcript | `check_in_session.messages` | Free text |
| **A second full transcript** | `audit_entry.after_value`, one row per utterance | Free text, **in the table that rejects DELETE** |
| Raw request bodies | `.spike-logs/elevenlabs-requests.jsonl` | Full conversation, plaintext — *logging now off by default* |
| Synthesised agent speech | `.speech-cache/*.mp3` | *Fixed instrument wording only, as of this revision* |

**The date of birth is free text in three places.** Verification asks for it out loud, so
the answer lands in `messages`, `subjectUtterances`, and — because the audit trail records
every utterance — in `audit_entry` too. Checked rather than assumed: driving a real call
through verification puts `"November 2nd, 1971."` in all three. Any de-identification
scheme that drops a column will not catch it.

**`audit_entry` is a complete second copy of the transcript.** Not just before/after
values of eCRF writes: `runTurn` records every subject utterance verbatim as
`UTTERANCE_RECEIVED` with the text in `after`. That table rejects `DELETE` by trigger and
its sessions are referenced `on delete restrict`. This single fact decides more of the
document than anything else in it — see D4.

**There was an unmanaged plaintext transcript store on disk.** The OpenAI-compatible route
logged every request body to `.spike-logs/elevenlabs-requests.jsonl` — the whole
conversation history, appended, never rotated, unencrypted. 30 entries on the development
machine, 7 containing a date-of-birth-shaped string. Gitignored, so no repository-level
review would ever have seen it, and outside every mechanism this document proposes.
**Left as it was, a team could have crypto-shredded the database, reported the subject's
data destroyed, and been wrong.** Now off unless explicitly enabled — see below.

**The speech cache was not impersonal either.** The agent is instructed to read back what
it recorded, and every synthesised sentence was cached with no filter limiting it to the
fixed instrument wording — so a subject's own symptom description, rendered as audio, was
written permanently to `.speech-cache`. Worse for deletion: the filename is a hash of the
text, so a given subject's audio could not be located without already knowing the exact
string that produced it. Ten such files were on disk. Now restricted — see below.

**No subject audio is stored by this system — but subject audio does leave the machine.**
That distinction was collapsed in the first draft and it matters, because a retention
policy is about where data goes, not only where it rests. The browser path uses the Web
Speech API, a cloud recogniser. The ElevenLabs Agents path validated in
`SPIKE-elevenlabs-agents.md` has ElevenLabs performing capture, turn detection and
transcription — that document already flags it: *"Another hop for PHI. Patient audio would
reach ElevenLabs."* Retention of that audio is governed by a subprocessor's terms, not by
anything decided here. **Backlog 6.2, the data-flow and subprocessor map, is a prerequisite
for D3 rather than a parallel task.**

### Fixed regardless of the decisions

Three of the above were not policy questions but uncontrolled stores of subject content
that no option below would govern. Two are now closed:

1. **`.spike-logs` — done.** Raw request-body logging is off unless
   `VOICE_AGENT_SPIKE_LOG=1` is set, and refused outright when `NODE_ENV=production`. A
   spike artefact that outlives its spike stops being a diagnostic and becomes an
   unmanaged store of somebody's medical history. *(The existing file is still on disk;
   it holds fixture data only, and removing it is a one-line decision left to the owner.)*
2. **`.speech-cache` — done.** Only the fixed instrument wording is written to disk now,
   which is the only text a second call ever asks for again. **Ten of the 37 cached files
   were subject-derived**, 168 KB of the agent reading back non-scripted sentences; they
   have been deleted. The allowlist moved into `lib/voice/speech-cache.ts` and is covered
   by a test, because re-broadening it would look like a performance improvement and read
   like one in a diff. The store also prunes itself on first use: the allowlist gated
   *writes*, which does nothing about a host that already ran the older code and is still
   serving what it cached then. Since the key is a hash of the text, the valid set is
   computable, so the control enforces itself rather than depending on someone
   remembering to run a script.
3. **`audit_entry` holding a verbatim transcript — still open, and deliberately.**
   Defensible, and arguably correct for a regulated trail, but it should be a decision
   rather than a side effect. It is the reason D1-a is not available.

## 2. The floor and the ceiling

Retention is squeezed from both directions, and the squeeze is what makes this a
decision rather than a number.

**The floor — keep at least this long**

- **ICH E6 (GCP)** — essential documents retained until at least 2 years after the last
  marketing approval in an ICH region, or at least 2 years after formal discontinuation
  of clinical development. The sponsor tells the investigator when retention ends; the
  site does not decide on its own.
- **21 CFR 312.62(c)** — the investigator retains records for 2 years after a marketing
  application is approved, or 2 years after the investigation is discontinued and FDA is
  notified.
- **EU CTR 536/2014, Article 58** — the sponsor and investigator archive the clinical
  trial master file for **at least 25 years after the end of the trial**. This is the
  binding constraint if the trial touches the EU, and it is far longer than most
  US-only retention instincts.
- **21 CFR 11.10(e)** — the audit trail is retained **at least as long as** the records
  it describes, and must be available for agency review and copying. Our audit trail is
  therefore on the same clock as the record, never a shorter one.

**The ceiling — do not keep it longer than you can justify**

- **GDPR Article 5(1)(e)**, storage limitation — personal data kept no longer than
  necessary for the purpose.
- **GDPR Article 17(3)** — the right to erasure does *not* apply where processing is
  necessary for compliance with a legal obligation, for public-interest reasons in
  public health, or for scientific research where erasure would seriously impair the
  research. Trial data usually sits inside these exemptions.

**The nuance that decides how much erasure exposure you carry:** per **EDPB Opinion
3/2019**, withdrawing *CTR informed consent* does not undo processing already lawfully
carried out — the data already collected stays. But if the **GDPR legal basis** for
processing were consent, withdrawing it would require stopping and, absent another
basis, deleting. This is why sponsors generally do not use GDPR consent as the legal
basis for trial data; they use legal obligation or public interest, and treat informed
consent as the ethical gateway rather than the data-protection basis. **Which basis the
sponsor has chosen is the single most important thing to find out**, because it decides
whether a subject can compel deletion at all.

---

## 3. The decisions, and what they were chosen from

### D1 — What is this system, for records purposes?

The shadow framing says no output is used for a regulatory decision. That is true of
*outputs*. It is not obviously true of *evidence*: if the agent captures an adverse
event the eDiary missed, and a coordinator is paged and acts, then the record of that
call is evidence of what the site knew and when. Escalation is an action, and this
system takes it.

| | Option | Consequence |
|---|---|---|
| **a** | **Non-record research system.** Pilot data is evaluation data, not trial data. Short retention, destroyed at pilot close-out. | Cheapest. Defensible *only* while nothing acts on the output — which the escalation path already breaks. |
| **b** | **Non-source, but retained on the trial clock.** Not an essential document and not source data, but retained as long as the trial's records because it may be evidence. | Honest about the escalation path. Costs storage and a 25-year archiving story if the EU is in scope. |
| **c** | **Source data.** The transcript is source for anything it captures; full GCP retention, TMF filing, validated system. | Correct if the agent ever becomes the primary instrument. Enormous for a pilot, and premature. |

**I would pick (b).** (a) is the tempting answer and I think it is wrong for one
specific reason: the deterministic safety net can page a coordinator, and once a human
acts on a machine-generated alert, the record of that alert stops being an experiment.
(b) costs almost nothing at pilot volume and removes the question.

### D2 — The retention clock

| | Option | Consequence |
|---|---|---|
| **a** | Fixed period from call date — e.g. 12 or 24 months. | Simple, predictable, and wrong if the trial outlives it. |
| **b** | Tied to the sponsor's trial retention SOP — the same clock as the eCRF. | Correct by construction, and inherits the 25-year EU CTR obligation if applicable. |
| **c** | Indefinite until the sponsor authorises destruction. | Matches how GCP actually works, since the sponsor notifies when retention ends. Weakest on GDPR storage limitation. |

**I would pick (b), with (c) as its behaviour in practice** — the clock is the sponsor's,
and nothing is destroyed without their written authorisation, which is the ICH E6
position anyway.

### D3 — Subject audio

Currently none is kept. The pilot's entire purpose is measuring agreement between what
the agent captured and what the participant recorded in the eDiary. **Without audio, a
disagreement cannot be attributed:** you cannot tell a mis-transcription from a
mis-capture from a participant who genuinely said two different things, because the
transcript is produced by the very pipeline whose fidelity is in question.

This is sharper than it looks given what the last few weeks found. The model was
observed writing the subject's side of the conversation, and a fabricated verbatim
reached the eCRF once. The provenance gate now checks quotes against the transcript —
but the transcript is *also* machine-produced. Audio is the only artifact in the system
that a human can check against.

| | Option | Consequence |
|---|---|---|
| **a** | Keep none. Status quo. | Best privacy posture, lowest consent burden. Pilot exit criteria become unfalsifiable at the margin. |
| **b** | Keep audio only for flagged calls — escalations, provenance refusals, coordinator disputes — for a short window (90 days). | Targeted. But you cannot know a call was worth keeping until after you have discarded it. |
| **c** | Keep all audio for the pilot, destroy at pilot close-out on a fixed date. | 10–20 participants × 8 weeks is a trivial volume. Makes the reconciliation dataset defensible. Requires explicit consent language. |

**I would pick (c), scoped hard to the pilot.** The volume is negligible, the analytical
value is the pilot's whole point, and a fixed destruction date bounds the exposure.
Note that voice recordings are personal data under GDPR but are *not* Article 9
biometric data unless processed to uniquely identify someone — speech-to-text is not
that. Some IRBs will still treat it as sensitive, so this has to be in the consent form
(backlog 6.5).

### D4 — How deletion works against an append-only store

This is the one with real engineering consequences. `audit_entry` rejects `DELETE` by
trigger, sessions are referenced `on delete restrict`, and the audit trail is hash-chained
— so content cannot be removed without either breaking the chain or changing the schema.
That was a deliberate design decision and it is now in tension with any retention policy
that ends in destruction.

| | Option | Consequence |
|---|---|---|
| **a** | **Never delete.** Retain for the full trial clock, rely on GDPR Art. 17(3) exemptions. | No code. Honest for regulated trial data. No answer at all for pilot data that should not outlive the pilot. |
| **b** | **Pseudonymisation split.** Identifiers move to a separate table; deleting that table de-identifies the rest. | Standard, simple. **Does not work here on its own** — the DOB is spoken aloud into the transcript and verbatim quotes can identify ("my daughter drove me to Northlake"). Free text is the hard part. |
| **c** | **Crypto-shredding.** Encrypt subject content with a per-subject key; destroy the key to destroy the data. Ciphertext stays in place, so the hash chain still verifies and the rows still prove a record existed. | Fits the append-only design better than anything else. Cost: key management becomes the crown jewels, and a key lost by accident is an unrecoverable record, which is itself a finding. |
| **d** | **Hard delete via migration**, dropping the triggers when a purge runs. | Destroys the property the audit trail exists to provide. I would argue against this whatever else is chosen. |

**I would pick (a) for trial-clock data and (c) for anything with a destruction date**
— which, if D3 is (c), means the audio above all. Crypto-shredding is the only option
that answers "prove this record existed and prove its content is gone" at the same time,
and that pairing is exactly what a regulator asks for.

**But (c) cannot be retrofitted, and the first draft of this document had it fourth in
the build order, which was wrong.** The audit hash is computed over the `before` and
`after` values, and `after` holds the raw utterance. Encrypting later means rewriting
existing rows — which `audit_entry_no_mutate` rejects on UPDATE as well as DELETE, and
which `check_in_session_locked_when_complete` blocks separately once a call is closed —
and re-hashing, which invalidates the chain: precisely the property option (c) exists to
preserve.

> **If crypto-shredding is wanted at all, it has to be designed in before the first
> record is written.** Under (a) alone, a destruction date assigned later has no path to
> it short of option (d), which destroys the audit trail's whole point.

That moves (c) from fourth in the build order to first, or off the list. It is the one
decision here with an expiry date on it.

### D5 — Legal hold

A legal hold suspends routine destruction when litigation, an inspection, or an
investigation is reasonably anticipated. It only bites once something actually deletes,
so its urgency follows from D4.

| | Option | Consequence |
|---|---|---|
| **a** | Procedural only — documented in an SOP, no code. Nothing deletes automatically during the pilot anyway. | Adequate today, and honest, provided nothing automated ever deletes. |
| **b** | **Flag-based hold** at subject and study level. The purge job must check it; setting and clearing are audited with who and why. | Small work, and it makes the hold provable rather than asserted. |
| **c** | Matter-based holds with custodian mapping and scope per matter. | Right for an organisation with a legal department. Overkill here. |

**I would pick (a) now and (b) at the same time as the first purge job** — a hold
mechanism guarding a purge job that does not exist is ceremony, but shipping a purge job
without one is the actual hazard.

### D6 — Withdrawal of consent

Two separate things get confused here, and the distinction is the EDPB one above:
withdrawal stops **future** collection; it does not retroactively unmake data already
lawfully collected.

There is a concrete and slightly embarrassing gap today. The safety net *detects* a
withdrawal statement — `lib/clinical/safety.ts` matches "withdraw from the study" and
escalates it — but nothing records the resulting status. **The subject's intent to leave
is captured, escalated, and then not acted on by the system.** The next scheduled call
proceeds exactly as before.

| | Option | Consequence |
|---|---|---|
| **a** | Document the position; handle withdrawal by the site not scheduling further calls. | No code, and it depends on a human never making a mistake. |
| **b** | **A withdrawal flag the session opener honours**, so a withdrawn subject cannot be called even if scheduled by error, with the refusal audited. | Small. Closes a real gap — nothing in the system today would stop a call to a withdrawn participant. |

**I would pick (b).** Calling a participant who has withdrawn is the kind of failure
that ends a pilot, and it is roughly an afternoon's work.

---

## 4. If you just want a default

**D1-b · D2-b · D3-c · D4-a+c · D5-a now, b with the purge job · D6-b**

That combination: retains pilot data on the sponsor's trial clock, records audio for the
pilot only with a fixed destruction date, never hard-deletes regulated records, uses
crypto-shredding for anything that does have a destruction date, documents legal hold now
and builds it when it can bite, and refuses to continue a call with a withdrawn
participant.

**Built**

0. `.spike-logs` gated behind an explicit flag and refused in production;
   `.speech-cache` restricted to the fixed instrument wording, with the stale
   subject-derived entries deleted and the store pruned on first use so a host that
   ran the older code cleans itself. See §1.
1. **D4-c — crypto-shredding.** `session_key` (migration 0003) holds one key per
   session, stamped with the subject when verification succeeds. Free text is sealed
   with AES-256-GCM before the audit hash is taken, which is what lets the chain
   survive destruction: the hash covers ciphertext, so a shredded record still
   verifies instead of looking tampered with. Structured clinical data — grades,
   counts, item ids — stays readable, because it is what a coordinator reviews and
   it identifies nobody. `node scripts/shred.mjs --subject <id> --reason <text>`
   reports and stops; `--confirm` destroys. Verified against the live database:
   the record survives, the chain verifies, the content is gone, and the key row
   carries who destroyed it and why.
2. **D6-b — withdrawal.** `subject_state` (migration 0004) is the first
   subject-level entity in the schema. `POST /api/subject/withdrawal` records it,
   and `verify_subject` refuses a withdrawn participant before a single clinical
   question — the earliest point the system knows who is calling, because a
   session is opened before anyone identifies themselves. The refusal is audited.
   Data collected before the withdrawal is retained, per ICH E6 and EDPB 3/2019;
   destruction stays a separate, separately authorised act.

**What survives a shred, and why.** Destroying a key destroys *content*, not the
existence of a record. `check_in_session.subject_id`, timestamps, statuses, and the
structure of the audit trail all remain — deliberately, because D4-a says the record is
retained and because "prove this record existed" is half of what a regulator asks. So a
shredded record still shows that subject 001-0042 had a check-in on a given date, and
that an escalation was raised on it. `escalation_delivery.subject_id` is cleared on shred
as defence in depth, but the session link makes that partial rather than complete. A
policy that needed even the existence of a check-in to disappear would need D4-d, which
destroys the audit trail's whole point. Worth stating so nobody discovers it during an
erasure request.

**Threat model, stated plainly.** Keys sit in the same database as the ciphertext,
so anyone who can read the data can read the keys while they exist. That is not an
oversight: what this defends against is *being unable to prove destruction*, and a
key row that is destroyed is destroyed. Confidentiality-at-rest against a database
compromise needs the keys in a KMS, which is a deployment decision — the sealed
format does not change when it is made.

**Still to build**

**Then, in order — and the order is not the same as the first draft's**

1. Data-flow and subprocessor map (backlog 6.2) — a prerequisite for D3, not a parallel
   task, because subject audio already leaves the machine.
2. Consent language covering recording, AI, subprocessors and the human alternative
   (backlog 6.5) — blocking for D3-c, and IRB-facing.
3. Audio capture and storage with a fixed destruction date (D3-c) — moderate, and
   blocked on the two above.
4. Legal-hold flag (D5-b) — small, and sequenced with the first purge job. D5-a is the
   decision for now: nothing deletes automatically, so a hold has nothing to suspend.
5. Authentication on `POST /api/subject/withdrawal`. It is unauthenticated, which is
   fine for a fabricated roster and not fine the day a real participant exists — who
   recorded a withdrawal is part of what makes it evidence.

---

## 5. What I cannot decide, and you or the sponsor must

- **The GDPR legal basis for trial data.** If it is consent, the erasure exposure is
  entirely different and D4 becomes urgent rather than architectural. Ask the sponsor.
- **Whether the trial touches the EU.** EU CTR Article 58's 25 years is the difference
  between a storage line item and an archiving strategy.
- **The sponsor's own retention SOP**, which governs regardless of what this document
  says, and which the site cannot override.
- **Whether the IRB will accept audio retention at all**, which is a submission question,
  not an engineering one.
- **What the ElevenLabs and browser-recogniser terms say about retention of the audio
  they already receive**, which no decision in this document reaches. Backlog 6.2.

---

## Sources

- [Regulation (EU) No 536/2014, Article 58](https://www.legislation.gov.uk/eur/2014/536/article/58?view=plain)
- [EDPB Opinion 3/2019 on the interplay between the Clinical Trials Regulation and the GDPR](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_opinionctrq_a_final_en.pdf)
- [EDPB Opinion 3/2019 — commentary on withdrawal and erasure](https://www.dataprotectionreport.com/2019/02/edpb-issues-new-opinion-on-interplay-between-clinical-trials-regulation-and-the-gdpr/)
- [eTMF retention under EU Regulation 536/2014](https://arkivum.com/blog/etmf-retention-requirements-complying-with-eu-regulation-536-2014/)
- [ICH E6 essential-document retention, as applied in practice](https://insights.complion.com/qa-follow-up-from-what-does-ich-e6r2-really-mean-for-research-sites)

*21 CFR 312.62(c) and 21 CFR 11.10(c)/(e) are cited from the regulation text; confirm
against the sponsor's own regulatory affairs reading before this becomes policy.*
