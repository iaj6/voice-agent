/**
 * Withdrawal, enforced where the system first knows who is calling.
 *
 * The gap this closes was live and slightly embarrassing: the safety net matched
 * "withdraw from the study" and escalated it, and nothing recorded the resulting
 * status, so the next scheduled call went ahead exactly as before. The intent was
 * captured, paged, and ignored.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/agent/tools.ts";
import { __setSessionStore, getSessionStore } from "../lib/store/session-store.ts";
import { __setKeyStore } from "../lib/store/keys.ts";
import {
  __setSubjectStore,
  getSubjectStore,
  isWithdrawn,
} from "../lib/store/subjects.ts";
import type { CheckInSession } from "../lib/store/session.ts";

const VERIFY = { subject_id: "001-0042", date_of_birth: "1958-03-11" };
const AE = {
  verbatim_term: "I've been very tired",
  coded_term: "Fatigue",
  onset_description: "this week",
  ongoing: true,
  grade: 2,
  grade_rationale: "Cut back.",
  limits_self_care: false,
  spontaneous: true,
};

beforeEach(() => {
  __setSessionStore(null);
  __setKeyStore(null);
  __setSubjectStore(null);
  delete process.env.DATABASE_URL;
});

async function call(): Promise<CheckInSession> {
  const session = await getSessionStore().create();
  session.subjectUtterances = ["I've been very tired"];
  return session;
}

test("a withdrawn participant is not verified, and nothing clinical is collected", async () => {
  await getSubjectStore().withdraw(VERIFY.subject_id, "Dana Whitfield, RN", "Called the site.");

  const session = await call();
  const out = await executeTool(session, "verify_subject", VERIFY);

  assert.equal(out.isError, true);
  assert.equal((out.result as Record<string, unknown>).withdrawn, true);
  assert.equal(session.subject, null, "a withdrawn participant was verified");

  // The write path is gated on verification, so nothing can be recorded.
  const ae = await executeTool(session, "record_adverse_event", AE);
  assert.equal(ae.isError, true);
  assert.equal(session.adverseEvents.length, 0);
});

test("the refusal is on the record, with who accepted the withdrawal", async () => {
  await getSubjectStore().withdraw(VERIFY.subject_id, "Dana Whitfield, RN", "Called the site.");
  const session = await call();
  await executeTool(session, "verify_subject", VERIFY);

  const entry = session.audit.all().find((e) => e.action === "WITHDRAWN_SUBJECT_REFUSED");
  assert.ok(entry, "a call to a withdrawn participant left no trace");
  assert.match(String(entry.reason), /retained/i, "the entry should say prior data is kept");
  assert.equal(session.audit.verifyChain().valid, true);
});

test("a participant who has not withdrawn is unaffected", async () => {
  const session = await call();
  const out = await executeTool(session, "verify_subject", VERIFY);
  assert.equal((out.result as Record<string, unknown>).verified, true);
  assert.equal(session.subject?.subjectId, VERIFY.subject_id);
});

test("withdrawal does not delete what was already collected", async () => {
  // The ICH E6 and EDPB 3/2019 position: withdrawal stops future collection and
  // does not unmake data lawfully gathered before it. Destruction is separate,
  // and separately authorised.
  const store = getSessionStore();
  const before = await call();
  await executeTool(before, "verify_subject", VERIFY);
  await executeTool(before, "record_adverse_event", AE);
  await store.save(before);

  await getSubjectStore().withdraw(VERIFY.subject_id, "Dana Whitfield, RN", "");

  const reloaded = (await store.get(before.id))!;
  assert.equal(reloaded.adverseEvents.length, 1, "withdrawal erased an earlier record");
  assert.equal(reloaded.adverseEvents[0].codedTerm, "Fatigue");
});

test("reinstating a participant restores ordinary check-ins", async () => {
  await getSubjectStore().withdraw(VERIFY.subject_id, "Dana Whitfield, RN", "In error.");
  await getSubjectStore().reinstate(VERIFY.subject_id, "Dana Whitfield, RN");

  const session = await call();
  const out = await executeTool(session, "verify_subject", VERIFY);
  assert.equal((out.result as Record<string, unknown>).verified, true);
});

test("reinstatement supersedes the withdrawal rather than erasing it", async () => {
  const store = getSubjectStore();
  await store.withdraw(VERIFY.subject_id, "Dana Whitfield, RN", "Called the site.");
  await store.reinstate(VERIFY.subject_id, "Dr Alvarez");

  const state = await store.get(VERIFY.subject_id);
  assert.ok(state?.withdrawnAt, "the withdrawal was erased; nothing records it happened");
  assert.equal(state.withdrawnBy, "Dana Whitfield, RN");
  assert.equal(state.reinstatedBy, "Dr Alvarez", "un-withdrawal is not attributable");
  assert.equal(isWithdrawn(state), false);
});

test("a fresh withdrawal after a reinstatement takes effect", async () => {
  const store = getSubjectStore();
  await store.withdraw(VERIFY.subject_id, "Dana Whitfield, RN", "First.");
  await store.reinstate(VERIFY.subject_id, "Dr Alvarez");
  await store.withdraw(VERIFY.subject_id, "Dana Whitfield, RN", "Second, and final.");

  assert.equal(isWithdrawn(await store.get(VERIFY.subject_id)), true);
  const session = await call();
  const out = await executeTool(session, "verify_subject", VERIFY);
  assert.equal(out.isError, true, "a re-withdrawn participant was verified");
});
