"use client";

import type { CallState } from "@/hooks/useVoiceAgent";

const LABEL: Record<CallState, string> = {
  idle: "Standby",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Processing",
  speaking: "Speaking",
  ended: "Call ended",
};

const CLASS: Record<CallState, string> = {
  idle: "",
  connecting: "orb-thinking",
  listening: "orb-listening",
  thinking: "orb-thinking",
  speaking: "orb-speaking",
  ended: "",
};

export function CallOrb({ state, alarm }: { state: CallState; alarm: boolean }) {
  const orbClass = alarm ? "orb-alarm" : CLASS[state];
  const label = alarm ? "Escalated" : LABEL[state];

  return (
    <div className="flex flex-col items-center gap-4">
      <div className={`orb ${orbClass}`} role="status" aria-live="polite">
        <span className="orb-ring" />
        <span className="orb-ring" />
        <span className="orb-ring" />

        {state === "speaking" && !alarm ? (
          <div className="flex h-8 items-center gap-[3px]">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <span
                key={i}
                className="eq-bar"
                style={{ animationDelay: `${i * 110}ms` }}
              />
            ))}
          </div>
        ) : state === "listening" && !alarm ? (
          <svg width="26" height="34" viewBox="0 0 24 32" fill="none" aria-hidden>
            <rect
              x="8"
              y="1"
              width="8"
              height="16"
              rx="4"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M4 14a8 8 0 0 0 16 0M12 22v8M7 31h10"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        ) : alarm ? (
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 2 1.5 21h21L12 2Z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="M12 9v5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <circle cx="12" cy="17.5" r="1" fill="currentColor" />
          </svg>
        ) : (
          <span
            className="block h-2 w-2 rounded-full"
            style={{ background: "var(--color-bone-faint)" }}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <span
          className={`pip ${
            alarm ? "pip-alarm" : state === "idle" || state === "ended" ? "pip-idle" : "pip-live"
          }`}
        />
        <span className="stamp" style={{ color: "var(--color-bone-dim)" }}>
          {label}
        </span>
      </div>
    </div>
  );
}
