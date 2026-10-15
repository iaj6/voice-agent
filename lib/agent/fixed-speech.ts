import { PROTOCOL } from "../clinical/protocol.ts";

/**
 * Utterances the agent must deliver word for word.
 *
 * This exists for validity before it exists for performance. A solicited symptom
 * question is an instrument item: its wording is what was reviewed and what every
 * subject is supposed to be answering. "How has your energy been since we last
 * spoke?" and "How have you been feeling energy-wise?" are not interchangeable —
 * they can elicit different answers, and if the agent improvises a new phrasing on
 * every call then no two subjects answered the same question. Free-form delivery
 * of a fixed instrument item is a data quality defect.
 *
 * Pinning the wording has a second effect: because the sentence chunker emits
 * complete sentences, a verbatim question is a cache hit on every call after the
 * first. Latency and cost fall out of doing the clinically correct thing.
 */

export const FIXED_GREETING =
  `Hello, this is the automated check-in assistant for the ${PROTOCOL.protocolId} study. Could you tell me your subject ID?`;

export const FIXED_DOB_PROMPT = "Thank you. And what is your date of birth?";

export const FIXED_RESPONDENT_PROMPT =
  "And am I speaking with the study participant, or with someone answering for them?";

export const FIXED_PROXY_NOT_PERMITTED =
  "Thank you for calling. This check-in has to be answered by the participant themselves, so I can't take it today. Please ask them to call back, or call the study site directly.";

export const FIXED_OPEN_QUESTION =
  "How have you been feeling since we last spoke?";

export const FIXED_ANYTHING_ELSE =
  "Has anything else come up since we last spoke, anything new or anything that worried you?";

export const FIXED_ADHERENCE =
  "How many days, if any, did you miss your study tablet since we last spoke?";

export const FIXED_CONMEDS =
  "Have you started any new medication since we last spoke, including anything over the counter?";

export const FIXED_FUNCTIONAL_PROBE =
  "Has it kept you from doing anything you would normally do?";

export const FIXED_SELF_CARE_PROBE =
  "Has it made it harder to do things like bathing, dressing, or feeding yourself?";

export const FIXED_READ_BACK_CONFIRM = "Is anything there wrong or missing?";

export const FIXED_VERIFICATION_FAILED =
  "I'm sorry, those details did not match our records. Could we try once more?";

export const FIXED_VERIFICATION_EXHAUSTED =
  "I'm sorry, I still could not match those details, so I cannot continue with the check-in. Please call your study site directly and they can help you.";

/** Every line above plus the protocol's solicited symptom prompts. */
export const FIXED_LINES: string[] = [
  FIXED_GREETING,
  FIXED_DOB_PROMPT,
  FIXED_RESPONDENT_PROMPT,
  FIXED_OPEN_QUESTION,
  ...PROTOCOL.safetyScreen.map((s) => s.prompt),
  ...PROTOCOL.safetyScreen.flatMap((s) => (s.onPositive ? [s.onPositive.followUpPrompt] : [])),
  ...PROTOCOL.solicitedSymptoms.map((s) => s.prompt),
  FIXED_ANYTHING_ELSE,
  FIXED_ADHERENCE,
  FIXED_CONMEDS,
  FIXED_FUNCTIONAL_PROBE,
  FIXED_SELF_CARE_PROBE,
  FIXED_READ_BACK_CONFIRM,
  FIXED_VERIFICATION_FAILED,
  FIXED_VERIFICATION_EXHAUSTED,
];
