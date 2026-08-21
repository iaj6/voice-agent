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
function ackBaseUrl(): string | null {
  const configured =
    process.env.VOICE_AGENT_PUBLIC_URL?.trim() || process.env.VOICE_AGENT_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return process.env.NODE_ENV === "production" ? null : "http://localhost:3100";
}

export async function deliverEscalation(
  session: CheckInSession,
  escalation: EscalationRecord,
): Promise<DeliveryOutcome> {
  // Everything is inside the guard, not just the send.
  //
  // Only transport.send() used to be wrapped, so a database hiccup while
  // queueing the attempt threw straight out of this function: no delivery row,
  // no ESCALATION_DELIVERY_FAILED entry, and — from the safety-net path, which
  // has no catch — the whole turn aborted mid-emergency. "Never silent" has to
  // survive the parts that are not the network.
  try {
    return await attemptDelivery(session, escalation);
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
): Promise<DeliveryOutcome> {
  const store = getDeliveryStore();
  const transport = getTransport();
  const to = escalationRecipient();
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
  const deadline = ackDeadline(escalation.urgency);
  const delivery = await store.queue(
    {
      sessionId: session.id,
      escalationId: escalation.id,
      subjectId: session.subject?.subjectId ?? null,
      urgency: escalation.urgency,
      channel: transport.channel,
      destination: to,
      attempt,
      deadlineAt: deadline,
    },
    token,
  );

  const message = composeEscalation({
    escalationId: escalation.id,
    urgency: escalation.urgency,
    reason: escalation.reason,
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
