import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cacheableLines,
  isCacheable,
  speechCacheKey,
} from "../lib/voice/speech-cache.ts";

const BASE = {
  modelId: "eleven_flash_v2_5",
  voiceId: "SAz9YHcvj6GT2YYXdXww",
  outputFormat: "mp3_22050_32",
  voiceSettings: { stability: 0.5, similarity_boost: 0.75, speed: 0.94 },
};

const LINE = "Have you had any nausea or upset stomach?";

test("same text and same instrument reuses the cached render", () => {
  assert.equal(speechCacheKey(LINE, BASE), speechCacheKey(LINE, { ...BASE }));
});

test("different text is a different entry", () => {
  assert.notEqual(speechCacheKey(LINE, BASE), speechCacheKey("How has your appetite been?", BASE));
});

test("repinning the voice invalidates every cached render", () => {
  // Otherwise a voice change would leave old audio in place and a single call
  // could be spoken by two different voices.
  const other = { ...BASE, voiceId: "cjVigY5qzO86Huf0OWal" };
  assert.notEqual(speechCacheKey(LINE, BASE), speechCacheKey(LINE, other));
});

test("changing the model invalidates", () => {
  const other = { ...BASE, modelId: "eleven_turbo_v2_5" };
  assert.notEqual(speechCacheKey(LINE, BASE), speechCacheKey(LINE, other));
});

test("changing voice settings invalidates", () => {
  const slower = { ...BASE, voiceSettings: { ...BASE.voiceSettings, speed: 0.85 } };
  assert.notEqual(speechCacheKey(LINE, BASE), speechCacheKey(LINE, slower));
});

test("changing output format invalidates", () => {
  const other = { ...BASE, outputFormat: "pcm_22050" };
  assert.notEqual(speechCacheKey(LINE, BASE), speechCacheKey(LINE, other));
});

test("key is a hex sha256 and leaks no source text", () => {
  const key = speechCacheKey(LINE, BASE);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes("nausea"));
});

/**
 * The cache allowlist is a privacy control now, not only a latency one.
 *
 * It used to write every synthesised sentence to disk. The agent is instructed
 * to read back what it recorded, so a subject's own symptom description was
 * being persisted as audio under a filename that is a hash of the text — which
 * meant it could not be found again without already knowing the exact words the
 * subject used. Ten such files were on disk when this was found.
 *
 * Guarded by a test because the failure mode is silent: broadening the cache
 * back out would look like a performance improvement and read like one in a
 * diff.
 */
test("only the fixed instrument wording is cacheable", () => {
  assert.ok(cacheableLines().length > 0, "nothing is cacheable, so the cache is dead");

  // Every scripted question the protocol pins, as the runtime asks for it.
  assert.ok(
    isCacheable("And what is your date of birth?"),
    "a fixed instrument line is not cacheable, so the cache does nothing useful",
  );

  // Anything the model composed for this subject, on this call.
  for (const improvised of [
    "I understand, and I'm noting the dizziness you described on Tuesday.",
    "So that's the fatigue, the nausea, and the numbness in your left hand.",
    "Thank you for telling me about your daughter driving you to the hospital.",
  ]) {
    assert.ok(
      !isCacheable(improvised),
      `subject-derived speech is cacheable and would be written to disk: ${improvised}`,
    );
  }
});

test("the allowlist cannot be widened by a caller", () => {
  // It used to hand out the memoised Set, so one add() broadened the control
  // process-wide — a line that would read as a cache-warming tweak in a diff.
  const lines = cacheableLines();
  lines.push("Thank you for telling me about the blood you coughed up.");
  assert.ok(
    !isCacheable("Thank you for telling me about the blood you coughed up."),
    "mutating what cacheableLines() returned widened the allowlist",
  );
});
