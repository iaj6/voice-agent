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
  return run(request);
}

/** Vercel Cron calls GET. */
export async function GET(request: Request) {
  return run(request);
}

async function run(request: Request) {
  if (!configured()) {
    return Response.json(
      { error: "No cron secret is set; this endpoint sends mail." },
      { status: 503 },
    );
  }
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json(
    { digest: await sendDigest() },
    { headers: { "Cache-Control": "no-store" } },
  );
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

