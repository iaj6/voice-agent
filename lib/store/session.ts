import type Anthropic from "@anthropic-ai/sdk";
import type { AuditEntry, AuditTrail } from "./audit";
import { getSessionStore } from "./session-store";
import type { Subject } from "@/lib/clinical/protocol";
import type {
  CtcaeGrade,
  EscalationUrgency,
  SaeCriterion,
  SeriousnessDetermination,
} from "@/lib/clinical/safety";

export interface AdverseEventRecord {
  id: string;
  /** The subject's own words. Required — coding must never replace the source. */
  verbatimTerm: string;
  /** The agent's clinical term for the eCRF. */
  codedTerm: string;
  onsetDescription: string;
  ongoing: boolean;
  grade: CtcaeGrade;
  gradeRationale: string;
  limitsSelfCare: boolean;
  seriousness: (SeriousnessDetermination & { assessedAt: string }) | null;
  recordedAt: string;
  /** True when the subject reported it unprompted rather than in the solicited review. */
  spontaneous: boolean;
}

/**
 * One screen item, recorded at the moment it was actually answered.
 *
 * Deliberately not a batch. An earlier design took every answer in a single tool
 * call, and when a call ended mid-screen the model invented the remaining
 * answers so it could make the call — inventing a fever answer and a bleeding
 * answer for questions never asked. Recording each item as it lands removes the
 * incentive rather than instructing against it, and it makes a partial screen
 * legible as partial instead of quietly complete.
 */
export interface SafetyScreenItemRecord {
  itemId: string;
  /** Null means the item does not apply to this subject. */
  answer: boolean | null;
  verbatim: string | null;
  answeredAt: string;
}

export interface SafetyScreenRecord {
  items: SafetyScreenItemRecord[];
  /** Item ids that came back positive and are red flags. */
  positiveRedFlags: string[];
}

export interface AdherenceRecord {
  dosesMissedSinceLastCheckIn: number;
  reasonVerbatim: string | null;
  recordedAt: string;
}

export interface ConMedRecord {
  id: string;
  name: string;
  indicationVerbatim: string;
  startedDescription: string;
  recordedAt: string;
}

export interface EscalationRecord {
  id: string;
  urgency: EscalationUrgency;
  reason: string;
  relatedEventIds: string[];
  triggeredBy: "agent" | "safety_net";
  category: string | null;
  createdAt: string;
  /** ISO deadline for site-to-sponsor notification, when one applies. */
  sponsorNotificationDeadline: string | null;
}

export type SessionStatus = "awaiting_verification" | "in_progress" | "escalated" | "completed";

export interface CheckInSession {
  id: string;
  createdAt: string;
  status: SessionStatus;
  subject: Subject | null;
  verificationAttempts: number;
  messages: Anthropic.Beta.BetaMessageParam[];
  adverseEvents: AdverseEventRecord[];
  safetyScreen: SafetyScreenRecord | null;
  adherence: AdherenceRecord | null;
  conMeds: ConMedRecord[];
  escalations: EscalationRecord[];
  solicitedReviewed: string[];
  summary: string | null;
  completedAt: string | null;
  audit: AuditTrail;
}

/**
 * Session lifecycle.
 *
 * Storage lives in session-store.ts; this module owns the domain shape and the
 * derived views. Both entry points are async because the durable backing is —
 * a call that cannot survive a restart is not something a participant should be
 * on the other end of.
 */
export async function createSession(): Promise<CheckInSession> {
  return getSessionStore().create();
}

export async function getSession(id: string): Promise<CheckInSession | null> {
  return getSessionStore().get(id);
}

/** Persists whatever has accumulated. Safe to call repeatedly. */
export async function saveSession(session: CheckInSession): Promise<void> {
  await getSessionStore().save(session);
}

export function nextEventId(session: CheckInSession): string {
  return `AE-${String(session.adverseEvents.length + 1).padStart(3, "0")}`;
}

export function nextConMedId(session: CheckInSession): string {
  return `CM-${String(session.conMeds.length + 1).padStart(3, "0")}`;
}

export function nextEscalationId(session: CheckInSession): string {
  return `ESC-${String(session.escalations.length + 1).padStart(3, "0")}`;
}

/** Serializable view for the client. Excludes the raw message history and audit object. */
export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  subject: Pick<
    Subject,
    | "subjectId"
    | "initials"
    | "siteName"
    | "cohort"
    | "studyDay"
    | "currentCycle"
    | "coordinatorName"
    | "coordinatorPhone"
    | "baselineConditions"
    | "knownConMeds"
    | "lastCheckIn"
    | "childbearingPotential"
  > | null;
  adverseEvents: AdverseEventRecord[];
  safetyScreen: SafetyScreenRecord | null;
  adherence: AdherenceRecord | null;
  conMeds: ConMedRecord[];
  escalations: EscalationRecord[];
  solicitedReviewed: string[];
  summary: string | null;
  completedAt: string | null;
  audit: AuditEntry[];
  auditChainValid: boolean;
}

export function snapshot(session: CheckInSession): SessionSnapshot {
  const chain = session.audit.verifyChain();
  return {
    id: session.id,
    status: session.status,
    subject: session.subject
      ? {
          subjectId: session.subject.subjectId,
          initials: session.subject.initials,
          siteName: session.subject.siteName,
          cohort: session.subject.cohort,
          studyDay: session.subject.studyDay,
          currentCycle: session.subject.currentCycle,
          coordinatorName: session.subject.coordinatorName,
          coordinatorPhone: session.subject.coordinatorPhone,
          baselineConditions: session.subject.baselineConditions,
          knownConMeds: session.subject.knownConMeds,
          lastCheckIn: session.subject.lastCheckIn,
          childbearingPotential: session.subject.childbearingPotential,
        }
      : null,
    adverseEvents: session.adverseEvents,
    safetyScreen: session.safetyScreen,
    adherence: session.adherence,
    conMeds: session.conMeds,
    escalations: session.escalations,
    solicitedReviewed: session.solicitedReviewed,
    summary: session.summary,
    completedAt: session.completedAt,
    audit: [...session.audit.all()],
    auditChainValid: chain.valid,
  };
}

export type { AuditEntry, SaeCriterion };
