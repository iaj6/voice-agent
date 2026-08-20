import { createHash } from "node:crypto";

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

export type AuditActor = "subject" | "agent" | "system" | "safety_net";

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

  constructor(sessionId: string) {
    this.sessionId = sessionId;
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
      before: snapshotValue(input.before),
      after: snapshotValue(input.after),
      reason: input.reason,
      prevHash,
    };

    const entry: AuditEntry = { ...draft, hash: computeHash(draft) };
    this.entries.push(entry);
    return entry;
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
