/**
 * Destroys a subject's content by destroying the keys that read it.
 *
 *   node scripts/shred.mjs --subject 001-0042 --reason "Sponsor authorised ..."
 *   node scripts/shred.mjs --subject 001-0042 --reason "..." --confirm
 *
 * Reports what it would destroy and stops, unless --confirm is given. There is
 * no undo: the record and its audit trail survive and still verify, and the
 * content does not.
 *
 * A reason is required. "Who authorised this and under what retention rule" is
 * the question asked afterwards, and it has to have been recorded at the time.
 */

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

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

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const subject = valueOf("--subject");
const reason = valueOf("--reason");
const confirm = args.includes("--confirm");

if (!subject || !reason) {
  console.error(
    "\nUsage: node scripts/shred.mjs --subject <id> --reason <text> [--confirm]\n\n" +
      "  Both are required. A destruction with no recorded reason is not evidence\n" +
      "  of compliance, it is just missing data.\n",
  );
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

const targets = await sql`
  select k.session_id, s.created_at, s.status, s.completed_at,
         (k.key is null) as already_destroyed
    from session_key k
    join check_in_session s on s.id = k.session_id
   where k.subject_id = ${subject}
   order by s.created_at`;

console.log(`\n${C.bold(`subject ${subject}`)}`);
if (targets.length === 0) {
  console.log(`  ${C.dim("no sessions hold a key for this subject")}\n`);
  process.exit(0);
}

let live = 0;
for (const t of targets) {
  const when = new Date(t.created_at).toISOString().slice(0, 16).replace("T", " ");
  if (t.already_destroyed) {
    console.log(`  ${C.dim("·")} ${when}  ${C.dim(`${t.status} — already destroyed`)}`);
  } else {
    live += 1;
    console.log(`  ${C.bad("×")} ${when}  ${t.status}`);
  }
}

if (live === 0) {
  console.log(`\n  ${C.dim("nothing left to destroy")}\n`);
  process.exit(0);
}

if (!confirm) {
  console.log(
    `\n  ${C.bold(`${live} session(s) would be destroyed.`)} Nothing has changed.\n` +
      `  ${C.dim("Re-run with --confirm to proceed. There is no undo.")}\n`,
  );
  process.exit(0);
}

const destroyed = await sql`
  update session_key
     set key = null, destroyed_at = now(), destroyed_reason = ${reason}
   where subject_id = ${subject} and key is not null
  returning session_id`;

console.log(`\n  ${C.good(`${destroyed.length} key(s) destroyed.`)}`);
console.log(
  `  ${C.dim("The records and their audit trails remain and still verify;")}\n` +
    `  ${C.dim("their content is unrecoverable.")}\n`,
);
