/**
 * Applies pending schema migrations.
 *
 *   node scripts/db-migrate.mjs             # apply everything pending
 *   node scripts/db-migrate.mjs --status    # report without changing anything
 *   node scripts/db-migrate.mjs --repair    # re-record a changed checksum
 *
 * Not a re-runnable schema file any more. Migrations are ordered and recorded,
 * so a database can say which of them it has run and an empty one can be brought
 * to the current shape by replaying them — see lib/store/migrate.ts.
 */

import { readFileSync } from "node:fs";
import { Pool } from "@neondatabase/serverless";
import { loadMigrations, migrate, repair, status } from "../lib/store/migrate.ts";

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

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run `vercel env pull --yes`.");
  process.exit(1);
}

const args = process.argv.slice(2);

// Unknown flags are refused rather than falling through to the apply path. The
// flag this script documented until the migration rewrite was `--verify`, for
// read-only inspection; treating anything that was not `--status` as "apply"
// meant the old habit silently migrated production. So does a typo.
const KNOWN = new Set(["--status", "--repair"]);
const unknown = args.filter((a) => !KNOWN.has(a));
if (unknown.length > 0) {
  console.error(
    `\nUnknown option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}\n` +
      "  (no flags)  apply everything pending\n" +
      "  --status    report without changing anything\n" +
      "  --repair    re-record a checksum that drifted\n",
  );
  process.exit(2);
}
// Unpooled where available: DDL and a connection pooler are a poor combination.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
});

try {
  const migrations = loadMigrations();

  if (args.includes("--repair")) {
    const fixed = await repair(pool, migrations);
    console.log(`\n${C.bold("repair")}`);
    if (fixed.length === 0) console.log(`  ${C.dim("nothing had drifted")}`);
    for (const f of fixed) {
      console.log(`  ${C.good("✓")} re-recorded ${f.version}_${f.name}`);
    }
  } else if (!args.includes("--status")) {
    console.log(`\n${C.bold("migrate")}`);
    const { applied } = await migrate(pool, {
      migrations,
      onApplied: (m, ms) =>
        console.log(`  ${C.good("✓")} ${m.version}_${m.name} ${C.dim(`${ms}ms`)}`),
    });
    if (applied.length === 0) console.log(`  ${C.dim("already up to date")}`);
  }

  const state = await status(pool, migrations);
  console.log(`\n${C.bold("schema")}`);
  for (const m of migrations) {
    const at = state.applied.find((a) => a.version === m.version);
    const mark = at ? C.good("✓") : C.bad("·");
    const when = at ? C.dim(new Date(at.applied_at).toISOString().slice(0, 19).replace("T", " ")) : C.bad("pending");
    console.log(`  ${mark} ${m.version}_${m.name.padEnd(28)} ${when}`);
  }
  if (state.drifted.length > 0) {
    console.log(`\n  ${C.bad("drifted:")} ${state.drifted.map((d) => d.version).join(", ")}`);
  }

  const tables = await pool.query(
    `select table_name, (select count(*) from information_schema.columns c
                         where c.table_name = t.table_name) as cols
       from information_schema.tables t
      where table_schema = 'public' order by table_name`,
  );
  console.log(`\n${C.bold("structure")}`);
  for (const t of tables.rows) {
    console.log(`  ${t.table_name.padEnd(22)} ${C.dim(`${t.cols} columns`)}`);
  }

  const triggers = await pool.query(
    `select trigger_name, event_object_table, string_agg(event_manipulation, '/') as events
       from information_schema.triggers where trigger_schema = 'public'
      group by trigger_name, event_object_table order by event_object_table`,
  );
  console.log(`\n${C.bold("guards")}`);
  for (const t of triggers.rows) {
    console.log(`  ${t.event_object_table.padEnd(22)} ${t.trigger_name} ${C.dim(`on ${t.events}`)}`);
  }
  if (triggers.rows.length === 0) console.log(`  ${C.bad("none — the audit table is mutable")}`);
  console.log("");
} catch (err) {
  console.error(`\n${C.bad("migration failed")}\n${err.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
