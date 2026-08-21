/**
 * A throwaway Postgres database, created and dropped per test run.
 *
 * The Postgres store's SQL had no test coverage at all: every test deleted
 * DATABASE_URL to force the in-memory store, so the leasing statement in
 * claimResumable — the one control standing between a redial and a live call —
 * was never executed by anything but production.
 *
 * Running those tests against the real database is not an option. audit_entry
 * rejects DELETE by design, and check_in_session rows are referenced with
 * `on delete restrict`, so test rows written there would be permanent. Neon
 * schemas are no help either: the HTTP driver discards connection options, so a
 * search_path cannot be pinned. A separate database is the isolation that
 * actually holds — nothing test-written can reach the real one.
 */

import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { migrate } from "../../lib/store/migrate.ts";
import { STASH, STASH_UNPOOLED } from "./isolate-db.ts";

/**
 * Credentials come from the stashed names, not DATABASE_URL — isolate-db.ts
 * moves them there so no other suite can reach a database by accident. Absent
 * in CI, which is why the Postgres suite skips rather than fails there.
 */
export function databaseAvailable(): boolean {
  return Boolean(process.env[STASH]);
}

function adminUrl(): string {
  // Unpooled where available: DDL and a connection pooler are a poor
  // combination, and DROP DATABASE fails outright while the pooler holds a
  // connection open against it.
  return process.env[STASH_UNPOOLED] ?? process.env[STASH] ?? "";
}

export interface ScratchDb {
  readonly url: string;
  drop(): Promise<void>;
}

export async function createScratchDb(): Promise<ScratchDb> {
  const name = `va_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: adminUrl() });
  admin.on("error", () => {});

  try {
    await admin.query(`create database ${name}`);
  } catch (err) {
    await admin.end();
    throw err;
  }

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;

  const scratch = new Pool({ connectionString: url.toString() });
  scratch.on("error", () => {});
  try {
    // Replayed from the migrations, not from a separate schema file. A test
    // fixture built a different way is a second source of truth that drifts, and
    // the drift shows up as tests passing against a schema production does not
    // have.
    await migrate(scratch);
  } finally {
    await scratch.end();
  }

  return {
    url: url.toString(),
    async drop() {
      try {
        // FORCE terminates the HTTP driver's lingering backends. Without it the
        // drop loses a race with its own connections and leaves the database
        // behind on every run.
        await new Promise((r) => setTimeout(r, 250));
        await admin.query(`drop database if exists ${name} with (force)`);
      } finally {
        await admin.end();
      }
    },
  };
}
