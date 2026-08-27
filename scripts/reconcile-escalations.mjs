/**
 * Every escalation on the record, against every delivery attempt.
 *
 *   node scripts/reconcile-escalations.mjs [--since 30d]
 *
 * The backstop for the worst defect this system has had. The directed safety
 * screen raised escalations and delivered none of them for the entire life of the
 * feature: the record said `escalated`, the audit trail said `ESCALATED`, and the
 * tool told the agent to tell a frightened person their coordinator had been
 * alerted. Nothing inside the system could see it, because the retry ladder, the
 * backup contact, the alarm and the digest are all queries over
 * `escalation_delivery`, and there was no row to find.
 *
 * `lib/escalation/raise.ts` makes delivery a consequence of raising rather than a
 * procedure a producer has to remember. This exists because that is a promise
 * about code, and a producer added next year can still bypass it. An escalation
 * with no delivery attempt is the one condition this system must never be quiet
 * about, so it is checked from the outside, against the database, by something
 * that does not care how the row got there.
 *
 * Exits non-zero when it finds one, so it can sit in the gate or on a cron.
 */

import { readFileSync } from "node:fs";
import { getDb, isDatabaseConfigured } from "../lib/store/db.ts";

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

if (!isDatabaseConfigured()) {
  console.error("\nNo DATABASE_URL. This check reads the stored record.\n");
  process.exit(2);
}

/**
 * When delivery existed at all.
 *
 * `4024f50` on 2026-08-21 15:25 -0400 built the delivery subsystem. Every
 * escalation raised before it reached nobody because there was nothing to reach
 * them with, and 190 of those sit in this database. Counting them here would bury
 * the ones that matter — the same reasoning as the synthetic-flag boundary in
 * summaries.ts, and the same refusal to rewrite stored records to tidy a report.
 */
const DELIVERY_EXISTED_FROM = "2026-08-21T19:25:20Z";

const arg = process.argv.indexOf("--since");
const sinceRaw = arg === -1 ? "30d" : (process.argv[arg + 1] ?? "30d");
const days = Number(sinceRaw.replace(/d$/, "")) || 30;
const since = new Date(Date.now() - days * 86_400_000).toISOString();

const sql = getDb();

// Escalations live inside the record JSONB; deliveries are their own table. The
// join is the whole point: it is the only place the two can be compared, and
// nothing in the running system ever compares them.
const rows = await sql`
  select s.id as session_id,
         s.created_at,
         coalesce((s.record ->> 'synthetic')::boolean, false) as synthetic,
         e ->> 'id' as escalation_id,
         e ->> 'urgency' as urgency,
         e ->> 'triggeredBy' as triggered_by,
         e ->> 'category' as category,
         (select count(*) from escalation_delivery d
           where d.session_id = s.id and d.escalation_id = e ->> 'id')::int as attempts
    from check_in_session s,
         lateral jsonb_array_elements(coalesce(s.record -> 'escalations', '[]'::jsonb)) e
   where s.created_at >= ${since}
     and s.created_at >= ${DELIVERY_EXISTED_FROM}
   order by s.created_at desc`;

const undelivered = rows.filter((r) => r.attempts === 0);
const real = undelivered.filter((r) => !r.synthetic);

console.log(
  `\n${C.bold("Escalation reconciliation")}  ${C.dim(
    `${rows.length} escalations in the last ${days} days, since delivery existed`,
  )}\n`,
);

if (undelivered.length === 0) {
  console.log(`  ${C.good("every escalation has at least one delivery attempt")}\n`);
  process.exit(0);
}

const byCategory = new Map();
for (const r of undelivered) {
  const key = `${r.triggered_by} · ${r.category ?? "—"} · ${r.urgency}`;
  byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
}

console.log(
  `  ${C.bad(`${undelivered.length} escalation(s) reached nobody`)}` +
    `${real.length !== undelivered.length ? C.dim(`  (${real.length} on non-harness calls)`) : ""}\n`,
);
for (const [key, n] of [...byCategory].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)}  ${key}`);
}
console.log(C.dim(`\n  Oldest first, the five most recent:`));
for (const r of undelivered.slice(0, 5)) {
  console.log(
    C.dim(
      `    ${r.created_at.toISOString?.().slice(0, 19) ?? String(r.created_at).slice(0, 19)}  ` +
        `${r.session_id.slice(0, 8)}  ${r.escalation_id}  ${r.urgency}`,
    ),
  );
}
console.log(
  C.dim(
    `\n  An escalation with no delivery attempt is invisible to the retry ladder,\n` +
      `  the backup contact, the alarm and the digest — every one of them queries\n` +
      `  escalation_delivery. On the record it reads as handled.\n` +
      `\n  One known false positive: a dropped call carried forward renumbers its\n` +
      `  escalations into the successor session (tools.ts, carryForward), so the\n` +
      `  original delivery is filed under the old session id and does not join here.\n` +
      `  The ladder still works those rows; this check cannot see that it does.\n`,
  ),
);

// Non-zero on any undelivered escalation, harness or not: a harness call proves
// the code path is still broken just as well as a real one does.
process.exit(1);
