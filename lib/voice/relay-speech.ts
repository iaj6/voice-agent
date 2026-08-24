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

export class RelayRecognizer implements SpeechRecognizer {
  readonly supported: boolean;
  readonly reportsConfidence = true;

  private readonly callbacks: RecognizerCallbacks;
  private readonly onSettings?: (settings: CaptureSettings) => void;
  private capture: Capture | null = null;
  private inFlight: AbortController | null = null;
  private running = false;
  private disposed = false;

  constructor(
    callbacks: RecognizerCallbacks,
    options: { onSettings?: (settings: CaptureSettings) => void } = {},
  ) {
    this.callbacks = callbacks;
    this.onSettings = options.onSettings;
    this.supported =
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof AudioWorkletNode !== "undefined";
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    let capture: Capture;
    try {
      capture = await startCapture();
    } catch (err) {
      this.running = false;
      // A refused microphone is the single most likely failure here and it is
      // not an error the participant can debug from a stack trace.
      this.callbacks.onError(
        `The microphone is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.capture = capture;
    this.onSettings?.(capture.settings);
    this.callbacks.onStart();

    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const response = await fetch("/api/stt/stream", {
        method: "POST",
        body: capture.frames,
        // Chromium-only, and the same constraint the Web Speech API already
        // imposed, so nothing is lost by requiring it.
        duplex: "half",
        signal: controller.signal,
        headers: { "Content-Type": "application/octet-stream" },
      } as RequestInit & { duplex: "half" });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail.slice(0, 160) || `relay returned ${response.status}`);
      }
      await this.readEvents(response.body);
    } catch (err) {
      if (!controller.signal.aborted) {
        this.callbacks.onError(
          `Speech recognition stopped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.running = false;
      this.callbacks.onEnd();
    }
  }

  private async readEvents(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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

        if (event.type === "interim" && event.heard) {
          this.callbacks.onInterim(event.heard.text);
        } else if (event.type === "final" && event.heard) {
          this.callbacks.onFinal(event.heard);
        } else if (event.type === "error") {
          this.callbacks.onError(event.message ?? "Speech recognition failed.");
        }
      }
    }
  }

  stop(): void {
    // Stops the microphone and lets the relay flush: the recogniser still owes a
    // final for whatever was said last, and aborting here would throw it away.
    this.capture?.stop();
    this.capture = null;
  }

  abort(): void {
    this.capture?.stop();
    this.capture = null;
    this.inFlight?.abort();
    this.inFlight = null;
    this.running = false;
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
  }
}
