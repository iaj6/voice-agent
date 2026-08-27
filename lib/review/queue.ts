/**
 * What a coordinator should look at first, and why.
 *
 * A review queue that is just "every call, newest first" is a queue nobody works
 * — the interesting calls are a minority and they are not the recent ones. So
 * each call carries the reasons it wants attention, and the reasons are ordered
 * by how badly a missed one would hurt.
 *
 * The ordering is deliberately not clever. It is a fixed precedence over facts
 * already in the record, because a coordinator has to be able to predict what
 * the top of their queue means, and because a ranking nobody can explain is a
 * ranking nobody trusts.
 */

import { PROTOCOL } from "../clinical/protocol.ts";
import type { CallSummary } from "../store/summaries.ts";

export type ReviewReasonKind =
  | "emergency_escalation"
  | "urgent_escalation"
  | "serious_event"
  | "high_grade_event"
  | "incomplete_screen"
  | "unverified"
  | "provenance_rejection"
  | "routine_escalation"
  | "dropped_call";

export interface ReviewReason {
  kind: ReviewReasonKind;
  detail: string;
}

/**
 * Precedence, worst first.
 *
 * `provenance_rejection` sits above routine escalations on purpose: it means the
 * agent tried to attribute words to a participant that the participant did not
 * say, and the gate stopped it. That is a fact about the instrument rather than
 * about the person, and an instrument inventing quotes is worse than a routine
 * symptom nobody has read yet.
 */
const PRECEDENCE: ReviewReasonKind[] = [
  "emergency_escalation",
  "urgent_escalation",
  "serious_event",
  "high_grade_event",
  "provenance_rejection",
  "incomplete_screen",
  "dropped_call",
  "unverified",
  "routine_escalation",
];

/** CTCAE 3 and above is the threshold the protocol escalates on. */
const HIGH_GRADE = 3;

/**
 * How many screen items this participant should have been asked.
 *
 * Not a constant. The pregnancy item applies only to participants of childbearing
 * potential — the tool filters on it and the prompt tells the agent to skip it —
 * so three of the four roster subjects legitimately answer 8 of 9 and the tool
 * says "Screen complete". A hard-coded 9 put a permanent PARTIAL SCREEN badge on
 * every clean call for the majority of the queue, which is exactly the
 * "teaches a coordinator to dismiss this reason" failure the emergency carve-out
 * below was written to avoid.
 */
export function screenItemsFor(childbearingPotential: boolean | null): number {
  return PROTOCOL.safetyScreen.filter(
    (i) => i.appliesTo !== "childbearing_potential" || childbearingPotential === true,
  ).length;
}

/** Every item the protocol defines, for a participant they all apply to. */
export const SCREEN_ITEM_COUNT = PROTOCOL.safetyScreen.length;

export interface ReviewItem {
  call: CallSummary;
  reasons: ReviewReason[];
  /** Index of the worst reason in PRECEDENCE. Lower is more urgent. */
  rank: number;
}

export function reasonsFor(call: CallSummary): ReviewReason[] {
  const reasons: ReviewReason[] = [];

  // Collapsed by urgency. One reason per escalation meant a call with three
  // emergencies wore the same badge three times, which reads as noise and
  // crowds out the other reasons the call is here.
  for (const urgency of ["emergency", "urgent", "routine"] as const) {
    const matching = call.escalations.filter((e) => e.urgency === urgency);
    if (matching.length === 0) continue;
    const kind: ReviewReasonKind =
      urgency === "emergency"
        ? "emergency_escalation"
        : urgency === "urgent"
          ? "urgent_escalation"
          : "routine_escalation";
    const byNet = matching.filter((e) => e.triggeredBy === "safety_net").length;
    const categories = [...new Set(matching.map((e) => e.category).filter(Boolean))];
    reasons.push({
      kind,
      detail:
        `${matching.length} ${urgency} escalation${matching.length === 1 ? "" : "s"}` +
        (byNet ? ` (${byNet} from the safety net)` : "") +
        (categories.length ? ` — ${categories.join(", ")}` : ""),
    });
  }

  const serious = call.events.filter((e) => e.serious).length;
  if (serious > 0) {
    reasons.push({
      kind: "serious_event",
      detail: `${serious} event${serious === 1 ? "" : "s"} meeting a seriousness criterion`,
    });
  }

  const high = call.events.filter((e) => e.grade >= HIGH_GRADE).length;
  if (high > 0) {
    reasons.push({
      kind: "high_grade_event",
      detail: `${high} event${high === 1 ? "" : "s"} at grade ${HIGH_GRADE} or above`,
    });
  }

  if (call.provenanceRejections > 0) {
    reasons.push({
      kind: "provenance_rejection",
      detail: `${call.provenanceRejections} quote${
        call.provenanceRejections === 1 ? "" : "s"
      } refused as unfounded — the agent attributed words nobody said`,
    });
  }

  // A screen is incomplete whenever a verified call finished without working
  // through it — including the zero case, which an earlier version skipped and
  // which is the worst version of this: a completed record with no screen at all,
  // invisible in the queue.
  //
  // Except after an emergency. The agent is instructed to abandon the script the
  // moment it sees one, so an emergency call with a half-finished screen is the
  // rule being followed, and flagging it would teach a coordinator to dismiss
  // this reason.
  const abandonedForEmergency = call.escalations.some((e) => e.urgency === "emergency");
  const expected = screenItemsFor(call.childbearingPotential);
  if (
    call.verified &&
    call.completedAt !== null &&
    call.screenAnswered < expected &&
    !abandonedForEmergency
  ) {
    reasons.push({
      kind: "incomplete_screen",
      detail: `${call.screenAnswered} of ${expected} screen items answered`,
    });
  }

  if (!call.completedAt && call.verified) {
    reasons.push({
      kind: "dropped_call",
      detail: "the call never completed — the record is whatever it reached",
    });
  }

  if (!call.verified) {
    reasons.push({
      kind: "unverified",
      detail: "identity was never verified, so nothing clinical was collected",
    });
  }

  // Sorted before returning. The badge row is the coordinator's triage signal
  // and it is rendered in order, so a call with a routine escalation and a
  // serious event was leading with the routine one.
  return reasons.sort(
    (a, b) => PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind),
  );
}

export function rankOf(reasons: readonly ReviewReason[]): number {
  if (reasons.length === 0) return PRECEDENCE.length;
  return Math.min(...reasons.map((r) => PRECEDENCE.indexOf(r.kind)));
}

export interface QueueOptions {
  /** Include calls with nothing flagged. Off by default; that is the point. */
  includeUnflagged?: boolean;
}

export function buildQueue(
  calls: readonly CallSummary[],
  options: QueueOptions = {},
): ReviewItem[] {
  return calls
    .map((call) => {
      const reasons = reasonsFor(call);
      return { call, reasons, rank: rankOf(reasons) };
    })
    .filter((item) => options.includeUnflagged || item.reasons.length > 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        // Within a tier, oldest first: a queue that puts the newest urgent call
        // on top buries the one that has been waiting longest.
        Date.parse(a.call.createdAt) - Date.parse(b.call.createdAt),
    );
}
