/**
 * The words a transcript has to get right.
 *
 * Not a vocabulary of everything clinical — a list of the words whose loss
 * changes what gets recorded. "Blood" is here and "discomfort" is not, because a
 * transcript that drops the first loses a reportable event and one that drops
 * the second loses an adjective.
 *
 * Drawn from what the protocol actually asks about — the solicited symptom terms
 * and the directed screen — plus the vocabulary of the topics the safety net
 * covers. Deliberately in the words participants use, not the coded terms: the
 * recogniser hears "throwing up", never "emesis".
 */

import { PROTOCOL } from "../clinical/protocol.ts";

/** Words whose loss changes the record, in the register they are spoken in. */
const HIGH_STAKES = [
  // Cardiac and respiratory
  "chest", "chest pain", "breathe", "breathing", "breath", "winded", "wheezing",
  // Bleeding
  "blood", "bleeding", "bled", "coughing up blood",
  // Neurological
  "numb", "numbness", "weakness", "slurred", "seizure", "fit", "stroke",
  "fainted", "faint", "passed out", "blacked out", "dizzy",
  // Infection
  "fever", "temperature", "chills", "shivery", "infection",
  // Skin and allergy
  "rash", "blister", "blistering", "peeling", "swelling", "swollen", "hives",
  // Care events
  "hospital", "ambulance", "emergency", "admitted",
  // Reproductive
  "pregnant", "pregnancy", "period",
  // Treatment intent
  "stopped", "stopping", "quit", "withdraw",
] as const;

/**
 * The full set, protocol terms included.
 *
 * Built at module load from the protocol rather than copied, so a solicited
 * symptom added to the study is a term the recogniser is measured on without
 * anyone remembering to update a list.
 */
export function clinicalTerms(): string[] {
  const fromProtocol = [
    ...PROTOCOL.solicitedSymptoms.map((s) => s.term.toLowerCase()),
    ...PROTOCOL.safetyScreen.map((i) => i.label.toLowerCase()),
  ];
  return [...new Set([...HIGH_STAKES, ...fromProtocol])].sort();
}
