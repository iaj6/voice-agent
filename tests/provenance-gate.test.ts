import { test } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/agent/tools.ts";
import { AuditTrail } from "../lib/store/audit.ts";
import { SUBJECTS } from "../lib/clinical/protocol.ts";
import type { CheckInSession } from "../lib/store/session.ts";

/**
 * A session shaped like a real one, mid-call, with a known subject transcript.
 * Built here rather than through the store so the gate can be exercised without
 * a database.
 */
function sessionWith(utterances: string[]): CheckInSession {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: new Date().toISOString(),
    status: "in_progress" as const,
    subject: SUBJECTS[0],
    verificationAttempts: 1,
    messages: [],
    subjectUtterances: utterances,
    provenanceRejections: 0,
    adverseEvents: [],
    safetyScreen: null,
    adherence: null,
    conMeds: [],
    escalations: [],
    solicitedReviewed: [],
    summary: null,
    completedAt: null,
    audit: new AuditTrail("11111111-1111-4111-8111-111111111111"),
  };
}

const SPOKEN = [
  "I've been very tired, I couldn't shower Tuesday, my daughter had to help me",
];

const FABRICATED_AE = {
  verbatim_term: "the kitchen sort of went sideways on me, I had to grab the counter",
  coded_term: "Dizziness",
  onset_description: "this week",
  ongoing: true,
  grade: 2,
  grade_rationale: "Reported unsteadiness.",
  limits_self_care: false,
  spontaneous: true,
};

test("a fabricated adverse event never reaches the record", () => {
  // The exact entry that was written for real: an event invented from the
  // agent's own hallucinated patient reply.
  const session = sessionWith(SPOKEN);
  const outcome = executeTool(session, "record_adverse_event", FABRICATED_AE);

  assert.equal(outcome.isError, true);
  assert.equal(session.adverseEvents.length, 0, "nothing may be written");
  assert.match(JSON.stringify(outcome.result), /Refused/);
});

test("the refusal is recorded, not silent", () => {
  // A rejected write is evidence the model tried to enter unfounded content.
  // Dropping it silently discards the only signal the call has gone wrong.
  const session = sessionWith(SPOKEN);
  executeTool(session, "record_adverse_event", FABRICATED_AE);

  const refusals = session.audit
    .all()
    .filter((e) => e.action === "WRITE_REFUSED_UNFOUNDED");
  assert.equal(refusals.length, 1);
  assert.equal(session.provenanceRejections, 1);
  assert.deepEqual(session.audit.verifyChain(), { valid: true });
});

test("a genuine capture passes the gate untouched", () => {
  const session = sessionWith(SPOKEN);
  const outcome = executeTool(session, "record_adverse_event", {
    ...FABRICATED_AE,
    verbatim_term: "very tired, couldn't shower Tuesday, daughter had to help",
    coded_term: "Fatigue",
    grade: 3,
  });

  assert.notEqual(outcome.isError, true);
  assert.equal(session.adverseEvents.length, 1);
  assert.equal(session.adverseEvents[0].codedTerm, "Fatigue");
  assert.equal(session.provenanceRejections, 0);
});

test("repeated unfounded writes escalate to a human", () => {
  // One is a slip. Three means the conversation the agent believes it is having
  // is not the one taking place, and the whole call is suspect.
  const session = sessionWith(SPOKEN);
  for (let i = 0; i < 3; i++) {
    executeTool(session, "record_adverse_event", {
      ...FABRICATED_AE,
      coded_term: `Invented ${i}`,
      verbatim_term: `a thing that was never said number ${i} about helicopters`,
    });
  }

  assert.equal(session.provenanceRejections, 3);
  assert.equal(session.adverseEvents.length, 0);
  const escalation = session.escalations.find(
    (e) => e.category === "Unfounded record content",
  );
  assert.ok(escalation, "three refusals must reach a coordinator");
  assert.equal(escalation.triggeredBy, "safety_net");
  assert.equal(session.status, "escalated");
});

test("every verbatim writer is gated, not just adverse events", () => {
  const session = sessionWith(SPOKEN);

  const adherence = executeTool(session, "record_adherence", {
    doses_missed: 2,
    reason_verbatim: "I was away at my brother's wedding in Scotland",
  });
  assert.equal(adherence.isError, true, "adherence reason must be gated");
  assert.equal(session.adherence, null);

  const conmed = executeTool(session, "record_concomitant_medication", {
    name: "Ibuprofen",
    indication_verbatim: "for the pain in my knee after the fall",
    started_description: "last week",
  });
  assert.equal(conmed.isError, true, "con-med indication must be gated");
  assert.equal(session.conMeds.length, 0);

  const screen = executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: "my temperature hit a hundred and three on Sunday night",
  });
  assert.equal(screen.isError, true, "screen verbatim must be gated");
  assert.equal(session.safetyScreen, null);
});
