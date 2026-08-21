import { sweepEscalations } from "../../../../lib/escalation/sweep.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs one pass of the escalation ladder.
 *
 * POST, and shared-secret authenticated, because it sends mail — an unprotected
 * endpoint that pages coordinators is a way to page coordinators. Meant to be
 * driven by a scheduler (Vercel Cron, systemd timer, anything) roughly as often
 * as the tightest SLA: at a five-minute emergency window, sweeping every minute
 * means an unacknowledged emergency reaches the backup within six.
 *
 * Idempotent by construction. Every rung checks what has already been sent
 * before sending, so running it twice in the same second does nothing twice.
 */
export async function POST(request: Request) {
  const secret = process.env.ESCALATION_SWEEP_SECRET;
  if (!secret) {
    return Response.json(
      {
        error:
          "ESCALATION_SWEEP_SECRET is not set. This endpoint sends mail and will " +
          "not run unauthenticated.",
      },
      { status: 503 },
    );
  }
  const offered = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (offered !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sweepEscalations();
  return Response.json({ swept: result }, { headers: { "Cache-Control": "no-store" } });
}
