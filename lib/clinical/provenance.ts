import { assessContext, tokenize } from "./context.ts";

/**
 * Provenance: does a verbatim quote have any basis in what the subject said?
 *
 * Every other fabrication guard in this system protects the *channel* — stop
 * sequences at speaker labels, hold-back of partial stop sequences, a prompt
 * rule making ending the turn an explicit action. All three have failed at least
 * once, and the failure that matters put this in the record:
 *
 *   AE-001  Dizziness  G2  "the kitchen sort of went sideways on me"
 *
 * The subject never said it. This guards the *destination* instead: before a
 * verbatim quote reaches the eCRF it is checked against the actual subject
 * utterances of this call, and unfounded content is refused whatever produced
 * it. It does not need to know why the model went wrong.
 *
 * ## What it does not catch
 *
 * It detects *invention* — words with no counterpart in the transcript. It is
 * weaker against a quote that reuses the subject's own words to mean something
 * they did not say. The negation check below covers the common case (a quote
 * that drops a "no"), but a determined inversion using only spoken vocabulary
 * can still pass. The gate narrows the hole; it does not close it, and the
 * coordinator review in SPEC.md §7 remains the actual backstop.
 */

export interface ProvenanceVerdict {
  grounded: boolean;
  /** Best fraction of the quote's content words found in one source span, 0..1. */
  score: number;
  /** Content words present in the quote but nowhere in the best-matching span. */
  unsupported: string[];
  reason: string | null;
}

/**
 * Below this fraction of matched content words, a quote is treated as unfounded.
 *
 * Set from observed behaviour. A genuine capture — including a heavily trimmed
 * one — scores near 1.0 because the agent quotes words the subject used; the
 * fabricated Dizziness entry scored 0. The threshold sits in the middle of that
 * gap rather than at either edge.
 */
export const GROUNDING_THRESHOLD = 0.6;

/**
 * Quotes with fewer content words than this must match *completely*.
 *
 * A short quote cannot be scored meaningfully — one content word is either 0 or
 * 1 — but exempting it entirely left the hole this gate exists to close:
 * `verbatim_term` is by nature a short symptom phrase ("dizzy spells", "pins and
 * needles"), so a brief fabrication sailed through. Requiring every word instead
 * is strict but fair, because a short genuine quote is quoting exactly.
 */
export const SHORT_QUOTE_WORDS = 3;

/** Words that carry no evidential weight and would inflate any overlap score. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "so", "then", "than", "that",
  "this", "these", "those", "is", "are", "was", "were", "be", "been", "being",
  "am", "i", "im", "ive", "id", "me", "my", "mine", "myself", "you", "your",
  "he", "she", "it", "its", "we", "they", "them", "their", "of", "in", "on",
  "at", "to", "for", "with", "from", "by", "as", "have", "has", "had", "do",
  "does", "did", "just", "very", "really", "quite", "some", "yes", "yeah",
  "any", "all", "up", "down", "out", "about", "over", "under", "again", "more",
  "most", "much", "there", "here", "when", "where", "what", "which", "who",
  "will", "would", "can", "could", "should", "might", "may", "get", "got",
  "still", "like", "well", "s", "t", "d", "ll", "re", "ve", "m",
]);

/**
 * Markers that a statement is being denied.
 *
 * Deliberately NOT stopwords. A quote that drops the subject's "no" reverses
 * their meaning while reusing their vocabulary, which scores 1.0 on word overlap
 * alone — "I have had chest pain this week" against "No, I have not had any
 * chest pain this week".
 */
const NEGATION_MARKERS = new Set([
  "no", "not", "never", "none", "nothing", "neither", "nor",
  "cant", "cannot", "dont", "doesnt", "didnt", "wont", "wouldnt",
  "havent", "hasnt", "hadnt", "isnt", "arent", "wasnt", "werent",
]);

/**
 * Words where a substitution changes the clinical meaning entirely.
 *
 * Word-overlap scoring cannot see a single critical swap: "I felt chest pain on
 * Tuesday" scores 0.75 against "I felt pain in my knee on Tuesday", because only
 * one word differs and it is the only one that matters. These must be present in
 * the source exactly, whatever the overall score.
 *
 * Hand-written, and therefore carrying the same limitation as the safety net's
 * patterns: it covers the words one engineer thought of. The durable version is
 * the same MedDRA-sourced vocabulary that backlog item 3 describes — body sites
 * and critical symptom terms are exactly what those dictionaries enumerate.
 */
const SALIENT_TERMS = new Set([
  // body sites
  "chest", "heart", "head", "skull", "brain", "eye", "eyes", "vision", "ear",
  "throat", "tongue", "lip", "lips", "neck", "arm", "arms", "hand", "hands",
  "leg", "legs", "foot", "feet", "knee", "knees", "back", "stomach", "abdomen",
  "belly", "bowel", "bowels", "chest", "lung", "lungs", "skin", "mouth",
  // critical symptoms
  "blood", "bleeding", "bled", "fever", "seizure", "seizures", "faint",
  "fainted", "fainting", "stroke", "vomit", "vomiting", "breath", "breathing",
  "breathe", "pain", "rash", "swelling", "swollen", "numbness", "numb",
  "tingling", "dizzy", "dizziness", "unconscious", "pregnant", "pregnancy",
  "hospital", "ambulance", "emergency",
]);

/**
 * Candidate normal forms for a word.
 *
 * A set rather than a single stem, because one-directional stemming failed
 * symmetry: stripping "-es" turned "headaches" into "headach" while "headache"
 * stayed itself, so a word never matched its own plural. Two words match when
 * their candidate sets intersect.
 */
function variants(word: string): string[] {
  const out = new Set<string>([word]);
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      out.add(word.slice(0, -suffix.length));
    }
  }
  return [...out];
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function contentWords(text: string): string[] {
  return words(text).filter((w) => !STOPWORDS.has(w) && !NEGATION_MARKERS.has(w));
}

function negationCount(text: string): number {
  return words(text).filter((w) => NEGATION_MARKERS.has(w)).length;
}

/** Fraction of `quoted` whose variants appear among `source`'s variants. */
function overlap(quoted: string[], source: string[]): {
  score: number;
  unsupported: string[];
} {
  const pool = new Set(source.flatMap(variants));
  const unsupported = quoted.filter((w) => !variants(w).some((v) => pool.has(v)));
  const score =
    quoted.length === 0 ? 1 : (quoted.length - unsupported.length) / quoted.length;
  return { score, unsupported };
}

/**
 * Whether the quoted concepts sit inside a negation in their source.
 *
 * Reuses ConText rather than counting negation words across the whole utterance:
 * a blunt count refuses a genuine capture whenever the source sentence negates
 * something *else* — "I have no appetite and I've been vomiting blood" legitimately
 * yields the quote "I've been vomiting blood", and the clause-boundary handling in
 * ConText is exactly what tells those apart.
 */
function quoteDropsANegation(quote: string, source: string): boolean {
  if (negationCount(quote) > 0) return false; // the quote carries it too

  const quoted = new Set(contentWords(quote).flatMap(variants));
  const tokens = tokenize(source);

  let negated = 0;
  let found = 0;
  for (const token of tokens) {
    if (!variants(token.text).some((v) => quoted.has(v))) continue;
    found++;
    if (assessContext(source, token.start, token.end).assertion === "negated") {
      negated++;
    }
  }

  return found > 0 && negated / found > 0.5;
}

/**
 * A quote is scored against each utterance separately, never against the pool.
 *
 * Pooling the whole call let a quote be assembled from unrelated turns — "I felt
 * chest pain on Tuesday" scored 1.0 against three turns that between them held
 * every word and none of the meaning. Allowing adjacent pairs, to accommodate a
 * subject answering across two turns, reopened the same hole one turn narrower.
 *
 * So: one utterance. The cost is that a genuine quote spanning two turns loses
 * its verbatim, and that cost is now small — a refusal drops the quote alone and
 * the graded event, the answer, and the escalation all still stand. Strictness
 * here buys a real guarantee for a bounded price.
 */
function candidateSpans(utterances: readonly string[]): string[] {
  return [...utterances];
}

export function checkProvenance(
  verbatim: string,
  subjectUtterances: readonly string[],
): ProvenanceVerdict {
  // Checked first. Previously the short-quote exemption ran before this, so a
  // brief invention passed even when the subject had said nothing at all.
  if (subjectUtterances.length === 0) {
    return {
      grounded: false,
      score: 0,
      unsupported: contentWords(verbatim),
      reason:
        "The subject has not said anything yet, so this quote cannot have come " +
        "from them.",
    };
  }

  const quoted = contentWords(verbatim);
  if (quoted.length === 0) {
    // Nothing but stopwords — "yes", "none". No evidential content to check.
    return { grounded: true, score: 1, unsupported: [], reason: null };
  }

  const spans = candidateSpans(subjectUtterances);
  let best = { score: -1, unsupported: quoted, span: spans[0] };
  for (const span of spans) {
    const result = overlap(quoted, contentWords(span));
    if (result.score > best.score) {
      best = { score: result.score, unsupported: result.unsupported, span };
    }
  }

  const required =
    quoted.length < SHORT_QUOTE_WORDS ? 1 : GROUNDING_THRESHOLD;

  // A salient word the source does not contain is a substitution, not a
  // paraphrase, and no overall score redeems it.
  const sourceWords = new Set(contentWords(best.span).flatMap(variants));
  const swapped = quoted.filter(
    (w) =>
      SALIENT_TERMS.has(w) && !variants(w).some((v) => sourceWords.has(v)),
  );
  if (swapped.length > 0) {
    return {
      grounded: false,
      score: best.score,
      unsupported: swapped,
      reason:
        `This quote says "${swapped.join('", "')}", which the subject did not. ` +
        "Changing a body site or a symptom changes what was reported.",
    };
  }

  if (best.score < required) {
    return {
      grounded: false,
      score: best.score,
      unsupported: best.unsupported,
      reason:
        `Only ${Math.round(best.score * 100)}% of this quote appears in any single ` +
        `thing the subject said. Words with no counterpart: ` +
        `${best.unsupported.slice(0, 8).join(", ")}.`,
    };
  }

  if (quoteDropsANegation(verbatim, best.span)) {
    return {
      grounded: false,
      score: best.score,
      unsupported: [],
      reason:
        "The subject denied this. The quote uses their words but drops the " +
        "negation, which reverses what they said.",
    };
  }

  return { grounded: true, score: best.score, unsupported: best.unsupported, reason: null };
}
