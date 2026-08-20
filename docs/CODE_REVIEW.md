# Code review

What to run, and what this codebase gets wrong repeatedly.

## Before every push

```bash
npm run verify      # enforced by .githooks/pre-push — types, lint, tests, safety floor
npm run eval:fast   # if the change touches the conversation at all
/code-review high   # in Claude Code, on the diff
```

`verify` is enforced because it is a command. Review is not enforceable the same way —
it needs judgement — so the pre-push hook asks, and `.claude/settings.json` blocks a push
from an agent session that has skipped it.

## What actually goes wrong here

This is not a generic checklist. Every item is a bug that reached "working" in this
repository and was caught by running something rather than by reading a diff.

### 1. A safety control gets weaker as a side effect

The recurring failure. Twice now an improvement quietly degraded a control:

- ConText negation, added to cut false positives, **double-negated the negation-bearing
  idioms** — "I don't want to live anymore", "I can't breathe" — and disarmed the
  highest-stakes rules in the system.
- Editing regex patterns for one reason dropped recall on a topic nobody was looking at.

**Ask:** does this change alter what the safety net catches? If you cannot answer from
the diff, run `npm run measure-net` before and after. The gate holds a sensitivity floor
for exactly this reason. If a change legitimately lowers it, move the floor deliberately
and say why in the commit.

### 2. Something looks finished because the part you notice works

- The eval harness reported **39/39 green during a total API outage** — most persona
  expectations are negative, and an outage satisfies those trivially.
- A `--repeat` stability block printed its header and silently stopped, because it called
  a colour helper that did not exist.
- The audit chain verified perfectly in memory and broke on the first read back from
  Postgres, because **Postgres reorders JSONB keys**.

**Ask:** what would this look like if it were broken? If the answer is "the same", the
check is not a check. Negative assertions especially need a positive control alongside
them.

### 3. A design gives the model something to gain from fabricating

- A tool that took all six safety-screen answers **in one call** led the model to invent
  the answers it did not have so it could make the call.
- A checklist of six questions led it to write its question, an invented patient reply,
  its next question, and reach "goodbye" in a single turn.
- Fabricated speech then reached the eCRF: an adverse event recorded from words no
  subject spoke.

**Ask:** does this change create pressure to produce a value the model does not have? An
instruction not to fabricate is weaker than a design with nothing to gain from it. Prefer
recording one thing at the moment it is known over batching.

### 4. A control is correct at the boundary and leaks past it

Stop sequences exclude a matched sequence from the final message — but streaming emits
its opening characters before the match is known, and a leaked fragment fused with the
next word and was **spoken aloud to the participant**.

**Ask:** is this control applied everywhere the data goes, or only where it is checked?
The record and the loudspeaker are different destinations.

### 5. Mutable references in an immutable record

The audit trail held references to live domain objects. A later correction rewrote the
entry describing the original capture, and the chain broke — the trail detected its own
corruption.

**Ask:** does anything written to the audit trail share identity with something still
being mutated?

## Severity

Findings in the safety net, escalation, the eCRF write path, or anything a participant
hears are **blocking**, whatever their apparent size. Everything else is a judgement call.

A miss is a gap. A fabrication is a lie in a regulated record with a participant's name
on it. They are not the same severity and should not be triaged the same way.

## Scope note

`npm run verify` deliberately excludes the simulated-patient eval: it needs a live server
and a model provider, and a gate that is sometimes unavailable stops being run. Run
`npm run eval:fast` alongside it, and the full `npm run eval` before a sprint closes.
