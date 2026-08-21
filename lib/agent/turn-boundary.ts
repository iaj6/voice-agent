/**
 * Where a spoken turn stops and the model's invention of the subject begins.
 *
 * The agent asks a question and then, instead of stopping, writes the answer it
 * expects and carries on — its reply, another question, another answer. Nothing
 * the subject "said" in that stretch passed through the deterministic safety
 * net, because the subject never said it. Observed reaching the record: an
 * adverse event graded from words no participant spoke.
 *
 * `stop_sequences` were the first defence and are not sufficient. They match
 * exact strings, and the model produces near misses. Four captured from one
 * six-round eval:
 *
 *     "...since we last spoke?\n\nuseleven Pretty rough, honestly."
 *     "...since we last spoke?\n\nuseparse_ai_response\nPretty rough,"
 *     "...since we last spoke?\n\nuseKind of a mixed bag."
 *     "...happened again since Saturday night?\n\nusen0, just that once"
 *
 * None of them is "\nuser", so none of them stopped anything. Earlier rounds
 * produced "usual", "useh", "useful" and "useard" — the same failure wearing a
 * different spelling each time, which is what makes an exact-match list the
 * wrong shape of control for it.
 *
 * What every instance does share is structure: a blank line, then a new speaker.
 * That is the boundary this looks for. The agent has no legitimate reason to
 * emit one — it is instructed to speak one or two sentences with no lists, no
 * headings and no markdown, and everything it produces is read aloud, where a
 * blank line means nothing. Cutting there costs a real turn nothing and takes
 * the whole family of near misses at once.
 */

/**
 * Role labels the model reaches for when it starts speaking as someone else.
 *
 * Transcript conventions only. An earlier version also listed "you", "me" and
 * "agent", which are ordinary English words: "Thank you.\nYou mentioned
 * dizziness earlier" was cut mid-turn and its tool calls dropped. A label list
 * has to contain things nobody says by accident.
 */
const ROLE_LABEL =
  /\n[ \t]*(?:user|assistant|subject|patient|human|speaker|caller|participant)\b/i;

/**
 * A blank line with something after it: the model changing speaker.
 *
 * The trailing content is required. Matching a bare "\n\n" meant a turn that
 * simply ended with a blank line before its tool calls — "Let me note that
 * down.\n\n" then record_adverse_event — was read as a fabrication, so the
 * adverse event was silently dropped and the audit trail recorded an invention
 * that never happened. A guard against losing the record must not lose it.
 */
const BLANK_LINE = /\n[ \t]*\n[ \t]*(?=\S)/;

/**
 * A new line that resumes in lower case.
 *
 * The near misses do not always use a blank line: "...last spoke?\nuseKind of a
 * mixed bag" has one newline and no label, so neither rule above sees it. What
 * it does have is a line beginning in lower case, which genuine speech does not
 * — the agent's turns are sentences, and sentences start capitalised.
 *
 * The trade is deliberate. If the model ever hard-wraps a sentence, this cuts it
 * mid-question: the agent asks half a question, the turn ends, and the subject
 * asks it to repeat. That is recoverable and it is audited. Letting the other
 * case through puts words the subject never said into a regulated record.
 */
const LOWERCASE_RESUME = /\n[ \t]*(?=[a-z])/;

/**
 * Index at which `text` stops being the agent's own turn, or -1.
 *
 * The index is where the *cut* goes — text before it is genuine and safe to
 * speak, text from it onward is discarded.
 */
export function findTurnBoundary(text: string): number {
  const found = [BLANK_LINE, ROLE_LABEL, LOWERCASE_RESUME]
    .map((re) => text.search(re))
    .filter((i) => i !== -1);
  return found.length === 0 ? -1 : Math.min(...found);
}

/**
 * How many trailing characters cannot be released yet, because they might be
 * the opening of a boundary that has not finished arriving.
 *
 * Only the newline and any indentation after it. Once one more character lands,
 * the rules above can decide, so there is nothing to gain by holding further —
 * and holding a partial word is what put "use" on the loudspeaker.
 */
export function pendingBoundaryPrefixLength(text: string): number {
  const match = /\n[ \t]*$/.exec(text);
  return match ? match[0].length : 0;
}
