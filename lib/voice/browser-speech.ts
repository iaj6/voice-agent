"use client";

import type {
  RecognizerCallbacks,
  SpeechRecognizer,
  SpeechSynthesizer,
  SynthesizerCallbacks,
} from "./types";

// The Web Speech API is still not in lib.dom under every TS config, and Chrome
// only exposes the prefixed constructor. Declare the slice we actually use.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message: string;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Pure capability probes. Safe to call during render on the client. */
export function isRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export function isSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export class BrowserRecognizer implements SpeechRecognizer {
  readonly supported: boolean;
  private recognition: SpeechRecognitionLike | null = null;
  private wantRunning = false;
  private running = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly callbacks: RecognizerCallbacks) {
    const Ctor = getRecognitionCtor();
    this.supported = Ctor !== null;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      this.running = true;
      this.callbacks.onStart();
    };

    recognition.onend = () => {
      this.running = false;
      this.callbacks.onEnd();
      // Chrome ends the session after a stretch of silence even in continuous
      // mode. If the user still has the mic open, bring it straight back.
      if (this.wantRunning) this.scheduleRestart();
    };

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are routine in a long call, not failures.
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.wantRunning = false;
        this.callbacks.onError(
          "Microphone permission was denied. Allow mic access and start the call again.",
        );
        return;
      }
      this.callbacks.onError(event.message || event.error);
    };

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) this.callbacks.onFinal(trimmed);
        } else {
          interim += text;
        }
      }
      const trimmedInterim = interim.trim();
      if (trimmedInterim) this.callbacks.onInterim(trimmedInterim);
    };

    this.recognition = recognition;
  }

  private scheduleRestart() {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.wantRunning || this.running) return;
      try {
        this.recognition?.start();
      } catch {
        // start() throws if a session is already live; the next onend retries.
      }
    }, 150);
  }

  start() {
    if (!this.recognition) return;
    this.wantRunning = true;
    if (this.running) return;
    try {
      this.recognition.start();
    } catch {
      // Already starting. onstart will fire.
    }
  }

  stop() {
    this.wantRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.recognition?.stop();
    } catch {
      /* not running */
    }
  }

  abort() {
    this.wantRunning = false;
    try {
      this.recognition?.abort();
    } catch {
      /* not running */
    }
  }

  dispose() {
    this.stop();
    if (this.recognition) {
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onstart = null;
      this.recognition.onend = null;
    }
    this.recognition = null;
  }
}

/** Voice names to try in order. Falls back to the platform default. */
const PREFERRED_VOICES = [
  "Samantha",
  "Google US English",
  "Microsoft Aria Online (Natural) - English (United States)",
  "Karen",
];

export class BrowserSynthesizer implements SpeechSynthesizer {
  readonly supported: boolean;
  private queue: string[] = [];
  private speaking = false;
  private current = "";
  private voice: SpeechSynthesisVoice | null = null;
  private cancelled = false;
  private disposed = false;
  /** Rolling record of what was recently said aloud, for echo suppression. */
  private spokenHistory: { text: string; at: number }[] = [];

  constructor(private readonly callbacks: SynthesizerCallbacks) {
    this.supported =
      typeof window !== "undefined" && "speechSynthesis" in window;
    if (!this.supported) return;
    this.pickVoice();
    // Voice list populates asynchronously in Chrome.
    window.speechSynthesis.onvoiceschanged = () => this.pickVoice();
  }

  private pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return;
    for (const name of PREFERRED_VOICES) {
      const match = voices.find((v) => v.name === name);
      if (match) {
        this.voice = match;
        return;
      }
    }
    this.voice =
      voices.find((v) => v.lang.startsWith("en") && v.localService) ??
      voices.find((v) => v.lang.startsWith("en")) ??
      voices[0];
  }

  enqueue(text: string) {
    if (!this.supported) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.cancelled = false;
    this.queue.push(trimmed);
    this.spokenHistory.push({ text: trimmed, at: Date.now() });

    if (!this.speaking) {
      // idle -> speaking transition
      this.speaking = true;
      if (!this.disposed) this.callbacks.onStart();
      this.drain();
    }
  }

  currentText() {
    return this.current;
  }

  /**
   * Everything said aloud in the last `windowMs`. Recognition finals arrive
   * after an utterance ends, by which point currentText() is already empty —
   * so echo detection has to look backwards, not at what is playing right now.
   */
  recentText(windowMs = 20_000) {
    const cutoff = Date.now() - windowMs;
    this.spokenHistory = this.spokenHistory.filter((e) => e.at >= cutoff);
    return this.spokenHistory.map((e) => e.text).join(" ");
  }

  private drain() {
    const next = this.queue.shift();
    if (next === undefined) {
      // speaking -> idle transition
      this.speaking = false;
      this.current = "";
      if (!this.disposed) this.callbacks.onIdle();
      return;
    }

    this.current = next;

    const utterance = new SpeechSynthesisUtterance(next);
    if (this.voice) utterance.voice = this.voice;
    // Slightly under default. Trial participants may be elderly or fatigued,
    // and rushed speech is the fastest way to lose a check-in answer.
    utterance.rate = 0.98;
    utterance.pitch = 1.0;

    utterance.onend = () => {
      if (this.cancelled || this.disposed) return;
      this.drain();
    };
    utterance.onerror = (event) => {
      if (this.cancelled || event.error === "interrupted" || event.error === "canceled") {
        return;
      }
      this.callbacks.onError(event.error);
      this.drain();
    };

    window.speechSynthesis.speak(utterance);
  }

  cancel() {
    if (!this.supported) return;
    const wasActive = this.speaking || this.queue.length > 0;
    this.cancelled = true;
    this.queue = [];
    this.current = "";
    this.speaking = false;
    window.speechSynthesis.cancel();
    // Only report going idle if there was something to interrupt. A cancel on an
    // already-quiet synth is a no-op, and firing onIdle for it would drive the
    // call state machine on mount — which StrictMode's double-invoked effect
    // does on every dev render.
    if (wasActive && !this.disposed) this.callbacks.onIdle();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    if (this.supported) window.speechSynthesis.onvoiceschanged = null;
  }
}
