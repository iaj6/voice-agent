/**
 * Deepgram's streaming responses, turned into the shape the app already speaks.
 *
 * Separated from the socket and the microphone on purpose: this is the half that
 * can be tested. Point it at real responses from the live service and you learn
 * whether confidence survives the trip, without a browser, a microphone, or a
 * permission prompt.
 */

import type { Heard, HeardWord } from "./types.ts";

export interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  confidence: number;
}

export interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; words?: DeepgramWord[] }[] };
}

export interface Parsed {
  /**
   * `segment` is a finalized piece of an utterance the person is still speaking.
   * `final` is the whole utterance, ready for the agent.
   */
  kind: "interim" | "segment" | "final" | "ignore";
  heard: Heard | null;
}

/**
 * Reads one message off the socket.
 *
 * `is_final` and `speech_final` are different questions and the difference
 * matters. `is_final` means this chunk of transcript will not be revised;
 * `speech_final` means the endpointer thinks the person stopped talking. Only
 * the second one should send an utterance to the agent — treating every
 * `is_final` as a completed turn cuts people off mid-sentence, which on a
 * check-in call means capturing half a symptom.
 *
 * The three states are distinct, and collapsing the middle one into `interim`
 * loses data. See `createTranscriptStream` for why.
 */
export function parseMessage(raw: unknown): Parsed {
  const message = raw as DeepgramMessage;
  if (!message || message.type === "Metadata") return { kind: "ignore", heard: null };

  const alternative = message.channel?.alternatives?.[0];
  const text = (alternative?.transcript ?? "").trim();
  if (!text) {
    // An endpoint marker carrying no words. Deepgram emits these — measured, two
    // of them after a four-second silence — and one still means the person
    // stopped talking, which is the signal that completes whatever came before
    // it. Discarding it because it has no text of its own strands the sentences
    // that do.
    return message.speech_final
      ? { kind: "final", heard: null }
      : { kind: "ignore", heard: null };
  }

  const words: HeardWord[] = (alternative?.words ?? []).map((w) => ({
    word: w.punctuated_word ?? w.word,
    confidence: typeof w.confidence === "number" ? w.confidence : null,
  }));

  const scored = words.map((w) => w.confidence).filter((c): c is number => c !== null);
  const heard: Heard = {
    text,
    words: words.length
      ? words
      : text.split(/\s+/).map((word) => ({ word, confidence: null })),
    minConfidence: scored.length ? Math.min(...scored) : null,
  };

  const kind: Parsed["kind"] = message.speech_final
    ? "final"
    : message.is_final
      ? "segment"
      : "interim";
  return { kind, heard };
}

/**
 * Several finalized segments read back as the one thing the person said.
 *
 * Confidence is carried per word, so the minimum survives the join — a symptom
 * heard poorly in the first sentence still asks to be confirmed after the third.
 */
export function joinHeard(parts: readonly Heard[]): Heard {
  const words = parts.flatMap((p) => p.words);
  const scored = words.map((w) => w.confidence).filter((c): c is number => c !== null);
  return {
    text: parts
      .map((p) => p.text)
      .filter(Boolean)
      .join(" "),
    words,
    minConfidence: scored.length ? Math.min(...scored) : null,
  };
}

/**
 * How sure the recogniser has to be before a symptom is recorded without asking.
 *
 * Derived from one measurement, and that limitation is the important part. On
 * synthesised speech through the live socket, the lowest word confidence on a
 * correctly transcribed clinical utterance was 0.667 — so 0.6 sits just under
 * what clean audio produces and will rarely fire. Real participants are elderly,
 * tired, on medication and on a phone; their confidences will be lower and more
 * spread out, and this number should be re-derived from recordings of them
 * rather than inherited from a synthesiser.
 *
 * Re-derive with scripts/measure-stt.mjs whenever the model or the audio path
 * changes. A threshold carried over from a different recogniser is a number with
 * no evidence behind it.
 */
export const CONFIRM_BELOW_CONFIDENCE = 0.6;

/**
 * Which clinical terms were heard too poorly to record without confirming.
 *
 * Only clinical terms are checked. A misheard "Tuesday" is a nuisance; a
 * misheard "blood" is a missing adverse event, and asking the participant to
 * repeat every uncertain word would make the call unbearable.
 *
 * Matched over word n-grams, because most of the list is phrases — "chest pain",
 * "passed out", "coughing up blood", and every protocol label from "Decreased
 * appetite" to "Peripheral sensory neuropathy". Comparing one word at a time
 * against that list matches none of them, so a badly heard "passed out" would
 * pass silently. The longest term wins where two overlap, so an uncertain "chest
 * pain" is read back as the phrase rather than as a bare "chest".
 */
export function needsConfirmation(heard: Heard, terms: readonly string[]): string[] {
  const norm = (word: string) => word.toLowerCase().replace(/[^a-z]/g, "");
  const tokens = heard.words.map((w) => norm(w.word));

  // Longest first, so "chest pain" claims its words before "chest" can.
  const byLength = [...terms].sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
  const claimed = new Set<number>();
  const found: { at: number; phrase: string }[] = [];

  for (const term of byLength) {
    const parts = term.split(/\s+/).map(norm).filter(Boolean);
    if (!parts.length) continue;
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      if (!parts.every((part, k) => tokens[i + k] === part)) continue;
      const span = [...Array(parts.length).keys()].map((k) => i + k);
      if (span.some((k) => claimed.has(k))) continue;

      const window = span.map((k) => heard.words[k]);
      const unsure = window.some(
        (w) => w.confidence !== null && w.confidence < CONFIRM_BELOW_CONFIDENCE,
      );
      // Claimed either way: a term heard confidently still owns its words, so a
      // shorter term inside it cannot re-flag them.
      span.forEach((k) => claimed.add(k));
      if (unsure) found.push({ at: i, phrase: window.map((w) => w.word).join(" ") });
    }
  }

  // In the order they were spoken, which is the order they would be read back.
  return found.sort((a, b) => a.at - b.at).map((f) => f.phrase);
}

/**
 * Reassembles an utterance from the pieces the recogniser finalizes it in.
 *
 * A long answer does not arrive whole. Deepgram finalizes it in segments as the
 * person keeps talking, and each `is_final` segment is *non-overlapping* — once
 * a segment is settled, later messages start fresh and never repeat it. Only the
 * last segment carries `speech_final`. So the message that says "the person
 * stopped talking" contains only the tail of what they said.
 *
 * Measured, not assumed. Twelve seconds of speech through the live socket:
 *
 *   is_final speech_final=false  "I coughed up blood on Tuesday morning and my
 *                                 chest has been tight ever since."
 *   is_final speech_final=false  "And then on Wednesday I had a fever and the
 *                                 chills came on in the evening."
 *   is_final speech_final=true   "And I have been so dizzy that I could not
 *                                 stand up in the shower yesterday."
 *
 * Delivering only the `speech_final` message loses the first two sentences —
 * including the coughed-up blood, which is exactly what the deterministic safety
 * net exists to catch. It never reaches the net, because the net can only read
 * what the transcript hands it. Unhurried, multi-symptom answers are what this
 * study's participants give, so this is the common case and not the edge one.
 *
 * So settled segments accumulate, and the turn the agent receives is all of them
 * joined. Interims are emitted against the accumulated text too, or the console
 * would appear to erase what the participant already said every few seconds.
 *
 * The tail is still held separately: an interim is a hypothesis the recogniser
 * has not committed to, and it is flushed only if the stream ends without a
 * final. Driving the live socket with audio that stopped abruptly produced three
 * segments and no final at all — the endpointer never saw the silence it needed.
 * On a check-in call that is the sentence a participant says before hanging up,
 * which is disproportionately the one that matters.
 */
export function createTranscriptStream() {
  /** Finalized pieces of the utterance in progress. */
  let settled: Heard[] = [];
  /** The unfinalized tail, which the recogniser may still revise. */
  let pending: Heard | null = null;

  return {
    /** Returns what to emit, if anything. */
    onMessage(raw: unknown): Parsed {
      const parsed = parseMessage(raw);
      if (parsed.kind === "ignore") return { kind: "ignore", heard: null };

      if (parsed.kind === "final") {
        // `heard` is null when the endpoint marker carried no words of its own.
        // It still ends the turn — everything settled before it is the turn.
        const parts = [
          ...settled,
          ...(parsed.heard ? [parsed.heard] : pending ? [pending] : []),
        ];
        settled = [];
        pending = null;
        if (!parts.length) return { kind: "ignore", heard: null };
        return { kind: "final", heard: joinHeard(parts) };
      }

      if (!parsed.heard) return { kind: "ignore", heard: null };

      if (parsed.kind === "segment") {
        // Settled, but the person is still talking. Anything the recogniser had
        // provisionally heard is now superseded by this.
        settled.push(parsed.heard);
        pending = null;
      } else {
        pending = parsed.heard;
      }
      return {
        kind: "interim",
        heard: joinHeard([...settled, ...(pending ? [pending] : [])]),
      };
    },

    /** The utterance that would otherwise be lost, or null. */
    onClose(): Heard | null {
      const parts = [...settled, ...(pending ? [pending] : [])];
      settled = [];
      pending = null;
      return parts.length ? joinHeard(parts) : null;
    },
  };
}
