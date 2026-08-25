/**
 * What the agent captured, next to what the participant typed into the eDiary.
 *
 * The pilot's exit criteria ask for "agreement between agent-captured events and
 * eDiary-captured events, measured and characterised, with disagreements
 * categorised by cause". The last clause is the design.
 *
 * **This produces a worklist, not a verdict.** An event present in one system
 * and absent from the other has at least four causes, and no matcher can tell
 * them apart:
 *
 *   - the agent found something the participant never typed (the whole premise)
 *   - the participant typed something the agent never asked about (a real miss)
 *   - both recorded it and the terms differ — "tiredness" against "Fatigue"
 *   - both recorded it and the dates differ enough to fall outside the window
 *
 * The first two are the findings the pilot exists to produce. The last two are
 * artefacts of comparison. A tool that reported all four as "disagreement" would
 * make the agent look worse than it is, and one that quietly matched fuzzily
 * would make it look better. So matching is conservative and explicit, every
 * unmatched row carries a blank `cause` for a human to fill in, and the summary
 * refuses to call an unmatched row a miss.
 */

import { PROTOCOL } from "../clinical/protocol.ts";
import type { CtcaeGrade } from "../clinical/safety.ts";

/** One row of whatever the site can export from its eDiary. */
export interface EDiaryEntry {
  subjectId: string;
  /** The participant's or the eDiary's term for the symptom. */
  term: string;
  /** ISO date. Time is ignored; eDiaries are day-grained. */
  date: string;
  /** CTCAE grade if the eDiary collects one, else null. */
  grade?: number | null;
}

export interface AgentEvent {
  subjectId: string;
  sessionId: string;
  codedTerm: string;
  verbatimTerm: string;
  grade: CtcaeGrade;
  recordedAt: string;
  spontaneous: boolean;
}

export type DisagreementKind =
  | "matched"
  | "grade_mismatch"
  | "agent_only"
  | "ediary_only";

export interface ReconciledRow {
  subjectId: string;
  kind: DisagreementKind;
  term: string;
  agentGrade: number | null;
  ediaryGrade: number | null;
  agentDate: string | null;
  ediaryDate: string | null;
  sessionId: string | null;
  /** The participant's own words, when the agent is the side that has it. */
  verbatim: string | null;
  /**
   * Left blank on purpose. Categorising a disagreement is a clinical judgement
   * about two records, and the tool that produced the disagreement is the last
   * thing that should be guessing at its cause.
   */
  cause: "";
}

/**
 * How far apart two records of the same symptom may be and still be the same
 * event.
 *
 * A check-in asks about the week; an eDiary entry is dated the day it was typed.
 * Three days each way covers a participant reporting on Tuesday something they
 * logged on Sunday, without spanning two weekly check-ins and merging what were
 * genuinely two events.
 */
export const MATCH_WINDOW_DAYS = 3;

/**
 * Terms both systems might use for the same thing.
 *
 * Only the protocol's own solicited symptoms, plus the everyday words for them.
 * Deliberately not a general medical synonym set: a broad one would match things
 * that are not the same event, and an over-matched reconciliation reports
 * agreement that was never there — which is the failure that would make this
 * whole exercise worthless.
 */
const EVERYDAY: Record<string, string[]> = {
  fatigue: ["tired", "tiredness", "exhausted", "exhaustion", "worn out", "no energy"],
  nausea: ["sick", "queasy", "nauseous", "feeling sick"],
  vomiting: ["throwing up", "threw up", "being sick"],
  diarrhea: ["diarrhoea", "loose stools", "runs"],
  constipation: ["blocked up", "not going"],
  "decreased appetite": ["not eating", "no appetite", "off my food", "appetite"],
  "peripheral sensory neuropathy": [
    "numbness",
    "tingling",
    "pins and needles",
    "numb hands",
    "numb feet",
  ],
  rash: ["spots", "skin rash", "breaking out"],
  fever: ["temperature", "high temperature", "burning up"],
  headache: ["head hurts", "migraine"],
};

function normalise(term: string): string {
  return term.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Every string that should be treated as naming the same symptom. */
export function aliasesFor(term: string): Set<string> {
  const key = normalise(term);
  const group = new Set<string>([key]);

  for (const [canonical, everyday] of Object.entries(EVERYDAY)) {
    const family = [canonical, ...everyday].map(normalise);
    if (family.includes(key)) family.forEach((t) => group.add(t));
  }

  // A protocol term is its own alias even when the map above says nothing about
  // it, so a study that adds a symptom does not silently stop reconciling.
  for (const symptom of PROTOCOL.solicitedSymptoms) {
    if (normalise(symptom.term) === key) group.add(normalise(symptom.term));
  }
  return group;
}

export function sameSymptom(a: string, b: string): boolean {
  const left = aliasesFor(a);
  for (const alias of aliasesFor(b)) if (left.has(alias)) return true;
  return false;
}

function withinWindow(a: string, b: string): boolean {
  const days = Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
  return Number.isFinite(days) && days <= MATCH_WINDOW_DAYS;
}

export interface ReconciliationSummary {
  subjects: number;
  matched: number;
  gradeMismatches: number;
  agentOnly: number;
  ediaryOnly: number;
  /**
   * Matched over everything either system recorded.
   *
   * Reported, and not to be read as accuracy. An unmatched row may be a real
   * miss or two systems using different words, and until a human has filled in
   * the cause column this number is the floor of agreement rather than a measure
   * of it.
   */
  agreementFloor: number | null;
}

export function reconcile(
  agentEvents: readonly AgentEvent[],
  ediary: readonly EDiaryEntry[],
): { rows: ReconciledRow[]; summary: ReconciliationSummary } {
  const rows: ReconciledRow[] = [];
  const claimed = new Set<number>();

  for (const event of agentEvents) {
    // Best fit, not first fit. A participant who logged "Fatigue" grade 1 on
    // Sunday and grade 3 on Tuesday would otherwise have the agent's Tuesday
    // grade-3 event claim the Sunday row: one fabricated grade disagreement plus
    // one fabricated eDiary-only, from a case where both systems agreed exactly.
    //
    // Nearest date first, with grade agreement breaking a tie — the two signals
    // that say "the same event" when the terms already match.
    const candidates = ediary
      .map((entry, i) => ({ entry, i }))
      .filter(
        ({ entry, i }) =>
          !claimed.has(i) &&
          entry.subjectId === event.subjectId &&
          sameSymptom(entry.term, event.codedTerm) &&
          withinWindow(entry.date, event.recordedAt),
      )
      .sort((a, b) => {
        const gap = (c: { entry: EDiaryEntry }) =>
          Math.abs(Date.parse(c.entry.date) - Date.parse(event.recordedAt));
        const byDate = gap(a) - gap(b);
        if (byDate !== 0) return byDate;
        const agrees = (c: { entry: EDiaryEntry }) =>
          typeof c.entry.grade === "number" && c.entry.grade === event.grade ? 0 : 1;
        return agrees(a) - agrees(b);
      });
    const index = candidates.length ? candidates[0].i : -1;

    if (index === -1) {
      rows.push({
        subjectId: event.subjectId,
        kind: "agent_only",
        term: event.codedTerm,
        agentGrade: event.grade,
        ediaryGrade: null,
        agentDate: event.recordedAt,
        ediaryDate: null,
        sessionId: event.sessionId,
        verbatim: event.verbatimTerm,
        cause: "",
      });
      continue;
    }

    claimed.add(index);
    const entry = ediary[index];
    const gradesDiffer =
      typeof entry.grade === "number" && entry.grade !== event.grade;
    rows.push({
      subjectId: event.subjectId,
      kind: gradesDiffer ? "grade_mismatch" : "matched",
      term: event.codedTerm,
      agentGrade: event.grade,
      ediaryGrade: entry.grade ?? null,
      agentDate: event.recordedAt,
      ediaryDate: entry.date,
      sessionId: event.sessionId,
      verbatim: event.verbatimTerm,
      cause: "",
    });
  }

  ediary.forEach((entry, i) => {
    if (claimed.has(i)) return;
    rows.push({
      subjectId: entry.subjectId,
      kind: "ediary_only",
      term: entry.term,
      agentGrade: null,
      ediaryGrade: entry.grade ?? null,
      agentDate: null,
      ediaryDate: entry.date,
      sessionId: null,
      verbatim: null,
      cause: "",
    });
  });

  rows.sort(
    (a, b) => a.subjectId.localeCompare(b.subjectId) || a.term.localeCompare(b.term),
  );

  const count = (kind: DisagreementKind) => rows.filter((r) => r.kind === kind).length;
  const matched = count("matched");
  const total = rows.length;

  return {
    rows,
    summary: {
      subjects: new Set(rows.map((r) => r.subjectId)).size,
      matched,
      gradeMismatches: count("grade_mismatch"),
      agentOnly: count("agent_only"),
      ediaryOnly: count("ediary_only"),
      agreementFloor: total === 0 ? null : matched / total,
    },
  };
}

/** One row per line, with the cause column empty for a reviewer to complete. */
export function toCsv(rows: readonly ReconciledRow[]): string {
  const header = [
    "subject_id",
    "kind",
    "term",
    "agent_grade",
    "ediary_grade",
    "agent_date",
    "ediary_date",
    "session_id",
    "verbatim",
    "cause",
  ];
  const escape = (v: unknown) => {
    const text = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = rows.map((r) =>
    [
      r.subjectId,
      r.kind,
      r.term,
      r.agentGrade,
      r.ediaryGrade,
      r.agentDate,
      r.ediaryDate,
      r.sessionId,
      r.verbatim,
      r.cause,
    ]
      .map(escape)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
