/**
 * Provider-agnostic seams for the ears and mouth of the agent.
 *
 * v1 binds both to the browser's Web Speech API — zero keys, zero latency to
 * first byte, and good enough to prove the conversation design. Swapping in
 * Deepgram for recognition or ElevenLabs/Cartesia for speech is an
 * implementation of these two interfaces, not a rewrite of the app.
 */

/** One word as the recogniser heard it, with how sure it was. */
export interface HeardWord {
  word: string;
  /** 0–1. Absent when the recogniser does not report one. */
  confidence: number | null;
}

/**
 * A stable transcript, with the evidence for it.
 *
 * The words matter separately from the text because a symptom heard at 0.4 and
 * a symptom heard at 0.98 are the same string and are not the same fact. The
 * browser recogniser reports no per-word confidence at all, which is most of why
 * D-3 went elsewhere — you cannot ask the agent to confirm what it heard badly
 * if nothing tells it what it heard badly.
 */
export interface Heard {
  text: string;
  words: HeardWord[];
  /** Lowest confidence across the utterance, or null if unknown. */
  minConfidence: number | null;
}

export interface RecognizerCallbacks {
  /** Partial hypothesis. Fires many times per utterance; used for barge-in. */
  onInterim(text: string): void;
  /**
   * Stable transcript for one utterance. This is what gets sent to the agent.
   *
   * Takes the full Heard rather than a string so confidence survives the trip.
   * Call sites that only want the words read `.text`.
   */
  onFinal(heard: Heard): void;
  onStart(): void;
  onEnd(): void;
  onError(message: string): void;
}

export interface SpeechRecognizer {
  readonly supported: boolean;
  /** Whether this recogniser reports per-word confidence at all. */
  readonly reportsConfidence: boolean;
  start(): void;
  stop(): void;
  /** Drop in-flight audio without emitting a final result. */
  abort(): void;
  dispose(): void;
}

export interface SynthesizerCallbacks {
  onStart(): void;
  /**
   * Fires when the agent first becomes *audible* in a speaking run.
   *
   * Deliberately separate from `onStart`, which fires when the first sentence is
   * queued — before the synthesis request has been made, let alone played. The
   * gap between the two is most of the latency a participant actually
   * experiences, so measuring N-01 from `onStart` would report a number that
   * looks good because it excludes the wait it is supposed to describe.
   */
  onAudible?(): void;
  /** Fires when the queue drains, not per utterance. */
  onIdle(): void;
  onError(message: string): void;
}

export interface SpeechSynthesizer {
  readonly supported: boolean;
  /** Queue a sentence. Sentences play in order as they arrive from the stream. */
  enqueue(text: string): void;
  /** What is being spoken right now — used to filter mic echo during barge-in. */
  currentText(): string;
  /**
   * Everything spoken aloud within the recent window. Recognition finals land
   * after playback ends, so echo detection for them has to look backwards.
   */
  recentText(windowMs?: number): string;
  /**
   * True when nothing is playing and nothing is queued. The call state machine
   * needs to ask rather than infer: onIdle can be swallowed while a turn is
   * still in flight, leaving the UI stuck on "speaking" with the mic shut.
   */
  isIdle(): boolean;
  cancel(): void;
  dispose(): void;
}
