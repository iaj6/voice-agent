import { sweepEscalations } from "../../../../lib/escalation/sweep.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs one pass of the escalation ladder.
 *
 * POST, and shared-secret authenticated, because it sends mail — an unprotected
 * endpoint that pages coordinators is a way to page coordinators. Meant to be
 * driven by a scheduler (Vercel Cron, systemd timer, anything) roughly as often
 * as the tightest SLA: at a fifteen-minute emergency window, sweeping every minute
 * means an unacknowledged emergency reaches the backup within sixteen.
 *
 * Idempotent by construction. Every rung checks what has already been sent
 * before sending, so running it twice in the same second does nothing twice.
 */
export async function POST(request: Request) {
  return run(request);
}

/** Vercel Cron calls GET. Same work, same authentication. */
export async function GET(request: Request) {
  return run(request);
}

async function run(request: Request) {
  if (!configured()) {
    return Response.json(
      {
        error:
          "Neither CRON_SECRET nor ESCALATION_SWEEP_SECRET is set. This endpoint " +
          "sends mail and will not run unauthenticated.",
      },
      { status: 503 },
    );
  }
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sweepEscalations();
  return Response.json({ swept: result }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Vercel Cron invokes with a **GET** and sends `Authorization: Bearer
 * $CRON_SECRET`. Exporting only POST, and checking only our own secret, meant
 * every scheduled run got a 405 — so the ladder still advanced only when
 * somebody POSTed by hand, while the docs claimed scheduling was solved. Both
 * verbs, and either secret.
 */
function authorised(request: Request): boolean {
  const offered = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!offered) return false;
  const accepted = [process.env.CRON_SECRET, process.env.ESCALATION_SWEEP_SECRET].filter(
    (s): s is string => Boolean(s),
  );
  return accepted.includes(offered);
}

function configured(): boolean {
  return Boolean(process.env.CRON_SECRET || process.env.ESCALATION_SWEEP_SECRET);
}

