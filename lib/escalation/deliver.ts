/**
 * Sending an escalation, and recording honestly whether it went.
 *
 * The system used to return `notified: coordinator` and have the agent say "your
 * coordinator has been alerted" out loud, while nothing had been sent anywhere.
 * That is the single place this system told a sick person something untrue, and
 * everything here exists to make the claim match the fact.
 *
 * Delivery is attempted *before* the tool returns, so the agent's next sentence
 * can reflect what actually happened. It costs a few hundred milliseconds on a
 * live call, which is the right trade against telling someone help is coming
 * when it is not.
 */

import type { CheckInSession, EscalationRecord } from "../store/session.ts";
import {
  getDeliveryStore,
  newAckToken,
  type DeliveryRecord,
  type DeliveryTier,
} from "../store/deliveries.ts";
import { composeEscalation } from "./message.ts";
import { ackDeadline } from "./sla.ts";
import {
  DeliveryFailure,
  escalationRecipient,
  getTransport,
} from "./transport.ts";

export interface DeliveryOutcome {
  delivered: boolean;
  delivery: DeliveryRecord | null;
  detail: string | null;
}

/**
 * Where acknowledgement links point, or null if that cannot be answered.
 *
 * Null rather than a localhost default in production. Every other missing
 * setting here is a loud delivery failure; this one used to fall back silently,
 * so a deployment with mail configured but no public URL sent coordinators a
 * page whose acknowledge button pointed at localhost — reported as delivered,
 * never acknowledged, quietly overdue. Empty strings count as unset, because
 * `??` let one through and produced a relative href inside an email.
 */
/**
 * What the notification may say this is about, built only from structured fields.
 *
 * Urgency and category come from the deterministic net. Coded terms come from
 * the eCRF, where they are the clinical vocabulary a coordinator reads — the
 * retention analysis already classed coded terms and grades as structured data
 * that identifies nobody, as against the verbatim, which does. Nothing here can
 * carry a sentence the model wrote.
 */
function safeSummary(session: CheckInSession, escalation: EscalationRecord): string {
  if (escalation.category) {
    return `Deterministic safety rule: ${escalation.category}.`;
  }

  const cited = escalation.relatedEventIds
    .map((id) => session.adverseEvents.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e))
    .map((e) => `${e.codedTerm} (grade ${e.grade})`);

  if (cited.length > 0) {
    return `Adverse event(s) requiring review: ${cited.join("; ")}.`;
  }
  return (
    "The check-in agent raised this for coordinator review. The details are in " +
    "the record; they are deliberately not repeated in this message."
  );
}

function ackBaseUrl(): string | null {
  const configured =
    process.env.VOICE_AGENT_PUBLIC_URL?.trim() || process.env.VOICE_AGENT_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return process.env.NODE_ENV === "production" ? null : "http://localhost:3100";
}

export interface DeliveryOptions {
  /** Which rung of the ladder this is. Defaults to the first. */
  tier?: DeliveryTier;
  /** Overrides the recipient, for a secondary contact or an alarm. */
  to?: string | null;
  /**
   * The clock this delivery is stamped against.
   *
   * One clock per pass. The sweeper decides whether a window has closed against
   * a time it is given, while the deadline here was computed from Date.now() —
   * so a backup contact paged during a sweep was handed a deadline in a
   * different frame from the one that would judge it, and its window could lapse
   * the instant it was created. The same two-clock mistake as reading a database
   * timestamp against an application clock.
   */
  now?: Date;
}

export async function deliverEscalation(
  session: CheckInSession,
  escalation: EscalationRecord,
  options: DeliveryOptions = {},
): Promise<DeliveryOutcome> {
  // Everything is inside the guard, not just the send.
  //
  // Only transport.send() used to be wrapped, so a database hiccup while
  // queueing the attempt threw straight out of this function: no delivery row,
  // no ESCALATION_DELIVERY_FAILED entry, and — from the safety-net path, which
  // has no catch — the whole turn aborted mid-emergency. "Never silent" has to
  // survive the parts that are not the network.
  try {
    return await attemptDelivery(session, escalation, options);
  } catch (err) {
    return fail(
      session,
      escalation,
      0,
      "unknown",
      "(unknown)",
      `delivery could not be attempted: ${String(err)}`,
    );
  }
}

async function attemptDelivery(
  session: CheckInSession,
  escalation: EscalationRecord,
  options: DeliveryOptions,
): Promise<DeliveryOutcome> {
  const store = getDeliveryStore();
  const transport = getTransport();
  const tier = options.tier ?? "primary";
  const to = options.to !== undefined ? options.to : escalationRecipient();
  const link = ackBaseUrl();
  const attempt = (await store.attemptsFor(session.id, escalation.id)) + 1;

  // No recipient is a delivery failure, not a skip. A system with nowhere to
  // send escalations should say so every time it tries, not once at boot.
  if (!to) {
    return fail(
      session,
      escalation,
      attempt,
      transport.channel,
      "(none)",
      "ESCALATION_EMAIL_TO is not set, so there is nowhere to send this",
    );
  }
  if (!link) {
    // The one setting that used to fail quietly. A page whose acknowledgement
    // button points at localhost is reported as delivered, is never
    // acknowledged, and silently becomes an overdue row.
    return fail(
      session,
      escalation,
      attempt,
      transport.channel,
      to,
      "no public base URL is configured, so the acknowledgement link would be unreachable",
    );
  }

  const token = newAckToken();
  const deadline = ackDeadline(escalation.urgency, (options.now ?? new Date()).getTime());
  const delivery = await store.queue(
    {
      sessionId: session.id,
      escalationId: escalation.id,
      subjectId: session.subject?.subjectId ?? null,
      urgency: escalation.urgency,
      channel: transport.channel,
      destination: to,
      attempt,
      tier,
      deadlineAt: deadline,
    },
    token,
  );

  const message = composeEscalation({
    escalationId: escalation.id,
    urgency: escalation.urgency,
    summary: safeSummary(session, escalation),
    tier,
    subjectId: session.subject?.subjectId ?? null,
    coordinatorName: session.subject?.coordinatorName ?? null,
    siteName: session.subject?.siteName ?? null,
    raisedAt: escalation.createdAt,
    ackUrl: `${link}/api/escalation/ack?t=${token}`,
    deadline,
  });

  let providerId: string;
  try {
    ({ providerId } = await transport.send({ ...message, to, urgency: escalation.urgency }));
  } catch (err) {
    const detail =
      err instanceof DeliveryFailure ? err.detail : `unexpected error: ${String(err)}`;
    // Bookkeeping must not turn a failure into a thrown error.
    await store.markFailed(delivery.id, detail).catch(() => {});
    return fail(session, escalation, attempt, transport.channel, to, detail, delivery);
  }

  // Sent. From here the message is in the coordinator's inbox and nothing that
  // happens to our own records can make that untrue — recording the send used to
  // sit inside the same try, so a database failure after a successful send told
  // the subject nobody had been notified while the page sat in an inbox, and
  // marked the row `failed`, which the overdue alarm excludes.
  try {
    await store.markSent(delivery.id, providerId);
  } catch (err) {
    session.audit.record({
      actor: "system",
      action: "ESCALATION_DELIVERY_UNRECORDED",
      entity: "Escalation",
      entityId: escalation.id,
      after: { deliveryId: delivery.id, providerId, error: String(err) },
      reason:
        "The escalation was delivered but the delivery record could not be " +
        "updated. It was sent; the acknowledgement alarm may not track it.",
    });
  }

  session.audit.record({
    actor: "system",
    action: "ESCALATION_DELIVERED",
    entity: "Escalation",
    entityId: escalation.id,
    after: {
      deliveryId: delivery.id,
      channel: transport.channel,
      destination: to,
      providerId,
      attempt,
      acknowledgeBy: deadline.toISOString(),
    },
    reason:
      "The escalation was accepted by the delivery provider. It is not " +
      "acknowledged until a human opens it.",
  });
  return {
    delivered: true,
    delivery: { ...delivery, status: "sent", providerId },
    detail: null,
  };
}

/**
 * A failed send is itself an escalation (2.5).
 *
 * Recorded at the highest urgency the original had, never lower, and never as a
 * warning in a log. The failure mode being designed against is a system that
 * quietly stops paging anyone and keeps reporting that it did.
 */
async function fail(
  session: CheckInSession,
  escalation: EscalationRecord,
  attempt: number,
  channel: string,
  destination: string,
  detail: string,
  delivery: DeliveryRecord | null = null,
): Promise<DeliveryOutcome> {
  // A row even when nothing could be attempted. The config failures used to
  // leave only a sealed audit entry, so attemptsFor() stayed at 0, `attempt`
  // never advanced across retries, and the deployment most likely to hit them —
  // a fresh environment with the env half set — was the one with nothing in
  // escalation_delivery for an operator to notice.
  if (!delivery) {
    delivery = await getDeliveryStore()
      .queue(
        {
          sessionId: session.id,
          escalationId: escalation.id,
          subjectId: session.subject?.subjectId ?? null,
          urgency: escalation.urgency,
          channel,
          destination,
          attempt: Math.max(attempt, 1),
          tier: "primary",
          deadlineAt: ackDeadline(escalation.urgency),
        },
        newAckToken(),
      )
      .catch(() => null);
    if (delivery) {
      await getDeliveryStore().markFailed(delivery.id, detail).catch(() => {});
    }
  }

  session.audit.record({
    actor: "system",
    action: "ESCALATION_DELIVERY_FAILED",
    entity: "Escalation",
    entityId: escalation.id,
    after: { attempt, channel, destination, error: detail, urgency: escalation.urgency },
    reason:
      "The escalation could not be delivered. Nobody has been notified by this " +
      "system, and the record must not be read as though anyone had been.",
  });
  return { delivered: false, delivery, detail };
}
