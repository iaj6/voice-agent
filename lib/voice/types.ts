/**
 * Provider-agnostic seams for the ears and mouth of the agent.
 *
 * v1 binds both to the browser's Web Speech API — zero keys, zero latency to
 * first byte, and good enough to prove the conversation design. Swapping in
 * Deepgram for recognition or ElevenLabs/Cartesia for speech is an
 * implementation of these two interfaces, not a rewrite of the app.
 */

export interface RecognizerCallbacks {
  /** Partial hypothesis. Fires many times per utterance; used for barge-in. */
  onInterim(text: string): void;
  /** Stable transcript for one utterance. This is what gets sent to the agent. */
  onFinal(text: string): void;
  onStart(): void;
  onEnd(): void;
  onError(message: string): void;
}

export interface SpeechRecognizer {
  readonly supported: boolean;
  start(): void;
  stop(): void;
  /** Drop in-flight audio without emitting a final result. */
  abort(): void;
  dispose(): void;
}

export interface SynthesizerCallbacks {
  onStart(): void;
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
  cancel(): void;
  dispose(): void;
}
