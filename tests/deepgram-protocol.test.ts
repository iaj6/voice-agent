/**
 * The recogniser protocol, tested against messages the live service actually
 * sent. The shapes below were captured by streaming synthesised speech through
 * wss://api.deepgram.com/v1/listen — not invented from documentation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRM_BELOW_CONFIDENCE,
  createTranscriptStream,
  needsConfirmation,
  parseMessage,
} from "../lib/voice/deepgram-protocol.ts";

const interim = {
  is_final: false,
  speech_final: false,
  channel: {
    alternatives: [
      {
        transcript: "I coughed up blood",
        words: [
          { word: "i", punctuated_word: "I", confidence: 0.99 },
          { word: "coughed", punctuated_word: "coughed", confidence: 0.98 },
          { word: "up", punctuated_word: "up", confidence: 0.99 },
          { word: "blood", punctuated_word: "blood", confidence: 0.94 },
        ],
      },
    ],
  },
};

const final = {
  is_final: true,
  speech_final: true,
  channel: {
    alternatives: [
      {
        transcript: "I coughed up blood last night and my chest is tight.",
        words: [
          { word: "i", punctuated_word: "I", confidence: 0.99 },
          { word: "blood", punctuated_word: "blood", confidence: 0.667 },
          { word: "chest", punctuated_word: "chest", confidence: 0.97 },
        ],
      },
    ],
  },
};

test("an interim is an interim, and a speech_final is a turn", () => {
  assert.equal(parseMessage(interim).kind, "interim");
  assert.equal(parseMessage(final).kind, "final");
});

test("is_final alone does not end a turn, but it does settle a segment", () => {
  // Three distinct states, and collapsing the middle one loses data. is_final
  // means this chunk will not be revised; speech_final means the person stopped
  // talking. Treating the first as a completed turn cuts people off mid-sentence
  // — but treating it as a mere interim discards it, because the next segment
  // does not repeat it.
  const chunk = { ...final, speech_final: false };
  assert.equal(parseMessage(chunk).kind, "segment");
});

test("per-word confidence survives, and the minimum is the one to act on", () => {
  const { heard } = parseMessage(final);
  assert.equal(heard?.words.length, 3);
  assert.equal(heard?.minConfidence, 0.667);
  assert.equal(heard?.words[1].word, "blood");
});

test("metadata and empty transcripts are ignored", () => {
  assert.equal(parseMessage({ type: "Metadata" }).kind, "ignore");
  assert.equal(parseMessage({ channel: { alternatives: [{ transcript: "   " }] } }).kind, "ignore");
  assert.equal(parseMessage(null).kind, "ignore");
});

// Captured from the live socket: twelve seconds of continuous speech, finalized
// in three non-overlapping segments, only the last one carrying speech_final.
const segment = (transcript: string, speechFinal: boolean, confidence = 0.95) => ({
  is_final: true,
  speech_final: speechFinal,
  channel: {
    alternatives: [
      {
        transcript,
        words: transcript
          .replace(/[.,]/g, "")
          .split(" ")
          .map((word) => ({ word: word.toLowerCase(), punctuated_word: word, confidence })),
      },
    ],
  },
});

const LONG_ANSWER = [
  "I coughed up blood on Tuesday morning and my chest has been tight ever since.",
  "And then on Wednesday I had a fever and the chills came on in the evening.",
  "And I have been so dizzy that I could not stand up in the shower yesterday.",
];

test("a long answer reaches the agent whole, not just its last sentence", () => {
  // The defect this replaces: each settled segment overwrote the one before it,
  // so the agent received only "And I have been so dizzy..." and the coughed-up
  // blood was discarded before the safety net could ever read it.
  const stream = createTranscriptStream();
  const emitted: string[] = [];
  for (const [i, text] of LONG_ANSWER.entries()) {
    const parsed = stream.onMessage(segment(text, i === LONG_ANSWER.length - 1));
    if (parsed.kind === "final") emitted.push(parsed.heard!.text);
  }
  assert.equal(emitted.length, 1, "one utterance, not three");
  assert.equal(emitted[0], LONG_ANSWER.join(" "));
});

test("the running transcript grows as segments settle, and never shrinks", () => {
  // The console shows interim text. If a settled segment reset it, the display
  // would appear to erase what the participant already said.
  const stream = createTranscriptStream();
  assert.equal(
    stream.onMessage(segment(LONG_ANSWER[0], false)).heard?.text,
    LONG_ANSWER[0],
  );
  assert.equal(
    stream.onMessage(segment(LONG_ANSWER[1], false)).heard?.text,
    `${LONG_ANSWER[0]} ${LONG_ANSWER[1]}`,
  );
});

test("confidence from an early segment survives into the joined turn", () => {
  // A symptom heard poorly in the first sentence still has to be confirmed after
  // the third, or the read-back asks about the wrong thing.
  const stream = createTranscriptStream();
  stream.onMessage(segment(LONG_ANSWER[0], false, 0.41));
  const turn = stream.onMessage(segment(LONG_ANSWER[2], true, 0.99));
  assert.equal(turn.heard?.minConfidence, 0.41);
  assert.deepEqual(needsConfirmation(turn.heard!, ["blood"]), ["blood"]);
});

test("an endpoint marker with no words still completes the turn", () => {
  // Measured on the live socket: after four seconds of silence Deepgram sent two
  // speech_final messages carrying no transcript at all. Ignoring them because
  // they are empty strands every settled segment behind them — the same shape of
  // loss as delivering only the last sentence.
  const stream = createTranscriptStream();
  stream.onMessage(segment(LONG_ANSWER[0], false));
  const turn = stream.onMessage(segment("", true));
  assert.equal(turn.kind, "final");
  assert.equal(turn.heard?.text, LONG_ANSWER[0]);
  assert.equal(stream.onClose(), null, "and it is not delivered a second time");
});

test("an endpoint marker with nothing behind it delivers nothing", () => {
  // The trailing markers during silence, once the turn has already gone out.
  const stream = createTranscriptStream();
  stream.onMessage(segment(LONG_ANSWER[0], true));
  assert.equal(stream.onMessage(segment("", true)).kind, "ignore");
  assert.equal(stream.onMessage(segment("", true)).kind, "ignore");
});

test("segments abandoned when the line drops are still flushed", () => {
  const stream = createTranscriptStream();
  stream.onMessage(segment(LONG_ANSWER[0], false));
  stream.onMessage(segment(LONG_ANSWER[1], false));
  assert.equal(stream.onClose()?.text, `${LONG_ANSWER[0]} ${LONG_ANSWER[1]}`);
});

test("a stream that ends without speech_final still yields its last utterance", () => {
  // Found by driving the live socket: audio that stops abruptly produces
  // interims and no final at all. On a call that is the sentence someone says
  // before hanging up.
  const stream = createTranscriptStream();
  stream.onMessage(interim);
  const flushed = stream.onClose();
  assert.equal(flushed?.text, "I coughed up blood");
});

test("a stream that ended properly has nothing left to flush", () => {
  const stream = createTranscriptStream();
  stream.onMessage(interim);
  stream.onMessage(final);
  assert.equal(stream.onClose(), null, "the last turn would be delivered twice");
});

const TERMS = ["blood", "chest", "fever"];
const PHRASES = ["chest pain", "passed out", "coughing up blood", "chest", "decreased appetite"];

test("a phrase heard poorly is flagged, not silently skipped", () => {
  // Most of the clinical list is phrases — "chest pain", "passed out", every
  // protocol label. Comparing one word at a time against that list matched none
  // of them, so an uncertain "passed out" was never read back.
  const heard = parseMessage({
    speech_final: true,
    channel: {
      alternatives: [
        {
          transcript: "I passed out and my chest pain got worse",
          words: [
            { word: "passed", confidence: 0.44 },
            { word: "out", confidence: 0.9 },
            { word: "chest", confidence: 0.98 },
            { word: "pain", confidence: 0.38 },
          ],
        },
      ],
    },
  }).heard!;
  assert.deepEqual(needsConfirmation(heard, PHRASES), ["passed out", "chest pain"]);
});

test("the longest matching term wins, so a phrase is not read back as one word", () => {
  const heard = parseMessage({
    speech_final: true,
    channel: {
      alternatives: [
        {
          transcript: "chest pain",
          words: [
            { word: "chest", confidence: 0.99 },
            { word: "pain", confidence: 0.3 },
          ],
        },
      ],
    },
  }).heard!;
  assert.deepEqual(needsConfirmation(heard, PHRASES), ["chest pain"]);
});

test("a clinical word the recogniser was unsure of is worth confirming", () => {
  const heard = parseMessage({
    speech_final: true,
    channel: {
      alternatives: [
        {
          transcript: "I coughed up blood",
          words: [
            { word: "coughed", confidence: 0.95 },
            { word: "blood", confidence: 0.41 },
          ],
        },
      ],
    },
  }).heard!;
  assert.deepEqual(needsConfirmation(heard, TERMS), ["blood"]);
});

test("the threshold sits below what clean speech actually produces", () => {
  // 0.667 was the lowest word confidence on a correctly transcribed clinical
  // utterance through the live socket. A threshold above that would ask a
  // participant to repeat words the recogniser got right.
  const clean = parseMessage(final).heard!;
  assert.equal(clean.minConfidence, 0.667);
  assert.ok(
    CONFIRM_BELOW_CONFIDENCE < 0.667,
    "the threshold would fire on a correctly heard word",
  );
  assert.deepEqual(needsConfirmation(clean, TERMS), []);
});

test("an uncertain non-clinical word is not worth interrupting for", () => {
  // Asking someone to repeat every uncertain word makes the call unbearable.
  const heard = parseMessage({
    speech_final: true,
    channel: {
      alternatives: [
        {
          transcript: "on Tuesday I felt fine",
          words: [
            { word: "tuesday", confidence: 0.2 },
            { word: "fine", confidence: 0.99 },
          ],
        },
      ],
    },
  }).heard!;
  assert.deepEqual(needsConfirmation(heard, TERMS), []);
});

test("a recogniser reporting no confidence asks for nothing", () => {
  const heard = parseMessage({
    speech_final: true,
    channel: { alternatives: [{ transcript: "I coughed up blood" }] },
  }).heard!;
  assert.equal(heard.minConfidence, null);
  assert.deepEqual(needsConfirmation(heard, TERMS), []);
});
