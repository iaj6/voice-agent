/**
 * How wrong a transcript is, and how wrong in the ways that matter.
 *
 * Word error rate is the standard number and it is not the number this system
 * cares about. A recogniser that turns "I've been feeling quite tired" into "I
 * have been feeling quite tired" scores badly and costs nothing; one that turns
 * "I coughed up blood" into "I coughed a bit" scores well and loses a
 * reportable event. So both are reported, and the second one is the one to read.
 *
 * Nothing here knows about a provider. It scores a transcript against a
 * reference, so the same harness measures whatever is behind the recogniser
 * interface — which is the point, given the provider is a decision that can
 * change.
 */

/** Words, lowercased, punctuation dropped. Contractions are expanded first. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    // "I've" and "I have" are the same clinical content and differ by a token.
    // Counting that as an error measures transcription style, not accuracy.
    .replace(/\bi'?ve\b/g, "i have")
    .replace(/\bcan'?t\b/g, "cannot")
    .replace(/\bwon'?t\b/g, "will not")
    .replace(/\bdon'?t\b/g, "do not")
    .replace(/\bdidn'?t\b/g, "did not")
    .replace(/\bit'?s\b/g, "it is")
    .replace(/\bi'?m\b/g, "i am")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface WerResult {
  /** Substitutions + deletions + insertions, over reference length. */
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
}

/** Levenshtein over words, with the edit types kept apart. */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = tokenise(reference);
  const hyp = tokenise(hypothesis);

  // rows = reference, columns = hypothesis. Each cell keeps the counts that
  // produced it, so the breakdown is exact rather than reconstructed.
  type Cell = { cost: number; s: number; d: number; i: number };
  const start: Cell = { cost: 0, s: 0, d: 0, i: 0 };
  let previous: Cell[] = [start];
  for (let j = 1; j <= hyp.length; j++) {
    previous.push({ cost: j, s: 0, d: 0, i: j });
  }

  for (let i = 1; i <= ref.length; i++) {
    const current: Cell[] = [{ cost: i, s: 0, d: i, i: 0 }];
    for (let j = 1; j <= hyp.length; j++) {
      const match = ref[i - 1] === hyp[j - 1];
      const diag = previous[j - 1];
      const up = previous[j];
      const left = current[j - 1];

      const options: Cell[] = [
        match
          ? { ...diag }
          : { cost: diag.cost + 1, s: diag.s + 1, d: diag.d, i: diag.i },
        { cost: up.cost + 1, s: up.s, d: up.d + 1, i: up.i },
        { cost: left.cost + 1, s: left.s, d: left.d, i: left.i + 1 },
      ];
      current.push(options.reduce((a, b) => (b.cost < a.cost ? b : a)));
    }
    previous = current;
  }

  const end = previous[hyp.length];
  return {
    wer: ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : end.cost / ref.length,
    substitutions: end.s,
    deletions: end.d,
    insertions: end.i,
    referenceWords: ref.length,
  };
}

export interface TermResult {
  term: string;
  /** Present in the reference, so it should have been transcribed. */
  expected: number;
  /** Present in the hypothesis. */
  heard: number;
}

/**
 * Whether the words that carry clinical meaning survived.
 *
 * The metric that decides whether a transcript is safe to record from. A missed
 * "blood" is a missed adverse event; a missed "quite" is nothing. Matching is on
 * word boundaries and is deliberately not fuzzy — "bloody" is not "blood" for
 * this purpose, and a recogniser that produces near-misses should score as
 * having missed.
 */
export function termRecall(
  reference: string,
  hypothesis: string,
  terms: readonly string[],
): { results: TermResult[]; recall: number } {
  const refWords = tokenise(reference);
  const hypWords = tokenise(hypothesis);
  const countIn = (words: string[], term: string) => {
    const parts = tokenise(term);
    if (parts.length === 0) return 0;
    let n = 0;
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (parts.every((p, k) => words[i + k] === p)) n += 1;
    }
    return n;
  };

  const results = terms
    .map((term) => ({
      term,
      expected: countIn(refWords, term),
      heard: countIn(hypWords, term),
    }))
    .filter((r) => r.expected > 0);

  const expected = results.reduce((n, r) => n + r.expected, 0);
  const heard = results.reduce((n, r) => n + Math.min(r.heard, r.expected), 0);
  return { results, recall: expected === 0 ? 1 : heard / expected };
}
