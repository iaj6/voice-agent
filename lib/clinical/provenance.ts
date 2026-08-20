/**
 * Provenance: does a verbatim quote have any basis in what the subject said?
 *
 * Every other fabrication guard in this system protects the *channel* — stop
 * sequences at speaker labels, hold-back of partial stop sequences, a prompt
 * rule making ending the turn an explicit action. All three have failed at least
 * once, and the failure that matters produced this:
 *
 *   AE-001  Dizziness  G2  "the kitchen sort of went sideways on me"
 *
 * The subject never said it. The agent generated a patient reply for itself,
 * recorded an adverse event from its own invention, and the safety net escalated
 * on the fabrication. Nothing downstream questioned it, because nothing
 * downstream was looking.
 *
 * This guards the *destination*. Before a verbatim quote reaches the eCRF, it is
 * checked against the actual subject utterances of this call. A quote with no
 * basis in them is refused, whatever produced it — which is the point: it does
 * not need to know why the model went wrong.
 *
 * The check is deliberately permissive about *form* and strict about *substance*.
 * Agents legitimately trim and elide when quoting ("pretty wiped out this week,
 * couldn't get in the shower" from a longer sentence), and refusing those would
 * cost real data. It is unfounded content — words with no counterpart anywhere in
 * the transcript — that gets refused.
 */

export interface ProvenanceVerdict {
  grounded: boolean;
  /** Fraction of the quote's content words found in the transcript, 0..1. */
  score: number;
  /** Content words present in the quote but nowhere in the transcript. */
  unsupported: string[];
  reason: string | null;
}

/**
 * Below this fraction of matched content words, a quote is treated as unfounded.
 *
 * Set from observed behaviour rather than taste. A genuine capture — including a
 * heavily trimmed one — scores near 1.0, because the agent quotes words the
 * subject used. The fabricated Dizziness entry scored 0. The gap is wide, so the
 * threshold sits in the middle of it rather than at either edge: high enough to
 * catch invention, low enough that ordinary paraphrase survives.
 */
export const GROUNDING_THRESHOLD = 0.6;

/**
 * Quotes shorter than this are passed without judgement.
 *
 * "Yes", "None", "About eight" carry real clinical meaning and have too few
 * content words to score meaningfully — a one-word quote is either 0 or 1, and
 * both readings are noise. Short answers are also the ones a model has least to
 * gain from inventing.
 */
export const MIN_CONTENT_WORDS = 3;

/** Words that carry no evidential weight and would inflate any overlap score. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "so", "then", "than", "that",
  "this", "these", "those", "is", "are", "was", "were", "be", "been", "being",
  "am", "i", "im", "ive", "id", "me", "my", "mine", "myself", "you", "your",
  "he", "she", "it", "its", "we", "they", "them", "their", "of", "in", "on",
  "at", "to", "for", "with", "from", "by", "as", "have", "has", "had", "do",
  "does", "did", "not", "no", "yes", "just", "very", "really", "quite", "some",
  "any", "all", "up", "down", "out", "about", "over", "under", "again", "more",
  "most", "much", "there", "here", "when", "where", "what", "which", "who",
  "will", "would", "can", "could", "should", "might", "may", "get", "got",
  "been", "still", "like", "well", "s", "t", "d", "ll", "re", "ve", "m",
]);

/**
 * Crude suffix stripping so "showering" matches "shower" and "days" matches
 * "day". Not a real stemmer — a real one is a dependency and a vocabulary, and
 * this only needs to survive the difference between two spellings of one word.
 */
function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * Checks a quote against everything the subject actually said this call.
 *
 * Compares against the union of utterances rather than any single one: a subject
 * often answers across two turns ("I've been tired." / "Couldn't shower
 * Tuesday."), and a capture that draws on both is a good capture.
 */
export function checkProvenance(
  verbatim: string,
  subjectUtterances: readonly string[],
): ProvenanceVerdict {
  const quoted = contentWords(verbatim);

  if (quoted.length < MIN_CONTENT_WORDS) {
    return {
      grounded: true,
      score: 1,
      unsupported: [],
      reason: null,
    };
  }

  if (subjectUtterances.length === 0) {
    return {
      grounded: false,
      score: 0,
      unsupported: quoted,
      reason:
        "The subject has not said anything yet, so this quote cannot have come " +
        "from them.",
    };
  }

  const spoken = new Set(contentWords(subjectUtterances.join(" ")));
  const unsupported = quoted.filter((w) => !spoken.has(w));
  const score = (quoted.length - unsupported.length) / quoted.length;

  if (score >= GROUNDING_THRESHOLD) {
    return { grounded: true, score, unsupported, reason: null };
  }

  return {
    grounded: false,
    score,
    unsupported,
    reason:
      `Only ${Math.round(score * 100)}% of this quote appears in what the subject ` +
      `actually said. Words with no counterpart in the transcript: ` +
      `${unsupported.slice(0, 8).join(", ")}.`,
  };
}
