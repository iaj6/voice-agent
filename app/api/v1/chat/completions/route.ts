import { runTurn } from "@/lib/agent/runner";
import {
  createSession,
  getSession,
  snapshot,
  type CheckInSession,
} from "@/lib/store/session";
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * OpenAI-compatible chat-completions shim for the ElevenLabs Agents Platform.
 *
 * SPIKE. The question this exists to answer: if ElevenLabs handles audio capture,
 * turn detection, transcription, speech, and telephony, does our architecture
 * survive — or does it dissolve the way a speech-to-speech model would?
 *
 * The answer is that it survives, and the reason is the direction of the call.
 * ElevenLabs POSTs the transcript to us and waits for text back. That means the
 * deterministic safety net still runs on the subject's words before Claude sees
 * them, the tool loop still writes the eCRF, and the audit trail still records
 * every turn. We give up the audio path and keep the entire regulated core.
 *
 * What we give up in exchange is that ElevenLabs owns turn detection, so the
 * transcript we receive is already segmented by their VAD rather than ours.
 *
 * Path matters: OpenAI-compatible clients append "/chat/completions" to the base
 * URL they are given, so this must live at {base}/chat/completions. Configure the
 * agent's Server URL as https://<host>/api/v1 — not the full path.
 */

const LOG_DIR = path.join(process.cwd(), ".spike-logs");

/** Records exactly what ElevenLabs sends, so the contract is observed not assumed. */
async function logPayload(label: string, body: unknown) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(
      path.join(LOG_DIR, "elevenlabs-requests.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), label, body }) + "\n",
    );
  } catch {
    // Logging must never break the call.
  }
}

interface OpenAIMessage {
  role: string;
  content: string | null;
}

interface ChatCompletionRequest {
  messages?: OpenAIMessage[];
  model?: string;
  stream?: boolean;
  user_id?: string;
  user?: string;
  tools?: unknown[];
  elevenlabs_extra_body?: Record<string, unknown>;
}

/**
 * Maps an ElevenLabs conversation onto one of our check-in sessions.
 *
 * ElevenLabs resends the whole history each turn and does not guarantee us a
 * conversation id, so we derive a stable key from the opening of the transcript.
 * Good enough to prove the architecture; a real integration would carry the
 * conversation id through elevenlabs_extra_body rather than inferring identity.
 */
const conversationSessions = new Map<string, string>();

function conversationKey(body: ChatCompletionRequest): string | null {
  const explicit =
    body.user_id ??
    body.user ??
    (body.elevenlabs_extra_body?.conversation_id as string | undefined);
  if (explicit) return `explicit:${explicit}`;

  // Derived from the subject's FIRST utterance only.
  //
  // The previous key hashed system + first user message. On the opening turn
  // there is no user message, so it hashed an empty string; on the next turn it
  // hashed the subject's actual reply. The key changed, the lookup missed, and a
  // second session was created mid-call — the subject was silently re-verified
  // and everything captured in turn one was stranded in an abandoned session.
  //
  // Returning null on the opening turn is deliberate: there is nothing stable to
  // key on yet, so the session is adopted on the next turn instead of registered
  // under a key that is about to change.
  const firstUser = body.messages?.find((m) => m.role === "user")?.content ?? "";
  if (!firstUser.trim()) return null;
  return (
    "derived:" + createHash("sha256").update(firstUser).digest("hex").slice(0, 24)
  );
}

/**
 * The session created on an opening turn, waiting to be adopted once the subject
 * speaks and a stable key exists. One slot, because a single shim instance is
 * only ever mid-opening for one conversation at a time; a real deployment
 * carries a conversation id and never needs this.
 */
let pendingOpeningSessionId: string | null = null;

/** Bounded so a long-lived process cannot accumulate keys without limit. */
const MAX_TRACKED_CONVERSATIONS = 500;

function rememberConversation(key: string, sessionId: string) {
  if (conversationSessions.size >= MAX_TRACKED_CONVERSATIONS) {
    const oldest = conversationSessions.keys().next().value;
    if (oldest !== undefined) conversationSessions.delete(oldest);
  }
  conversationSessions.set(key, sessionId);
}

async function resolveSession(
  body: ChatCompletionRequest,
): Promise<CheckInSession> {
  const key = conversationKey(body);

  // Opening turn: no stable key yet. Create and park it.
  if (key === null) {
    const created = await createSession();
    pendingOpeningSessionId = created.id;
    return created;
  }

  const existingId = conversationSessions.get(key);
  if (existingId) {
    const existing = await getSession(existingId);
    if (existing) return existing;
  }

  // First real utterance: adopt the session opened a moment ago rather than
  // starting a second one and stranding the greeting.
  if (pendingOpeningSessionId) {
    const adopted = await getSession(pendingOpeningSessionId);
    pendingOpeningSessionId = null;
    if (adopted) {
      rememberConversation(key, adopted.id);
      return adopted;
    }
  }

  const created = await createSession();
  rememberConversation(key, created.id);
  return created;
}

function sseChunk(id: string, model: string, delta: Record<string, unknown>) {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    }) +
    "\n\n"
  );
}

function sseFinish(id: string, model: string) {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    "\n\ndata: [DONE]\n\n"
  );
}

export async function POST(request: Request) {
  let body: ChatCompletionRequest;
  try {
    body = (await request.json()) as ChatCompletionRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  await logPayload("chat.completions", body);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const utterance = (lastUser?.content ?? "").trim();

  const session = await resolveSession(body);
  const model = body.model ?? "onx-301-check-in";
  const completionId = `chatcmpl-${session.id.slice(0, 8)}-${Date.now()}`;

  // An empty opening turn is ElevenLabs asking us to speak first.
  const isOpening = !utterance;
  const turnInput = isOpening
    ? "(The call has connected. The subject has not spoken yet.)"
    : utterance;
  const source: "subject" | "system" = isOpening ? "system" : "subject";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      let spoke = false;

      try {
        for await (const event of runTurn(session, {
          utterance: turnInput,
          source,
        })) {
          if (event.type === "delta") {
            spoke = true;
            send(sseChunk(completionId, model, { content: event.text }));
          } else if (event.type === "safety") {
            // Visible in our own logs; never surfaced to the subject.
            await logPayload("safety_net_fired", {
              sessionId: session.id,
              hits: event.hits,
            });
          } else if (event.type === "error") {
            if (!spoke) {
              send(
                sseChunk(completionId, model, {
                  content:
                    "I'm sorry, I'm having trouble with the connection. Let me have your study coordinator call you.",
                }),
              );
              spoke = true;
            }
          }
        }
      } catch (err) {
        await logPayload("turn_exception", { error: String(err) });
        if (!spoke) {
          send(
            sseChunk(completionId, model, {
              content:
                "I'm sorry, something has gone wrong on my end. Your study coordinator will call you.",
            }),
          );
        }
      } finally {
        await logPayload("turn_result", {
          sessionId: session.id,
          status: session.status,
          adverseEvents: session.adverseEvents.length,
          escalations: session.escalations.map((e) => ({
            id: e.id,
            urgency: e.urgency,
            by: e.triggeredBy,
          })),
          auditEntries: snapshot(session).audit.length,
          auditChainValid: snapshot(session).auditChainValid,
        });
        send(sseFinish(completionId, model));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
