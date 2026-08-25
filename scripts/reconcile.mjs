/**
 * The agent's events against the eDiary's, per participant.
 *
 *   node scripts/reconcile.mjs --ediary export.json [--out reconciliation.csv]
 *
 * The pilot exists to answer one question: does a voice agent capture the same
 * events a participant would have typed, and what does each system find that the
 * other misses? This produces the file that question gets answered from.
 *
 * **It is a worklist, not a verdict.** An event in one system and not the other
 * has at least four causes — the agent found something nobody typed, the
 * participant typed something the agent never asked, the two used different
 * words, or the dates fell outside the window — and no matcher can tell them
 * apart. Every unmatched row ships with an empty `cause` column for a reviewer,
 * and the summary reports an agreement *floor* rather than an accuracy.
 *
 * The eDiary export shape, because this system does not get to choose it:
 *
 *   [{ "subjectId": "001-0042", "term": "Fatigue",
 *      "date": "2026-09-02", "grade": 2 }]
 *
 * `grade` is optional — many eDiaries collect severity on their own scale or not
 * at all, and a missing grade is reported as unknown rather than as agreement.
 * Mapping whatever the site actually exports into this shape is a site task; a
 * guess at their column names here would be a guess nobody could check.
 *
 * By default this reads nothing sealed: coded terms, grades and subject ids all
 * sit outside the seal. `--verbatim` adds the participant's own words, which is
 * the most useful column a reviewer has and also the one that makes the output a
 * PHI document the moment it is emailed anywhere.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { listAdverseEvents } from "../lib/store/summaries.ts";
import { reconcile, toCsv } from "../lib/observability/reconcile.ts";

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

const valueOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 || !process.argv[i + 1] ? fallback : process.argv[i + 1];
};

const ediaryPath = valueOf("--ediary", null);
const outPath = valueOf("--out", "reconciliation.csv");
const includeSynthetic = process.argv.includes("--include-synthetic");
const includeVerbatim = process.argv.includes("--verbatim");

if (!ediaryPath) {
  console.error(
    `\nUsage: node scripts/reconcile.mjs --ediary <export.json> [--out file.csv]\n\n` +
      `Expected shape:\n` +
      `  [{ "subjectId": "001-0042", "term": "Fatigue", "date": "2026-09-02", "grade": 2 }]\n\n` +
      `grade is optional. Mapping the site's export into this shape is a site task.\n`,
  );
  process.exit(2);
}

let ediary;
try {
  ediary = JSON.parse(readFileSync(ediaryPath, "utf8"));
} catch (err) {
  console.error(`\nCould not read ${ediaryPath}: ${err.message}\n`);
  process.exit(1);
}
if (!Array.isArray(ediary)) {
  console.error(`\n${ediaryPath} is not an array of entries.\n`);
  process.exit(1);
}

const malformed = ediary.filter((e) => !e?.subjectId || !e?.term || !e?.date);
if (malformed.length) {
  // Loudly, because a silently skipped entry becomes an "agent_only" row and
  // reads as the eDiary having missed something it recorded perfectly well.
  console.error(
    `\n${malformed.length} eDiary entr${malformed.length === 1 ? "y is" : "ies are"} missing subjectId, term or date.\n` +
      `Fix the export rather than letting them drop — a skipped entry looks\n` +
      `exactly like the eDiary having missed the event.\n`,
  );
  process.exit(1);
}

let events;
try {
  events = await listAdverseEvents({ includeSynthetic, includeVerbatim });
} catch (err) {
  console.error(`\nCould not read captured events: ${err.message}\n`);
  process.exit(1);
}

const { rows, summary } = reconcile(events, ediary);
writeFileSync(outPath, `${toCsv(rows)}\n`);

console.log(`\n${C.bold("Reconciliation")}  ${C.dim(`${events.length} agent events, ${ediary.length} eDiary entries`)}\n`);
console.log(`  participants          ${String(summary.subjects).padStart(5)}`);
console.log(`  ${C.good("matched")}               ${String(summary.matched).padStart(5)}`);
console.log(`  grade disagreements   ${String(summary.gradeMismatches).padStart(5)}  ${C.dim("both systems have it, different severity")}`);
console.log(`  agent only            ${String(summary.agentOnly).padStart(5)}  ${C.dim("the finding this pilot exists to produce — or a term mismatch")}`);
console.log(`  eDiary only           ${String(summary.ediaryOnly).padStart(5)}  ${C.dim("a missed capture — or a term mismatch")}`);
console.log(
  `\n  agreement floor       ${
    summary.agreementFloor === null ? "  —  " : `${(summary.agreementFloor * 100).toFixed(0)}%`.padStart(5)
  }  ${C.dim("a floor, not an accuracy: unmatched rows are uncategorised")}`,
);
console.log(
  C.dim(
    `\n  Wrote ${outPath}. Every unmatched row has an empty cause column — the\n` +
      `  pilot's exit criteria ask for disagreements "categorised by cause", and\n` +
      `  that categorisation is a clinical judgement this tool must not make.`,
  ),
);
if (includeVerbatim) {
  console.log(
    C.bad(`\n  ${outPath} contains participants' own words. It is a PHI document.`),
  );
}
console.log();
