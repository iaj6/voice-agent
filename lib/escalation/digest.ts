/**
 * A standing summary of everything nobody has acknowledged.
 *
 * D-D chose email plus a daily digest, and the digest is the half that catches
 * the slow failures. The alarm fires once, into the same inbox that had already
 * ignored two messages; the digest is the thing that is still saying so tomorrow
 * morning. It will not help an emergency — nothing sent once a day will — and it
 * is exactly right for a routine flag raised on Friday afternoon that nobody
 * opened.
 *
 * Deliberately not per-participant. It carries counts, ages and escalation ids;
 * the clinical content stays behind the acknowledgement links, on the same
 * reasoning as the notifications themselves.
 */

import { getDeliveryStore, type DeliveryRecord } from "../store/deliveries.ts";
import { PROTOCOL } from "../clinical/protocol.ts";
import { getTransport, escalationRecipient, DeliveryFailure } from "./transport.ts";

export interface DigestResult {
  outstanding: number;
  overdue: number;
  sent: boolean;
  detail: string | null;
}

function hoursSince(iso: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(iso)) / 3_600_000);
}

export function composeDigest(rows: DeliveryRecord[], now: Date): { subject: string; text: string } {
  const overdue = rows.filter((r) => Date.parse(r.deadlineAt) < now.getTime());
  const subject =
    overdue.length > 0
      ? `[${PROTOCOL.protocolId}] ${overdue.length} escalation(s) past their response window`
      : `[${PROTOCOL.protocolId}] ${rows.length} escalation(s) awaiting acknowledgement`;

  const lines = [
    overdue.length > 0
      ? `${overdue.length} of ${rows.length} outstanding escalations are past the window.`
      : `${rows.length} escalation(s) are awaiting acknowledgement, none overdue.`,
    "",
  ];

  for (const row of [...rows].sort((a, b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt))) {
    const late = Date.parse(row.deadlineAt) < now.getTime();
    lines.push(
      `${late ? "OVERDUE" : "  open "}  ${row.urgency.padEnd(9)} ` +
        `subject ${row.subjectId ?? "unidentified"}  ${row.escalationId}  ` +
        `${hoursSince(row.deadlineAt, now).toFixed(1)}h past due`.replace(
          /^-?[\d.]+h past due$/,
          late ? `${hoursSince(row.deadlineAt, now).toFixed(1)}h past due` : "in window",
        ),
    );
  }

  lines.push(
    "",
    "Open each escalation from the message that raised it to acknowledge it.",
    "This summary deliberately carries no clinical detail.",
  );
  return { subject, text: lines.join("\n") };
}

export async function sendDigest(now = new Date()): Promise<DigestResult> {
  // unacknowledged(), not openLadder(): the ladder retires an escalation once
  // it has alarmed, which is precisely the one the digest exists to keep
  // reporting the next morning.
  const rows = await getDeliveryStore().unacknowledged();
  // One row per escalation: the ladder holds every attempt, and a digest that
  // counted attempts would report one unanswered page three times.
  const byEscalation = new Map<string, DeliveryRecord>();
  for (const row of rows) {
    const key = `${row.sessionId}:${row.escalationId}`;
    const existing = byEscalation.get(key);
    if (!existing || Date.parse(row.deadlineAt) < Date.parse(existing.deadlineAt)) {
      byEscalation.set(key, row);
    }
  }
  const outstanding = [...byEscalation.values()];
  const overdue = outstanding.filter((r) => Date.parse(r.deadlineAt) < now.getTime());

  if (outstanding.length === 0) {
    // Silence when there is nothing outstanding. A daily "all clear" trains
    // people to delete it unread, which is how the one that matters gets missed.
    return { outstanding: 0, overdue: 0, sent: false, detail: "nothing outstanding" };
  }

  const to = escalationRecipient();
  if (!to) return { outstanding: outstanding.length, overdue: overdue.length, sent: false, detail: "no recipient configured" };

  const { subject, text } = composeDigest(outstanding, now);
  try {
    await getTransport().send({ to, subject, text, html: `<pre>${escapeHtml(text)}</pre>` });
    return { outstanding: outstanding.length, overdue: overdue.length, sent: true, detail: null };
  } catch (err) {
    return {
      outstanding: outstanding.length,
      overdue: overdue.length,
      sent: false,
      detail: err instanceof DeliveryFailure ? err.detail : String(err),
    };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
