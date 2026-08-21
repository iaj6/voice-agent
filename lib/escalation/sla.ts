/**
 * How long an escalation may sit unacknowledged before it is a problem.
 *
 * Decided in docs/ONCALL.md (D-A b): 15 minutes, 4 hours, next business day.
 * The previous values were placeholders invented so the code had something to
 * compare against.
 *
 * They are deliberately tighter than the regulatory clock: 21 CFR 312.32 gives a sponsor 7 or 15 days for an IND safety
 * report, and ICH E2A gives a site 24 hours to tell the sponsor about a serious
 * event. Neither of those is the question here. The question is how long a
 * participant who has just described chest pain waits for a human, and the
 * answer cannot be a reporting deadline.
 *
 * The acknowledgement window is the front half of the protocol's 24-hour SAE
 * awareness clock: an escalation sitting unacknowledged is the site not yet being
 * aware, and a page that waits twenty hours leaves four for everything else.
 */
import type { EscalationUrgency } from "../clinical/safety.ts";
import { configuredWindow, nextOpening } from "../clinical/calling-hours.ts";

export const ACK_SLA_MS: Record<EscalationUrgency, number> = {
  emergency: 15 * 60 * 1000,
  urgent: 4 * 60 * 60 * 1000,
  // A placeholder value only; the real deadline for routine is the next time
  // somebody is on call, which ackDeadline resolves from the call window. This
  // is the fallback for a deployment with no window configured.
  routine: 24 * 60 * 60 * 1000,
};

/**
 * When an escalation stops being in flight and starts being a problem.
 *
 * Emergency and urgent are fixed offsets: they are meant to interrupt whoever is
 * covering, and an interruption that waits for opening hours is not one.
 *
 * Routine is "the next business day", which is not a number of milliseconds —
 * it is the next time somebody is on call. Resolving it against the call window
 * means a routine flag raised at 4pm on Friday is due Monday morning rather than
 * Saturday afternoon, when the deadline would pass unseen and the alarm would
 * fire into an empty office.
 */
export function ackDeadline(urgency: EscalationUrgency, from = Date.now()): Date {
  const fixed = new Date(from + ACK_SLA_MS[urgency]);
  if (urgency !== "routine") return fixed;

  const window = configuredWindow();
  if (!window) return fixed;

  // The next opening strictly after the raise time; if the site is open now,
  // still the *next* one, because "next business day" is not "in ten minutes".
  return nextOpening(new Date(from), window);
}
