/**
 * Putting a human's acknowledgement onto the record's own trail.
 *
 * Acknowledging an escalation is the only action in this system that a person
 * takes. It was written to `escalation_delivery` and nowhere else — so the
 * hash-chained audit trail, which is the record's evidence of everything that
 * happened to it, had no entry for the single human decision in the call.
 *
 * 21 CFR 11.10(e) asks for a computer-generated, time-stamped audit trail
 * recording operator actions. This was the one operator action there was, and it
 * was the one thing missing from it.
 *
 * The coordinator's typed name goes in the sealed `after` value, not in
 * `reason`: `reason` is stored in the clear in a table that rejects UPDATE and
 * DELETE, and a named person is personal data even when the person is staff.
 */

import { getSession } from "../store/session.ts";
import { getSessionStore } from "../store/session-store.ts";
import type { DeliveryRecord } from "../store/deliveries.ts";

export async function noteAcknowledgement(
  record: DeliveryRecord,
  by: string,
): Promise<{ recorded: boolean; detail: string | null }> {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    // Inside the guard, not outside it. The acknowledgement has already been
    // committed by the time this runs, so a read failure escaping as a 500 tells
    // the coordinator their action failed when it succeeded — and they resubmit.
    session = await getSession(record.sessionId);
  } catch {
    return { recorded: false, detail: "the call record could not be read" };
  }
  if (!session) {
    return { recorded: false, detail: "the call this escalation belongs to is gone" };
  }

  session.audit.record({
    actor: "coordinator",
    action: "ESCALATION_ACKNOWLEDGED",
    entity: "Escalation",
    entityId: record.escalationId,
    after: {
      acknowledgedBy: by,
      acknowledgedAt: record.acknowledgedAt,
      tier: record.tier,
      attempt: record.attempt,
      urgency: record.urgency,
      deadlineAt: record.deadlineAt,
      late:
        record.acknowledgedAt !== null &&
        Date.parse(record.acknowledgedAt) > Date.parse(record.deadlineAt),
    },
    reason:
      "A named person accepted responsibility for this escalation. Who they are " +
      "is in the sealed value, not here.",
  });

  try {
    await getSessionStore().appendAudit(session);
    return { recorded: true, detail: null };
  } catch (err) {
    // The acknowledgement itself stands — it is already in escalation_delivery,
    // and refusing it because the trail write failed would page a backup for an
    // escalation a human has actually taken. But a trail with a hole in it is
    // the thing this file exists to prevent, so it is reported rather than
    // swallowed, and the caller says so on the page.
    // Deliberately not the driver's message. This is rendered on a page anyone
    // holding the acknowledgement token can reach, and a raw database error is
    // schema detail on a public surface.
    console.error("[ack] audit trail write failed", err);
    return { recorded: false, detail: "the audit trail write did not complete" };
  }
}
