import { randomUUID } from "node:crypto";
import { AuditTrail, type AuditEntry } from "./audit.ts";
import { getDb, isDatabaseConfigured } from "./db.ts";
import { getKeyStore } from "./keys.ts";
import { isSealed, seal, unsealOrMark, type SealedValue } from "./seal.ts";
import type { CheckInSession } from "./session.ts";

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
  /**
   * Claims the most recent *dropped* check-in for a subject, or null.
   *
   * Claiming rather than finding: the lookup and the reservation have to be one
   * operation. Two redials landing together — a retried webhook, a subject
   * dialling twice — otherwise both see an unclaimed session and both carry the
   * same adverse events forward into two records.
   *
   * Bounded two ways. By age, because an unfinished session from last week is an
   * abandoned check-in rather than a dropped call, and merging those merges two
   * visits into one record. And by idleness, because a session with a write
   * seconds ago is not dropped — it is a call that is still happening, and
   * claiming it locks a participant's live record out from under them.
   */
  claimResumable(
    subjectId: string,
    excludeId: string,
  ): Promise<CheckInSession | null>;
  /** Marks a claimed session closed once its record has been carried forward. */
  supersede(session: CheckInSession, successorId: string): Promise<void>;
  /**
   * Marks a session as still live, without writing its record.
   *
   * Idleness was measured from the last *write*, and a turn only writes after a
   * tool batch or at its end — nothing is written while the subject is speaking
   * or thinking. A tired participant who put the phone down to go and find their
   * pill bottle looked exactly like a dropped call, and a second inbound leg
   * could then supersede the one they were still on. Called as speech arrives,
   * so silence on an open line is not mistaken for absence.
   */
  touch(id: string): Promise<void>;
  /**
   * Appends audit entries to a record without touching the record itself.
   *
   * Deliberately not blocked by the completion lock. A coordinator failing to
   * acknowledge an escalation is a fact about a call that arrives *after* the
   * call ends, and a trail that cannot accept it is a trail that stops being the
   * history of the record at the moment the record becomes interesting. The
   * table is append-only, so this can add and never rewrite.
   */
  appendAudit(session: CheckInSession): Promise<void>;
}

/** How long after a drop a redial still counts as the same check-in. */
export const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * A session written to more recently than this is treated as live, not dropped.
 *
 * Turns must not exceed it silently — a slow tool loop can take tens of seconds,
 * so this is generous. The cost of guessing wrong in this direction is a redial
 * that starts fresh; the cost in the other direction is locking a call that is
 * still in progress.
 */
export const RESUME_IDLE_MS = 90_000;

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
  subjectUtterances: string[];
  provenanceRejections: number;
  refusedQuotes: string[];
  resumable: boolean;
  synthetic?: boolean;
}

/**
 * The free-text fields, which are the ones that identify.
 *
 * Sealed individually rather than sealing the whole record, because the leasing
 * query reads `record ->> 'resumable'` and a sealed blob cannot be queried into.
 * Structured clinical data — grades, counts, item ids, timestamps — stays
 * readable: it is what a coordinator reviews and it identifies nobody on its own.
 *
 * What is sealed is everything a person said, which is where identity actually
 * lives. A date of birth spoken aloud is in `subjectUtterances`. A verbatim
 * symptom description can name a relative, a hospital, a street.
 */
function sealRecord(record: StoredRecord, keyId: string, key: Buffer): StoredRecord {
  const s = (v: unknown) => seal(v, keyId, key);
  return {
    ...record,
    subject: record.subject ? (s(record.subject) as never) : null,
    subjectUtterances: s(record.subjectUtterances) as never,
    refusedQuotes: s(record.refusedQuotes) as never,
    adverseEvents: record.adverseEvents.map((e) => ({
      ...e,
      verbatimTerm: s(e.verbatimTerm) as never,
      onsetDescription: s(e.onsetDescription) as never,
    })),
    conMeds: record.conMeds.map((m) => ({
      ...m,
      indicationVerbatim: s(m.indicationVerbatim) as never,
      startedDescription: s(m.startedDescription) as never,
    })),
    adherence: record.adherence
      ? { ...record.adherence, reasonVerbatim: s(record.adherence.reasonVerbatim) as never }
      : null,
    safetyScreen: record.safetyScreen
      ? {
          ...record.safetyScreen,
          items: record.safetyScreen.items.map((i) => ({
            ...i,
            verbatim: s(i.verbatim) as never,
          })),
        }
      : null,
  };
}

/** Inverse of sealRecord. Shredded fields come back as a marker, never a throw. */
function unsealRecord(record: StoredRecord, key: Buffer | null): StoredRecord {
  // `shape` tells the marker what it is standing in for: an emptied array where
  // an array was, "[destroyed]" where a string was. A single object marker
  // returned for every field is what made `[...prior.subjectUtterances]` throw
  // on the resume path, in code whose contract is that reading a shredded record
  // must not throw.
  const u = (v: unknown, shape: unknown = null) =>
    isSealed(v) ? unsealOrMark(v as SealedValue, key, shape) : v;
  return {
    ...record,
    subject: (u(record.subject) ?? null) as never,
    subjectUtterances: (u(record.subjectUtterances, []) ?? []) as never,
    refusedQuotes: (u(record.refusedQuotes, []) ?? []) as never,
    adverseEvents: (record.adverseEvents ?? []).map((e) => ({
      ...e,
      verbatimTerm: u(e.verbatimTerm, "") as never,
      onsetDescription: u(e.onsetDescription, "") as never,
    })),
    conMeds: (record.conMeds ?? []).map((m) => ({
      ...m,
      indicationVerbatim: u(m.indicationVerbatim, "") as never,
      startedDescription: u(m.startedDescription, "") as never,
    })),
    adherence: record.adherence
      ? { ...record.adherence, reasonVerbatim: u(record.adherence.reasonVerbatim, "") as never }
      : null,
    safetyScreen: record.safetyScreen
      ? {
          ...record.safetyScreen,
          items: (record.safetyScreen.items ?? []).map((i) => ({
            ...i,
            verbatim: u(i.verbatim, "") as never,
          })),
        }
      : null,
  };
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
    subjectUtterances: session.subjectUtterances,
    provenanceRejections: session.provenanceRejections,
    refusedQuotes: session.refusedQuotes,
    resumable: session.resumable,
    synthetic: session.synthetic,
  };
}

function blankSession(id: string): CheckInSession {
  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "awaiting_verification",
    subject: null,
    verificationAttempts: 0,
    messages: [],
    subjectUtterances: [],
    provenanceRejections: 0,
    refusedQuotes: [],
    resumable: true,
    adverseEvents: [],
    safetyScreen: null,
    adherence: null,
    conMeds: [],
    escalations: [],
    solicitedReviewed: [],
    summary: null,
    completedAt: null,
    shredded: false,
    synthetic: false,
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

/**
 * Detaches a session from whatever else holds a reference to it.
 *
 * The in-memory store used to hand out live objects, which made it a poor stand-in
 * for a database: two callers "loading" the same session got the same object, so a
 * write through one appeared in the other with no save and no audit entry. That is
 * not a hypothetical — a locked record gained an emergency-tier screen answer that
 * way, and its own hash chain could not see it, because the mutation never went
 * through the log.
 *
 * A store that copies on the way in and out has the same semantics as Postgres,
 * so tests written against it mean what they appear to mean.
 */
/**
 * Rehydrates a trail and re-arms sealing on it.
 *
 * A session loaded mid-call goes on recording entries. Without re-arming, every
 * entry written after a reload would be plaintext while the ones before it were
 * sealed — the record would be half-shreddable, and nothing would say which half.
 */
function rehydrateSealed(
  sessionId: string,
  key: Buffer | null,
  entries: AuditEntry[],
): AuditTrail {
  const trail = AuditTrail.rehydrate(sessionId, entries);
  if (key) trail.sealWith(sessionId, key);
  return trail;
}

function detach(session: CheckInSession, key: Buffer | null = null): CheckInSession {
  const entries = [...session.audit.all()].map((e) => ({ ...e }));
  return {
    ...structuredClone({ ...session, audit: undefined }),
    // Re-armed, like the Postgres store's rehydrateSealed. Without it every
    // audit entry written after the first load was plaintext while the ones
    // before it were sealed — the record half-shreddable, with nothing saying
    // which half. The comment on create() claimed this store behaved "exactly
    // as the Postgres store does"; it did not.
    audit: rehydrateSealed(session.id, key, entries),
  } as CheckInSession;
}

class MemorySessionStore implements SessionStore {
  readonly kind = "memory" as const;
  private sessions = new Map<string, CheckInSession>();

  /**
   * Every session, oldest first. Read by the summary reader, which has no
   * Postgres to query against when there is no DATABASE_URL.
   */
  __all(): CheckInSession[] {
    return [...this.sessions.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async create(): Promise<CheckInSession> {
    const session = blankSession(randomUUID());
    // Armed before the opening entry, exactly as the Postgres store does. A
    // fallback that seals differently from the real store is a fallback whose
    // tests prove nothing about the real store.
    const key = await getKeyStore().create(session.id);
    session.audit.sealWith(session.id, key);
    openingEntry(session);
    this.sessions.set(session.id, detach(session, key));
    return session;
  }

  async get(id: string): Promise<CheckInSession | null> {
    const stored = this.sessions.get(id);
    if (!stored) return null;
    return detach(stored, await getKeyStore().get(id));
  }

  async save(session: CheckInSession): Promise<void> {
    const stored = this.sessions.get(session.id);
    if (stored && stored.completedAt !== null && session.completedAt === null) {
      throw new Error(
        `Session ${session.id} was closed by another process while this call was ` +
          "still in progress. Writes since then were not saved.",
      );
    }
    const key = await getKeyStore().ensureWritable(session.id);
    if (session.subject) {
      await getKeyStore().bindSubject(session.id, session.subject.subjectId);
    }
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.id, detach(session, key));
  }

  async claimResumable(
    subjectId: string,
    excludeId: string,
  ): Promise<CheckInSession | null> {
    const ageCutoff = Date.now() - RESUME_WINDOW_MS;
    const idleCutoff = Date.now() - RESUME_IDLE_MS;
    const candidate = [...this.sessions.values()]
      .filter(
        (s) =>
          s.id !== excludeId &&
          s.completedAt === null &&
          s.resumable &&
          s.subject?.subjectId === subjectId &&
          new Date(s.createdAt).getTime() >= ageCutoff &&
          new Date(s.updatedAt).getTime() <= idleCutoff,
      )
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];
    if (!candidate) return null;
    // Touching it is the lease: a concurrent claimer now sees it as live.
    candidate.updatedAt = new Date().toISOString();
    return detach(candidate, await getKeyStore().get(candidate.id));
  }

  async supersede(session: CheckInSession, successorId: string): Promise<void> {
    const stored = this.sessions.get(session.id);
    if (stored && stored.completedAt !== null) {
      throw new Error(
        `Session ${session.id} was already closed; it was not superseded by ` +
          `${successorId}. Its record was not carried forward twice.`,
      );
    }
    session.completedAt = new Date().toISOString();
    session.status = session.status === "escalated" ? "escalated" : "completed";
    session.summary =
      (session.summary ?? "") +
      ` [Interrupted; record carried forward into session ${successorId}.]`;
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.id, detach(session));
  }

  async touch(id: string): Promise<void> {
    const stored = this.sessions.get(id);
    if (stored && stored.completedAt === null) {
      stored.updatedAt = new Date().toISOString();
    }
  }

  async appendAudit(session: CheckInSession): Promise<void> {
    const stored = this.sessions.get(session.id);
    if (!stored) return;
    const known = new Set(stored.audit.all().map((e) => e.seq));
    const merged = [
      ...stored.audit.all().map((e) => ({ ...e })),
      ...session.audit.all().filter((e) => !known.has(e.seq)).map((e) => ({ ...e })),
    ];
    this.sessions.set(session.id, {
      ...stored,
      // Re-armed, like detach() and the Postgres store. Every other write path
      // here goes through that, and the comment on it records what happens when
      // one does not: entries written afterwards are plaintext while the ones
      // before are sealed.
      audit: rehydrateSealed(session.id, await getKeyStore().get(session.id), merged),
    });
  }

  /** See __backdateForTest. */
  __backdate(id: string, ms: number): void {
    const stored = this.sessions.get(id);
    if (stored) {
      stored.updatedAt = new Date(Date.now() - ms).toISOString();
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * The highest migration the *database* has applied, cached for the process.
 *
 * Deliberately not imported from lib/store/migrate.ts. That module lists a
 * directory and reads files at module scope, and this file is reachable from
 * every API route — pulling it in made the bundler try to resolve the migrations
 * directory as a module and broke `next build` outright, and had it built, the
 * path would have pointed inside .next/server where no .sql file is emitted.
 *
 * Cached because it changes only when a migration runs, which is a deploy step,
 * not something that happens mid-call. A process that started before a migration
 * keeps reporting the version it verified at startup, which is the honest answer
 * for the sessions it created.
 */
let appliedVersion: string | null = null;

async function appliedSchemaVersion(): Promise<string> {
  if (appliedVersion !== null) return appliedVersion;
  const sql = getDb();
  // Tolerates a database with no ledger — an un-migrated checkout should not
  // fail to open a call, it should say it does not know.
  const rows = (await sql`
    select case
             when to_regclass('public.schema_migration') is null then null
             else (select max(version) from schema_migration)
           end as version`) as { version: string | null }[];
  appliedVersion = rows[0]?.version ?? "unknown";
  return appliedVersion;
}

/** Test seam: forget the cached schema version. */
export function __resetSchemaVersionCache(): void {
  appliedVersion = null;
}

/*
 * `instrument` is out-of-band metadata about the row, not part of the domain
 * object, and is deliberately not read back: nothing in a call needs to know
 * which schema is holding it, and a field the application can read is a field
 * the application can be tempted to branch on. It is there for whoever
 * reconstructs the record later, which is why the test that covers it queries
 * the column directly rather than going through the store.
 *
 * The in-memory store has no equivalent because it is a fallback for tests and
 * for a checkout without credentials. It is not a record of anything, and giving
 * it a provenance stamp would suggest otherwise.
 */


class PostgresSessionStore implements SessionStore {
  readonly kind = "postgres" as const;

  async create(): Promise<CheckInSession> {
    const sql = getDb();
    const session = blankSession(randomUUID());

    // The row has to exist before the key can reference it, and the key has to
    // exist before the first audit entry is written — otherwise SESSION_OPENED
    // is the one entry in the trail that shredding cannot reach.
    await sql`
      insert into check_in_session (id, created_at, status, record, messages, instrument)
      values (${session.id}, ${session.createdAt}, ${session.status},
              ${JSON.stringify(toRecord(session))}::jsonb, '[]'::jsonb,
              ${JSON.stringify({ schemaVersion: await appliedSchemaVersion() })}::jsonb)`;

    const key = await getKeyStore().create(session.id);
    session.audit.sealWith(session.id, key);
    openingEntry(session);
    await this.appendAudit(session);
    return session;
  }

  async get(id: string): Promise<CheckInSession | null> {
    const sql = getDb();
    const rows = await sql`
      select id, created_at, updated_at, status, record, messages, summary, completed_at
      from check_in_session where id = ${id}`;
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;

    const entries = (await sql`
      select seq, recorded_at, actor, action, entity, entity_id,
             before_value, after_value, reason, prev_hash, hash
      from audit_entry where session_id = ${id} order by seq`) as Record<string, unknown>[];

    // Unsealed on the way in, so everything above this line works in plaintext
    // and nothing else in the system needs to know sealing happened. A record
    // whose key is gone comes back with markers where the content was, rather
    // than throwing — a coordinator opening a destroyed check-in should see that
    // it was destroyed.
    const key = await getKeyStore().get(id);
    const record = unsealRecord(row.record as StoredRecord, key);
    const rawMessages = row.messages ?? [];
    const messages = (
      isSealed(rawMessages) ? (unsealOrMark(rawMessages, key, []) ?? []) : rawMessages
    ) as CheckInSession["messages"];

    return {
      id: String(row.id),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(
        (row.updated_at as string | null) ?? (row.created_at as string),
      ).toISOString(),
      status: row.status as CheckInSession["status"],
      subject: record.subject ?? null,
      verificationAttempts: record.verificationAttempts ?? 0,
      messages,
      subjectUtterances: record.subjectUtterances ?? [],
      provenanceRejections: record.provenanceRejections ?? 0,
      refusedQuotes: record.refusedQuotes ?? [],
      resumable: record.resumable ?? true,
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
      shredded: key === null && (await getKeyStore().state(id)) === "destroyed",
      synthetic: record.synthetic ?? false,
      audit: rehydrateSealed(
        id,
        key,
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

    // Ask before writing, so the three outcomes stay distinguishable. Filtering
    // on `completed_at is null` inside the UPDATE collapsed two of them: a
    // locked record and a *missing* record both produced zero rows and resolved
    // successfully. A lost session has to be loud.
    const existing = (await sql`
      select completed_at from check_in_session where id = ${session.id}`) as {
      completed_at: string | null;
    }[];

    if (existing.length === 0) {
      throw new Error(
        `Session ${session.id} is not in the database. Nothing was saved — ` +
          "the record for this call may be incomplete.",
      );
    }

    if (existing[0].completed_at !== null) {
      // Locked by us, via complete_check_in: conversation after the record
      // closes is not part of it, so declining to write the record is correct —
      // but our own closing entries still belong on the trail.
      if (session.completedAt !== null) {
        await this.appendAudit(session);
        return;
      }

      // Locked by something else while this call was still running — a redial
      // that claimed it as dropped, most likely. Everything written since is
      // gone. Silence here was the quiet data-loss path that save() was
      // rewritten to eliminate; it must not come back through this door.
      //
      // Nothing is appended on this path. Appending first meant the trail
      // recorded writes the database had just refused: a record would carry an
      // AE_RECORDED entry with no adverse event anywhere in it. The chain still
      // verified, because every entry was individually well-formed — the record
      // simply disagreed with its own audit trail, which is precisely the
      // failure the trail exists to make impossible.
      throw new Error(
        `Session ${session.id} was closed by another process while this call was ` +
          "still in progress. Writes since then were not saved.",
      );
    }

    // Throws only if the key was *destroyed*. A session with no key at all
    // predates sealing and gets one now — otherwise every row written before
    // this deploy became unwritable, with an error announcing a destruction
    // that never happened.
    const key = await getKeyStore().ensureWritable(session.id);

    await sql`
      update check_in_session
         set status = ${session.status},
             subject_id = ${session.subject?.subjectId ?? null},
             record = ${JSON.stringify(sealRecord(toRecord(session), session.id, key))}::jsonb,
             messages = ${JSON.stringify(seal(session.messages, session.id, key))}::jsonb,
             summary = ${session.summary},
             completed_at = ${session.completedAt},
             updated_at = now()
       where id = ${session.id}`;

    // Bound here rather than in the tool: this is the moment subject_id is first
    // written, so the two stay in step without the write path having to remember.
    if (session.subject) {
      await getKeyStore().bindSubject(session.id, session.subject.subjectId);
    }
    session.updatedAt = new Date().toISOString();
    await this.appendAudit(session);
  }

  async claimResumable(
    subjectId: string,
    excludeId: string,
  ): Promise<CheckInSession | null> {
    const sql = getDb();

    // One statement: select and lease together. Bumping updated_at makes the row
    // non-idle, so a concurrent redial skips it instead of carrying the same
    // record forward a second time.
    //
    // Both cutoffs are computed by the database, not by this process. They are
    // compared against created_at and updated_at, which the database writes with
    // its own now() — mixing in the application server's clock meant a few
    // seconds of skew decided whether a call counted as live. Ahead, and a call
    // that saved 85 seconds ago reads as idle and gets locked mid-sentence;
    // behind, and genuinely dropped calls become unclaimable. One clock.
    const claimed = (await sql`
      update check_in_session
         set updated_at = now()
       where id = (
         select id from check_in_session
          where subject_id = ${subjectId}
            and completed_at is null
            and coalesce((record ->> 'resumable')::boolean, true)
            and id <> ${excludeId}
            and created_at >= now() - (${String(RESUME_WINDOW_MS)} || ' milliseconds')::interval
            and updated_at <= now() - (${String(RESUME_IDLE_MS)} || ' milliseconds')::interval
          order by created_at desc
          limit 1
          for update skip locked
       )
      returning id`) as { id: string }[];

    if (claimed.length === 0) return null;
    return this.get(claimed[0].id);
  }

  async supersede(session: CheckInSession, successorId: string): Promise<void> {
    const sql = getDb();
    // save() refuses to write to a shredded session; this path appends audit
    // entries and did not. Those entries would land as plaintext — the trail is
    // unarmed once the key is gone — in a table that rejects DELETE, so nothing
    // in this design could ever destroy them.
    await getKeyStore().ensureWritable(session.id);
    const summary =
      (session.summary ?? "") +
      ` [Interrupted; record carried forward into session ${successorId}.]`;
    const status = session.status === "escalated" ? "escalated" : "completed";
    const closed = (await sql`
      update check_in_session
         set completed_at = now(), status = ${status}, summary = ${summary},
             updated_at = now()
       where id = ${session.id} and completed_at is null
      returning id`) as { id: string }[];

    // Zero rows means someone else closed it first. Reporting success anyway
    // told the caller the source was locked when it was still open, so the same
    // record could be carried forward a second time.
    if (closed.length === 0) {
      throw new Error(
        `Session ${session.id} was already closed; it was not superseded by ` +
          `${successorId}. Its record was not carried forward twice.`,
      );
    }

    session.completedAt = new Date().toISOString();
    session.status = status;
    session.summary = summary;
    await this.appendAudit(session);
  }

  async touch(id: string): Promise<void> {
    const sql = getDb();
    // `completed_at is null` is not just correctness: the lock trigger raises on
    // any update to a closed row, so touching one would throw.
    await sql`
      update check_in_session set updated_at = now()
       where id = ${id} and completed_at is null`;
  }

  /** Inserts only entries not already persisted. The table rejects rewrites. */
  async appendAudit(session: CheckInSession): Promise<void> {
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

/**
 * Ages a stored session so it reads as dropped rather than live.
 *
 * Test-only, and in-memory only. The idleness rule is what stops a redial
 * locking a call that is still happening, so tests have to be able to say which
 * of the two they mean — and they cannot do it by mutating their own copy,
 * because the store keeps its own.
 */
export function __backdateForTest(id: string, ms: number): void {
  const current = store;
  if (!(current instanceof MemorySessionStore)) {
    throw new Error("__backdateForTest only applies to the in-memory store");
  }
  current.__backdate(id, ms);
}
