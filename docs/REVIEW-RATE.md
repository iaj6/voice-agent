# How much of this gets reviewed, and why

**Status:** options, not decided · **Backlog item:** 5.5 (Tier C) · **Owner:** Ian Jones + site

| | Decision | Options | Status |
|---|---|---|---|
| **R-1** | How many calls a human reviews during the pilot | a–d | **open** |
| **R-2** | How unflagged calls get sampled | a–c | **open** |
| **R-3** | What "reviewed" means the reviewer has done | a–c | **open** |
| **R-4** | Who reviews | a–c | **open** |
| **R-5** | What happens when review finds a miss | a–c | **open** |
| **R-6** | What would justify reviewing less | a–c | **open** |

The queue at `/review` ranks calls by why they want attention, and `/review/[id]`
puts what the participant said beside what was recorded. Neither of those is a
review policy. This is the policy, and it is Tier C because it is a quality-system
decision rather than an engineering one.

---

## 1. The thing that decides everything else

**A review policy that only looks at flagged calls cannot discover what the flags
miss.**

The queue is built out of the system's own judgements — its escalations, its
grades, its screen answers. Reviewing only what it flagged means every review
confirms something the system already knew. You would measure precision and never
touch recall, and the number you would report is "of the calls we thought were
interesting, this many were", which answers a question nobody asked.

This project has already been wrong in exactly this shape once. The safety net
measured 53.9% sensitivity against a corpus that had partly co-evolved with its
own regexes; against 350 utterances written by something that had never seen the
code, it measured **27.0%**. Nothing about the net had changed. The measurement
had been reading its own reflection.

So whatever rate gets chosen below, some **unflagged** calls have to be in the
sample, chosen without reference to what the system thought of them. That is
R-2, and it is the load-bearing one.

**The second thing.** Review rate during a shadow pilot and review rate in
production are different questions with different answers. The pilot exists to
characterise a novel instrument; you review heavily because you are measuring,
not because you distrust it. ICH E6(R2) endorses risk-based, targeted monitoring
for established processes — that is an argument about a qualified instrument, and
this one is not qualified yet. Using it to justify light review during
qualification inverts it.

---

## 2. The decisions

### R-1 — How many calls a human reviews during the pilot

| | Option | Consequence |
|---|---|---|
| **a** | **Every call, every participant** | The only option that measures recall directly. At 10–20 participants on a weekly cadence that is 10–20 reviews a week, and a review with the transcript beside the record is maybe 5–10 minutes. Affordable, and it is what a validation exercise normally looks like. |
| **b** | **Every flagged call, plus a fixed random sample of the rest** | Cheaper, and still capable of estimating the miss rate — but the estimate's precision is set by the sample size, and at pilot volumes a 20% sample of unflagged calls is two or three calls a week. That is enough to catch a systematic failure and not enough to bound a rare one. |
| **c** | **Every flagged call only** | The one option that cannot answer the pilot's own question. See §1. |
| **d** | **Every call for the first N participants, then re-decide** | Front-loads the expensive work into the period where it is most informative, and makes the drop to sampling a decision with evidence behind it rather than a plan made before any data existed. |

**I would pick (d), falling back to (a).** The pilot's whole output is evidence
about an instrument nobody has characterised. Reviewing everything for the first
cohort costs a few hours a week and is the difference between "we think it works"
and a dataset.

### R-2 — How unflagged calls get sampled

| | Option | Consequence |
|---|---|---|
| **a** | **Random, seeded, and recorded before review begins** | The only version that supports a rate. A sample chosen after looking is not a sample. |
| **b** | **Every Nth call by time** | Simple and defensible; slightly weaker than random if anything about the call schedule correlates with risk — and it does, because evening calls and weekend calls are different populations. |
| **c** | **Reviewer's choice** | Whatever a coordinator finds interesting, which is not what a miss looks like. A miss looks boring by construction: it is a call the system said nothing about. |

**I would pick (a).** The point of the unflagged sample is to be unbiased, and (c)
is a way of spending review effort while learning nothing about recall.

### R-3 — What "reviewed" means the reviewer has done

| | Option | Consequence |
|---|---|---|
| **a** | **Read the record** | Cheap, and does not test the instrument at all — the record is what the agent produced, so reading it confirms the agent agrees with itself. |
| **b** | **Read the transcript against the record, and attest they match** | Tests the thing that matters: whether what was captured is what was said. This is what `/review/[id]` is built for. Slower, and the only version that can find a fabricated or dropped event. |
| **c** | **(b) plus re-grade independently before looking at the agent's grade** | The strongest, and the only one that measures grading agreement rather than checking it. Roughly doubles the time per call, and it is how you would qualify a grading instrument. |

**I would pick (b) for every reviewed call, and (c) for the unflagged sample.**
The unflagged sample is where recall lives, so it deserves the expensive version.

### R-4 — Who reviews

| | Option | Consequence |
|---|---|---|
| **a** | **The study coordinator** | Knows the participants, sees the calls anyway, and is also the person the agent escalates to — so a miss in their own queue is a miss they are motivated not to find. |
| **b** | **A second coordinator or a data manager** | Independent of the escalation path. Costs a second person's time. |
| **c** | **Coordinator for flagged calls, investigator for the unflagged sample** | Puts clinical judgement where recall is measured, which is where a missed grade 3 would actually be caught. |

**I would pick (c) if the investigator will sit for it, (a) otherwise** — with the
conflict in (a) written down rather than assumed away.

### R-5 — What happens when review finds a miss

| | Option | Consequence |
|---|---|---|
| **a** | **Correct the record, note it** | The minimum. The record is correct and nothing learns from it. |
| **b** | **Correct it, and add the utterance to the safety-net corpus** | Every real miss becomes a permanent regression test. This is how 27.0% becomes a number that moves. Costs almost nothing and is the highest-leverage thing on this page. |
| **c** | **(b) plus a stop rule: N misses of a given kind pauses the pilot** | The honest version. It requires deciding in advance what would be bad enough to stop, which is uncomfortable and is exactly why it should be decided in advance. |

**I would pick (b) now and (c) before any real participant.** A pilot with no stop
rule is a pilot that cannot fail, and one that cannot fail is not evidence.

### R-6 — What would justify reviewing less

| | Option | Consequence |
|---|---|---|
| **a** | **A measured miss rate below an agreed threshold, over an agreed number of calls** | Defensible, and requires agreeing the threshold and the number first. Without both, "it seems to be working" becomes the justification. |
| **b** | **Sponsor or IRB sign-off on the pilot data** | The formal route. Slow, and appropriate if this ever leaves shadow mode. |
| **c** | **Nothing during the pilot** | Simplest. The rate is what it is until the pilot ends and someone decides what happens next. |

**I would pick (c) for a shadow pilot.** Changing the measurement partway through
means the second half is not comparable to the first, and comparability is most of
what the pilot produces.

---

## 3. If you just want a default

**R-1: d · R-2: a · R-3: b, with c on the unflagged sample · R-4: c · R-5: b · R-6: c**

Review everything for the first cohort, sample the rest randomly and seeded, read
the transcript against the record, put the investigator on the unflagged sample,
turn every miss into a corpus entry, and do not change the rate mid-pilot.

**What that implies in code**

1. A seeded sampler that records which unflagged calls were selected, before
   review, so the selection is auditable (R-2 a). Small.
2. An attestation on the review page — who reviewed, when, and whether the record
   matched the transcript (R-3 b). Small, and it needs 5.7 answered first, since
   both are about writing to a completed call's trail.
3. A path from a reviewed miss into `tests/corpus/safety-corpus.json` (R-5 b).
   Small, and it is the one that compounds.

---

## 4. What I cannot decide

- **Whether the coordinator has the hours.** Every option above is a claim about
  somebody's week, and none of them are mine to spend.
- **Whether the investigator will re-grade** an unflagged sample, which is the
  difference between measuring grading agreement and asserting it.
- **What miss rate would be unacceptable.** That is a clinical and regulatory
  judgement about this protocol and this population, and an engineer picking a
  number would be inventing a threshold with nothing behind it — the same mistake
  the escalation windows were, before the site named them.
- **Whether the site's existing SOP already defines a review rate** for eDiary
  data, because a second contradictory one is worse than none.
