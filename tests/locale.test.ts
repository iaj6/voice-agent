/**
 * The right number, where the participant actually is.
 *
 * The system told everyone to call 911 and, in a crisis, to text 988 — both US
 * numbers, in a trial whose own roster has a UK site. A wrong emergency number
 * costs someone the seconds that matter most; a wrong crisis line is worse than
 * silence, because they will try it and it will not answer.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  crisisPhrase,
  emergencyPhrase,
  knownRegions,
  localise,
  regionFor,
  UNKNOWN_REGION,
} from "../lib/clinical/locale.ts";
import { SUBJECTS } from "../lib/clinical/protocol.ts";
import { assertedHits, scanForSafetySignals } from "../lib/clinical/safety.ts";
import { executeTool } from "../lib/agent/tools.ts";
import { __setSessionStore, getSessionStore } from "../lib/store/session-store.ts";
import { __setKeyStore } from "../lib/store/keys.ts";
import { __setSubjectStore } from "../lib/store/subjects.ts";
import { __setDeliveryStore } from "../lib/store/deliveries.ts";
import { __setTransport, type EscalationTransport } from "../lib/escalation/transport.ts";

beforeEach(() => {
  __setSessionStore(null);
  __setKeyStore(null);
  __setSubjectStore(null);
  __setDeliveryStore(null);
  delete process.env.DATABASE_URL;
  delete process.env.ESCALATION_EMAIL_TO;
  __setTransport({
    channel: "test",
    async send() {
      return { providerId: "test" };
    },
  } satisfies EscalationTransport);
});

test("every site on the roster has a country we can answer for", () => {
  for (const subject of SUBJECTS) {
    const region = regionFor(subject.siteCountry);
    assert.notEqual(
      region,
      UNKNOWN_REGION,
      `${subject.siteName} is in ${subject.siteCountry}, which has no entry — ` +
        "participants there would be told to call their local emergency number " +
        "rather than a number",
    );
    assert.ok(region.emergency, `${region.name} has no emergency number`);
  }
});

test("the numbers are the ones for that country", () => {
  assert.equal(emergencyPhrase(regionFor("US")), "911");
  assert.equal(emergencyPhrase(regionFor("GB")), "999");
  assert.equal(emergencyPhrase(regionFor("AU")), "000");
  assert.equal(emergencyPhrase(regionFor("NZ")), "111");
  assert.match(crisisPhrase(regionFor("GB"))!, /Samaritans.*116 123/);
  assert.match(crisisPhrase(regionFor("AU"))!, /Lifeline.*13 11 14/);
  assert.match(crisisPhrase(regionFor("US"))!, /988/);
});

test("an unknown country gets a hedge, never a guess", () => {
  // A wrong number is worse than no number: it will be dialled.
  for (const unknown of [null, undefined, "", "ZZ", "Narnia"]) {
    const region = regionFor(unknown as string);
    assert.equal(region, UNKNOWN_REGION);
    assert.equal(emergencyPhrase(region), "your local emergency number");
    assert.equal(crisisPhrase(region), null);
  }
});

test("no rule instruction hardcodes a country's number", () => {
  // The rules carry placeholders; substitution happens once, where the subject
  // is known. A literal in a rule is a number six copies of it will drift from.
  const hits = assertedHits(
    scanForSafetySignals("I can't breathe. I don't want to live anymore."),
  );
  assert.ok(hits.length >= 2, "the corpus utterance stopped matching");
  for (const hit of hits) {
    assert.ok(
      !/\b(911|988|999|000|111|116 123)\b/.test(hit.instruction),
      `${hit.category} hardcodes a number: ${hit.instruction}`,
    );
  }
});

test("substitution puts the right numbers into a rule", () => {
  const raw =
    "Tell them to call {{EMERGENCY_NUMBER}} and that they can reach {{CRISIS_LINE}}.";

  const uk = localise(raw, regionFor("GB"));
  assert.match(uk, /call 999/);
  assert.match(uk, /Samaritans by calling 116 123/);
  assert.ok(!uk.includes("911"), "a UK participant was told to call 911");
  assert.ok(!uk.includes("988"), "a UK participant was sent to a US crisis line");

  const us = localise(raw, regionFor("US"));
  assert.match(us, /call 911/);
  assert.match(us, /988/);
});

test("an unknown region is never told about a crisis line that does not serve it", () => {
  const raw = "They can reach {{CRISIS_LINE}}.";
  const text = localise(raw, UNKNOWN_REGION);
  for (const number of ["988", "116 123", "13 11 14", "1737"]) {
    assert.ok(!text.includes(number), `an unplaceable participant was given ${number}`);
  }
  assert.match(text, /study site/, "they were left with no route at all");
});

test("a UK participant's failed escalation does not mention 911", async () => {
  // The end-to-end path: no recipient configured, so delivery fails, and the
  // instruction that routes the subject has to name the right service.
  const session = await getSessionStore().create();
  session.subjectUtterances = ["I have had chest pain"];
  await executeTool(session, "verify_subject", {
    subject_id: "002-0013",
    date_of_birth: "1949-07-24",
  });
  assert.equal(session.subject?.siteCountry, "GB", "the fixture is not a UK site");

  const out = await executeTool(session, "escalate_to_coordinator", {
    urgency: "emergency",
    reason: "Possible cardiac emergency.",
    related_event_ids: [],
  });
  const instruction = String((out.result as Record<string, unknown>).instruction);

  assert.match(instruction, /999/, "a UK participant was not given 999");
  assert.ok(!instruction.includes("911"), "a UK participant was told to call 911");
});

test("a US participant still gets 911", async () => {
  const session = await getSessionStore().create();
  session.subjectUtterances = ["I have had chest pain"];
  await executeTool(session, "verify_subject", {
    subject_id: "001-0042",
    date_of_birth: "1958-03-11",
  });

  const out = await executeTool(session, "escalate_to_coordinator", {
    urgency: "emergency",
    reason: "Possible cardiac emergency.",
    related_event_ids: [],
  });
  assert.match(String((out.result as Record<string, unknown>).instruction), /911/);
});

test("every known region can answer both questions", () => {
  for (const region of knownRegions()) {
    assert.ok(region.emergency, `${region.name} has no emergency number`);
    assert.ok(region.crisis, `${region.name} has no crisis line`);
    assert.match(region.code, /^[A-Z]{2}$/);
  }
});

test("an eval session records the page and sends nothing", async () => {
  // The harness drives the same escalation path the console does. Without this,
  // every `npm run eval:fast` pages a real coordinator three times.
  process.env.ESCALATION_EMAIL_TO = "coordinator@example.test";
  let sends = 0;
  __setTransport({
    channel: "test",
    async send() {
      sends += 1;
      return { providerId: "should-not-happen" };
    },
  } satisfies EscalationTransport);

  const session = await getSessionStore().create();
  session.synthetic = true;
  session.subjectUtterances = ["I have had chest pain"];
  await executeTool(session, "verify_subject", {
    subject_id: "001-0042",
    date_of_birth: "1958-03-11",
  });
  const out = await executeTool(session, "escalate_to_coordinator", {
    urgency: "emergency",
    reason: "Possible cardiac emergency.",
    related_event_ids: [],
  });

  assert.equal(sends, 0, "the eval harness sent a real page");
  // Still reported as delivered and recorded, so the harness exercises the same
  // branch a real call takes rather than the failure path.
  assert.equal((out.result as Record<string, unknown>).delivered, true);
  const { getDeliveryStore } = await import("../lib/store/deliveries.ts");
  const [row] = await getDeliveryStore().forSession(session.id);
  assert.equal(row.status, "sent");
  assert.match(row.providerId!, /suppressed/);
  assert.equal(row.destination, "coordinator@example.test", "the record lost who it was for");
});
