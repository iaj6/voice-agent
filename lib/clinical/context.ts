/**
 * ConText: assertion, experiencer, and temporality detection.
 *
 * Implements the algorithm from Harkema et al. (2009), which generalises NegEx
 * (Chapman et al. 2001). A trigger phrase opens a scope over neighbouring tokens;
 * a concept falling inside that scope inherits the trigger's property. Scopes end
 * at a termination term, a sentence boundary, or a token-count limit.
 *
 * This exists because a keyword net without it is close to useless on real
 * speech. Measured on the project corpus, the bare net fired on every one of
 * "no chest pain at all this week", "my husband had chest pain last year",
 * "I had chest pain years ago", and "call if I get chest pain" — four different
 * ways of saying the subject is fine right now.
 *
 * Everything here is deterministic and enumerable. That is the point: it is a
 * control you can specify, test, and report a confusion matrix for, sitting
 * underneath a model you cannot.
 */

export type Assertion = "asserted" | "negated";
export type Experiencer = "subject" | "other";
export type Temporality = "current" | "historical" | "hypothetical";

export interface TriggerHit {
  axis: "assertion" | "experiencer" | "temporality";
  value: string;
  phrase: string;
}

export interface ContextVerdict {
  assertion: Assertion;
  experiencer: Experiencer;
  temporality: Temporality;
  /** Every trigger that moved an axis off its default, for the audit record. */
  triggers: TriggerHit[];
}

/** How far a scope reaches, in tokens, absent a termination term. */
const SCOPE_WINDOW = 6;
/** Experiencer scope runs longer — "my husband ... had chest pain last Tuesday". */
const EXPERIENCER_WINDOW = 10;

type Direction = "forward" | "backward";

interface Trigger {
  axis: TriggerHit["axis"];
  value: string;
  direction: Direction;
  window: number;
  /** Token sequences, already lowercased and punctuation-free. */
  phrases: string[];
}

const TRIGGERS: Trigger[] = [
  {
    axis: "assertion",
    value: "negated",
    direction: "forward",
    window: SCOPE_WINDOW,
    phrases: [
      "no", "not", "none", "never", "nothing",
      "denies", "denied", "deny",
      "without", "free of", "negative for",
      "no sign of", "no signs of", "no evidence of", "no history of",
      "havent had", "hasnt had", "hadnt had", "havent",
      "dont have", "doesnt have", "didnt have", "dont", "doesnt", "didnt",
      "no more", "nothing like that", "not really", "not at all",
      "cant say i", "wouldnt say",
    ],
  },
  {
    axis: "assertion",
    value: "negated",
    direction: "backward",
    window: SCOPE_WINDOW,
    phrases: [
      "was ruled out", "ruled out", "has resolved", "went away",
      "at all this week", "either", "thankfully no", "none of that",
    ],
  },
  {
    axis: "experiencer",
    value: "other",
    direction: "forward",
    window: EXPERIENCER_WINDOW,
    phrases: [
      "my husband", "my wife", "my partner", "my spouse",
      "my daughter", "my son", "my mother", "my mom", "my father", "my dad",
      "my sister", "my brother", "my friend", "my neighbour", "my neighbor",
      "my caregiver", "my roommate", "my grandson", "my granddaughter",
      "the doctor", "the nurse", "my doctor", "my nurse",
      "the coordinator", "my coordinator", "somebody else", "someone else",
      "the man", "the woman", "a friend of mine",
    ],
  },
  {
    axis: "temporality",
    value: "historical",
    direction: "forward",
    window: SCOPE_WINDOW,
    phrases: [
      "history of", "used to", "in the past", "previously",
      "before the study", "before i started", "before joining",
      "when i was younger", "back when", "years back",
    ],
  },
  {
    axis: "temporality",
    value: "historical",
    direction: "backward",
    window: SCOPE_WINDOW,
    phrases: [
      "years ago", "months ago", "a year ago", "last year",
      "in the past", "before the study", "before i started",
      "a long time ago", "when i was younger", "back then",
      "but not since", "not since then",
    ],
  },
  {
    axis: "temporality",
    value: "hypothetical",
    direction: "forward",
    window: SCOPE_WINDOW + 2,
    phrases: [
      "if", "if i", "in case", "in case of", "should i",
      "were i to", "if it", "supposed to watch for", "watch for",
      "look out for", "told me to call if", "call if", "in the event",
      "what if", "as long as i dont", "unless i",
    ],
  },
];

/**
 * Ends any scope crossing it.
 *
 * Contrastive conjunctions were not enough. With only those, a trigger in one
 * clause swallowed a signal in the next and the net stood down on real
 * emergencies — "I have no appetite and I've been vomiting blood" was suppressed
 * as negated, producing no escalation at all. Coordinating conjunctions and
 * discourse markers open a new clause, and a new clause is a new assertion.
 */
const TERMINATORS = new Set([
  // contrastive
  "but", "however", "although", "though", "except", "aside", "besides",
  "still", "yet", "whereas", "otherwise", "instead",
  // coordinating and sequential — a new clause is a new assertion
  "and", "then", "so", "now", "also", "plus", "additionally",
  "actually", "anyway", "meanwhile", "afterwards", "because",
  ",",
]);

/**
 * Comma is a clause boundary too — "I don't know, I've been having chest pain"
 * kept the whole second clause inside the negation. Emitted as its own token so
 * scopes stop at it.
 *
 * "or" is deliberately NOT a terminator: it continues a list under the same
 * trigger, so "no fever or chills" stays negated throughout.
 */
const CLAUSE_BREAK = ",";

interface Token {
  text: string;
  start: number;
  end: number;
  /** Sentence index — scopes never cross a sentence boundary. */
  sentence: number;
}

/** Lowercases and strips punctuation while keeping offsets into the original. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let sentence = 0;
  const re = /[A-Za-z0-9']+|[.!?;,]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (/^[.!?;]$/.test(raw)) {
      sentence++;
      continue;
    }
    if (raw === CLAUSE_BREAK) {
      tokens.push({
        text: CLAUSE_BREAK,
        start: m.index,
        end: m.index + 1,
        sentence,
      });
      continue;
    }
    tokens.push({
      text: raw.toLowerCase().replace(/'/g, ""),
      start: m.index,
      end: m.index + raw.length,
      sentence,
    });
  }
  return tokens;
}

/** Token indices whose spans overlap [start, end). */
function tokensInSpan(tokens: Token[], start: number, end: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].end > start && tokens[i].start < end) idx.push(i);
  }
  return idx;
}

/** Matches a trigger's token sequence starting at i; returns its length or 0. */
function phraseLengthAt(tokens: Token[], i: number, phrase: string): number {
  const want = phrase.split(" ");
  if (i + want.length > tokens.length) return 0;
  for (let k = 0; k < want.length; k++) {
    if (tokens[i + k].text !== want[k]) return 0;
    if (tokens[i + k].sentence !== tokens[i].sentence) return 0;
  }
  return want.length;
}

interface Scope {
  trigger: Trigger;
  phrase: string;
  /** Scope the trigger opens over neighbouring tokens. */
  from: number;
  to: number;
  /** The trigger phrase's own tokens, [triggerFrom, triggerTo). */
  triggerFrom: number;
  triggerTo: number;
}

function findScopes(tokens: Token[]): Scope[] {
  const scopes: Scope[] = [];

  for (let i = 0; i < tokens.length; i++) {
    for (const trigger of TRIGGERS) {
      // Longest phrase first so "no evidence of" beats a bare "no".
      const ordered = [...trigger.phrases].sort(
        (a, b) => b.split(" ").length - a.split(" ").length,
      );
      for (const phrase of ordered) {
        const len = phraseLengthAt(tokens, i, phrase);
        if (!len) continue;

        const sentence = tokens[i].sentence;
        let from: number;
        let to: number;

        if (trigger.direction === "forward") {
          from = i + len;
          to = from;
          let budget = trigger.window;
          while (
            to < tokens.length &&
            budget > 0 &&
            tokens[to].sentence === sentence &&
            !TERMINATORS.has(tokens[to].text)
          ) {
            to++;
            budget--;
          }
        } else {
          to = i;
          from = i;
          let budget = trigger.window;
          while (
            from > 0 &&
            budget > 0 &&
            tokens[from - 1].sentence === sentence &&
            !TERMINATORS.has(tokens[from - 1].text)
          ) {
            from--;
            budget--;
          }
        }

        if (to > from) {
          scopes.push({
            trigger,
            phrase,
            from,
            to,
            triggerFrom: i,
            triggerTo: i + len,
          });
        }
        break; // one match per trigger per position
      }
    }
  }

  return scopes;
}

/**
 * Assesses a concept occupying [matchStart, matchEnd) in `text`.
 *
 * Defaults are the clinically safe ones: asserted, about the subject, happening
 * now. A trigger has to actively argue the concept away.
 */
export function assessContext(
  text: string,
  matchStart: number,
  matchEnd: number,
): ContextVerdict {
  const tokens = tokenize(text);
  const conceptIdx = tokensInSpan(tokens, matchStart, matchEnd);

  const verdict: ContextVerdict = {
    assertion: "asserted",
    experiencer: "subject",
    temporality: "current",
    triggers: [],
  };

  if (conceptIdx.length === 0) return verdict;

  const conceptSet = new Set(conceptIdx);

  for (const scope of findScopes(tokens)) {
    const overlaps = conceptIdx.some((i) => i >= scope.from && i < scope.to);
    if (!overlaps) continue;

    // A trigger sitting INSIDE the matched concept is not negating it — it is
    // part of it. Several safety rules are negation-bearing idioms: "I don't
    // want to live anymore", "I can't breathe", "bleeding that won't stop".
    // Without this guard, ConText double-negates exactly the rules that matter
    // most and silently disarms them.
    let triggerInsideConcept = false;
    for (let t = scope.triggerFrom; t < scope.triggerTo; t++) {
      if (conceptSet.has(t)) { triggerInsideConcept = true; break; }
    }
    if (triggerInsideConcept) continue;

    const { axis, value } = scope.trigger;
    if (axis === "assertion" && verdict.assertion === "asserted") {
      verdict.assertion = "negated";
      verdict.triggers.push({ axis, value, phrase: scope.phrase });
    } else if (axis === "experiencer" && verdict.experiencer === "subject") {
      verdict.experiencer = "other";
      verdict.triggers.push({ axis, value, phrase: scope.phrase });
    } else if (axis === "temporality" && verdict.temporality === "current") {
      verdict.temporality = value as Temporality;
      verdict.triggers.push({ axis, value, phrase: scope.phrase });
    }
  }

  return verdict;
}

/**
 * Whether a matched concept should still drive an escalation.
 *
 * Historical is deliberately NOT suppressed on its own for emergency-tier
 * findings elsewhere in the system — this returns the plain reading, and the
 * caller decides how much weight to give it.
 */
export function suppressionReason(verdict: ContextVerdict): string | null {
  if (verdict.assertion === "negated") {
    const t = verdict.triggers.find((x) => x.axis === "assertion");
    return `negated by "${t?.phrase ?? "negation"}"`;
  }
  if (verdict.experiencer === "other") {
    const t = verdict.triggers.find((x) => x.axis === "experiencer");
    return `reported about someone else ("${t?.phrase ?? "other"}")`;
  }
  if (verdict.temporality === "hypothetical") {
    const t = verdict.triggers.find((x) => x.axis === "temporality");
    return `hypothetical ("${t?.phrase ?? "if"}")`;
  }
  if (verdict.temporality === "historical") {
    const t = verdict.triggers.find((x) => x.axis === "temporality");
    return `historical ("${t?.phrase ?? "in the past"}")`;
  }
  return null;
}
