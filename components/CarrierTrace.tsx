"use client";

import { useMemo } from "react";
import type { CallState } from "@/hooks/useVoiceAgent";

/**
 * The console's heartbeat. A monitor trace that always reflects call state, so
 * the operator can read the channel from across the room without parsing text.
 * Idle is a flat line; listening breathes; the agent speaking is a fuller wave;
 * an emergency escalation switches the trace to a hard ECG spike pattern.
 */

const SEGMENT = 600;
const HEIGHT = 44;
const MID = HEIGHT / 2;

type TraceMode = "flat" | "breath" | "scan" | "voice" | "alarm";

function sample(mode: TraceMode, x: number): number {
  const t = (x / SEGMENT) * Math.PI * 2;
  switch (mode) {
    case "flat":
      return MID;
    case "breath":
      return MID + Math.sin(t) * 4 + Math.sin(t * 2.7) * 1.4;
    case "scan":
      return (
        MID + Math.sin(t * 3) * 2.5 + Math.sin(t * 11) * 1.6 + Math.sin(t * 23) * 0.8
      );
    case "voice":
      return (
        MID +
        Math.sin(t * 2) * 8 +
        Math.sin(t * 5.3) * 4.5 +
        Math.sin(t * 13.1) * 2 +
        Math.sin(t * 29) * 1
      );
    case "alarm": {
      // Repeating QRS-like complex: quiet baseline, then a sharp spike.
      const p = (x % SEGMENT) / SEGMENT;
      if (p < 0.52) return MID + Math.sin(t * 2) * 0.8;
      if (p < 0.56) return MID + 3;
      if (p < 0.59) return MID + 5;
      if (p < 0.615) return MID - 17;
      if (p < 0.645) return MID + 9;
      if (p < 0.68) return MID - 2;
      if (p < 0.78) return MID + Math.sin((p - 0.68) * 30) * 4;
      return MID;
    }
  }
}

function buildPath(mode: TraceMode): string {
  const step = mode === "alarm" ? 3 : 6;
  const points: string[] = [];
  // Two segments so a -50% translate loops seamlessly.
  for (let x = 0; x <= SEGMENT * 2; x += step) {
    const y = sample(mode, x % SEGMENT).toFixed(2);
    points.push(`${x === 0 ? "M" : "L"}${x} ${y}`);
  }
  return points.join(" ");
}

const MODE_BY_STATE: Record<CallState, TraceMode> = {
  idle: "flat",
  connecting: "scan",
  listening: "breath",
  thinking: "scan",
  speaking: "voice",
  ended: "flat",
};

const SPEED_BY_MODE: Record<TraceMode, string> = {
  flat: "16s",
  breath: "9s",
  scan: "3.2s",
  voice: "2.1s",
  alarm: "2.6s",
};

const COLOR_BY_MODE: Record<TraceMode, string> = {
  flat: "var(--color-line-lit)",
  breath: "var(--color-mint)",
  scan: "var(--color-slate-signal)",
  voice: "var(--color-amber)",
  alarm: "var(--color-oxide)",
};

export function CarrierTrace({
  state,
  alarm,
}: {
  state: CallState;
  alarm: boolean;
}) {
  const mode: TraceMode = alarm ? "alarm" : MODE_BY_STATE[state];
  const d = useMemo(() => buildPath(mode), [mode]);
  const color = COLOR_BY_MODE[mode];

  return (
    <div className="relative h-11 w-full overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, var(--color-line-lit) 0 1px, transparent 1px 40px)",
        }}
      />
      <svg
        className="absolute inset-0 h-full w-[200%]"
        viewBox={`0 0 ${SEGMENT * 2} ${HEIGHT}`}
        preserveAspectRatio="none"
        style={{
          animation: `trace-scroll ${SPEED_BY_MODE[mode]} linear infinite`,
        }}
      >
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={mode === "flat" ? 1 : 1.4}
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{
            filter: mode === "flat" ? "none" : `drop-shadow(0 0 5px ${color})`,
            transition: "stroke 400ms ease",
          }}
        />
      </svg>
      {/* Edge fades so the trace reads as a window onto a continuous signal. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, var(--color-ink-000) 0%, transparent 7%, transparent 93%, var(--color-ink-000) 100%)",
        }}
      />
      <style>{`@keyframes trace-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
    </div>
  );
}
