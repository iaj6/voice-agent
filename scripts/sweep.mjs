/**
 * Runs one pass of the escalation ladder, locally.
 *
 *   node scripts/sweep.mjs
 *   node scripts/sweep.mjs --at 2026-08-21T21:00:00Z   # pretend it is later
 *   node scripts/sweep.mjs --digest                    # and send the daily summary
 *
 * The --at flag exists so the ladder can be exercised without waiting an hour
 * for an SLA to lapse. It only moves the sweeper's idea of now; the records keep
 * their real timestamps.
 */

import { readFileSync } from "node:fs";
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

const { sweepEscalations } = await import("../lib/escalation/sweep.ts");

const C = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  good: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
  bad: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const atArg = process.argv.indexOf("--at");
const at = atArg === -1 ? new Date() : new Date(process.argv[atArg + 1]);
if (Number.isNaN(at.getTime())) {
  console.error("--at needs an ISO timestamp, e.g. 2026-08-21T21:00:00Z");
  process.exit(2);
}

console.log(`\n${C.bold("escalation sweep")} ${C.dim(at.toISOString())}`);
const r = await sweepEscalations(at);

const line = (label, n, colour) =>
  console.log(`  ${n > 0 ? colour(String(n).padStart(3)) : C.dim("  0")}  ${label}`);
line("retried after a failed send", r.retried, C.good);
line("retries that failed again", r.retriesFailed, C.bad);
line("escalated to the backup contact", r.escalatedToSecondary, C.bad);
line("alarmed — nobody acknowledged", r.alarmed, C.bad);
line("still inside their response window", r.stillWaiting, C.dim);
line("orphaned — paged for something not on the record", r.orphaned, C.bad);
console.log("");

if (process.argv.includes("--digest")) {
  const { sendDigest } = await import("../lib/escalation/digest.ts");
  const d = await sendDigest(at);
  console.log(`${C.bold("digest")}  ${d.outstanding} outstanding, ${d.overdue} overdue` +
    (d.sent ? C.good("  sent") : C.dim(`  not sent — ${d.detail}`)));
  console.log("");
}
