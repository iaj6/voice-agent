/**
 * Transcription accuracy, and the distinction that matters.
 *
 * Word error rate is the standard number and it is not the one this system
 * cares about: a recogniser that drops "quite" scores the same as one that
 * drops "blood", and only the second one loses a reportable event.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { termRecall, tokenise, wordErrorRate } from "../lib/voice/wer.ts";

test("a perfect transcript scores zero", () => {
  const r = wordErrorRate("I have had chest pain since last night", "I have had chest pain since last night");
  assert.equal(r.wer, 0);
  assert.equal(r.substitutions + r.deletions + r.insertions, 0);
});

test("contractions are not errors", () => {
  // "I've been coughing" and "I have been coughing" are the same clinical
  // content. Counting the difference measures transcription style.
  assert.equal(wordErrorRate("I've been coughing", "I have been coughing").wer, 0);
  assert.equal(wordErrorRate("I can't breathe", "I cannot breathe").wer, 0);
  assert.deepEqual(tokenise("It's fine, I'm okay"), ["it", "is", "fine", "i", "am", "okay"]);
});

test("the edit types are counted apart", () => {
  const sub = wordErrorRate("chest pain today", "chest ache today");
  assert.equal(sub.substitutions, 1);
  assert.equal(sub.deletions + sub.insertions, 0);

  const del = wordErrorRate("sharp chest pain today", "chest pain today");
  assert.equal(del.deletions, 1);

  const ins = wordErrorRate("chest pain", "sharp chest pain");
  assert.equal(ins.insertions, 1);
});

test("word error rate is relative to the reference, not the transcript", () => {
  const r = wordErrorRate("chest pain", "chest pain and a headache and a cough");
  assert.equal(r.referenceWords, 2);
  assert.ok(r.wer > 1, "an over-long transcript can exceed 1.0, and should");
});

test("a harmless miss and a dangerous one score the same on WER", () => {
  // The whole argument for term recall, stated as a test.
  const harmless = wordErrorRate("I have been feeling quite tired", "I have been feeling very tired");
  const dangerous = wordErrorRate("I coughed up blood", "I coughed up phlegm");
  assert.equal(harmless.substitutions, 1);
  assert.equal(dangerous.substitutions, 1);
});

const TERMS = ["blood", "chest pain", "breathe", "fever", "numb"];

test("term recall catches the dangerous miss the WER shrugged at", () => {
  const kept = termRecall("I coughed up blood", "I coughed up blood", TERMS);
  assert.equal(kept.recall, 1);

  const lost = termRecall("I coughed up blood", "I coughed up phlegm", TERMS);
  assert.equal(lost.recall, 0, "a lost clinical term scored as fully recalled");
});

test("only terms actually in the reference are scored", () => {
  const { results, recall } = termRecall("I have a fever", "I have a fever", TERMS);
  assert.deepEqual(
    results.map((r) => r.term),
    ["fever"],
    "terms the participant never said were counted against the recogniser",
  );
  assert.equal(recall, 1);
});

test("multi-word terms match as phrases, not as loose words", () => {
  const present = termRecall("I get chest pain walking", "I get chest pain walking", TERMS);
  assert.equal(present.recall, 1);

  // The words are both there and the term is not.
  const scattered = termRecall("I get chest pain walking", "my chest is fine but my knee is in pain", TERMS);
  assert.equal(scattered.recall, 0, "scattered words counted as the phrase");
});

test("a near-miss counts as a miss", () => {
  // "bloody" is not "blood" for a record somebody acts on, and a recogniser
  // producing near-misses should score as having missed.
  const near = termRecall("I coughed up blood", "I coughed up bloody stuff", TERMS);
  assert.equal(near.recall, 0);
});

test("hearing a term more often than it was said does not earn credit", () => {
  const r = termRecall("blood", "blood blood blood", TERMS);
  assert.equal(r.recall, 1, "recall should cap at what was actually said");
});

test("an empty transcript loses everything", () => {
  assert.equal(wordErrorRate("I have had chest pain", "").wer, 1);
  assert.equal(termRecall("I have had chest pain", "", TERMS).recall, 0);
});
