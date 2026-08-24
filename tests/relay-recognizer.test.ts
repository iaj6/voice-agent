/**
 * The recogniser's lifecycle, which is where a voice agent fails silently.
 *
 * None of this needs a browser. `startCapture` and `fetch` are the only two
 * things RelayRecognizer touches that a test cannot provide, so both are
 * replaced and the rest runs as written.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const captures: { stopped: boolean }[] = [];
let openSessions = 0;
/** Resolved by the test to end a relay session, standing in for the server. */
let endSession: (() => void) | null = null;
/** Pushes an SSE event into the open session, standing in for the recogniser. */
let deliver: ((type: string, text: string) => void) | null = null;
/** Every session opened, so a test can speak to one that is still draining. */
const sessions: { deliver: (type: string, text: string) => void; end: () => void }[] = [];
/** Makes the next fetch fail, standing in for a dropped session. */
let failNext = false;
/** Makes the next startCapture throw, standing in for a broken audio path. */
let failCapture: Error | null = null;

mock.module("../lib/voice/capture.ts", {
  // `exports` replaced `namedExports` in the runtime API; the shipped type
  // definitions have not caught up, so the cast is to the current API rather
  // than around it.
  exports: {
    TARGET_SAMPLE_RATE: 16_000,
    startCapture: async () => {
      if (failCapture) {
        const err = failCapture;
        failCapture = null;
        throw err;
      }
      const state = { stopped: false };
      captures.push(state);
      return {
        frames: new ReadableStream<Uint8Array>({ start() {} }),
        settings: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16_000,
          channelCount: 1,
        },
        stop: () => {
          state.stopped = true;
        },
      };
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);

const { RelayRecognizer } = await import("../lib/voice/relay-speech.ts");

/** A relay that stays open until the test lets it end. */
function stubFetch(status = 200) {
  failNext = false;
  failCapture = null;
  openSessions = 0;
  sessions.length = 0;
  globalThis.fetch = (async () => {
    if (failNext) {
      failNext = false;
      throw new TypeError("network error");
    }
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "no key" }), { status });
    }
    openSessions += 1;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          deliver = (type, text) =>
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type, heard: { text, words: [], minConfidence: null } })}\n\n`,
              ),
            );
          endSession = () => {
            openSessions -= 1;
            try {
              controller.close();
            } catch {
              /* already gone */
            }
          };
          sessions.push({ deliver: deliver!, end: endSession });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

const callbacks = () => ({
  onInterim: () => {},
  onFinal: () => {},
  onStart: () => {},
  onEnd: () => {},
  onError: () => {},
});

test("the final a draining session flushes still reaches the agent", async () => {
  // stop() deliberately does not abort, so the relay can flush the sentence the
  // participant was part-way through when the agent started speaking. Discarding
  // that once a newer session exists loses it on every one of the ~22 turns in a
  // half-duplex call, silently.
  captures.length = 0;
  stubFetch();
  const finals: string[] = [];
  const recognizer = new RelayRecognizer({
    ...callbacks(),
    onFinal: (heard) => finals.push(heard.text),
  });

  recognizer.start();
  await settle();
  recognizer.stop();
  recognizer.start();
  await settle();
  assert.equal(sessions.length, 2, "a newer session is open");

  // The old one flushes what it owed.
  sessions[0].deliver("final", "I coughed up blood this morning");
  sessions[0].end();
  await settle();

  assert.deepEqual(finals, ["I coughed up blood this morning"]);
  recognizer.dispose();
});

test("a capture failure that is not a refused microphone hands back", async () => {
  // An undeployed worklet or a blocking CSP is specific to owning the audio
  // path. The older recogniser works fine in all of them, so ending the call
  // with no microphone is the wrong answer.
  captures.length = 0;
  stubFetch();
  let handedBack = 0;
  let errored = 0;
  const recognizer = new RelayRecognizer(
    { ...callbacks(), onError: () => { errored += 1; } },
    { onUnavailable: () => { handedBack += 1; } },
  );

  failCapture = new DOMException("worklet missing", "AbortError");
  recognizer.start();
  await settle();
  assert.equal(handedBack, 1, "the caller can install the fallback");
  assert.equal(errored, 0, "and the participant is not told the mic is broken");

  failCapture = new DOMException("denied", "NotAllowedError");
  recognizer.start();
  await settle();
  assert.equal(handedBack, 1, "a refused microphone is terminal, not a swap");
  assert.equal(errored, 1);
  recognizer.dispose();
});

test("the microphone reopens even though the last session is still draining", async () => {
  // The agent stops the recogniser to speak and starts it again when it stops.
  // A short turn — "Okay." — ends well before the relay has finished flushing
  // its final, and a guard that waited for that drain left the participant
  // talking into a dead microphone for the rest of the check-in.
  captures.length = 0;
  stubFetch();
  const recognizer = new RelayRecognizer(callbacks());

  recognizer.start();
  await settle();
  assert.equal(captures.length, 1, "the first session opened");

  recognizer.stop();
  // Deliberately not ending the session: it is still draining, exactly as it
  // would be while the agent speaks a two-word turn.
  recognizer.start();
  await settle();

  assert.equal(captures.length, 2, "a second session opened while the first drained");
  assert.equal(captures[1].stopped, false, "the new microphone is live");
  assert.equal(openSessions, 2, "the draining session was not cut off mid-flush");
  endSession?.();
  recognizer.dispose();
});

test("a session that ends on its own stops its own microphone", async () => {
  // The relay caps its own session, and errors out when it has no credential.
  // Either way the run returns while the capture is still live — leaving the
  // recording indicator on and the worklet pushing into a stream nobody reads.
  captures.length = 0;
  stubFetch();
  const recognizer = new RelayRecognizer(callbacks());

  recognizer.start();
  await settle();
  // No stop() here on purpose. stop() releasing the microphone proves nothing;
  // the question is whether the run releases it when the *relay* is what ended.
  endSession?.();
  await settle();

  assert.equal(captures[0].stopped, true, "the microphone was released");
  recognizer.dispose();
});

test("a session that ends while we still want to listen is rebuilt", async () => {
  // With barge-in on, one session covers the whole call — longer than the cap
  // the relay puts on itself. Without resumption the microphone stopped working
  // partway through, silently, with the console still reading "listening".
  captures.length = 0;
  stubFetch();
  const recognizer = new RelayRecognizer(callbacks());

  recognizer.start();
  await settle();
  assert.equal(captures.length, 1);

  endSession?.();
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(captures.length >= 2, "a fresh session replaced the one that ended");
  recognizer.dispose();
});

test("a relay with no credential gives up instead of retrying a metered socket", async () => {
  captures.length = 0;
  stubFetch(503);
  let unavailable = 0;
  const recognizer = new RelayRecognizer(callbacks(), {
    onUnavailable: () => {
      unavailable += 1;
    },
  });

  recognizer.start();
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(unavailable, 1, "the caller is told once, so it can fall back");
  assert.equal(captures.length, 1, "and it did not reconnect in a loop");
  assert.equal(captures[0].stopped, true);
  recognizer.dispose();
});

test("a relay that has worked before retries instead of downgrading the call", async () => {
  // A dropped session mid-call is not a verdict on the browser. Falling back on
  // the first blip would cost the rest of the check-in its per-word confidence,
  // which is what the read-back is thresholded on.
  captures.length = 0;
  stubFetch();
  let unavailable = 0;
  const recognizer = new RelayRecognizer(callbacks(), {
    onUnavailable: () => {
      unavailable += 1;
    },
  });

  recognizer.start();
  await settle();
  deliver?.("interim", "I have been");
  await settle();

  failNext = true;
  endSession?.();
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(unavailable, 0, "a working relay is not abandoned over one failure");
  assert.ok(captures.length >= 2, "it tried again");
  recognizer.dispose();
});

test("stopping before the permission prompt is answered releases the microphone", async () => {
  captures.length = 0;
  stubFetch();
  const recognizer = new RelayRecognizer(callbacks());

  recognizer.start();
  recognizer.stop();
  await settle();

  assert.equal(captures.length, 1);
  assert.equal(captures[0].stopped, true, "a microphone granted after stop() is not left live");
  recognizer.dispose();
});
