/**
 * Microphone echo detection.
 *
 * Without headphones, the recognizer hears the agent's own text-to-speech and
 * reports it as subject speech. In a clinical data-capture system that is not a
 * cosmetic glitch — an echoed sentence entering the eCRF is a fabricated patient
 * utterance.
 *
 * The Web Speech API gives no audio pipeline to attach acoustic echo
 * cancellation to, so this is a text heuristic and is tuned to under-reach:
 * letting an echo through is recoverable (it is visible in the transcript, and
 * the agent notices the conversation has gone strange), while discarding a real
 * answer is a silent data loss. Half-duplex mode is the actual fix; this is the
 * backstop for when barge-in is on.
 */

export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shortest run of words that may be judged an echo of a completed utterance. */
export const ECHO_MIN_WORDS = 4;

/**
 * For interim hypotheses, compared against the sentence playing right now.
 * Containment either way, because an interim is often a truncated prefix.
 */
export function looksLikeEcho(interim: string, currentlySpeaking: string): boolean {
  if (!currentlySpeaking) return false;
  const a = normalizeSpeech(interim);
  const b = normalizeSpeech(currentlySpeaking);
  if (!a) return true;
  return b.includes(a) || a.includes(b);
}

/**
 * For finalized transcripts, which arrive after playback has ended and so cannot
 * be compared against "what is playing now". Requires an exact run of at least
 * ECHO_MIN_WORDS inside what was recently spoken aloud. A looser similarity
 * threshold would catch more echo and also start eating real answers — a subject
 * replying "any nausea, yes" right after "have you had any nausea?" overlaps
 * heavily by word count but is genuine speech.
 */
export function isEchoOfRecentSpeech(final: string, recentlySpoken: string): boolean {
  if (!recentlySpoken) return false;
  const a = normalizeSpeech(final);
  if (a.split(" ").filter(Boolean).length < ECHO_MIN_WORDS) return false;
  return normalizeSpeech(recentlySpoken).includes(a);
}
