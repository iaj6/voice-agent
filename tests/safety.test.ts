import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanForSafetySignals,
  highestUrgency,
  determineSeriousness,
} from "../lib/clinical/safety.ts";

test("fires on cardiac and respiratory emergencies", () => {
  for (const utterance of [
    "I've had this chest pain since last night",
    "there's a lot of pressure in my chest",
    "I can't breathe when I walk to the kitchen",
    "having trouble breathing since yesterday",
  ]) {
    const hits = scanForSafetySignals(utterance);
    assert.ok(hits.length > 0, `no hit for: ${utterance}`);
    assert.equal(highestUrgency(hits), "emergency");
  }
});

test("fires on self-harm language", () => {
  const hits = scanForSafetySignals("some days I don't want to live anymore");
  assert.equal(highestUrgency(hits), "emergency");
  assert.equal(hits[0].category, "Self-harm or suicidal ideation");
});

test("fires on hospitalization at urgent, not emergency", () => {
  const hits = scanForSafetySignals("I was admitted overnight on Saturday");
  assert.equal(highestUrgency(hits), "urgent");
});

test("returns highest urgency first when several rules match", () => {
  const hits = scanForSafetySignals(
    "I had a fever so I went to the ER, and then I passed out in the waiting room",
  );
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].urgency, "emergency");
});

test("does not fire on ordinary symptom reports", () => {
  for (const utterance of [
    "I've been pretty tired this week",
    "a little queasy but I'm still eating okay",
    "my feet have been tingling, it's annoying",
    "appetite is about the same as always",
    "no rash, skin's fine",
  ]) {
    assert.deepEqual(scanForSafetySignals(utterance), [], `false positive: ${utterance}`);
  }
});

test("word boundaries prevent substring false positives", () => {
  // "chest painting" and "shaking hands hello" should not trip cardiac/fever rules.
  assert.deepEqual(scanForSafetySignals("I finished the chest painting project"), []);
});

test("seriousness with no criteria is not serious and starts no clock", () => {
  const d = determineSeriousness([], 24);
  assert.equal(d.isSerious, false);
  assert.equal(d.sponsorNotificationHours, null);
  assert.equal(d.indSafetyReportNote, null);
});

test("hospitalization triggers the 15-day IND report path", () => {
  const d = determineSeriousness(["hospitalization"], 24);
  assert.equal(d.isSerious, true);
  assert.equal(d.sponsorNotificationHours, 24);
  assert.match(d.indSafetyReportNote!, /15-calendar-day/);
});

test("fatal or life-threatening events take the 7-day path", () => {
  for (const c of ["death", "life_threatening"] as const) {
    const d = determineSeriousness([c], 24);
    assert.match(d.indSafetyReportNote!, /7-calendar-day/);
  }
});
