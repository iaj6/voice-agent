# On-call model and response times — decisions needed

**Status:** options, awaiting decision · **Backlog item:** 2.6 (Tier C) · **Owner:** Ian Jones + site

The escalation ladder is built and working: a page goes out, an unacknowledged one reaches
a backup, and an exhausted ladder raises an alarm. What it does not have is a set of
numbers anyone agreed to. The windows in `lib/escalation/sla.ts` are mine, invented so the
code had something to compare against, and they are the wrong kind of thing to leave to an
engineer.

Reply with a letter per decision and I will turn it into policy and the config it implies.

---

## 1. The thing to be clear about first

**The escalation ladder is not what keeps a participant safe.** When the deterministic net
fires on "I have had chest pain since last night", the agent tells the subject to hang up
and call emergency services *now*. That is the safety mechanism, it happens in the same
breath, and it does not wait for anybody.

The ladder is how the **site finds out**. Which means the response window is not "how long
until this participant gets help" — it is "how long until the people responsible for their
trial participation know something happened."

That reframes every number below, and it is easy to get backwards. A five-minute emergency
window feels urgent and humane; it is not rescuing anyone. What it buys is a coordinator
who can call the participant back, check they actually went, tell the investigator, and
start the paperwork clock — while it is still the same afternoon.

**The clock it sits inside.** ICH E6 requires serious adverse events to be reported to the
sponsor immediately, and this protocol operationalises that as
`saeReportingWindowHours: 24` — 24 hours from the site becoming *aware*. An escalation
sitting unacknowledged is the site not yet being aware. So the acknowledgement window is
the front half of a regulatory clock: a page that sits for twenty hours leaves four hours
for everything else.

---

## 2. What is already built

| | |
|---|---|
| Ladder | primary contact → backup contact → alarm, each recorded as its own delivery attempt |
| Retry | 3 out-of-band retries, 60s backoff, then the ladder moves on |
| Acknowledgement | one-time signed link; a GET shows a button, a POST records it; scanners cannot acknowledge |
| Alarm | audit entry on the participant's record, plus a message to the alarm address |
| Windows | **placeholders**: emergency 5 min, urgent 60 min, routine 24 h |
| Sweeper | `POST /api/escalation/sweep`, shared-secret; **nothing schedules it yet** |

Two gaps worth naming before the options, because they change what the options mean.

**Nothing schedules the sweep.** The ladder only advances when something calls it. Until a
cron exists, an unacknowledged emergency stays unacknowledged forever and no backup is ever
paged. This is config, not code, and it is the single most load-bearing line of ops in the
system.

**Nothing restricts when a check-in can happen.** The agent will take a call at 03:00 and
escalate into an inbox nobody is watching. See D-C, which is the decision this creates.

---

## 3. The decisions

### D-A — The response windows

The window is "time until a human acknowledges", per urgency tier.

| | Option | Consequence |
|---|---|---|
| **a** | **5 min / 1 h / 24 h** (my placeholders) | Emergency demands a phone in a hand. Realistic only with genuine on-call cover; without it, every emergency alarms and the alarm stops meaning anything. |
| **b** | **15 min / 4 h / next business day** | Achievable by a coordinator who is working and checking mail. Still leaves ~23 h of the SAE clock. |
| **c** | **1 h / 8 h / 5 days** | Comfortable, and close to meaningless for an emergency tier — an hour is long enough that the agent's "call 911" was the entire safety response. |
| **d** | **Tie the tiers to the SAE clock**: emergency 15 min, urgent 2 h, routine 24 h, with the alarm firing at 50% of the 24 h regulatory window regardless of tier | Makes the numbers derive from something rather than from taste. More moving parts. |

**I would pick (b).** (a) is the number you choose if you have not asked who is holding the
phone. The honest test for any of these: if the site cannot commit to it at 2am on a
Sunday, it is not the window — it is the aspiration.

### D-B — Who is on call

| | Option | Consequence |
|---|---|---|
| **a** | **One named coordinator, business hours** | Simplest, and true of most single-site pilots. Everything outside those hours is D-C. |
| **b** | **Primary + backup, business hours** | What the ladder already assumes. Backup catches "she's in a clinic all afternoon", which is the common failure, not heroics. |
| **c** | **Rota with 24/7 cover** | The only model where a 5-minute emergency window is real. Expensive, and unusual for 10–20 participants. |
| **d** | **Primary + backup in hours, investigator-on-call out of hours** | Realistic for oncology, where an on-call physician usually exists for the standard of care anyway. Needs the investigator to agree to be in the ladder. |

**I would pick (b) for the pilot, and (d) if the site already has a physician on call.**
The ladder supports either today — it is two environment variables.

### D-C — What happens outside cover

This is the decision nobody has made, and the system currently makes it by accident.

| | Option | Consequence |
|---|---|---|
| **a** | **Nothing. Calls run at any hour; out-of-hours escalations wait.** | Status quo. The participant is still told to call emergency services, so nobody is unsafe — but "the site was notified" can mean nine hours later, and the SAE clock has been running that whole time. |
| **b** | **Restrict when the agent will take a call** to the hours somebody is on call. Outside them, the agent does not run. | Makes the promise and the cover match. Costs participants some convenience — evenings are when people are home — which is a real trade against the eDiary this runs alongside. |
| **c** | **Run any hour, but out-of-hours escalations page the on-call physician (D-B d)** | Best of both, and only available if a physician is in the ladder. |
| **d** | **Run any hour; out-of-hours emergencies end the call with emergency-services guidance and no claim of notification** | Honest, and the agent already does most of this — it only claims notification when delivery actually succeeded. Formalises it. |

**I would pick (b) unless (c) is available.** It is the only option where the phrase "your
coordinator has been alerted" is true at the moment it is said, and the agent says that
sentence to frightened people.

### D-D — What the alarm does

The alarm fires when the ladder is exhausted: nobody acknowledged, at any rung.

| | Option | Consequence |
|---|---|---|
| **a** | **Email to the alarm address** (current) | Same channel that already failed to get a response. Weakest possible answer to "email is not being read." |
| **b** | **A different channel** — SMS, or a phone call to the site's main line | The point of an alarm is to leave the channel that is not working. Needs a second provider. |
| **c** | **Email plus a standing daily digest of anything unacknowledged** | Cheap, catches the slow failures, useless for an emergency. |
| **d** | **Alarm escalates to the sponsor's medical monitor** | Correct for a real trial, heavy for a shadow pilot, and needs someone at the sponsor to agree to receive it. |

**I would pick (a) + (c) for the pilot, and (b) before any real participant.** Alarming by
email into an inbox that just ignored two emails is a design that only looks finished.

### D-E — Who may acknowledge

| | Option | Consequence |
|---|---|---|
| **a** | **Possession of the link** (current) | Works, unauthenticated, and records an IP rather than a person. Fine for a fabricated roster; not fine when "who acknowledged this" is evidence. |
| **b** | **Site SSO / existing auth in front of the acknowledgement page** | Named individuals, attributable. Needs the site to have something to authenticate against. |
| **c** | **Link plus a typed name** on the confirmation page | No infrastructure, and an attestation rather than an authentication — weaker than SSO, considerably better than an IP. |

**I would pick (c) now and (b) before a pilot.** The current state is honestly documented
in the route, but an acknowledgement attributed to `203.0.113.44` is not a record of a
human taking responsibility.

### D-F — Who runs the sweeper, and how often

| | Option | Consequence |
|---|---|---|
| **a** | **Vercel Cron every minute** | Matches the tightest window: an unacknowledged emergency reaches the backup within about six minutes of a five-minute SLA. |
| **b** | **Every 5 minutes** | Cheaper, and adds up to a full extra tier-window of delay on the emergency path. |
| **c** | **External scheduler the site controls** | Right if the site runs its own ops. Adds a dependency on somebody else's uptime for the alarm path. |

**I would pick (a).** The sweep is idempotent by construction and costs nothing when there
is nothing to do; the reason to run it often is that the alarm is the only thing standing
behind a page nobody read.

---

## 4. If you just want a default

**D-A: b · D-B: b · D-C: b · D-D: a+c · D-E: c · D-F: a**

Windows a working coordinator can actually meet, primary and backup, calls restricted to
the hours somebody is on call, alarm by mail plus a daily digest of anything outstanding, a
typed name on the acknowledgement, and a one-minute cron.

**What that implies in code**

1. A calling window — refuse to start a check-in outside it, with a spoken line that says
   when to call back (D-C b). Small, and it is the only item here that changes what a
   participant experiences.
2. A typed name on the acknowledgement page, stored instead of the IP (D-E c). Small.
3. A daily digest of unacknowledged escalations (D-D c). Small, and it reuses `overdue()`.
4. The cron itself (D-F a). Config.
5. New window constants (D-A b). One file.

---

## 5. What I cannot decide

- **Whether anyone is actually on call**, and during which hours, in which timezone. Every
  number above is downstream of that one fact.
- **Whether the site will accept a calling window**, which trades participant convenience
  for a promise the system can keep.
- **Whether the investigator will sit in the ladder** out of hours.
- **What the site's existing on-call SOP already says**, because a second, contradictory
  on-call model is worse than none.
