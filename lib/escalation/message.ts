/**
 * What an escalation email says — and deliberately, what it does not.
 *
 * Email is a subprocessor hop and an inbox is not a clinical record, so this
 * carries the least that still lets a coordinator triage: who, how urgent, what
 * category, and a link. **No verbatim quotes, no date of birth, no transcript.**
 * Those live behind the acknowledgement link, inside the system that has an
 * audit trail and a retention policy — see docs/RETENTION.md §1, which spent
 * some effort establishing that free text is where identity actually lives.
 *
 * The clinical reason is included, because "possible cardiac or respiratory
 * emergency" is the entire value of the page and withholding it would make the
 * message useless. It is a category written by the system, not something the
 * participant said.
 */

import type { EscalationUrgency } from "../clinical/safety.ts";
import { PROTOCOL } from "../clinical/protocol.ts";
import type { EscalationMessage } from "./transport.ts";

const URGENCY_LABEL: Record<EscalationUrgency, string> = {
  emergency: "EMERGENCY — respond now",
  urgent: "URGENT — respond today",
  routine: "Routine — review in the normal queue",
};

export interface EscalationNotice {
  escalationId: string;
  urgency: EscalationUrgency;
  /**
   * What this is about, in words the system chose.
   *
   * Never the model's free text. `escalate_to_coordinator` takes a `reason`
   * written by the model — prompted, in its own schema, for "what the coordinator
   * needs to know, in two sentences or less" — which is an open invitation to
   * paraphrase what the subject just said. Nothing screens it, and this file
   * promises the message carries no verbatim, no names, no transcript. A model
   * writing "her daughter Sarah is driving her to Northlake" would have shipped
   * exactly that to a mail provider.
   *
   * The caller derives this from structured fields: the safety-net category, or
   * the coded terms of the events the escalation cites. The free text stays in
   * the record, behind the link.
   */
  summary: string;
  subjectId: string | null;
  coordinatorName: string | null;
  siteName: string | null;
  raisedAt: string;
  ackUrl: string;
  deadline: Date;
}

export function composeEscalation(notice: EscalationNotice): Omit<EscalationMessage, "to"> {
  const subject =
    `[${PROTOCOL.protocolId}] ${notice.urgency.toUpperCase()} — ` +
    `subject ${notice.subjectId ?? "unidentified"} (${notice.escalationId})`;

  const respondBy = notice.deadline.toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const lines = [
    URGENCY_LABEL[notice.urgency],
    "",
    `Protocol:    ${PROTOCOL.protocolId} — ${PROTOCOL.shortTitle}`,
    `Subject:     ${notice.subjectId ?? "not yet verified"}`,
    `Site:        ${notice.siteName ?? "unknown"}`,
    `Coordinator: ${notice.coordinatorName ?? "unassigned"}`,
    `Raised:      ${notice.raisedAt.replace("T", " ").slice(0, 16)} UTC`,
    `Respond by:  ${respondBy}`,
    "",
    "What:",
    `  ${notice.summary}`,
    "",
    "Acknowledge, and open the full record:",
    `  ${notice.ackUrl}`,
    "",
    "This message deliberately contains no transcript, no verbatim symptom",
    "description and no date of birth. Those are in the record behind the link.",
    "",
    "Automated check-in assistant. If this reached you in error, the call record",
    "will say so; do not reply to this address.",
  ];

  const html = `<div style="font-family:ui-monospace,Menlo,monospace;font-size:14px;line-height:1.6">
<p style="font-weight:700;color:${notice.urgency === "emergency" ? "#b3261e" : notice.urgency === "urgent" ? "#8a5300" : "#3c4043"}">
${escapeHtml(URGENCY_LABEL[notice.urgency])}</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${row("Protocol", `${PROTOCOL.protocolId} — ${PROTOCOL.shortTitle}`)}
${row("Subject", notice.subjectId ?? "not yet verified")}
${row("Site", notice.siteName ?? "unknown")}
${row("Coordinator", notice.coordinatorName ?? "unassigned")}
${row("Raised", notice.raisedAt.replace("T", " ").slice(0, 16) + " UTC")}
${row("Respond by", respondBy)}
</table>
<p style="margin-top:16px"><strong>What:</strong><br>${escapeHtml(notice.summary)}</p>
<p style="margin-top:20px">
<a href="${escapeHtml(notice.ackUrl)}"
   style="background:#1a73e8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">
Acknowledge and open the record</a></p>
<p style="margin-top:20px;color:#5f6368;font-size:12px">
This message deliberately contains no transcript, no verbatim symptom description
and no date of birth. Those are in the record behind the link.</p>
</div>`;

  return { subject, text: lines.join("\n"), html };
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:2px 16px 2px 0;color:#5f6368">${escapeHtml(label)}</td><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
