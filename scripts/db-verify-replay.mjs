/**
 * Proves the migrations reproduce the schema the database actually has.
 *
 *   node scripts/db-verify-replay.mjs
 *
 * Applies every migration to a throwaway database and compares the result,
 * column by column, index by index, trigger by trigger, against the live one.
 *
 * The point is that "ordered and replayable" is a claim, and the only way to
 * know it is true is to replay them. A migration set drifts from its database
 * quietly: a hand-applied hotfix, a migration edited after the fact, an object
 * created by a console session nobody wrote down. Nothing in the ordinary test
 * suite would see any of that, because the tests build their own database from
 * the same files they are testing.
 *
 * Read-only against the live database. The scratch database is created and
 * dropped here.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { migrate } from "../lib/store/migrate.ts";

for (const file of [".env", ".env.local"]) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    /* optional */
  }
}

const C = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  good: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
  bad: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const live = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!live) {
  console.error("DATABASE_URL is not set. Run `vercel env pull --yes`.");
  process.exit(1);
}

// schema_migration is excluded: the ledger records *when* this database ran each
// migration, so its contents legitimately differ between the two. Its structure
// is compared like everything else.
const SHAPES = [
  [
    "columns",
    `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`,
  ],
  [
    "indexes",
    `select tablename, indexdef from pg_indexes
      where schemaname = 'public' order by indexdef`,
  ],
  [
    "triggers",
    `select event_object_table, trigger_name, event_manipulation, action_statement
       from information_schema.triggers where trigger_schema = 'public'
      order by event_object_table, trigger_name, event_manipulation`,
  ],
];

const admin = new Pool({ connectionString: live });
admin.on("error", () => {});
const name = `va_replay_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
let fresh = null;

try {
  await admin.query(`create database ${name}`);
  const url = new URL(live);
  url.pathname = `/${name}`;
  fresh = new Pool({ connectionString: url.toString() });
  fresh.on("error", () => {});

  console.log(`\n${C.bold("replay")}`);
  const { applied } = await migrate(fresh, {
    onApplied: (m, ms) =>
      console.log(`  ${C.good("✓")} ${m.version}_${m.name} ${C.dim(`${ms}ms`)}`),
  });
  if (applied.length === 0) console.log(`  ${C.bad("no migrations applied")}`);

  console.log(`\n${C.bold("compared with the live database")}`);
  let identical = true;
  for (const [label, query] of SHAPES) {
    const a = (await fresh.query(query)).rows;
    const b = (await admin.query(query)).rows;
    const key = (r) => JSON.stringify(r);
    const onlyReplayed = a.filter((r) => !b.some((x) => key(x) === key(r)));
    const onlyLive = b.filter((r) => !a.some((x) => key(x) === key(r)));

    if (onlyReplayed.length === 0 && onlyLive.length === 0) {
      console.log(`  ${C.good("✓")} ${label.padEnd(10)} ${C.dim(`${a.length} identical`)}`);
      continue;
    }
    identical = false;
    console.log(`  ${C.bad("✗")} ${label}`);
    for (const r of onlyReplayed.slice(0, 5)) {
      console.log(`      ${C.dim("only from migrations:")} ${key(r).slice(0, 150)}`);
    }
    for (const r of onlyLive.slice(0, 5)) {
      console.log(`      ${C.dim("only in the database: ")} ${key(r).slice(0, 150)}`);
    }
  }

  if (identical) {
    console.log(`\n  ${C.good("an empty database plus the migrations is the live schema")}\n`);
  } else {
    console.log(
      `\n  ${C.bad("the migrations do not reproduce the live schema")}\n` +
        `  ${C.dim("Something changed this database outside the migration set.")}\n`,
    );
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n${C.bad("replay failed")}\n${err.message}\n`);
  process.exitCode = 1;
} finally {
  await fresh?.end();
  await new Promise((r) => setTimeout(r, 250));
  await admin.query(`drop database if exists ${name} with (force)`).catch(() => {});
  await admin.end();
}
