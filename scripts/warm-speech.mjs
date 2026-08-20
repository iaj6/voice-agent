/**
 * Pre-renders the fixed protocol speech into the server-side cache.
 *
 * About two thirds of what the agent says on a routine check-in is identical
 * every time — the greeting, the two verification prompts, the six solicited
 * symptom questions, the adherence and medication questions. Rendering them once
 * up front means:
 *
 *   - no synthesis latency at all for those turns, on any call
 *   - no per-call cost for the majority of the agent's speech
 *   - that text is never transmitted to the speech provider again, and it is the
 *     portion that carries no patient-reported content
 *
 * Run after any change to the protocol wording, the voice, or the model —
 * the cache key covers all three, so stale entries are ignored rather than
 * served.
 *
 *   node scripts/warm-speech.mjs
 */

const BASE = process.env.VOICE_AGENT_URL ?? "http://localhost:3100";

const listRes = await fetch(`${BASE}/api/speech`);
if (!listRes.ok) {
  console.error(`Could not read the fixed-line list from ${BASE}/api/speech (${listRes.status}). Is the dev server running?`);
  process.exit(1);
}
const { lines: FIXED_LINES } = await listRes.json();

let hits = 0;
let misses = 0;
let failures = 0;
let bytes = 0;

console.log(`Warming ${FIXED_LINES.length} fixed lines against ${BASE}\n`);

for (const text of FIXED_LINES) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      failures++;
      const detail = await res.text().catch(() => "");
      console.log(`  ✗ ${res.status}  ${text.slice(0, 58)}…`);
      if (detail) console.log(`     ${detail.slice(0, 160)}`);
      continue;
    }
    const cache = res.headers.get("X-Speech-Cache");
    const buf = await res.arrayBuffer();
    bytes += buf.byteLength;
    if (cache === "hit") hits++;
    else misses++;
    const ms = Date.now() - started;
    console.log(
      `  ${cache === "hit" ? "·" : "✓"} ${String(ms).padStart(5)}ms  ${(buf.byteLength / 1024).toFixed(0).padStart(4)}KB  ${cache === "hit" ? "cached" : "rendered"}  ${text.slice(0, 46)}…`,
    );
  } catch (err) {
    failures++;
    console.log(`  ✗ ${err.message}  ${text.slice(0, 50)}…`);
  }
}

const chars = FIXED_LINES.reduce((n, l) => n + l.length, 0);
console.log(
  `\n  rendered ${misses}, already cached ${hits}, failed ${failures}` +
    `\n  ${chars.toLocaleString()} characters now served from cache, ${(bytes / 1024).toFixed(0)}KB of audio`,
);
process.exit(failures > 0 ? 1 : 0);
