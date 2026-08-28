import { getSession, looksLikeSessionId } from "@/lib/store/session";
import { runTurn } from "@/lib/agent/runner";
import { getLatencyStore } from "@/lib/store/latency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Voice turns are short, but tool loops plus thinking can run long. */
export const maxDuration = 300;

interface ChatRequest {
  sessionId?: string;
  utterance?: string;
  source?: "subject" | "system";
}

export async function POST(request: Request) {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, utterance, source = "subject" } = body;
  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }
  // Same guard as the other id-taking routes: a malformed id throws the uuid
  // cast out of the driver as an unhandled 500 before reaching the 404 below.
  if (!looksLikeSessionId(sessionId)) {
    return Response.json({ error: "Unknown session. Start a new call." }, { status: 404 });
  }
  if (typeof utterance !== "string" || utterance.trim().length === 0) {
    return Response.json({ error: "Missing utterance" }, { status: 400 });
  }

  const session = await getSession(sessionId);
  if (!session) {
    return Response.json(
      { error: "Unknown session. Start a new call." },
      { status: 404 },
    );
  }
  if (session.completedAt) {
    return Response.json(
      { error: "This check-in is complete and locked." },
      { status: 409 },
    );
  }

  // Counted before the turn runs, so the browser can name the same turn without
  // the two having to agree on anything else.
  const turnIndex = session.messages.length;
  const startedAt = Date.now();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      // Where the wait went, so a bad p95 can be attributed rather than noticed.
      let firstTokenMs: number | null = null;
      let firstSentenceMs: number | null = null;
      let spokeBeforeTools: boolean | null = null;

      try {
        // Named so the browser can attach what it heard to this turn.
        send({ type: "turn", index: turnIndex });

        for await (const event of runTurn(session, {
          utterance: utterance.trim(),
          source: source === "system" ? "system" : "subject",
        })) {
          const at = Date.now() - startedAt;
          if (event.type === "delta" && firstTokenMs === null) firstTokenMs = at;
          if (event.type === "speak" && firstSentenceMs === null) {
            firstSentenceMs = at;
            // Speaking first is the rule that exists because this went wrong: a
            // turn that called tools before saying anything left the participant
            // in silence with no way to tell the call from a dropped one.
            if (spokeBeforeTools === null) spokeBeforeTools = true;
          }
          if (event.type === "tool_call" && spokeBeforeTools === null) {
            spokeBeforeTools = false;
          }
          send(event);
        }
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Off the critical path, but not abandoned.
        //
        // Awaiting it put a database round trip between the last event and
        // [DONE], so every turn paid for it before the client could listen
        // again — observability on the critical path of the thing it measures.
        // A bare `void` was the first fix and traded that for a worse one: once
        // the response completes the function can be frozen or torn down, and
        // the rows most likely to still be in flight are the slow turns, so
        // N-01 would have lost exactly the measurements that matter, silently
        // and in the flattering direction.
        //
        // So: sent after [DONE] and the close, and awaited. The client already
        // has everything it needs and is not waiting on this, while the handler
        // is still executing — which is a weaker guarantee than waitUntil and
        // needs no dependency. Recorded as 4.11.
        const write = getLatencyStore()
          .record({
            sessionId: session.id,
            turnIndex,
            source: source === "system" ? "system" : "subject",
            firstTokenMs,
            firstSentenceMs,
            totalMs: Date.now() - startedAt,
            spokeBeforeTools,
          })
          .catch(() => {
            /* observability is not worth a dropped turn */
          });

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        await write;
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
