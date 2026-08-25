/**
 * Turn latency, which is the one requirement this system used to assert rather
 * than measure. The arithmetic below decides whether N-01 is met, so it is worth
 * being sure it is arithmetic and not wishful thinking.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __setLatencyStore,
  getLatencyStore,
  percentile,
  plausible,
} from "../lib/store/latency.ts";

test("the percentile names a wait that actually happened", () => {
  // Nearest rank, not interpolated. A pilot produces tens of turns, and
  // interpolating invents a value between two real measurements and reports it
  // as though a participant had waited it.
  const sample = [100, 200, 300, 400];
  assert.equal(percentile(sample, 50), 200);
  assert.equal(percentile(sample, 95), 400);
  assert.ok(sample.includes(percentile(sample, 75)!));
});

test("percentiles of nothing are nothing, not zero", () => {
  // Zero would read as "instant" on a report whose whole job is honesty about
  // waiting.
  assert.equal(percentile([], 50), null);
});

test("a single measurement is its own every percentile", () => {
  assert.equal(percentile([1234], 50), 1234);
  assert.equal(percentile([1234], 95), 1234);
});

test("an impossible measurement is refused rather than stored", () => {
  // The browser reports this and a clock adjustment mid-call produces a negative
  // or absurd figure. One of those in the set moves a percentile silently, in
  // whichever direction its sign happens to point.
  assert.equal(plausible(-1), null);
  assert.equal(plausible(60 * 60 * 1000), null);
  assert.equal(plausible(Number.NaN), null);
  assert.equal(plausible(Number.POSITIVE_INFINITY), null);
  assert.equal(plausible(undefined), null);
  assert.equal(plausible(2500), 2500);
  assert.equal(plausible(0), 0, "an instant answer is possible, if unlikely");
});

test("the two halves of a turn find each other whichever arrives first", async () => {
  // The server writes its segments when the turn ends; the browser reports what
  // it heard whenever it hears it, which can be either side of that.
  __setLatencyStore(null);
  const store = getLatencyStore();
  assert.equal(store.kind, "memory", "no DATABASE_URL in tests");

  await store.record({
    sessionId: "s1",
    turnIndex: 4,
    source: "subject",
    firstAudioMs: 1800,
  });
  await store.record({
    sessionId: "s1",
    turnIndex: 4,
    source: "subject",
    firstTokenMs: 900,
    firstSentenceMs: 1400,
    totalMs: 3000,
    spokeBeforeTools: true,
  });

  const rows = await store.forSession("s1");
  assert.equal(rows.length, 1, "one turn, one row");
  assert.equal(rows[0].firstAudioMs, 1800, "the browser's half survived");
  assert.equal(rows[0].firstSentenceMs, 1400, "the server's half survived");
  assert.equal(rows[0].spokeBeforeTools, true);
  __setLatencyStore(null);
});

test("a later write never erases what the other half already reported", async () => {
  __setLatencyStore(null);
  const store = getLatencyStore();
  await store.record({
    sessionId: "s2",
    turnIndex: 0,
    source: "system",
    firstAudioMs: 2200,
    firstTokenMs: 700,
  });
  // A second server write with nothing new to say about audio.
  await store.record({ sessionId: "s2", turnIndex: 0, source: "system", totalMs: 4000 });

  const [row] = await store.forSession("s2");
  assert.equal(row.firstAudioMs, 2200, "not clobbered by a null");
  assert.equal(row.firstTokenMs, 700);
  assert.equal(row.totalMs, 4000);
  __setLatencyStore(null);
});

test("turns that produced no audio are kept, not dropped", async () => {
  // A turn the participant heard nothing from is the worst case N-01 describes.
  // Dropping it would remove exactly the evidence that matters.
  __setLatencyStore(null);
  const store = getLatencyStore();
  await store.record({ sessionId: "s3", turnIndex: 2, source: "subject", totalMs: 9000 });
  const [row] = await store.forSession("s3");
  assert.equal(row.firstAudioMs, null);
  assert.equal(row.totalMs, 9000);
  __setLatencyStore(null);
});
