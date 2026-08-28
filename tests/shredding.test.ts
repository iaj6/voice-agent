/**
 * Crypto-shredding, against real Postgres.
 *
 * The claim: destroy the key and the subject's content is unrecoverable, while
 * the record still proves it existed and its audit trail still verifies. Both
 * halves matter. A record that vanishes cannot answer "did you hold data on this
 * person"; a chain that stops verifying after a lawful destruction looks like
 * tampering rather than compliance.
 */

import { test, before, beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { __resetDb } from "../lib/store/db.ts";
import { __setSessionStore, getSessionStore } from "../lib/store/session-store.ts";
import { __setKeyStore, getKeyStore } from "../lib/store/keys.ts";
import { executeTool } from "../lib/agent/tools.ts";
import { createScratchDb, databaseAvailable, type ScratchDb } from "./helpers/scratch-db.ts";
import { getDeliveryStore } from "../lib/store/deliveries.ts";
import { noteAcknowledgement } from "../lib/escalation/acknowledge.ts";

const VERIFY = { subject_id: "001-0042", date_of_birth: "1958-03-11" };
const SPOKEN = ["I've been very tired, I couldn't shower Tuesday"];
/** What the agent writes about a participant's week. The most readable single
 *  paragraph about them in the database, and it has its own column. */
const SUMMARY =
  "Reports worsening fatigue since Tuesday; needed her daughter's help to shower.";

const AE = {
  verbatim_term: "I've been very tired",
  coded_term: "Fatigue",
  onset_description: "this week",
  ongoing: true,
  grade: 2,
  grade_rationale: "Cut back on errands.",
  limits_self_care: false,
  spontaneous: true,
};

let scratch: ScratchDb | null = null;
let raw: NeonQueryFunction<false, false> | null = null;
const originalUrl = process.env.DATABASE_URL;

describe(
  "crypto-shredding",
  { skip: databaseAvailable() ? false : "DATABASE_URL not set" },
  () => {
    before(async () => {
      scratch = await createScratchDb();
      process.env.DATABASE_URL = scratch.url;
      raw = neon(scratch.url);
      __resetDb();
      __setSessionStore(null);
      __setKeyStore(null);
    });

    after(async () => {
      raw = null;
      __setSessionStore(null);
      __setKeyStore(null);
      __resetDb();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      await scratch?.drop();
    });

    beforeEach(async () => {
      await raw!.query(
        `update check_in_session set completed_at = now() where completed_at is null`,
      );
    });

    async function recordedCall() {
      const store = getSessionStore();
      const session = await store.create();
      session.subjectUtterances = [...SPOKEN];
      await executeTool(session, "verify_subject", VERIFY);
      await executeTool(session, "record_adverse_event", AE);
      await store.save(session);
      return session;
    }

    test("subject speech is not stored in the clear", async () => {
      const session = await recordedCall();
      const rows = await raw!.query(
        `select record::text as record, messages::text as messages
           from check_in_session where id = $1`,
        [session.id],
      );
      const stored = rows[0].record + rows[0].messages;

      assert.ok(
        !stored.includes("couldn't shower Tuesday"),
        "the subject's own words are in the database in plaintext",
      );
      assert.ok(
        !stored.includes("1958-03-11"),
        "the date of birth is in the database in plaintext",
      );
      // Structured clinical data stays readable — it is what a coordinator
      // reviews and it identifies nobody on its own.
      assert.ok(stored.includes("Fatigue"), "the coded term should stay readable");
    });

    test("the audit trail is not a plaintext copy of the transcript", async () => {
      const session = await recordedCall();
      const rows = await raw!.query(
        `select coalesce(string_agg(after_value::text, ' '), '') as v
           from audit_entry where session_id = $1`,
        [session.id],
      );
      assert.ok(
        !rows[0].v.includes("couldn't shower Tuesday"),
        "audit_entry holds the subject's words in the clear",
      );
    });

    /** A call that also *finished*, so the summary column is populated. */
    async function completedCall() {
      const store = getSessionStore();
      const session = await store.create();
      session.subjectUtterances = [...SPOKEN];
      await executeTool(session, "verify_subject", VERIFY);
      await executeTool(session, "record_adverse_event", AE);
      await executeTool(session, "complete_check_in", {
        summary: SUMMARY,
        ended_early: false,
      });
      await store.save(session);
      return session;
    }

    test("no subject-derived free text survives anywhere in the row", async () => {
      // Four channels were missed for four sprints because sealRecord is a
      // per-field list and the list drifted behind the record: the grade
      // rationale, the escalation reason, and the summary — which is its own
      // column, sitting beside the record rather than inside it, and is the most
      // readable single paragraph about a participant in the database.
      // Completed, not just recorded: the summary is written by
      // complete_check_in and lives in its own column, and a fixture that never
      // finishes the call leaves it null — so a test built on one would pass
      // whether or not the summary is sealed. Confirmed by mutation.
      const session = await completedCall();
      await getKeyStore().shredSubject(VERIFY.subject_id, "Retention elapsed.");

      const rows = await raw!.query(
        `select coalesce(record::text, '') || ' ' || coalesce(summary, '') || ' ' ||
                coalesce((select string_agg(after_value::text || ' ' || reason, ' ')
                            from audit_entry where session_id = c.id), '') as everything
           from check_in_session c where c.id = $1`,
        [session.id],
      );
      const everything: string = rows[0].everything;

      for (const phrase of [
        AE.verbatim_term,
        AE.grade_rationale,
        AE.onset_description,
        SUMMARY,
        VERIFY.date_of_birth,
        ...SPOKEN,
      ]) {
        assert.ok(
          phrase.length < 4 || !everything.includes(phrase),
          `"${phrase}" survived the shred in the clear`,
        );
      }
    });

    test("a spoken date of birth is reachable by erasure even when verification failed", async () => {
      // The caller says their date of birth aloud before anyone knows whether it
      // matches. On a failure the key was never bound to a subject, and
      // shredSubject finds keys *by* subject id — so the most identifying
      // sentence in the call sat in a session no erasure request could reach.
      const store = getSessionStore();
      const session = await store.create();
      session.subjectUtterances = ["It's 001-0042.", "March the eleventh, 1958."];
      await executeTool(session, "verify_subject", {
        subject_id: VERIFY.subject_id,
        date_of_birth: "1958-03-12", // one digit out, as a mishearing would be
      });
      await store.save(session);

      const destroyed = await getKeyStore().shredSubject(
        VERIFY.subject_id,
        "Erasure requested.",
      );
      assert.ok(destroyed > 0, "the failed session's key was unreachable by erasure");

      const reloaded = (await store.get(session.id))!;
      assert.equal(reloaded.shredded, true);
      assert.ok(
        !JSON.stringify(reloaded.subjectUtterances).includes("1958"),
        "the spoken date of birth survived",
      );
    });

    test("shredding clears the subject id from delivery rows too", async () => {
      // escalation_delivery carries subject_id in the clear by necessity — the
      // alarm query needs it — so shredding has to reach it explicitly, or
      // "that subject had an emergency escalation on that date" survives an
      // erasure request. shredSubject does this; the only shipped destruction
      // *tool* ran its own UPDATE and skipped it, while printing that the
      // content was unrecoverable.
      const session = await completedCall();
      await getDeliveryStore().queue(
        {
          sessionId: session.id,
          escalationId: "ESC-001",
          subjectId: VERIFY.subject_id,
          urgency: "emergency",
          channel: "test",
          destination: "coordinator@example.test",
          attempt: 1,
          tier: "primary",
          deadlineAt: new Date(),
        },
        "tok-shred-test",
      );

      await getKeyStore().shredSubject(VERIFY.subject_id, "Erasure requested.");

      const rows = await raw!.query(
        `select coalesce(string_agg(coalesce(subject_id, ''), ' '), '') as ids
           from escalation_delivery where session_id = $1`,
        [session.id],
      );
      assert.ok(
        !rows[0].ids.includes(VERIFY.subject_id),
        "the subject id survived the shred in escalation_delivery",
      );
    });

    test("two writers keep both entries and the chain still verifies", async () => {
      // A coordinator acknowledging an escalation while the call is still running
      // is the ordinary case, and each writer holds its own in-memory trail with
      // its own counter. Both mint the same next sequence number.
      //
      // Three things you can do. Drop one silently — a hole in the record, which
      // is what the code did. Throw — which was the fix, and was worse: an
      // ordinary race became a turn that failed for the participant and kept
      // failing, because the conflicting entry stayed in memory. Or rebase, and
      // lose nothing.
      // Pinned to the scratch database. Another test file deletes DATABASE_URL
      // mid-suite, so getSessionStore() here can hand back the memory store —
      // which is a different implementation of the thing being tested, and this
      // test silently proved nothing until it printed its own store kind.
      process.env.DATABASE_URL = scratch!.url;
      __resetDb();
      __setSessionStore(null);

      const store = getSessionStore();
      assert.equal(store.kind, "postgres", "this test must exercise the real store");
      const live = await store.create();
      await store.save(live);

      const sweeper = (await store.get(live.id))!;

      live.audit.record({
        actor: "agent",
        action: "AE_RECORDED",
        entity: "AdverseEvent",
        entityId: "AE-1",
        reason: "written by the live call",
      });
      await store.save(live);

      sweeper.audit.record({
        actor: "coordinator",
        action: "ESCALATION_ACKNOWLEDGED",
        entity: "Escalation",
        entityId: "ESC-1",
        reason: "written by the coordinator, at the same sequence number",
      });
      await store.appendAudit(sweeper);

      const reloaded = (await store.get(live.id))!;
      const actions = reloaded.audit.all().map((e) => e.action);
      assert.ok(actions.includes("AE_RECORDED"), "the live call's entry was lost");
      assert.ok(
        actions.includes("ESCALATION_ACKNOWLEDGED"),
        "the coordinator's entry was lost",
      );
      assert.equal(reloaded.audit.verifyChain().valid, true, "the chain broke");

      // Sequence numbers stay unique and contiguous after the rebase.
      const seqs = reloaded.audit.all().map((e) => e.seq);
      assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), "seq collided");

      // And the live session can still write afterwards, rather than being stuck
      // throwing for the rest of the call.
      live.audit.record({
        actor: "agent",
        action: "CHECK_IN_COMPLETED",
        entity: "CheckInSession",
        entityId: live.id,
        reason: "the call continued",
      });
      await store.appendAudit(live);
      const after = (await store.get(live.id))!;
      assert.equal(after.audit.verifyChain().valid, true);
      assert.ok(after.audit.all().some((e) => e.action === "CHECK_IN_COMPLETED"));
    });

    test("acknowledging an escalation lands on the record's own trail", async () => {
      // The only action a human takes in this whole system, and it was written to
      // escalation_delivery and nowhere else — so the hash-chained trail, which
      // is the record's evidence of what happened to it, had no entry for the
      // single human decision in the call. 21 CFR 11.10(e) wants operator
      // actions on that trail; this was the one operator action there was.
      const store = getSessionStore();
      const session = await store.create();
      await store.save(session);

      const token = "tok-ack-trail-test";
      await getDeliveryStore().queue(
        {
          sessionId: session.id,
          escalationId: "ESC-001",
          subjectId: VERIFY.subject_id,
          urgency: "emergency",
          channel: "test",
          destination: "coordinator@example.test",
          attempt: 1,
          tier: "primary",
          deadlineAt: new Date(),
        },
        token,
      );

      const acknowledged = await getDeliveryStore().acknowledge(token, "Dana Whitfield, RN");
      assert.ok(acknowledged, "the acknowledgement did not take");

      const result = await noteAcknowledgement(acknowledged!, "Dana Whitfield, RN");
      assert.equal(result.recorded, true, result.detail ?? "");

      const reloaded = (await store.get(session.id))!;
      const entry = reloaded.audit
        .all()
        .find((e) => e.action === "ESCALATION_ACKNOWLEDGED");
      assert.ok(entry, "the only human action in the system is not on the trail");
      assert.equal(entry.actor, "coordinator");
      assert.equal(entry.entityId, "ESC-001");
      assert.equal(reloaded.audit.verifyChain().valid, true, "the chain broke");

      // The name is in the sealed value, never in `reason` — that column is
      // stored in the clear in a table that rejects UPDATE and DELETE.
      assert.ok(
        !entry.reason.includes("Dana"),
        "a named person ended up in the unerasable column",
      );
    });

    test("a sealed record reads back exactly as it was written", async () => {
      const session = await recordedCall();
      const reloaded = (await getSessionStore().get(session.id))!;

      assert.deepEqual(reloaded.subjectUtterances, SPOKEN);
      assert.equal(reloaded.subject?.subjectId, VERIFY.subject_id);
      assert.equal(reloaded.adverseEvents[0].verbatimTerm, AE.verbatim_term);
      assert.equal(reloaded.audit.verifyChain().valid, true);
    });

    test("shredding destroys the content and leaves the record standing", async () => {
      const session = await recordedCall();
      const destroyed = await getKeyStore().shredSubject(
        VERIFY.subject_id,
        "Retention period elapsed; sponsor authorised destruction.",
      );
      assert.ok(destroyed > 0, "no keys were destroyed");

      const rows = await raw!.query(
        `select id, subject_id, completed_at from check_in_session where id = $1`,
        [session.id],
      );
      assert.equal(rows.length, 1, "the record vanished; it should still prove it existed");

      const reloaded = (await getSessionStore().get(session.id))!;
      assert.equal(reloaded.shredded, true, "the record does not say it was destroyed");
      assert.deepEqual(
        reloaded.subjectUtterances,
        [],
        "content survived the destruction of its key",
      );
      assert.equal(
        reloaded.adverseEvents[0].verbatimTerm,
        "[destroyed]",
        "the verbatim term survived",
      );
      // Shaped like what it replaced, so nothing downstream throws on it.
      assert.doesNotThrow(() => [...reloaded.subjectUtterances]);
      // Grade and coded term are structured, not personal, and stay.
      assert.equal(reloaded.adverseEvents[0].grade, 2);
    });

    test("the chain still verifies after a lawful destruction", async () => {
      const session = await recordedCall();
      await getKeyStore().shredSubject(VERIFY.subject_id, "Retention elapsed.");

      const reloaded = (await getSessionStore().get(session.id))!;
      assert.equal(
        reloaded.audit.verifyChain().valid,
        true,
        "a destroyed record now looks tampered with rather than destroyed",
      );
      assert.ok(reloaded.audit.all().length > 0, "the trail itself went missing");
    });

    test("the destruction is provable, with a reason and a time", async () => {
      const session = await recordedCall();
      await getKeyStore().shredSubject(VERIFY.subject_id, "Sponsor authorised 2026-08-21.");

      const rows = await raw!.query(
        `select key, destroyed_at, destroyed_reason from session_key where session_id = $1`,
        [session.id],
      );
      assert.equal(rows.length, 1, "the key row was deleted, so nothing proves destruction");
      assert.equal(rows[0].key, null);
      assert.notEqual(rows[0].destroyed_at, null);
      assert.match(rows[0].destroyed_reason, /Sponsor authorised/);
    });

    test("nothing can be written to a shredded record", async () => {
      const store = getSessionStore();
      const session = await store.create();
      session.subjectUtterances = [...SPOKEN];
      await executeTool(session, "verify_subject", VERIFY);
      await store.save(session);

      await getKeyStore().shredSubject(VERIFY.subject_id, "Retention elapsed.");

      await assert.rejects(
        () => store.save(session),
        /shredded/,
        "a destroyed record accepted a plaintext write, silently undoing the destruction",
      );
    });

    test("a session that predates sealing is still writable", async () => {
      // Migration 0003 created session_key empty, so every row written before
      // that deploy has no key. Treating "no key" as "shredded" made all of them
      // unwritable — a call in flight at deploy time would fail on its next
      // write, with an error announcing a destruction that never happened.
      const store = getSessionStore();
      const session = await store.create();
      await raw!.query(`delete from session_key where session_id = $1`, [session.id]);

      session.subjectUtterances = [...SPOKEN];
      await executeTool(session, "verify_subject", VERIFY);
      await store.save(session);

      const rows = await raw!.query(
        `select key is not null as live from session_key where session_id = $1`,
        [session.id],
      );
      assert.equal(rows[0]?.live, true, "no key was minted for a legacy session");
    });

    test("a withdrawal refusal still binds the key it sealed under", async () => {
      // The refusal returns before session.subject is set, so nothing bound the
      // key to the subject — and shredSubject finds keys by subject_id. The
      // session still holds the spoken subject ID and date of birth, so the
      // participant most likely to ask for erasure was the one the shredder
      // silently skipped.
      const { getSubjectStore } = await import("../lib/store/subjects.ts");
      await getSubjectStore().withdraw("001-0055", "Dana Whitfield, RN", "");

      const store = getSessionStore();
      const session = await store.create();
      session.subjectUtterances = ["001-0055", "November 2nd, 1971"];
      const out = await executeTool(session, "verify_subject", {
        subject_id: "001-0055",
        date_of_birth: "1971-11-02",
      });
      assert.equal(out.isError, true, "a withdrawn participant was verified");

      const bound = await raw!.query(
        `select subject_id from session_key where session_id = $1`,
        [session.id],
      );
      assert.equal(
        bound[0]?.subject_id,
        "001-0055",
        "the key is unbound, so subject-level shredding will never reach it",
      );

      const destroyed = await getKeyStore().shredSubject("001-0055", "Erasure request.");
      assert.ok(destroyed > 0, "shredSubject skipped the refused call entirely");
    });

    test("nothing can be appended to a shredded record, including on supersede", async () => {
      const store = getSessionStore();
      const session = await recordedCall();
      await getKeyStore().shredSubject(VERIFY.subject_id, "Retention elapsed.");

      // save() already refused; supersede() appends audit entries by a different
      // path, and those would land as plaintext in a table that rejects DELETE.
      await assert.rejects(
        () => store.supersede(session, "00000000-0000-0000-0000-0000000000ff"),
        /shredded/,
        "a shredded record gained audit entries that can never be destroyed",
      );
    });

    test("one subject's destruction does not touch another's", async () => {
      const other = { subject_id: "001-0055", date_of_birth: "1971-11-02" };
      const store = getSessionStore();

      const mine = await recordedCall();
      const theirs = await store.create();
      theirs.subjectUtterances = ["I've had a headache"];
      await executeTool(theirs, "verify_subject", other);
      await store.save(theirs);

      await getKeyStore().shredSubject(VERIFY.subject_id, "Retention elapsed.");

      const shredded = (await store.get(mine.id))!;
      const intact = (await store.get(theirs.id))!;
      assert.equal(shredded.shredded, true);
      assert.deepEqual(shredded.subjectUtterances, []);
      assert.deepEqual(
        intact.subjectUtterances,
        ["I've had a headache"],
        "shredding one subject destroyed another subject's record",
      );
    });
  },
);
