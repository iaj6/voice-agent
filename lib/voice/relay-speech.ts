/**
 * The recogniser the agent actually listens through.
 *
 * Microphone → this page → our server → Deepgram, and back. The credential never
 * reaches the browser, and the audio path stays inside infrastructure that can
 * be audited — which is the shape a clinical system wants, and happens also to
 * be the only shape available given the key cannot mint browser tokens.
 *
 * Implements the same SpeechRecognizer the browser recogniser does, so the swap
 * is a constructor call.
 */

import { startCapture, type Capture, type CaptureSettings } from "./capture.ts";
import type { Heard, RecognizerCallbacks, SpeechRecognizer } from "./types.ts";

/**
 * Whether this browser can stream a request body.
 *
 * The relay's hard requirement, and the one worth testing for. Checking
 * `getUserMedia` and `AudioWorkletNode` instead tests the wrong thing: Safari
 * has both, so it would report supported, skip the fallback, prompt for the
 * microphone, and only then fail on the fetch. The participant would have
 * granted a permission for nothing.
 *
 * Reading `duplex` is the detection: a browser that supports request streams
 * consults the getter and declines to set a Content-Type for the stream.
 */
function supportsRequestStreams(): boolean {
  if (typeof Request === "undefined" || typeof ReadableStream === "undefined") return false;
  try {
    let consulted = false;
    const typed = new Request("https://example.invalid", {
      method: "POST",
      body: new ReadableStream(),
      get duplex() {
        consulted = true;
        return "half";
      },
    } as RequestInit).headers.has("Content-Type");
    return consulted && !typed;
  } catch {
    return false;
  }
}

/** How long to wait before rebuilding a session that ended on its own. */
const RECONNECT_DELAY_MS = 250;
/** Consecutive failures that produced nothing before we stop trying. */
const MAX_RECONNECTS = 3;

export class RelayRecognizer implements SpeechRecognizer {
  readonly supported: boolean;
  readonly reportsConfidence = true;

  private readonly callbacks: RecognizerCallbacks;
  private readonly onSettings?: (settings: CaptureSettings) => void;
  private readonly onUnavailable?: () => void;
  private capture: Capture | null = null;
  /**
   * Every live request, not just the newest.
   *
   * In half-duplex a session is left draining on every turn while the next one
   * starts, so holding a single controller made each drained turn permanently
   * unreachable — abort() cancelled only the most recent one and every orphan
   * behind it kept delivering into whatever call came next.
   */
  private readonly inFlight = new Set<AbortController>();
  /** Runs at or below this generation have been cancelled and must stay silent. */
  private abortedThrough = 0;
  /** Whether the caller wants a live microphone right now. */
  private wantRunning = false;
  /** Bumped per session, so a superseded run cannot clobber a live one. */
  private generation = 0;
  private failures = 0;
  /** Whether the relay has ever worked in this browser, against this deployment. */
  private everDelivered = false;
  private disposed = false;

  constructor(
    callbacks: RecognizerCallbacks,
    options: {
      onSettings?: (settings: CaptureSettings) => void;
      onUnavailable?: () => void;
    } = {},
  ) {
    this.callbacks = callbacks;
    this.onSettings = options.onSettings;
    this.onUnavailable = options.onUnavailable;
    this.supported =
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof AudioWorkletNode !== "undefined" &&
      supportsRequestStreams();
  }

  start(): void {
    if (this.wantRunning || this.disposed) return;
    this.wantRunning = true;
    this.failures = 0;
    void this.run(++this.generation);
  }

  private async run(gen: number): Promise<void> {
    let capture: Capture;
    try {
      capture = await startCapture();
    } catch (err) {
      if (gen === this.generation) {
        this.wantRunning = false;
        const name = err instanceof Error ? err.name : "";
        // A refused or absent microphone is terminal — the browser recogniser
        // would be refused too, and it is not an error the participant can debug
        // from a stack trace. Everything else capture can fail on is specific to
        // owning the audio path: an undeployed worklet, a CSP that blocks
        // addModule, a browser that will not build a 16 kHz context. The older
        // recogniser handles all of those, so hand back rather than ending the
        // call with no microphone.
        if (name === "NotAllowedError" || name === "NotFoundError") {
          this.callbacks.onError(
            `The microphone is unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.callbacks.onEnd();
        } else {
          this.callbacks.onEnd();
          this.onUnavailable?.();
        }
      }
      return;
    }

    // The permission prompt can sit open for a while. Whatever the caller
    // decided in the meantime wins.
    if (gen !== this.generation || !this.wantRunning) {
      capture.stop();
      return;
    }

    this.capture = capture;
    this.onSettings?.(capture.settings);
    this.callbacks.onStart();

    const controller = new AbortController();
    this.inFlight.add(controller);

    let delivered = false;
    /** The relay cannot be used here, as opposed to this session having ended. */
    let unusable = false;
    let threw: unknown = null;
    /** A failure the relay itself says to try again after. */
    let retryable = false;
    /** An error the relay streamed on an otherwise successful response. */
    let relayError: string | null = null;

    try {
      // The rate the microphone actually produced, which the relay has no other
      // way to learn — and declaring the wrong one turns the whole transcript
      // into nonsense without raising an error anywhere.
      const response = await fetch(`/api/stt/stream?rate=${capture.settings.sampleRate}`, {
        method: "POST",
        body: capture.frames,
        // Chromium-only, which `supported` above tests for directly.
        duplex: "half",
        signal: controller.signal,
        headers: { "Content-Type": "application/octet-stream" },
      } as RequestInit & { duplex: "half" });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        // 429 is the one status the relay declares transient — it is our own
        // concurrency cap, and half-duplex reaches it by opening a session per
        // turn while closed ones are still draining. Treating it as a verdict on
        // the browser dropped the whole check-in to the older recogniser, losing
        // per-word confidence and echo cancellation over a queue.
        retryable = response.status === 429;
        throw new Error(detail.slice(0, 160) || `relay returned ${response.status}`);
      }
      await this.readEvents(
        gen,
        controller,
        response.body,
        () => {
          delivered = true;
          this.everDelivered = true;
          this.failures = 0;
          // Not sticky. Otherwise one frame ten seconds in still red-bannered a
          // session that went on to transcribe normally until the cap rotated it.
          relayError = null;
        },
        (message) => {
          relayError = message;
        },
      );
    } catch (err) {
      threw = err;
      // Anything that goes wrong before a single transcript arrives means the
      // relay does not work here, whatever the reason — no credential, a
      // platform that buffers the request body, a transport that refuses to
      // stream one. Chrome only streams a request body over HTTP/2, and no
      // feature test can see that in advance, so the first attempt is the test.
      //
      // Narrowing this to a 503 left every other failure ending in "could not be
      // re-established" and no recogniser at all — worse than the one this
      // replaced, which is the outcome the fallback exists to prevent.
      //
      // Only on the first attempt, though. Once the relay has produced a
      // transcript we know it works here, and a later failure is a dropped
      // session rather than a verdict on the browser — retrying that is right,
      // and downgrading the whole call over one blip is not.
    } finally {
      // The relay can fail two ways and only one of them throws. A rotated key,
      // a revoked scope or an exhausted quota all answer 200 and *then* stream
      // an error before closing, so readEvents returns normally. Treating only
      // the throwing kind as fatal meant a dead key produced four fresh
      // microphones, four relay sessions, four metered Deepgram sockets and four
      // red banners before the fallback was finally offered.
      const failed = threw !== null || relayError !== null;
      unusable =
        failed &&
        !retryable &&
        !controller.signal.aborted &&
        !delivered &&
        !this.everDelivered;

      if (failed && !unusable && !controller.signal.aborted && gen === this.generation) {
        const detail =
          relayError ??
          (threw instanceof Error ? threw.message : String(threw));
        this.callbacks.onError(`Speech recognition stopped: ${detail}`);
      }

      // This run's microphone stops with this run, on every path out. A relay
      // that ended early — no credential, an upstream error, the session cap —
      // otherwise left the recording indicator on and the worklet pushing into a
      // stream nobody was reading.
      capture.stop();

      this.inFlight.delete(controller);

      if (gen === this.generation) {
        this.capture = null;

        if (unusable) {
          this.wantRunning = false;
          this.callbacks.onEnd();
          this.onUnavailable?.();
        } else if (this.wantRunning && !this.disposed) {
          this.resume(gen, delivered);
        } else {
          this.callbacks.onEnd();
        }
      }
    }
  }

  /**
   * Rebuilds a session that ended while we still wanted to be listening.
   *
   * The relay closes on its own for ordinary reasons — it caps its own session
   * so the platform cannot kill it mid-stream, and a call with barge-in on runs
   * longer than that cap. Without this the microphone simply stopped working
   * partway through a check-in, silently, with the console still saying
   * "listening".
   *
   * Bounded, because the other reason a session ends immediately is that
   * something is broken, and retrying that in a tight loop opens a socket per
   * attempt against a metered account.
   */
  private resume(gen: number, delivered: boolean): void {
    this.failures = delivered ? 0 : this.failures + 1;
    if (this.failures > MAX_RECONNECTS) {
      // Out of attempts. Hand back rather than stopping here: no microphone at
      // all is the worst available outcome, and the older recogniser still works.
      this.wantRunning = false;
      this.callbacks.onEnd();
      this.onUnavailable?.();
      return;
    }
    setTimeout(() => {
      if (this.disposed || !this.wantRunning || gen !== this.generation) return;
      void this.run(++this.generation);
    }, RECONNECT_DELAY_MS);
  }

  private async readEvents(
    gen: number,
    controller: AbortController,
    body: ReadableStream<Uint8Array>,
    onDelivered: () => void,
    onRelayError: (message: string) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Superseded is not the same as cancelled. A run that stop() left draining
      // still owes its final; a run somebody aborted owes nothing, and must not
      // still be talking — its words belong to a call that is over.
      //
      // Checked against a watermark rather than only this run's own signal,
      // because a drain orphaned several turns ago has a controller nobody holds
      // any more. The watermark silences all of them at once.
      if (this.disposed || gen <= this.abortedThrough || controller.signal.aborted) return;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = frame.replace(/^data: /, "").trim();
        if (!payload) continue;

        let event: { type?: string; heard?: Heard; message?: string };
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        // A session superseded by a newer one is still draining, and the reason
        // stop() does not abort is to wait for exactly what it is about to send.
        // Guarding the whole loop on the generation threw that away on every one
        // of the ~22 turns in a half-duplex call — the participant starts
        // answering as the agent stops speaking, and the sentence went nowhere.
        const draining = gen !== this.generation;

        if (event.type === "interim" && event.heard) {
          onDelivered();
          // Its guesses, though, would fight the live session for the display.
          if (!draining) this.callbacks.onInterim(event.heard.text);
        } else if (event.type === "final" && event.heard) {
          onDelivered();
          this.callbacks.onFinal(event.heard);
        } else if (event.type === "error") {
          // Reported by the caller once it knows whether this is a dead relay to
          // hand back from or a blip to retry.
          onRelayError(event.message ?? "Speech recognition failed.");
        }
      }
    }
  }

  stop(): void {
    // Stops the microphone and lets the relay flush: the recogniser still owes a
    // final for whatever was said last, and aborting here would throw it away.
    //
    // The draining run keeps its own reference and shuts itself down. Clearing
    // the intent here is what lets the next start() open a fresh session without
    // waiting for that drain — the agent speaks a two-word turn and reopens the
    // microphone well before the old session's final has come back, and a guard
    // that waited for it left the participant talking into a dead line.
    this.wantRunning = false;
    this.capture?.stop();
    this.capture = null;
  }

  abort(): void {
    this.wantRunning = false;
    // Everything up to now is cancelled — including drains from earlier turns
    // whose controllers are no longer reachable individually.
    this.abortedThrough = this.generation;
    this.generation += 1;
    this.capture?.stop();
    this.capture = null;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
  }
}
