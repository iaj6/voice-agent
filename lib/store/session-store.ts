import { randomUUID } from "node:crypto";
import { AuditTrail, type AuditEntry } from "./audit";
import { getDb, isDatabaseConfigured } from "./db";
import type { CheckInSession } from "./session";

/**
 * Where check-in sessions live.
 *
 * Two implementations behind one interface. The in-memory one keeps the unit
 * tests and any DATABASE_URL-less checkout working; the Postgres one is what a
 * call with a real participant runs on. The distinction that matters is not
 * speed — it is that a process restart mid-call currently loses a reported
 * adverse event, which is unacceptable rather than inconvenient.
 */
export interface SessionStore {
  readonly kind: "memory" | "postgres";
  create(): Promise<CheckInSession>;
  get(id: string): Promise<CheckInSession | null>;
  save(session: CheckInSession): Promise<void>;
}

/** The clinical record, separated from the conversation for storage. */
interface StoredRecord {
  adverseEvents: CheckInSession["adverseEvents"];
  safetyScreen: CheckInSession["safetyScreen"];
  adherence: CheckInSession["adherence"];
  conMeds: CheckInSession["conMeds"];
  escalations: CheckInSession["escalations"];
  solicitedReviewed: CheckInSession["solicitedReviewed"];
  subject: CheckInSession["subject"];
  verificationAttempts: number;
}

function toRecord(session: CheckInSession): StoredRecord {
  return {
    adverseEvents: session.adverseEvents,
    safetyScreen: session.safetyScreen,
    adherence: session.adherence,
    conMeds: session.conMeds,
    escalations: session.escalations,
    solicitedReviewed: session.solicitedReviewed,
    subject: session.subject,
    verificationAttempts: session.verificationAttempts,
  };
}

function blankSession(id: string): CheckInSession {
  return {
    id,
    createdAt: new Date().toISOString(),
    status: "awaiting_verification",
    subject: null,
    verificationAttempts: 0,
    messages: [],
    adverseEvents: [],
    safetyScreen: null,
    adherence: null,
    conMeds: [],
    escalations: [],
    solicitedReviewed: [],
    summary: null,
    completedAt: null,
    audit: new AuditTrail(id),
  };
}

function openingEntry(session: CheckInSession) {
  session.audit.record({
    actor: "system",
    action: "SESSION_OPENED",
    entity: "CheckInSession",
    entityId: session.id,
    after: { status: session.status },
    reason: "Subject initiated a voice check-in.",
  });
}

// ---------------------------------------------------------------------------

class MemorySessionStore implements SessionStore {
  readonly kind = "memory" as const;
  private sessions = new Map<string, CheckInSession>();

  async create(): Promise<CheckInSession> {
    const session = blankSession(randomUUID());
    openingEntry(session);
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<CheckInSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async save(session: CheckInSession): Promise<void> {
    this.sessions.set(session.id, session);
  }
}

// ---------------------------------------------------------------------------

class PostgresSessionStore implements SessionStore {
  readonly kind = "postgres" as const;

  async create(): Promise<CheckInSession> {
    const sql = getDb();
    const session = blankSession(randomUUID());
    openingEntry(session);
    await sql`
      insert into check_in_session (id, created_at, status, record, messages)
      values (${session.id}, ${session.createdAt}, ${session.status},
              ${JSON.stringify(toRecord(session))}::jsonb, '[]'::jsonb)`;
    await this.appendAudit(session);
    return session;
  }

  async get(id: string): Promise<CheckInSession | null> {
    const sql = getDb();
    const rows = await sql`
      select id, created_at, status, record, messages, summary, completed_at
      from check_in_session where id = ${id}`;
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;

    const entries = (await sql`
      select seq, recorded_at, actor, action, entity, entity_id,
             before_value, after_value, reason, prev_hash, hash
      from audit_entry where session_id = ${id} order by seq`) as Record<string, unknown>[];

    const record = row.record as StoredRecord;
    return {
      id: String(row.id),
      createdAt: new Date(row.created_at as string).toISOString(),
      status: row.status as CheckInSession["status"],
      subject: record.subject ?? null,
      verificationAttempts: record.verificationAttempts ?? 0,
      messages: (row.messages ?? []) as CheckInSession["messages"],
      adverseEvents: record.adverseEvents ?? [],
      safetyScreen: record.safetyScreen ?? null,
      adherence: record.adherence ?? null,
      conMeds: record.conMeds ?? [],
      escalations: record.escalations ?? [],
      solicitedReviewed: record.solicitedReviewed ?? [],
      summary: (row.summary as string | null) ?? null,
      completedAt: row.completed_at
        ? new Date(row.completed_at as string).toISOString()
        : null,
      audit: AuditTrail.rehydrate(
        id,
        entries.map(
          (e): AuditEntry => ({
            seq: Number(e.seq),
            timestamp: new Date(e.recorded_at as string).toISOString(),
            sessionId: id,
            actor: e.actor as AuditEntry["actor"],
            action: String(e.action),
            entity: String(e.entity),
            entityId: (e.entity_id as string | null) ?? null,
            before: e.before_value ?? null,
            after: e.after_value ?? null,
            reason: String(e.reason),
            prevHash: String(e.prev_hash),
            hash: String(e.hash),
          }),
        ),
      ),
    };
  }

  async save(session: CheckInSession): Promise<void> {
    const sql = getDb();
    // `completed_at is null` makes this a no-op once the record is locked,
    // so the lock trigger never has to fire on our own writes.
    await sql`
      update check_in_session
         set status = ${session.status},
             subject_id = ${session.subject?.subjectId ?? null},
             record = ${JSON.stringify(toRecord(session))}::jsonb,
             messages = ${JSON.stringify(session.messages)}::jsonb,
             summary = ${session.summary},
             completed_at = ${session.completedAt},
             updated_at = now()
       where id = ${session.id} and completed_at is null`;
    await this.appendAudit(session);
  }

  /** Inserts only entries not already persisted. The table rejects rewrites. */
  private async appendAudit(session: CheckInSession): Promise<void> {
    const sql = getDb();
    const [{ high }] = (await sql`
      select coalesce(max(seq), 0) as high from audit_entry
      where session_id = ${session.id}`) as { high: number }[];

    const pending = session.audit.all().filter((e) => e.seq > Number(high));
    if (pending.length === 0) return;

    await sql.transaction(
      pending.map(
        (e) => sql`
          insert into audit_entry
            (session_id, seq, recorded_at, actor, action, entity, entity_id,
             before_value, after_value, reason, prev_hash, hash)
          values
            (${session.id}, ${e.seq}, ${e.timestamp}, ${e.actor}, ${e.action},
             ${e.entity}, ${e.entityId},
             ${e.before === null ? null : JSON.stringify(e.before)}::jsonb,
             ${e.after === null ? null : JSON.stringify(e.after)}::jsonb,
             ${e.reason}, ${e.prevHash}, ${e.hash})`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------

let store: SessionStore | null = null;

/**
 * Postgres when configured, memory otherwise.
 *
 * The fallback is for tests and for a checkout without credentials — never a
 * production posture. `verify` reports which one is active so a run against the
 * wrong backing is visible rather than silent.
 */
export function getSessionStore(): SessionStore {
  if (!store) {
    store = isDatabaseConfigured()
      ? new PostgresSessionStore()
      : new MemorySessionStore();
  }
  return store;
}

/** Test seam. */
export function __setSessionStore(next: SessionStore | null) {
  store = next;
}
