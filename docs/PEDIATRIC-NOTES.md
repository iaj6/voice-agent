# What a pediatric version would need

This prototype is built around a synthetic adult oncology trial. Some of its design would
carry over to a voice check-in used by pediatric nurses and families. A lot would not. This
page maps each part to what a pediatric version would need, and says plainly whether
anything here already does it.

**Built** means there is working code for it here. **Partial** means a piece exists but
not the whole thing. **Not built** means nothing here does it yet. None of this has been
reviewed by a pediatric clinician.

| Area | This prototype (adult) | Pediatric counterpart | Status |
|---|---|---|---|
| Symptom instrument | Adult CTCAE grading, with functional anchors like shopping, chores and driving | Ped-PRO-CTCAE: child self-report forms by age band, plus a caregiver proxy form. Anchors in terms of school, play and sleep | Not built |
| Who is answering | `verify_subject` records `self` or `caregiver`; protocol has a proxy-reporting policy. This adult protocol refuses caregiver reports and ends the call | Caregiver report is the normal case for young children. Accept it, tag every record with the respondent, and use the proxy form rather than the self-report one | Partial |
| Consent | Assumed; not modelled in the call | Parental permission plus the child's assent, recorded separately, with assent revisited as the child ages | Not built |
| Adolescent confidentiality | Every question is asked of whoever is on the line | Some items (pregnancy, sexual activity, substance use, mood) may need to be asked of the teen privately, or routed differently when a parent is present | Not built |
| Suicide-risk screen | An open question about spirits, written by an engineer, deliberately not a red-flag item | A validated youth screen such as the ASQ, with its own scoring and response pathway, approved by the site | Not built |
| Fever | A "yes" to the fever item pages at emergency, the agent asks once for a measured temperature, gives a fixed instruction, and ends the call | Fever in a child with a central line or on chemotherapy is a door-to-antibiotics emergency. Same shape, with pediatric thresholds and the family's fever plan | Built (adult thresholds) |
| Escalation route | Email through Resend, with retry, backup contact, alarm sweep and daily digest | After-hours nurse triage workflows: EHR in-basket, secure chat or a paging system, with on-call routing | Partial (the retry and acknowledgement logic would carry over; the channel would not) |
| Language | English only | Caregiver language access. Spanish (and others) as separately validated instruments, not translations of the English wording | Not built |
| Medication adherence | Missed oral doses and the reason | Weight-based and liquid dosing, who gave the dose, and vomiting after a dose (re-dose or not, per protocol) | Not built |
| Pace and attention | Tuned for a tired adult; time to first audio currently misses its own 2s target | Shorter calls, fewer questions per turn, faster responses. Latency matters more with a child on the line | Not built |
| Nurse review | Read-only review queue ordered by severity, behind one shared secret | A review that records the nurse's decision (confirm or change a grade, note an action), per-user identity, and memory of prior answers so a known ongoing symptom does not re-alert every week | Not built |
| Fixed wording | Instrument questions are delivered word for word from one source file | Same requirement, with age-appropriate validated wording per form | Built (the mechanism; not the pediatric wording) |
| Deterministic escalation | Red-flag screen answers and grade 3 or higher page from code, not from model judgment | Same principle | Built (the mechanism) |
| Audit trail and erasure | Hash-chained audit trail, per-session encryption, crypto-shredding | Same, plus retention rules for minors, which often run until well after the age of majority | Partial |

## What carries over unchanged

The principles more than the code:

- Safety escalation should not depend on the model deciding it is serious.
- The agent must not claim a nurse was notified unless the notification actually went.
- Questions are instrument items, so they are asked in fixed wording.
- The record keeps the respondent's own words next to anything coded, so a nurse can
  check the work rather than trust it.

## What would be hardest

Probably the respondent problem. In adult trials a proxy is the exception and this
prototype refuses one. In pediatrics the respondent changes with age and sometimes within
a single call (a parent answers, then hands the phone to the teen). Every answer would need
to carry who gave it, and the instrument used would need to match.
