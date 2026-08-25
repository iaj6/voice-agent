import { listSummaries } from "@/lib/store/summaries";
import { buildQueue } from "@/lib/review/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The coordinator's queue: which calls want attention, worst first.
 *
 * Built from summaries, which read only the structured half of a record — so
 * listing the queue never unseals anything anybody said. Opening one call does,
 * and that is the point at which reading becomes a deliberate act rather than a
 * side effect of loading a page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") ?? "30");
  const includeUnflagged = url.searchParams.get("all") === "1";
  const includeSynthetic = url.searchParams.get("synthetic") === "1";

  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 365) * 86_400_000);
  const calls = await listSummaries({ since, limit: 2000, includeSynthetic });
  const queue = buildQueue(calls, { includeUnflagged });

  return Response.json({
    queue: queue.map((item) => ({
      id: item.call.id,
      createdAt: item.call.createdAt,
      completedAt: item.call.completedAt,
      status: item.call.status,
      verified: item.call.verified,
      synthetic: item.call.synthetic,
      events: item.call.events.length,
      escalations: item.call.escalations.length,
      screenAnswered: item.call.screenAnswered,
      reasons: item.reasons,
    })),
    // Reported so an empty queue is legible as "nothing needs attention" rather
    // than "the query is broken" — a distinction that matters when the answer is
    // always empty because the pilot has not started.
    scanned: calls.length,
    windowDays: days,
  });
}
