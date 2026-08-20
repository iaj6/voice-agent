/**
 * Measures the deterministic safety net against the annotated corpus.
 *
 * The number this produces is the point. "We have a safety net" is not a claim
 * anyone can evaluate; "94% sensitivity at 88% specificity on a 108-utterance
 * annotated corpus, and here is the confusion matrix" is. The per-kind breakdown
 * matters more than the headline: a net that scores well overall while missing
 * every colloquial phrasing is a net that works on the sentences its author
 * happened to think of.
 *
 *   node scripts/measure-net.mjs
 *   node scripts/measure-net.mjs --misses                # list every false negative
 *   node scripts/measure-net.mjs --min-sensitivity=0.50  # exit non-zero below the floor
 */

import { readFileSync } from "node:fs";
import { scanForSafetySignals, assertedHits } from "../lib/clinical/safety.ts";

const C = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  good: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
  bad: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  warn: (s) => `\x1b[38;5;215m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const corpus = JSON.parse(
  readFileSync(new URL("../tests/corpus/safety-corpus.json", import.meta.url)),
).utterances;

const showMisses = process.argv.includes("--misses");

/**
 * Regression floors, not targets.
 *
 * Sensitivity is genuinely low (see SPEC.md §8) and raising it is Sprint 3 work.
 * The floor exists so that a pattern edit made for one reason cannot quietly cost
 * recall somewhere else — the failure mode where a safety control gets weaker as
 * a side effect of an unrelated improvement, which has already happened once in
 * this codebase.
 *
 * Specificity has no slack. A net that cries wolf gets ignored, and an ignored
 * floor is not a floor.
 */
function floorArg(name, fallback) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw === undefined ? fallback : Number(raw.split("=")[1]);
}
const minSensitivity = floorArg("min-sensitivity", null);
const minSpecificity = floorArg("min-specificity", null);

const rows = corpus.map((entry) => {
  const all = scanForSafetySignals(entry.text);
  const live = assertedHits(all);
  const fired = live.length > 0;
  const shouldFire = entry.expect !== null;
  return {
    ...entry,
    fired,
    shouldFire,
    predicted: fired ? live[0].urgency : null,
    suppressedBy: !fired && all.length ? all[0].suppressionReason : null,
    outcome:
      fired && shouldFire ? "TP" : !fired && !shouldFire ? "TN" : fired ? "FP" : "FN",
  };
});

const count = (o) => rows.filter((r) => r.outcome === o).length;
const tp = count("TP"), tn = count("TN"), fp = count("FP"), fn = count("FN");

const sensitivity = tp + fn ? tp / (tp + fn) : 0;
const specificity = tn + fp ? tn / (tn + fp) : 0;
const ppv = tp + fp ? tp / (tp + fp) : 0;
const npv = tn + fn ? tn / (tn + fn) : 0;

console.log(`\n${C.bold("Deterministic safety net")}  ${C.dim(`n=${rows.length}`)}\n`);

console.log(C.bold("  Confusion matrix"));
console.log(C.dim("                    net fires    net silent"));
console.log(`    signal present  ${String(tp).padStart(9)} ${C.dim("TP")}  ${String(fn).padStart(8)} ${fn ? C.bad("FN") : C.dim("FN")}`);
console.log(`    no signal       ${String(fp).padStart(9)} ${fp ? C.warn("FP") : C.dim("FP")}  ${String(tn).padStart(8)} ${C.dim("TN")}`);

console.log(`\n${C.bold("  Operating point")}`);
const line = (label, v, note) => {
  const s = `${(100 * v).toFixed(1)}%`;
  const col = v >= 0.9 ? C.good : v >= 0.75 ? C.warn : C.bad;
  console.log(`    ${label.padEnd(24)} ${col(s.padStart(6))}   ${C.dim(note)}`);
};
line("Sensitivity (recall)", sensitivity, "of real signals, how many fire — the one that matters");
line("Specificity", specificity, "of clean utterances, how many stay quiet");
line("PPV (precision)", ppv, "when it fires, how often it is right");
line("NPV", npv, "when it is silent, how often that is safe");

console.log(`\n${C.bold("  Where it is strong and where it is blind")}`);
const kinds = [...new Set(rows.map((r) => r.kind))];
const order = ["direct", "colloquial", "compound", "negated", "other_experiencer", "historical", "hypothetical", "benign"];
kinds.sort((a, b) => order.indexOf(a) - order.indexOf(b));
console.log(C.dim("    kind                  n     correct    note"));
for (const kind of kinds) {
  const sub = rows.filter((r) => r.kind === kind);
  const right = sub.filter((r) => r.outcome === "TP" || r.outcome === "TN").length;
  const rate = right / sub.length;
  const col = rate === 1 ? C.good : rate >= 0.75 ? C.warn : C.bad;
  const note = sub[0].shouldFire ? "should fire" : "should stay silent";
  console.log(
    `    ${kind.padEnd(20)} ${String(sub.length).padStart(3)}   ${col(`${right}/${sub.length}`.padStart(7))}    ${C.dim(note)}`,
  );
}

console.log(`\n${C.bold("  By safety topic")}  ${C.dim("(signal-bearing utterances only)")}`);
const topics = [...new Set(rows.filter((r) => r.shouldFire).map((r) => r.topic))];
for (const topic of topics.sort()) {
  const sub = rows.filter((r) => r.shouldFire && r.topic === topic);
  const caught = sub.filter((r) => r.fired).length;
  const rate = caught / sub.length;
  const col = rate === 1 ? C.good : rate >= 0.6 ? C.warn : C.bad;
  const bar = "█".repeat(Math.round(rate * 12)).padEnd(12, "·");
  console.log(`    ${topic.padEnd(24)} ${col(bar)} ${col(`${caught}/${sub.length}`)}`);
}

const misses = rows.filter((r) => r.outcome === "FN");
const spurious = rows.filter((r) => r.outcome === "FP");

if (spurious.length) {
  console.log(`\n${C.bold("  False alarms")} ${C.dim("(cost: coordinator time, and alert fatigue at scale)")}`);
  for (const r of spurious) console.log(`    ${C.warn("FP")} ${r.text}`);
}

if (misses.length) {
  console.log(`\n${C.bold("  Missed signals")} ${C.dim(`(${misses.length} — the ones that matter)`)}`);
  const byKind = {};
  for (const m of misses) (byKind[m.kind] ||= []).push(m);
  for (const [kind, list] of Object.entries(byKind)) {
    console.log(`    ${C.dim(kind)} ${C.dim(`×${list.length}`)}`);
    const show = showMisses ? list : list.slice(0, 3);
    for (const m of show) console.log(`      ${C.bad("·")} ${m.text}`);
    if (!showMisses && list.length > 3) {
      console.log(C.dim(`        …and ${list.length - 3} more (--misses to list all)`));
    }
  }
}

if (minSensitivity !== null || minSpecificity !== null) {
  const breaches = [];
  if (minSensitivity !== null && sensitivity < minSensitivity) {
    breaches.push(
      `sensitivity ${(100 * sensitivity).toFixed(1)}% is below the ${(100 * minSensitivity).toFixed(1)}% floor`,
    );
  }
  if (minSpecificity !== null && specificity < minSpecificity) {
    breaches.push(
      `specificity ${(100 * specificity).toFixed(1)}% is below the ${(100 * minSpecificity).toFixed(1)}% floor`,
    );
  }
  console.log("");
  if (breaches.length) {
    for (const b of breaches) console.log(`  ${C.bad("✗")} ${b}`);
    console.log(
      C.dim("\n  A safety control got weaker. If that was intended, move the floor deliberately."),
    );
    process.exit(1);
  }
  console.log(`  ${C.good("✓")} ${C.dim("above the regression floors")}`);
}

console.log(
  `\n  ${C.dim("The net is a floor, not a ceiling — Claude is the primary detector and")}` +
  `\n  ${C.dim("a human reviews every escalation. Read sensitivity as: if the model")}` +
  `\n  ${C.dim("misses this utterance entirely, does anything else catch it?")}\n`,
);
