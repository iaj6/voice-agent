import { readFileSync } from "node:fs";
import { scanForSafetySignals, assertedHits } from "./lib/clinical/safety.ts";
const staged = JSON.parse(readFileSync("tests/corpus/staged.json", "utf8"));

const fires = (t) => assertedHits(scanForSafetySignals(t)).length > 0;
const quiet = staged.filter((e) => e.expect === null);
const signal = staged.filter((e) => e.expect !== null);

const quietThatFire = quiet.filter((e) => fires(e.text));
const signalThatFire = signal.filter((e) => fires(e.text));

console.log(`  staged: ${staged.length}  (${signal.length} signal, ${quiet.length} quiet)`);
console.log(`  signal entries the net already catches: ${signalThatFire.length}/${signal.length}`);
console.log(`\n  QUIET ENTRIES THE NET FIRES ON — each needs a human decision (${quietThatFire.length}):`);
for (const e of quietThatFire) {
  console.log(`    [${e.kind}/${e.topic}] ${JSON.stringify(e.text.slice(0, 95))}`);
}
