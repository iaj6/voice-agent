/**
 * Preloaded into every test process, before any test module is evaluated.
 *
 * The test command loads .env.local so the Postgres suite can reach a database.
 * That puts a live production connection string in the environment of every
 * other suite too, and getSessionStore() picks Postgres whenever DATABASE_URL
 * is set — so a future test that touched the store would write to the real
 * database, and would pass while doing it. audit_entry rejects DELETE, so those
 * rows would be permanent.
 *
 * Moving the credentials out of the name the application reads makes that
 * accident impossible rather than merely discouraged. A test that genuinely
 * wants a database asks for one by the stashed name, and gets a scratch
 * database — see scratch-db.ts.
 */

export const STASH = "VOICE_AGENT_TEST_DATABASE_URL";
export const STASH_UNPOOLED = "VOICE_AGENT_TEST_DATABASE_URL_UNPOOLED";

for (const [live, stash] of [
  ["DATABASE_URL", STASH],
  ["DATABASE_URL_UNPOOLED", STASH_UNPOOLED],
] as const) {
  if (process.env[live]) {
    process.env[stash] = process.env[live];
    delete process.env[live];
  }
}
