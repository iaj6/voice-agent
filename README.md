# ONX-301 Voice Check-In Agent

A prototype voice check-in for participants in a clinical trial. The participant talks to
it in a browser; it verifies who they are, asks a fixed safety screen and the
protocol's symptom questions, records adverse events with the participant's own words and
a proposed CTCAE grade, pages a human coordinator when a red flag comes up, and writes
everything to a hash-chained audit trail that a reviewer can check. Speech in and speech
out are the easy part. Most of this codebase is about what happens around the model: what
it is not allowed to decide, what it must not say, and what the record can prove later.

**Synthetic protocol, invented roster, no real participants. This is not a medical device
and is not validated for clinical use.**

## Why this might interest a pediatric nursing team

This is a prototype voice check-in for an adult oncology trial, built on synthetic data
with no real patients. The hard problems carry over to pediatric nursing: asking symptom
questions in fixed, validated wording; getting a red flag to a human reliably without
depending on the AI's judgment; and keeping a record a nurse can check rather than take on
faith. A pediatric version would need things this one lacks. They are listed in
[`docs/PEDIATRIC-NOTES.md`](docs/PEDIATRIC-NOTES.md).

## Design decisions worth reading

**Asking beats listening.** The first safety control was a keyword net that scans every
utterance before the model sees it. Measured against an annotated corpus it misses most
real signals, and it catches none of the colloquial ones ("my chest is killing me"). Rather
than chase that with more patterns, the call now asks a short directed screen in fixed
wording (hospital visits, chest pain or breathing, fever, bleeding or fainting, stroke
signs, severe skin reactions, intent to stop the drug, mood, and pregnancy where it
applies). A "yes" to a red-flag item pages a coordinator deterministically, from code, the
moment the answer is recorded. The model is not asked whether it is worth escalating. The
keyword net stays as a floor under everything said outside the screen.

**Recording one answer at a time, and cutting invented turns.** When the screen was one
tool call taking every answer, the model filled in answers to questions it never asked so
it could make the call. Each item is now recorded as it is answered. Separately, the model
sometimes kept writing past its own turn and invented the participant's reply. Exact-match
stop sequences leaked through streaming and missed near-miss spellings, so a structural
turn-boundary guard now cuts the turn, and a provenance gate refuses to record a quote the
participant did not say.

**Never claiming a page that was not delivered.** The agent used to say "your coordinator
has been alerted" when nothing had been sent. Delivery now happens before the tool
returns, and if it fails the agent is told not to claim otherwise and to direct the
participant to their site. Undelivered or unacknowledged pages are retried, escalated to a
backup contact, and alarmed by a cron sweep.

**Fever stops the call, and the record says who answered.** Following a
[simulated clinical review](docs/CLINICAL-REVIEW.md), a "yes" to the fever item pages at
emergency immediately. The agent asks once for a measured temperature, records it, gives a
fixed protocol-set instruction, and ends the call instead of continuing to collect data.
`verify_subject` records whether the participant or a caregiver is speaking. This adult
protocol does not accept caregiver reports and ends the call without collecting anything;
a pediatric protocol would accept them and tag every record with the respondent. The
review UI shows who answered.

**An audit trail that can be checked, and content that can be erased.** Every write
appends a SHA-256 hash-chained audit entry, so an edit to history breaks verification.
Content is sealed with a per-session key, and erasure destroys the key (crypto-shredding),
so the trail still verifies after the content is gone.

The longer stories, with the bugs that led to each decision, are in
[`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md).

## Architecture

```
browser mic ──PCM──► POST /api/stt/stream   Deepgram relay (key stays server-side);
                                            falls back to the browser's Web Speech API
transcript ───────► POST /api/chat (SSE)
                       1. deterministic safety net (regex, before the model)
                       2. Claude agent, streaming, with tools that write the record
                          (directed screen and grade >= 3 page from code)
                       3. turn-boundary guard + sentence chunker ──► speak events
speak events ─────► /api/speech             ElevenLabs TTS, cached for fixed wording;
                                            browser speech as per-sentence fallback
record + audit ───► Neon Postgres           in-memory store when DATABASE_URL is unset
escalations ──────► email via Resend        ack link, retry/backup/alarm sweep (cron),
                                            daily digest
review ───────────► /review                 behind VOICE_AGENT_REVIEW_SECRET
```

There is also `/api/v1/chat/completions`, an experimental OpenAI-compatible endpoint that
would let ElevenLabs Agents own telephony and audio while this server keeps the agent,
safety net and record. It was validated end to end against a live ElevenLabs agent through
a temporary tunnel, and is not deployed; see
[`docs/SPIKE-elevenlabs-agents.md`](docs/SPIKE-elevenlabs-agents.md).

The agent has eight tools (`lib/agent/tools.ts`): `verify_subject`,
`record_safety_screen_item`, `record_adverse_event`, `assess_seriousness`,
`record_adherence`, `record_concomitant_medication`, `escalate_to_coordinator`,
`complete_check_in`. Every handler writes to the audit trail.

| Path | What lives there |
|---|---|
| `lib/agent/` | Runner (safety scan, model and tool loop, SSE), system prompt, tools, fixed wording, turn-boundary guard, sentence chunker |
| `lib/clinical/` | Protocol and synthetic roster, safety net and CTCAE/seriousness definitions, ConText negation, provenance gate, calling hours, locale (emergency numbers) |
| `lib/escalation/` | Raising, delivering, acknowledging and sweeping escalations; message composition; response windows; daily digest |
| `lib/store/` | Session store (Postgres or memory), audit chain, sealing and keys, deliveries, migrations |
| `lib/review/` | Review queue ordering and the shared-secret gate |
| `lib/voice/` | Recognizer and synthesizer interfaces, Deepgram relay, ElevenLabs, echo suppression, speech cache, WER |
| `lib/observability/` | Drift and reconciliation checks |
| `lib/telephony/` | Caller identity handling for a future phone path |
| `app/` | Console (`/`), review UI (`/review`), API routes |
| `scripts/` | Migrations, eval harness, net measurement, latency, shredding, sweep |

## Running it

Prerequisites: Node 24 or later (CI uses 24), Chrome or Edge for the microphone, and an
Anthropic API key. Everything else is optional and degrades in a stated way.

```bash
npm install
# put the variables below in .env.local
npm run db:migrate               # only if DATABASE_URL is set
npm run dev                      # http://localhost:3100
npm run warm-speech              # optional: pre-render fixed wording (dev server must be up)
```

Test identities: `001-0042` / `1958-03-11`, `001-0055` / `1971-11-02`, `002-0013` /
`1949-07-24`, `002-0027` / `1992-05-19`. There is a text box on the console if you would
rather not talk.

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Model access. The SDK's normal credential chain applies |
| `DATABASE_URL` | Neon Postgres. Unset means an in-memory store (fine for dev and tests, lost on restart) |
| `DATABASE_URL_UNPOOLED` | Direct connection used by migrations and the scratch test database |
| `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL` | Streaming recognition through the relay. Model defaults to `nova-3-medical`. Unset falls back to browser recognition |
| `ELEVENLABS_API_KEY` | Pinned neural voice. Unset falls back to browser speech |
| `RESEND_API_KEY`, `ESCALATION_EMAIL_FROM`, `ESCALATION_EMAIL_TO` | Escalation email. Missing any of these makes every escalation a recorded delivery failure, not a silent success |
| `ESCALATION_EMAIL_SECONDARY`, `ESCALATION_EMAIL_ALARM` | Backup contact, and where the alarm goes when the ladder runs out (defaults to the primary) |
| `CRON_SECRET` or `ESCALATION_SWEEP_SECRET` | Bearer token for the sweep and digest endpoints. Unset means they refuse to run |
| `VOICE_AGENT_REVIEW_SECRET` | Gate for `/review` and the review APIs. Unset means review is unavailable (fails closed) |
| `VOICE_AGENT_PUBLIC_URL` | Base URL for acknowledgement links. Required in production |
| `VOICE_AGENT_CALL_WINDOW` | Hours the agent takes calls, e.g. `Mon-Fri 09:00-17:00 America/New_York`. Unset means always open |
| `VOICE_AGENT_EFFORT`, `VOICE_AGENT_FAST_MODE` | Reasoning effort (default `medium`) and fast mode, both latency trade-offs |
| `VOICE_AGENT_URL` | Base URL the eval and warm scripts drive (default `http://localhost:3100`) |
| `VOICE_AGENT_SPIKE_LOG`, `VOICE_AGENT_RAW` | Debug dumps of raw conversations. Dev only |

## Testing and measurement

```bash
npm run verify          # the gate: types, lint, unit tests, build, safety-net floor
npm test                # unit tests; Postgres suites skip without database credentials
npm run measure-net     # safety-net confusion matrix against the annotated corpus
npm run eval:fast       # simulated-patient eval, fast personas (needs dev server + API key)
npm run eval            # all personas
npm run eval:stability  # fast personas five times, to report a flake rate
npm run latency         # time to first audio from recorded turns (needs the database)
```

Unit tests cover the audit chain, safety net and negation handling, echo suppression,
speech cache keys, escalation delivery and sweep, acknowledgement, review auth and queue
ordering, crypto-shredding, resume after a dropped call, migrations, and the provenance
gate. Tests that need Postgres create and drop a scratch database and never touch the
configured one.

`scripts/simulate.mjs` drives the real HTTP stack with a second Claude instance playing a
participant. It has eight personas (routine, SAE, chest pain, chest pain at a UK site,
withdrawal, screen-positive fever, screen-positive emergency, failed verification), each
with assertions, plus invariants checked on every call: audit chain intact, no medical
advice, no false reassurance, no fabricated participant speech, no screen item recorded
that was never asked. The personas are model-driven, so results are rates, not a pass/fail
gate.

The keyword net's sensitivity is tracked in
[`docs/net-history.jsonl`](docs/net-history.jsonl). As of the last recorded measurement
(2026-08-27, `npm run measure-net`), it caught 25.7% of signal-bearing utterances at 90.3%
specificity on a 523-utterance corpus, and 0 of 81 colloquial phrasings. That is why the
directed screen exists.

## Limitations

- **Not validated, not a medical device.** No IQ/OQ/PQ, no traceability matrix, no
  IRB-reviewed script. Grades are the model's proposals for a human to confirm, and the
  review UI does not yet have controls to confirm or change them.
- **The audit chain is tamper-evident, not tamper-proof.** It catches accidental or partial
  edits. It is unkeyed and not externally anchored, so someone who owns the database can
  rewrite history and recompute the hashes.
- **Escalation is email only**, through one provider. No SMS, paging service, on-call
  rota, or EHR integration.
- **No per-user clinician identity.** The review UI and coordinator actions sit behind one
  shared secret. Acknowledgement links are unauthenticated tokens.
- **Identity is knowledge-based** (subject ID plus date of birth), which a family member
  also knows.
- **English only.** Another language would be a separately validated instrument, not a
  translation.
- **The keyword net is weak**, as measured above. Anything volunteered outside the screen
  relies on the model or the human reviewer.
- **Participant audio and some agent text go to third parties** (Deepgram, ElevenLabs,
  Anthropic). A real deployment needs agreements with each and consent language covering
  them.
- **Mood is an open question**, not a validated suicide-risk screen.

More detail: [`docs/SPEC.md`](docs/SPEC.md) (product spec and risk register),
[`docs/CLINICAL-REVIEW.md`](docs/CLINICAL-REVIEW.md) (a simulated clinician review),
[`docs/ONCALL.md`](docs/ONCALL.md) (escalation ladder), [`docs/RETENTION.md`](docs/RETENTION.md)
(retention and erasure), [`docs/REVIEW-RATE.md`](docs/REVIEW-RATE.md) (how much to review),
[`docs/BACKLOG.md`](docs/BACKLOG.md), [`docs/LESSONS.md`](docs/LESSONS.md).

## License

MIT. See [`LICENSE`](LICENSE).
