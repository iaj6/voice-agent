/**
 * The one way an escalation comes into existence.
 *
 * Raising and delivering used to be two steps, and delivery was a procedure each
 * producer had to remember. There were four producers and two of them forgot —
 * including the directed safety screen, which exists precisely because the regex
 * net catches 27% of signals, and which therefore paged nobody for the entire
 * life of the feature. The record said `escalated`, the audit trail said
 * `ESCALATED`, and the tool told the agent to tell a frightened person their
 * coordinator had been alerted.
 *
 * Nothing about that was detectable from inside: no row in `escalation_delivery`
 * means the retry ladder, the backup contact, the alarm and the digest are all
 * structurally blind, because every one of them is a query over that table.
 *
 * So delivery is no longer something a producer does. It is what raising an
 * escalation *is*. A new producer added next sprint gets it by construction, and
 * `scripts/reconcile-escalations.mjs` is the backstop for anyone who bypasses
 * this function anyway.
 */

import type { CheckInSession } from "../store/session.ts";
import type { EscalationRecord } from "../store/session.ts";
import { saveSession } from "../store/session.ts";
import { deliverEscalation, type DeliveryOutcome } from "./deliver.ts";

export interface RaiseOptions {
  /** Who the record should say raised it. */
  actor: "safety_net" | "agent";
  /** The audit entry's reason. */
  auditReason: string;
  /** True while a call is live, which shortens the delivery timeout. */
  onCall?: boolean;
}

/**
 * Records the escalation and pages somebody, in that order, before returning.
 *
 * The order matters: the record must exist even if the page fails, because an
 * escalation nobody could deliver is still an escalation a human has to see.
 * What must never happen is the reverse — a caller reporting a page that did not
 * occur, which is what every one of these sites did.
 */
export async function raiseEscalation(
  session: CheckInSession,
  escalation: EscalationRecord,
  options: RaiseOptions,
): Promise<DeliveryOutcome> {
  session.escalations.push(escalation);
  session.status = "escalated";
  session.audit.record({
    actor: options.actor,
    action: "ESCALATED",
    entity: "Escalation",
    entityId: escalation.id,
    after: escalation,
    reason: options.auditReason,
  });

  // Persisted before delivery, which is what the runner's safety-net producer
  // already does. deliverEscalation writes a row immediately, while the session
  // is only saved after the whole tool batch — so a crash in between left a
  // delivery whose escalation_id appears nowhere in the stored record. That is
  // the inverse of the invariant reconcile-escalations.mjs checks, and it cannot
  // see it: it looks for escalations with no attempts, not attempts with no
  // escalation.
  //
  // Best-effort. A save that fails must not stop the page going out — the record
  // is recoverable and a missed emergency is not.
  try {
    await saveSession(session);
  } catch {
    /* the page matters more than the ordering */
  }

  return deliverEscalation(session, escalation, { onCall: options.onCall ?? true });
}
