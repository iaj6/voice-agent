/**
 * Word error rate and clinical-term recall for a recogniser.
 *
 *   node scripts/measure-stt.mjs tests/corpus/stt-samples.json
 *
 * Takes a file of {reference, hypothesis} pairs — a reference is what the
 * participant said, a hypothesis is what the recogniser heard — and reports both
 * numbers. Provider-agnostic on purpose: the provider is a decision that can
 * change, and a harness wired to one of them would have to be rebuilt when it
 * does.
 *
 * The number to read is term recall, not WER. A recogniser that turns "I've
 * been quite tired" into "I have been very tired" scores badly on WER and costs
 * nothing; one that turns "I coughed up blood" into "I coughed up phlegm" scores
 * well and loses a reportable event.
 */

import { readFileSync } from "node:fs";
import { termRecall, wordErrorRate } from "../lib/voice/wer.ts";
import { clinicalTerms } from "../lib/voice/clinical-terms.ts";

const C = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  good: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
  bad: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const file = process.argv[2];
if (!file) {
  console.error("\nUsage: node scripts/measure-stt.mjs <samples.json>\n");
  process.exit(2);
}

let samples;
try {
  samples = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error(`\nCould not read ${file}: ${err.message}\n`);
  process.exit(1);
}
if (!Array.isArray(samples) || samples.length === 0) {
  console.error("\nExpected a non-empty array of {reference, hypothesis}.\n");
  process.exit(1);
}

const terms = clinicalTerms();
const rows = samples.map((s) => ({
  ...s,
  wer: wordErrorRate(s.reference, s.hypothesis),
  terms: termRecall(s.reference, s.hypothesis, terms),
}));

const totalRefWords = rows.reduce((n, r) => n + r.wer.referenceWords, 0);
const totalErrors = rows.reduce(
  (n, r) => n + r.wer.substitutions + r.wer.deletions + r.wer.insertions,
  0,
);
// Aggregated over words, not averaged over samples: a one-word sample and a
// forty-word sample are not equally informative, and averaging rates pretends
// they are.
const overallWer = totalRefWords === 0 ? 0 : totalErrors / totalRefWords;

const allTermResults = rows.flatMap((r) => r.terms.results);
const termsExpected = allTermResults.reduce((n, r) => n + r.expected, 0);
const termsHeard = allTermResults.reduce((n, r) => n + Math.min(r.heard, r.expected), 0);
const overallRecall = termsExpected === 0 ? 1 : termsHeard / termsExpected;

console.log(`\n${C.bold("Transcription accuracy")}  ${C.dim(`n=${rows.length}`)}\n`);
console.log(`  Word error rate        ${(overallWer * 100).toFixed(1).padStart(6)}%   ${C.dim(`${totalErrors} errors in ${totalRefWords} words`)}`);
console.log(
  `  Clinical term recall   ${(overallRecall * 100).toFixed(1).padStart(6)}%   ` +
    C.dim(`${termsHeard} of ${termsExpected} — the one that matters`),
);

const missed = new Map();
for (const r of allTermResults) {
  const lost = r.expected - Math.min(r.heard, r.expected);
  if (lost > 0) missed.set(r.term, (missed.get(r.term) ?? 0) + lost);
}
if (missed.size > 0) {
  console.log(`\n  ${C.bold("Clinical terms lost")}`);
  for (const [term, n] of [...missed].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${C.bad("×")} ${term.padEnd(22)} ${n}`);
  }
}

const worst = [...rows].sort((a, b) => a.terms.recall - b.terms.recall).slice(0, 5);
console.log(`\n  ${C.bold("Worst samples by term recall")}`);
for (const r of worst) {
  console.log(`    ${C.dim("said ")}${JSON.stringify(r.reference.slice(0, 72))}`);
  console.log(`    ${C.dim("heard")} ${JSON.stringify(r.hypothesis.slice(0, 72))}`);
  console.log(
    `          ${C.dim(`WER ${(r.wer.wer * 100).toFixed(0)}%, term recall ${(r.terms.recall * 100).toFixed(0)}%`)}\n`,
  );
}

console.log(
  C.dim(
    "  Read term recall, not WER. A dropped adjective and a dropped symptom cost\n" +
      "  the same on WER and are not the same mistake.\n",
  ),
);
