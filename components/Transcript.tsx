"use client";

import { useEffect, useRef } from "react";
import type { TranscriptLine } from "@/hooks/useVoiceAgent";

function clockOf(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function Transcript({
  lines,
  interim,
}: {
  lines: TranscriptLine[];
  interim: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines, interim]);

  if (lines.length === 0 && !interim) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p
          className="max-w-sm text-[13px] leading-relaxed"
          style={{ color: "var(--color-bone-faint)" }}
        >
          No active channel. Start a check-in to open the microphone and place the
          subject on the line.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-6 py-6">
      {lines.map((line) => {
        const isAgent = line.role === "agent";
        return (
          <div key={line.id} className="line-in flex gap-3.5">
            <div className="flex w-[70px] shrink-0 flex-col items-end gap-1 pt-[3px]">
              <span
                className="stamp"
                style={{
                  color: isAgent
                    ? "var(--color-amber-deep)"
                    : "var(--color-bone-faint)",
                }}
              >
                {isAgent ? "Agent" : "Subject"}
              </span>
              <span
                className="font-mono text-[9.5px] tabular-nums"
                style={{ color: "var(--color-bone-faint)", opacity: 0.55 }}
              >
                {clockOf(line.at)}
              </span>
            </div>

            <div
              className="min-w-0 flex-1 border-l pl-3.5"
              style={{
                borderColor: isAgent
                  ? "var(--color-amber-deep)"
                  : "var(--color-line-lit)",
              }}
            >
              <p
                className="text-[14.5px] leading-[1.62]"
                style={{
                  color: isAgent ? "var(--color-bone)" : "var(--color-bone-dim)",
                  fontStyle: isAgent ? "normal" : "italic",
                }}
              >
                {line.text}
              </p>
            </div>
          </div>
        );
      })}

      {interim ? (
        <div className="flex gap-3.5 opacity-55">
          <div className="flex w-[70px] shrink-0 justify-end pt-[3px]">
            <span className="stamp">Subject</span>
          </div>
          <div
            className="min-w-0 flex-1 border-l border-dashed pl-3.5"
            style={{ borderColor: "var(--color-line-lit)" }}
          >
            <p
              className="text-[14.5px] italic leading-[1.62]"
              style={{ color: "var(--color-bone-faint)" }}
            >
              {interim}
              <span
                className="ml-1 inline-block h-[13px] w-[2px] translate-y-[2px]"
                style={{
                  background: "var(--color-mint)",
                  animation: "pip-alarm 1s steps(1,end) infinite",
                }}
              />
            </p>
          </div>
        </div>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
