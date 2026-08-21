/**
 * Where the keys live, and how they are destroyed.
 *
 * One key per session. Not per subject, because a session exists before anyone
 * knows who is calling — verification happens several turns in, and the date of
 * birth is spoken before it. A key created at verification would leave the most
 * identifying utterance in the record unsealed.
 *
 * The key is bound to a subject when verification succeeds, so shredding a
 * subject destroys every key bound to them. A session that never verified is
 * shredded by its own id.
 */

import { getDb, isDatabaseConfigured } from "./db.ts";
import { KEY_BYTES, newKey } from "./seal.ts";

/**
 * Why a key is unavailable, which decides what the caller may do next.
 *
 * "destroyed" means a retention rule was applied and nothing further may be
 * written. "absent" means no key was ever minted — a session created before
 * sealing existed. Collapsing the two meant every pre-deploy session became
 * unwritable with an error announcing a destruction that never happened.
 */
export type KeyState = "live" | "destroyed" | "absent";

/** A key that was deliberately destroyed. Distinct from one that never existed. */
export class KeyDestroyedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Session ${sessionId} was shredded under a retention rule: its key has been ` +
        "destroyed and nothing further can be written to it.",
    );
    this.sessionId = sessionId;
  }
}

export interface KeyStore {
  readonly kind: "memory" | "postgres";
  /** Mints the key for a new session. */
  create(sessionId: string): Promise<Buffer>;
  /** The key, or null if it has been destroyed or never existed. */
  get(sessionId: string): Promise<Buffer | null>;
  /** Which of the two "no key" cases this is. */
  state(sessionId: string): Promise<KeyState>;
  /**
   * The key to seal with, minting one if this session predates sealing.
   *
   * Throws only when the key was destroyed. A session with no key yet gets one,
   * so content written from now on is shreddable even though whatever was
   * written before this deploy is not — that history cannot be re-sealed,
   * because audit_entry rejects UPDATE and re-hashing would break the chain.
   */
  ensureWritable(sessionId: string): Promise<Buffer>;
  /** Records who this session turned out to be, once verification succeeds. */
  bindSubject(sessionId: string, subjectId: string): Promise<void>;
  /** Destroys every key for a subject. Returns how many. */
  shredSubject(subjectId: string, reason: string): Promise<number>;
  /** Destroys one session's key. */
  shredSession(sessionId: string, reason: string): Promise<number>;
}

class MemoryKeyStore implements KeyStore {
  readonly kind = "memory" as const;
  private keys = new Map<string, { key: Buffer | null; subjectId: string | null }>();

  async create(sessionId: string): Promise<Buffer> {
    const key = newKey();
    this.keys.set(sessionId, { key, subjectId: null });
    return key;
  }

  async get(sessionId: string): Promise<Buffer | null> {
    return this.keys.get(sessionId)?.key ?? null;
  }

  async state(sessionId: string): Promise<KeyState> {
    const row = this.keys.get(sessionId);
    if (!row) return "absent";
    return row.key ? "live" : "destroyed";
  }

  async ensureWritable(sessionId: string): Promise<Buffer> {
    const state = await this.state(sessionId);
    if (state === "destroyed") throw new KeyDestroyedError(sessionId);
    const existing = await this.get(sessionId);
    return existing ?? (await this.create(sessionId));
  }

  async bindSubject(sessionId: string, subjectId: string): Promise<void> {
    const row = this.keys.get(sessionId);
    if (row) row.subjectId = subjectId;
  }

  async shredSubject(subjectId: string): Promise<number> {
    let n = 0;
    for (const row of this.keys.values()) {
      if (row.subjectId === subjectId && row.key) {
        row.key = null;
        n += 1;
      }
    }
    return n;
  }

  async shredSession(sessionId: string): Promise<number> {
    const row = this.keys.get(sessionId);
    if (!row?.key) return 0;
    row.key = null;
    return 1;
  }
}

class PostgresKeyStore implements KeyStore {
  readonly kind = "postgres" as const;

  async create(sessionId: string): Promise<Buffer> {
    const sql = getDb();
    const key = newKey();
    await sql`
      insert into session_key (session_id, key) values (${sessionId}, ${key})
      on conflict (session_id) do nothing`;

    // A conflict means this session already has a key; use it rather than a
    // second one. If it has a *destroyed* key, returning the freshly minted one
    // would seal content under a key that was never stored — unreadable by
    // everyone, including the legitimate reader, and indistinguishable from
    // shredded on the next load.
    const stored = await this.get(sessionId);
    if (stored) return stored;
    if ((await this.state(sessionId)) === "destroyed") {
      throw new KeyDestroyedError(sessionId);
    }
    return key;
  }

  async state(sessionId: string): Promise<KeyState> {
    const sql = getDb();
    const rows = (await sql`
      select (key is not null) as live from session_key
       where session_id = ${sessionId}`) as { live: boolean }[];
    if (rows.length === 0) return "absent";
    return rows[0].live ? "live" : "destroyed";
  }

  async ensureWritable(sessionId: string): Promise<Buffer> {
    const state = await this.state(sessionId);
    if (state === "destroyed") throw new KeyDestroyedError(sessionId);
    if (state === "absent") return this.create(sessionId);
    return (await this.get(sessionId))!;
  }

  async get(sessionId: string): Promise<Buffer | null> {
    const sql = getDb();
    const rows = (await sql`
      select key from session_key where session_id = ${sessionId}`) as {
      key: Buffer | Uint8Array | string | null;
    }[];
    const raw = rows[0]?.key;
    if (raw == null) return null;
    // The driver hands bytea back as a Buffer, a Uint8Array, or a \\x hex string
    // depending on the path. A key that reads back the wrong length would decrypt
    // to garbage rather than fail, so the length is checked, not assumed.
    const key =
      typeof raw === "string"
        ? Buffer.from(raw.replace(/^\\x/, ""), "hex")
        : Buffer.from(raw);
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Session key for ${sessionId} is ${key.length} bytes, expected ${KEY_BYTES}.`,
      );
    }
    return key;
  }

  async bindSubject(sessionId: string, subjectId: string): Promise<void> {
    const sql = getDb();
    await sql`
      update session_key set subject_id = ${subjectId}
       where session_id = ${sessionId} and subject_id is null`;
  }

  async shredSubject(subjectId: string, reason: string): Promise<number> {
    const sql = getDb();
    const rows = (await sql`
      update session_key
         set key = null, destroyed_at = now(), destroyed_reason = ${reason}
       where subject_id = ${subjectId} and key is not null
      returning session_id`) as { session_id: string }[];

    // escalation_delivery carries subject_id in the clear — it has to, because a
    // coordinator's inbox is not the place to look up who a page was about, and
    // the alarm query needs it. Sealing was designed around one key per session
    // and this table sits outside that, so shredding has to reach it explicitly
    // or "that subject had an emergency escalation on that date" survives an
    // erasure. Defence in depth rather than a complete answer: see the residual
    // note in docs/RETENTION.md D4.
    await sql`
      update escalation_delivery set subject_id = null, updated_at = now()
       where subject_id = ${subjectId}`;

    return rows.length;
  }

  async shredSession(sessionId: string, reason: string): Promise<number> {
    const sql = getDb();
    const rows = (await sql`
      update session_key
         set key = null, destroyed_at = now(), destroyed_reason = ${reason}
       where session_id = ${sessionId} and key is not null
      returning session_id`) as { session_id: string }[];
    return rows.length;
  }
}

let store: KeyStore | null = null;

export function getKeyStore(): KeyStore {
  if (!store) {
    store = isDatabaseConfigured() ? new PostgresKeyStore() : new MemoryKeyStore();
  }
  return store;
}

/** Test seam. */
export function __setKeyStore(next: KeyStore | null) {
  store = next;
}
