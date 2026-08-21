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
  reinstatedAt: string | null;
  reinstatedBy: string | null;
}

/**
 * Withdrawn *now*, as opposed to withdrawn at some point in the past.
 *
 * Derived rather than stored, so the history survives. Erasing the withdrawal on
 * reinstatement left no record that collection had ever been refused, which is
 * the fact a monitor would come looking for.
 */
export function isWithdrawn(state: SubjectState | null): boolean {
  if (!state?.withdrawnAt) return false;
  if (!state.reinstatedAt) return true;
  return Date.parse(state.reinstatedAt) < Date.parse(state.withdrawnAt);
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
      reinstatedAt: null,
      reinstatedBy: null,
    };
    this.states.set(subjectId, state);
    return state;
  }

  async reinstate(subjectId: string, by: string): Promise<void> {
    const existing = this.states.get(subjectId);
    if (!existing) return;
    // Superseded, not deleted. The withdrawal stays on the record.
    this.states.set(subjectId, {
      ...existing,
      reinstatedAt: new Date().toISOString(),
      reinstatedBy: by,
    });
  }
}

class PostgresSubjectStore implements SubjectStore {
  readonly kind = "postgres" as const;

  async get(subjectId: string): Promise<SubjectState | null> {
    const sql = getDb();
    const rows = (await sql`
      select subject_id, withdrawn_at, withdrawn_by, withdrawn_note,
             reinstated_at, reinstated_by
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
      reinstatedAt: row.reinstated_at
        ? new Date(row.reinstated_at as string).toISOString()
        : null,
      reinstatedBy: (row.reinstated_by as string | null) ?? null,
    };
  }

  async withdraw(subjectId: string, by: string, note: string): Promise<SubjectState> {
    const sql = getDb();
    await sql`
      insert into subject_state (subject_id, withdrawn_at, withdrawn_by, withdrawn_note)
      values (${subjectId}, now(), ${by}, ${note})
      on conflict (subject_id) do update
        set withdrawn_at = now(), withdrawn_by = ${by},
            withdrawn_note = ${note},
            -- A fresh withdrawal supersedes any earlier reinstatement.
            reinstated_at = null, reinstated_by = null,
            updated_at = now()`;
    return (await this.get(subjectId))!;
  }

  async reinstate(subjectId: string, by: string): Promise<void> {
    const sql = getDb();
    await sql`
      update subject_state
         set reinstated_at = now(), reinstated_by = ${by}, updated_at = now()
       where subject_id = ${subjectId} and withdrawn_at is not null`;
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
