import { createHash } from "node:crypto";
import { seal } from "./seal.ts";

/**
 * Append-only, hash-chained audit trail.
 *
 * Models the 21 CFR 11.10(e) requirement for secure, computer-generated,
 * time-stamped audit trails that record operator entries and actions, do not
 * obscure previously recorded information, and are retained for the record's
 * lifetime. Each entry commits to its predecessor, so any retroactive edit
 * breaks the chain and is detectable by verifyChain().
 *
 * NOT a validated implementation. A production system needs durable WORM
 * storage, per-record retention policy, and CSV evidence behind it.
 */

/**
 * Who did the thing.
 *
 * `coordinator` is the only human in this list, and it exists because
 * acknowledging an escalation is the only action in the whole system a person
 * takes — and it was recorded solely in `escalation_delivery`, outside the
 * hash-chained trail that is the record's evidence of what happened to it.
 * 21 CFR 11.10(e) wants operator actions on that trail; this was the one
 * operator action there was.
 */
export type AuditActor =
  | "subject"
  | "agent"
  | "system"
  | "safety_net"
  | "coordinator";

export interface AuditEntry {
  seq: number;
  timestamp: string;
  sessionId: string;
  actor: AuditActor;
  /** Verb, e.g. "SUBJECT_VERIFIED", "AE_RECORDED". */
  action: string;
  /** Record type touched, e.g. "AdverseEvent". */
  entity: string;
  entityId: string | null;
  /** Prior value for changed records. Null for creations. */
  before: unknown;
  after: unknown;
  /** 21 CFR 11 expects a reason on modifications. */
  reason: string;
  prevHash: string;
  hash: string;
}

const GENESIS_HASH = "0".repeat(64);

/**
 * Recursively orders object keys so serialization is independent of insertion
 * order.
 *
 * Required because the trail is persisted as JSONB, and **Postgres reorders
 * JSONB keys** (by length, then bytewise). Hashing raw `JSON.stringify` output
 * meant an entry verified in memory and failed the moment it was read back from
 * the database — the integrity guarantee would have held right up until the
 * first restart, and then quietly stopped holding. Canonicalising both when
 * hashing and when re-verifying makes storage order irrelevant.
 *
 * Arrays keep their order: element order is data, not representation.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    ordered[key] = canonicalize(source[key]);
  }
  return ordered;
}

function computeHash(entry: Omit<AuditEntry, "hash">): string {
  const payload = JSON.stringify({
    seq: entry.seq,
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    actor: entry.actor,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    before: canonicalize(entry.before ?? null),
    after: canonicalize(entry.after ?? null),
    reason: entry.reason,
    prevHash: entry.prevHash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function snapshotValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return structuredClone(value);
}

export class AuditTrail {
  private entries: AuditEntry[] = [];
  private readonly sessionId: string;
  /**
   * The session key, when this trail is sealing.
   *
   * Sealing happens *before* hashing, so the chain covers ciphertext. That is
   * the whole reason crypto-shredding works here: destroy the key and the
   * content is unreadable, while every entry still hashes to what it always
   * hashed to and the chain still verifies. Hashing plaintext and encrypting
   * afterwards would mean a shredded record could never be verified again —
   * which is to say it would look tampered with rather than destroyed.
   */
  private key: { id: string; material: Buffer } | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Turns on sealing for entries recorded from here on.
   *
   * Entries already recorded are left alone. Re-sealing them would change their
   * hashes, and rewriting history to make it more private is still rewriting
   * history.
   */
  sealWith(keyId: string, material: Buffer): void {
    this.key = { id: keyId, material };
  }

  record(input: {
    actor: AuditActor;
    action: string;
    entity: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    reason: string;
  }): AuditEntry {
    const prevHash =
      this.entries.length === 0
        ? GENESIS_HASH
        : this.entries[this.entries.length - 1].hash;

    const draft: Omit<AuditEntry, "hash"> = {
      seq: this.entries.length + 1,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      actor: input.actor,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      // Deep-clone, do not reference. Callers hand us live domain objects that
      // they go on to mutate; holding a reference would let a later edit
      // retroactively rewrite what this entry says happened — which is the exact
      // failure mode an audit trail exists to prevent. It also breaks the hash
      // chain, since verifyChain() would rehash the mutated value.
      before: this.protect(input.before),
      after: this.protect(input.after),
      // NOT protected, deliberately — an operator reading a trail after a
      // subject has been shredded still needs to know *why* each entry exists,
      // and sealing this would leave a chain of opaque blobs nobody can account
      // for.
      //
      // Which makes it a rule about callers: **nothing participant-derived may
      // go in here.** `audit_entry` rejects UPDATE and DELETE, so anything
      // written to this field survives key destruction and cannot be erased.
      // Put the participant's words in `before`/`after`, which are sealed, and
      // keep this to what the system did. One caller broke this — the
      // seriousness basis — and the sentence it wrote was a quote.
      reason: input.reason,
      prevHash,
    };

    const entry: AuditEntry = { ...draft, hash: computeHash(draft) };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Snapshot, then seal if this trail has a key.
   *
   * Null stays null. An entry with no before-value should still read as having
   * none after shredding, rather than as an opaque blob nobody can account for.
   */
  private protect(value: unknown): unknown {
    const snapshot = snapshotValue(value);
    if (snapshot === null || snapshot === undefined) return null;
    if (!this.key) return snapshot;
    return seal(snapshot, this.key.id, this.key.material);
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  /**
   * Rebuilds a trail from persisted entries.
   *
   * Does not re-verify on load — call verifyChain() for that. Rehydrating and
   * verifying are separate on purpose: a trail that fails verification still
   * needs to be loadable, because the broken chain is itself the finding and
   * hiding it behind a constructor error would lose it.
   */
  /**
   * Re-sequences this process's unwritten entries onto a trail somebody else
   * extended, and returns the ones to insert.
   *
   * Two writers holding the same session is ordinary — a coordinator clicking
   * the acknowledgement link while the call is still running is the case that
   * made this necessary. Both mint the same next sequence number, and there are
   * three things you can do about it. Drop one silently, which is what the code
   * did and is a hole in the record. Throw, which is what replaced it and turns
   * an ordinary race into a call that fails for the participant and keeps failing
   * for the rest of the call, because the conflicting entry stays in memory.
   *
   * Or rebase: keep both, renumber ours after theirs, and rehash the chain from
   * that point. Hashes survive the round trip through JSONB because canonicalize
   * sorts keys — which is the property this file already established for exactly
   * this kind of reason.
   */
  rebaseOnto(persisted: AuditEntry[], persistedHashes: Set<string>): AuditEntry[] {
    const mine = this.entries.filter((e) => !persistedHashes.has(e.hash));
    const ordered = [...persisted].sort((a, b) => a.seq - b.seq);

    let seq = ordered.length === 0 ? 0 : ordered[ordered.length - 1].seq;
    let prev = ordered.length === 0 ? GENESIS_HASH : ordered[ordered.length - 1].hash;

    const rebased = mine.map((entry) => {
      seq += 1;
      const draft: Omit<AuditEntry, "hash"> = { ...entry, seq, prevHash: prev };
      const rehashed: AuditEntry = { ...draft, hash: computeHash(draft) };
      prev = rehashed.hash;
      return rehashed;
    });

    this.entries = [...ordered, ...rebased];
    return rebased;
  }

  static rehydrate(sessionId: string, entries: AuditEntry[]): AuditTrail {
    const trail = new AuditTrail(sessionId);
    trail.entries = [...entries].sort((a, b) => a.seq - b.seq);
    return trail;
  }

  since(seq: number): AuditEntry[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  /** Recomputes every hash. Returns the first broken link, if any. */
  verifyChain(): { valid: true } | { valid: false; brokenAtSeq: number; detail: string } {
    let prevHash = GENESIS_HASH;
    for (const entry of this.entries) {
      if (entry.prevHash !== prevHash) {
        return {
          valid: false,
          brokenAtSeq: entry.seq,
          detail: `prevHash mismatch: entry claims ${entry.prevHash.slice(0, 12)}…, chain has ${prevHash.slice(0, 12)}…`,
        };
      }
      const { hash, ...rest } = entry;
      const recomputed = computeHash(rest);
      if (recomputed !== hash) {
        return {
          valid: false,
          brokenAtSeq: entry.seq,
          detail: `content hash mismatch: stored ${hash.slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…`,
        };
      }
      prevHash = hash;
    }
    return { valid: true };
  }
}
