/**
 * Reconciliation against the eDiary, which is how the pilot answers its central
 * question. The matcher decides what counts as agreement, so it decides what the
 * study concludes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_WINDOW_DAYS,
  reconcile,
  sameSymptom,
  toCsv,
} from "../lib/observability/reconcile.ts";
import type { AgentEvent, EDiaryEntry } from "../lib/observability/reconcile.ts";

const event = (over: Partial<AgentEvent> = {}): AgentEvent => ({
  subjectId: "001-0042",
  sessionId: "sess-1",
  codedTerm: "Fatigue",
  verbatimTerm: "worn out all week",
  grade: 1 as never,
  recordedAt: "2026-09-02T10:00:00.000Z",
  spontaneous: false,
  ...over,
});

const entry = (over: Partial<EDiaryEntry> = {}): EDiaryEntry => ({
  subjectId: "001-0042",
  term: "Fatigue",
  date: "2026-09-02",
  grade: 1,
  ...over,
});

test("the everyday word and the coded term are the same symptom", () => {
  // A participant types "tiredness"; the agent codes "Fatigue". Counting that as
  // a disagreement would make the agent look like it missed an event it caught.
  assert.ok(sameSymptom("Fatigue", "tiredness"));
  assert.ok(sameSymptom("Peripheral sensory neuropathy", "pins and needles"));
  assert.ok(sameSymptom("Nausea", "feeling sick"));
});

test("different symptoms do not match, however tempting", () => {
  // Over-matching reports agreement that was never there, which is the failure
  // that would make the whole exercise worthless.
  assert.ok(!sameSymptom("Fatigue", "Nausea"));
  assert.ok(!sameSymptom("Headache", "Rash"));
  assert.ok(!sameSymptom("Vomiting", "Diarrhea"));
});

test("the same event recorded on nearby days is one event", () => {
  const { summary } = reconcile(
    [event({ recordedAt: "2026-09-04T10:00:00.000Z" })],
    [entry({ date: "2026-09-02" })],
  );
  assert.equal(summary.matched, 1);
});

test("records too far apart are two events, not one", () => {
  // Beyond the window they span two weekly check-ins, and merging those merges
  // what were genuinely two reports.
  const far = new Date(Date.parse("2026-09-02") + (MATCH_WINDOW_DAYS + 2) * 86_400_000);
  const { summary } = reconcile(
    [event({ recordedAt: far.toISOString() })],
    [entry({ date: "2026-09-02" })],
  );
  assert.equal(summary.matched, 0);
  assert.equal(summary.agentOnly, 1);
  assert.equal(summary.ediaryOnly, 1);
});

test("one eDiary entry cannot satisfy two agent events", () => {
  // Without claiming, a single typed entry would match every similar event the
  // agent captured and inflate agreement.
  const { summary } = reconcile(
    [event({ sessionId: "a" }), event({ sessionId: "b" })],
    [entry()],
  );
  assert.equal(summary.matched, 1);
  assert.equal(summary.agentOnly, 1);
});

test("both systems have it at different severities", () => {
  const { rows, summary } = reconcile([event({ grade: 3 as never })], [entry({ grade: 1 })]);
  assert.equal(summary.gradeMismatches, 1);
  assert.equal(summary.matched, 0, "a grade disagreement is not agreement");
  assert.equal(rows[0].agentGrade, 3);
  assert.equal(rows[0].ediaryGrade, 1);
});

test("an eDiary with no grades is not treated as agreeing", () => {
  // Many eDiaries collect severity on their own scale or not at all. Absent is
  // unknown, and unknown must not read as a match on severity.
  const { rows, summary } = reconcile([event({ grade: 3 as never })], [entry({ grade: null })]);
  assert.equal(summary.matched, 1, "the event still matches");
  assert.equal(rows[0].ediaryGrade, null, "but severity is reported as unknown");
});

test("events for different participants never match each other", () => {
  const { summary } = reconcile([event({ subjectId: "001-0042" })], [entry({ subjectId: "001-0055" })]);
  assert.equal(summary.matched, 0);
  assert.equal(summary.agentOnly, 1);
  assert.equal(summary.ediaryOnly, 1);
});

test("every unmatched row leaves the cause for a human", () => {
  // The exit criteria ask for disagreements "categorised by cause", and the tool
  // that produced the disagreement is the last thing that should guess at it.
  const { rows } = reconcile([event({ codedTerm: "Rash" })], [entry({ term: "Headache" })]);
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.equal(row.cause, "");
});

test("the nearest entry wins, so one agreement is not split into two disagreements", () => {
  // A participant logs Fatigue grade 1 on Sunday and grade 3 on Tuesday. First-fit
  // matching gave the agent's Tuesday grade-3 event the Sunday row — one
  // fabricated grade disagreement, plus the true pair reported as eDiary-only,
  // from a case where both systems agreed exactly.
  const { summary } = reconcile(
    [event({ grade: 3 as never, recordedAt: "2026-09-04T10:00:00.000Z" })],
    [
      entry({ date: "2026-09-02", grade: 1 }),
      entry({ date: "2026-09-04", grade: 3 }),
    ],
  );
  assert.equal(summary.matched, 1, "the same-day, same-grade entry was chosen");
  assert.equal(summary.gradeMismatches, 0, "no fabricated disagreement");
  assert.equal(summary.ediaryOnly, 1, "the Sunday entry is genuinely unmatched");
});

test("with two equally close entries, the one that agrees on grade wins", () => {
  const { summary } = reconcile(
    [event({ grade: 3 as never, recordedAt: "2026-09-02T12:00:00.000Z" })],
    [entry({ date: "2026-09-02", grade: 1 }), entry({ date: "2026-09-02", grade: 3 })],
  );
  assert.equal(summary.matched, 1);
  assert.equal(summary.gradeMismatches, 0);
});

test("agreement is reported as a floor, and as nothing when there is nothing", () => {
  assert.equal(reconcile([], []).summary.agreementFloor, null);
  const { summary } = reconcile([event()], [entry()]);
  assert.equal(summary.agreementFloor, 1);
});

test("the csv survives a verbatim quote containing a comma and a quote mark", () => {
  // Participants speak in commas. A naive join turns one row into two and
  // silently shifts every column after it.
  const { rows } = reconcile(
    [event({ verbatimTerm: 'it was "bad", really bad' })],
    [entry()],
  );
  const csv = toCsv(rows);
  assert.equal(csv.split("\n").length, 2, "one header, one row");
  assert.ok(csv.includes('"it was ""bad"", really bad"'));
});
