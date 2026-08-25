/**
 * The review queue's ordering, which decides what a coordinator sees first and
 * therefore what gets missed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueue, reasonsFor, SCREEN_ITEM_COUNT } from "../lib/review/queue.ts";
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
    screenAnswered: SCREEN_ITEM_COUNT,
    screenPositive: 0,
    provenanceRejections: 0,
    dosesMissed: null,
    ...overrides,
  };
}

const escalation = (urgency: string, by: "agent" | "safety_net" = "agent") => ({
  urgency: urgency as never,
  triggeredBy: by,
  category: null,
  createdAt: "2026-09-02T10:03:00.000Z",
});

test("an uneventful call is not in the queue at all", () => {
  // A queue containing every call is a queue nobody works.
  assert.equal(buildQueue([call()]).length, 0);
  assert.equal(buildQueue([call()], { includeUnflagged: true }).length, 1);
});

test("an emergency outranks everything else", () => {
  const queue = buildQueue([
    call({ escalations: [escalation("routine")] }),
    call({ events: [{ grade: 4 as never, serious: false, spontaneous: false, limitsSelfCare: true }] }),
    call({ escalations: [escalation("emergency", "safety_net")] }),
  ]);
  assert.equal(queue[0].reasons[0].kind, "emergency_escalation");
  assert.equal(queue[queue.length - 1].reasons[0].kind, "routine_escalation");
});

test("within a tier the oldest call is first", () => {
  // Ordering urgent calls newest-first buries the one that has waited longest,
  // which is the opposite of what a queue is for.
  const older = call({
    createdAt: "2026-09-02T08:00:00.000Z",
    escalations: [escalation("urgent")],
  });
  const newer = call({
    createdAt: "2026-09-02T11:00:00.000Z",
    escalations: [escalation("urgent")],
  });
  const queue = buildQueue([newer, older]);
  assert.equal(queue[0].call.id, older.id);
});

test("an agent inventing a quote outranks a routine symptom nobody has read", () => {
  // A refused quote is a fact about the instrument, not the participant. An
  // instrument attributing words nobody said is worse than an unread symptom.
  const queue = buildQueue([
    call({ escalations: [escalation("routine")] }),
    call({ provenanceRejections: 2 }),
  ]);
  assert.equal(queue[0].reasons[0].kind, "provenance_rejection");
});

test("a half-finished screen is flagged, but only when there was a screen", () => {
  const partial = reasonsFor(call({ screenAnswered: 4 }));
  assert.ok(partial.some((r) => r.kind === "incomplete_screen"));

  // The zero case is the worst version, not an exempt one: a completed record
  // with no screen at all. An earlier version skipped it and it was invisible.
  assert.ok(reasonsFor(call({ screenAnswered: 0 })).some((r) => r.kind === "incomplete_screen"));

  // A call that ended at verification never reached the screen. Flagging it as
  // an incomplete screen describes the wrong problem.
  const unverified = reasonsFor(
    call({ verified: false, screenAnswered: 0, status: "awaiting_verification" }),
  );
  assert.ok(!unverified.some((r) => r.kind === "incomplete_screen"));
  assert.ok(unverified.some((r) => r.kind === "unverified"));
});

test("a screen abandoned for an emergency is not flagged as incomplete", () => {
  // The agent is told to drop the script the moment it sees an emergency, so
  // flagging that as a partial screen teaches a coordinator to dismiss the
  // reason on exactly the calls where it would otherwise matter.
  const reasons = reasonsFor(
    call({ screenAnswered: 2, escalations: [escalation("emergency", "safety_net")] }),
  );
  assert.ok(!reasons.some((r) => r.kind === "incomplete_screen"));
  assert.ok(reasons.some((r) => r.kind === "emergency_escalation"));
});

test("many escalations of one urgency collapse into one reason", () => {
  const reasons = reasonsFor(
    call({
      escalations: [escalation("emergency"), escalation("emergency", "safety_net")],
    }),
  );
  assert.equal(reasons.filter((r) => r.kind === "emergency_escalation").length, 1);
  assert.match(reasons[0].detail, /2 emergency escalations/);
  assert.match(reasons[0].detail, /1 from the safety net/);
});

test("a call that never completed is flagged as dropped", () => {
  const reasons = reasonsFor(call({ completedAt: null, status: "in_progress" }));
  assert.ok(reasons.some((r) => r.kind === "dropped_call"));
});

test("reasons come back worst first, because that is the order they are shown in", () => {
  // The badge row is the coordinator's triage signal and is rendered in order,
  // so a call with a routine escalation and a serious event was leading with the
  // routine one.
  const reasons = reasonsFor(
    call({
      escalations: [escalation("routine")],
      events: [{ grade: 4 as never, serious: true, spontaneous: false, limitsSelfCare: true }],
    }),
  );
  assert.equal(reasons[0].kind, "serious_event");
  assert.equal(reasons[reasons.length - 1].kind, "routine_escalation");
});

test("a call carries every reason it has, not just the worst", () => {
  // The rank decides position; the coordinator still needs the whole list,
  // because "serious event" and "the agent invented a quote" are two different
  // things to do about the same call.
  const reasons = reasonsFor(
    call({
      escalations: [escalation("urgent")],
      events: [{ grade: 4 as never, serious: true, spontaneous: true, limitsSelfCare: true }],
      screenAnswered: 2,
      provenanceRejections: 1,
    }),
  );
  const kinds = reasons.map((r) => r.kind);
  assert.ok(kinds.includes("urgent_escalation"));
  assert.ok(kinds.includes("serious_event"));
  assert.ok(kinds.includes("high_grade_event"));
  assert.ok(kinds.includes("provenance_rejection"));
  assert.ok(kinds.includes("incomplete_screen"));
});
