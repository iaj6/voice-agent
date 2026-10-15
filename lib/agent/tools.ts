import type Anthropic from "@anthropic-ai/sdk";
import { PROTOCOL, findSubject, siteCountryForPrefix } from "../clinical/protocol.ts";
import { emergencyPhrase, speakingRegion } from "../clinical/locale.ts";
import {
  CTCAE_GRADES,
  ESCALATION_GRADE_THRESHOLD,
  URGENCY_RANK,
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
  type SafetyScreenRecord,
} from "../store/session.ts";
import { getSessionStore } from "../store/session-store.ts";
import { deliverEscalation } from "../escalation/deliver.ts";
import { raiseEscalation } from "../escalation/raise.ts";
import { getDeliveryStore } from "../store/deliveries.ts";

/** How many times one escalation may block a live call on a failing provider. */
const MAX_DELIVERY_ATTEMPTS = 2;
import { getKeyStore } from "../store/keys.ts";
import { getSubjectStore, isWithdrawn } from "../store/subjects.ts";
import { FIXED_PROXY_NOT_PERMITTED } from "./fixed-speech.ts";

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
        respondent: {
          type: "string",
          enum: ["self", "caregiver"],
          description:
            "Who is answering, from their reply to the fixed respondent question: " +
            "'self' if the participant is on the line, 'caregiver' if someone is " +
            "answering on their behalf. If unclear, ask again; do not assume.",
        },
      },
      required: ["subject_id", "date_of_birth", "respondent"],
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
        measurement: {
          type: ["string", "null"],
          description:
            "Only when a tool result has told you to ask a follow-up for this item " +
            "and you are recording the answer: the value exactly as the subject said " +
            "it, units included. Null if they did not measure, and null on every " +
            "other call.",
        },
      },
      required: ["item_id", "answer", "verbatim", "measurement"],
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
      "Close and lock the check-in record. Call only after the read-back in step 8, " +
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
) => ToolOutcome | Promise<ToolOutcome>;

/**
 * Screens a verbatim quote, returning the value that may be stored.
 *
 * **Drops the quote, never the record.** The first version of this returned an
 * error and aborted the whole tool call, which meant a red-flag safety screen
 * answer — "yes, I have had chest pain" — was thrown away whenever the agent's
 * paraphrase of it scored badly, and no coordinator was paged. It silently
 * undid the correction-escalation fix and locked the behaviour in with a test.
 * A doubtful quote is a doubtful quote; the structured answer beside it is
 * still the subject's, and it is the part with a reporting clock attached.
 *
 * A refusal is written to the audit trail rather than dropped — it is evidence
 * the model tried to enter unfounded content, and it is the only signal that the
 * conversation has gone wrong.
 */
const PROVENANCE_ESCALATION_THRESHOLD = 3;


/**
 * Raises and delivers an escalation for an adverse event, once.
 *
 * Idempotent per event and category, because the grade threshold and the
 * seriousness determination can both fire for the same event — and a correction
 * can re-record it — and a coordinator paged three times for one symptom stops
 * reading the pages.
 *
 * **Returns the delivery status either way.** The first version returned null on
 * the skip, and every caller read null as "not delivered": correcting a grade 3
 * event told the model the page had failed and to stop the participant relying on
 * it, when the coordinator had in fact been paged minutes earlier. That is the
 * same class of untruth this whole sprint exists to remove, reintroduced by the
 * fix for it. "Already raised" and "nobody was reached" are different facts and
 * nothing may collapse them.
 *
 * An escalation is re-raised when the urgency goes *up*. A correction from grade
 * 3 to grade 4 is a life-threatening event whose only page is sitting at urgent;
 * the deduplication must not hold a participant at the lower tier.
 */
async function escalateForEvent(
  session: CheckInSession,
  event: { id: string; codedTerm: string },
  urgency: EscalationUrgency,
  reason: string,
  category: string,
): Promise<{ raised: boolean; delivered: boolean; detail: string | null }> {
  // Matched on the event, not on (category, event). Keying on both meant the
  // grade threshold and the seriousness determination never saw each other, so a
  // grade 3 event that is also serious raised two escalations and sent two pages
  // seconds apart — and the grade-3 tool result *tells* the model to assess
  // seriousness next, so that was the standard path, not an edge case. Exactly
  // what the paragraph above claims this prevents.
  //
  // The seriousness fact is not lost by paging once: it is on the event itself
  // and in the audit trail as SAE_DETERMINED, both of which the coordinator sees
  // on opening the record. What they do not get is a second alert about a symptom
  // they are already looking at.
  const prior = session.escalations.find((e) => e.relatedEventIds.includes(event.id));

  if (prior && URGENCY_RANK[urgency] <= URGENCY_RANK[prior.urgency]) {
    // Already covered at this tier or higher. Report what actually happened to
    // that page rather than assuming either outcome.
    const attempts = await getDeliveryStore().forSession(session.id);
    const delivered = attempts.some(
      (d) =>
        d.escalationId === prior.id &&
        (d.status === "sent" || d.status === "acknowledged" || d.status === "suppressed"),
    );
    if (delivered) return { raised: false, delivered: true, detail: null };

    const attempted = attempts.some((d) => d.escalationId === prior.id);
    if (attempted) {
      // Tried and failed. Not re-raised: the sweeper retries failed rows, and a
      // second escalation would give it two ladders for one symptom. Reported
      // honestly instead.
      return {
        raised: false,
        delivered: false,
        detail: "an earlier page for this event did not go through",
      };
    }

    // An escalation with no attempt at all in this session is one carryForward
    // brought over from a dropped call: it renumbers escalations into the
    // successor and leaves the delivery filed under the old session id, so the
    // page did happen and cannot be seen from here.
    //
    // Paged again rather than guessed at. A duplicate alert about a symptom the
    // coordinator has already seen is a nuisance; telling a participant nobody
    // knows about their chest pain when somebody does is not.
    return raiseAndReport(session, event, urgency, reason, category);
  }

  return raiseAndReport(session, event, urgency, reason, category);
}

async function raiseAndReport(
  session: CheckInSession,
  event: { id: string; codedTerm: string },
  urgency: EscalationUrgency,
  reason: string,
  category: string,
): Promise<{ raised: boolean; delivered: boolean; detail: string | null }> {
  const outcome = await raiseEscalation(
    session,
    {
      id: nextEscalationId(session),
      urgency,
      reason,
      relatedEventIds: [event.id],
      triggeredBy: "safety_net",
      category,
      createdAt: new Date().toISOString(),
      sponsorNotificationDeadline:
        urgency === "routine"
          ? null
          : new Date(
              Date.now() + PROTOCOL.saeReportingWindowHours * 3600 * 1000,
            ).toISOString(),
    },
    { actor: "safety_net", auditReason: reason },
  );
  return { raised: true, delivered: outcome.delivered, detail: outcome.detail ?? null };
}

async function screenQuote(
  session: CheckInSession,
  field: string,
  quote: string | null | undefined,
  context: string,
): Promise<string | null> {
  if (quote == null || quote.trim() === "") return null;

  const verdict = checkProvenance(quote, session.subjectUtterances);
  if (verdict.grounded) return quote;

  // Deduplicated by field and text: the model retries a refused call, and with
  // MAX_TOOL_ITERATIONS at 8 three identical retries inside one turn used to
  // cross the escalation threshold and page a coordinator about a call that was
  // fine. Distinct fabrications still count separately.
  const fingerprint = `${field}:${quote.trim().toLowerCase()}`;
  const alreadySeen = session.refusedQuotes.includes(fingerprint);
  if (!alreadySeen) {
    session.refusedQuotes.push(fingerprint);
    session.provenanceRejections += 1;
  }

  session.audit.record({
    actor: "system",
    action: "QUOTE_REFUSED_UNFOUNDED",
    entity: "Provenance",
    entityId: field,
    after: {
      field,
      context,
      quote,
      score: verdict.score,
      unsupported: verdict.unsupported,
      reason: verdict.reason,
      repeat: alreadySeen,
      distinctRefusalsThisCall: session.provenanceRejections,
    },
    reason:
      "Verbatim text was refused because it does not appear in what the subject " +
      "said. The quote was dropped; any structured data in the same call was kept.",
  });

  if (
    session.provenanceRejections >= PROVENANCE_ESCALATION_THRESHOLD &&
    !session.escalations.some((e) => e.category === "Unfounded record content")
  ) {
    const record = {
      id: nextEscalationId(session),
      urgency: "urgent" as const,
      reason:
        `${session.provenanceRejections} distinct attempts to record content the ` +
        "subject never said. This check-in is not trustworthy and needs a human to " +
        "review the call before any of it is used.",
      relatedEventIds: [],
      triggeredBy: "safety_net" as const,
      category: "Unfounded record content",
      createdAt: new Date().toISOString(),
      sponsorNotificationDeadline: new Date(
        Date.now() + PROTOCOL.saeReportingWindowHours * 3600 * 1000,
      ).toISOString(),
    };
    // Delivered, not merely recorded. This had the same defect as the screen: an
    // agent repeatedly attributing words to a participant who never said them is
    // the strongest possible signal that the call cannot be trusted, and it
    // reached nobody.
    await raiseEscalation(session, record, {
      actor: "safety_net",
      auditReason:
        "Repeated unfounded quotes. Deterministic, independent of model judgment.",
    });
  }

  return null;
}

/**
 * Natural key for deduplicating a write.
 *
 * Natural rather than caller-supplied, because the case that matters is a redial:
 * the agent on the second call has no memory of a key it generated on the first.
 * Domain identity is the only thing both calls agree on.
 */
function naturalKey(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

/**
 * Carries a dropped call's record forward into the current one.
 *
 * A call that drops after an adverse event is captured leaves that event in a
 * session nobody will look at again, and the subject — who has already described
 * it once — is asked to describe it a second time. A stranded reportable event
 * is a compliance gap; re-interrogating someone who is unwell is how a check-in
 * gets abandoned halfway.
 *
 * Order matters. The successor is persisted with the carried record BEFORE the
 * source is closed, so a crash in between leaves the source claimable rather
 * than closed-and-empty. Locking first meant the exact failure this feature
 * exists for — a process dying mid-call — could strand the data permanently,
 * reachable only by someone reading the database by hand.
 */
/** Protocol truth for whether a screen item is a red flag. */
function isRedFlagItem(itemId: string): boolean {
  return PROTOCOL.safetyScreen.some((i) => i.id === itemId && i.redFlag);
}

/**
 * Union of two safety screens, with the successor's answer winning a conflict.
 *
 * Additive because a half-finished screen is the point: the subject answered
 * some items before the line dropped and the rest after, and re-asking a sick
 * person a red-flag question they already answered is how a check-in gets
 * abandoned. The successor wins ties because it is the more recent statement
 * from the same subject.
 */
function mergeSafetyScreen(
  live: SafetyScreenRecord | null,
  carried: SafetyScreenRecord | null,
): SafetyScreenRecord | null {
  if (!carried) return live;
  if (!live) return carried;

  const items = [...carried.items];
  for (const item of live.items) {
    const at = items.findIndex((i) => i.itemId === item.itemId);
    if (at === -1) items.push(item);
    else items[at] = item;
  }

  // Recomputed from the merged items rather than unioned from the two lists: a
  // red flag that was corrected to "no" on the second call must not survive
  // because the first call recorded it.
  const positiveRedFlags = items
    .filter((i) => i.answer && isRedFlagItem(i.itemId))
    .map((i) => i.itemId);

  return { items, positiveRedFlags };
}

async function resumeDroppedCall(
  session: CheckInSession,
  subjectId: string,
): Promise<Record<string, unknown> | null> {
  const store = getSessionStore();
  const prior = await store.claimResumable(subjectId, session.id);
  if (!prior) return null;

  // A shredded record has nothing to carry. Its free text came back as empty
  // arrays and "[destroyed]" placeholders so that reading it does not throw, and
  // carrying those forward would put a placeholder into a live eCRF and offer it
  // to the provenance gate as though the subject had said it.
  if (prior.shredded) {
    session.audit.record({
      actor: "system",
      action: "RESUME_DECLINED_SHREDDED",
      entity: "CheckInSession",
      entityId: prior.id,
      after: { from: prior.id },
      reason:
        "An earlier call for this subject was found, but its content has been " +
        "destroyed under a retention rule. Nothing was carried forward.",
    });
    return null;
  }

  // Deep copies. Sharing structure with a record that is about to be closed let
  // later writes mutate the closed one — an emergency-tier screen answer once
  // appeared inside a locked session with no matching audit entry, so the record
  // contradicted its own trail. The hash chain cannot see that; it arrives
  // through the object graph, not through the log.
  //
  // Merged, never assigned. The successor is not necessarily empty when this
  // runs: the deterministic safety net escalates on the subject's *first*
  // utterance, before the model takes a turn, and the DOB and an emergency
  // routinely arrive in one breath — "March 11th 1958, sorry, I've been coughing
  // up blood since last night". Assigning the prior call's escalations over the
  // top erased that escalation, dropped the session out of `escalated`, and left
  // an ESCALATED audit entry pointing at a record that no longer existed. The
  // one escalation that must never depend on the model was the one being
  // discarded.
  // Taken before a single field is touched. If persisting the merge fails, the
  // successor has to go back to being exactly the call it was: leaving it
  // carrying an unsaved copy of the prior record, while that prior record is
  // still open and claimable by a third call, is how one check-in becomes two.
  const beforeCarry = {
    adverseEvents: structuredClone(session.adverseEvents),
    safetyScreen: structuredClone(session.safetyScreen),
    adherence: structuredClone(session.adherence),
    conMeds: structuredClone(session.conMeds),
    escalations: structuredClone(session.escalations),
    solicitedReviewed: [...session.solicitedReviewed],
    screenAsked: [...session.screenAsked],
    subjectUtterances: [...session.subjectUtterances],
    provenanceRejections: session.provenanceRejections,
    refusedQuotes: [...session.refusedQuotes],
    status: session.status,
  };

  const priorEvents = structuredClone(prior.adverseEvents);
  const priorEscalations = structuredClone(prior.escalations);

  // Carried adverse events keep their identifiers where the successor has none
  // of its own, which is the normal case — every AE writer is gated behind
  // verification. Where it does, they are renumbered and the escalations that
  // reference them are rewritten through the same map, so no carried escalation
  // is left pointing at an event id that now means something else.
  const eventIdMap = new Map<string, string>();
  for (const event of priorEvents) {
    const collides = session.adverseEvents.some((e) => e.id === event.id);
    const id = collides ? nextEventId(session) : event.id;
    eventIdMap.set(event.id, id);
    event.id = id;
    session.adverseEvents.push(event);
  }

  for (const escalation of priorEscalations) {
    escalation.relatedEventIds = escalation.relatedEventIds.map(
      (id) => eventIdMap.get(id) ?? id,
    );
    escalation.id = nextEscalationId(session);
    session.escalations.push(escalation);
  }

  // The screen and the solicited list are additive: an item answered on either
  // call stays answered, and the successor's own answer wins a conflict because
  // it is the more recent statement from the subject.
  session.safetyScreen = mergeSafetyScreen(
    session.safetyScreen,
    structuredClone(prior.safetyScreen),
  );
  session.adherence = session.adherence ?? structuredClone(prior.adherence);
  for (const med of structuredClone(prior.conMeds)) {
    if (session.conMeds.some((m) => naturalKey(m.name) === naturalKey(med.name))) {
      continue;
    }
    med.id = nextConMedId(session);
    session.conMeds.push(med);
  }
  // Carried alongside solicitedReviewed, because the screen gate reads it.
  //
  // Without this, a call that drops mid-screen and redials starts with an empty
  // screenAsked, and record_safety_screen_item refuses every item the successor
  // has not re-asked — including a subject correcting "no" to "yes", which the
  // comment on the escalation gate below calls "the single most important
  // correction they can make". The gate added to stop fabrication would have
  // blocked the one answer that matters most.
  //
  // Intersected with what was actually *answered*, not everything that was
  // asked. `screenAsked` records that the agent spoke the prompt; a call that
  // drops between the question and the answer would otherwise carry the item
  // forward as asked, and the successor's gate would then accept an answer the
  // participant never gave — while the resume payload steers the model to "pick
  // up at the first unanswered item". A red-flag screen item recorded from
  // nothing is the fabrication this gate exists to stop, reintroduced by the fix
  // for a different hole in it. The correction case only needs items that were
  // both asked and answered.
  const priorAnswered = new Set(
    (prior.safetyScreen?.items ?? []).map((i) => i.itemId),
  );
  session.screenAsked = [
    ...new Set([
      ...prior.screenAsked.filter((id) => priorAnswered.has(id)),
      ...session.screenAsked,
    ]),
  ];
  session.solicitedReviewed = [
    ...new Set([...prior.solicitedReviewed, ...session.solicitedReviewed]),
  ];

  // Prior speech comes too: without it the provenance gate would refuse a quote
  // of something said before the line dropped. Deduplicated, because a retried
  // verify_subject would otherwise append the same utterances twice and inflate
  // the corpus the gate scores against.
  session.subjectUtterances = [
    ...new Set([...prior.subjectUtterances, ...session.subjectUtterances]),
  ];

  // The fabrication counter travels too. Two unfounded quotes before the drop
  // and two after would otherwise never reach the escalation threshold that a
  // single continuous call would have crossed.
  session.provenanceRejections = prior.provenanceRejections;
  session.refusedQuotes = [...prior.refusedQuotes];

  if (prior.status === "escalated") session.status = "escalated";

  const carried = {
    from: prior.id,
    started_at: prior.createdAt,
    // Identities, not counts. The instruction tells the agent to pick up at the
    // first unanswered item; counts alone force it to guess, and guessing
    // protocol order skips a red-flag screen item that was never asked.
    adverse_events: session.adverseEvents.map((e) => ({
      id: e.id,
      coded_term: e.codedTerm,
      grade: e.grade,
    })),
    screen_items_answered: (session.safetyScreen?.items ?? []).map((i) => ({
      item_id: i.itemId,
      answer: i.answer,
    })),
    concomitant_medications: session.conMeds.map((m) => m.name),
    escalations: session.escalations.map((e) => ({
      id: e.id,
      urgency: e.urgency,
    })),
    adherence_recorded: session.adherence !== null,
    solicited_symptoms_reviewed: [...session.solicitedReviewed],
  };

  const nothingToCarry =
    carried.adverse_events.length === 0 &&
    carried.screen_items_answered.length === 0 &&
    carried.concomitant_medications.length === 0 &&
    carried.escalations.length === 0 &&
    !carried.adherence_recorded;

  session.audit.record({
    actor: "system",
    action: "CALL_RESUMED",
    entity: "CheckInSession",
    entityId: prior.id,
    after: carried,
    reason:
      "An earlier check-in for this subject was interrupted within the resume " +
      "window and had been idle. Its record was carried forward.",
  });

  // Persist the successor first. Only then close the source.
  try {
    await store.save(session);
  } catch (err) {
    // The merge never reached the database. Put the successor back and let the
    // call continue unresumed rather than half-resumed: `prior` keeps its lease
    // but stays open, so it goes back to being claimable once the lease ages out
    // and its record is recovered by the next redial instead of stranded.
    Object.assign(session, beforeCarry);
    session.audit.record({
      actor: "system",
      action: "CALL_RESUME_FAILED",
      entity: "CheckInSession",
      entityId: prior.id,
      after: { attemptedFrom: prior.id, error: String(err) },
      reason:
        "An earlier record was claimed but could not be persisted into this " +
        "session. The carry-forward was rolled back; the earlier record remains " +
        "open and is not closed.",
    });
    return null;
  }

  prior.audit.record({
    actor: "system",
    action: "SESSION_SUPERSEDED",
    entity: "CheckInSession",
    entityId: prior.id,
    after: { supersededBy: session.id },
    reason:
      "Call was interrupted and the subject redialled. This record was carried " +
      "forward and this session is closed to further writes.",
  });
  try {
    await store.supersede(prior, session.id);
  } catch {
    // Someone closed it first. The successor already holds the record — which is
    // the outcome that matters — so the call proceeds; the loser of the race is
    // the one that carried nothing forward.
  }

  return nothingToCarry ? null : carried;
}

const handlers: Record<string, Handler> = {
  async verify_subject(session, input) {
    const subjectId = String(input.subject_id ?? "");
    const dob = String(input.date_of_birth ?? "");

    // The attempt limit and the one-identity-per-call rule are enforced here,
    // not left to the instruction text below. A model can be talked into "one
    // more try", and a second verification mid-call would reassign every record
    // that follows to whoever's details were offered last.
    if (session.subject) {
      session.audit.record({
        actor: "system",
        action: "VERIFICATION_REFUSED",
        entity: "CheckInSession",
        entityId: session.id,
        after: { subjectIdOffered: subjectId, verifiedAs: session.subject.subjectId },
        reason: "This call is already verified. Identity cannot change mid-call.",
      });
      return {
        result: {
          verified: false,
          instruction:
            "This call is already verified for one participant. Do not verify " +
            "again. Continue the check-in for the participant already verified.",
        },
        isError: true,
      };
    }
    if (session.verificationAttempts >= 2) {
      session.audit.record({
        actor: "system",
        action: "VERIFICATION_REFUSED",
        entity: "CheckInSession",
        entityId: session.id,
        after: { attempt: session.verificationAttempts + 1, subjectIdOffered: subjectId },
        reason: "Verification attempts exhausted. The offered details were not checked.",
      });
      return {
        result: {
          verified: false,
          attempts_used: session.verificationAttempts,
          attempts_remaining: 0,
          instruction:
            "Two attempts have already failed and no further attempts are allowed. " +
            "Tell the subject to call their site directly, collect no clinical " +
            "information, and call complete_check_in with ended_early true.",
        },
        isError: true,
      };
    }

    session.verificationAttempts += 1;

    const subject = findSubject(subjectId, dob);
    if (!subject) {
      // Bind the key to the offered id even though verification failed.
      //
      // By this point the caller has spoken a date of birth aloud, and it is in
      // `subjectUtterances`, sealed with this session's key. `shredSubject` finds
      // keys by subject id — so an unbound session is one an erasure request can
      // never reach, and the most identifying sentence in the call sits there
      // permanently.
      //
      // The trade is real and it goes the other way: the id is *claimed*, not
      // verified, so a caller who misspoke their id files this session under
      // somebody else. The audit entry below records the id as offered rather
      // than confirmed, and the realistic case by far is a genuine participant
      // whose date of birth was misheard over a phone line. An erasure that
      // cannot reach a spoken date of birth is the worse failure.
      if (subjectId) {
        await getKeyStore().bindSubject(session.id, subjectId).catch(() => {
          /* an unbindable key must not stop the call from failing verification */
        });
      }
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

    // Withdrawal is checked here because here is the first moment the system
    // knows who is on the call. A session is opened before anyone identifies
    // themselves — createSession takes no subject — so there is no earlier
    // enforcement point, and refusing to *place* a call is not something this
    // system does anyway. What it can do is decline to collect.
    //
    // Nothing clinical has been asked at this point: verification is step 1 and
    // the open question is step 2. So the call ends having captured an identity
    // and nothing else, which is the correct record of a call that should not
    // have happened.
    const state = await getSubjectStore().get(subject.subjectId);
    if (isWithdrawn(state)) {
      // Bind the key even though verification is being refused. This session
      // still holds the subject's spoken ID and date of birth, sealed — and
      // shredSubject() finds keys by subject_id, so leaving it unbound would
      // make the participant most likely to ask for erasure the one whose data
      // the shredder silently skips.
      await getKeyStore().bindSubject(session.id, subject.subjectId);

      session.audit.record({
        actor: "system",
        action: "WITHDRAWN_SUBJECT_REFUSED",
        entity: "CheckInSession",
        entityId: session.id,
        after: {
          subjectId: subject.subjectId,
          withdrawnAt: state?.withdrawnAt,
          withdrawnBy: state?.withdrawnBy,
        },
        reason:
          "This participant has withdrawn from the study. The check-in was ended " +
          "before any clinical question was asked. Data collected before the " +
          "withdrawal is unaffected and is retained.",
      });
      return {
        result: {
          verified: false,
          withdrawn: true,
          instruction:
            "This participant has withdrawn from the study, so there is nothing " +
            "to collect. Say exactly: \"Thank you — I can see you've withdrawn " +
            "from the study, so there's nothing I need to ask you today. Your " +
            "study team will be in touch if anything is needed. Take care, " +
            "goodbye.\" Then call complete_check_in with ended_early true. Do not " +
            "ask a single clinical question, and do not try to talk them out of " +
            "anything.",
        },
        isError: true,
      };
    }

    // Who is on the line, decided before anything clinical is asked, because a
    // caregiver's account recorded as the participant's own words is a
    // data-integrity failure and a consent failure at once. The schema requires
    // the field on every real call; absent only when a test calls this directly.
    const respondent = input.respondent === "caregiver" ? "caregiver" : "self";
    if (respondent === "caregiver" && PROTOCOL.proxyReporting === "not_permitted") {
      // Bound for the same reason as the withdrawal path: the caregiver has
      // spoken the participant's date of birth, and an erasure request finds
      // sessions by subject id.
      await getKeyStore().bindSubject(session.id, subject.subjectId);
      session.audit.record({
        actor: "system",
        action: "PROXY_RESPONDENT_REFUSED",
        entity: "CheckInSession",
        entityId: session.id,
        after: { subjectId: subject.subjectId, respondent },
        reason:
          "A caregiver answered for the participant and this protocol does not " +
          "permit proxy reporting. Nothing clinical was collected.",
      });
      return {
        result: {
          verified: false,
          proxy_not_permitted: true,
          instruction:
            `Say exactly: "${FIXED_PROXY_NOT_PERMITTED}" If they then describe ` +
            "anything urgent about the participant, tell them to call " +
            `${emergencyPhrase(speakingRegion(subject.siteCountry, session.subjectUtterances, siteCountryForPrefix))} ` +
            "if it is an emergency. Then call complete_check_in with ended_early " +
            "true. Do not ask any clinical question.",
        },
        isError: true,
      };
    }

    session.subject = subject;
    session.respondent = respondent;
    // Never downgrade. The deterministic net escalates on the subject's first
    // utterance, which over a phone line is routinely the same breath as their
    // date of birth — so this runs with the record already escalated, and
    // assigning "in_progress" here quietly un-escalated it.
    if (session.status !== "escalated") session.status = "in_progress";
    session.audit.record({
      actor: "system",
      action: "SUBJECT_VERIFIED",
      entity: "CheckInSession",
      entityId: session.id,
      after: { subjectId: subject.subjectId, siteId: subject.siteId, respondent },
      reason:
        "Two-factor verification succeeded (subject ID + date of birth)." +
        (respondent === "caregiver" ? " Answered by a caregiver; proxy reporting is permitted." : ""),
    });

    const resumed = await resumeDroppedCall(session, subject.subjectId);

    return {
      result: {
        verified: true,
        ...(resumed ? { resumed } : {}),
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
        // The baseline sentence is appended, not swapped out. It used to be the
        // alternative branch of this ternary, so every resumed call lost it
        // while still being handed `baseline_conditions` — and a subject's
        // long-standing neuropathy came back as a newly reported adverse event
        // on the redial.
        instruction:
          "Verified. The baseline conditions listed above are already documented " +
          "— do not record them as new adverse events unless the subject reports " +
          "they have worsened. " +
          (resumed
            ? "An earlier call from this subject was interrupted; its record has " +
              "been carried forward and is listed under 'resumed'. Do NOT start " +
              "again. Acknowledge briefly that you spoke earlier, then continue " +
              "from where it stopped: skip anything already recorded and pick up " +
              "at the first unanswered item. Re-asking a sick person questions " +
              "they already answered is how a check-in gets abandoned."
            : "Proceed to step 2 and ask how they have been feeling."),
      },
    };
  },

  async record_safety_screen_item(session, input) {
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

    // Refused when the question was never spoken.
    //
    // The prompt tells the model to ask each item exactly as written and record
    // it afterwards, and nothing enforced that — so an answer could be recorded
    // for a question the participant never heard. That is data falsification,
    // and it is the exact failure the per-item design was built for after a
    // batch tool call invented answers for unasked questions.
    //
    // Deterministic and independent of model judgment: the runner records which
    // prompts the agent actually spoke, matched verbatim against the protocol.
    if (!session.screenAsked.includes(itemId)) {
      return {
        result: {
          error:
            `Screen item ${itemId} has not been asked yet. Say its question ` +
            "exactly as written, wait for the answer, and record it then. An " +
            "answer to a question the subject never heard is not a record.",
          // Applicability-filtered, like the success path. Without it this told
          // the model `pregnancy` was outstanding for participants it does not
          // apply to — the same false-incomplete failure screenItemsFor was
          // written to remove from the review queue.
          items_remaining: PROTOCOL.safetyScreen
            .filter(
              (i) =>
                (i.appliesTo !== "childbearing_potential" ||
                  session.subject?.childbearingPotential) &&
                !session.safetyScreen?.items.some((x) => x.itemId === i.id),
            )
            .map((i) => i.id),
        },
        isError: true,
      };
    }

    // The quote is screened; the ANSWER is not discarded with it. A red-flag
    // "yes" is the field with a reporting clock attached.
    const screenedVerbatim = await screenQuote(
      session,
      "verbatim",
      input.verbatim as string | null,
      `record_safety_screen_item:${itemId}`,
    );

    const answer =
      input.answer === null || input.answer === undefined
        ? null
        : Boolean(input.answer);

    const measurement =
      item.onPositive && typeof input.measurement === "string" && input.measurement.trim()
        ? input.measurement.trim()
        : null;

    const record = {
      itemId,
      answer,
      verbatim: screenedVerbatim,
      answeredAt: new Date().toISOString(),
      ...(item.onPositive ? { measurement } : {}),
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
    let delivery: Awaited<ReturnType<typeof deliverEscalation>> | null = null;
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
      raised = escalation.id;

      // Delivered before this returns, exactly as escalate_to_coordinator does.
      //
      // This did not happen, and it is the worst defect this system has had. The
      // escalation was pushed, the status was set, the audit entry was written,
      // and the tool told the model "the coordinator is already paged" — while
      // nothing was sent anywhere. No row in escalation_delivery means the retry
      // ladder, the backup contact, the non-acknowledgement alarm and the morning
      // digest were all structurally blind to it: every one of them is a query
      // over that table. And system-prompt.ts forbids the model from escalating a
      // screen item itself, "because that has already been done for you", so the
      // one remaining path was closed off too.
      //
      // The directed screen exists because the regex net measures 27% sensitivity.
      // It was the deterministic path, and it paged nobody.
      delivery = await raiseEscalation(session, escalation, {
        actor: "safety_net",
        auditReason:
          `Deterministic escalation from a positive directed screen item (${itemId}). ` +
          "Independent of model judgment.",
      });
    }

    const applicable = PROTOCOL.safetyScreen.filter(
      (i) =>
        i.appliesTo !== "childbearing_potential" ||
        session.subject?.childbearingPotential,
    );
    const answered = new Set(session.safetyScreen.items.map((i) => i.itemId));
    const remaining = applicable.filter((i) => !answered.has(i.id));

    // Only ever claimed when a delivery actually succeeded. The agent reads this
    // and says it out loud to a frightened person, so "the coordinator has been
    // paged" has to be a fact this tool observed rather than one it assumed.
    // Three states, not two. A red-flag item re-answered "yes" raises nothing,
    // because it was already positive — and reading that as "not delivered" told
    // an emergency-tier participant nobody had been alerted when somebody had.
    //
    // Checked, not assumed: the earlier page may itself have failed, and assuming
    // it succeeded is the same untruth in the other direction.
    let paged = delivery?.delivered === true;
    if (isRedFlag && !raised) {
      const prior = session.escalations.find((e) => e.category === item.label);
      if (prior) {
        const attempts = await getDeliveryStore().forSession(session.id);
        paged = attempts.some(
          (d) =>
            d.escalationId === prior.id &&
            (d.status === "sent" ||
              d.status === "acknowledged" ||
              d.status === "suppressed"),
        );
      }
    }
    const coordinator = session.subject.coordinatorName;
    // Same reasoning as escalate_to_coordinator: telling someone in Manchester to
    // call 911 costs them the seconds that matter most.
    const region = speakingRegion(
      session.subject?.siteCountry,
      session.subjectUtterances,
      siteCountryForPrefix,
    );

    // Items with their own positive path (fever) stop the call like any emergency,
    // but with a protocol-set instruction instead of "call 911", and with one
    // follow-up to capture the measurement. The page has already gone out above;
    // nothing here waits on the follow-up. A first "yes" asks it, unless the
    // subject already volunteered the value; the next record of the same item
    // closes the call whatever the answer, so "I didn't take it" ends it too.
    const ownPath = isRedFlag ? item.onPositive : undefined;
    const pagedLine = paged
      ? `${coordinator} has been paged.`
      : "The page did NOT go through. Do not say anyone has been alerted.";
    const ownPathInstruction = !ownPath
      ? null
      : !wasAlreadyPositive && measurement === null
        ? `${pagedLine} Stop the screen. Ask exactly: "${ownPath.followUpPrompt}" ` +
          "and stop generating. When they answer, call record_safety_screen_item " +
          `for ${itemId} again with answer true and measurement set to what they said, ` +
          "or null if they did not measure."
        : `${pagedLine} Say exactly: "${ownPath.closingInstruction}" ` +
          (paged ? `You may add, in one sentence, that ${coordinator} has been alerted. ` : "") +
          "Then call complete_check_in with ended_early true. Ask nothing further.";

    return {
      result: {
        recorded: true,
        item: item.label,
        escalation_raised: raised,
        // Reported for any red flag, not only a newly raised one. Keying this on
        // `raised` returned null when the item was answered yes a second time —
        // an escalation covering it exists and the model could not tell whether
        // anyone had been reached.
        delivered: isRedFlag ? paged : null,
        notified: paged ? coordinator : null,
        delivery_error: delivery?.detail ?? null,
        acknowledge_by: delivery?.delivery?.deadlineAt ?? null,
        items_remaining: remaining.map((i) => i.id),
        instruction:
          ownPathInstruction ??
          (isRedFlag && item.urgencyIfPositive === "emergency"
            ? paged
              ? `This is an emergency-tier answer and ${coordinator} has been paged. ` +
                "Stop the screen. Tell the subject in one sentence to call " +
                `${emergencyPhrase(region)} now and that their coordinator has been ` +
                "alerted, then call complete_check_in with ended_early true."
              : "This is an emergency-tier answer and the page did NOT go through. " +
                "Do not tell the subject their coordinator has been alerted — that " +
                `is not true. Stop the screen, tell them in one sentence to call ` +
                `${emergencyPhrase(region)} now and to call their study site directly ` +
                "afterwards, then call complete_check_in with ended_early true."
            : isRedFlag
              ? paged
                ? `Recorded and ${coordinator} has been paged — do not call ` +
                  "escalate_to_coordinator for this. Ask briefly what happened, record " +
                  "an adverse event if warranted, then carry on with the remaining screen items."
                : "Recorded, but the page did NOT go through. Do not say anyone has " +
                  "been notified. Tell the subject to call their study site directly " +
                  "today, then carry on with the remaining screen items."
              : remaining.length > 0
                ? `Recorded. Next unanswered screen item: ${remaining[0].id}. Ask it exactly as written.`
                : "Screen complete. Move to the solicited symptom review."),
      },
      // An escalation nobody received is an error condition, and the model should
      // see it as one rather than as a successful call.
      // An escalation nobody received is an error condition — including one
      // raised on an earlier turn whose page never landed.
      isError: isRedFlag && !paged,
    };
  },

  async record_adverse_event(session, input) {
    if (!session.subject) {
      return {
        result: { error: "Subject is not verified. Verify before recording anything." },
        isError: true,
      };
    }

    const verbatimTerm = await screenQuote(
      session,
      "verbatim_term",
      input.verbatim_term as string | null,
      "record_adverse_event",
    );

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
      // Null when the quote was refused. A coordinator sees an event with no
      // verbatim rather than an event with an invented one.
      verbatimTerm: verbatimTerm ?? "",
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

    // Deterministic, not advisory.
    //
    // SPEC §7.1 says "anything with a reporting clock attached is decided by a
    // deterministic control". Grade 3+ is one of the two things it names, and
    // until now the entire mechanism was the sentence below telling the model to
    // call escalate_to_coordinator. A grade 5 event recorded by a model that did
    // not then call it raised nothing at all.
    const delivery = needsEscalation
      ? await escalateForEvent(
          session,
          record,
          // Grade 4 is life-threatening and grade 5 is a death; neither waits for
          // an inbox. Grade 3 is severe and reportable but not immediately so.
          // Worth a clinician's eye — an engineer picked this split (7.10).
          grade >= 4 ? "emergency" : "urgent",
          `CTCAE grade ${grade} (${CTCAE_GRADES[grade].label}) recorded for ` +
            `"${record.codedTerm}". Deterministic, independent of model judgment.`,
          "Grade 3 or above",
        )
      : null;

    const paged = delivery?.delivered === true;

    return {
      result: {
        event_id: record.id,
        recorded: true,
        was_correction: Boolean(existing),
        grade_label: CTCAE_GRADES[grade].label,
        escalated: needsEscalation,
        delivered: needsEscalation ? paged : null,
        instruction: needsEscalation
          ? paged
            ? `Grade ${grade} meets the escalation threshold and the coordinator ` +
              "has already been paged for it — do not call escalate_to_coordinator " +
              "for this event. Call assess_seriousness for it now."
            : `Grade ${grade} meets the escalation threshold and the page did NOT ` +
              "go through. Do not tell the subject anyone has been notified. Call " +
              "assess_seriousness for this event, then tell them to contact their " +
              "study site directly today."
          : "Recorded. Continue the review. Do not tell the subject the grade — " +
            "grades are for the coordinator, not the subject.",
      },
      isError: needsEscalation && !paged,
    };
  },

  async assess_seriousness(session, input) {
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
      // The basis moves here because `after` is sealed and `reason` is not.
      // It is model-authored free text about why an event is serious, and it
      // quotes the participant readily — "admitted overnight after coughing up
      // blood". Written into `reason` it sat in plain text in the one table that
      // rejects UPDATE and DELETE, so destroying the subject's key left it
      // readable and unerasable. That is the opposite of what crypto-shredding
      // is for.
      after: { ...event.seriousness, basis: String(input.basis ?? "not stated") },
      reason:
        "Seriousness assessed against 21 CFR 312.32 criteria. The basis is in the " +
        "sealed value, not here.",
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

    // The other decision SPEC §7.1 names as having a clock, and the other one
    // that was an instruction string. An SAE starts a 24-hour reporting window
    // under ICH E2A and 21 CFR 312.32; a window that opens only when a model
    // remembers to call another tool is not a control.
    //
    // Death and life-threatening are the criteria that do not wait for an inbox.
    const immediate =
      determination.criteria.includes("death") ||
      determination.criteria.includes("life_threatening");
    const delivery = await escalateForEvent(
      session,
      event,
      immediate ? "emergency" : "urgent",
      `Serious adverse event determined for "${event.codedTerm}": ` +
        `${determination.criteria.map((c) => SAE_CRITERIA[c].label).join(", ")}. ` +
        `Sponsor notification due within ${determination.sponsorNotificationHours}h. ` +
        "Deterministic, independent of model judgment.",
      "Serious adverse event",
    );
    const paged = delivery.delivered;

    return {
      result: {
        event_id: eventId,
        is_serious: true,
        criteria_met: determination.criteria.map((c) => SAE_CRITERIA[c].label),
        sponsor_notification_deadline: deadline,
        sponsor_notification_hours: determination.sponsorNotificationHours,
        ind_safety_report_note: determination.indSafetyReportNote,
        escalated: true,
        delivered: paged,
        instruction: paged
          ? "This is a serious adverse event and the coordinator has already been " +
            "paged for it — do not call escalate_to_coordinator for this event. Do " +
            "not tell the subject the words 'serious adverse event'; say you are " +
            "getting their coordinator involved right away."
          : "This is a serious adverse event and the page did NOT go through. Do " +
            "not tell the subject anyone has been notified — tell them to contact " +
            "their study site directly today, and do not use the words 'serious " +
            "adverse event'.",
      },
      isError: !paged,
    };
  },

  async record_adherence(session, input) {
    // Every other clinical writer is gated on verification; these two were not,
    // which is how they became reachable on the same turn as the safety net and
    // ended up in the carry-forward's path.
    if (!session.subject) {
      return {
        result: {
          recorded: false,
          instruction:
            "Verify the subject with verify_subject before recording anything " +
            "clinical.",
        },
        isError: true,
      };
    }
    const missed = Number(input.doses_missed ?? 0);
    // doses_missed is structured data and survives a doubtful reason.
    const reason = await screenQuote(
      session,
      "reason_verbatim",
      input.reason_verbatim as string | null,
      "record_adherence",
    );
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
              "disappointment. Move to step 7."
            : "Recorded. Move to step 7.",
      },
    };
  },

  async record_concomitant_medication(session, input) {
    if (!session.subject) {
      return {
        result: {
          recorded: false,
          instruction:
            "Verify the subject with verify_subject before recording anything " +
            "clinical.",
        },
        isError: true,
      };
    }
    // The drug name and start date are what an interaction check needs; losing
    // them because the stated reason was loosely quoted has no clinical basis.
    const indication = await screenQuote(
      session,
      "indication_verbatim",
      input.indication_verbatim as string | null,
      "record_concomitant_medication",
    );

    const name = String(input.name ?? "");
    // Idempotent on the drug name: a redial or a retried turn must not put the
    // same medication in the record twice, which would read as two prescriptions.
    const existing = session.conMeds.find(
      (m) => naturalKey(m.name) === naturalKey(name),
    );

    const startedDescription = String(input.started_description ?? "");
    const record = {
      id: existing?.id ?? nextConMedId(session),
      // Keep the first call's values where the second is emptier or vaguer. A
      // subject repeating a medication on redial says less about it, not more,
      // and overwriting "since Tuesday" with "a while back" loses information
      // the record already had.
      name: existing?.name ?? name,
      indicationVerbatim: indication ?? existing?.indicationVerbatim ?? "",
      startedDescription:
        startedDescription.trim() !== ""
          ? startedDescription
          : (existing?.startedDescription ?? ""),
      // When the medication was first captured, not when it was last mentioned.
      // A subject re-reporting the same drug on a redial was moving this forward,
      // so the eCRF no longer showed when it entered the record.
      recordedAt: existing?.recordedAt ?? new Date().toISOString(),
    };

    if (existing) {
      const before = { ...existing };
      Object.assign(existing, record);
      session.audit.record({
        actor: "agent",
        action: "CONMED_UPDATED",
        entity: "ConcomitantMedication",
        entityId: record.id,
        before,
        after: { ...existing },
        reason:
          "Medication already on this record; updated rather than duplicated.",
      });
    } else {
      session.conMeds.push(record);
      session.audit.record({
        actor: "agent",
        action: "CONMED_RECORDED",
        entity: "ConcomitantMedication",
        entityId: record.id,
        after: record,
        reason: "New concomitant medication reported by subject.",
      });
    }

    return {
      result: {
        conmed_id: record.id,
        recorded: true,
        was_already_recorded: Boolean(existing),
        instruction: existing
          ? "Already on the record — updated rather than added again. Ask whether " +
            "there are any others, then move to step 8."
          : "Recorded. Ask whether there are any others, then move to step 8.",
      },
    };
  },

  async escalate_to_coordinator(session, input) {
    // Whatever this agent says out loud about emergency services has to be true
    // where the participant actually is. Site 002 is in the UK; telling someone
    // in Manchester to call 911 costs them the seconds that matter most.
    const region = speakingRegion(
      session.subject?.siteCountry,
      session.subjectUtterances,
      siteCountryForPrefix,
    );
    const urgency = String(input.urgency ?? "routine") as EscalationUrgency;
    const reasonText = String(input.reason ?? "");

    const relatedRaw = Array.isArray(input.related_event_ids)
      ? input.related_event_ids
      : [];
    const relatedIds = relatedRaw.map(String);

    // Idempotent on urgency, reason AND the events it concerns. A redial or a
    // retried turn must not show two pages for one event — a coordinator
    // counting escalations is counting things that happened to a person — but
    // two different events escalated with the same stock phrase are two events,
    // and collapsing them loses the second one's link entirely.
    const duplicate = session.escalations.find(
      (e) =>
        naturalKey(e.urgency, e.reason, [...e.relatedEventIds].sort().join(",")) ===
        naturalKey(urgency, reasonText, [...relatedIds].sort().join(",")),
    );
    if (duplicate) {
      // A duplicate escalation is not necessarily a delivered one. The first
      // attempt may have failed, the model may be retrying *because* it was told
      // the call errored — and returning "already raised" would strand a page
      // nobody received, with no retry anywhere in the system and no alarm,
      // because overdue() deliberately excludes failed rows.
      const priorAttempts = await getDeliveryStore().forSession(session.id);
      // "sent or acknowledged", not "not failed". A row can be stuck at `queued`
      // when the outage that broke the send also broke the update that would
      // have marked it failed — and markFailed deliberately swallows its own
      // error. Treating queued as delivered re-strands the exact page this
      // branch exists to rescue.
      const everDelivered = priorAttempts.some(
        (d) =>
          d.escalationId === duplicate.id &&
          (d.status === "sent" || d.status === "acknowledged"),
      );
      // Bounded. Without a cap the model sees isError, retries, blocks on another
      // send, and repeats — up to MAX_TOOL_ITERATIONS times at up to 15s each,
      // which is two minutes of silence on a live call. Past the cap the page is
      // still undelivered and still recorded as such; what stops is the retrying.
      const exhausted = priorAttempts.filter((d) => d.escalationId === duplicate.id).length;
      if (!everDelivered && exhausted >= MAX_DELIVERY_ATTEMPTS) {
        return {
          result: {
            escalation_id: duplicate.id,
            urgency: duplicate.urgency,
            already_raised: true,
            delivered: false,
            delivery_error: `delivery failed ${exhausted} times; not retrying`,
            instruction:
              duplicate.urgency === "emergency"
                ? "This page cannot be delivered. Tell the subject in one sentence " +
                  `to call ${emergencyPhrase(region)} now and their study site ` +
                  "directly, then call " +
                  "complete_check_in with ended_early true. Do not try again."
                : "This page cannot be delivered. Tell the subject to call their " +
                  "study site directly. Do not try again; continue the check-in " +
                  "if it is safe to do so.",
          },
        };
      }

      if (!everDelivered) {
        // Recorded before the attempt, like the suppression path it replaces. A
        // page that was requested a second time is a fact about the call whether
        // it was suppressed, retried, or retried and failed again.
        session.audit.record({
          actor: "system",
          action: "ESCALATION_DUPLICATE_REDELIVERED",
          entity: "Escalation",
          entityId: duplicate.id,
          after: { urgency, reason: reasonText, relatedEventIds: relatedIds },
          reason:
            "This escalation was already on the record but had never been " +
            "delivered, so the duplicate request was treated as a retry rather " +
            "than suppressed.",
        });
        const retry = await deliverEscalation(session, duplicate, { onCall: true });
        return {
          result: {
            escalation_id: duplicate.id,
            urgency: duplicate.urgency,
            already_raised: true,
            delivered: retry.delivered,
            delivery_error: retry.detail,
            instruction: retry.delivered
              ? "Already raised, and now delivered. Do not raise it again. " +
                (duplicate.urgency === "emergency"
                  ? "Tell the subject to seek emergency care now, then call " +
                    "complete_check_in with ended_early true."
                  : "Continue the check-in if it is safe to do so.")
              : // Still branches on urgency. An earlier fix made a duplicate
                // EMERGENCY end the call, and writing one instruction for both
                // outcomes quietly undid it — an emergency ends the call whether
                // or not the page went through, and a failed page is a stronger
                // reason to end it, not a weaker one.
                duplicate.urgency === "emergency"
                ? "Already raised, and it still has NOT been delivered. Do not " +
                  "tell the subject anyone has been notified. Tell them in one " +
                  `sentence to call ${emergencyPhrase(region)} now and their ` +
                  "study site directly, then " +
                  "call complete_check_in with ended_early true. Ask nothing further."
                : "Already raised, and it still has NOT been delivered. Do not " +
                  "tell the subject anyone has been notified. Tell them to call " +
                  "their study site directly, then continue the check-in if it " +
                  "is safe to do so.",
          },
          isError: !retry.delivered,
        };
      }

      // Audited, like the other two idempotency paths. A page that was requested
      // and not raised is otherwise invisible to anyone reconstructing the call.
      session.audit.record({
        actor: "system",
        action: "ESCALATION_SUPPRESSED_DUPLICATE",
        entity: "Escalation",
        entityId: duplicate.id,
        after: { urgency, reason: reasonText, relatedEventIds: relatedIds },
        reason:
          "An identical escalation was already raised on this record; a second " +
          "was not created.",
      });
      return {
        result: {
          escalation_id: duplicate.id,
          urgency: duplicate.urgency,
          already_raised: true,
          // Branches on urgency exactly as the fresh path does. Returning a bare
          // "continue" for a duplicate EMERGENCY told the agent to carry on with
          // a call the protocol says must end.
          instruction:
            duplicate.urgency === "emergency"
              ? "Already raised for this event. Tell the subject in one sentence " +
                "to seek emergency care now, then call complete_check_in with " +
                "ended_early true. Ask nothing further."
              : duplicate.urgency === "urgent"
                ? "Already raised for this event. Do not raise it again. Continue " +
                  "the check-in if it is safe to do so."
                : "Already flagged for routine review. Continue the check-in.",
        },
      };
    }
    const record = {
      id: nextEscalationId(session),
      urgency,
      reason: reasonText,
      relatedEventIds: relatedIds,
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

    // Delivered before this returns, so the next thing the agent says is true.
    // The system used to report `notified: coordinator` and have the agent tell
    // the participant their coordinator had been alerted, while nothing had been
    // sent anywhere — the one place it said something untrue to a sick person.
    const outcome = await deliverEscalation(session, record, { onCall: true });

    return {
      result: {
        escalation_id: record.id,
        urgency,
        delivered: outcome.delivered,
        notified: outcome.delivered ? coordinator : null,
        // Why it failed, in the tool result rather than only in the audit trail.
        // Audit values are sealed wholesale, so after a subject is shredded the
        // operational reason a page failed becomes unreadable along with the
        // clinical content — a coarseness worth knowing about. This detail is
        // about the mail transport, not the participant.
        delivery_error: outcome.detail,
        acknowledge_by: outcome.delivery?.deadlineAt ?? null,
        instruction: outcome.delivered
          ? urgency === "emergency"
            ? `${coordinator} has been paged. Tell the subject in one sentence to ` +
              "seek emergency care now and that their coordinator has been alerted. " +
              "Then call complete_check_in with ended_early true. Ask nothing further."
            : urgency === "urgent"
              ? `${coordinator} has been paged and will call today. Tell the subject ` +
                "a coordinator will reach out, then continue the check-in if it is " +
                "safe to do so."
              : "Flagged for routine review. Continue the check-in."
          : // Nothing reached anyone. Say what is true and hand the subject a
            // route that does not depend on this system working.
            urgency === "emergency"
            ? "The page did NOT go through. Do not tell the subject their " +
              "coordinator has been alerted — that is not true. Tell them in one " +
              `sentence to call ${emergencyPhrase(region)} now, and to call their ` +
              "study site directly " +
              "afterwards. Then call complete_check_in with ended_early true."
            : urgency === "urgent"
              ? "The page did NOT go through. Do not say a coordinator has been " +
                "notified. Tell the subject to call their study site directly " +
                "today, and give no reassurance that anyone already knows. Then " +
                "continue the check-in if it is safe to do so."
              : "Recorded, but the notification did not send. Do not tell the " +
                "subject anyone has been informed. Continue the check-in.",
      },
      // An escalation nobody received is an error condition, and the model
      // should see it as one rather than as a successful call.
      isError: !outcome.delivered,
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

export async function executeTool(
  session: CheckInSession,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  const handler = handlers[name];
  if (!handler) {
    return { result: { error: `Unknown tool: ${name}` }, isError: true };
  }
  try {
    return await handler(session, (input ?? {}) as Record<string, unknown>);
  } catch (err) {
    return {
      result: {
        error: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      isError: true,
    };
  }
}
