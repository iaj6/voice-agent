/**
 * Adverse-event severity, seriousness, and the deterministic escalation net.
 *
 * The keyword net in this file is intentionally NOT model-driven. An LLM deciding
 * whether to escalate is a probabilistic control; a regulated safety pathway needs
 * a deterministic one behind it. The model is the primary path, this is the floor.
 */

// ---------------------------------------------------------------------------
// CTCAE v5.0 severity
// ---------------------------------------------------------------------------

import {
  assessContext,
  suppressionReason,
  type ContextVerdict,
} from "./context.ts";

export type CtcaeGrade = 1 | 2 | 3 | 4 | 5;

export const CTCAE_GRADES: Record<CtcaeGrade, { label: string; definition: string }> = {
  1: {
    label: "Grade 1 — Mild",
    definition:
      "Asymptomatic or mild symptoms; clinical or diagnostic observations only; " +
      "intervention not indicated.",
  },
  2: {
    label: "Grade 2 — Moderate",
    definition:
      "Minimal, local, or noninvasive intervention indicated; limiting " +
      "age-appropriate instrumental activities of daily living (shopping, cooking, " +
      "managing money, using the phone).",
  },
  3: {
    label: "Grade 3 — Severe",
    definition:
      "Severe or medically significant but not immediately life-threatening; " +
      "hospitalization or prolongation of hospitalization indicated; disabling; " +
      "limiting self-care activities of daily living (bathing, dressing, feeding, " +
      "toileting).",
  },
  4: {
    label: "Grade 4 — Life-threatening",
    definition: "Life-threatening consequences; urgent intervention indicated.",
  },
  5: {
    label: "Grade 5 — Death",
    definition: "Death related to the adverse event.",
  },
};

/** Grade 3 and above always leaves the automated pathway. */
export const ESCALATION_GRADE_THRESHOLD: CtcaeGrade = 3;

// ---------------------------------------------------------------------------
// Seriousness — ICH E2A / 21 CFR 312.32
// ---------------------------------------------------------------------------

export type SaeCriterion =
  | "death"
  | "life_threatening"
  | "hospitalization"
  | "disability"
  | "congenital_anomaly"
  | "important_medical_event";

export const SAE_CRITERIA: Record<SaeCriterion, { label: string; definition: string }> = {
  death: {
    label: "Results in death",
    definition: "The adverse event resulted in the death of the subject.",
  },
  life_threatening: {
    label: "Life-threatening",
    definition:
      "The subject was at immediate risk of death from the event as it occurred. " +
      "Not an event that hypothetically might have caused death if more severe.",
  },
  hospitalization: {
    label: "Inpatient hospitalization or prolongation",
    definition:
      "Required inpatient hospitalization or prolonged an existing hospitalization. " +
      "Emergency department visits and elective admissions do not by themselves qualify.",
  },
  disability: {
    label: "Persistent or significant disability/incapacity",
    definition:
      "Substantial disruption of the subject's ability to conduct normal life functions.",
  },
  congenital_anomaly: {
    label: "Congenital anomaly or birth defect",
    definition: "A congenital anomaly or birth defect in the offspring of a subject.",
  },
  important_medical_event: {
    label: "Important medical event",
    definition:
      "May jeopardize the subject or require intervention to prevent one of the " +
      "other outcomes listed above.",
  },
};

export interface SeriousnessDetermination {
  isSerious: boolean;
  criteria: SaeCriterion[];
  /** Hours from site awareness to sponsor notification. */
  sponsorNotificationHours: number | null;
  /**
   * Sponsor-to-FDA IND safety report clock, per 21 CFR 312.32(c)(1). Only runs
   * when the event is serious AND unexpected AND there is a reasonable possibility
   * the drug caused it — the latter two are the sponsor's call, not this agent's.
   */
  indSafetyReportNote: string | null;
}

export function determineSeriousness(
  criteria: SaeCriterion[],
  sponsorWindowHours: number,
): SeriousnessDetermination {
  const isSerious = criteria.length > 0;
  if (!isSerious) {
    return {
      isSerious: false,
      criteria: [],
      sponsorNotificationHours: null,
      indSafetyReportNote: null,
    };
  }
  const fatalOrLifeThreatening =
    criteria.includes("death") || criteria.includes("life_threatening");
  return {
    isSerious: true,
    criteria,
    sponsorNotificationHours: sponsorWindowHours,
    indSafetyReportNote: fatalOrLifeThreatening
      ? "If assessed by the sponsor as serious, unexpected, and reasonably " +
        "possibly related to study drug, this qualifies for a 7-calendar-day IND " +
        "safety report to FDA (21 CFR 312.32(c)(2))."
      : "If assessed by the sponsor as serious, unexpected, and reasonably " +
        "possibly related to study drug, this qualifies for a 15-calendar-day IND " +
        "safety report to FDA (21 CFR 312.32(c)(1)).",
  };
}

// ---------------------------------------------------------------------------
// Deterministic escalation net
// ---------------------------------------------------------------------------

export type EscalationUrgency = "routine" | "urgent" | "emergency";

export interface SafetyNetHit {
  urgency: EscalationUrgency;
  category: string;
  matchedPhrase: string;
  instruction: string;
  /** Assertion, experiencer, and temporality reading of the matched span. */
  context: ContextVerdict;
  /**
   * True when context argues the match away — "no chest pain", "my husband had
   * chest pain", "call if I get chest pain". Suppressed hits are returned rather
   * than discarded: a control that silently drops matches cannot be audited, and
   * a coordinator reviewing a call should be able to see that the net fired and
   * why it stood down.
   */
  suppressed: boolean;
  suppressionReason: string | null;
}

interface NetRule {
  category: string;
  urgency: EscalationUrgency;
  /** Word-boundary anchored so "chest pain" does not fire on "chest painting". */
  patterns: RegExp[];
  instruction: string;
}

const EMERGENCY_INSTRUCTION =
  "Stop the check-in script immediately. Tell the subject in one short sentence " +
  "to hang up and call 911 (or their local emergency number) right now, and that " +
  "you are alerting their study coordinator. Do not ask further screening " +
  "questions. Do not offer reassurance, interpretation, or medical advice. Call " +
  "escalate_to_coordinator with urgency 'emergency' if you have not already.";

const URGENT_INSTRUCTION =
  "Treat this as a potential serious adverse event. Capture what the subject said " +
  "verbatim, ask only the minimum needed to record onset and severity, then call " +
  "escalate_to_coordinator with urgency 'urgent'. Do not reassure the subject that " +
  "this is expected or harmless.";

const NET_RULES: NetRule[] = [
  {
    category: "Possible cardiac or respiratory emergency",
    urgency: "emergency",
    patterns: [
      /\bchest (pain|pressure|tightness|tight)\b/i,
      // "pain in my chest" and "hard to breathe" are the same two concepts the
      // patterns above already target, just said the other way round. Both were
      // observed live from a simulated patient and missed. Completing an existing
      // pattern is fair; note that this is the last place hand-editing regexes is
      // the right answer — the durable fix is a sourced vocabulary, and every
      // phrasing added by hand is one an author happened to think of.
      /\b(pain|pressure|tightness|ache|aching) in (my |the |his |her )?chest\b/i,
      /\bpressure in my chest\b/i,
      /\b(can'?t|cannot|unable to|struggling to|struggle to) breathe\b/i,
      /\b(hard|difficult|a struggle) to breathe\b/i,
      /\b(trouble|difficulty|hard time) breathing\b/i,
      /\bgasping\b/i,
      /\bturning blue\b/i,
    ],
    instruction: EMERGENCY_INSTRUCTION,
  },
  {
    category: "Possible stroke",
    urgency: "emergency",
    patterns: [
      /\b(face|mouth) (is )?droop(ing|ed)?\b/i,
      /\bslurr?(ed|ing) (my |his |her )?(speech|words)\b/i,
      /\bcan'?t (move|feel) (my|his|her) (arm|leg|side|face)\b/i,
      /\b(sudden|suddenly) (numb|weak) on one side\b/i,
      /\bworst headache of my life\b/i,
    ],
    instruction: EMERGENCY_INSTRUCTION,
  },
  {
    category: "Self-harm or suicidal ideation",
    urgency: "emergency",
    patterns: [
      /\b(kill|killing) myself\b/i,
      /\bsuicid(e|al)\b/i,
      /\bend (my|it all|my life)\b/i,
      /\bhurt(ing)? myself\b/i,
      /\b(don'?t|do not) want to (live|be here|go on)\b/i,
      /\bbetter off dead\b/i,
    ],
    instruction:
      "Stop the check-in script immediately. Respond with warmth in one or two " +
      "short sentences, tell the subject they can reach the 988 Suicide and Crisis " +
      "Lifeline by calling or texting 988, and that you are alerting their study " +
      "coordinator now. Do not attempt counseling, risk assessment, or " +
      "problem-solving. Call escalate_to_coordinator with urgency 'emergency'.",
  },
  {
    category: "Severe bleeding",
    urgency: "emergency",
    patterns: [
      /\b(bleeding|blood) (that )?(won'?t|will not) stop\b/i,
      /\bcoughing up blood\b/i,
      /\bvomiting blood\b/i,
      /\bthrowing up blood\b/i,
      /\bblood in my (stool|urine|vomit)\b/i,
      /\bhemorrhag(e|ing)\b/i,
    ],
    instruction: EMERGENCY_INSTRUCTION,
  },
  {
    category: "Loss of consciousness or new severe neurologic symptom",
    urgency: "emergency",
    patterns: [
      /\b(passed|blacked) out\b/i,
      /\bfaint(ed|ing)\b/i,
      /\bseizure\b/i,
      /\bconvuls(ion|ing)\b/i,
      /\bunresponsive\b/i,
    ],
    instruction: EMERGENCY_INSTRUCTION,
  },
  {
    category: "Possible anaphylaxis or severe cutaneous reaction",
    urgency: "emergency",
    patterns: [
      /\b(throat|tongue|lips?|face) (is |are )?swell(ing|ed)\b/i,
      /\banaphyla(xis|ctic)\b/i,
      /\bskin (is )?(peeling|blistering|sloughing)\b/i,
      /\bblisters? (in|on) my mouth\b/i,
    ],
    instruction: EMERGENCY_INSTRUCTION,
  },
  {
    category: "Reported hospitalization or emergency care",
    urgency: "urgent",
    patterns: [
      /\b(was|been|got) (admitted|hospitalized)\b/i,
      /\bin the hospital\b/i,
      /\bwent to the (er|emergency room)\b/i,
      /\bemergency department\b/i,
      /\bambulance\b/i,
    ],
    instruction: URGENT_INSTRUCTION,
  },
  {
    category: "Possible neutropenic fever",
    urgency: "urgent",
    patterns: [
      /\bfever\b/i,
      /\btemperature (of |was |is )?(10[0-9]|3[89]|4[01])\b/i,
      /\bchills\b/i,
      /\bshaking\b/i,
    ],
    instruction:
      "Fever in a subject on cytotoxic or targeted therapy may indicate neutropenic " +
      "fever, which is an oncologic emergency. Ask only for the measured temperature " +
      "and when it started, then call escalate_to_coordinator with urgency 'urgent'. " +
      "Do not tell the subject it is probably a cold, or to take anything for it.",
  },
  {
    category: "Pregnancy",
    urgency: "urgent",
    patterns: [/\b(i'?m |i am |am )?pregnan(t|cy)\b/i, /\bmissed my period\b/i],
    instruction:
      "Pregnancy on an interventional oncology study is always reportable and " +
      "requires immediate coordinator involvement. Capture the report, do not ask " +
      "clinical follow-up questions, and call escalate_to_coordinator with urgency " +
      "'urgent'.",
  },
  {
    category: "Subject intends to stop study drug",
    urgency: "urgent",
    patterns: [
      /\b(stopped|quit|stopping|quitting) (taking |the )?(the )?(study )?(drug|medication|pill|tablet)\b/i,
      /\b(want|going) to (drop|withdraw) out\b/i,
      /\bwithdraw from the (study|trial)\b/i,
    ],
    instruction:
      "Do not attempt to persuade the subject to continue — that is coercion and " +
      "it is not your role. Acknowledge, capture the reason verbatim, and call " +
      "escalate_to_coordinator with urgency 'urgent'.",
  },
];

const URGENCY_RANK: Record<EscalationUrgency, number> = {
  routine: 0,
  urgent: 1,
  emergency: 2,
};

/**
 * Scans a subject utterance before it reaches the model. Returns every rule that
 * fired, highest urgency first. Runs server-side on the raw transcript so a
 * prompt-injection attempt in the audio cannot suppress it.
 */
/**
 * Every rule match in an utterance, each carrying its context reading.
 *
 * Returns suppressed matches too. Use assertedHits() for the ones that should
 * actually drive an escalation.
 */
export function scanForSafetySignals(utterance: string): SafetyNetHit[] {
  const hits: SafetyNetHit[] = [];
  for (const rule of NET_RULES) {
    for (const pattern of rule.patterns) {
      // exec() on a non-global regex always starts at 0, so match.index is stable.
      const match = pattern.exec(utterance);
      if (match) {
        const context = assessContext(
          utterance,
          match.index,
          match.index + match[0].length,
        );
        const reason = suppressionReason(context);
        hits.push({
          urgency: rule.urgency,
          category: rule.category,
          matchedPhrase: match[0],
          instruction: rule.instruction,
          context,
          suppressed: reason !== null,
          suppressionReason: reason,
        });
        break; // one hit per rule is enough
      }
    }
  }
  return hits.sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency]);
}

/** Matches that survived context analysis — these are the ones that escalate. */
export function assertedHits(hits: SafetyNetHit[]): SafetyNetHit[] {
  return hits.filter((h) => !h.suppressed);
}

export function highestUrgency(hits: SafetyNetHit[]): EscalationUrgency | null {
  const asserted = assertedHits(hits);
  if (asserted.length === 0) return null;
  return asserted[0].urgency;
}
