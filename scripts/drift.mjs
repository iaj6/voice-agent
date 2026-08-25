/**
 * Is the instrument still measuring what it measured last week?
 *
 *   node scripts/drift.mjs [--weeks 8] [--record]
 *
 * A check-in agent degrades without failing. A model update shifts how it
 * grades, so a cohort that used to produce grade 2 events starts producing
 * grade 1s and the study under-reports. A prompt edit makes it escalate more, or
 * less. A recogniser update changes what it hears. None of that throws; all of
 * it changes the dataset, and the dataset is the deliverable.
 *
 * `--record` appends the newest complete week to docs/drift-history.jsonl, the
 * same way measure-net does — a single number is a fact about today and the
 * trend is what says whether anything moved.
 *
 * **Reads no free text.** Grades, urgencies and item ids sit outside the seal by
 * design, so this never fetches a key and cannot load anything a participant
 * said. A shredded subject's calls still count correctly instead of erroring or
 * quietly leaving the denominator.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { listSummaries } from "../lib/store/summaries.ts";
import { byWeek, compare, MIN_CALLS_FOR_COMPARISON } from "../lib/observability/drift.ts";

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
const weeks = Number(valueOf("--weeks", "8"));
// The eval harness makes hundreds of calls against a pilot's handful, so
// including them produces a report about whoever last edited a persona.
const includeSynthetic = process.argv.includes("--include-synthetic");
const since = new Date(Date.now() - weeks * 7 * 86_400_000);

let calls;
try {
  calls = await listSummaries({ since, limit: 5000, includeSynthetic });
} catch (err) {
  console.error(`\nCould not read check-ins: ${err.message}\n`);
  process.exit(1);
}

if (calls.length === 0) {
  console.error(
    `\nNo${includeSynthetic ? "" : " real"} check-ins in the last ${weeks} weeks.\n` +
      (includeSynthetic
        ? ""
        : `The eval harness's own calls are excluded by default; --include-synthetic counts them.\n`),
  );
  process.exit(1);
}

const windows = byWeek(calls);
const n = (v, digits = 2) => (v === null ? "  —  " : v.toFixed(digits).padStart(5));
const pct = (v) => (v === null ? "  —  " : `${(v * 100).toFixed(0).padStart(3)}%`);

console.log(
  `\n${C.bold("Instrument drift")}  ${C.dim(
    `${windows.length} week(s), ${calls.length} calls${includeSynthetic ? ", eval calls included" : ""}`,
  )}\n`,
);
console.log(
  C.dim("  week        calls  events  mean gr  esc/call  net/agent  screen  positive"),
);
for (const w of windows) {
  const thin = w.calls < MIN_CALLS_FOR_COMPARISON;
  const line =
    `  ${w.week}  ${String(w.calls).padStart(5)}  ${String(w.events).padStart(6)}  ` +
    `${n(w.meanGrade)}    ${n(w.escalationsPerCall)}     ` +
    `${String(w.bySafetyNet).padStart(3)}/${String(w.byAgent).padEnd(3)}   ` +
    `${n(w.screenCompletion, 1)}   ${pct(w.screenPositiveRate)}`;
  console.log(thin ? C.dim(`${line}  (thin)`) : line);
}

if (windows.length >= 2) {
  const previous = windows[windows.length - 2];
  const current = windows[windows.length - 1];
  console.log(`\n${C.bold("Week over week")}  ${C.dim(`${previous.week} to ${current.week}`)}`);
  for (const s of compare(previous, current)) {
    if (!s.meaningful) {
      console.log(
        C.dim(
          `  ${s.metric.padEnd(24)} not enough calls to compare ` +
            `(${previous.calls} then ${current.calls}, want ${MIN_CALLS_FOR_COMPARISON}+)`,
        ),
      );
      continue;
    }
    const arrow = s.delta > 0 ? "up" : s.delta < 0 ? "down" : "flat";
    console.log(
      `  ${s.metric.padEnd(24)} ${n(s.from)} -> ${n(s.to)}  ${C.dim(`${arrow} ${Math.abs(s.delta).toFixed(2)}`)}`,
    );
  }
  console.log(
    C.dim(
      `\n  Descriptive, not a threshold. A rising escalation rate can be a twitchy\n` +
        `  agent or a sicker cohort, and nothing here can tell those apart — the\n` +
        `  point is that the question gets asked while the answer is recoverable.`,
    ),
  );
} else {
  console.log(
    C.dim(`\n  One week of data. A trend needs a second one; run this again next week.`),
  );
}

if (process.argv.includes("--record") && includeSynthetic) {
  // The history file is the trend of the real study. A row built from harness
  // calls looks identical to a real one once it is written, and the whole reason
  // the synthetic boundary exists is that nobody could tell them apart later.
  console.error(
    C.bad(`\n  Refusing to record: --include-synthetic mixes harness calls into a\n`) +
      C.bad(`  file whose only purpose is the real study's trend.\n`),
  );
  process.exit(1);
}

if (process.argv.includes("--record")) {
  // The newest *complete* week. Recording the in-progress one appends a partial
  // row, and running again the next day appends a second row for the same week
  // with different numbers — which makes the history file untrendable, and it is
  // the only thing that file is for.
  const cutoff = Date.now() - 7 * 86_400_000;
  const complete = windows.filter((w) => Date.parse(w.week) + 7 * 86_400_000 <= Date.now());
  const latest = complete[complete.length - 1];
  if (!latest) {
    console.log(
      C.dim(`\n  nothing to record: no week has finished yet (cutoff ${new Date(cutoff).toISOString().slice(0, 10)})`),
    );
  } else {
    const already = (() => {
      try {
        return readFileSync("docs/drift-history.jsonl", "utf8")
          .split("\n")
          .filter(Boolean)
          .some((line) => JSON.parse(line).week === latest.week);
      } catch {
        return false;
      }
    })();
    if (already) {
      console.log(C.dim(`\n  ${latest.week} is already recorded; not appending a second row`));
    } else {
      appendFileSync("docs/drift-history.jsonl", `${JSON.stringify(latest)}\n`);
      console.log(C.good(`\n  recorded ${latest.week} to docs/drift-history.jsonl`));
    }
  }
}
console.log();
