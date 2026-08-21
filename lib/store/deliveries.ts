/**
 * Delivery attempts, and whether anyone acknowledged them.
 *
 * One row per attempt. A retry is a new attempt with its own outcome, because
 * "the first send failed and the second worked" is a different fact from "it was
 * delivered", and the first half is the part a monitor asks about.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDb, isDatabaseConfigured } from "./db.ts";
import type { EscalationUrgency } from "../clinical/safety.ts";

export type DeliveryStatus = "queued" | "sent" | "failed" | "acknowledged";

export interface DeliveryRecord {
  id: string;
  sessionId: string;
  escalationId: string;
  subjectId: string | null;
  urgency: EscalationUrgency;
  channel: string;
  destination: string;
  attempt: number;
  status: DeliveryStatus;
  providerId: string | null;
  error: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  deadlineAt: string;
}

export interface NewDelivery {
  sessionId: string;
  escalationId: string;
  subjectId: string | null;
  urgency: EscalationUrgency;
  channel: string;
  destination: string;
  attempt: number;
  deadlineAt: Date;
}

/** Only the hash is stored, so a database read cannot forge an acknowledgement. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newAckToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface DeliveryStore {
  readonly kind: "memory" | "postgres";
  queue(input: NewDelivery, ackToken: string): Promise<DeliveryRecord>;
  markSent(id: string, providerId: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /** Looks a delivery up by token without changing it. Used by the GET view. */
  find(token: string): Promise<DeliveryRecord | null>;
  /** Acknowledges by token. Returns the record, or null if the token is unknown. */
  acknowledge(token: string, by: string): Promise<DeliveryRecord | null>;
  forSession(sessionId: string): Promise<DeliveryRecord[]>;
  /** Sent, unacknowledged, past deadline. The alarm list. */
  overdue(now?: Date): Promise<DeliveryRecord[]>;
  attemptsFor(sessionId: string, escalationId: string): Promise<number>;
}

function rowToRecord(row: Record<string, unknown>): DeliveryRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    escalationId: String(row.escalation_id),
    subjectId: (row.subject_id as string | null) ?? null,
    urgency: row.urgency as EscalationUrgency,
    channel: String(row.channel),
    destination: String(row.destination),
    attempt: Number(row.attempt),
    status: row.status as DeliveryStatus,
    providerId: (row.provider_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    acknowledgedAt: row.acknowledged_at
      ? new Date(row.acknowledged_at as string).toISOString()
      : null,
    acknowledgedBy: (row.acknowledged_by as string | null) ?? null,
    deadlineAt: new Date(row.deadline_at as string).toISOString(),
  };
}

class MemoryDeliveryStore implements DeliveryStore {
  readonly kind = "memory" as const;
  private rows = new Map<string, DeliveryRecord & { ackTokenHash: string }>();

  async queue(input: NewDelivery, ackToken: string): Promise<DeliveryRecord> {
    const record = {
      id: randomUUID(),
      ...input,
      status: "queued" as DeliveryStatus,
      providerId: null,
      error: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      deadlineAt: input.deadlineAt.toISOString(),
      ackTokenHash: hashToken(ackToken),
    };
    this.rows.set(record.id, record);
    return { ...record };
  }

  async markSent(id: string, providerId: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "sent";
      row.providerId = providerId;
    }
  }

  async markFailed(id: string, error: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "failed";
      row.error = error;
    }
  }

  async find(token: string): Promise<DeliveryRecord | null> {
    const hash = hashToken(token);
    for (const row of this.rows.values()) {
      if (row.ackTokenHash === hash) return { ...row };
    }
    return null;
  }

  async acknowledge(token: string, by: string): Promise<DeliveryRecord | null> {
    const hash = hashToken(token);
    for (const row of this.rows.values()) {
      if (row.ackTokenHash !== hash) continue;
      // First acknowledgement wins. A second click is not a second human.
      if (!row.acknowledgedAt) {
        row.acknowledgedAt = new Date().toISOString();
        row.acknowledgedBy = by;
        row.status = "acknowledged";
      }
      return { ...row };
    }
    return null;
  }

  async forSession(sessionId: string): Promise<DeliveryRecord[]> {
    // Copies, like queue() and acknowledge(). Handing out the stored objects let
    // a caller mutate store state — and leaked the private ackTokenHash with it.
    return [...this.rows.values()]
      .filter((r) => r.sessionId === sessionId)
      .map((r) => ({ ...r }));
  }

  async overdue(now = new Date()): Promise<DeliveryRecord[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.acknowledgedAt === null &&
          r.status !== "failed" &&
          Date.parse(r.deadlineAt) < now.getTime(),
      )
      .map((r) => ({ ...r }));
  }

  async attemptsFor(sessionId: string, escalationId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (r) => r.sessionId === sessionId && r.escalationId === escalationId,
    ).length;
  }
}

class PostgresDeliveryStore implements DeliveryStore {
  readonly kind = "postgres" as const;

  async queue(input: NewDelivery, ackToken: string): Promise<DeliveryRecord> {
    const sql = getDb();
    const id = randomUUID();
    const rows = (await sql`
      insert into escalation_delivery
        (id, session_id, escalation_id, subject_id, urgency, channel, destination,
         attempt, status, ack_token_hash, deadline_at)
      values (${id}, ${input.sessionId}, ${input.escalationId}, ${input.subjectId},
              ${input.urgency}, ${input.channel}, ${input.destination},
              ${input.attempt}, 'queued', ${hashToken(ackToken)}, ${input.deadlineAt.toISOString()})
      returning *`) as Record<string, unknown>[];
    return rowToRecord(rows[0]);
  }

  async markSent(id: string, providerId: string): Promise<void> {
    const sql = getDb();
    await sql`
      update escalation_delivery
         set status = 'sent', provider_id = ${providerId}, updated_at = now()
       where id = ${id}`;
  }

  async markFailed(id: string, error: string): Promise<void> {
    const sql = getDb();
    await sql`
      update escalation_delivery
         set status = 'failed', error = ${error}, updated_at = now()
       where id = ${id}`;
  }

  async find(token: string): Promise<DeliveryRecord | null> {
    const sql = getDb();
    const rows = (await sql`
      select * from escalation_delivery
       where ack_token_hash = ${hashToken(token)}`) as Record<string, unknown>[];
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  async acknowledge(token: string, by: string): Promise<DeliveryRecord | null> {
    const sql = getDb();
    // Conditional on not already acknowledged, so a second click does not
    // overwrite who actually responded first.
    const rows = (await sql`
      update escalation_delivery
         set status = 'acknowledged', acknowledged_at = now(),
             acknowledged_by = ${by}, updated_at = now()
       where ack_token_hash = ${hashToken(token)} and acknowledged_at is null
      returning *`) as Record<string, unknown>[];
    if (rows.length > 0) return rowToRecord(rows[0]);

    // Already acknowledged, or unknown token. Distinguish them for the caller.
    const existing = (await sql`
      select * from escalation_delivery
       where ack_token_hash = ${hashToken(token)}`) as Record<string, unknown>[];
    return existing.length > 0 ? rowToRecord(existing[0]) : null;
  }

  async forSession(sessionId: string): Promise<DeliveryRecord[]> {
    const sql = getDb();
    const rows = (await sql`
      select * from escalation_delivery
       where session_id = ${sessionId} order by created_at`) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  async overdue(now = new Date()): Promise<DeliveryRecord[]> {
    const sql = getDb();
    const rows = (await sql`
      select * from escalation_delivery
       where acknowledged_at is null and status <> 'failed'
         and deadline_at < ${now.toISOString()}
       order by deadline_at`) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  async attemptsFor(sessionId: string, escalationId: string): Promise<number> {
    const sql = getDb();
    const rows = (await sql`
      select count(*)::int as n from escalation_delivery
       where session_id = ${sessionId} and escalation_id = ${escalationId}`) as {
      n: number;
    }[];
    return rows[0]?.n ?? 0;
  }
}

let store: DeliveryStore | null = null;

export function getDeliveryStore(): DeliveryStore {
  if (!store) {
    store = isDatabaseConfigured()
      ? new PostgresDeliveryStore()
      : new MemoryDeliveryStore();
  }
  return store;
}

/** Test seam. */
export function __setDeliveryStore(next: DeliveryStore | null) {
  store = next;
}
