/**
 * The resume path, against real Postgres.
 *
 * resume-idempotency.test.ts covers the same behaviour on the in-memory store,
 * which is where the logic is easy to read. It is not where the logic actually
 * runs. Two of these rules live in SQL and nowhere else — the leasing UPDATE
 * that makes a claim atomic, and the trigger that locks a completed row — so a
 * suite that only exercised the memory store was asserting a reimplementation
 * of the control rather than the control.
 *
 * Skips when DATABASE_URL is absent, which is the normal state in CI. A skipped
 * test is honest; a passing test that never reached a database is not.
 */

import { test, before, beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { __resetDb } from "../lib/store/db.ts";
import { schemaVersion } from "../lib/store/migrate.ts";
import {
  __setSessionStore,
  getSessionStore,
  RESUME_IDLE_MS,
  RESUME_WINDOW_MS,
} from "../lib/store/session-store.ts";
import { executeTool } from "../lib/agent/tools.ts";
import { createScratchDb, databaseAvailable, type ScratchDb } from "./helpers/scratch-db.ts";

const VERIFY = { subject_id: "001-0042", date_of_birth: "1958-03-11", respondent: "self" };
const SPOKEN = ["I've been very tired, I couldn't shower Tuesday"];

let scratch: ScratchDb | null = null;

/**
 * A direct handle, for setting up states the store has no API for — ageing a
 * row, or attempting the writes the triggers are supposed to reject.
 *
 * Over HTTP rather than a pool: a pooled connection outlives end() long enough
 * to still be attached when the scratch database is dropped, and DROP DATABASE
 * ... FORCE then kills it mid-teardown. Each HTTP query is its own short-lived
 * backend, so there is nothing left holding the database open.
 */
let raw: NeonQueryFunction<false, false> | null = null;
const originalUrl = process.env.DATABASE_URL;

describe("resume against Postgres", { skip: databaseAvailable() ? false : "DATABASE_URL not set" }, () => {
  before(async () => {
    scratch = await createScratchDb();
    process.env.DATABASE_URL = scratch.url;
    raw = neon(scratch.url);
    __resetDb();
    __setSessionStore(null);
  });

  after(async () => {
    raw = null;
    __setSessionStore(null);
    __resetDb();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    await scratch?.drop();
  });

  /** Ages the stored row directly. The trigger only guards completed rows. */
  async function age(id: string, ms: number) {
    await raw!.query(
      `update check_in_session set updated_at = now() - ($2 || ' milliseconds')::interval
        where id = $1`,
      [id, String(ms)],
    );
  }

  async function backdateCreated(id: string, ms: number) {
    await raw!.query(
      `update check_in_session set created_at = now() - ($2 || ' milliseconds')::interval
        where id = $1`,
      [id, String(ms)],
    );
  }

  /**
   * Every test uses the same subject, so rows left open by an earlier test are
   * claimable by a later one — which would let an assertion pass by claiming
   * the wrong record. Closing them is the only way to reset: audit_entry
   * rejects DELETE, and check_in_session rows are referenced with
   * `on delete restrict`, so nothing here can be removed. null -> now() is the
   * one update the lock trigger permits.
   */
  beforeEach(async () => {
    await raw!.query(
      `update check_in_session set completed_at = now()
        where completed_at is null`,
    );
  });

  async function droppedCall() {
    const store = getSessionStore();
    const session = await store.create();
    session.subjectUtterances = [...SPOKEN];
    await executeTool(session, "verify_subject", VERIFY);
    await store.save(session);
    await age(session.id, RESUME_IDLE_MS + 5_000);
    return session;
  }

  test("the store in use is actually Postgres", () => {
    assert.equal(getSessionStore().kind, "postgres");
  });

  test("an idle call for the same subject is claimed", async () => {
    const dropped = await droppedCall();
    const claimed = await getSessionStore().claimResumable(VERIFY.subject_id, "00000000-0000-0000-0000-000000000000");
    assert.equal(claimed?.id, dropped.id);
    assert.equal(claimed?.subject?.subjectId, VERIFY.subject_id);
  });

  test("a call that is still live is not claimed", async () => {
    const store = getSessionStore();
    const live = await store.create();
    live.subjectUtterances = [...SPOKEN];
    await executeTool(live, "verify_subject", VERIFY);
    await store.save(live); // updated_at = now(), so: not idle

    const claimed = await store.claimResumable(
      VERIFY.subject_id,
      "00000000-0000-0000-0000-000000000001",
    );
    assert.equal(claimed, null, "a live call was claimed as dropped");

    const still = await store.get(live.id);
    assert.equal(still?.completedAt, null, "a live call was locked");
  });

  test("two redials race for one dropped call and only one wins", async () => {
    const dropped = await droppedCall();
    const store = getSessionStore();

    const [a, b] = await Promise.all([
      store.claimResumable(VERIFY.subject_id, "00000000-0000-0000-0000-00000000000a"),
      store.claimResumable(VERIFY.subject_id, "00000000-0000-0000-0000-00000000000b"),
    ]);

    const winners = [a, b].filter((s) => s?.id === dropped.id);
    assert.equal(winners.length, 1, "the same dropped call was carried forward twice");
    assert.equal([a, b].filter(Boolean).length, 1, "a second redial claimed something");
  });

  test("a call older than the resume window is left alone", async () => {
    const dropped = await droppedCall();
    await backdateCreated(dropped.id, RESUME_WINDOW_MS + 60_000);
    const claimed = await getSessionStore().claimResumable(
      VERIFY.subject_id,
      "00000000-0000-0000-0000-00000000000c",
    );
    assert.equal(claimed, null, `a call outside the window was claimed (${dropped.id})`);
  });

  test("a call marked not resumable is left alone", async () => {
    const store = getSessionStore();
    const dropped = await droppedCall();
    const loaded = (await store.get(dropped.id))!;
    loaded.resumable = false;
    await store.save(loaded);
    await age(dropped.id, RESUME_IDLE_MS + 5_000);

    const claimed = await store.claimResumable(
      VERIFY.subject_id,
      "00000000-0000-0000-0000-00000000000d",
    );
    assert.equal(claimed, null, `a call marked not resumable was claimed (${dropped.id})`);
  });

  test("superseding locks the row, and the database enforces it", async () => {
    const store = getSessionStore();
    const dropped = await droppedCall();
    const successor = await store.create();

    await store.supersede(dropped, successor.id);

    const locked = (await store.get(dropped.id))!;
    assert.notEqual(locked.completedAt, null);
    assert.match(locked.summary ?? "", new RegExp(successor.id));

    await assert.rejects(
      () => raw!.query(`update check_in_session set status = 'tampered' where id = $1`, [dropped.id]),
      /complete and locked/,
      "the trigger let a completed row be rewritten",
    );
  });

  test("a stale in-flight call cannot write over a record a redial closed", async () => {
    const store = getSessionStore();
    const dropped = await droppedCall();
    const successor = await store.create();
    await store.supersede(dropped, successor.id);

    // The original call's object, unaware it was superseded, tries to save on.
    const stale = (await store.get(dropped.id))!;
    stale.completedAt = null;
    stale.summary = "written after the record closed";

    await assert.rejects(
      () => store.save(stale),
      /closed by another process/,
      "a superseded call silently wrote on after being closed",
    );
  });

  test("a refused write leaves nothing behind on the audit trail", async () => {
    const store = getSessionStore();
    const live = await droppedCall();
    const successor = await store.create();
    await store.supersede(live, successor.id);

    // The original call, unaware it was superseded, records an adverse event.
    const stale = (await store.get(live.id))!;
    stale.completedAt = null;
    stale.subjectUtterances = [...SPOKEN];
    await executeTool(stale, "record_adverse_event", {
      verbatim_term: "I've been very tired",
      coded_term: "Fatigue",
      onset_description: "this week",
      ongoing: true,
      grade: 2,
      grade_rationale: "Cut back on errands.",
      limits_self_care: false,
      spontaneous: true,
    });
    await assert.rejects(() => store.save(stale), /closed by another process/);

    const reloaded = (await store.get(live.id))!;
    const trailClaims = reloaded.audit.all().some((e) => e.action === "AE_RECORDED");
    const recordHas = reloaded.adverseEvents.length > 0;

    // The chain verified even when this was broken — every entry was
    // individually well-formed. What was wrong was that the record disagreed
    // with its own trail, which the hash chain cannot see.
    assert.equal(reloaded.audit.verifyChain().valid, true);
    assert.equal(
      trailClaims,
      recordHas,
      "the audit trail records an adverse event the record does not contain",
    );
  });

  test("the audit chain still verifies after a Postgres round trip", async () => {
    const store = getSessionStore();
    const dropped = await droppedCall();
    const successor = await store.create();
    await store.supersede(dropped, successor.id);

    const reloaded = (await store.get(dropped.id))!;
    assert.ok(reloaded.audit.all().length > 0, "no audit entries came back");
    assert.equal(reloaded.audit.verifyChain().valid, true);
  });

  test("a heartbeat on a quiet line keeps the call unclaimable", async () => {
    const store = getSessionStore();
    const live = await droppedCall(); // aged: looks dropped
    await store.touch(live.id);

    const claimed = await store.claimResumable(
      VERIFY.subject_id,
      "00000000-0000-0000-0000-00000000000e",
    );
    assert.equal(claimed, null, "a live call was claimed despite a heartbeat");
  });

  test("touching a closed record does not raise the lock trigger", async () => {
    const store = getSessionStore();
    const dropped = await droppedCall();
    const successor = await store.create();
    await store.supersede(dropped, successor.id);
    await store.touch(dropped.id); // must be a no-op, not an exception
  });

  test("a record cannot be superseded twice", async () => {
    const store = getSessionStore();
    const dropped = await droppedCall();
    const successor = await store.create();
    await store.supersede(dropped, successor.id);

    dropped.completedAt = null;
    await assert.rejects(
      () => store.supersede(dropped, "00000000-0000-0000-0000-00000000000f"),
      /already closed/,
      "a lost race reported success, so the record could be carried forward twice",
    );
  });

  test("a new record records the schema that captured it", async () => {
    const session = await getSessionStore().create();
    const rows = await raw!.query(
      `select instrument from check_in_session where id = $1`,
      [session.id],
    );
    assert.equal(
      rows[0].instrument.schemaVersion,
      schemaVersion(),
      "the record cannot say what shape it was captured in",
    );
  });

  test("audit_entry rejects deletion", async () => {
    const dropped = await droppedCall();
    await assert.rejects(
      () => raw!.query(`delete from audit_entry where session_id = $1`, [dropped.id]),
      /append-only/,
    );
  });
});
