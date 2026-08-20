import { test } from "node:test";
import assert from "node:assert/strict";
import { isEchoOfRecentSpeech, looksLikeEcho } from "../lib/voice/echo.ts";

// The exact echoes observed when the console ran on laptop speakers: the mic
// captured the agent's own text-to-speech and reported it as subject speech.
const AGENT_SPOKE = [
  "I'm sorry, I may not have come through clearly. Could you tell me your subject ID, please?",
  "It sounds like there may be an echo on the line. Can you hear me all right?",
  "I'm still only hearing my own words repeated back. If you can hear me, please say your subject ID.",
].join(" ");

test("suppresses verbatim echo of the agent's own speech", () => {
  for (const echoed of [
    "I'm sorry I may not have come through clearly",
    "it sounds like there may be an echo on the line",
    "Could you tell me your subject ID",
  ]) {
    assert.equal(
      isEchoOfRecentSpeech(echoed, AGENT_SPOKE),
      true,
      `should have suppressed: ${echoed}`,
    );
  }
});

test("does not suppress genuine subject answers that overlap the question", () => {
  const asked = "Have you had any nausea or upset stomach? How has your appetite been?";
  for (const genuine of [
    "any nausea yes a little",
    "my appetite has been poor this week",
    "I have had some nausea in the mornings",
    "no rash my skin has been fine",
  ]) {
    assert.equal(
      isEchoOfRecentSpeech(genuine, asked),
      false,
      `should NOT have suppressed: ${genuine}`,
    );
  }
});

test("short utterances are never judged echo", () => {
  // "yes", "no", "about eight" carry real clinical meaning and must survive
  // even when those words appear in what the agent just said.
  const spoken = "Was it about eight times a day? Yes or no is fine.";
  for (const short of ["yes", "no", "about eight"]) {
    assert.equal(isEchoOfRecentSpeech(short, spoken), false, `dropped: ${short}`);
  }
});

test("nothing is echo when the agent has not spoken", () => {
  assert.equal(isEchoOfRecentSpeech("I have been very tired this week", ""), false);
});

test("punctuation and casing do not defeat matching", () => {
  assert.equal(
    isEchoOfRecentSpeech(
      "could you tell me your subject id please",
      "Could you tell me your subject ID, please?",
    ),
    true,
  );
});

test("interim barge-in check matches truncated prefixes both ways", () => {
  const speaking = "Have you noticed any rash or changes to your skin?";
  assert.equal(looksLikeEcho("have you noticed any rash", speaking), true);
  assert.equal(looksLikeEcho("no I have not seen anything", speaking), false);
  assert.equal(looksLikeEcho("anything", ""), false);
});
