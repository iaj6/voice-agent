/**
 * The gate.
 *
 * One command that decides whether the working tree is in a state anything else
 * should be built on. Semi-autonomous work needs this: without an objective
 * check, "done" is an assertion rather than a fact, and the failure modes in this
 * codebase have consistently been things that looked finished and were not.
 *
 *   npm run verify
 *
 * Deliberately does NOT run the simulated-patient eval — that needs a live dev
 * server and a model provider, and a gate that is sometimes unavailable stops
 * being run. Use `npm run eval:fast` alongside this for anything that touches the
 * conversation.
 */

import { spawn } from "node:child_process";

const C = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  good: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
  bad: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const STEPS = [
  { name: "types", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "lint", cmd: "npx", args: ["eslint", ".", "--max-warnings=0"] },
  { name: "unit tests", cmd: "npm", args: ["test", "--silent"] },
  {
    name: "safety-net floor",
    cmd: "node",
    args: [
      "scripts/measure-net.mjs",
      // Floors track the measured position; raising them is deliberate work.
      "--min-sensitivity=0.50",
      "--min-specificity=1.0",
    ],
  },
];

function run(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.cmd, step.args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) =>
      resolve({ ...step, code, out, ms: Date.now() - started }),
    );
  });
}

console.log(`\n${C.bold("verify")}`);

let failed = 0;
for (const step of STEPS) {
  const r = await run(step);
  const mark = r.code === 0 ? C.good("✓") : C.bad("✗");
  console.log(
    `  ${mark} ${r.name.padEnd(18)} ${C.dim(`${(r.ms / 1000).toFixed(1)}s`)}`,
  );
  if (r.code !== 0) {
    failed++;
    const lines = r.out.split("\n").filter(Boolean);
    for (const line of lines.slice(-25)) console.log(`      ${C.dim(line)}`);
  }
}

if (failed) {
  console.log(`\n  ${C.bad(`${failed} step(s) failed`)}\n`);
  process.exit(1);
}
console.log(`\n  ${C.good("green")} ${C.dim("— safe to build on")}\n`);
