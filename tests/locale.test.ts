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
  speakingRegion,
  UNKNOWN_REGION,
} from "../lib/clinical/locale.ts";
import { SUBJECTS, siteCountryForPrefix } from "../lib/clinical/protocol.ts";
import { ruleInstructions } from "../lib/clinical/safety.ts";
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
  // Every rule, not the two that one utterance happens to match. Reaching them
  // through scanForSafetySignals meant a new rule with a literal "call 911"
  // would have passed a test whose name says otherwise.
  const instructions = ruleInstructions();
  assert.ok(instructions.length >= 8, `only ${instructions.length} rules reached`);
  for (const instruction of instructions) {
    assert.ok(
      !/\b(911|988|999|000|111|116 123|13 11 14|1737)\b/.test(instruction),
      `a rule hardcodes a number: ${instruction}`,
    );
  }
});

test("no rule instruction asserts that anyone has been notified", () => {
  // The same claim has had to be removed from four separate places. A rule is
  // the wrong layer to make it from: it is a statement about a mail transport.
  for (const instruction of ruleInstructions()) {
    assert.ok(
      !/alerting (their|your) study coordinator|coordinator has been (paged|alerted|notified)/i.test(
        instruction,
      ),
      `a rule claims a notification: ${instruction}`,
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
    respondent: "self",
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
    respondent: "self",
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
    respondent: "self",
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
  // Its own status, not "sent". Filing a suppressed send as a delivery said
  // something untrue in the subsystem built to stop exactly that.
  assert.equal(row.status, "suppressed");
  assert.equal(row.destination, "coordinator@example.test", "the record lost who it was for");
  assert.ok(
    session.audit.all().some((e) => e.action === "ESCALATION_DELIVERY_SUPPRESSED"),
    "nothing on the record says this page was never sent",
  );
  assert.ok(
    !session.audit.all().some((e) => e.action === "ESCALATION_DELIVERED"),
    "a suppressed page was recorded as delivered",
  );
});

test("a synthetic session never enters the escalation ladder", async () => {
  // The sweeper used to treat suppressed rows as delivered, so it walked the
  // whole ladder on pages nobody sent — writing UNACKNOWLEDGED and ALARM entries
  // onto eval sessions.
  process.env.ESCALATION_EMAIL_TO = "coordinator@example.test";
  const session = await getSessionStore().create();
  session.synthetic = true;
  session.subjectUtterances = ["I have had chest pain"];
  await executeTool(session, "verify_subject", {
    subject_id: "001-0042",
    date_of_birth: "1958-03-11",
    respondent: "self",
  });
  await executeTool(session, "escalate_to_coordinator", {
    urgency: "emergency",
    reason: "Possible cardiac emergency.",
    related_event_ids: [],
  });

  const { getDeliveryStore } = await import("../lib/store/deliveries.ts");
  assert.deepEqual(await getDeliveryStore().openLadder(), []);
});

test("the emergency number survives an emergency before verification", async () => {
  // The net fires on the first utterance, and the ID is spoken before the date
  // of birth — so resolving the region only from a verified subject meant the
  // agent said "your local emergency number" at the most time-critical moment it
  // has. The site prefix is enough to answer which country, and it decides only
  // what is spoken aloud, never what may be written.
  const us = speakingRegion(null, ["001-0042"], siteCountryForPrefix);
  assert.equal(emergencyPhrase(us), "911");

  const uk = speakingRegion(null, ["My subject ID is 002 0013"], siteCountryForPrefix);
  assert.equal(emergencyPhrase(uk), "999");

  // Still hedges when there is genuinely nothing to go on.
  assert.equal(
    emergencyPhrase(speakingRegion(null, ["I don't remember my number"], siteCountryForPrefix)),
    "your local emergency number",
  );

  // A verified subject always wins over a spoken hint.
  assert.equal(emergencyPhrase(speakingRegion("GB", ["001-0042"], siteCountryForPrefix)), "999");
});
