/**
 * Ordered, replayable schema migrations.
 *
 * The schema used to be one idempotent file re-applied on every deploy. That is
 * convenient and it cannot answer the question a regulated system is eventually
 * asked: what shape was the database in when this record was captured? A file
 * full of `create ... if not exists` has no history — it describes where the
 * schema ended up, never how it got there, and a record written last March
 * cannot be tied to the structure that held it.
 *
 * So: numbered files, applied in order, each recorded with a checksum. Applying
 * them to an empty database reproduces the current schema exactly, which is what
 * makes a restore or a fresh validation environment reconstructable rather than
 * approximate.
 *
 * The checksums are the part that does real work. An applied migration whose
 * file has since changed means the recorded history is a lie, and the runner
 * refuses to go further rather than papering over it — see `--repair` in
 * scripts/db-migrate.mjs for the deliberate escape hatch.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/** `0007_add_widget.sql` -> version "0007", name "add_widget". */
const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly file: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  execution_ms: number;
}

/** Minimal shape of a node-postgres style client. Keeps this testable. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * A pool, which is not a connection.
 *
 * This distinction is load-bearing and was got wrong once already: `pool.query`
 * checks out a connection, runs one statement and hands it back, so `begin` and
 * the migration after it can land on two different connections and the
 * transaction wraps nothing. The test that was supposed to catch it passed
 * anyway, because Postgres runs a multi-statement simple query in an implicit
 * transaction of its own — the protection was real and it was not mine.
 */
export interface SqlPool extends SqlClient {
  connect?(): Promise<SqlClient & { release(): void }>;
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Every migration on disk, in version order.
 *
 * Throws on anything ambiguous — a stray filename, a duplicate version, a gap in
 * the sequence. Ordering is the whole guarantee; a directory the runner has to
 * guess about does not provide it.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));

  const migrations = files.map((file) => {
    const match = FILENAME.exec(file);
    if (!match) {
      throw new Error(
        `Migration filename "${file}" is not NNNN_lower_snake_case.sql. ` +
          "The number is the order migrations run in, so it cannot be optional.",
      );
    }
    const sql = readFileSync(join(dir, file), "utf8");
    return {
      version: match[1],
      name: match[2],
      file,
      sql,
      checksum: checksum(sql),
    };
  });

  migrations.sort((a, b) => a.version.localeCompare(b.version));

  for (let i = 0; i < migrations.length; i++) {
    const expected = String(i + 1).padStart(4, "0");
    if (migrations[i].version === migrations[i - 1]?.version) {
      throw new Error(
        `Two migrations share version ${migrations[i].version}: ` +
          `${migrations[i - 1].file} and ${migrations[i].file}. ` +
          "Which runs first would be decided by filesystem order.",
      );
    }
    if (migrations[i].version !== expected) {
      throw new Error(
        `Migration ${migrations[i].file} is out of sequence — expected ${expected}. ` +
          "A gap means a migration was deleted, and a database that ran it can no " +
          "longer be told apart from one that never did.",
      );
    }
  }

  return migrations;
}

/**
 * Bootstrap. Created by the runner rather than by a migration, because it is
 * what records that migrations ran.
 */
const LEDGER = `
  create table if not exists schema_migration (
    version      text        primary key,
    name         text        not null,
    checksum     char(64)    not null,
    applied_at   timestamptz not null default now(),
    execution_ms integer     not null
  )`;

export async function readLedger(sql: SqlClient): Promise<AppliedMigration[]> {
  await sql.query(LEDGER);
  const { rows } = await sql.query(
    `select version, name, checksum, applied_at, execution_ms
       from schema_migration order by version`,
  );
  return rows as unknown as AppliedMigration[];
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: Migration[];
  /** Applied migrations whose file has changed since. Never empty quietly. */
  drifted: { version: string; name: string; was: string; now: string }[];
  /** Applied migrations with no file on disk any more. */
  missing: AppliedMigration[];
}

export async function status(
  sql: SqlClient,
  migrations: Migration[] = loadMigrations(),
): Promise<MigrationStatus> {
  const applied = await readLedger(sql);
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const appliedVersions = new Set(applied.map((a) => a.version));

  return {
    applied,
    pending: migrations.filter((m) => !appliedVersions.has(m.version)),
    drifted: applied
      .filter((a) => {
        const m = byVersion.get(a.version);
        return m && m.checksum !== a.checksum;
      })
      .map((a) => ({
        version: a.version,
        name: a.name,
        was: a.checksum,
        now: byVersion.get(a.version)!.checksum,
      })),
    missing: applied.filter((a) => !byVersion.has(a.version)),
  };
}

export class MigrationDriftError extends Error {}

/**
 * Applies everything pending, in order, each in its own transaction.
 *
 * Per-migration transactions rather than one spanning all of them: Postgres
 * makes DDL transactional, so a migration that fails halfway leaves nothing
 * behind, and the ones before it stay applied and recorded. A single enormous
 * transaction would roll back work that succeeded and is now being repeated on
 * the next attempt.
 */
export async function migrate(
  sql: SqlPool,
  options: { migrations?: Migration[]; onApplied?: (m: Migration, ms: number) => void } = {},
): Promise<{ applied: Migration[] }> {
  const migrations = options.migrations ?? loadMigrations();
  const state = await status(sql, migrations);

  if (state.drifted.length > 0) {
    const detail = state.drifted
      .map((d) => `  ${d.version}_${d.name}: recorded ${d.was.slice(0, 12)}, file is ${d.now.slice(0, 12)}`)
      .join("\n");
    throw new MigrationDriftError(
      "A migration that has already been applied has changed on disk:\n" +
        `${detail}\n` +
        "The database no longer matches its own recorded history, so it cannot say " +
        "which schema a record was captured under. Add a new migration instead of " +
        "editing an applied one. If the change was genuinely cosmetic, re-record it " +
        "deliberately with `node scripts/db-migrate.mjs --repair`.",
    );
  }

  if (state.missing.length > 0) {
    throw new MigrationDriftError(
      `The database has applied migrations with no file on disk: ` +
        `${state.missing.map((m) => `${m.version}_${m.name}`).join(", ")}. ` +
        "This checkout is older than the database, or a migration was deleted.",
    );
  }

  const applied: Migration[] = [];
  for (const migration of state.pending) {
    const startedAt = Date.now();
    // One connection for the whole migration, so the transaction is real. The
    // statement that matters most is the ledger insert: DDL that applied without
    // being recorded is the worst state to leave a database in, because the next
    // run will try to apply it again.
    const client = sql.connect ? await sql.connect() : null;
    const run = client ?? sql;
    try {
      await run.query("begin");
      try {
        await run.query(migration.sql);
        await run.query(
          `insert into schema_migration (version, name, checksum, execution_ms)
           values ($1, $2, $3, $4)`,
          [migration.version, migration.name, migration.checksum, Date.now() - startedAt],
        );
        await run.query("commit");
      } catch (err) {
        await run.query("rollback").catch(() => {});
        throw new Error(
          `Migration ${migration.file} failed and was rolled back. ` +
            `Nothing from it was applied and it is not recorded.\n${String(err)}`,
        );
      }
    } finally {
      client?.release();
    }
    applied.push(migration);
    options.onApplied?.(migration, Date.now() - startedAt);
  }

  return { applied };
}

/** Re-records checksums for applied migrations. Deliberate, and never automatic. */
export async function repair(
  sql: SqlClient,
  migrations: Migration[] = loadMigrations(),
): Promise<{ version: string; name: string }[]> {
  const state = await status(sql, migrations);
  for (const d of state.drifted) {
    const m = migrations.find((x) => x.version === d.version)!;
    await sql.query(`update schema_migration set checksum = $2 where version = $1`, [
      m.version,
      m.checksum,
    ]);
  }
  return state.drifted.map((d) => ({ version: d.version, name: d.name }));
}

/** The schema version a record was captured under. Belongs in `instrument`. */
export function schemaVersion(migrations: Migration[] = loadMigrations()): string {
  return migrations[migrations.length - 1]?.version ?? "0000";
}
