import { getSession } from "@/lib/store/session";
import { getLatencyStore, plausible } from "@/lib/store/latency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How long after a call completes its own turns may still report timings.
 *
 * Long enough for the goodbye to be spoken and heard, short enough that a
 * completed session is not an open write channel.
 */
const TELEMETRY_GRACE_MS = 2 * 60 * 1000;

/**
 * Receives the one latency number the server cannot observe.
 *
 * The server knows when it dispatched a sentence. Only the browser knows when
 * the participant heard one, and the gap between those is synthesis, transfer
 * and decode — most of what a person on a phone experiences as the agent being
 * slow. N-01 is a claim about that gap, so it has to be reported from where it
 * happens.
 *
 * Bound to a live session on purpose. This writes to the database from an
 * unauthenticated request, and requiring a session that exists and is still open
 * means a caller has to be in a check-in to add rows to it — which is the
 * posture 4.10 asks for on the relay and is cheap to have here from the start.
 */
export async function POST(request: Request) {
  let body: {
    sessionId?: string;
    turnIndex?: number;
    firstAudioMs?: number;
    source?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, turnIndex, firstAudioMs, source } = body;
  if (!sessionId || typeof turnIndex !== "number" || !Number.isInteger(turnIndex)) {
    return Response.json({ error: "Missing sessionId or turnIndex" }, { status: 400 });
  }

  const measured = plausible(firstAudioMs);
  if (measured === null) {
    // A clock adjustment mid-call produces a negative or absurd figure, and one
    // of those moves a percentile silently. Refusing is honest; storing it is not.
    return Response.json({ error: "Implausible measurement" }, { status: 400 });
  }

  const session = await getSession(sessionId);
  if (!session) {
    return Response.json({ error: "Unknown session" }, { status: 404 });
  }
  // A grace period, not a hard lock. complete_check_in sets completedAt and then
  // tells the agent to say goodbye, so the closing turn is spoken *after* the
  // session is locked — and every call's last turn, plus every call an emergency
  // ended early, was rejected here and then reported by latency.mjs as a turn
  // that "produced no audio at all". Both untrue, and both in the flattering
  // direction, which is the same shape as the onStart and speakLocally bugs.
  //
  // Still bounded: this writes to the table N-01 is computed from, and a
  // long-completed session must not be able to add rows to it forever.
  const completedFor = session.completedAt
    ? Date.now() - Date.parse(session.completedAt)
    : 0;
  if (completedFor > TELEMETRY_GRACE_MS) {
    return Response.json({ error: "This check-in is complete and locked." }, { status: 409 });
  }

  try {
    await getLatencyStore().record({
      sessionId,
      turnIndex,
      // Sent rather than defaulted. Either writer can create the row, so a
      // placeholder here would stick when the browser got there first — and the
      // call-start turn is a system turn that has to stay separable, because it
      // includes answering the phone and averaging it in flatters the figure.
      source: source === "system" ? "system" : "subject",
      firstAudioMs: measured,
    });
  } catch {
    return Response.json({ error: "Could not record" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
