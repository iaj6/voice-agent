/**
 * The invariant: an escalation that exists has been delivered to somebody.
 *
 * This is the defect the 2026-08-26 audit found, and it is worth stating why the
 * whole 305-test suite missed it. Every test that cared asserted on
 * `session.escalations` — the in-memory object the code had just written — under
 * comments that said things like "the red flag must still page someone". The
 * comment named the page; the assertion checked the record. An escalation that
 * reached nobody looked identical to one that reached a coordinator, for the
 * entire life of the directed safety screen.
 *
 * So every assertion here is on the artefact the outside world would see: a row
 * in `escalation_delivery`, which is what the retry ladder, the backup contact,
 * the alarm and the morning digest all query.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/agent/tools.ts";
import { AuditTrail } from "../lib/store/audit.ts";
import { SUBJECTS, PROTOCOL } from "../lib/clinical/protocol.ts";
import { __setDeliveryStore, getDeliveryStore } from "../lib/store/deliveries.ts";
import type { CheckInSession } from "../lib/store/session.ts";

const ID = "22222222-2222-4222-8222-222222222222";

function session(utterances: string[]): CheckInSession {
  return {
    id: ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "in_progress",
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
    shredded: false,
    synthetic: false,
    audit: new AuditTrail(ID),
  };
}

/** Every red-flag item the protocol defines, so a new one cannot be added silently. */
const RED_FLAGS = PROTOCOL.safetyScreen.filter((i) => i.redFlag);

test("every red-flag screen item pages somebody when answered yes", async () => {
  assert.ok(RED_FLAGS.length >= 6, "the protocol should have several red flags");

  for (const item of RED_FLAGS) {
    __setDeliveryStore(null);
    const s = session([`Yes, that has been happening — ${item.label.toLowerCase()}.`]);

    await executeTool(s, "record_safety_screen_item", {
      item_id: item.id,
      answer: true,
      verbatim: null,
    });

    assert.equal(s.escalations.length, 1, `${item.id}: no escalation was raised`);
    const attempts = await getDeliveryStore().forSession(ID);
    assert.equal(
      attempts.length,
      1,
      `${item.id}: an escalation exists and NOBODY WAS PAGED for it`,
    );
    assert.equal(attempts[0].urgency, item.urgencyIfPositive);
  }
  __setDeliveryStore(null);
});

test("the tool never claims a page it did not observe", async () => {
  // With no transport configured nothing can be delivered, so the instruction the
  // agent reads — and repeats aloud to a frightened person — must say so. This
  // said "the coordinator is already paged" unconditionally.
  __setDeliveryStore(null);
  const s = session(["Yes, my chest has been tight and I cannot get a breath."]);

  const outcome = await executeTool(s, "record_safety_screen_item", {
    item_id: "chest_or_breathing",
    answer: true,
    verbatim: null,
  });

  const result = outcome.result as Record<string, unknown>;
  assert.equal(result.delivered, false, "nothing was delivered in this environment");
  assert.equal(result.notified, null, "so nobody may be named as notified");
  assert.match(
    String(result.instruction),
    /did NOT go through/,
    "the agent must be told the page failed",
  );
  // Checked as a prohibition rather than an absence: the instruction does contain
  // the phrase "coordinator has been alerted", inside the sentence telling the
  // agent not to say it. Asserting the phrase is absent would fail on correct copy.
  assert.match(
    String(result.instruction),
    /Do not tell the subject their coordinator has been alerted/,
    "the agent must be explicitly forbidden from claiming the alert",
  );
  assert.equal(outcome.isError, true, "an escalation nobody received is an error");
  __setDeliveryStore(null);
});

test("a correction from no to yes pages somebody too", async () => {
  // The gating is on the prior answer rather than on a prior record existing,
  // because a subject correcting "no" to "yes" is the most important correction
  // available to them. That fix predates this one and was equally undelivered.
  __setDeliveryStore(null);
  const s = session(["No.", "Actually yes, sorry — I did have a fever."]);

  await executeTool(s, "record_safety_screen_item", {
    item_id: "fever",
    answer: false,
    verbatim: null,
  });
  assert.equal((await getDeliveryStore().forSession(ID)).length, 0, "no page for a no");

  await executeTool(s, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: null,
  });
  assert.equal(
    (await getDeliveryStore().forSession(ID)).length,
    1,
    "the correction paged nobody",
  );
  __setDeliveryStore(null);
});

test("repeated fabrication pages somebody, not just the record", async () => {
  // An agent repeatedly attributing words to a participant who never said them is
  // the strongest available signal that a call cannot be trusted. It raised an
  // escalation and delivered nothing.
  __setDeliveryStore(null);
  const s = session(["I have been alright this week, nothing much to report."]);

  for (const invented of [
    "I coughed up blood on Tuesday",
    "I fainted in the kitchen on Wednesday",
    "my chest was crushing on Thursday",
  ]) {
    await executeTool(s, "record_adverse_event", {
      verbatim_term: invented,
      coded_term: "Fabricated",
      onset_description: "unknown",
      ongoing: true,
      grade: 2,
      grade_rationale: "n/a",
      limits_self_care: false,
      spontaneous: true,
    });
  }

  const fabrication = s.escalations.find((e) => e.category === "Unfounded record content");
  assert.ok(fabrication, "repeated fabrication should escalate");
  const attempts = await getDeliveryStore().forSession(ID);
  assert.ok(
    attempts.some((a) => a.escalationId === fabrication.id),
    "the fabrication escalation reached nobody",
  );
  __setDeliveryStore(null);
});

test("a grade 3 event pages somebody without the model choosing to", async () => {
  // SPEC §7.1 names grade 3+ as a decision with a reporting clock that leaves the
  // model. The entire mechanism used to be a sentence in the tool result telling
  // the model to call escalate_to_coordinator. A grade 5 event recorded by a model
  // that did not then call it raised nothing at all.
  __setDeliveryStore(null);
  const s = session(["My chest has been so tight I could not get up the stairs."]);

  await executeTool(s, "record_adverse_event", {
    verbatim_term: "so tight I could not get up the stairs",
    coded_term: "Dyspnea",
    onset_description: "three days",
    ongoing: true,
    grade: 3,
    grade_rationale: "limits instrumental activities",
    limits_self_care: false,
    spontaneous: true,
  });

  const attempts = await getDeliveryStore().forSession(ID);
  assert.equal(attempts.length, 1, "grade 3 paged nobody");
  assert.equal(attempts[0].urgency, "urgent");
  __setDeliveryStore(null);
});

test("grade 4 does not wait in an inbox", async () => {
  __setDeliveryStore(null);
  const s = session(["I could not breathe at all and they called an ambulance."]);
  await executeTool(s, "record_adverse_event", {
    verbatim_term: "could not breathe at all",
    coded_term: "Respiratory failure",
    onset_description: "last night",
    ongoing: true,
    grade: 4,
    grade_rationale: "life-threatening",
    limits_self_care: true,
    spontaneous: true,
  });
  const attempts = await getDeliveryStore().forSession(ID);
  assert.equal(attempts[0]?.urgency, "emergency");
  __setDeliveryStore(null);
});

test("one event does not page a coordinator three times", async () => {
  // The grade threshold and the seriousness determination can both fire for the
  // same event, and a correction can re-record it. A coordinator paged three
  // times for one symptom stops reading the pages.
  __setDeliveryStore(null);
  const s = session(["I was admitted overnight with the bleeding."]);

  const first = await executeTool(s, "record_adverse_event", {
    verbatim_term: "admitted overnight with the bleeding",
    coded_term: "Hemorrhage",
    onset_description: "yesterday",
    ongoing: true,
    grade: 3,
    grade_rationale: "required hospitalisation",
    limits_self_care: false,
    spontaneous: true,
  });
  const eventId = (first.result as Record<string, unknown>).event_id as string;

  await executeTool(s, "assess_seriousness", {
    event_id: eventId,
    criteria_met: ["hospitalization"],
    basis: "admitted overnight",
  });

  // Re-recording the same event, as a correction would.
  await executeTool(s, "record_adverse_event", {
    verbatim_term: "admitted overnight with the bleeding",
    coded_term: "Hemorrhage",
    onset_description: "yesterday",
    ongoing: true,
    grade: 4,
    grade_rationale: "corrected upward",
    limits_self_care: true,
    spontaneous: true,
  });

  const categories = s.escalations.map((e) => e.category);
  assert.equal(
    categories.filter((c) => c === "Grade 3 or above").length,
    1,
    "the grade threshold escalated twice for one event",
  );
  assert.equal(
    categories.filter((c) => c === "Serious adverse event").length,
    1,
    "seriousness escalated more than once",
  );
  __setDeliveryStore(null);
});

test("a serious determination pages somebody on its own", async () => {
  // An SAE opens a 24-hour reporting window under ICH E2A and 21 CFR 312.32. A
  // window that opens only when a model remembers to call another tool is not a
  // control.
  __setDeliveryStore(null);
  const s = session(["They kept me in overnight."]);
  const rec = await executeTool(s, "record_adverse_event", {
    verbatim_term: "kept me in overnight",
    coded_term: "Neutropenia",
    onset_description: "two days",
    ongoing: true,
    grade: 2,
    grade_rationale: "moderate",
    limits_self_care: false,
    spontaneous: true,
  });
  assert.equal(
    (await getDeliveryStore().forSession(ID)).length,
    0,
    "grade 2 should not escalate on grade alone",
  );

  await executeTool(s, "assess_seriousness", {
    event_id: (rec.result as Record<string, unknown>).event_id as string,
    criteria_met: ["hospitalization"],
    basis: "inpatient admission",
  });

  const attempts = await getDeliveryStore().forSession(ID);
  assert.equal(attempts.length, 1, "a serious grade 2 event paged nobody");
  assert.equal(attempts[0].urgency, "urgent");
  __setDeliveryStore(null);
});
