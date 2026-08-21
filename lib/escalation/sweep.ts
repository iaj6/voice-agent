/**
 * The part that runs when nobody is on the call.
 *
 * Delivery told the truth about a single send. It could not retry, because the
 * subject is on the line and a live call is the wrong place to sit in a backoff
 * loop; and it could not notice silence, because noticing silence means waiting.
 * `overdue()` existed and nothing called it, which meant an escalation that
 * nobody opened looked exactly like one that had been handled.
 *
 * This closes that, in three moves, each idempotent so the sweep can run as
 * often as it likes:
 *
 *   1. Retry sends that failed, out of band, with backoff.
 *   2. Page the backup contact when the primary lets the window close.
 *   3. Raise an alarm when the ladder runs out.
 *
 * Everything it does lands on the session's audit trail, because "the
 * coordinator did not respond within the window" is a fact about a
 * participant's care, not an operational metric.
 */

import { getDeliveryStore, type DeliveryRecord } from "../store/deliveries.ts";
import { getSessionStore } from "../store/session-store.ts";
import type { CheckInSession, EscalationRecord } from "../store/session.ts";
import { deliverEscalation } from "./deliver.ts";
import { escalationRecipient } from "./transport.ts";

/**
 * How many out-of-band retries a failed send gets before the ladder moves on.
 *
 * Retries, not attempts. The original in-call send is not one of them — counting
 * it made the documented figure and the actual behaviour differ by one, which is
 * the kind of thing nobody notices until they are counting pages during an
 * incident.
 */
export const MAX_RETRIES = 3;

/** Wait between retries. Short: these are pages, not newsletters. */
export const RETRY_BACKOFF_MS = 60_000;

export interface SweepResult {
  retried: number;
  escalatedToSecondary: number;
  alarmed: number;
  /**
   * Retries that were attempted and failed again.
   *
   * Counted separately, because a sweep that is actively churning failed sends
   * used to report all zeros — "nothing needed doing" — on a system whose whole
   * premise is that failures are never silent.
   */
  retriesFailed: number;
  stillWaiting: number;
  /**
   * Delivery rows whose escalation could not be found on its session.
   *
   * Counted rather than skipped in silence. It means a page went out for
   * something the record does not contain — a call that died between escalating
   * and persisting, or a shredded record — and an escalation the ladder cannot
   * climb is exactly the thing this sweep exists to stop being invisible.
   */
  orphaned: number;
}

export function secondaryRecipient(): string | null {
  return process.env.ESCALATION_EMAIL_SECONDARY?.trim() || null;
}

export function alarmRecipient(): string | null {
  // Falls back to the primary rather than going nowhere. An alarm that has no
  // destination is the failure it exists to report.
  return process.env.ESCALATION_EMAIL_ALARM?.trim() || escalationRecipient();
}

interface Ladder {
  sessionId: string;
  escalationId: string;
  rows: DeliveryRecord[];
}

function groupByEscalation(rows: DeliveryRecord[]): Ladder[] {
  const groups = new Map<string, Ladder>();
  for (const row of rows) {
    const key = `${row.sessionId}:${row.escalationId}`;
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else
      groups.set(key, {
        sessionId: row.sessionId,
        escalationId: row.escalationId,
        rows: [row],
      });
  }
  return [...groups.values()];
}

const delivered = (r: DeliveryRecord) =>
  r.status === "sent" || r.status === "acknowledged";

/**
 * One pass over everything unacknowledged.
 *
 * `now` is a parameter so a test can move time rather than wait for it — an
 * alarm that can only be observed by sleeping for an hour is an alarm nobody
 * tests.
 */
export async function sweepEscalations(now = new Date()): Promise<SweepResult> {
  const store = getDeliveryStore();
  const result: SweepResult = {
    retried: 0,
    escalatedToSecondary: 0,
    alarmed: 0,
    retriesFailed: 0,
    stillWaiting: 0,
    orphaned: 0,
  };

  for (const ladder of groupByEscalation(await store.openLadder())) {
    const loaded = await load(ladder.sessionId, ladder.escalationId);
    if (!loaded) {
      result.orphaned += 1;
      continue;
    }
    const { session, escalation } = loaded;

    const primary = ladder.rows.filter((r) => r.tier === "primary");
    const secondary = ladder.rows.filter((r) => r.tier === "secondary");
    const alarms = ladder.rows.filter((r) => r.tier === "alarm");

    // 1. Nothing has ever reached anyone on this rung. Retry it.
    if (!primary.some(delivered)) {
      if (primary.length > MAX_RETRIES) {
        if (alarms.length === 0) {
          await raiseAlarm(session, escalation, "delivery failed repeatedly", now);
          result.alarmed += 1;
        }
        continue;
      }
      // Backoff from when the attempt was actually made.
      //
      // It used to reconstruct the send time by subtracting the SLA from the
      // deadline — which stopped being true the moment routine deadlines started
      // resolving against the call window. For routine the derived "send time"
      // became nextOpening minus 24h, often in the future, so the elapsed time
      // went negative, the backoff never expired, and a failed routine page was
      // never retried at all.
      const last = primary.at(-1);
      if (last && now.getTime() - Date.parse(last.createdAt) < RETRY_BACKOFF_MS) {
        result.stillWaiting += 1;
        continue;
      }
      const retry = await deliverEscalation(session, escalation, { now });
      await getSessionStore().appendAudit(session);
      if (retry.delivered) result.retried += 1;
      else result.retriesFailed += 1;
      continue;
    }

    // 2. It was delivered and the window closed with no acknowledgement.
    const newest = primary.filter(delivered).at(-1)!;
    if (now.getTime() <= Date.parse(newest.deadlineAt)) {
      result.stillWaiting += 1;
      continue;
    }

    if (secondary.length === 0) {
      const backup = secondaryRecipient();
      if (backup) {
        session.audit.record({
          actor: "system",
          action: "ESCALATION_UNACKNOWLEDGED",
          entity: "Escalation",
          entityId: escalation.id,
          after: {
            urgency: escalation.urgency,
            deadline: newest.deadlineAt,
            pagedAt: newest.deadlineAt,
          },
          reason:
            "The primary contact did not acknowledge this escalation within the " +
            "response window. The backup contact is being paged.",
        });
        await deliverEscalation(session, escalation, {
          tier: "secondary",
          to: backup,
          now,
        });
        await getSessionStore().appendAudit(session);
        result.escalatedToSecondary += 1;
        continue;
      }
      // No backup configured: the ladder is one rung, so this is the alarm.
      if (alarms.length === 0) {
        await raiseAlarm(session, escalation, "no acknowledgement, and no backup contact", now);
        result.alarmed += 1;
      }
      continue;
    }

    // 3. The backup was paged and also let the window close.
    const newestSecondary = secondary.filter(delivered).at(-1);
    const secondaryLapsed =
      !newestSecondary || now.getTime() > Date.parse(newestSecondary.deadlineAt);
    if (secondaryLapsed && alarms.length === 0) {
      await raiseAlarm(session, escalation, "neither contact acknowledged", now);
      result.alarmed += 1;
      continue;
    }
    result.stillWaiting += 1;
  }

  return result;
}

async function raiseAlarm(
  session: CheckInSession,
  escalation: EscalationRecord,
  why: string,
  now: Date,
): Promise<void> {
  session.audit.record({
    actor: "system",
    action: "ESCALATION_ALARM",
    entity: "Escalation",
    entityId: escalation.id,
    after: { urgency: escalation.urgency, why, at: now.toISOString() },
    reason:
      "This escalation has exhausted the contact ladder without being " +
      "acknowledged by anyone. It is on the record as unhandled, and stays that " +
      "way until a human acknowledges it.",
  });
  await deliverEscalation(session, escalation, {
    tier: "alarm",
    to: alarmRecipient(),
    now,
  });
  await getSessionStore().appendAudit(session);
}

async function load(
  sessionId: string,
  escalationId: string,
): Promise<{ session: CheckInSession; escalation: EscalationRecord } | null> {
  const session = await getSessionStore().get(sessionId);
  if (!session) return null;
  // A shredded record still has its delivery rows, but no content to page about
  // and no key to seal new audit entries with. Leave it alone.
  if (session.shredded) return null;
  const escalation = session.escalations.find((e) => e.id === escalationId);
  return escalation ? { session, escalation } : null;
}
