/**
 * The clinical shape of past calls, without reading anything anyone said.
 *
 * Drift monitoring and the coordinator queue both need to look across many
 * check-ins. Neither needs the free text, and both would otherwise unseal it —
 * loading a participant's spoken date of birth and verbatim symptom descriptions
 * into memory to count how many grade 3 events there were that week.
 *
 * So this reads only the structured half. Grades, urgencies, item ids and
 * timestamps stay outside the seal by design (see `sealRecord`), which means a
 * summary can be built without a key at all. That is a stronger property than a
 * policy of not looking: a report that never holds the key cannot leak it, and a
 * shredded subject's calls still summarise correctly instead of erroring or
 * disappearing from the denominator.
 */

import type { CtcaeGrade, EscalationUrgency } from "../clinical/safety.ts";
import { getDb, isDatabaseConfigured } from "./db.ts";
import { getSessionStore } from "./session-store.ts";
import type { CheckInSession, SessionStatus } from "./session.ts";

export interface EventSummary {
  grade: CtcaeGrade;
  serious: boolean;
  spontaneous: boolean;
  limitsSelfCare: boolean;
}

export interface EscalationSummary {
  urgency: EscalationUrgency;
  triggeredBy: "agent" | "safety_net";
  category: string | null;
  createdAt: string;
}

export interface CallSummary {
  id: string;
  /**
   * A call the eval harness made, not a participant.
   *
   * Load-bearing for anything that trends over time. The eval suite makes far
   * more calls than a pilot does — hundreds against a handful — so a report that
   * counts both is a report about the test harness wearing the study's name, and
   * its "drift" is mostly whoever last edited a persona.
   */
  synthetic: boolean;
  createdAt: string;
  completedAt: string | null;
  status: SessionStatus;
  /** Present only when the call got past verification. */
  verified: boolean;
  events: EventSummary[];
  escalations: EscalationSummary[];
  /** Screen items actually answered, and how many came back positive. */
  screenAnswered: number;
  screenPositive: number;
  /** Distinct verbatim quotes the provenance gate refused. */
  provenanceRejections: number;
  dosesMissed: number | null;
}

/**
 * When `synthetic` started being written reliably.
 *
 * The flag was added to suppress eval escalations and failed open — it only
 * persisted inside the `resumable: false` branch, so a session created with
 * `synthetic` alone reloaded as a real one. Fixed by a71be42 at 2026-08-21
 * 16:46 -0400; every call stored before that carries `false` whether or not a
 * person made it.
 *
 * All of them were the eval harness. This study has enrolled nobody, so there is
 * no participant a pre-cutoff call could belong to.
 *
 * They are excluded rather than back-filled. Rewriting a stored record to make a
 * report tidier is the exact move the append-only audit trail and the completion
 * lock exist to prevent, and a documented boundary costs nothing next to an
 * edited history.
 */
export const SYNTHETIC_FLAG_RELIABLE_FROM = Date.parse("2026-08-21T20:46:30Z");

/** Whether a call predates any way of telling a harness run from a real one. */
export function beforeSyntheticFlag(createdAt: string): boolean {
  return Date.parse(createdAt) < SYNTHETIC_FLAG_RELIABLE_FROM;
}

export interface SummaryQuery {
  since?: Date;
  limit?: number;
  /** Defaults to excluding the eval harness's own calls. */
  includeSynthetic?: boolean;
}

function summarise(row: {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: string;
  record: Record<string, unknown>;
  subjectPresent: boolean;
  provenanceRejections: number;
  synthetic: boolean;
}): CallSummary {
  const record = row.record ?? {};
  const events = (record.adverseEvents as Record<string, unknown>[] | undefined) ?? [];
  const escalations =
    (record.escalations as Record<string, unknown>[] | undefined) ?? [];
  const screen = record.safetyScreen as
    | { items?: { answer: boolean | null }[]; positiveRedFlags?: string[] }
    | null
    | undefined;
  const adherence = record.adherence as
    | { dosesMissedSinceLastCheckIn?: number }
    | null
    | undefined;

  return {
    id: row.id,
    synthetic: row.synthetic,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    status: row.status as SessionStatus,
    verified: row.subjectPresent,
    events: events.map((e) => ({
      grade: Number(e.grade) as CtcaeGrade,
      serious: Boolean(
        (e.seriousness as { isSerious?: boolean } | null | undefined)?.isSerious,
      ),
      spontaneous: Boolean(e.spontaneous),
      limitsSelfCare: Boolean(e.limitsSelfCare),
    })),
    escalations: escalations.map((e) => ({
      urgency: e.urgency as EscalationUrgency,
      triggeredBy: e.triggeredBy === "safety_net" ? "safety_net" : "agent",
      category: (e.category as string | null) ?? null,
      createdAt: String(e.createdAt),
    })),
    // Answered, not asked. A screen that ended halfway is a half-finished screen
    // and counting it as complete is the thing the per-item design exists to stop.
    screenAnswered: (screen?.items ?? []).filter((i) => i.answer !== null).length,
    screenPositive: (screen?.positiveRedFlags ?? []).length,
    provenanceRejections: row.provenanceRejections,
    dosesMissed:
      typeof adherence?.dosesMissedSinceLastCheckIn === "number"
        ? adherence.dosesMissedSinceLastCheckIn
        : null,
  };
}

/**
 * One already-loaded session, summarised.
 *
 * Shares `summarise` with the list path so a single call and a listed one cannot
 * disagree about why a call is flagged — which is what happened when the detail
 * page derived its reasons from a bounded scan and quietly found nothing.
 */
export function summariseSession(session: CheckInSession): CallSummary {
  return summarise({
    id: session.id,
    createdAt: session.createdAt,
    completedAt: session.completedAt ?? null,
    status: session.status,
    record: session as unknown as Record<string, unknown>,
    subjectPresent: Boolean(session.subject),
    provenanceRejections: Number(session.provenanceRejections ?? 0),
    synthetic: Boolean(session.synthetic),
  });
}

export async function listSummaries(query: SummaryQuery = {}): Promise<CallSummary[]> {
  const limit = query.limit ?? 500;
  const includeSynthetic = query.includeSynthetic === true;

  if (!isDatabaseConfigured()) {
    // The memory store holds whole sessions; the same fields are read off them,
    // and nothing is unsealed there because nothing was sealed.
    const store = getSessionStore() as unknown as {
      __all?: () => { id: string; createdAt: string }[];
    };
    const all = store.__all?.() ?? [];
    return all
      .filter((s) => !query.since || Date.parse(s.createdAt) >= query.since.getTime())
      .slice(-limit)
      .map((s) => {
        const session = s as unknown as Record<string, unknown>;
        return summarise({
          id: String(session.id),
          createdAt: String(session.createdAt),
          completedAt: (session.completedAt as string | null) ?? null,
          status: String(session.status),
          record: session,
          subjectPresent: Boolean(session.subject),
          provenanceRejections: Number(session.provenanceRejections ?? 0),
          synthetic: Boolean(session.synthetic),
        });
      })
      .filter(
        (c) => includeSynthetic || (!c.synthetic && !beforeSyntheticFlag(c.createdAt)),
      );
  }

  const sql = getDb();
  // `record` carries the sealed fields too, but nothing here reads them and no
  // key is ever fetched, so they stay opaque blobs for the life of the call.
  const rows = (await sql`
    select id, created_at, completed_at, status, record,
           (record -> 'subject') is not null and record -> 'subject' <> 'null'::jsonb
             as subject_present,
           coalesce((record ->> 'synthetic')::boolean, false) as synthetic
      from check_in_session
     where ${query.since ? sql`created_at >= ${query.since.toISOString()}` : sql`true`}
       and ${includeSynthetic ? sql`true` : sql`coalesce((record ->> 'synthetic')::boolean, false) = false`}
     order by created_at desc
     limit ${limit}`) as Record<string, unknown>[];

  const summaries = rows.map((r) => {
    const record = (r.record ?? {}) as Record<string, unknown>;
    return summarise({
      id: String(r.id),
      createdAt: new Date(String(r.created_at)).toISOString(),
      completedAt: r.completed_at ? new Date(String(r.completed_at)).toISOString() : null,
      status: String(r.status),
      record,
      subjectPresent: Boolean(r.subject_present),
      provenanceRejections: Number(record.provenanceRejections ?? 0),
      synthetic: Boolean(r.synthetic),
    });
  });

  return includeSynthetic
    ? summaries
    : summaries.filter((c) => !beforeSyntheticFlag(c.createdAt));
}


/**
 * Adverse events across calls, for reconciliation against another system.
 *
 * Coded term, grade, timestamp and subject id all sit outside the seal — the
 * subject id is a plain column, and `sealRecord` seals only the verbatim halves
 * — so a full reconciliation can be produced without fetching a key.
 *
 * `includeVerbatim` is the exception and is off by default. The participant's
 * own words are the most useful thing a reviewer has when deciding whether two
 * systems disagree or merely used different words, and they are also the reason
 * a reconciliation CSV is a PHI document the moment it leaves the machine.
 * Making that a deliberate flag rather than a default is the difference.
 *
 * Against Postgres it is refused rather than silently ignored. The verbatim
 * halves are sealed per session, so producing them means fetching a key per
 * call, and this reader's whole premise is that it never holds one. Returning
 * an empty column while the caller printed "this file contains participants'
 * own words" is the worst of both — a useless file, mislabelled as dangerous.
 */
export class VerbatimUnavailableError extends Error {
  constructor() {
    super(
      "Verbatim terms cannot be exported from the database path: they are sealed " +
        "per session and this reader deliberately holds no key. Export without " +
        "--verbatim, or add a key-holding export that says so in its own audit entry.",
    );
    this.name = "VerbatimUnavailableError";
  }
}
export interface StoredEvent {
  subjectId: string;
  sessionId: string;
  codedTerm: string;
  verbatimTerm: string | null;
  grade: number;
  recordedAt: string;
  spontaneous: boolean;
}

export async function listAdverseEvents(
  query: SummaryQuery & { includeVerbatim?: boolean } = {},
): Promise<StoredEvent[]> {
  if (!isDatabaseConfigured()) {
    const store = getSessionStore() as unknown as { __all?: () => unknown[] };
    const all = (store.__all?.() ?? []) as Record<string, unknown>[];
    return all.flatMap((session) => {
      const subjectId = (session.subject as { subjectId?: string } | null)?.subjectId;
      if (!subjectId) return [];
      return ((session.adverseEvents as Record<string, unknown>[]) ?? []).map((e) => ({
        subjectId,
        sessionId: String(session.id),
        codedTerm: String(e.codedTerm),
        verbatimTerm: query.includeVerbatim ? String(e.verbatimTerm ?? "") : null,
        grade: Number(e.grade),
        recordedAt: String(e.recordedAt),
        spontaneous: Boolean(e.spontaneous),
      }));
    });
  }

  if (query.includeVerbatim) throw new VerbatimUnavailableError();

  const sql = getDb();
  const rows = (await sql`
    select id, subject_id, created_at, record -> 'adverseEvents' as events
      from check_in_session
     where subject_id is not null
       and ${query.since ? sql`created_at >= ${query.since.toISOString()}` : sql`true`}
       and ${query.includeSynthetic === true ? sql`true` : sql`coalesce((record ->> 'synthetic')::boolean, false) = false`}
     order by created_at asc`) as Record<string, unknown>[];

  return rows
    .filter((r) => query.includeSynthetic === true || !beforeSyntheticFlag(
      new Date(String(r.created_at)).toISOString(),
    ))
    .flatMap((r) =>
      ((r.events as Record<string, unknown>[]) ?? []).map((e) => ({
        subjectId: String(r.subject_id),
        sessionId: String(r.id),
        codedTerm: String(e.codedTerm),
        // Sealed, so without a key this is an opaque blob rather than words.
        // Left null unless a caller asked, and unsealing it is a separate step
        // this reader deliberately does not perform.
        verbatimTerm: null,
        grade: Number(e.grade),
        recordedAt: String(e.recordedAt),
        spontaneous: Boolean(e.spontaneous),
      })),
    );
}
