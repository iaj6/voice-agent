"use client";

import type { ToolCallLine } from "@/hooks/useVoiceAgent";
import type { UsageTotals } from "@/hooks/useVoiceAgent";

function preview(value: unknown, max = 320) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function ActivityPanel({
  toolCalls,
  usage,
  echoSuppressed,
  voiceFallbacks,
  voiceName,
  neuralVoice,
}: {
  toolCalls: ToolCallLine[];
  usage: UsageTotals;
  echoSuppressed: number;
  voiceFallbacks: number;
  voiceName: string;
  neuralVoice: boolean;
}) {
  // Prompt tokens are input + cache writes + cache reads. Omitting the writes
  // shrinks the denominator and flatters the figure, which matters here because
  // this number is the visible payoff of keeping the system prompt byte-stable.
  const promptTokens =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const cacheRate =
    promptTokens > 0 ? Math.round((usage.cacheReadTokens / promptTokens) * 100) : 0;

  return (
    <div className="flex flex-col gap-5 p-4">
      <section className="flex flex-col gap-2.5">
        <span className="stamp stamp-lit">Model telemetry</span>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Turns", value: usage.turns },
            { label: "Cache hit", value: `${cacheRate}%` },
            { label: "Input tok", value: usage.inputTokens.toLocaleString() },
            { label: "Output tok", value: usage.outputTokens.toLocaleString() },
          ].map((m) => (
            <div
              key={m.label}
              className="border px-2.5 py-2"
              style={{ borderColor: "var(--color-line)" }}
            >
              <div className="stamp mb-1">{m.label}</div>
              <div
                className="font-mono text-[15px] tabular-nums"
                style={{ color: "var(--color-bone)" }}
              >
                {m.value}
              </div>
            </div>
          ))}
        </div>
        <p
          className="text-[10.5px] leading-relaxed"
          style={{ color: "var(--color-bone-faint)" }}
        >
          The system prompt is byte-stable across every turn and every session, so
          it caches once and reads on every subsequent request. That prefix is most
          of the input on a short voice turn.
        </p>
      </section>

      <div className="hairline" />

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="stamp stamp-lit">Voice integrity</span>
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{
              color:
                voiceFallbacks > 0 ? "var(--color-rust)" : "var(--color-mint)",
            }}
          >
            {voiceFallbacks === 0 ? "consistent" : `${voiceFallbacks} fallback`}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="stamp">Instrument</span>
          <span
            className="font-mono text-[11.5px]"
            style={{ color: "var(--color-bone)" }}
          >
            {neuralVoice ? `${voiceName} · eleven_flash_v2_5` : "browser default"}
          </span>
        </div>
        <p
          className="text-[10.5px] leading-relaxed"
          style={{ color: "var(--color-bone-faint)" }}
        >
          {neuralVoice
            ? "Pinned voice and model, identical for every subject on every device. Fallbacks are sentences the browser had to speak because synthesis was unavailable — the subject heard a different voice for those."
            : "Browser synthesis varies by operating system and browser version, so two subjects will not hear the same instrument."}
        </p>
      </section>

      <div className="hairline" />

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="stamp stamp-lit">Echo suppression</span>
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{
              color:
                echoSuppressed > 0 ? "var(--color-rust)" : "var(--color-bone-faint)",
            }}
          >
            {String(echoSuppressed).padStart(2, "0")} dropped
          </span>
        </div>
        <p
          className="text-[10.5px] leading-relaxed"
          style={{ color: "var(--color-bone-faint)" }}
        >
          Transcripts discarded as the agent&rsquo;s own voice returning through the
          microphone. Counted rather than dropped silently — a rising number means
          the subject is on speakers and the channel is not trustworthy.
        </p>
      </section>

      <div className="hairline" />

      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <span className="stamp stamp-lit">Tool calls</span>
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: "var(--color-bone-faint)" }}
          >
            {String(toolCalls.length).padStart(2, "0")}
          </span>
        </div>

        {toolCalls.length === 0 ? (
          <p
            className="border border-dashed px-3 py-2.5 text-[11.5px]"
            style={{
              borderColor: "var(--color-line)",
              color: "var(--color-bone-faint)",
            }}
          >
            No tool calls yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {toolCalls.map((call) => (
              <details
                key={call.id}
                className="stamp-in border-l-2 pl-3"
                style={{
                  borderColor: call.isError
                    ? "var(--color-oxide)"
                    : "var(--color-amber-deep)",
                }}
              >
                <summary className="flex cursor-pointer items-center gap-2 list-none">
                  <span
                    className="font-mono text-[12px] font-medium"
                    style={{
                      color: call.isError
                        ? "var(--color-oxide)"
                        : "var(--color-amber)",
                    }}
                  >
                    {call.name}
                  </span>
                  <span
                    className={`pip ${call.result === null ? "pip-live" : "pip-idle"}`}
                  />
                  <span
                    className="ml-auto font-mono text-[9.5px] tabular-nums"
                    style={{ color: "var(--color-bone-faint)" }}
                  >
                    {new Date(call.at).toLocaleTimeString("en-US", { hour12: false })}
                  </span>
                </summary>

                <div className="mt-2 flex flex-col gap-2">
                  <div>
                    <div className="stamp mb-1">Input</div>
                    <pre
                      className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.5]"
                      style={{ color: "var(--color-bone-dim)" }}
                    >
                      {preview(call.input)}
                    </pre>
                  </div>
                  {call.result !== null ? (
                    <div>
                      <div className="stamp mb-1">Result</div>
                      <pre
                        className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.5]"
                        style={{ color: "var(--color-bone-faint)" }}
                      >
                        {preview(call.result)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
