import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/agent/tools.ts";
import {
  __setSessionStore,
  getSessionStore,
  RESUME_WINDOW_MS,
} from "../lib/store/session-store.ts";
import type { CheckInSession } from "../lib/store/session.ts";
import { SUBJECTS } from "../lib/clinical/protocol.ts";

/** Forces the in-memory store so these run without a database. */
beforeEach(() => {
  __setSessionStore(null);
  delete process.env.DATABASE_URL;
});

const VERIFY = { subject_id: "001-0042", date_of_birth: "1958-03-11" };
const SPOKEN = ["I've been very tired, I couldn't shower Tuesday"];

const AE = {
  verbatim_term: "I've been very tired",
  coded_term: "Fatigue",
  onset_description: "this week",
  ongoing: true,
  grade: 2,
  grade_rationale: "Cut back on errands.",
  limits_self_care: false,
  spontaneous: true,
};

async function callWith(utterances: string[]): Promise<CheckInSession> {
  const session = await getSessionStore().create();
  session.subjectUtterances = [...utterances];
  return session;
}

// --- 1.4 mid-call recovery ---------------------------------------------------

test("a dropped call's captures are carried into the redial", async () => {
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  await executeTool(first, "record_adverse_event", AE);
  await getSessionStore().save(first);
  assert.equal(first.adverseEvents.length, 1);

  // The line drops. The subject calls back.
  const second = await callWith(SPOKEN);
  const outcome = await executeTool(second, "verify_subject", VERIFY);

  assert.equal(second.adverseEvents.length, 1, "the event must come forward");
  assert.equal(second.adverseEvents[0].codedTerm, "Fatigue");
  assert.match(JSON.stringify(outcome.result), /resumed/);
  assert.ok(
    second.audit.all().some((e) => e.action === "CALL_RESUMED"),
    "the transfer must be auditable",
  );
});

test("the earlier session is locked so its content cannot be claimed twice", async () => {
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  await executeTool(first, "record_adverse_event", AE);
  await getSessionStore().save(first);

  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);

  const reloaded = await getSessionStore().get(first.id);
  assert.ok(reloaded?.completedAt, "the source must be closed to further writes");
  assert.ok(
    reloaded?.audit.all().some((e) => e.action === "SESSION_SUPERSEDED"),
    "and say why",
  );

  // A third call finds nothing to resume — the record moved, it was not copied.
  const third = await callWith(SPOKEN);
  const outcome = await executeTool(third, "verify_subject", VERIFY);
  assert.equal(third.adverseEvents.length, 1, "resumes the second, not the first");
  assert.match(JSON.stringify(outcome.result), /resumed/);
});

test("prior speech comes forward, so quoting it is still allowed", async () => {
  // Without the transcript, the provenance gate would refuse a quote of
  // something the subject said before the line dropped.
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  await getSessionStore().save(first);

  const second = await callWith([]);
  await executeTool(second, "verify_subject", VERIFY);
  assert.ok(
    second.subjectUtterances.includes(SPOKEN[0]),
    "earlier speech must be quotable after a redial",
  );
});

test("a stale session is not resumed", async () => {
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  await executeTool(first, "record_adverse_event", AE);
  // Older than the window: an abandoned check-in, not a dropped call.
  first.createdAt = new Date(Date.now() - RESUME_WINDOW_MS - 60_000).toISOString();
  await getSessionStore().save(first);

  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);
  assert.equal(second.adverseEvents.length, 0, "two visits must not merge");
});

test("a session marked not-resumable is never claimed", async () => {
  const first = await callWith(SPOKEN);
  first.resumable = false;
  await executeTool(first, "verify_subject", VERIFY);
  await executeTool(first, "record_adverse_event", AE);
  await getSessionStore().save(first);

  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);
  assert.equal(second.adverseEvents.length, 0);
});

test("another subject's session is never resumed", async () => {
  const other = await callWith(SPOKEN);
  await executeTool(other, "verify_subject", {
    subject_id: SUBJECTS[1].subjectId,
    date_of_birth: SUBJECTS[1].dateOfBirth,
  });
  await executeTool(other, "record_adverse_event", AE);
  await getSessionStore().save(other);

  const mine = await callWith(SPOKEN);
  await executeTool(mine, "verify_subject", VERIFY);
  assert.equal(mine.adverseEvents.length, 0, "records must not cross subjects");
});

// --- 1.5 idempotency ---------------------------------------------------------

test("replaying a turn produces no duplicate event", async () => {
  const session = await callWith([
    "I've been very tired and I started taking ibuprofen for my knee",
  ]);
  await executeTool(session, "verify_subject", VERIFY);

  for (let i = 0; i < 3; i++) {
    await executeTool(session, "record_adverse_event", AE);
    await executeTool(session, "record_concomitant_medication", {
      name: "Ibuprofen",
      indication_verbatim: "for my knee",
      started_description: "this week",
    });
    await executeTool(session, "escalate_to_coordinator", {
      urgency: "routine",
      reason: "Grade 2 fatigue noted.",
      related_event_ids: [],
    });
  }

  assert.equal(session.adverseEvents.length, 1, "one event");
  assert.equal(session.conMeds.length, 1, "one medication");
  assert.equal(
    session.escalations.filter((e) => e.triggeredBy === "agent").length,
    1,
    "one page, not three",
  );
  assert.deepEqual(session.audit.verifyChain(), { valid: true });
});

test("a genuinely different escalation is still raised", async () => {
  const session = await callWith(SPOKEN);
  await executeTool(session, "verify_subject", VERIFY);
  await executeTool(session, "escalate_to_coordinator", {
    urgency: "routine",
    reason: "Grade 2 fatigue noted.",
    related_event_ids: [],
  });
  await executeTool(session, "escalate_to_coordinator", {
    urgency: "urgent",
    reason: "Subject now reports a fever.",
    related_event_ids: [],
  });
  assert.equal(
    session.escalations.filter((e) => e.triggeredBy === "agent").length,
    2,
    "deduplication must not swallow a new event",
  );
});

test("a medication re-reported after a redial updates rather than duplicates", async () => {
  const first = await callWith(["I started taking ibuprofen for my knee"]);
  await executeTool(first, "verify_subject", VERIFY);
  await executeTool(first, "record_concomitant_medication", {
    name: "Ibuprofen",
    indication_verbatim: "for my knee",
    started_description: "this week",
  });
  await getSessionStore().save(first);

  const second = await callWith(["I started taking ibuprofen for my knee"]);
  await executeTool(second, "verify_subject", VERIFY);
  // The subject repeats it, not knowing the first call recorded it.
  await executeTool(second, "record_concomitant_medication", {
    name: "ibuprofen",
    indication_verbatim: "for my knee",
    started_description: "this week",
  });
  assert.equal(second.conMeds.length, 1, "case and redial must not duplicate");
});
