import { getSession, looksLikeSessionId } from "@/lib/store/session";
import { getLatencyStore } from "@/lib/store/latency";
import { getDeliveryStore } from "@/lib/store/deliveries";
import { reasonsFor } from "@/lib/review/queue";
import { summariseSession } from "@/lib/store/summaries";
import { reviewAuthorised, reviewRefusal } from "@/lib/review/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One call, as a reviewer needs to see it: what was said, what was recorded, and
 * whether those two agree.
 *
 * This is the endpoint that unseals. Everything else in the observability layer
 * reads structured fields and never fetches a key; reviewing a call means
 * reading a participant's own words, because a record you cannot compare against
 * the conversation is a record you cannot review.
 *
 * Shredded sessions return markers rather than failing. A subject who withdrew
 * and had their key destroyed still has a call in the queue — the structured
 * facts survive by design — and a reviewer opening it should see that the words
 * are gone, not a 500.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!reviewAuthorised(request)) return reviewRefusal();

  const { id } = await params;
  // Checked before the lookup: `check_in_session.id` is a uuid column, so a
  // truncated or mistyped deep link threw "invalid input syntax for type uuid"
  // out of the driver as an unhandled 500 rather than reaching the 404 below.
  if (!looksLikeSessionId(id)) {
    return Response.json({ error: "Unknown call" }, { status: 404 });
  }
  const session = await getSession(id);
  if (!session) {
    return Response.json({ error: "Unknown call" }, { status: 404 });
  }

  // Summarised from this session directly. Scanning the 2,000 most recent calls
  // and filtering in JS meant an older call opened with no reasons at all —
  // indistinguishable from a clean one — while loading every row's whole record
  // JSONB to find one id.
  const summary = summariseSession(session);

  const [turns, deliveries] = await Promise.all([
    getLatencyStore().forSession(id),
    getDeliveryStore().forSession(id),
  ]);

  return Response.json({
    call: {
      id: session.id,
      createdAt: session.createdAt,
      completedAt: session.completedAt ?? null,
      status: session.status,
      synthetic: session.synthetic,
      // The real signal. Sealed arrays come back as `[]` rather than a marker,
      // so a shredded transcript is indistinguishable from an absent one by
      // looking at the words — which made the reviewer's banner unreachable and
      // labelled an erased call as one that never got past verification.
      shredded: session.shredded,
      subject: session.subject,
      verificationAttempts: session.verificationAttempts,
      respondent: session.respondent,
      provenanceRejections: session.provenanceRejections,
      summary: session.summary ?? null,
    },
    reasons: summary ? reasonsFor(summary) : [],
    // The conversation, in order, as the ground truth the record is checked
    // against. `subjectUtterances` is kept apart from `messages` precisely so a
    // reviewer can see what the participant actually said without tool results
    // and the synthetic call-start turn mixed in.
    saidByParticipant: session.subjectUtterances,
    record: {
      adverseEvents: session.adverseEvents,
      safetyScreen: session.safetyScreen,
      adherence: session.adherence,
      conMeds: session.conMeds,
      escalations: session.escalations,
    },
    audit: session.audit.all(),
    // Whether the record's own trail still hashes. A reviewer signing off on a
    // record whose audit chain is broken is signing off on nothing.
    auditChain: session.audit.verifyChain(),
    deliveries: deliveries.map((d) => ({
      urgency: d.urgency,
      tier: d.tier,
      status: d.status,
      attempt: d.attempt,
      acknowledgedAt: d.acknowledgedAt,
    })),
    latency: turns,
  });
}
