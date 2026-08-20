import { test } from "node:test";
import assert from "node:assert/strict";
import { speechCacheKey } from "../lib/voice/speech-cache.ts";

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
