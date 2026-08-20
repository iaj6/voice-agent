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
    updatedAt: new Date().toISOString(),
    status: "in_progress" as const,
    subject: SUBJECTS[0],
    verificationAttempts: 1,
    messages: [],
    subjectUtterances: utterances,
    provenanceRejections: 0,
    refusedQuotes: [],
    resumable: true,
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

test("a fabricated quote never reaches the record", async () => {
  // The exact quote that was written for real, from the agent's own hallucinated
  // patient reply. The graded event is the agent's clinical judgement and is
  // kept for a human to review; the invented words are not.
  const session = sessionWith(SPOKEN);
  await executeTool(session, "record_adverse_event", FABRICATED_AE);

  const written = JSON.stringify(session.adverseEvents);
  assert.ok(
    !written.includes("kitchen") && !written.includes("sideways"),
    "no invented words may appear anywhere in the record",
  );
});

test("the refusal is recorded, not silent", async () => {
  // A refused quote is evidence the model tried to enter unfounded content.
  // Dropping it silently discards the only signal the call has gone wrong.
  const session = sessionWith(SPOKEN);
  await executeTool(session, "record_adverse_event", FABRICATED_AE);

  const refusals = session.audit
    .all()
    .filter((e) => e.action === "QUOTE_REFUSED_UNFOUNDED");
  assert.equal(refusals.length, 1);
  assert.equal(session.provenanceRejections, 1);
  assert.deepEqual(session.audit.verifyChain(), { valid: true });
});

test("a genuine capture passes the gate untouched", async () => {
  const session = sessionWith(SPOKEN);
  const outcome = await executeTool(session, "record_adverse_event", {
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

test("a doubtful quote never costs the structured data beside it", async () => {
  // Regression, HIGH. The gate used to abort the whole tool call, so a red-flag
  // "yes" was discarded whenever the agent's paraphrase of it scored badly and
  // no coordinator was paged — silently undoing the correction-escalation fix.
  // The quote is the doubtful part; the answer is the part with a clock on it.
  const session = sessionWith([
    "Yeah, my temperature was up around 103 on Sunday",
  ]);

  const outcome = await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    // Digits-versus-words, an ordinary transcription mismatch. Scores badly.
    verbatim: "my temperature hit a hundred and three on Sunday night",
  });

  assert.notEqual(outcome.isError, true, "the call must succeed");
  assert.ok(session.safetyScreen, "the answer must be recorded");
  assert.equal(session.safetyScreen.items[0].answer, true);
  assert.equal(
    session.safetyScreen.items[0].verbatim,
    null,
    "the doubtful quote is dropped",
  );
  assert.equal(session.escalations.length, 1, "the red flag must still page someone");
  assert.equal(session.escalations[0].triggeredBy, "safety_net");
  assert.equal(session.status, "escalated");
});

test("adherence keeps its dose count when only the reason is doubtful", async () => {
  const session = sessionWith(["I was away visiting family last week"]);
  const outcome = await executeTool(session, "record_adherence", {
    doses_missed: 2,
    reason_verbatim: "I was at my brother's wedding in Scotland",
  });
  assert.notEqual(outcome.isError, true);
  assert.equal(session.adherence?.dosesMissedSinceLastCheckIn, 2);
  assert.equal(session.adherence?.reasonVerbatim, null);
});

test("a concomitant medication keeps its name when the indication is doubtful", async () => {
  // Losing the drug name because the stated reason was loosely quoted is an
  // interaction-check gap with no clinical justification.
  const session = sessionWith(["My knee's been sore since I fell last week"]);
  const outcome = await executeTool(session, "record_concomitant_medication", {
    name: "Ibuprofen",
    indication_verbatim: "for the crushing headaches every morning",
    started_description: "last week",
  });
  assert.notEqual(outcome.isError, true);
  assert.equal(session.conMeds.length, 1);
  assert.equal(session.conMeds[0].name, "Ibuprofen");
  assert.equal(session.conMeds[0].indicationVerbatim, "");
});

test("an adverse event is still recorded, without the invented quote", async () => {
  const session = sessionWith(SPOKEN);
  const outcome = await executeTool(session, "record_adverse_event", FABRICATED_AE);
  assert.notEqual(outcome.isError, true);
  assert.equal(session.adverseEvents.length, 1, "the graded event survives");
  assert.equal(
    session.adverseEvents[0].verbatimTerm,
    "",
    "but carries no invented verbatim",
  );
});

test("identical retries are not counted as separate fabrications", async () => {
  // The model retries a refused call. With MAX_TOOL_ITERATIONS at 8, three
  // identical retries inside one turn used to cross the escalation threshold
  // and page a coordinator about a call that was fine.
  const session = sessionWith(SPOKEN);
  for (let i = 0; i < 4; i++) {
    await executeTool(session, "record_adverse_event", FABRICATED_AE);
  }
  assert.equal(session.provenanceRejections, 1, "one distinct fabrication");
  assert.equal(
    session.escalations.filter((e) => e.category === "Unfounded record content").length,
    0,
    "a retry loop must not page anyone",
  );
});

test("distinct fabrications still escalate", async () => {
  const session = sessionWith(SPOKEN);
  for (const term of ["helicopters overhead", "the purple curtains", "my third elbow"]) {
    await executeTool(session, "record_adverse_event", {
      ...FABRICATED_AE,
      coded_term: term,
      verbatim_term: `something about ${term} that was never said aloud`,
    });
  }
  assert.equal(session.provenanceRejections, 3);
  const escalation = session.escalations.find(
    (e) => e.category === "Unfounded record content",
  );
  assert.ok(escalation, "three distinct fabrications must reach a coordinator");
  assert.equal(session.status, "escalated");
});
