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

function baseUrl(): string {
  return (
    process.env.VOICE_AGENT_PUBLIC_URL ??
    process.env.VOICE_AGENT_URL ??
    "http://localhost:3100"
  );
}

export async function deliverEscalation(
  session: CheckInSession,
  escalation: EscalationRecord,
): Promise<DeliveryOutcome> {
  const store = getDeliveryStore();
  const transport = getTransport();
  const to = escalationRecipient();
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
    ackUrl: `${baseUrl()}/api/escalation/ack?t=${token}`,
    deadline,
  });

  try {
    const { providerId } = await transport.send({ ...message, to });
    await store.markSent(delivery.id, providerId);
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
    return { delivered: true, delivery: { ...delivery, status: "sent", providerId }, detail: null };
  } catch (err) {
    const detail =
      err instanceof DeliveryFailure ? err.detail : `unexpected error: ${String(err)}`;
    await store.markFailed(delivery.id, detail);
    return fail(session, escalation, attempt, transport.channel, to, detail, delivery);
  }
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
