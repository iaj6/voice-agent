/**
 * How long an escalation may sit unacknowledged before it is a problem.
 *
 * These are the pilot's numbers and they are deliberately tighter than the
 * regulatory clock: 21 CFR 312.32 gives a sponsor 7 or 15 days for an IND safety
 * report, and ICH E2A gives a site 24 hours to tell the sponsor about a serious
 * event. Neither of those is the question here. The question is how long a
 * participant who has just described chest pain waits for a human, and the
 * answer cannot be a reporting deadline.
 *
 * Site agreement is backlog 2.6 and will replace these.
 */
import type { EscalationUrgency } from "../clinical/safety.ts";

export const ACK_SLA_MS: Record<EscalationUrgency, number> = {
  emergency: 5 * 60 * 1000,
  urgent: 60 * 60 * 1000,
  routine: 24 * 60 * 60 * 1000,
};

export function ackDeadline(urgency: EscalationUrgency, from = Date.now()): Date {
  return new Date(from + ACK_SLA_MS[urgency]);
}
