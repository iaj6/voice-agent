"use client";

import type { SpeechSynthesizer, SynthesizerCallbacks } from "./types.ts";
import { SYNTHESIS_TIMEOUT_MS } from "./tts-config.ts";

/**
 * Neural speech via the server-side /api/speech route, with local browser
 * synthesis as an automatic fallback.
 *
 * The fallback is the point. Moving text-to-speech off the device puts a network
 * hop in the middle of the agent's mouth, and a provider outage would otherwise
 * mean a trial participant sitting in silence with no idea whether the line is
 * live. A robot voice is a degraded call; no voice is a broken one. Every
 * fallback is counted and surfaced rather than hidden, because a call rendered
 * in a different voice than the pinned instrument is a fact the coordinator
 * should be able to see.
 *
 * Sentences are prefetched while the previous one plays, so the ~250ms synthesis
 * latency is paid once per turn rather than once per sentence.
 */

interface QueueItem {
  text: string;
  /** Resolves to null when synthesis failed and local playback should be used. */
  audio: Promise<Blob | null>;
  abort: AbortController;
}

export class ElevenLabsSynthesizer implements SpeechSynthesizer {
  readonly supported: boolean;

  private queue: QueueItem[] = [];
  private speaking = false;
  private current = "";
  private cancelled = false;
  private disposed = false;
  private audioEl: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  /** Settles the in-flight playBlob promise when playback is torn down. */
  private endPlayback: (() => void) | null = null;
  private spokenHistory: { text: string; at: number }[] = [];
  private fallbackCount = 0;
  /** Whether this speaking run has already reported becoming audible. */
  private audibleReported = false;

  constructor(
    private readonly callbacks: SynthesizerCallbacks & {
      /** Fired when a sentence had to be spoken by the browser instead. */
      onFallback?: (reason: string) => void;
    },
  ) {
    this.supported = typeof window !== "undefined";
  }

  private async synthesize(text: string, signal: AbortSignal): Promise<Blob | null> {
    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        // Past a few seconds the conversational moment has passed; speaking late
        // is worse than speaking now in the fallback voice.
        signal: AbortSignal.any([signal, AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS)]),
      });
      if (!response.ok) return null;
      return await response.blob();
    } catch {
      return null;
    }
  }

  enqueue(text: string) {
    if (!this.supported || this.disposed) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    this.cancelled = false;
    this.spokenHistory.push({ text: trimmed, at: Date.now() });

    const abort = new AbortController();
    // Kick the request off immediately — this is the prefetch.
    const item: QueueItem = {
      text: trimmed,
      audio: this.synthesize(trimmed, abort.signal),
      abort,
    };
    this.queue.push(item);

    if (!this.speaking) {
      this.speaking = true;
      if (!this.disposed) this.callbacks.onStart();
      void this.drain();
    }
  }

  currentText() {
    return this.current;
  }

  recentText(windowMs = 20_000) {
    const cutoff = Date.now() - windowMs;
    this.spokenHistory = this.spokenHistory.filter((e) => e.at >= cutoff);
    return this.spokenHistory.map((e) => e.text).join(" ");
  }

  /** How many sentences this call fell back to browser synthesis. */
  fallbacks() {
    return this.fallbackCount;
  }

  /** True when nothing is playing and nothing is queued. */
  isIdle() {
    return !this.speaking && this.queue.length === 0;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.cancelled || this.disposed) return;

      const item = this.queue.shift();
      if (!item) {
        this.speaking = false;
        this.current = "";
        if (!this.disposed) this.callbacks.onIdle();
        return;
      }

      this.current = item.text;
      const blob = await item.audio;
      if (this.cancelled || this.disposed) return;

      if (blob && blob.size > 0) {
        await this.playBlob(blob);
      } else {
        // A fallback sentence is still the agent becoming audible.
        this.fallbackCount += 1;
        this.callbacks.onFallback?.(
          `Synthesis unavailable for one sentence; spoke it with the browser voice instead.`,
        );
        await this.speakLocally(item.text);
      }
    }
  }

  /**
   * Tells the next sentence to report audibility again.
   *
   * Called when a turn is dispatched rather than when the queue drains. Resetting
   * only on the idle-to-speaking transition lost the measurement whenever a turn
   * began while the previous one was still draining — which is what a
   * participant answering promptly produces, so the turns it dropped were not a
   * random sample.
   */
  beginTurn(): void {
    this.audibleReported = false;
  }

  /** Once per turn, at the moment sound actually reaches the line. */
  private reportAudible(): void {
    if (this.audibleReported || this.disposed) return;
    this.audibleReported = true;
    this.callbacks.onAudible?.();
  }

  private playBlob(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      this.releaseUrl();
      const url = URL.createObjectURL(blob);
      this.objectUrl = url;

      const el = new Audio(url);
      this.audioEl = el;
      // `playing`, not `play()` resolving: the promise settles when playback has
      // been permitted to begin, this fires when it has actually begun.
      el.onplaying = () => this.reportAudible();

      const done = () => {
        el.onended = null;
        el.onerror = null;
        this.endPlayback = null;
        resolve();
      };
      // pause() fires no "ended" event, so without this the promise drain() is
      // awaiting never settles and the continuation is leaked on every barge-in.
      this.endPlayback = done;
      el.onended = done;
      el.onerror = done;

      el.play().catch(() => {
        // Autoplay refused, or the element was torn down mid-play.
        done();
      });
    });
  }

  /**
   * Last-resort local synthesis, awaited so queue ordering is preserved.
   *
   * Reports audibility like any other sentence. It did not, and the turns that
   * take this path are the ones where the neural provider timed out — the
   * slowest turns in the call. Excluding exactly those from the p50 and p95 made
   * N-01 look better than it is, and `latency.mjs` then described them as turns
   * that "produced no audio at all", which is the opposite of what happened.
   */
  private speakLocally(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        resolve();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.98;
      utterance.onstart = () => this.reportAudible();
      const done = () => resolve();
      utterance.onend = done;
      utterance.onerror = done;
      window.speechSynthesis.speak(utterance);
    });
  }

  private releaseUrl() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  cancel() {
    if (!this.supported) return;
    const wasActive = this.speaking || this.queue.length > 0;

    this.cancelled = true;
    for (const item of this.queue) item.abort.abort();
    this.queue = [];
    this.current = "";
    this.speaking = false;

    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.onended = null;
      this.audioEl.onerror = null;
      this.audioEl = null;
    }
    this.endPlayback?.();
    this.releaseUrl();

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    if (wasActive && !this.disposed) this.callbacks.onIdle();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
  }
}
