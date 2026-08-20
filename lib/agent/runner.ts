import Anthropic from "@anthropic-ai/sdk";
import { Agent, fetch as undiciFetch } from "undici";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { TOOLS, executeTool } from "./tools.ts";
import { SentenceChunker } from "./sentence-chunker.ts";
import {
  assertedHits,
  highestUrgency,
  scanForSafetySignals,
  type SafetyNetHit,
} from "../clinical/safety.ts";
import { PROTOCOL } from "../clinical/protocol.ts";
import {
  nextEscalationId,
  saveSession,
  snapshot,
  type CheckInSession,
} from "../store/session.ts";

/**
 * A dedicated HTTP/1.1 connection pool, not the process-global one.
 *
 * Node 26's built-in fetch negotiates HTTP/2 to api.anthropic.com. In a
 * long-lived server the pooled h2 session goes stale while idle, and every
 * subsequent request on it fails with ERR_HTTP2_INVALID_SESSION — including
 * the SDK's own retries, which reuse the same poisoned pool. Observed in
 * practice: a dev server idle for a few minutes failed every turn until it was
 * restarted. For a voice agent that is not a degraded experience, it is dead
 * air while a trial participant waits.
 *
 * Pinning our own agent with allowH2 off and a bounded idle keepalive avoids
 * the h2 path entirely and keeps the pool from holding connections long enough
 * to rot. Scoped to this client, so nothing else in the app is affected.
 */
const httpAgent = new Agent({
  allowH2: false,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connections: 16,
});

/**
 * A dropped turn mid-call is not a recoverable UX — the subject hears silence
 * and starts repeating themselves. Retry harder than the SDK's default of 2.
 */
const client = new Anthropic({
  maxRetries: 4,
  fetch: ((input: string, init?: Record<string, unknown>) =>
    undiciFetch(input, { ...init, dispatcher: httpAgent })) as unknown as typeof fetch,
});

const MAX_STREAM_ATTEMPTS = 3;


/** Unwraps the underlying network cause the SDK hides behind "Connection error." */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = (err as { cause?: unknown }).cause;
  for (let depth = 0; cause instanceof Error && depth < 3; depth++) {
    const code = (cause as { code?: string }).code;
    parts.push(code ? `${cause.message} (${code})` : cause.message);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(" ← ");
}

const MODEL = "claude-opus-5";
const MAX_TOOL_ITERATIONS = 8;
/**
 * Voice turns are short by design. This is a ceiling against runaway output, not
 * a target — the system prompt is what keeps responses to a sentence or two.
 */
const MAX_TOKENS = 4096;

/**
 * Hard stop at anything that looks like the model starting a new speaker turn.
 *
 * Observed failure: the agent asked for a date of birth, then continued past its
 * own turn and wrote the subject's answer for them — "user\nMarch 4th, 1958" —
 * and passed that fabricated date to verify_subject. Prompt instructions alone
 * are a probabilistic guard against this; a stop sequence is not. In a system
 * whose entire job is capturing what the subject actually said, invented subject
 * speech is the most damaging output it can produce.
 */
const STOP_SEQUENCES = [
  "\nuser",
  "\nUser",
  "\nUSER",
  "\nsubject:",
  "\nSubject:",
  "\nassistant",
  "\nAssistant:",
  "\nHuman:",
  "\nPatient:",
];

/** Longest stop sequence, in characters — the most we ever need to hold back. */
const MAX_STOP_LEN = Math.max(...STOP_SEQUENCES.map((s) => s.length));

/**
 * How many trailing characters of `buffered` might be the opening of a stop
 * sequence.
 *
 * Stop sequences protect the transcript but not the loudspeaker. The API stops
 * generating once a sequence completes and excludes it from the final message —
 * but streaming emits deltas token by token, so the first characters of
 * "\nuser" are already on their way to the browser before the match is known.
 * Observed live: the agent asked its question, began fabricating a subject
 * reply, and the leaked fragment fused with the next word into "usual bit rough
 * honestly" — spoken aloud to the participant.
 *
 * Holding back any suffix that could still become a stop sequence closes that
 * gap. Nothing reaches the speaker until it is known not to be the start of text
 * that will be discarded.
 */
function pendingStopPrefixLength(buffered: string): number {
  // MAX_STOP_LEN, not MAX_STOP_LEN - 1. A complete sequence is a prefix of
  // itself and must be held, so the stop_reason check downstream can discard it.
  // Capping one short let the longest sequence ("\nAssistant:", 11 chars) through
  // to the synthesizer — the exact leak this function exists to prevent.
  const max = Math.min(MAX_STOP_LEN, buffered.length);
  for (let n = max; n > 0; n--) {
    const suffix = buffered.slice(buffered.length - n);
    if (STOP_SEQUENCES.some((stop) => stop.startsWith(suffix))) return n;
  }
  return 0;
}

const EFFORT = (process.env.VOICE_AGENT_EFFORT ?? "medium") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * Fast mode runs the same Opus 5 at up to 2.5x output tokens/sec for premium
 * pricing ($10/$50 per MTok vs $5/$25). For a voice agent that trade is usually
 * worth it — output speed is felt directly as dead air. Off by default so the
 * cost is an explicit choice.
 */
const FAST_MODE = process.env.VOICE_AGENT_FAST_MODE === "1";

/**
 * Transport-level failures worth another attempt, as opposed to a 400 from a
 * malformed request, which will fail identically every time.
 */
function isTransientConnectionError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  const text = describeError(err);
  return /ERR_HTTP2|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|fetch failed|other side closed/i.test(
    text,
  );
}

export type AgentEvent =
  | { type: "safety"; hits: SafetyNetHit[] }
  | { type: "delta"; text: string }
  | { type: "speak"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown; isError: boolean }
  | { type: "state"; snapshot: ReturnType<typeof snapshot> }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  | { type: "done"; terminal: boolean }
  | { type: "error"; message: string };

function safetyNetSystemMessage(hits: SafetyNetHit[]): string {
  const lines = hits.map(
    (h) =>
      `- [${h.urgency.toUpperCase()}] ${h.category} (matched: "${h.matchedPhrase}"). ${h.instruction}`,
  );
  return (
    "TRIAL SAFETY SYSTEM — AUTOMATED ALERT.\n\n" +
    "The subject's last utterance matched one or more deterministic safety rules. " +
    "These rules run outside the model and are not subject to your judgment. Act on " +
    "every instruction below before doing anything else, and do not mention this " +
    "alert to the subject.\n\n" +
    lines.join("\n")
  );
}

/**
 * Marks a solicited symptom reviewed when the agent actually asks about it.
 *
 * Previously the only writer was record_adverse_event, so a symptom the subject
 * denied never showed as reviewed and the console's checklist stayed unlit on a
 * clean check-in. A coordinator could not tell "asked, negative" from "never
 * asked" — the same partial-versus-complete distinction the safety screen goes
 * out of its way to preserve.
 *
 * The protocol prompts are verbatim-pinned, so matching the spoken text against
 * them is deterministic and needs nothing from the model.
 */
function markSolicitedAsked(session: CheckInSession, spoken: string) {
  if (!spoken) return;
  const haystack = spoken.toLowerCase();
  for (const item of PROTOCOL.solicitedSymptoms) {
    if (session.solicitedReviewed.includes(item.term)) continue;
    if (haystack.includes(item.prompt.toLowerCase())) {
      session.solicitedReviewed.push(item.term);
    }
  }
}

/**
 * Runs one conversational turn: safety scan, then the model/tool loop, streaming
 * events as they happen.
 */
export async function* runTurn(
  session: CheckInSession,
  input: { utterance: string; source: "subject" | "system" },
): AsyncGenerator<AgentEvent> {
  const { utterance, source } = input;

  // ---- 1. Deterministic safety net, before the model sees anything ----------
  // Only subject speech is scanned. The synthetic call-start turn is ours.
  const allHits = source === "subject" ? scanForSafetySignals(utterance) : [];
  const hits = assertedHits(allHits);
  const suppressed = allHits.filter((h) => h.suppressed);

  session.audit.record({
    actor: source === "subject" ? "subject" : "system",
    action: source === "subject" ? "UTTERANCE_RECEIVED" : "CALL_CONNECTED",
    entity: "Transcript",
    entityId: null,
    after:
      source === "subject"
        ? {
            text: utterance,
            safetyHits: hits.map((h) => h.category),
            // Recorded, not hidden: a reviewer can see the net matched and why
            // context stood it down.
            safetySuppressed: suppressed.map((h) => ({
              category: h.category,
              matched: h.matchedPhrase,
              reason: h.suppressionReason,
            })),
          }
        : { note: "Voice channel opened; agent prompted to greet." },
    reason:
      source === "subject"
        ? "Subject speech transcribed and submitted to the check-in agent."
        : "Call connected. Agent turn initiated without subject input.",
  });

  session.messages.push({ role: "user", content: utterance });

  // Ground truth for the provenance check. Only genuine subject speech — the
  // synthetic call-start turn is ours and must never be quotable.
  if (source === "subject") session.subjectUtterances.push(utterance);

  if (hits.length > 0) {
    const urgency = highestUrgency(hits)!;
    const record = {
      id: nextEscalationId(session),
      urgency,
      reason:
        `Deterministic safety rule fired on subject speech: ` +
        hits.map((h) => h.category).join("; "),
      relatedEventIds: [],
      triggeredBy: "safety_net" as const,
      category: hits[0].category,
      createdAt: new Date().toISOString(),
      sponsorNotificationDeadline:
        urgency === "routine"
          ? null
          : new Date(
              Date.now() + PROTOCOL.saeReportingWindowHours * 3600 * 1000,
            ).toISOString(),
    };
    session.escalations.push(record);
    session.status = "escalated";
    session.audit.record({
      actor: "safety_net",
      action: "ESCALATED",
      entity: "Escalation",
      entityId: record.id,
      after: record,
      reason:
        "Rule-based escalation independent of model judgment. Matched phrases: " +
        hits.map((h) => `"${h.matchedPhrase}"`).join(", "),
    });

    // Persist before the model runs. A rule-based escalation is the one record
    // that must survive a crash on the very next line.
    await saveSession(session);

    yield { type: "safety", hits };
    yield { type: "state", snapshot: snapshot(session) };

    // Operator channel. The subject cannot forge this and it survives caching.
    session.messages.push({
      role: "system",
      content: safetyNetSystemMessage(hits),
    });
  }

  // ---- 2. Model + tool loop -------------------------------------------------
  let terminal = false;

  /**
   * Whether any earlier iteration of this turn already produced speech.
   *
   * With "acknowledge before you work", a single turn commonly emits text, runs
   * tools, then emits more text — two model passes whose deltas are concatenated
   * by whatever is consuming the stream. Without a separator they join flush
   * against each other: "I'm writing that down.I've let your coordinator know."
   * That is wrong in the transcript and worse in speech, because the sentence
   * splitter needs whitespace after a full stop to see a boundary at all, so the
   * two sentences get read aloud as one run-on.
   */
  let emittedTextThisTurn = false;
  let spokenThisTurn = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const chunker = new SentenceChunker();
    let firstDeltaOfIteration = true;

    const params = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text" as const,
          text: SYSTEM_PROMPT,
          // Everything before this point is byte-stable across every turn of
          // every session, so it is a clean cache prefix.
          cache_control: { type: "ephemeral" as const },
        },
      ],
      tools: TOOLS,
      messages: session.messages,
      stop_sequences: STOP_SEQUENCES,
      thinking: { type: "adaptive" as const },
      output_config: { effort: EFFORT },
      ...(FAST_MODE
        ? { speed: "fast" as const, betas: ["fast-mode-2026-02-01"] }
        : {}),
    };

    // Stale pooled connections in a long-lived server surface as
    // ERR_HTTP2_INVALID_SESSION, and the SDK's own retries reuse the same dead
    // session so every attempt fails together. Retrying at this level gets a
    // fresh connection. Only safe before the first token has been spoken —
    // after that a retry would make the agent repeat itself mid-sentence.
    let message: Anthropic.Beta.BetaMessage | null = null;
    let spokeThisTurn = false;

    for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt++) {
      let held = "";

      try {
        const stream = client.beta.messages.stream(params);

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            held += event.delta.text;
            const holdBack = pendingStopPrefixLength(held);
            let text = held.slice(0, held.length - holdBack);
            held = held.slice(held.length - holdBack);
            if (!text) continue;

            if (firstDeltaOfIteration && emittedTextThisTurn && !/^\s/.test(text)) {
              text = ` ${text}`;
            }
            firstDeltaOfIteration = false;
            spokeThisTurn = true;
            emittedTextThisTurn = true;
            spokenThisTurn += text;
            yield { type: "delta", text };
            for (const sentence of chunker.push(text)) {
              yield { type: "speak", text: sentence };
            }
          }
        }

        message = await stream.finalMessage();

        // Anything still held is only safe to release if generation ended for a
        // reason other than a stop sequence. If a sequence fired, the held text
        // is its opening and must never be spoken.
        if (held && message.stop_reason !== "stop_sequence") {
          const text =
            firstDeltaOfIteration && emittedTextThisTurn && !/^\s/.test(held)
              ? ` ${held}`
              : held;
          spokeThisTurn = true;
          emittedTextThisTurn = true;
          spokenThisTurn += text;
          yield { type: "delta", text };
          for (const sentence of chunker.push(text)) {
            yield { type: "speak", text: sentence };
          }
        }
        held = "";
        break;
      } catch (err) {
        const retryable =
          !spokeThisTurn &&
          attempt < MAX_STREAM_ATTEMPTS &&
          isTransientConnectionError(err);

        if (retryable) {
          await new Promise((r) => setTimeout(r, 200 * attempt));
          continue;
        }

        const detail = describeError(err);
        session.audit.record({
          actor: "system",
          action: "TURN_FAILED",
          entity: "CheckInSession",
          entityId: session.id,
          after: { error: detail, iteration, attempt },
          reason:
            "Model request failed. The turn produced no record; a coordinator " +
            "should confirm nothing was lost.",
        });
        await saveSession(session);
        yield { type: "error", message: detail };
        return;
      }
    }

    if (!message) {
      yield { type: "error", message: "No response from the model after retries." };
      return;
    }

    const trailing = chunker.flush();
    if (trailing) yield { type: "speak", text: trailing };

    yield {
      type: "usage",
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    };

    if (message.stop_reason === "refusal") {
      yield {
        type: "error",
        message:
          "The model declined to respond to that turn. Escalating to a human coordinator.",
      };
      return;
    }

    // Echo the assistant turn back verbatim — thinking blocks included, since
    // they must be replayed unchanged on the same model.
    session.messages.push({ role: "assistant", content: message.content });

    const toolUses = message.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock =>
        block.type === "tool_use",
    );

    if (toolUses.length === 0) break;

    const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];

    for (const call of toolUses) {
      yield { type: "tool_call", id: call.id, name: call.name, input: call.input };

      const outcome = executeTool(session, call.name, call.input);
      if (outcome.terminal) terminal = true;

      yield {
        type: "tool_result",
        id: call.id,
        name: call.name,
        result: outcome.result,
        isError: Boolean(outcome.isError),
      };

      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(outcome.result),
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }

    // All results for a parallel batch go back in a single user message.
    session.messages.push({ role: "user", content: toolResults });
    await saveSession(session);
    yield { type: "state", snapshot: snapshot(session) };
  }

  markSolicitedAsked(session, spokenThisTurn);
  await saveSession(session);
  yield { type: "state", snapshot: snapshot(session) };
  yield { type: "done", terminal };
}
