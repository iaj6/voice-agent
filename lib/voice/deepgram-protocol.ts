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
  kind: "interim" | "final" | "ignore";
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
 */
export function parseMessage(raw: unknown): Parsed {
  const message = raw as DeepgramMessage;
  if (!message || message.type === "Metadata") return { kind: "ignore", heard: null };

  const alternative = message.channel?.alternatives?.[0];
  const text = (alternative?.transcript ?? "").trim();
  if (!text) return { kind: "ignore", heard: null };

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

  return { kind: message.speech_final ? "final" : "interim", heard };
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
 * Which clinical words were heard too poorly to record without confirming.
 *
 * Only clinical terms are checked. A misheard "Tuesday" is a nuisance; a
 * misheard "blood" is a missing adverse event, and asking the participant to
 * repeat every uncertain word would make the call unbearable.
 */
export function needsConfirmation(heard: Heard, terms: readonly string[]): string[] {
  const wanted = new Set(terms.map((t) => t.toLowerCase()));
  return heard.words
    .filter(
      (w) =>
        w.confidence !== null &&
        w.confidence < CONFIRM_BELOW_CONFIDENCE &&
        wanted.has(w.word.toLowerCase().replace(/[^a-z]/g, "")),
    )
    .map((w) => w.word);
}

/**
 * Tracks a stream so nothing said last is lost.
 *
 * Only `speech_final` produces a turn, which is right while a call is running
 * and wrong at the end of one. Driving the live socket with audio that stopped
 * abruptly produced three interim results and no final at all — the endpointer
 * never saw the silence it needed, so the last thing said simply never arrived.
 * On a check-in call that is the sentence a participant says before hanging up,
 * which is disproportionately the one that matters.
 *
 * So the last interim is held, and flushed as a final if the stream ends without
 * one. Held rather than emitted eagerly, because an interim is by definition a
 * hypothesis the recogniser has not committed to.
 */
export function createTranscriptStream() {
  let pending: Heard | null = null;

  return {
    /** Returns what to emit, if anything. */
    onMessage(raw: unknown): Parsed {
      const parsed = parseMessage(raw);
      if (parsed.kind === "interim") {
        pending = parsed.heard;
      } else if (parsed.kind === "final") {
        pending = null;
      }
      return parsed;
    },

    /** The utterance that would otherwise be lost, or null. */
    onClose(): Heard | null {
      const last = pending;
      pending = null;
      return last;
    },
  };
}
