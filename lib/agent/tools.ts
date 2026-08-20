import type Anthropic from "@anthropic-ai/sdk";
import { PROTOCOL, findSubject } from "../clinical/protocol.ts";
import {
  CTCAE_GRADES,
  ESCALATION_GRADE_THRESHOLD,
  SAE_CRITERIA,
  determineSeriousness,
  type CtcaeGrade,
  type EscalationUrgency,
  type SaeCriterion,
} from "../clinical/safety.ts";
import { checkProvenance } from "../clinical/provenance.ts";
import {
  nextConMedId,
  nextEscalationId,
  nextEventId,
  type CheckInSession,
} from "../store/session.ts";

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "verify_subject",
    description:
      "Confirm the caller is an enrolled subject using two factors: their subject " +
      "ID and their date of birth. Must succeed before any clinical question is " +
      "asked. Returns the subject's study context, including baseline conditions " +
      "that are already documented and must not be recorded as new adverse events.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        subject_id: {
          type: "string",
          description:
            "Subject ID as spoken, e.g. '001-0042' or 'zero zero one dash zero " +
            "zero four two'. Digits are extracted for matching, so pass it through " +
            "roughly as heard.",
        },
        date_of_birth: {
          type: "string",
          description: "Date of birth normalized to YYYY-MM-DD.",
        },
      },
      required: ["subject_id", "date_of_birth"],
    },
  },
  {
    name: "record_safety_screen_item",
    description:
      "Record the subject's answer to ONE directed safety screen item, at the moment " +
      "they answer it. Call this immediately after each answer — never batch several " +
      "items into one call, and never record an item you have not actually asked. A " +
      "positive red flag escalates automatically and immediately, so recording early " +
      "is what gets a coordinator involved fastest.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        item_id: {
          type: "string",
          enum: PROTOCOL.safetyScreen.map((i) => i.id),
          description: "Which screen item this answer belongs to.",
        },
        answer: {
          type: ["boolean", "null"],
          description:
            "True for yes, false for no. Null ONLY when the item does not apply to " +
            "this subject and you therefore did not ask it. Never guess — if the " +
            "answer was unclear, ask again rather than recording a value.",
        },
        verbatim: {
          type: ["string", "null"],
          description:
            "What the subject actually said, in their words. Null if they answered " +
            "with a bare yes or no.",
        },
      },
      required: ["item_id", "answer", "verbatim"],
    },
  },
  {
    name: "record_adverse_event",
    description:
      "Record an adverse event in the eCRF. Call this once per distinct symptom, " +
      "as soon as you have enough to grade it — do not batch them until the end of " +
      "the call. If the subject later corrects a detail, call record_adverse_event " +
      "again with the corrected values and note the correction in grade_rationale.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        verbatim_term: {
          type: "string",
          description:
            "The subject's own words for the symptom, quoted as closely as the " +
            "transcript allows. This is the source record and must not be cleaned " +
            "up, medicalized, or paraphrased.",
        },
        coded_term: {
          type: "string",
          description:
            "The clinical term for the eCRF, e.g. 'Nausea', 'Peripheral sensory " +
            "neuropathy'. Prefer the protocol's solicited term when it matches.",
        },
        onset_description: {
          type: "string",
          description:
            "When it started, as the subject described it — 'three days ago', " +
            "'since Tuesday', 'a while back'. Do not convert to a date you were " +
            "not given.",
        },
        ongoing: {
          type: "boolean",
          description: "True if the symptom is still present now.",
        },
        grade: {
          type: "integer",
          enum: [1, 2, 3, 4, 5],
          description: "CTCAE v5.0 grade, assigned from functional impact.",
        },
        grade_rationale: {
          type: "string",
          description:
            "One sentence citing the functional evidence behind the grade, e.g. " +
            "'Reports needing help bathing this week.' A coordinator reads this to " +
            "check your work.",
        },
        limits_self_care: {
          type: "boolean",
          description:
            "True if the subject indicated the symptom interferes with bathing, " +
            "dressing, feeding, or toileting.",
        },
        spontaneous: {
          type: "boolean",
          description:
            "True if the subject raised this unprompted rather than in response to " +
            "the solicited symptom review.",
        },
      },
      required: [
        "verbatim_term",
        "coded_term",
        "onset_description",
        "ongoing",
        "grade",
        "grade_rationale",
        "limits_self_care",
        "spontaneous",
      ],
    },
  },
  {
    name: "assess_seriousness",
    description:
      "Evaluate a recorded adverse event against the ICH E2A / 21 CFR 312.32 " +
      "seriousness criteria. Call this for any event touching hospitalization, " +
      "life-threatening symptoms, disability, or anything the subject describes as " +
      "the worst it has been. Returns the reporting clock that applies.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        event_id: {
          type: "string",
          description: "The event ID returned by record_adverse_event, e.g. 'AE-001'.",
        },
        criteria_met: {
          type: "array",
          description:
            "Every seriousness criterion the event meets. Empty array if it meets " +
            "none — that is a valid and common outcome.",
          items: {
            type: "string",
            enum: Object.keys(SAE_CRITERIA),
          },
        },
        basis: {
          type: "string",
          description:
            "What the subject said that supports this determination, in their words.",
        },
      },
      required: ["event_id", "criteria_met", "basis"],
    },
  },
  {
    name: "record_adherence",
    description:
      "Record study drug adherence since the last check-in. Call once per check-in.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        doses_missed: {
          type: "integer",
          description: "Number of missed doses reported. Zero is a valid answer.",
        },
        reason_verbatim: {
          type: ["string", "null"],
          description:
            "The subject's stated reason, in their words. Null when no doses were " +
            "missed or no reason was given.",
        },
      },
      required: ["doses_missed", "reason_verbatim"],
    },
  },
  {
    name: "record_concomitant_medication",
    description:
      "Record a medication started since the last check-in, including over-the-counter " +
      "products and supplements. Call once per medication.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Medication name as reported." },
        indication_verbatim: {
          type: "string",
          description: "Why they are taking it, in their words.",
        },
        started_description: {
          type: "string",
          description: "When they started it, as described.",
        },
      },
      required: ["name", "indication_verbatim", "started_description"],
    },
  },
  {
    name: "escalate_to_coordinator",
    description:
      "Route this check-in to a human. Call immediately when triggered — do not " +
      "finish the script first. Safe to call more than once in a call.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        urgency: {
          type: "string",
          enum: ["routine", "urgent", "emergency"],
          description:
            "'emergency' — subject needs care now and the call ends. 'urgent' — " +
            "coordinator paged today. 'routine' — normal review queue.",
        },
        reason: {
          type: "string",
          description: "What the coordinator needs to know, in two sentences or less.",
        },
        related_event_ids: {
          type: "array",
          items: { type: "string" },
          description: "Event IDs this escalation concerns. Empty array if none.",
        },
      },
      required: ["urgency", "reason", "related_event_ids"],
    },
  },
  {
    name: "complete_check_in",
    description:
      "Close and lock the check-in record. Call only after the read-back in step 7, " +
      "or when ending a call early on an emergency escalation.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          description:
            "Two to four sentences for the coordinator: what was reported, what was " +
            "graded, what needs attention.",
        },
        ended_early: {
          type: "boolean",
          description: "True if the call ended before the full script completed.",
        },
      },
      required: ["summary", "ended_early"],
    },
  },
];

export interface ToolOutcome {
  /** JSON payload handed back to the model as the tool_result. */
  result: unknown;
  isError?: boolean;
  /** Set when the tool ends the call. */
  terminal?: boolean;
}

type Handler = (
  session: CheckInSession,
  input: Record<string, unknown>,
) => ToolOutcome;

/**
 * Refuses a verbatim quote that has no basis in what the subject said.
 *
 * Returns null when the quote is grounded and the write may proceed. Otherwise
 * records the refusal in the audit trail — a rejected write is evidence the
 * model tried to enter unfounded content into a regulated record, and hiding it
 * would throw away the only signal that the call has gone wrong — and returns
 * the outcome the tool should hand back.
 *
 * Repeated refusals escalate. One is a slip; three means the conversation the
 * agent believes it is having is not the one taking place.
 */
const PROVENANCE_ESCALATION_THRESHOLD = 3;

function refuseUnfoundedQuote(
  session: CheckInSession,
  field: string,
  quote: string | null | undefined,
  context: string,
): ToolOutcome | null {
  if (quote == null || quote.trim() === "") return null;

  const verdict = checkProvenance(quote, session.subjectUtterances);
  if (verdict.grounded) return null;

  session.provenanceRejections += 1;

  session.audit.record({
    actor: "system",
    action: "WRITE_REFUSED_UNFOUNDED",
    entity: "Provenance",
    entityId: field,
    after: {
      field,
      context,
      quote,
      score: verdict.score,
      unsupported: verdict.unsupported,
      subjectUtteranceCount: session.subjectUtterances.length,
      rejectionsThisCall: session.provenanceRejections,
    },
    reason:
      "Verbatim text was refused because it does not appear in anything the " +
      "subject said on this call. No clinical record was written.",
  });

  const escalate =
    session.provenanceRejections >= PROVENANCE_ESCALATION_THRESHOLD &&
    !session.escalations.some((e) => e.category === "Unfounded record content");

  if (escalate) {
    const record = {
      id: nextEscalationId(session),
      urgency: "urgent" as const,
      reason:
        `${session.provenanceRejections} attempts to record content the subject ` +
        "never said. This check-in is not trustworthy and needs a human to review " +
        "the call before any of it is used.",
      relatedEventIds: [],
      triggeredBy: "safety_net" as const,
      category: "Unfounded record content",
      createdAt: new Date().toISOString(),
      sponsorNotificationDeadline: new Date(
        Date.now() + PROTOCOL.saeReportingWindowHours * 3600 * 1000,
      ).toISOString(),
    };
    session.escalations.push(record);
    session.status = "escalated";
    session.audit.record({
      actor: "safety_net",
      action: "ESCALATED",
      entity: "Escalation",
      entityId: record.id,
      after: record,
      reason:
        "Repeated unfounded write attempts. Deterministic, independent of model " +
        "judgment.",
    });
  }

  return {
    result: {
      error: `Refused: ${verdict.reason}`,
      field,
      instruction:
        "Nothing was recorded. Quote only what the subject actually said. If you " +
        "are unsure what they said, ask them again rather than reconstructing it — " +
        "a gap in the record is recoverable, an invented quote is not." +
        (escalate
          ? " A coordinator has been alerted that this call may be unreliable."
          : ""),
    },
    isError: true,
  };
}

const handlers: Record<string, Handler> = {
  verify_subject(session, input) {
    const subjectId = String(input.subject_id ?? "");
    const dob = String(input.date_of_birth ?? "");
    session.verificationAttempts += 1;

    const subject = findSubject(subjectId, dob);
    if (!subject) {
      session.audit.record({
        actor: "system",
        action: "VERIFICATION_FAILED",
        entity: "CheckInSession",
        entityId: session.id,
        after: { attempt: session.verificationAttempts, subjectIdOffered: subjectId },
        reason: "Two-factor subject verification did not match the roster.",
      });
      const exhausted = session.verificationAttempts >= 2;
      return {
        result: {
          verified: false,
          attempts_used: session.verificationAttempts,
          attempts_remaining: Math.max(0, 2 - session.verificationAttempts),
          instruction: exhausted
            ? "Two attempts have failed. Tell the subject to call their site " +
              "directly, collect no clinical information, and call complete_check_in " +
              "with ended_early true."
            : "Tell the subject the details did not match and offer one more try. " +
              "Do not hint at what the correct values are.",
        },
        isError: true,
      };
    }

    session.subject = subject;
    session.status = "in_progress";
    session.audit.record({
      actor: "system",
      action: "SUBJECT_VERIFIED",
      entity: "CheckInSession",
      entityId: session.id,
      after: { subjectId: subject.subjectId, siteId: subject.siteId },
      reason: "Two-factor verification succeeded (subject ID + date of birth).",
    });

    return {
      result: {
        verified: true,
        subject_id: subject.subjectId,
        initials: subject.initials,
        site: subject.siteName,
        cohort: subject.cohort,
        study_day: subject.studyDay,
        current_cycle: subject.currentCycle,
        last_check_in: subject.lastCheckIn,
        coordinator: subject.coordinatorName,
        baseline_conditions: subject.baselineConditions,
        known_concomitant_medications: subject.knownConMeds,
        instruction:
          "Verified. The baseline conditions listed above are already documented — " +
          "do not record them as new adverse events unless the subject reports they " +
          "have worsened. Proceed to step 2 and ask how they have been feeling.",
      },
    };
  },

  record_safety_screen_item(session, input) {
    if (!session.subject) {
      return {
        result: { error: "Subject is not verified. Verify before screening." },
        isError: true,
      };
    }

    const itemId = String(input.item_id ?? "");
    const item = PROTOCOL.safetyScreen.find((i) => i.id === itemId);
    if (!item) {
      return {
        result: { error: `Unknown screen item "${itemId}".` },
        isError: true,
      };
    }

    const screenRefusal = refuseUnfoundedQuote(
      session,
      "verbatim",
      input.verbatim as string | null,
      `record_safety_screen_item:${itemId}`,
    );
    if (screenRefusal) return screenRefusal;

    const answer =
      input.answer === null || input.answer === undefined
        ? null
        : Boolean(input.answer);

    const record = {
      itemId,
      answer,
      verbatim: input.verbatim == null ? null : String(input.verbatim),
      answeredAt: new Date().toISOString(),
    };

    session.safetyScreen ??= { items: [], positiveRedFlags: [] };
    const existingIdx = session.safetyScreen.items.findIndex(
      (i) => i.itemId === itemId,
    );
    const before = existingIdx >= 0 ? { ...session.safetyScreen.items[existingIdx] } : null;
    if (existingIdx >= 0) session.safetyScreen.items[existingIdx] = record;
    else session.safetyScreen.items.push(record);

    session.audit.record({
      actor: "agent",
      action: before ? "SAFETY_SCREEN_ITEM_UPDATED" : "SAFETY_SCREEN_ITEM_RECORDED",
      entity: "SafetyScreenItem",
      entityId: itemId,
      before,
      after: record,
      reason: `Directed safety screen item "${item.label}" answered by subject.`,
    });

    const isRedFlag = item.redFlag && answer === true;
    if (isRedFlag && !session.safetyScreen.positiveRedFlags.includes(itemId)) {
      session.safetyScreen.positiveRedFlags.push(itemId);
    }

    // Deterministic escalation, the instant the answer lands. No model judgment
    // stands between the subject saying yes and a coordinator being paged, and it
    // does not wait for the rest of the screen to finish.
    //
    // Gated on the PRIOR ANSWER, not on whether a prior record exists. Gating on
    // existence meant a subject who said "no" and then corrected to "yes" — the
    // single most important correction they can make — updated the record and
    // paged nobody. The prompt tells the agent not to escalate screen items
    // itself, so nothing downstream caught it either.
    const wasAlreadyPositive = before?.answer === true;
    let raised: string | null = null;
    if (isRedFlag && !wasAlreadyPositive) {
      const escalation = {
        id: nextEscalationId(session),
        urgency: item.urgencyIfPositive,
        reason: `Safety screen positive: ${item.label}. Subject answered yes to "${item.prompt}"`,
        relatedEventIds: [],
        triggeredBy: "safety_net" as const,
        category: item.label,
        createdAt: new Date().toISOString(),
        sponsorNotificationDeadline:
          item.urgencyIfPositive === "routine"
            ? null
            : new Date(
                Date.now() + PROTOCOL.saeReportingWindowHours * 3600 * 1000,
              ).toISOString(),
      };
      session.escalations.push(escalation);
      session.status = "escalated";
      session.audit.record({
        actor: "safety_net",
        action: "ESCALATED",
        entity: "Escalation",
        entityId: escalation.id,
        after: escalation,
        reason:
          `Deterministic escalation from a positive directed screen item (${itemId}). ` +
          "Independent of model judgment.",
      });
      raised = escalation.id;
    }

    const applicable = PROTOCOL.safetyScreen.filter(
      (i) =>
        i.appliesTo !== "childbearing_potential" ||
        session.subject?.childbearingPotential,
    );
    const answered = new Set(session.safetyScreen.items.map((i) => i.itemId));
    const remaining = applicable.filter((i) => !answered.has(i.id));

    return {
      result: {
        recorded: true,
        item: item.label,
        escalation_raised: raised,
        items_remaining: remaining.map((i) => i.id),
        instruction:
          isRedFlag && item.urgencyIfPositive === "emergency"
            ? "This is an emergency-tier answer and the coordinator is already paged. " +
              "Stop the screen. Tell the subject in one sentence to seek emergency care " +
              "now, then call complete_check_in with ended_early true."
            : isRedFlag
              ? `Recorded and ${session.subject.coordinatorName} has been paged — do not ` +
                "call escalate_to_coordinator for this. Ask briefly what happened, record " +
                "an adverse event if warranted, then carry on with the remaining screen items."
              : remaining.length > 0
                ? `Recorded. Next unanswered screen item: ${remaining[0].id}. Ask it exactly as written.`
                : "Screen complete. Move to the solicited symptom review.",
      },
    };
  },

  record_adverse_event(session, input) {
    if (!session.subject) {
      return {
        result: { error: "Subject is not verified. Verify before recording anything." },
        isError: true,
      };
    }

    const refusal = refuseUnfoundedQuote(
      session,
      "verbatim_term",
      input.verbatim_term as string | null,
      "record_adverse_event",
    );
    if (refusal) return refusal;

    const codedTerm = String(input.coded_term ?? "").trim();

    // Validated before anything is written. The schema is strict, so reaching
    // this needs a schema-enforcement gap — but if it happens, throwing later
    // leaves an AE_RECORDED audit entry for a call that reported failure, and
    // the model re-records it. Refuse first, mutate second.
    const rawGrade = Number(input.grade);
    if (!Number.isInteger(rawGrade) || rawGrade < 1 || rawGrade > 5) {
      return {
        result: {
          error:
            `Grade ${JSON.stringify(input.grade)} is not a CTCAE grade. ` +
            "Use an integer 1 through 5. Nothing was recorded.",
        },
        isError: true,
      };
    }
    const grade = rawGrade as CtcaeGrade;

    // Re-record of an existing term is a correction, not a duplicate event.
    const existing = session.adverseEvents.find(
      (e) => e.codedTerm.toLowerCase() === codedTerm.toLowerCase(),
    );

    const record = {
      id: existing?.id ?? nextEventId(session),
      verbatimTerm: String(input.verbatim_term ?? ""),
      codedTerm,
      onsetDescription: String(input.onset_description ?? ""),
      ongoing: Boolean(input.ongoing),
      grade,
      gradeRationale: String(input.grade_rationale ?? ""),
      limitsSelfCare: Boolean(input.limits_self_care),
      seriousness: existing?.seriousness ?? null,
      recordedAt: new Date().toISOString(),
      spontaneous: Boolean(input.spontaneous),
    };

    if (existing) {
      const before = { ...existing };
      Object.assign(existing, record);
      session.audit.record({
        actor: "agent",
        action: "AE_UPDATED",
        entity: "AdverseEvent",
        entityId: record.id,
        before,
        after: { ...existing },
        reason: "Subject corrected or added detail during the check-in.",
      });
    } else {
      session.adverseEvents.push(record);
      session.audit.record({
        actor: "agent",
        action: "AE_RECORDED",
        entity: "AdverseEvent",
        entityId: record.id,
        after: record,
        reason: record.spontaneous
          ? "Spontaneous report by subject."
          : "Solicited during protocol-specified symptom review.",
      });
    }

    if (!session.solicitedReviewed.includes(codedTerm)) {
      session.solicitedReviewed.push(codedTerm);
    }
    // NOTE: recording an event is not the only way a symptom gets reviewed —
    // markSolicitedAsked() in the runner marks the ones answered "no", which are
    // the majority. See lib/agent/runner.ts.

    const needsEscalation = grade >= ESCALATION_GRADE_THRESHOLD;
    return {
      result: {
        event_id: record.id,
        recorded: true,
        was_correction: Boolean(existing),
        grade_label: CTCAE_GRADES[grade].label,
        instruction: needsEscalation
          ? `Grade ${grade} meets the escalation threshold. Call ` +
            "escalate_to_coordinator now, before continuing the review, and call " +
            "assess_seriousness for this event."
          : "Recorded. Continue the review. Do not tell the subject the grade — " +
            "grades are for the coordinator, not the subject.",
      },
    };
  },

  assess_seriousness(session, input) {
    const eventId = String(input.event_id ?? "");
    const event = session.adverseEvents.find((e) => e.id === eventId);
    if (!event) {
      return {
        result: {
          error: `No event with ID ${eventId}. Record the event first, then assess it.`,
        },
        isError: true,
      };
    }

    const rawCriteria = Array.isArray(input.criteria_met) ? input.criteria_met : [];
    const criteria = rawCriteria.filter(
      (c): c is SaeCriterion => typeof c === "string" && c in SAE_CRITERIA,
    );

    const determination = determineSeriousness(
      criteria,
      PROTOCOL.saeReportingWindowHours,
    );
    const before = event.seriousness;
    event.seriousness = { ...determination, assessedAt: new Date().toISOString() };

    session.audit.record({
      actor: "agent",
      action: determination.isSerious ? "SAE_DETERMINED" : "SERIOUSNESS_ASSESSED",
      entity: "AdverseEvent",
      entityId: eventId,
      before,
      after: event.seriousness,
      reason: `Seriousness assessed against 21 CFR 312.32 criteria. Basis: ${String(input.basis ?? "not stated")}`,
    });

    if (!determination.isSerious) {
      return {
        result: {
          event_id: eventId,
          is_serious: false,
          instruction:
            "Not serious by regulatory criteria. This does not change the CTCAE " +
            "grade. Continue the review.",
        },
      };
    }

    const deadline = new Date(
      Date.now() + PROTOCOL.saeReportingWindowHours * 3600 * 1000,
    ).toISOString();

    return {
      result: {
        event_id: eventId,
        is_serious: true,
        criteria_met: determination.criteria.map((c) => SAE_CRITERIA[c].label),
        sponsor_notification_deadline: deadline,
        sponsor_notification_hours: determination.sponsorNotificationHours,
        ind_safety_report_note: determination.indSafetyReportNote,
        instruction:
          "This is a serious adverse event. Call escalate_to_coordinator with " +
          "urgency 'urgent' or 'emergency' immediately. Do not tell the subject the " +
          "words 'serious adverse event' — say you are getting their coordinator " +
          "involved right away.",
      },
    };
  },

  record_adherence(session, input) {
    const adherenceRefusal = refuseUnfoundedQuote(
      session,
      "reason_verbatim",
      input.reason_verbatim as string | null,
      "record_adherence",
    );
    if (adherenceRefusal) return adherenceRefusal;

    const missed = Number(input.doses_missed ?? 0);
    const reason =
      input.reason_verbatim == null ? null : String(input.reason_verbatim);
    const before = session.adherence;
    session.adherence = {
      dosesMissedSinceLastCheckIn: missed,
      reasonVerbatim: reason,
      recordedAt: new Date().toISOString(),
    };
    session.audit.record({
      actor: "agent",
      action: before ? "ADHERENCE_UPDATED" : "ADHERENCE_RECORDED",
      entity: "Adherence",
      entityId: session.id,
      before,
      after: session.adherence,
      reason: "Study drug adherence collected during check-in.",
    });
    return {
      result: {
        recorded: true,
        instruction:
          missed > 0
            ? "Missed doses recorded. Do not correct, coach, or express " +
              "disappointment. Move to step 6."
            : "Recorded. Move to step 6.",
      },
    };
  },

  record_concomitant_medication(session, input) {
    const conMedRefusal = refuseUnfoundedQuote(
      session,
      "indication_verbatim",
      input.indication_verbatim as string | null,
      "record_concomitant_medication",
    );
    if (conMedRefusal) return conMedRefusal;

    const record = {
      id: nextConMedId(session),
      name: String(input.name ?? ""),
      indicationVerbatim: String(input.indication_verbatim ?? ""),
      startedDescription: String(input.started_description ?? ""),
      recordedAt: new Date().toISOString(),
    };
    session.conMeds.push(record);
    session.audit.record({
      actor: "agent",
      action: "CONMED_RECORDED",
      entity: "ConcomitantMedication",
      entityId: record.id,
      after: record,
      reason: "New concomitant medication reported by subject.",
    });
    return {
      result: {
        conmed_id: record.id,
        recorded: true,
        instruction:
          "Recorded. Ask whether there are any others, then move to step 7.",
      },
    };
  },

  escalate_to_coordinator(session, input) {
    const urgency = String(input.urgency ?? "routine") as EscalationUrgency;
    const relatedRaw = Array.isArray(input.related_event_ids)
      ? input.related_event_ids
      : [];
    const record = {
      id: nextEscalationId(session),
      urgency,
      reason: String(input.reason ?? ""),
      relatedEventIds: relatedRaw.map(String),
      triggeredBy: "agent" as const,
      category: null,
      createdAt: new Date().toISOString(),
      sponsorNotificationDeadline:
        urgency === "routine"
          ? null
          : new Date(
              Date.now() + PROTOCOL.saeReportingWindowHours * 3600 * 1000,
            ).toISOString(),
    };
    session.escalations.push(record);
    session.status = "escalated";
    session.audit.record({
      actor: "agent",
      action: "ESCALATED",
      entity: "Escalation",
      entityId: record.id,
      after: record,
      reason: `Agent-initiated escalation at urgency '${urgency}'.`,
    });

    const coordinator = session.subject?.coordinatorName ?? "the study coordinator";
    return {
      result: {
        escalation_id: record.id,
        urgency,
        notified: coordinator,
        instruction:
          urgency === "emergency"
            ? "Coordinator paged. Tell the subject in one sentence to seek " +
              "emergency care now and that their coordinator has been alerted. Then " +
              "call complete_check_in with ended_early true. Ask nothing further."
            : urgency === "urgent"
              ? `${coordinator} has been paged and will call today. Tell the subject ` +
                "a coordinator will reach out, then continue the check-in if it is " +
                "safe to do so."
              : "Flagged for routine review. Continue the check-in.",
      },
    };
  },

  complete_check_in(session, input) {
    session.summary = String(input.summary ?? "");
    session.completedAt = new Date().toISOString();
    if (session.status !== "escalated") session.status = "completed";
    session.audit.record({
      actor: "agent",
      action: "CHECK_IN_COMPLETED",
      entity: "CheckInSession",
      entityId: session.id,
      after: {
        status: session.status,
        summary: session.summary,
        endedEarly: Boolean(input.ended_early),
        adverseEventCount: session.adverseEvents.length,
        escalationCount: session.escalations.length,
      },
      reason: input.ended_early
        ? "Check-in ended early."
        : "Check-in completed through the full protocol script.",
    });
    return {
      result: {
        completed: true,
        instruction:
          "Record is locked. Say a brief goodbye in one sentence and stop.",
      },
      terminal: true,
    };
  },
};

export function executeTool(
  session: CheckInSession,
  name: string,
  input: unknown,
): ToolOutcome {
  const handler = handlers[name];
  if (!handler) {
    return { result: { error: `Unknown tool: ${name}` }, isError: true };
  }
  try {
    return handler(session, (input ?? {}) as Record<string, unknown>);
  } catch (err) {
    return {
      result: {
        error: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      isError: true,
    };
  }
}
