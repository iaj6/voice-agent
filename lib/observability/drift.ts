/**
 * Whether the instrument is still measuring the same thing it was last week.
 *
 * A check-in agent can degrade without anything failing. A model update shifts
 * how it grades, so a population that used to produce grade 2 events starts
 * producing grade 1s and the study quietly under-reports. A recogniser update
 * changes what it hears. A prompt edit makes the agent escalate more, or less.
 * None of that raises an error; all of it changes the dataset.
 *
 * So the numbers describing the *output* get tracked over time, and a shift
 * becomes something you can see rather than something someone eventually
 * notices.
 *
 * **These are descriptive, not thresholds.** A rising escalation rate can mean
 * the agent got twitchy or it can mean a sicker cohort, and no arithmetic here
 * can tell those apart. The point is to make the question get asked while the
 * answer is still recoverable.
 */

import type { CallSummary } from "../store/summaries.ts";
import type { CtcaeGrade } from "../clinical/safety.ts";

export interface DriftWindow {
  /** ISO date of the Monday this window starts on. */
  week: string;
  calls: number;
  completedCalls: number;
  /** Calls that got past identity verification. */
  verifiedCalls: number;
  events: number;
  /** Count per CTCAE grade, 1-5. */
  gradeDistribution: Record<string, number>;
  /** Mean grade over recorded events. The single number a shift shows up in. */
  meanGrade: number | null;
  seriousEvents: number;
  spontaneousShare: number | null;
  /** Escalations per completed call, and the split by who raised them. */
  escalationsPerCall: number | null;
  escalationsByUrgency: Record<string, number>;
  bySafetyNet: number;
  byAgent: number;
  /** Screen items answered per call that reached the screen. */
  screenCompletion: number | null;
  screenPositiveRate: number | null;
  provenanceRejections: number;
}

/** The Monday of the week a timestamp falls in, as YYYY-MM-DD. */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day),
  );
  return monday.toISOString().slice(0, 10);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function summariseWindow(week: string, calls: CallSummary[]): DriftWindow {
  const events = calls.flatMap((c) => c.events);
  const escalations = calls.flatMap((c) => c.escalations);
  const completed = calls.filter((c) => c.completedAt !== null);

  const gradeDistribution: Record<string, number> = {};
  for (const grade of [1, 2, 3, 4, 5] as CtcaeGrade[]) {
    gradeDistribution[String(grade)] = events.filter((e) => e.grade === grade).length;
  }

  const escalationsByUrgency: Record<string, number> = {};
  for (const e of escalations) {
    escalationsByUrgency[e.urgency] = (escalationsByUrgency[e.urgency] ?? 0) + 1;
  }

  // Only calls that actually reached the screen belong in a completion rate.
  // Counting a call that ended at verification as 0 of 9 would report the screen
  // getting worse every time somebody failed to verify.
  const reachedScreen = calls.filter((c) => c.screenAnswered > 0);

  return {
    week,
    calls: calls.length,
    completedCalls: completed.length,
    verifiedCalls: calls.filter((c) => c.verified).length,
    events: events.length,
    gradeDistribution,
    meanGrade: mean(events.map((e) => e.grade)),
    seriousEvents: events.filter((e) => e.serious).length,
    spontaneousShare: events.length
      ? events.filter((e) => e.spontaneous).length / events.length
      : null,
    // Over every call, not only completed ones. The numerator counted
    // escalations from dropped calls too, and an emergency ends a call early —
    // so the rate rose with the drop rate rather than with the instrument.
    escalationsPerCall: calls.length ? escalations.length / calls.length : null,
    escalationsByUrgency,
    bySafetyNet: escalations.filter((e) => e.triggeredBy === "safety_net").length,
    byAgent: escalations.filter((e) => e.triggeredBy === "agent").length,
    screenCompletion: mean(reachedScreen.map((c) => c.screenAnswered)),
    screenPositiveRate: reachedScreen.length
      ? reachedScreen.filter((c) => c.screenPositive > 0).length / reachedScreen.length
      : null,
    provenanceRejections: calls.reduce((n, c) => n + c.provenanceRejections, 0),
  };
}

export function byWeek(calls: CallSummary[]): DriftWindow[] {
  const buckets = new Map<string, CallSummary[]>();
  for (const call of calls) {
    const week = weekOf(call.createdAt);
    const bucket = buckets.get(week);
    if (bucket) bucket.push(call);
    else buckets.set(week, [call]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, bucket]) => summariseWindow(week, bucket));
}

/**
 * How far a number moved, and whether the sample is big enough to mean it.
 *
 * The second half is the part that matters. Two calls one week and thirty the
 * next produce a dramatic-looking shift in every rate here, and reporting that
 * as drift trains people to ignore the report.
 */
export interface Shift {
  metric: string;
  from: number | null;
  to: number | null;
  delta: number | null;
  /** False when either window is too small for the comparison to say anything. */
  meaningful: boolean;
}

export const MIN_CALLS_FOR_COMPARISON = 5;

export function compare(previous: DriftWindow, current: DriftWindow): Shift[] {
  const enough =
    previous.calls >= MIN_CALLS_FOR_COMPARISON &&
    current.calls >= MIN_CALLS_FOR_COMPARISON;

  const pick: [string, number | null, number | null][] = [
    ["mean CTCAE grade", previous.meanGrade, current.meanGrade],
    ["escalations per call", previous.escalationsPerCall, current.escalationsPerCall],
    ["screen items answered", previous.screenCompletion, current.screenCompletion],
    ["screen positive rate", previous.screenPositiveRate, current.screenPositiveRate],
    ["spontaneous share", previous.spontaneousShare, current.spontaneousShare],
  ];

  return pick.map(([metric, from, to]) => ({
    metric,
    from,
    to,
    delta: from === null || to === null ? null : to - from,
    meaningful: enough && from !== null && to !== null,
  }));
}
