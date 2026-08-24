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

test("is_final alone does not end a turn", () => {
  // is_final means this chunk will not be revised. speech_final means the person
  // stopped talking. Treating the first as a completed turn cuts people off
  // mid-sentence, which on a check-in means capturing half a symptom.
  const chunk = { ...final, speech_final: false };
  assert.equal(parseMessage(chunk).kind, "interim");
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
