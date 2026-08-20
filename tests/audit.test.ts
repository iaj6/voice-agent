import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditTrail } from "../lib/store/audit.ts";

test("chain verifies for an untouched trail", () => {
  const trail = new AuditTrail("s1");
  trail.record({ actor: "system", action: "A", entity: "E", reason: "r1" });
  trail.record({ actor: "agent", action: "B", entity: "E", reason: "r2" });
  assert.deepEqual(trail.verifyChain(), { valid: true });
});

test("entries snapshot their payload instead of referencing it", () => {
  // Regression: audit entries used to hold a live reference to the caller's
  // domain object. Mutating that object afterwards silently rewrote history and
  // broke the hash chain.
  const trail = new AuditTrail("s2");
  const liveRecord = { id: "AE-001", grade: 1, term: "Nausea" };

  trail.record({
    actor: "agent",
    action: "AE_RECORDED",
    entity: "AdverseEvent",
    entityId: liveRecord.id,
    after: liveRecord,
    reason: "initial capture",
  });

  liveRecord.grade = 4;
  liveRecord.term = "Something else entirely";

  const [entry] = trail.all();
  assert.deepEqual(entry.after, { id: "AE-001", grade: 1, term: "Nausea" });
  assert.deepEqual(trail.verifyChain(), { valid: true });
});

test("tampering with a recorded entry is detected", () => {
  const trail = new AuditTrail("s3");
  trail.record({ actor: "agent", action: "AE_RECORDED", entity: "E", reason: "r1" });
  trail.record({ actor: "agent", action: "AE_UPDATED", entity: "E", reason: "r2" });
  trail.record({ actor: "agent", action: "ESCALATED", entity: "E", reason: "r3" });

  // Simulate an after-the-fact edit of an already-written entry.
  const entries = trail.all() as unknown as Array<{ reason: string }>;
  entries[1].reason = "backdated justification";

  const result = trail.verifyChain();
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.brokenAtSeq, 2);
});

test("chain links each entry to its predecessor", () => {
  const trail = new AuditTrail("s4");
  trail.record({ actor: "system", action: "A", entity: "E", reason: "r" });
  trail.record({ actor: "system", action: "B", entity: "E", reason: "r" });
  const [first, second] = trail.all();
  assert.equal(second.prevHash, first.hash);
  assert.equal(first.prevHash, "0".repeat(64));
});

test("key order does not affect the hash", () => {
  // Postgres reorders JSONB keys, so an entry written with one key order comes
  // back with another. Hashing raw JSON.stringify output meant the chain
  // verified in memory and broke on the first read from the database.
  const a = new AuditTrail("s5");
  const b = new AuditTrail("s5");

  const entryA = a.record({
    actor: "agent",
    action: "AE_RECORDED",
    entity: "AdverseEvent",
    entityId: "AE-001",
    after: { verbatimTerm: "tired", codedTerm: "Fatigue", grade: 3, ongoing: true },
    reason: "captured",
  });
  const entryB = b.record({
    actor: "agent",
    action: "AE_RECORDED",
    entity: "AdverseEvent",
    entityId: "AE-001",
    // Same data, the order Postgres would hand back.
    after: { ongoing: true, grade: 3, codedTerm: "Fatigue", verbatimTerm: "tired" },
    reason: "captured",
  });

  // Timestamps differ, so compare by rehydrating B's payload under A's metadata.
  const rebuilt = AuditTrail.rehydrate("s5", [
    { ...entryA, after: entryB.after },
  ]);
  assert.deepEqual(rebuilt.verifyChain(), { valid: true });
});

test("nested key order also does not affect the hash", () => {
  const trail = new AuditTrail("s6");
  const entry = trail.record({
    actor: "agent",
    action: "SAFETY_SCREEN_ITEM_RECORDED",
    entity: "SafetyScreenItem",
    entityId: "fever",
    after: { itemId: "fever", answer: true, ctx: { z: 1, a: { y: 2, b: 3 } } },
    reason: "answered",
  });
  const reordered = AuditTrail.rehydrate("s6", [
    { ...entry, after: { ctx: { a: { b: 3, y: 2 }, z: 1 }, answer: true, itemId: "fever" } },
  ]);
  assert.deepEqual(reordered.verifyChain(), { valid: true });
});

test("array order is still significant", () => {
  // Element order is data. Canonicalisation must not sort it away.
  const trail = new AuditTrail("s7");
  const entry = trail.record({
    actor: "agent",
    action: "ESCALATED",
    entity: "Escalation",
    after: { relatedEventIds: ["AE-001", "AE-002"] },
    reason: "escalated",
  });
  const swapped = AuditTrail.rehydrate("s7", [
    { ...entry, after: { relatedEventIds: ["AE-002", "AE-001"] } },
  ]);
  assert.equal(swapped.verifyChain().valid, false);
});
