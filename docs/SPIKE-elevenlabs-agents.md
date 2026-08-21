# Spike: ElevenLabs Agents Platform with a custom LLM

**Question.** If ElevenLabs owns audio capture, turn detection, transcription, speech,
and telephony, does the regulated core of this system survive — or does it dissolve the
way it would behind a speech-to-speech model?

**Answer. It survives, and the reason is the direction of the call.** ElevenLabs POSTs
the transcript to us and waits for text back. The deterministic safety net still runs on
the subject's words before Claude sees them; the tool loop still writes the eCRF; the
audit trail still records every turn. We hand over the audio path and keep the entire
regulated core.

Status: **validated end to end against a live ElevenLabs agent.** Their runtime called
our endpoint, consumed our SSE, and drove a real multi-turn check-in — greeting delivered
verbatim, subject verified, a Grade 3 adverse event captured and escalated, audit chain
intact.

    agent_id  agent_9201m0dkz8w6e47secjp36sqmwhn
    server    https://guides-adaptation-widespread-salt.trycloudflare.com/api/v1

---

## The contract

ElevenLabs speaks OpenAI Chat Completions. It POSTs to `{server_url}/chat/completions`
with `stream: true` and expects SSE chunks terminated by `data: [DONE]`.

Implemented at `app/api/v1/chat/completions/route.ts`, so the agent's **Server URL is
`https://<host>/api/v1`** — not the full path. OpenAI-compatible clients append
`/chat/completions` themselves. Getting this wrong produces a 404 that looks like the
endpoint is broken; it cost a debug cycle here.

Fields actually observed on the wire: `messages`, `model`, `stream`, `user_id`.

```
ElevenLabs                          our server
──────────                          ──────────
mic ─► VAD ─► Scribe ─► transcript
                          │
                          └─ POST /api/v1/chat/completions
                                     │
                                     ├─ deterministic safety net   ◄── still ours
                                     ├─ Claude Opus 5 + tool loop  ◄── still ours
                                     ├─ eCRF writes + audit trail  ◄── still ours
                                     │
                          ┌──────────┘ SSE text
                          ▼
        TTS ─► speakers / phone
```

## What was verified

| Property | Result |
|---|---|
| Official OpenAI SDK consumes our stream | ✅ over the public tunnel, no parse errors |
| Deterministic safety net fires on the transcript | ✅ `[emergency] chest pain` matched before Claude saw it |
| Two independent escalation paths preserved | ✅ 1 via `safety_net`, 6 via `agent` |
| Tool loop writes the eCRF | ✅ verification, AE recording, seriousness, escalation |
| Audit chain intact | ✅ valid on all 19 turns |
| Multi-turn session continuity | ✅ 7 distinct sessions tracked across 19 requests |
| Verbatim instrument wording survives | ✅ greeting and questions delivered word for word |

## The finding that mattered

The spike was supposed to answer an integration question. It surfaced a latency bug that
the browser UI had been hiding.

First-token latency, by how much tool work the turn required:

| Turn | Before | After | |
|---|---|---|---|
| Opening (no tools) | 2,011ms | 1,932ms | — |
| Verification (1 tool) | 5,546ms | **2,395ms** | −57% |
| Grade 3 report (3+ tools) | 10,703ms | **2,462ms** | −77% |

The tunnel accounted for ~500ms of that. The rest was the tool loop: our runner made a
model call, ran tools, made another model call, ran more tools, and only produced speech
on the final pass. Ten seconds of it on a heavy turn.

In the browser this is invisible — the orb says *Processing*, the record panel fills in,
the operator sees work happening. **On a phone line it is ten seconds of silence, which a
patient reads as a dropped call.** The visual affordance was compensating for an
architectural problem, and nothing surfaced it until the UI was taken away.

The fix is a prompt rule, not code: acknowledge before you work. The agent now says one
short sentence — "Thank you for telling me." — in the same turn, *before* the tool calls.
Claude emits it as a text block ahead of the `tool_use` blocks, so it streams immediately
and the tool work happens while the acknowledgement is being spoken. Total turn time is
unchanged; perceived latency drops by three quarters.

This applies to the browser path too. It was always a defect there; it was just
survivable.

## Creating the agent

The dashboard permission is called **ElevenAgents**; the API scope is `convai_write`. With
it set to Write, creation is scriptable. Three things cost a cycle each:

1. **`api_key` must be omitted entirely.** Passing `{"secret_id": ""}` returns a 500, not a
   validation error.
2. **English agents reject `eleven_flash_v2_5`** — "English Agents must use turbo or flash
   v2". The platform takes `eleven_flash_v2`. This matters for instrument pinning: the
   browser path and the Agents path would render the same voice through *different models*,
   so they are not bit-identical instruments. Pin `eleven_flash_v2` in both, or document
   the channels as separate.
3. **Server URL is the base, not the endpoint** — `https://<host>/api/v1`. Clients append
   `/chat/completions`.

What ElevenLabs' live runtime actually sends: `messages`, `model`, `stream`,
`stream_options`, `temperature`, `max_tokens`.

**Their agent prompt is inert here.** ElevenLabs wraps the dashboard prompt into a `system`
message we discard — our own system prompt is the validated instrument. Correct for this
design, but a real trap for anyone expecting the dashboard field to change behaviour.

**`simulate-conversation` returns 500** even though every call to our endpoint succeeds. It
appears to be a batch harness that waits for whole turns; ours take 3–7.5s. Irrelevant to a
live call, which consumes the stream and hears the first words at ~2.5s — but it means that
endpoint is not usable as a test harness against this backend.

### To drive it with a real microphone

The agent exists and is wired. Open it in the ElevenLabs dashboard and use the built-in
test widget, or embed the web widget.

One caveat: the tunnel URL is a disposable `trycloudflare.com` address that dies with the
process. After restarting it, patch the agent:

```bash
curl -X PATCH https://api.elevenlabs.io/v1/convai/agents/agent_9201m0dkz8w6e47secjp36sqmwhn \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"conversation_config":{"agent":{"prompt":{"custom_llm":{"url":"https://NEW-HOST/api/v1","model_id":"onx-301-check-in"}}}}}'
```

## What this would buy

- **Real acoustic echo cancellation.** The platform runs on LiveKit/WebRTC
  (`default_livekit_stack = standard`). This is the actual fix for the bug where our mic
  captured the agent's own voice; half-duplex is a workaround for the lack of it.
- **Proper turn detection** instead of Chrome's silence heuristic.
- **Telephony.** A phone number, which is what this population would actually use.
- **One fewer subprocessor** than adding Deepgram separately.

## What it would cost

- **ElevenLabs owns turn detection.** The transcript arrives already segmented by their
  VAD. We would no longer control what counts as the end of an utterance — which matters,
  because a subject who trails off mid-symptom is a clinical event, not just a pause.
- **The safety net moves downstream of their ASR.** It currently scans what Chrome heard;
  it would scan what Scribe heard. Better transcription, but a transcription error can
  now suppress a rule match. Worth pairing with Scribe's per-word confidence scores.
- **Their tool-calling path is unused.** ElevenLabs can pass `tools` and execute them
  itself; we ignore that and run our own loop internally, returning only final text. Fine,
  but it means their platform tools (transfer-to-human, end-call) are not wired.
- **Another hop for PHI.** Patient audio would reach ElevenLabs, not just the agent's
  outbound text. That is a materially larger subprocessor surface than TTS alone.

## A second bug the spike exposed

With "acknowledge before you work", one turn emits text, runs tools, then emits more text —
two model passes whose deltas get concatenated by the consumer. They joined flush against
each other, which ElevenLabs read back to us verbatim:

> "I'm writing that down.**I've** let your coordinator, Dana, know"

Wrong in the transcript, worse in speech: the sentence splitter needs whitespace after a
full stop to see a boundary, so those two sentences would have been read aloud as one
run-on. `lib/agent/runner.ts` now inserts a separator when a new tool-loop iteration
produces text after an earlier one already did. Affects the browser path identically — it
was simply never visible there.

## Files

- `app/api/v1/chat/completions/route.ts` — the shim
- `.spike-logs/elevenlabs-requests.jsonl` — every payload received, gitignored.
  **Off by default since the 1.6 retention review**: it records the whole conversation
  in plaintext, unrotated, outside every retention control the system has. Re-enable
  for spike work with `VOICE_AGENT_SPIKE_LOG=1`; it is refused under
  `NODE_ENV=production` regardless.
- Prompt change: `lib/agent/system-prompt.ts`, the "Speak before you work" rule
