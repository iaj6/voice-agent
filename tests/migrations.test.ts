/**
 * Migrations, replayed against real Postgres.
 *
 * The claim being tested is "an empty database plus the migrations equals the
 * schema production runs". That is not a claim you can check in the abstract —
 * it is only true if the files actually apply, in order, to a real server.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksum,
  loadMigrations,
  migrate,
  MigrationDriftError,
  repair,
  schemaVersion,
  status,
} from "../lib/store/migrate.ts";
import { databaseAvailable } from "./helpers/scratch-db.ts";

/** Filesystem-only checks; these need no database and always run. */
describe("the migration set on disk", () => {
  test("is well-formed, sequential, and gap-free", () => {
    const migrations = loadMigrations();
    assert.ok(migrations.length > 0, "no migrations found");
    migrations.forEach((m, i) => {
      assert.equal(m.version, String(i + 1).padStart(4, "0"));
      assert.ok(m.sql.trim().length > 0, `${m.file} is empty`);
    });
  });

  test("a gap in the sequence is refused, not silently accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    try {
      writeFileSync(join(dir, "0001_first.sql"), "select 1;");
      writeFileSync(join(dir, "0003_third.sql"), "select 1;");
      assert.throws(() => loadMigrations(dir), /out of sequence/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unparseable filename is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    try {
      writeFileSync(join(dir, "add-widget.sql"), "select 1;");
      assert.throws(() => loadMigrations(dir), /NNNN_lower_snake_case/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only the baseline is allowed to be idempotent", () => {
    // Comments stripped first. Scanning raw text failed on 0002, whose comment
    // explains that it deliberately avoids "if not exists" — a check that reads
    // prose is checking the wrong thing.
    const statements = (sql: string) =>
      sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

    for (const m of loadMigrations().slice(1)) {
      assert.ok(
        !/if not exists|create or replace/i.test(statements(m.sql)),
        `${m.file} uses idempotent DDL. Only 0001 adopts an existing database; ` +
          "after that, a migration that cannot apply cleanly must fail loudly.",
      );
    }
  });

  test("the schema version is the highest migration", () => {
    assert.equal(schemaVersion(), loadMigrations().at(-1)?.version);
  });
});

describe(
  "replayed against Postgres",
  { skip: databaseAvailable() ? false : "DATABASE_URL not set" },
  () => {
    let admin: Pool;
    let scratch: Pool;
    let name = "";

    before(async () => {
      const adminUrl =
        process.env.VOICE_AGENT_TEST_DATABASE_URL_UNPOOLED ??
        process.env.VOICE_AGENT_TEST_DATABASE_URL ??
        "";
      admin = new Pool({ connectionString: adminUrl });
      name = `va_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await admin.query(`create database ${name}`);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      scratch = new Pool({ connectionString: url.toString() });
      // Dropping the scratch database terminates whatever the pool still holds.
      // Unhandled, that arrives as an uncaughtException during teardown and
      // fails a run in which every test passed.
      scratch.on("error", () => {});
      admin.on("error", () => {});
    });

    after(async () => {
      await scratch?.end();
      // end() resolves before the sockets have finished closing.
      await new Promise((r) => setTimeout(r, 250));
      try {
        await admin.query(`drop database if exists ${name} with (force)`);
      } finally {
        await admin?.end();
      }
    });

    test("an empty database becomes the production schema", async () => {
      const { applied } = await migrate(scratch);
      assert.equal(applied.length, loadMigrations().length);

      const tables = await scratch.query(
        `select table_name from information_schema.tables
          where table_schema = 'public' order by table_name`,
      );
      assert.deepEqual(
        tables.rows.map((r) => r.table_name),
        [
          "audit_entry",
          "check_in_session",
          "escalation_delivery",
          "schema_migration",
          "session_key",
          "subject_state",
        ],
      );

      const triggers = await scratch.query(
        `select trigger_name from information_schema.triggers
          where trigger_schema = 'public'`,
      );
      const names = triggers.rows.map((r) => r.trigger_name);
      assert.ok(names.includes("audit_entry_no_mutate"), "append-only guard missing");
      assert.ok(names.includes("check_in_session_lock"), "completion lock missing");

      const idx = await scratch.query(
        `select indexname from pg_indexes where tablename = 'check_in_session'`,
      );
      assert.ok(
        idx.rows.some((r) => r.indexname === "check_in_session_open_idx"),
        "0002 did not apply, so migrations after the baseline are not running",
      );

      // 0003: a key row must be all-key or all-destroyed, never half of each.
      //
      // A real session row first. The earlier version used an id with no session
      // behind it, so the foreign key fired before the check constraint was ever
      // reached — the assertion passed whether or not 0003 defined the check at
      // all, which is the same as not testing it.
      const sessionId = "11111111-1111-1111-1111-111111111111";
      await scratch.query(
        `insert into check_in_session (id, status, record, messages)
         values ($1, 'awaiting_verification', '{}'::jsonb, '[]'::jsonb)`,
        [sessionId],
      );
      await assert.rejects(
        () =>
          scratch.query(
            `insert into session_key (session_id, key, destroyed_at)
             values ($1, null, null)`,
            [sessionId],
          ),
        /session_key_destruction_is_complete/,
        "0003 applied but its destruction check does not hold",
      );
    });

    test("running again applies nothing", async () => {
      const { applied } = await migrate(scratch);
      assert.deepEqual(applied, []);
      const state = await status(scratch);
      assert.deepEqual(state.pending, []);
      assert.deepEqual(state.drifted, []);
    });

    test("every applied migration is recorded with its checksum", async () => {
      const state = await status(scratch);
      for (const m of loadMigrations()) {
        const row = state.applied.find((a) => a.version === m.version);
        assert.ok(row, `${m.file} applied but not recorded`);
        assert.equal(row.checksum, m.checksum);
        assert.ok(row.execution_ms >= 0);
      }
    });

    test("an applied migration that changed on disk halts the runner", async () => {
      const real = loadMigrations();
      const tampered = real.map((m, i) =>
        i === 0 ? { ...m, sql: `${m.sql}\n-- edited`, checksum: checksum(`${m.sql}\n-- edited`) } : m,
      );
      await assert.rejects(
        () => migrate(scratch, { migrations: tampered }),
        MigrationDriftError,
        "a schema that no longer matches its recorded history was accepted",
      );
    });

    test("repair re-records a drifted checksum, and only when asked", async () => {
      const real = loadMigrations();
      const edited = `${real[0].sql}\n-- edited`;
      const tampered = real.map((m, i) =>
        i === 0 ? { ...m, sql: edited, checksum: checksum(edited) } : m,
      );

      const fixed = await repair(scratch, tampered);
      assert.equal(fixed.length, 1);
      assert.deepEqual((await status(scratch, tampered)).drifted, []);

      // Put it back, so the ledger matches the files this checkout actually has.
      await repair(scratch, real);
      assert.deepEqual((await status(scratch, real)).drifted, []);
    });

    test("two runners racing do not both try to apply", async () => {
      // The hazard the switch away from idempotent DDL introduced: a CI deploy
      // step and a manual run both read the same pending list, and the loser
      // hits "relation already exists" — 0002 onward deliberately omit `if not
      // exists` — then reports that nothing was applied, which is false and
      // sends the operator after the wrong problem.
      const url = new URL(
        process.env.VOICE_AGENT_TEST_DATABASE_URL_UNPOOLED ??
          process.env.VOICE_AGENT_TEST_DATABASE_URL ??
          "",
      );
      const raceName = `va_race_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      await admin.query(`create database ${raceName}`);
      url.pathname = `/${raceName}`;

      const a = new Pool({ connectionString: url.toString() });
      const b = new Pool({ connectionString: url.toString() });
      a.on("error", () => {});
      b.on("error", () => {});
      try {
        const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
        const total = ra.applied.length + rb.applied.length;
        assert.equal(
          total,
          loadMigrations().length,
          "a migration was applied twice, or one runner's work went missing",
        );
        const state = await status(a);
        assert.deepEqual(state.pending, []);
      } finally {
        await a.end();
        await b.end();
        await new Promise((r) => setTimeout(r, 250));
        await admin.query(`drop database if exists ${raceName} with (force)`);
      }
    });

    test("status does not create the ledger it reports on", async () => {
      const url = new URL(
        process.env.VOICE_AGENT_TEST_DATABASE_URL_UNPOOLED ??
          process.env.VOICE_AGENT_TEST_DATABASE_URL ??
          "",
      );
      const freshName = `va_ro_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      await admin.query(`create database ${freshName}`);
      url.pathname = `/${freshName}`;
      const fresh = new Pool({ connectionString: url.toString() });
      fresh.on("error", () => {});
      try {
        const state = await status(fresh);
        assert.equal(state.applied.length, 0);
        assert.equal(state.pending.length, loadMigrations().length);

        const made = await fresh.query(
          `select to_regclass('public.schema_migration') as t`,
        );
        assert.equal(
          made.rows[0].t,
          null,
          "reporting on a database changed it — --status is documented as read-only",
        );
      } finally {
        await fresh.end();
        await new Promise((r) => setTimeout(r, 250));
        await admin.query(`drop database if exists ${freshName} with (force)`);
      }
    });

    test("a database ahead of this checkout is refused", async () => {
      const short = loadMigrations().slice(0, -1);
      await assert.rejects(
        () => migrate(scratch, { migrations: short }),
        /no file on disk/,
        "an older checkout silently accepted a newer database",
      );
    });

    test("DDL that cannot be recorded is rolled back with it", async () => {
      // The transaction's real job. If the migration applies but the ledger
      // insert fails, the database has schema it has no record of running, and
      // the next attempt tries to apply it again. A null name violates NOT NULL,
      // so the insert fails after the DDL has already succeeded.
      const unrecordable = [
        ...loadMigrations(),
        {
          version: "9998",
          name: null as unknown as string,
          file: "9998_unrecordable.sql",
          sql: "create table orphan_ddl (id int);",
          checksum: "y".repeat(64),
        },
      ];
      await assert.rejects(
        () => migrate(scratch, { migrations: unrecordable }),
        /Nothing from it was applied and it is not recorded/,
      );

      const left = await scratch.query(`select to_regclass('public.orphan_ddl') as t`);
      assert.equal(
        left.rows[0].t,
        null,
        "the table survived a migration that was never recorded, so the next run " +
          "will try to create it again",
      );
    });

    test("a failing migration leaves nothing behind and is not recorded", async () => {
      const broken = [
        ...loadMigrations(),
        {
          version: "9999",
          name: "broken",
          file: "9999_broken.sql",
          sql: "create table will_not_exist (id int); select from nowhere;",
          checksum: "x".repeat(64),
        },
      ];
      await assert.rejects(
        () => migrate(scratch, { migrations: broken }),
        /Nothing from it was applied and it is not recorded/,
      );

      const left = await scratch.query(`select to_regclass('public.will_not_exist') as t`);
      assert.equal(left.rows[0].t, null, "a rolled-back migration left a table behind");

      const recorded = await scratch.query(
        `select 1 from schema_migration where version = '9999'`,
      );
      assert.equal(recorded.rows.length, 0, "a failed migration was recorded as applied");
    });
  },
);
