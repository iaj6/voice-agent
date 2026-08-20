import { getSession } from "@/lib/store/session";
import { runTurn } from "@/lib/agent/runner";

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        for await (const event of runTurn(session, {
          utterance: utterance.trim(),
          source: source === "system" ? "system" : "subject",
        })) {
          send(event);
        }
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
