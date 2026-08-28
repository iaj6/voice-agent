import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/agent/tools.ts";
import {
  __backdateForTest,
  __setSessionStore,
  getSessionStore,
  RESUME_IDLE_MS,
  RESUME_WINDOW_MS,
} from "../lib/store/session-store.ts";
import type { CheckInSession } from "../lib/store/session.ts";
import { SUBJECTS, PROTOCOL } from "../lib/clinical/protocol.ts";

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

/**
 * Ages a session past the idleness threshold so it reads as dropped.
 *
 * A session written to seconds ago is a call still in progress, and claiming one
 * locks a participant's live record out from under them. Tests have to say
 * explicitly which they mean.
 */
async function markAsDropped(session: CheckInSession) {
  await getSessionStore().save(session);
  __backdateForTest(session.id, RESUME_IDLE_MS + 5_000);
}

// --- 1.4 mid-call recovery ---------------------------------------------------

test("a dropped call's captures are carried into the redial", async () => {
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  await executeTool(first, "record_adverse_event", AE);
  await markAsDropped(first);
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
  await markAsDropped(first);

  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);
  await markAsDropped(second);

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
  await markAsDropped(first);

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
  await markAsDropped(first);

  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);
  assert.equal(second.adverseEvents.length, 0, "two visits must not merge");
});

test("a session marked not-resumable is never claimed", async () => {
  const first = await callWith(SPOKEN);
  first.resumable = false;
  await executeTool(first, "verify_subject", VERIFY);
  await executeTool(first, "record_adverse_event", AE);
  await markAsDropped(first);

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
  await markAsDropped(other);

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
  await markAsDropped(first);

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

// --- findings from the third review ------------------------------------------

test("a session still being written to is never claimed as dropped", async () => {
  // The worst failure this feature can produce: two live calls for one subject,
  // one locks the other, and every later write on the locked one is discarded.
  const live = await callWith(SPOKEN);
  await executeTool(live, "verify_subject", VERIFY);
  await getSessionStore().save(live); // written to just now — this call is live

  const other = await callWith(SPOKEN);
  await executeTool(other, "verify_subject", VERIFY);

  assert.equal(live.completedAt, null, "a live call must not be locked");
  assert.equal(other.adverseEvents.length, 0, "and nothing carried from it");
});

test("being locked out mid-call is loud, not silent", async () => {
  const session = await callWith(SPOKEN);
  await executeTool(session, "verify_subject", VERIFY);
  await getSessionStore().save(session);

  // Something else closes it while this call is still running.
  const store = getSessionStore();
  const stored = await store.get(session.id);
  assert.ok(stored);
  await store.supersede(stored, "some-other-session");

  await assert.rejects(
    () => store.save(session),
    /closed by another process/,
    "silent loss here is what save() was rewritten to eliminate",
  );
});

test("the carried record does not share structure with the closed one", async () => {
  // An emergency-tier screen answer once appeared inside a locked record with no
  // matching audit entry, because the carried objects were the same objects.
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  first.screenAsked = PROTOCOL.safetyScreen.map((i) => i.id);
  await executeTool(first, "record_safety_screen_item", {
    item_id: "fever",
    answer: false,
    verbatim: null,
  });
  await markAsDropped(first);

  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);
  second.screenAsked = PROTOCOL.safetyScreen.map((i) => i.id);
  await executeTool(second, "record_safety_screen_item", {
    item_id: "chest_or_breathing",
    answer: true,
    verbatim: null,
  });

  const closed = await getSessionStore().get(first.id);
  assert.ok(
    !closed?.safetyScreen?.items.some((i) => i.itemId === "chest_or_breathing"),
    "a closed record must not gain items after it closes",
  );
  assert.deepEqual(closed?.audit.verifyChain(), { valid: true });
});

test("the resume payload names what was answered, not just how many", async () => {
  // Counts alone force the agent to guess which screen items were asked, and
  // guessing protocol order skips a red-flag item that was never asked.
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  first.screenAsked = PROTOCOL.safetyScreen.map((i) => i.id);
  await executeTool(first, "record_safety_screen_item", {
    item_id: "fever",
    answer: false,
    verbatim: null,
  });
  await executeTool(first, "record_adverse_event", AE);
  await markAsDropped(first);

  const second = await callWith(SPOKEN);
  const outcome = await executeTool(second, "verify_subject", VERIFY);
  const payload = JSON.stringify(outcome.result);
  assert.match(payload, /fever/, "answered screen items must be named");
  assert.match(payload, /Fatigue/, "captured events must be named");
});

test("the fabrication counter survives a redial", async () => {
  // Two unfounded quotes before the drop and two after would otherwise never
  // reach the threshold a single continuous call would have crossed.
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  first.provenanceRejections = 2;
  first.refusedQuotes = ["verbatim_term:a", "verbatim_term:b"];
  await markAsDropped(first);

  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);
  assert.equal(second.provenanceRejections, 2);
  assert.equal(second.refusedQuotes.length, 2);
});

test("a duplicate emergency escalation still ends the call", async () => {
  // Returning a bare "continue" for a duplicate emergency told the agent to
  // carry on with a call the protocol says must end.
  const session = await callWith(SPOKEN);
  await executeTool(session, "verify_subject", VERIFY);
  const args = {
    urgency: "emergency",
    reason: "Subject reports chest pain and breathlessness.",
    related_event_ids: [],
  };
  await executeTool(session, "escalate_to_coordinator", args);
  const second = await executeTool(session, "escalate_to_coordinator", args);

  assert.match(JSON.stringify(second.result), /ended_early|emergency care/);
  // Either outcome is legitimate — suppressed because it was already delivered,
  // or retried because it never was — but both have to be on the record. A page
  // requested a second time is a fact about the call.
  assert.ok(
    session.audit
      .all()
      .some(
        (e) =>
          e.action === "ESCALATION_SUPPRESSED_DUPLICATE" ||
          e.action === "ESCALATION_DUPLICATE_REDELIVERED",
      ),
    "a page requested a second time left no trace",
  );
});

test("two events sharing a reason phrase are two escalations", async () => {
  const session = await callWith(SPOKEN);
  await executeTool(session, "verify_subject", VERIFY);
  await executeTool(session, "escalate_to_coordinator", {
    urgency: "urgent",
    reason: "Grade 3 event requires review.",
    related_event_ids: ["AE-001"],
  });
  await executeTool(session, "escalate_to_coordinator", {
    urgency: "urgent",
    reason: "Grade 3 event requires review.",
    related_event_ids: ["AE-002"],
  });
  assert.equal(
    session.escalations.filter((e) => e.triggeredBy === "agent").length,
    2,
    "the second event's link would otherwise never be recorded",
  );
});

/**
 * A safety-net escalation exists before the model has taken a turn.
 *
 * This is the shape that matters: the deterministic net fires on the subject's
 * first utterance, and over a phone line the date of birth and an emergency
 * arrive in one breath. Resume then runs inside verify_subject, on the same
 * turn, with an escalation already on the record.
 */
function escalateFromNet(session: CheckInSession, category: string) {
  const record = {
    id: `ESC-${String(session.escalations.length + 1).padStart(3, "0")}`,
    urgency: "emergency" as const,
    reason: `Deterministic safety rule fired on subject speech: ${category}`,
    relatedEventIds: [] as string[],
    triggeredBy: "safety_net" as const,
    category,
    createdAt: new Date().toISOString(),
    sponsorNotificationDeadline: null,
  };
  session.escalations.push(record);
  session.status = "escalated";
  session.audit.record({
    actor: "safety_net",
    action: "ESCALATED",
    entity: "Escalation",
    entityId: record.id,
    after: record,
    reason: "Rule-based escalation independent of model judgment.",
  });
  return record;
}

test("a safety-net escalation raised before verification survives the redial", async () => {
  const dropped = await callWith(SPOKEN);
  await executeTool(dropped, "verify_subject", VERIFY);
  await executeTool(dropped, "record_adverse_event", AE);
  await markAsDropped(dropped);

  // "March 11th 1958 — sorry, I've been coughing up blood since last night"
  const redial = await callWith(["March 11th 1958, I've been coughing up blood"]);
  const raised = escalateFromNet(redial, "Severe bleeding");
  await getSessionStore().save(redial);

  await executeTool(redial, "verify_subject", VERIFY);

  assert.ok(
    redial.escalations.some((e) => e.id === raised.id && e.triggeredBy === "safety_net"),
    "the redial's own emergency escalation was erased by the carry-forward",
  );
  assert.equal(redial.status, "escalated", "the session stopped being escalated");
  assert.equal(redial.adverseEvents.length, 1, "the prior call's record was not carried");
});

test("every ESCALATED audit entry names an escalation the record still holds", async () => {
  const dropped = await callWith(SPOKEN);
  await executeTool(dropped, "verify_subject", VERIFY);
  await executeTool(dropped, "escalate_to_coordinator", {
    urgency: "urgent",
    reason: "Grade 3 event requires review.",
    related_event_ids: [],
  });
  await markAsDropped(dropped);

  const redial = await callWith(["March 11th 1958, I've been coughing up blood"]);
  escalateFromNet(redial, "Severe bleeding");
  await getSessionStore().save(redial);
  await executeTool(redial, "verify_subject", VERIFY);

  const held = new Set(redial.escalations.map((e) => e.id));
  const orphans = redial.audit
    .all()
    .filter((e) => e.action === "ESCALATED")
    .map((e) => e.entityId)
    .filter((id) => id !== null && !held.has(id));

  assert.deepEqual(orphans, [], "the trail points at escalations the record lost");
  assert.equal(
    new Set(redial.escalations.map((e) => e.id)).size,
    redial.escalations.length,
    "two escalations share an id, so one page overwrites the other",
  );
});

test("a carried escalation still points at the event it was raised for", async () => {
  const dropped = await callWith(SPOKEN);
  await executeTool(dropped, "verify_subject", VERIFY);
  await executeTool(dropped, "record_adverse_event", AE);
  await executeTool(dropped, "escalate_to_coordinator", {
    urgency: "urgent",
    reason: "Fatigue limiting self-care.",
    related_event_ids: ["AE-001"],
  });
  await markAsDropped(dropped);

  const redial = await callWith(["March 11th 1958, I've been coughing up blood"]);
  escalateFromNet(redial, "Severe bleeding");
  await getSessionStore().save(redial);
  await executeTool(redial, "verify_subject", VERIFY);

  const carried = redial.escalations.find((e) => e.triggeredBy === "agent");
  assert.ok(carried, "the prior call's escalation was not carried");
  for (const id of carried.relatedEventIds) {
    assert.ok(
      redial.adverseEvents.some((e) => e.id === id),
      `carried escalation references ${id}, which is not in the merged record`,
    );
  }
});

test("nothing clinical is recorded before the subject is verified", async () => {
  const session = await callWith(SPOKEN);

  const adherence = await executeTool(session, "record_adherence", {
    doses_missed: 2,
    reason_verbatim: null,
  });
  const conMed = await executeTool(session, "record_concomitant_medication", {
    name: "Ondansetron",
    indication_verbatim: null,
    started_description: "Tuesday",
  });

  assert.equal(session.adherence, null, "adherence was recorded before verification");
  assert.equal(session.conMeds.length, 0, "a con-med was recorded before verification");
  assert.equal(adherence.isError, true);
  assert.equal(conMed.isError, true);
});

test("the baseline-conditions instruction is not lost on a resumed call", async () => {
  const dropped = await callWith(SPOKEN);
  await executeTool(dropped, "verify_subject", VERIFY);
  await executeTool(dropped, "record_adverse_event", AE);
  await markAsDropped(dropped);

  const redial = await callWith(SPOKEN);
  const out = await executeTool(redial, "verify_subject", VERIFY);
  const instruction = String(
    (out.result as Record<string, unknown>).instruction ?? "",
  );

  assert.ok((out.result as Record<string, unknown>).resumed, "this call did not resume");
  assert.match(
    instruction,
    /baseline conditions/i,
    "a resumed call is handed baseline_conditions with no instruction about them",
  );
  assert.match(instruction, /carried forward/i, "the resume instruction was lost");
});

test("a heartbeat keeps a quiet live call from being claimed", async () => {
  const live = await callWith(SPOKEN);
  await executeTool(live, "verify_subject", VERIFY);
  await markAsDropped(live); // silence long enough to look dropped

  // The subject was there all along — they just went to find their pill bottle.
  await getSessionStore().touch(live.id);

  const claimed = await getSessionStore().claimResumable(VERIFY.subject_id, "other");
  assert.equal(claimed, null, "a live call was claimed after a heartbeat");
});

test("a record cannot be superseded twice", async () => {
  const dropped = await callWith(SPOKEN);
  await executeTool(dropped, "verify_subject", VERIFY);
  await markAsDropped(dropped);

  const store = getSessionStore();
  const first = await store.claimResumable(VERIFY.subject_id, "successor-a");
  assert.ok(first, "nothing was claimed");
  await store.supersede(first, "successor-a");

  await assert.rejects(
    () => store.supersede(first, "successor-b"),
    /already closed/,
    "a closed record reported itself superseded a second time",
  );
});

test("a medication re-reported on a redial keeps its first capture time", async () => {
  const session = await callWith(SPOKEN);
  await executeTool(session, "verify_subject", VERIFY);
  await executeTool(session, "record_concomitant_medication", {
    name: "Ondansetron",
    indication_verbatim: null,
    started_description: "Tuesday",
  });
  const first = session.conMeds[0].recordedAt;

  await new Promise((r) => setTimeout(r, 5));
  await executeTool(session, "record_concomitant_medication", {
    name: "ondansetron",
    indication_verbatim: null,
    started_description: "a while back",
  });

  assert.equal(session.conMeds.length, 1, "the medication was duplicated");
  assert.equal(
    session.conMeds[0].recordedAt,
    first,
    "re-reporting moved the capture time forward, losing when it entered the record",
  );
});

test("a no-to-yes screen correction survives a redial", async () => {
  // The screen gate refuses an answer for a question that was never asked, and a
  // successor session starts with nothing asked. Without carrying screenAsked
  // forward, a subject who answered "no" on the dropped call and corrects to
  // "yes" on the redial is refused — the single most important correction they
  // can make, blocked by the guard added to stop fabrication.
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  first.screenAsked = ["chest_or_breathing"];
  await executeTool(first, "record_safety_screen_item", {
    item_id: "chest_or_breathing",
    answer: false,
    verbatim: null,
  });
  await markAsDropped(first);

  // The redial: the agent has not re-asked anything yet.
  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);
  assert.ok(
    second.screenAsked.includes("chest_or_breathing"),
    "the redial forgot which questions had already been put to the subject",
  );

  const corrected = await executeTool(second, "record_safety_screen_item", {
    item_id: "chest_or_breathing",
    answer: true,
    verbatim: null,
  });
  assert.ok(
    !/has not been asked/.test(String((corrected.result as Record<string, unknown>).error ?? "")),
    "the correction was refused on the redial",
  );
  assert.equal(
    second.safetyScreen?.items.find((i) => i.itemId === "chest_or_breathing")?.answer,
    true,
    "the correction did not land",
  );
});

test("an asked-but-unanswered item is not carried forward as asked", async () => {
  // screenAsked records that the agent *spoke* the prompt, not that anyone
  // answered. Carrying it forward wholesale meant a call that dropped between
  // the question and the answer let the successor record an answer the
  // participant never gave — a red-flag screen item made from nothing, which is
  // the fabrication this gate exists to stop, reintroduced by the fix for a
  // different hole in it.
  const first = await callWith(SPOKEN);
  await executeTool(first, "verify_subject", VERIFY);
  // Asked, and the call drops before the subject says anything.
  first.screenAsked = ["bleeding_or_fainting"];
  await markAsDropped(first);

  const second = await callWith(SPOKEN);
  await executeTool(second, "verify_subject", VERIFY);
  assert.ok(
    !second.screenAsked.includes("bleeding_or_fainting"),
    "an unanswered question was carried forward as though it had been put",
  );

  const fabricated = await executeTool(second, "record_safety_screen_item", {
    item_id: "bleeding_or_fainting",
    answer: true,
    verbatim: null,
  });
  assert.equal(fabricated.isError, true, "an answer nobody gave was accepted");
  assert.match(
    String((fabricated.result as Record<string, unknown>).error),
    /has not been asked/,
  );
});
