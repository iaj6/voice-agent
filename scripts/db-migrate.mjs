/**
 * Applies lib/store/schema.sql.
 *
 * The schema is idempotent (`create ... if not exists`, `create or replace`), so
 * this is safe to re-run. It is not a migration framework and does not pretend
 * to be one — the pilot needs versioned migrations before it needs anything
 * clever, and that is a Sprint 1 follow-up rather than something to fake now.
 *
 *   node scripts/db-migrate.mjs
 *   node scripts/db-migrate.mjs --verify   # report structure without changing it
 */

import { readFileSync } from "node:fs";
import { neon, Pool } from "@neondatabase/serverless";

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

const sql = neon(process.env.DATABASE_URL);
const verifyOnly = process.argv.includes("--verify");

if (!verifyOnly) {
  const ddl = readFileSync(new URL("../lib/store/schema.sql", import.meta.url), "utf8");
  console.log(`\n${C.bold("applying schema")}`);
  // DDL goes over a real connection, not the HTTP driver: the schema contains
  // dollar-quoted function bodies that a naive split on ";" would tear in half,
  // and the HTTP endpoint does not accept multi-statement queries. Unpooled
  // where available — DDL and a connection pooler are a poor combination.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  });
  try {
    await pool.query(ddl);
    console.log(`  ${C.good("✓")} ${C.dim("schema applied")}`);
  } finally {
    await pool.end();
  }
}

console.log(`\n${C.bold("structure")}`);
const tables = await sql`
  select table_name, (select count(*) from information_schema.columns c
                      where c.table_name = t.table_name) as cols
  from information_schema.tables t
  where table_schema = 'public' order by table_name`;
for (const t of tables) console.log(`  ${t.table_name.padEnd(22)} ${C.dim(`${t.cols} columns`)}`);

const triggers = await sql`
  select trigger_name, event_object_table, string_agg(event_manipulation, '/') as events
  from information_schema.triggers where trigger_schema = 'public'
  group by trigger_name, event_object_table order by event_object_table`;
console.log(`\n${C.bold("guards")}`);
for (const t of triggers) {
  console.log(`  ${t.event_object_table.padEnd(22)} ${t.trigger_name} ${C.dim(`on ${t.events}`)}`);
}
if (triggers.length === 0) console.log(`  ${C.bad("none — the audit table is mutable")}`);
console.log("");
