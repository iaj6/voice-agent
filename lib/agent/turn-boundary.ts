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

/** Role labels the model reaches for when it starts speaking as someone else. */
const ROLE_LABEL =
  /\n[ \t]*(?:user|assistant|subject|patient|human|speaker|caller|participant|agent|you|me)\b/i;

/** A blank line: the model changing speaker. */
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * Index at which `text` stops being the agent's own turn, or -1.
 *
 * The index is where the *cut* goes — text before it is genuine and safe to
 * speak, text from it onward is discarded.
 */
export function findTurnBoundary(text: string): number {
  const blank = text.search(BLANK_LINE);
  const label = text.search(ROLE_LABEL);
  if (blank === -1) return label;
  if (label === -1) return blank;
  return Math.min(blank, label);
}

/**
 * How many trailing characters cannot be released yet, because they might be
 * the opening of a boundary that has not finished arriving.
 *
 * A trailing "\n" could become "\n\n"; a trailing "\nus" could become "\nuser".
 * Releasing either the moment it arrives would speak the first half of a
 * boundary and then discard the second, which is the exact shape of the "use"
 * fragments above reaching the loudspeaker.
 */
const MAX_HOLD = 16;

export function pendingBoundaryPrefixLength(text: string): number {
  // A newline, optional indentation, and at most one partial word after it.
  const match = /\n[ \t]*[A-Za-z]*$/.exec(text);
  if (!match) return 0;
  // Past this length it is prose on a new line, not a label being typed.
  return match[0].length <= MAX_HOLD ? match[0].length : 0;
}
