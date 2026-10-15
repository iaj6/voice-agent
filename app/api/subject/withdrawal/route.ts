import { reviewAuthorised, reviewRefusal } from "../../../../lib/review/auth.ts";
import { getSubjectStore } from "../../../../lib/store/subjects.ts";
import { SUBJECTS } from "../../../../lib/clinical/protocol.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Records that a participant has withdrawn, so no further check-in collects
 * anything from them.
 *
 * A coordinator action, not a subject-facing one. The agent detects a withdrawal
 * statement and escalates it; a human decides what it meant and records it here.
 * That split is deliberate — "I don't think I can keep doing this" is a sentence
 * a tired person says on a hard week, and an automated system acting on it alone
 * would remove someone from a trial on the strength of a phrase match.
 *
 * Withdrawal stops future collection. It does not delete what was lawfully
 * collected before it, which is the ICH E6 and EDPB Opinion 3/2019 position;
 * destruction is a separate, separately authorised act. See docs/RETENTION.md D6.
 *
 * Gated by the same coordinator credential as the review screens. That proves a
 * coordinator made the call, not which one; `by` is still self-asserted, and a
 * real deployment needs per-user identity because who recorded a withdrawal is
 * part of what makes it evidence.
 */
export async function POST(request: Request) {
  if (!reviewAuthorised(request)) return reviewRefusal();

  let body: { subject_id?: unknown; by?: unknown; note?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Request body is not valid JSON" }, { status: 400 });
  }

  const subjectId = String(body.subject_id ?? "").trim();
  const by = String(body.by ?? "").trim();
  const note = String(body.note ?? "").trim();

  if (!subjectId || !by) {
    return Response.json(
      { error: "subject_id and by are both required. A withdrawal has to be attributable." },
      { status: 400 },
    );
  }

  // Checked against the roster so a typo cannot create a withdrawal for a subject
  // who does not exist — which would silently fail to protect the real one.
  if (!SUBJECTS.some((s) => s.subjectId === subjectId)) {
    return Response.json(
      { error: `No subject ${subjectId} on this protocol's roster.` },
      { status: 404 },
    );
  }

  const state = await getSubjectStore().withdraw(subjectId, by, note);
  return Response.json({ withdrawn: state });
}

/**
 * Whether a participant has withdrawn, and the coordinator's note about why.
 *
 * Gated, and this one mattered more than the session route: subject ids are
 * sequential (001-0042), so the whole roster's withdrawal status and the
 * free-text reason a coordinator typed were enumerable by anyone who could reach
 * the host. "Withdrew after her husband died" is a sentence that belongs to one
 * person.
 */
export async function GET(request: Request) {
  if (!reviewAuthorised(request)) return reviewRefusal();

  const subjectId = new URL(request.url).searchParams.get("subject_id");
  if (!subjectId) {
    return Response.json({ error: "Missing subject_id" }, { status: 400 });
  }
  return Response.json({
    subject_id: subjectId,
    state: await getSubjectStore().get(subjectId),
  });
}
