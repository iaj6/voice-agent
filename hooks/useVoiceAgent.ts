"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  BrowserRecognizer,
  BrowserSynthesizer,
  isRecognitionSupported,
  isSynthesisSupported,
} from "@/lib/voice/browser-speech";
import { ElevenLabsSynthesizer } from "@/lib/voice/elevenlabs-speech";
import { VOICE_NAME } from "@/lib/voice/tts-config";
import type { SpeechRecognizer, SpeechSynthesizer } from "@/lib/voice/types";
import type { SafetyNetHit } from "@/lib/clinical/safety";
import type { SessionSnapshot } from "@/lib/store/session";
import { isEchoOfRecentSpeech, looksLikeEcho } from "@/lib/voice/echo";

export type CallState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "ended";

export interface TranscriptLine {
  id: string;
  role: "subject" | "agent";
  text: string;
  at: string;
}

export interface ToolCallLine {
  id: string;
  name: string;
  input: unknown;
  result: unknown | null;
  isError: boolean;
  at: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Prompt tokens written to cache. Part of the prompt, and billed above input. */
  cacheWriteTokens: number;
  turns: number;
}

const CALL_START_UTTERANCE =
  "(The call has connected. The subject has not spoken yet.)";

const subscribeNever = () => () => {};
const returnTrue = () => true;

/** Interim hypotheses shorter than this are ignored for barge-in. */
const BARGE_IN_MIN_WORDS = 2;

export function useVoiceAgent() {
  const [state, setState] = useState<CallState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState("");
  const [toolCalls, setToolCalls] = useState<ToolCallLine[]>([]);
  const [safetyHits, setSafetyHits] = useState<SafetyNetHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [echoSuppressed, setEchoSuppressed] = useState(0);
  const [voiceFallbacks, setVoiceFallbacks] = useState(0);
  const [neuralVoice, setNeuralVoice] = useState(true);
  const [usage, setUsage] = useState<UsageTotals>({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
  });
  // Half-duplex by default. Full-duplex barge-in over laptop speakers feeds the
  // agent's own voice back into the recognizer, and the Web Speech API gives us
  // no audio pipeline to attach echo cancellation to. Correct capture outranks
  // conversational polish here; headphone users can turn it on.
  const [bargeInEnabled, setBargeInEnabled] = useState(false);

  // Platform capability is external state that never changes after load.
  // The server snapshot assumes support so the warning banner does not flash
  // in during hydration on browsers that do have it.
  const micSupported = useSyncExternalStore(
    subscribeNever,
    isRecognitionSupported,
    returnTrue,
  );
  const ttsSupported = useSyncExternalStore(
    subscribeNever,
    isSynthesisSupported,
    returnTrue,
  );

  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const synthRef = useRef<SpeechSynthesizer | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const stateRef = useRef<CallState>("idle");
  const busyRef = useRef(false);
  const pendingRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const bargeInRef = useRef(false);
  const agentLineRef = useRef<string | null>(null);

  const setCallState = useCallback((next: CallState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    bargeInRef.current = bargeInEnabled;
  }, [bargeInEnabled]);

  const appendAgentText = useCallback((text: string) => {
    // Everything impure — id generation, the clock, the ref write — happens
    // out here. The updater itself must be a pure function of its input:
    // StrictMode invokes it twice and keeps the second result, so an updater
    // that mutates a ref on its first pass silently drops the write on the
    // second.
    let lineId = agentLineRef.current;
    if (!lineId) {
      lineId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      agentLineRef.current = lineId;
    }
    const id = lineId;
    const at = new Date().toISOString();

    setTranscript((lines) =>
      lines.some((l) => l.id === id)
        ? lines.map((l) => (l.id === id ? { ...l, text: l.text + text } : l))
        : [...lines, { id, role: "agent" as const, text, at }],
    );
  }, []);

  const sendTurn = useCallback(
    async (utterance: string, source: "subject" | "system") => {
      const sid = sessionIdRef.current;
      if (!sid) return;

      busyRef.current = true;
      agentLineRef.current = null;
      setCallState("thinking");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, utterance, source }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          throw new Error(detail || `Request failed (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let terminal = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const payload = frame.replace(/^data: /, "").trim();
            if (!payload || payload === "[DONE]") continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }

            switch (event.type) {
              case "delta":
                appendAgentText(String(event.text));
                break;
              case "speak":
                setCallState("speaking");
                synthRef.current?.enqueue(String(event.text));
                break;
              case "tool_call":
                setToolCalls((calls) => [
                  ...calls,
                  {
                    id: String(event.id),
                    name: String(event.name),
                    input: event.input,
                    result: null,
                    isError: false,
                    at: new Date().toISOString(),
                  },
                ]);
                break;
              case "tool_result":
                setToolCalls((calls) =>
                  calls.map((c) =>
                    c.id === event.id
                      ? { ...c, result: event.result, isError: Boolean(event.isError) }
                      : c,
                  ),
                );
                break;
              case "safety":
                setSafetyHits((event.hits ?? []) as SafetyNetHit[]);
                break;
              case "state":
                setSnapshot(event.snapshot as SessionSnapshot);
                break;
              case "usage":
                setUsage((u) => ({
                  inputTokens: u.inputTokens + Number(event.inputTokens ?? 0),
                  outputTokens: u.outputTokens + Number(event.outputTokens ?? 0),
                  cacheReadTokens:
                    u.cacheReadTokens + Number(event.cacheReadTokens ?? 0),
                  cacheWriteTokens:
                    u.cacheWriteTokens + Number(event.cacheWriteTokens ?? 0),
                  turns: u.turns + 1,
                }));
                break;
              case "done":
                terminal = Boolean(event.terminal);
                break;
              case "error":
                setError(String(event.message));
                break;
            }
          }
        }

        if (terminal) {
          recognizerRef.current?.stop();
          setCallState("ended");
          return;
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        busyRef.current = false;
        abortRef.current = null;
      }

      if (stateRef.current === "ended") return;

      const queued = pendingRef.current.join(" ").trim();
      pendingRef.current = [];
      if (queued) {
        void sendTurn(queued, "subject");
        return;
      }

      // Ask the synthesizer whether it is actually still speaking rather than
      // trusting the state flag. `state` is set to "speaking" on the first
      // speak event and only cleared by onIdle — and onIdle returns early while
      // a turn is in flight. If the last sentence finishes playing before the
      // HTTP stream closes, that onIdle is swallowed, and the old guard
      // (`state !== "speaking"`) left the UI stuck on Speaking with the
      // microphone shut in half-duplex mode.
      if (synthRef.current?.isIdle() ?? true) {
        setCallState("listening");
        if (!bargeInRef.current) recognizerRef.current?.start();
      }
    },
    [appendAgentText, setCallState],
  );

  const handleFinal = useCallback(
    (text: string) => {
      const recent = synthRef.current?.recentText() ?? "";
      if (isEchoOfRecentSpeech(text, recent)) {
        // The microphone heard the agent, not the subject. Never let this reach
        // the eCRF as a patient utterance.
        setEchoSuppressed((n) => n + 1);
        setInterim("");
        return;
      }

      setInterim("");
      const line: TranscriptLine = {
        id: `subject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "subject",
        text,
        at: new Date().toISOString(),
      };
      setTranscript((lines) => [...lines, line]);

      if (busyRef.current) {
        pendingRef.current.push(text);
        return;
      }
      void sendTurn(text, "subject");
    },
    [sendTurn],
  );

  const handleInterim = useCallback((text: string) => {
    const speaking = synthRef.current?.currentText() ?? "";

    if (stateRef.current === "speaking") {
      if (!bargeInRef.current) return;
      if (text.trim().split(/\s+/).length < BARGE_IN_MIN_WORDS) return;
      if (looksLikeEcho(text, speaking)) return;

      // Real interruption: stop talking, drop the rest of the turn, and listen.
      synthRef.current?.cancel();
      abortRef.current?.abort();
      setCallState("listening");
    }

    if (looksLikeEcho(text, speaking)) return;
    setInterim(text);
  }, [setCallState]);

  // Wire up the speech providers once, on the client.
  useEffect(() => {
    const synthCallbacks = {
      onStart: () => {
        if (!sessionIdRef.current || stateRef.current === "ended") return;
        setCallState("speaking");
        if (!bargeInRef.current) recognizerRef.current?.stop();
      },
      onIdle: () => {
        // Guard on a live session: the speech providers are constructed on
        // mount, well before any call exists, and must not drive call state.
        if (!sessionIdRef.current || stateRef.current === "ended") return;
        // The synth goes briefly idle between streamed sentences. Reopening the
        // mic on every gap would thrash it, so wait for the turn itself to end.
        if (busyRef.current) return;
        setCallState("listening");
        if (!bargeInRef.current) recognizerRef.current?.start();
      },
      onError: (message: string) => setError(`Speech synthesis: ${message}`),
    };

    // Neural voice by default, with the browser engine underneath it. The
    // ElevenLabs synthesizer falls back per sentence on its own; this only
    // chooses which engine leads.
    const synth = neuralVoice
      ? new ElevenLabsSynthesizer({
          ...synthCallbacks,
          onFallback: () => setVoiceFallbacks((n) => n + 1),
        })
      : new BrowserSynthesizer(synthCallbacks);

    const recognizer = new BrowserRecognizer({
      onInterim: handleInterim,
      onFinal: handleFinal,
      onStart: () => {},
      onEnd: () => {},
      onError: (message) => setError(message),
    });

    synthRef.current = synth;
    recognizerRef.current = recognizer;
    return () => {
      recognizer.dispose();
      synth.dispose();
      recognizerRef.current = null;
      synthRef.current = null;
    };
  }, [handleFinal, handleInterim, setCallState, neuralVoice]);

  const startCall = useCallback(async () => {
    setError(null);
    setTranscript([]);
    setToolCalls([]);
    setSafetyHits([]);
    setSnapshot(null);
    setInterim("");
    setUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 0,
    });
    setEchoSuppressed(0);
    setVoiceFallbacks(0);
    pendingRef.current = [];
    setCallState("connecting");

    try {
      const response = await fetch("/api/session", { method: "POST" });
      if (!response.ok) throw new Error("Could not open a check-in session.");
      const data = (await response.json()) as { session: SessionSnapshot };
      sessionIdRef.current = data.session.id;
      setSessionId(data.session.id);
      setSnapshot(data.session);

      recognizerRef.current?.start();
      await sendTurn(CALL_START_UTTERANCE, "system");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCallState("idle");
    }
  }, [sendTurn, setCallState]);

  const endCall = useCallback(() => {
    sessionIdRef.current = null;
    abortRef.current?.abort();
    recognizerRef.current?.stop();
    synthRef.current?.cancel();
    busyRef.current = false;
    pendingRef.current = [];
    setInterim("");
    setCallState("ended");
  }, [setCallState]);

  /** Types an utterance straight in, bypassing the mic. Useful without a headset. */
  const sendTyped = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionIdRef.current) return;
      if (stateRef.current === "speaking") {
        synthRef.current?.cancel();
        abortRef.current?.abort();
      }
      handleFinal(trimmed);
    },
    [handleFinal],
  );

  return {
    state,
    sessionId,
    snapshot,
    transcript,
    interim,
    toolCalls,
    safetyHits,
    usage,
    echoSuppressed,
    voiceFallbacks,
    neuralVoice,
    setNeuralVoice,
    voiceName: VOICE_NAME,
    error,
    micSupported,
    ttsSupported,
    bargeInEnabled,
    setBargeInEnabled,
    startCall,
    endCall,
    sendTyped,
    clearError: () => setError(null),
  };
}
