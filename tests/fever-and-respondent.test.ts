/**
 * The two pre-pilot changes the simulated clinical review insisted on
 * (docs/CLINICAL-REVIEW.md section 5): fever stops the call, and a proxy
 * respondent is recorded as one rather than passing as the participant.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/agent/tools.ts";
import { __setSessionStore, getSessionStore } from "../lib/store/session-store.ts";
import { __setKeyStore } from "../lib/store/keys.ts";
import { __setSubjectStore } from "../lib/store/subjects.ts";
import { __setDeliveryStore, getDeliveryStore } from "../lib/store/deliveries.ts";
import { PROTOCOL } from "../lib/clinical/protocol.ts";
import { assertedHits, scanForSafetySignals } from "../lib/clinical/safety.ts";
import type { CheckInSession } from "../lib/store/session.ts";

const VERIFY = { subject_id: "001-0042", date_of_birth: "1958-03-11", respondent: "self" };
const FEVER = PROTOCOL.safetyScreen.find((i) => i.id === "fever")!;

beforeEach(() => {
  __setSessionStore(null);
  __setKeyStore(null);
  __setSubjectStore(null);
  __setDeliveryStore(null);
  delete process.env.DATABASE_URL;
});

async function verified(): Promise<CheckInSession> {
  const session = await getSessionStore().create();
  await executeTool(session, "verify_subject", { ...VERIFY, respondent: "self" });
  assert.ok(session.subject, "fixture failed to verify");
  session.screenAsked = ["fever"];
  return session;
}

const instruction = (out: { result: unknown }) =>
  String((out.result as Record<string, unknown>).instruction);

test("a yes to fever pages at emergency before anything else is asked", async () => {
  const session = await verified();
  session.subjectUtterances = ["Yes, I've had a fever."];
  const out = await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: null,
    measurement: null,
  });

  assert.equal(session.escalations[0]?.urgency, "emergency");
  assert.equal((await getDeliveryStore().forSession(session.id)).length, 1, "nobody was paged");
  // The follow-up is asked after the page, not before it.
  assert.match(instruction(out), new RegExp(FEVER.onPositive!.followUpPrompt.replace(/[?]/g, "\\?")));
  assert.match(instruction(out), /Stop the screen/);
});

test("the temperature is recorded as said, and the call ends with the protocol's words", async () => {
  const session = await verified();
  session.subjectUtterances = ["Yes.", "It was thirty-eight point nine."];
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: null,
    measurement: null,
  });
  const out = await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: null,
    measurement: "thirty-eight point nine",
  });

  const item = session.safetyScreen!.items.find((i) => i.itemId === "fever")!;
  assert.equal(item.measurement, "thirty-eight point nine");
  assert.match(instruction(out), /ended_early true/);
  assert.ok(instruction(out).includes(FEVER.onPositive!.closingInstruction));
  assert.equal(session.escalations.length, 1, "the follow-up paged a second time");
});

test("a subject who did not measure still gets the closing instruction", async () => {
  const session = await verified();
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: null,
    measurement: null,
  });
  const out = await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: null,
    measurement: null,
  });
  assert.match(instruction(out), /ended_early true/);
});

test("fever in free speech fires the net at emergency; shaking alone stays urgent", () => {
  const fever = assertedHits(scanForSafetySignals("I've had a fever since Monday"));
  assert.equal(fever[0]?.urgency, "emergency");

  const shaking = assertedHits(scanForSafetySignals("my hands are shaking a bit"));
  assert.equal(shaking[0]?.urgency, "urgent");
});

test("a caregiver is refused on a protocol that does not permit proxy reporting", async () => {
  assert.equal(PROTOCOL.proxyReporting, "not_permitted");
  const session = await getSessionStore().create();
  const out = await executeTool(session, "verify_subject", { ...VERIFY, respondent: "caregiver" });

  assert.equal((out.result as Record<string, unknown>).verified, false);
  assert.equal(session.subject, null, "a proxy was verified as the participant");
  assert.ok(session.audit.all().some((e) => e.action === "PROXY_RESPONDENT_REFUSED"));
  assert.match(instruction(out), /complete_check_in with ended_early true/);

  // And nothing clinical can be recorded afterwards.
  session.screenAsked = ["fever"];
  const screen = await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: false,
    verbatim: null,
    measurement: null,
  });
  assert.equal(screen.isError, true);
});

test("where proxy reporting is permitted, the call proceeds and is marked as a proxy report", async () => {
  const policy = PROTOCOL.proxyReporting;
  PROTOCOL.proxyReporting = "permitted";
  try {
    const session = await getSessionStore().create();
    const out = await executeTool(session, "verify_subject", { ...VERIFY, respondent: "caregiver" });
    assert.equal((out.result as Record<string, unknown>).verified, true);
    assert.equal(session.respondent, "caregiver");
    const entry = session.audit.all().find((e) => e.action === "SUBJECT_VERIFIED");
    // The payload is sealed at rest; the reason line is not, so a reviewer sees it.
    assert.match(String(entry?.reason), /caregiver/);
  } finally {
    PROTOCOL.proxyReporting = policy;
  }
});

// Review findings: each of these held only while the model behaved.

test("a fever follow-up recorded as 'no' cannot un-flag the item or skip the close", async () => {
  const session = await verified();
  session.subjectUtterances = ["Yes, I've been burning up since Tuesday.", "No, I didn't take it."];
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: "I've been burning up since Tuesday",
    measurement: null,
  });
  const out = await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: false,
    verbatim: "I didn't take it",
    measurement: null,
  });

  const item = session.safetyScreen!.items.find((i) => i.itemId === "fever")!;
  assert.equal(item.answer, true);
  assert.equal(item.verbatim, "I've been burning up since Tuesday", "the first account was overwritten");
  assert.deepEqual(session.safetyScreen!.positiveRedFlags, ["fever"]);
  assert.match(instruction(out), /ended_early true/);
});

test("after the fever close, no further clinical record is accepted", async () => {
  const session = await verified();
  session.subjectUtterances = ["Yes, thirty-nine."];
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever",
    answer: true,
    verbatim: null,
    measurement: "thirty-nine",
  });
  assert.ok(session.mustEnd);
  const next = await executeTool(session, "record_adherence", {
    doses_missed_since_last_check_in: 0,
    reason_verbatim: null,
  });
  assert.equal(next.isError, true);
});

test("a refused caregiver cannot be re-verified as the participant", async () => {
  const session = await getSessionStore().create();
  await executeTool(session, "verify_subject", { ...VERIFY, respondent: "caregiver" });
  const retry = await executeTool(session, "verify_subject", { ...VERIFY, respondent: "self" });
  assert.equal(retry.isError, true);
  assert.equal(session.subject, null);
});

test("the closing and proxy lines are pre-warmed fixed speech", async () => {
  const { FIXED_LINES, FIXED_PROXY_NOT_PERMITTED } = await import("../lib/agent/fixed-speech.ts");
  assert.ok(FIXED_LINES.includes(FIXED_PROXY_NOT_PERMITTED));
  assert.ok(FIXED_LINES.includes(FEVER.onPositive!.closingInstruction));
});

// Second review: the lock arms on the first emergency, not the model's next move.

test("a first fever 'yes' locks the call even if the model skips the follow-up", async () => {
  const session = await verified();
  session.subjectUtterances = ["Yes."];
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever", answer: true, verbatim: null, measurement: null,
  });
  assert.ok(session.mustEnd, "the call was not locked on the yes");
  const next = await executeTool(session, "record_adherence", {
    doses_missed_since_last_check_in: 0, reason_verbatim: null,
  });
  assert.equal(next.isError, true);
});

test("a locked call can still page about something new", async () => {
  const session = await verified();
  session.subjectUtterances = ["Yes.", "And he collapsed earlier"];
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever", answer: true, verbatim: null, measurement: null,
  });
  const out = await executeTool(session, "escalate_to_coordinator", {
    urgency: "emergency", reason: "Reports collapsing earlier today", related_event_ids: [],
  });
  assert.doesNotMatch(String((out.result as Record<string, unknown>).error ?? ""), /must end/);
  assert.equal(session.escalations.length, 2);
});

test("an unclear respondent is asked again, not treated as the participant", async () => {
  for (const respondent of [undefined, "proxy", "Caregiver"]) {
    const session = await getSessionStore().create();
    const out = await executeTool(session, "verify_subject", { ...VERIFY, respondent });
    assert.equal(session.subject, null, `respondent ${respondent} verified as self`);
    assert.equal(session.verificationAttempts, 0, "an unclear respondent cost an attempt");
    assert.match(instruction(out), /Who is answering/);
  }
});

test("a temperature the subject never said is not recorded", async () => {
  const session = await verified();
  session.subjectUtterances = ["Yes.", "No, I didn't take it."];
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever", answer: true, verbatim: null, measurement: null,
  });
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever", answer: true, verbatim: null, measurement: "38.9 C",
  });
  const item = session.safetyScreen!.items.find((i) => i.itemId === "fever")!;
  assert.equal(item.measurement, null);
});

test("fever named by the net and then answered yes on the screen pages once", async () => {
  const { runTurn } = await import("../lib/agent/runner.ts");
  const session = await verified();
  for await (const ev of runTurn(session, { source: "subject", utterance: "I've had a fever since last night" })) {
    if (ev.type === "error") break;
  }
  assert.equal(session.escalations.length, 1);
  await executeTool(session, "record_safety_screen_item", {
    item_id: "fever", answer: true, verbatim: null, measurement: null,
  });
  assert.equal(session.escalations.length, 1, "one fever produced two emergency pages");
});
