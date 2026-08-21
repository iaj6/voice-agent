import { sendDigest } from "../../../../lib/escalation/digest.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sends the standing summary of unacknowledged escalations.
 *
 * Same shared secret as the sweep, and for the same reason: it sends mail.
 * Intended to run once a day, in the morning, so the first thing a coordinator
 * sees is anything that went unanswered overnight.
 */
export async function POST(request: Request) {
  const secret = process.env.ESCALATION_SWEEP_SECRET;
  if (!secret) {
    return Response.json(
      { error: "ESCALATION_SWEEP_SECRET is not set; this endpoint sends mail." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization")?.replace(/^Bearer /, "") !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json(
    { digest: await sendDigest() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
