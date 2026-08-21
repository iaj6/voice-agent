/**
 * Subject-level state that outlives a single call.
 *
 * Only withdrawal for now. It is here rather than on the session because a
 * participant is not a call: withdrawal has to be true of the person across
 * every future call, which is precisely what the schema had nowhere to express.
 */

import { getDb, isDatabaseConfigured } from "./db.ts";

export interface SubjectState {
  subjectId: string;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawnNote: string | null;
}

export interface SubjectStore {
  readonly kind: "memory" | "postgres";
  get(subjectId: string): Promise<SubjectState | null>;
  withdraw(subjectId: string, by: string, note: string): Promise<SubjectState>;
  reinstate(subjectId: string, by: string): Promise<void>;
}

class MemorySubjectStore implements SubjectStore {
  readonly kind = "memory" as const;
  private states = new Map<string, SubjectState>();

  async get(subjectId: string): Promise<SubjectState | null> {
    return this.states.get(subjectId) ?? null;
  }

  async withdraw(subjectId: string, by: string, note: string): Promise<SubjectState> {
    const state: SubjectState = {
      subjectId,
      withdrawnAt: new Date().toISOString(),
      withdrawnBy: by,
      withdrawnNote: note,
    };
    this.states.set(subjectId, state);
    return state;
  }

  async reinstate(subjectId: string): Promise<void> {
    this.states.delete(subjectId);
  }
}

class PostgresSubjectStore implements SubjectStore {
  readonly kind = "postgres" as const;

  async get(subjectId: string): Promise<SubjectState | null> {
    const sql = getDb();
    const rows = (await sql`
      select subject_id, withdrawn_at, withdrawn_by, withdrawn_note
        from subject_state where subject_id = ${subjectId}`) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      subjectId: String(row.subject_id),
      withdrawnAt: row.withdrawn_at
        ? new Date(row.withdrawn_at as string).toISOString()
        : null,
      withdrawnBy: (row.withdrawn_by as string | null) ?? null,
      withdrawnNote: (row.withdrawn_note as string | null) ?? null,
    };
  }

  async withdraw(subjectId: string, by: string, note: string): Promise<SubjectState> {
    const sql = getDb();
    await sql`
      insert into subject_state (subject_id, withdrawn_at, withdrawn_by, withdrawn_note)
      values (${subjectId}, now(), ${by}, ${note})
      on conflict (subject_id) do update
        set withdrawn_at = now(), withdrawn_by = ${by},
            withdrawn_note = ${note}, updated_at = now()`;
    return (await this.get(subjectId))!;
  }

  async reinstate(subjectId: string): Promise<void> {
    const sql = getDb();
    await sql`
      update subject_state
         set withdrawn_at = null, withdrawn_by = null, withdrawn_note = null,
             updated_at = now()
       where subject_id = ${subjectId}`;
  }
}

let store: SubjectStore | null = null;

export function getSubjectStore(): SubjectStore {
  if (!store) {
    store = isDatabaseConfigured()
      ? new PostgresSubjectStore()
      : new MemorySubjectStore();
  }
  return store;
}

/** Test seam. */
export function __setSubjectStore(next: SubjectStore | null) {
  store = next;
}
