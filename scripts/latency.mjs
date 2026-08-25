/**
 * What participants actually waited, against what N-01 promises.
 *
 *   node scripts/latency.mjs [--since 7d] [--limit 2000]
 *
 * N-01: time to first audio under 2s at p50, under 4s at p95. Before this the
 * spec recorded "~2.5s p50, unmeasured p95" — a number somebody felt and a
 * number nobody had. Dead air is the failure mode of a voice agent, so this is
 * the requirement least safe to assert.
 *
 * **The headline is measured in the browser**, because the server knows when it
 * dispatched a sentence and not when anyone heard one. The server segments below
 * it are for attribution: a slow p95 is a slow model, a slow first sentence, or
 * slow synthesis, and those have different fixes.
 *
 * System turns are reported apart from subject turns on purpose. The call-start
 * turn includes answering the phone and is not a participant waiting for an
 * answer to something they said; averaging it in moves the number in the
 * flattering direction.
 */

import { readFileSync } from "node:fs";
import { getLatencyStore, percentile } from "../lib/store/latency.ts";

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

const limit = Number(valueOf("--limit", "2000"));
const sinceRaw = valueOf("--since", null);
const sinceMs = sinceRaw
  ? Number(sinceRaw.replace(/[dh]$/, "")) * (sinceRaw.endsWith("h") ? 3.6e6 : 8.64e7)
  : null;
const cutoff = sinceMs ? Date.now() - sinceMs : null;

/** N-01, verbatim. */
const TARGETS = { p50: 2000, p95: 4000 };

const store = getLatencyStore();
let rows;
try {
  rows = await store.recent(limit);
} catch (err) {
  // Almost always an unmigrated database, and a stack trace is a poor way to
  // say "run the migrations".
  const unmigrated = /relation "turn_latency" does not exist/.test(String(err));
  console.error(
    unmigrated
      ? `\nThe turn_latency table is missing. Run: node scripts/db-migrate.mjs\n`
      : `\nCould not read latency: ${err.message}\n`,
  );
  process.exit(1);
}
if (cutoff) rows = rows.filter((r) => Date.parse(r.createdAt) >= cutoff);

if (rows.length === 0) {
  console.error(
    `\nNo turns recorded${store.kind === "memory" ? " (no DATABASE_URL, so nothing persists)" : ""}.\n` +
      `Run a check-in first — this reads what real calls produced.\n`,
  );
  process.exit(1);
}

const ms = (v) => (v === null ? "  —  " : `${String(Math.round(v)).padStart(5)}`);

function report(label, sample) {
  const audible = sample.map((r) => r.firstAudioMs).filter((v) => v !== null);
  const p50 = percentile(audible, 50);
  const p95 = percentile(audible, 95);

  console.log(`\n${C.bold(label)}  ${C.dim(`n=${sample.length}`)}`);
  if (audible.length === 0) {
    console.log(
      `  ${C.bad("no first-audio measurements")} ${C.dim("— the browser reports these; only server segments are present")}`,
    );
  } else {
    const verdict = (value, target) =>
      value === null ? C.dim("—") : value <= target ? C.good("meets") : C.bad("MISSES");
    console.log(
      `  Time to first audio   p50 ${ms(p50)}ms  ${verdict(p50, TARGETS.p50)} ${C.dim(`(N-01: ≤${TARGETS.p50}ms)`)}`,
    );
    console.log(
      `                        p95 ${ms(p95)}ms  ${verdict(p95, TARGETS.p95)} ${C.dim(`(N-01: ≤${TARGETS.p95}ms)`)}`,
    );
    if (audible.length < sample.length) {
      console.log(
        `  ${C.dim(`${sample.length - audible.length} of ${sample.length} turns produced no audio at all — counted, not dropped`)}`,
      );
    }
    // A p95 over a handful of turns is not a p95. Saying so is the difference
    // between a measurement and a number.
    if (audible.length < 20) {
      console.log(
        `  ${C.bad("too few turns for a p95 to mean anything")} ${C.dim(`(${audible.length}; want 20+)`)}`,
      );
    }
  }

  const seg = (key) => {
    const values = sample.map((r) => r[key]).filter((v) => v !== null);
    return values.length ? `p50 ${ms(percentile(values, 50))}  p95 ${ms(percentile(values, 95))}` : C.dim("no data");
  };
  console.log(C.dim(`  where it went:`));
  console.log(C.dim(`    to first model token   ${seg("firstTokenMs")}`));
  console.log(C.dim(`    to first sentence out  ${seg("firstSentenceMs")}`));
  console.log(C.dim(`    whole turn             ${seg("totalMs")}`));
}

const subject = rows.filter((r) => r.source === "subject");
const system = rows.filter((r) => r.source === "system");

console.log(`\n${C.bold("Turn latency")}  ${C.dim(`${store.kind}${cutoff ? `, last ${sinceRaw}` : ""}`)}`);
report("Subject turns — what N-01 is about", subject);
if (system.length) report("System turns — call start, reported apart", system);

// The rule that exists because breaking it produced ten seconds of silence.
const decided = rows.filter((r) => r.spokeBeforeTools !== null);
if (decided.length) {
  const silent = decided.filter((r) => !r.spokeBeforeTools);
  console.log(
    `\n${C.bold("Acknowledge before tools")}  ${
      silent.length === 0
        ? C.good(`held on all ${decided.length} turns`)
        : C.bad(`broken on ${silent.length} of ${decided.length} turns`)
    }`,
  );
  if (silent.length) {
    console.log(
      C.dim(
        `  A turn that called tools before speaking leaves the participant in\n` +
          `  silence with no way to tell a working call from a dropped one.`,
      ),
    );
  }
}
console.log();
