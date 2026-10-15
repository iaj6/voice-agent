/**
 * The only text a "system" turn may carry. The safety net scans subject speech
 * only, so letting the client both choose the source and supply the words would
 * let any caller route arbitrary text past it. The client may ask for the
 * call-start turn; the server decides what that turn says.
 */
export const CALL_START_TURN = "(The call has connected. The subject has not spoken yet.)";

export type TurnInput = { utterance: string; source: "subject" | "system" };

/**
 * What the runner actually receives for a turn the client sent. A system turn is
 * only ever the opening of the call, with fixed wording; anything else the client
 * labels "system" is refused rather than trusted.
 */
export function resolveTurn(
  requested: { utterance: string; source?: string },
  priorMessages: number,
): TurnInput | { error: string } {
  if (requested.source !== "system") {
    return { utterance: requested.utterance.trim(), source: "subject" };
  }
  if (priorMessages > 0) return { error: "Only the opening turn may come from the system." };
  return { utterance: CALL_START_TURN, source: "system" };
}
