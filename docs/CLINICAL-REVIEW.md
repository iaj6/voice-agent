# Clinical review of the instrument

**Status:** draft rationale, not a sign-off · **Date:** 2026-08-28 · **Owner:** Ian Jones + investigator

Produced by a model reasoning as an oncology clinical research physician, at Ian's
suggestion, because the alternative was an engineer's unexamined guess with nothing
written down. **It is not a clinician and this is not a regulatory sign-off.** What
it is: a rationale specific enough that a real investigator can accept, amend or
reject each item in minutes, and contest the reasoning rather than the conclusion.

Three of its factual claims were checked against the code before recording. All
three held, and they are the ones that need no clinical judgement at all — they are
the instrument contradicting itself.

---

## 1. Where the code disagrees with itself

These are defects, not opinions. No investigator is needed to see them.

| | The contradiction |
|---|---|
| **Fainting** | Say "I passed out" in free speech and the net fires **emergency** and ends the call. Answer yes to the screen item asking the same question and it pages **urgent**. Same fact, two tiers, decided by whether the participant volunteered it or was asked. |
| **Fever** | The net's own instruction reads *"may indicate neutropenic fever, which is an oncologic emergency"* — and then tells the agent to escalate at **urgent**. The system calls it an emergency in the same sentence it pages it as routine-ish. |
| **Temperature** | That same instruction tells the agent to ask for the measured temperature. The screen item captures none, and there is no field for it. The number separating "go now" from "mention it at the visit" is not collected. |
| **The script continues** | After a positive *urgent* red flag the tool result says "carry on with the remaining screen items". A participant reporting fever is then walked through the rest of the screen, six solicited symptoms, adherence, con meds and a read-back — 15+ turns. If they are febrile-neutropenic, that is a meaningful fraction of a one-hour door-to-antibiotic window spent collecting data. |

## 2. The structural argument worth taking seriously

**Seriousness should not drive urgency at all.** ICH E2A seriousness is a *reporting*
classification — it answers "does this reach the sponsor in 24 hours". It does not
answer "how fast does a human need to speak to this person". Two events with
identical seriousness can have opposite time-criticality: a resolved admission three
weeks ago, and an admission happening right now.

The recommendation is **two clocks**: a clinical response tier set by what the
participant needs, and a regulatory clock set by the seriousness determination alone.
The code already has the second as `sponsorNotificationDeadline` and is conflating it
with the first.

The clearest symptom: `important_medical_event` sits on the urgent tier. It is defined
as the catch-all an investigator reaches for when something is dangerous and fits no
box — suspected pneumonitis, a QT finding — and it pages at the same speed as a
resolved two-day admission.

## 3. What the screen is missing, ranked

Assessed as "better constructed than most ePRO safety modules, but better at
detecting a myocardial infarction than the toxicity this drug class is known for."

1. **Pneumonitis / ILD** — new or worsening cough and breathlessness *as a change from
   baseline*. The class toxicity that kills people on NSCLC-targeted agents. Currently
   split badly across an emergency cardiac item, with cough not asked at all.
2. **Haemoptysis** — on a lung cancer trial, with an anticoagulated participant on the
   roster. The net has patterns for it; the screen does not.
3. **Mucosal involvement** — "sores in your mouth or eyes" is the earliest SJS prodrome
   and also catches grade 3 mucositis, which on an oral agent means you cannot swallow
   the tablet.
4. **VTE** — new leg swelling or one-sided calf pain. PE is a common cause of sudden
   death in NSCLC and DVT is the presentation you can catch on a phone call. Neither
   the screen nor the net has anything.
5. Vomiting separate from nausea; new confusion or visual change; falls; weight;
   jaundice.

And a false-positive source nobody had named: **the screen has no memory of last
week's answer.** A participant with chronic baseline dyspnoea answers yes every week,
is told to hang up and dial 999 every week, and pages an emergency every week. The
system has no notion of *change* — which is 5.8 wearing a different hat.

## 4. On baseline conditions (5.8)

The proposed design — annotate and adjust, never suppress — was endorsed without
reservation, with three arguments that strengthen it:

- **Migraine with aura is an independent risk factor for ischaemic stroke**, roughly a
  doubling. Subject 002-0027 is 34. The participant whose baseline would trigger the
  suppression is the one for whom the stroke rule should be *louder*, not quieter.
- In oncology, baseline conditions are the ones most likely to **mask a new malignant
  process**, because tumour recapitulates the symptom the patient already has. Chronic
  back pain plus a new cord compression is a same-day emergency with a permanent
  disability endpoint.
- ICH E6(R2) places medical decisions on the investigator. Automated suppression is an
  algorithm making a delegated medical judgement; annotation keeps the physician in the
  loop. That argument settles it with a quality unit regardless of the clinical detail.

Three amendments:

1. **Use the baseline to select a follow-up question, not to modify a consequence.** A
   fixed-wording, protocol-pinned discriminating item — "Is this the same as the
   headaches you usually get, or is it different?" — then the original tier if
   different, undowngraded.
2. **It should be "adjust", not "downgrade".** Anticoagulation plus bleeding, prior VTE
   plus leg swelling, known brain metastases plus new headache — in every one the known
   condition makes the presentation *more* dangerous. A design that only downgrades is
   missing half the clinical content.
3. **The feed is wrong.** `baselineConditions` is one third of it. The participant's own
   *ongoing AEs from prior calls* and their *concomitant medications* are equally
   invisible to the deterministic path, and by week six most of what trips a screen item
   repeatedly will be a known ongoing study-drug AE rather than an enrolment comorbidity.

**And a contrarian recommendation worth weighing:** for a 10-20 participant shadow
pilot, ship the structured baseline and the discriminating questions and the
annotation — and *do not ship the downgrade*. Every downgrade rule is an untested
control making a safety decision on a live participant, and the pilot exists to measure
the false-positive rate, which you cannot do for what you have already suppressed. Let
the coordinator downgrade by hand for eight weeks while the system records every one,
then derive the table from evidence.

## 5. The three changes it would insist on before a pilot

1. **Fever stops the call.** Capture the temperature, page at emergency, give a
   protocol-directed instruction, stop collecting data.
2. **Split `chest_or_breathing`**, and build the breathing half as an ILD item at urgent
   tier with a cough follow-up. As written it is a weekly emergency generator for a
   population with baseline dyspnoea.
3. **Define the proxy-respondent pathway, or refuse the call.** Verification is subject
   ID plus date of birth — both of which a spouse knows. A proxy passes verification
   today and their account enters a regulated record as the participant's own words,
   past a provenance gate that cannot tell the difference. Simultaneously a
   data-integrity failure, a consent failure, and the only route by which a grade 5
   event would ever reach this system.

## 6. Two things it said the system does well

Worth recording because they are cheap to lose in a refactor: fixed instrument wording
with a structural guard against paraphrase, and the refusal to claim a coordinator was
notified unless a delivery actually succeeded. Both are named as among the most common
quiet failures in this product category.

## 7. What a real investigator still has to decide

Everything in sections 2, 3 and 4, plus: whether the agent may deliver a
protocol-directed instruction ("take your temperature, call the site today") at all —
argued here to be an instrument item rather than medical advice, but that is the
site's and the IRB's call, not a model's and not an engineer's.
