/**
 * Drift monitoring, which exists because a check-in agent degrades without
 * failing. The arithmetic decides whether anyone gets told, so it is worth being
 * sure the denominators are the ones a clinician would expect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byWeek,
  compare,
  MIN_CALLS_FOR_COMPARISON,
  summariseWindow,
  weekOf,
} from "../lib/observability/drift.ts";
import { beforeSyntheticFlag } from "../lib/store/summaries.ts";
import type { CallSummary } from "../lib/store/summaries.ts";

function call(overrides: Partial<CallSummary> = {}): CallSummary {
  return {
    id: crypto.randomUUID(),
    synthetic: false,
    createdAt: "2026-09-02T10:00:00.000Z",
    completedAt: "2026-09-02T10:08:00.000Z",
    status: "completed",
    verified: true,
    events: [],
    escalations: [],
    screenAnswered: 9,
    screenPositive: 0,
    provenanceRejections: 0,
    dosesMissed: null,
    ...overrides,
  };
}

const event = (grade: number, extra = {}) => ({
  grade: grade as never,
  serious: false,
  spontaneous: false,
  limitsSelfCare: false,
  ...extra,
});

test("weeks start on Monday, so a Sunday call belongs to the week before", () => {
  // 2026-09-06 is a Sunday. Bucketing it forward would move a weekend call into
  // the next window and make two adjacent weeks both look wrong.
  assert.equal(weekOf("2026-09-06T23:00:00Z"), "2026-08-31");
  assert.equal(weekOf("2026-09-07T00:30:00Z"), "2026-09-07");
});

test("a call that ended at verification does not drag the screen rate down", () => {
  // Counting it as 0 of 9 answered would report the screen degrading every time
  // somebody failed to verify, which is a different problem entirely.
  const window = summariseWindow("2026-09-02", [
    call({ screenAnswered: 9 }),
    call({ screenAnswered: 0, verified: false, status: "awaiting_verification" }),
  ]);
  assert.equal(window.screenCompletion, 9, "averaged over calls that reached it");
  assert.equal(window.calls, 2, "but both calls still count");
  assert.equal(window.verifiedCalls, 1);
});

test("grade distribution and mean describe the same events", () => {
  const window = summariseWindow("2026-09-02", [
    call({ events: [event(1), event(3), event(3)] }),
  ]);
  assert.deepEqual(window.gradeDistribution, { "1": 1, "2": 0, "3": 2, "4": 0, "5": 0 });
  assert.equal(window.meanGrade, 7 / 3);
  assert.equal(window.events, 3);
});

test("escalations are attributed to whoever raised them", () => {
  // The deterministic net and the model are different controls, and a shift in
  // the ratio is the interesting signal — a net doing less work means either
  // the population changed or the net stopped matching.
  const window = summariseWindow("2026-09-02", [
    call({
      escalations: [
        { urgency: "emergency", triggeredBy: "safety_net", category: "bleeding", createdAt: "x" },
        { urgency: "routine", triggeredBy: "agent", category: null, createdAt: "x" },
      ],
    }),
  ]);
  assert.equal(window.bySafetyNet, 1);
  assert.equal(window.byAgent, 1);
  assert.equal(window.escalationsPerCall, 2);
  assert.deepEqual(window.escalationsByUrgency, { emergency: 1, routine: 1 });
});

test("a shift across thin weeks is reported as not comparable, not as drift", () => {
  // Two calls one week and thirty the next produces a dramatic-looking move in
  // every rate. Calling that drift trains people to ignore the report.
  const thin = summariseWindow("2026-08-31", [call({ events: [event(1)] })]);
  const fat = summariseWindow("2026-09-07", [
    ...Array.from({ length: MIN_CALLS_FOR_COMPARISON }, () =>
      call({ events: [event(4)] }),
    ),
  ]);
  const shifts = compare(thin, fat);
  const grade = shifts.find((s) => s.metric === "mean CTCAE grade")!;
  assert.equal(grade.meaningful, false, "one call is not a week");
  assert.equal(grade.delta, 3, "the number is still reported, just not believed");
});

test("a shift across two adequate weeks is comparable", () => {
  const enough = (grade: number) =>
    summariseWindow("w", Array.from({ length: MIN_CALLS_FOR_COMPARISON }, () =>
      call({ events: [event(grade)] }),
    ));
  const grade = compare(enough(2), enough(3)).find(
    (s) => s.metric === "mean CTCAE grade",
  )!;
  assert.equal(grade.meaningful, true);
  assert.equal(grade.delta, 1);
});

test("calls are bucketed into the week they happened in", () => {
  const windows = byWeek([
    call({ createdAt: "2026-08-31T09:00:00Z" }),
    call({ createdAt: "2026-09-07T09:00:00Z" }),
    call({ createdAt: "2026-09-08T09:00:00Z" }),
  ]);
  assert.deepEqual(
    windows.map((w) => [w.week, w.calls]),
    [
      ["2026-08-31", 1],
      ["2026-09-07", 2],
    ],
  );
});

test("calls from before the synthetic flag worked are not treated as real", () => {
  // The flag failed open until a71be42, so everything stored before it reads as
  // a real participant. There were no participants — the study has enrolled
  // nobody — and counting hundreds of harness calls as the baseline would make
  // the first real week look like a catastrophic shift.
  assert.equal(beforeSyntheticFlag("2026-08-20T12:00:00Z"), true);
  assert.equal(beforeSyntheticFlag("2026-08-21T12:00:00Z"), true);
  assert.equal(beforeSyntheticFlag("2026-08-22T12:00:00Z"), false);
});
