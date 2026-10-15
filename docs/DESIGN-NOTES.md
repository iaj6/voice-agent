# Design notes

The longer stories behind the decisions summarised in the [README](../README.md). Most of
them are a bug that reached "working" and was caught by running something, followed by
what changed. Numbers are dated where they can go stale; re-run the named command rather
than trusting the figure here.

Everything here concerns a synthetic protocol (ONX-301) and an invented roster. No real
participant has used this system.

---

## Asking beats listening

The deterministic safety net (`lib/clinical/safety.ts`) is a set of regex rules over the
raw utterance, run before the model sees it. It is measured against an annotated corpus
(`tests/corpus/safety-corpus.json`) by `npm run measure-net`, which prints a confusion
matrix and a breakdown by kind of phrasing. As of the last recorded measurement
(2026-08-27, the latest line of [`net-history.jsonl`](net-history.jsonl)), it catches
**25.7%** of signal-bearing utterances at 90.3% specificity on 523 utterances, and **0 of
81** colloquial phrasings. "My chest is killing me", "I get winded going to the bathroom",
"I just don't see the point in any of this anymore" all pass it silently.

Rather than chase that with more patterns, the check-in runs a **directed safety screen**
before the symptom review (`safetyScreen` in `lib/clinical/protocol.ts`): unplanned medical
care, chest pain or breathing, fever, bleeding or fainting, sudden neurological symptoms,
severe skin reactions, intent to stop the study drug, mood, and (only for a subject of
childbearing potential) pregnancy. Each is asked in fixed wording and answered yes or no.

That changes the problem rather than improving the solution. Listening for danger in
open-ended speech is the hard version. Asking outright turns it into a yes/no, which
transcription and a model both handle reliably.

A positive red flag escalates **deterministically, the moment the answer is recorded**:
`triggeredBy: "safety_net"`, no model judgment between the subject saying yes and a
coordinator being paged, and no waiting for the rest of the screen.

Mood is deliberately an open probe ("How have your spirits been?") rather than a red-flag
question. Screening for self-harm needs a validated instrument and ethics approval, not
wording an engineer wrote, and closing the gap by inventing wording would have been worse
than leaving it open and saying so.

The net still matters. It is the floor under the model for anything said outside the
screen. It is not the ceiling, and the model remains the primary detector for volunteered
speech.

## Fabricated answers and the turn boundary

**The first design of the screen was dangerous.** The tool originally took all the answers
in one call. When a call ended mid-screen, the model invented the remaining answers so it
could make the call: the record came back with a fever answer and a bleeding answer for
questions that were never asked. Recording each item as it lands
(`record_safety_screen_item`) removes the incentive rather than instructing against it,
and it makes a partial screen legible as partial instead of quietly complete. The eval
harness asserts that no screen item is recorded that was never asked.

The same failure had a second face. Told to work through a list, the model would write the
whole exchange itself (its question, an invented patient reply, its next question) and
reach "goodbye" in a single turn. Early on, it asked for a date of birth, wrote
`user\nMarch 4th, 1958` as the subject's answer, and passed that to `verify_subject`.

Stop sequences were the first defence and were not enough, for two reasons:

- **Streaming leaks the prefix.** The first characters of a stop sequence are emitted
  before the match completes, so a fragment fused with the next word and reached the
  speaker as *"usual bit rough honestly"*. The runner now holds back any suffix that could
  still become a stop sequence (`pendingStopPrefixLength` in `lib/agent/runner.ts`).
- **The model produces near misses.** "useleven", "useparse_ai_response", "usen0", "useful":
  never exactly `\nuser`, so an exact-match list stopped none of them.
  `lib/agent/turn-boundary.ts` cuts on structure instead: a blank line followed by more
  text, a role label at the start of a line, or a new line that resumes in lower case. The
  agent's output is spoken aloud and has no legitimate use for any of them.

Behind that, a provenance gate (`lib/clinical/provenance.ts`) refuses to record a
verbatim quote the participant did not actually say. A call with a rejection is ranked
above routine escalations in the review queue, because an instrument inventing quotes is a
fact about the system that a reviewer needs to see first. The prompt also makes ending the turn an explicit action:
*"the subject cannot answer until you stop."*

In a system whose job is capturing what a participant said, invented participant speech is
the worst output it can produce, so it is guarded in layers rather than by one rule.

## Not claiming a page that was not delivered

For a long stretch the escalation tool returned `notified: coordinator`, and the agent
said "your coordinator has been alerted" out loud, while nothing had been sent anywhere.
That was the one place the system told a sick person something untrue.

`lib/escalation/deliver.ts` now attempts delivery **before the tool returns**, so the
agent's next sentence reflects what happened. If the page did not go through, the tool
result says so and instructs the agent not to tell the subject anyone was notified, and to
tell them to contact their site directly. Missing configuration (no mail key, no
recipient, no public URL for the acknowledgement link) is a loud delivery failure, never a
silent default. It costs a few hundred milliseconds on a live call, which is the right
trade.

Delivery is email through Resend. A coordinator acknowledges through a link; the GET only
renders a button and the POST records the acknowledgement, because enterprise mail
scanners prefetch every URL in a message and would otherwise "acknowledge" an emergency
seconds after it was sent. A sweep (`/api/escalation/sweep`, every minute via Vercel Cron)
retries, pages a secondary contact when the response window closes, and raises an alarm
when the ladder runs out. A daily digest lists everything still unacknowledged. See
[`ONCALL.md`](ONCALL.md).

Grade 3 and above, and a positive seriousness determination, also page deterministically
when the model records them, rather than depending on the model to call
`escalate_to_coordinator` afterwards. The grade itself is still the model's proposal.

## The audit trail catches its own tampering

`lib/store/audit.ts` models the 21 CFR 11.10(e) requirement: computer-generated,
time-stamped, does not obscure prior information. Each entry commits to the SHA-256 hash
of its predecessor, so a retroactive edit breaks `verifyChain()`.

It earned its keep twice. The first version stored *references* to the caller's objects;
when a record was later corrected, the audit entry describing its creation silently
changed too, and the chain broke. The trail detected its own corruption before I did.
Entries now deep-clone their payloads, and `tests/audit.test.ts` pins the behaviour.

The second time was the move to Postgres. Postgres reorders JSONB keys, so an entry that
verified in memory failed the moment it was read back. Hashing now runs over a
canonicalised form, so storage order is irrelevant.

Content is sealed with a per-session AES-256-GCM key (`lib/store/seal.ts`,
`lib/store/keys.ts`). Erasure is **crypto-shredding**: `scripts/shred.mjs` destroys the
keys bound to a subject, after which the record and its audit trail still exist and still
verify, and the content cannot be read. A reason is required and recorded. See
[`RETENTION.md`](RETENTION.md).

The limit is worth stating plainly: the chain is unkeyed. It detects accidental or partial
edits. It does not stop someone who owns the database from rewriting history and
recomputing every hash. That needs an external anchor or WORM storage.

## Fever, and other places the code disagreed with itself

A [simulated clinical review](CLINICAL-REVIEW.md) found that the net's fever instruction
described neutropenic fever as an oncologic emergency and then paged at urgent, and that a
participant reporting fever was walked through fifteen more turns of data collection. On
a possible febrile neutropenia, that is time out of a one-hour door-to-antibiotics window.
A yes to the fever screen item now pages at emergency immediately; the agent asks once for
a measured temperature, records it, gives a fixed protocol-set instruction, and ends the
call.

The same review pointed out that a spouse knows the subject ID and date of birth, so a
proxy could pass verification and have their account recorded as the participant's own
words. `verify_subject` now records who is speaking (`self` or `caregiver`), and the
protocol carries a proxy-reporting policy. This adult protocol refuses caregiver reports
and ends the call without collecting anything. A pediatric protocol would invert that,
which is one of the items in [`PEDIATRIC-NOTES.md`](PEDIATRIC-NOTES.md).

## The microphone hears the agent

Running the console on laptop speakers produced this, unprompted:

```
AGENT    I'm sorry, I may not have come through clearly. Could you tell me your subject ID?
SUBJECT  "I'm sorry I may not have come through clearly"      <- the agent's own voice
AGENT    It sounds like there may be an echo on the line. Can you hear me all right?
SUBJECT  "it sounds like there may be an echo on the line"     <- again
AGENT    Something seems wrong with the connection. I'll have a coordinator reach out to you.
```

The agent diagnosed the echo and escalated, which was better than the code was doing. The
bug was mine: echo detection only ran on *interim* hypotheses, compared against the
sentence currently playing. Recognition finals arrive after playback ends, so every echo
went straight into the transcript. An echoed sentence entering the record is a fabricated
patient utterance. Three changes:

- **Half-duplex is the default.** The mic closes while the agent speaks. Barge-in is a
  toggle that says it needs headphones.
- **Finals are checked against a rolling window** of what was spoken in the last 20
  seconds (`lib/voice/echo.ts`).
- **Suppressed transcripts are counted, not dropped silently**, and shown in the Activity
  tab. A rising count means the channel is not trustworthy.

The heuristic is deliberately conservative: an exact run of four or more words. A tighter
threshold catches more echo and starts eating real answers ("any nausea, yes" right after
"have you had any nausea?"). Letting an echo through is visible and recoverable; discarding
real patient speech is silent data loss.

## The voice is part of the instrument

Speech is synthesised by ElevenLabs Flash v2.5 through `/api/speech`, with the browser's
own engine as a per-sentence fallback. The reason is not that it sounds better.
`SpeechSynthesis` renders a different voice depending on operating system and browser, and
an ePRO instrument that varies by the subject's device is a validation problem.
`lib/voice/tts-config.ts` pins voice, model, output format and settings as constants, so a
change is a deliberate act rather than a side effect of someone's laptop.

Measured head-to-head (one session, five interleaved runs each, best config against best
config):

| Config | Median TTFB | Range |
|---|---|---|
| ElevenLabs `eleven_flash_v2_5` (pcm) | 240ms | 236-274 |
| ElevenLabs `eleven_flash_v2_5` (mp3 stream) | 251ms | 233-275 |
| OpenAI `gpt-4o-mini-tts` (pcm) | 744ms | 578-962 |
| OpenAI `tts-1` (pcm) | 1,889ms | 1,480-2,154 |

The variance gap mattered more than the median gap: uneven pacing reads as a broken line
more than uniform slowness does. OpenAI is cheaper and accepts prose delivery instructions,
which ElevenLabs does not. Neither outweighed latency here. Output format mattered more
than expected: MP3 forces frame buffering on both providers.

**Fallback is not optional.** If the provider is slow or down, each sentence falls back to
local synthesis after a timeout. A robot voice is a degraded call; no voice is a broken
one. Fallbacks are counted and shown in the Activity tab, because those sentences were
spoken in a different voice than the pinned instrument.

## Fixed wording is a validity requirement that happens to be an optimisation

The first version of the speech cache hit on 9% of requests. The agent was paraphrasing
the protocol questions: "How has your energy been since we last spoke?" one call, "How have
you been feeling energy-wise?" the next.

The cache miss was the smaller problem. A solicited symptom question is an instrument
item. Its wording is what was reviewed, and two phrasings can elicit different answers. If
the agent improvises wording each call, no two subjects answered the same question, and the
dataset is quietly incomparable.

`lib/agent/fixed-speech.ts` is now the single source of wording the agent must deliver
word for word. It may put an acknowledgement in a separate sentence before one, never
inside it. The performance result followed from doing the clinically correct thing:

| | Cache hits | Spoken characters served from cache |
|---|---|---|
| Paraphrasing freely | 2 / 22 | 9% |
| Verbatim wording pinned | 9 / 16 | 57% |
| Warm units aligned to the sentence chunker | 16 / 19 | 79% |

What remains uncached is what should be: acknowledgements, the closing, and the read-back,
which is the only sentence carrying patient-reported content. That is also the only agent
speech routinely sent to the provider after the cache is warm.

## Acknowledge before you work

First-token latency used to scale with how much the turn had to record. The runner made a
model call, ran tools, made another call, and only produced speech on the final pass. In
the console that was invisible: the orb read *Processing* and the record panel filled in.
Take the screen away and it is up to ten seconds of silence, which a patient on a phone
reads as a dropped call. The visual affordance was compensating for an architectural
problem, and nothing surfaced it until the interface was removed (see
[`SPIKE-elevenlabs-agents.md`](SPIKE-elevenlabs-agents.md)).

The fix was a prompt rule: say one short acknowledgement in the same turn, before the tool
calls, so it streams while the writes happen behind it. An early spot measurement showed a
three-tool turn dropping from about 10.7s to 2.5s to first token. A later, broader
measurement with `npm run latency` found the first sentence leaving the server at about
5.2s p50 on subject turns, partly because the rule is not always followed. Latency is
tracked against a target in [`SPEC.md`](SPEC.md) (N-01), and it is currently missed.

## A connection-pooling bug worth knowing about

Node 26's built-in `fetch` negotiates HTTP/2 to `api.anthropic.com`. In a long-lived
server the pooled h2 session goes stale while idle, and every later request on it fails
with `ERR_HTTP2_INVALID_SESSION`, including the SDK's own retries, which reuse the same
pool. A dev server idle for a few minutes failed every turn until restarted.

`lib/agent/runner.ts` pins its own `undici` agent with `allowH2: false` and a bounded
keepalive. There is also a retry that only fires before the first token is spoken; after
that, retrying would make the agent repeat itself mid-sentence.

## The eval harness's own failure mode

Most persona expectations are negative ("nothing recorded", "not verified"), which a total
API outage satisfies trivially. An early run reported 39/39 green while nearly every turn
was failing with a connection error. There is now an unconditional "call completed without
transport errors" check evaluated first, and a persona aborts after two consecutive failed
turns. A suite that passes during an outage is worse than no suite.

The personas are model-driven, so a single failing assertion is as likely to be sampling
variance as a regression. `npm run eval:stability` reports a rate rather than a verdict.
That is the same argument the project makes about qualifying a non-deterministic system:
characterise behaviour over runs, do not assert it once.

## Severity and seriousness are different axes

- **Severity** is CTCAE grade 1-5, graded from function, not adjectives. "Terrible" is not
  grade 3; "my daughter had to help me shower" is. Every adverse event stores
  `gradeRationale`, one sentence of functional evidence, so a coordinator can check the
  grade rather than take it on faith, alongside the participant's verbatim words.
- **Seriousness** is a regulatory determination against the ICH E2A / 21 CFR 312.32
  criteria. A grade 3 event is not automatically serious, and a grade 2 event can be.

The simulated clinical review argues that seriousness should set the reporting clock and
not the response urgency. That is open; see [`CLINICAL-REVIEW.md`](CLINICAL-REVIEW.md) §2.

## What it will not say

The prompt's prohibitions are the highest-leverage text in the repo: no diagnosis, no
medical advice, no telling a subject to change a dose, no reassurance ("that's normal" is
how serious events get reported late), no talking anyone out of withdrawing, and no
inventing a value the subject did not give. Several are asserted in the eval harness,
because a prompt rule you do not test is a wish.
