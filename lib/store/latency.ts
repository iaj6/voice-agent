/**
 * What a participant actually waited, per turn.
 *
 * N-01 asks for time to first audio under 2s at p50 and under 4s at p95. Until
 * this existed the spec recorded "~2.5s p50, unmeasured p95" — a number someone
 * felt and a number nobody had. Dead air is a voice agent's entire failure mode,
 * so this is the requirement least safe to assert.
 *
 * The number that counts is measured in the browser, because the server knows
 * when it dispatched a sentence and not when anybody heard one. The server
 * segments travel alongside it so a bad p95 can be attributed instead of merely
 * noticed: a slow model, a slow first sentence and slow synthesis are three
 * different problems.
 */

import { randomUUID } from "node:crypto";
import { getDb, isDatabaseConfigured } from "./db.ts";

export interface TurnLatency {
  id: string;
  sessionId: string;
  turnIndex: number;
  source: "subject" | "system";
  /** Dispatch to audible, from the browser. Null when the turn said nothing. */
  firstAudioMs: number | null;
  firstTokenMs: number | null;
  firstSentenceMs: number | null;
  totalMs: number | null;
  spokeBeforeTools: boolean | null;
  createdAt: string;
}

export interface NewTurnLatency {
  sessionId: string;
  turnIndex: number;
  source: "subject" | "system";
  firstAudioMs?: number | null;
  firstTokenMs?: number | null;
  firstSentenceMs?: number | null;
  totalMs?: number | null;
  spokeBeforeTools?: boolean | null;
}

/**
 * Rejects impossible values rather than storing them.
 *
 * The browser reports this, and a client can say anything. More importantly a
 * clock adjustment mid-call produces a negative or absurd figure, and one of
 * those in the set moves a percentile — silently, in the direction of looking
 * better or worse than the truth depending on sign. A discarded measurement is
 * honest; a fabricated one is not.
 */
const CEILING_MS = 10 * 60 * 1000;

export function plausible(ms: number | null | undefined): number | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  if (ms < 0 || ms > CEILING_MS) return null;
  return Math.round(ms);
}

export interface LatencyStore {
  readonly kind: "memory" | "postgres";
  /**
   * Creates or fills in the row for one turn.
   *
   * Fields that arrive null leave what is already stored alone, because the two
   * writers know different halves and neither should erase the other's.
   */
  record(input: NewTurnLatency): Promise<TurnLatency>;
  forSession(sessionId: string): Promise<TurnLatency[]>;
  /** Newest first, for the reporting window. */
  recent(limit?: number): Promise<TurnLatency[]>;
}

function build(input: NewTurnLatency): TurnLatency {
  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    source: input.source,
    firstAudioMs: plausible(input.firstAudioMs),
    firstTokenMs: plausible(input.firstTokenMs),
    firstSentenceMs: plausible(input.firstSentenceMs),
    totalMs: plausible(input.totalMs),
    spokeBeforeTools: input.spokeBeforeTools ?? null,
    createdAt: new Date().toISOString(),
  };
}

class MemoryLatencyStore implements LatencyStore {
  readonly kind = "memory" as const;
  private rows: TurnLatency[] = [];

  async record(input: NewTurnLatency): Promise<TurnLatency> {
    const row = build(input);
    const at = this.rows.findIndex(
      (r) => r.sessionId === row.sessionId && r.turnIndex === row.turnIndex,
    );
    if (at === -1) {
      this.rows.push(row);
      return row;
    }
    const merged = merge(this.rows[at], row);
    this.rows[at] = merged;
    return merged;
  }

  async forSession(sessionId: string): Promise<TurnLatency[]> {
    return this.rows
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.turnIndex - b.turnIndex);
  }

  async recent(limit = 2000): Promise<TurnLatency[]> {
    return [...this.rows].reverse().slice(0, limit);
  }
}

class PostgresLatencyStore implements LatencyStore {
  readonly kind = "postgres" as const;

  async record(input: NewTurnLatency): Promise<TurnLatency> {
    const row = build(input);
    const sql = getDb();
    const stored = (await sql`
      insert into turn_latency
        (id, session_id, turn_index, source, first_audio_ms, first_token_ms,
         first_sentence_ms, total_ms, spoke_before_tools, created_at)
      values
        (${row.id}, ${row.sessionId}, ${row.turnIndex}, ${row.source},
         ${row.firstAudioMs}, ${row.firstTokenMs}, ${row.firstSentenceMs},
         ${row.totalMs}, ${row.spokeBeforeTools}, ${row.createdAt})
      on conflict (session_id, turn_index) do update set
        first_audio_ms = coalesce(excluded.first_audio_ms, turn_latency.first_audio_ms),
        first_token_ms = coalesce(excluded.first_token_ms, turn_latency.first_token_ms),
        first_sentence_ms =
          coalesce(excluded.first_sentence_ms, turn_latency.first_sentence_ms),
        total_ms = coalesce(excluded.total_ms, turn_latency.total_ms),
        spoke_before_tools =
          coalesce(excluded.spoke_before_tools, turn_latency.spoke_before_tools)
      returning *`) as Record<string, unknown>[];
    return stored[0] ? hydrate(stored[0]) : row;
  }

  async forSession(sessionId: string): Promise<TurnLatency[]> {
    const sql = getDb();
    const rows = (await sql`
      select * from turn_latency where session_id = ${sessionId}
      order by turn_index asc`) as Record<string, unknown>[];
    return rows.map(hydrate);
  }

  async recent(limit = 2000): Promise<TurnLatency[]> {
    const sql = getDb();
    const rows = (await sql`
      select * from turn_latency order by created_at desc limit ${limit}`) as Record<
      string,
      unknown
    >[];
    return rows.map(hydrate);
  }
}

/** Keeps whatever is already known; a null half never erases a stored one. */
function merge(existing: TurnLatency, incoming: TurnLatency): TurnLatency {
  return {
    ...existing,
    firstAudioMs: incoming.firstAudioMs ?? existing.firstAudioMs,
    firstTokenMs: incoming.firstTokenMs ?? existing.firstTokenMs,
    firstSentenceMs: incoming.firstSentenceMs ?? existing.firstSentenceMs,
    totalMs: incoming.totalMs ?? existing.totalMs,
    spokeBeforeTools: incoming.spokeBeforeTools ?? existing.spokeBeforeTools,
  };
}

function hydrate(row: Record<string, unknown>): TurnLatency {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnIndex: Number(row.turn_index),
    source: row.source === "system" ? "system" : "subject",
    firstAudioMs: num(row.first_audio_ms),
    firstTokenMs: num(row.first_token_ms),
    firstSentenceMs: num(row.first_sentence_ms),
    totalMs: num(row.total_ms),
    spokeBeforeTools:
      row.spoke_before_tools === null || row.spoke_before_tools === undefined
        ? null
        : Boolean(row.spoke_before_tools),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

let store: LatencyStore | null = null;

export function getLatencyStore(): LatencyStore {
  if (!store) {
    store = isDatabaseConfigured()
      ? new PostgresLatencyStore()
      : new MemoryLatencyStore();
  }
  return store;
}

/** Test seam. */
export function __setLatencyStore(next: LatencyStore | null) {
  store = next;
}

/**
 * The percentile of a sample, by nearest rank.
 *
 * Not interpolated. With the tens-to-hundreds of turns a pilot produces,
 * interpolating invents a value between two real measurements and reports it as
 * if a participant had waited it. Nearest rank always names a wait that actually
 * happened.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}
