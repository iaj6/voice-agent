"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useVoiceAgent } from "@/hooks/useVoiceAgent";
import { CarrierTrace } from "./CarrierTrace";
import { CallOrb } from "./CallOrb";
import { Transcript } from "./Transcript";
import { SubjectPanel } from "./SubjectPanel";
import { RecordPanel } from "./RecordPanel";
import { SafetyPanel } from "./SafetyPanel";
import { AuditPanel } from "./AuditPanel";
import { ActivityPanel } from "./ActivityPanel";

export interface ProtocolInfo {
  protocolId: string;
  shortTitle: string;
  title: string;
  phase: string;
  sponsor: string;
  investigationalProduct: string;
  solicitedSymptoms: string[];
}

type Tab = "record" | "safety" | "audit" | "activity";

const TABS: { id: Tab; label: string }[] = [
  { id: "record", label: "Record" },
  { id: "safety", label: "Safety" },
  { id: "audit", label: "Audit" },
  { id: "activity", label: "Activity" },
];

export function Console({ protocol }: { protocol: ProtocolInfo }) {
  const agent = useVoiceAgent();
  const [tab, setTab] = useState<Tab>("record");
  const [typed, setTyped] = useState("");

  const alarm = useMemo(
    () =>
      agent.safetyHits.some((h) => h.urgency === "emergency") ||
      (agent.snapshot?.escalations ?? []).some((e) => e.urgency === "emergency"),
    [agent.safetyHits, agent.snapshot],
  );

  const escalationCount = agent.snapshot?.escalations.length ?? 0;
  const eventCount = agent.snapshot?.adverseEvents.length ?? 0;
  const callActive = agent.state !== "idle" && agent.state !== "ended";

  const badgeFor = (id: Tab) => {
    if (id === "record" && eventCount > 0) return eventCount;
    if (id === "safety" && escalationCount > 0) return escalationCount;
    if (id === "activity" && agent.toolCalls.length > 0) return agent.toolCalls.length;
    return null;
  };

  function onTypedSubmit(e: FormEvent) {
    e.preventDefault();
    if (!typed.trim() || !callActive) return;
    agent.sendTyped(typed);
    setTyped("");
  }

  return (
    <div
      className={`flex h-dvh flex-col overflow-hidden ${alarm ? "chassis-alarm" : ""}`}
    >
      {/* ---------------- Masthead ---------------- */}
      <header
        className="rise shrink-0 border-b"
        style={{ borderColor: "var(--color-line)", background: "var(--color-ink-000)" }}
      >
        <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-3 pt-5">
          <div className="flex items-end gap-4">
            <h1
              className="font-display text-[30px] leading-none tracking-tight"
              style={{ color: "var(--color-bone)" }}
            >
              {protocol.protocolId}
            </h1>
            <div className="flex flex-col gap-1 pb-[3px]">
              <span className="stamp">Voice Check-In Console</span>
              <span
                className="text-[11.5px] leading-none"
                style={{ color: "var(--color-bone-faint)" }}
              >
                {protocol.phase} · {protocol.sponsor}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-5">
            <div className="flex flex-col items-end gap-1">
              <span className="stamp">Session</span>
              <span
                className="font-mono text-[11px]"
                style={{ color: "var(--color-bone-dim)" }}
              >
                {agent.sessionId ? agent.sessionId.slice(0, 8) : "—"}
              </span>
            </div>

            <div className="flex flex-col items-end gap-1">
              <span className="stamp">Status</span>
              <span
                className="font-mono text-[11px] uppercase tracking-wider"
                style={{
                  color: alarm
                    ? "var(--color-oxide)"
                    : agent.snapshot?.status === "completed"
                      ? "var(--color-mint)"
                      : "var(--color-bone-dim)",
                }}
              >
                {agent.snapshot?.status.replace(/_/g, " ") ?? "no session"}
              </span>
            </div>

            {callActive ? (
              <button className="btn btn-danger focus-ring" onClick={agent.endCall}>
                End call
              </button>
            ) : (
              <button
                className="btn btn-primary focus-ring"
                onClick={agent.startCall}
                disabled={agent.state === "connecting"}
              >
                {agent.state === "connecting" ? "Connecting…" : "Start check-in"}
              </button>
            )}
          </div>
        </div>

        <CarrierTrace state={agent.state} alarm={alarm} />
      </header>

      {/* ---------------- Alerts ---------------- */}
      {!agent.micSupported ? (
        <div
          className="border-b px-6 py-2.5 text-[12px]"
          style={{
            borderColor: "#5c4416",
            background: "var(--color-amber-ghost)",
            color: "var(--color-amber)",
          }}
        >
          This browser has no Web Speech recognition. Chrome or Edge is required for
          the microphone — you can still drive the call with the text input below.
        </div>
      ) : null}

      {agent.error ? (
        <div
          className="flex items-center justify-between gap-4 border-b px-6 py-2.5 text-[12px]"
          style={{
            borderColor: "#5c2320",
            background: "var(--color-oxide-ghost)",
            color: "var(--color-oxide)",
          }}
        >
          <span>{agent.error}</span>
          <button
            className="stamp focus-ring shrink-0"
            style={{ color: "var(--color-oxide)" }}
            onClick={agent.clearError}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* ---------------- Console body ---------------- */}
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-hidden lg:grid-cols-[290px_minmax(0,1fr)_400px]">
        <aside
          className="rise hidden min-h-0 overflow-y-auto border-r lg:block"
          style={{ borderColor: "var(--color-line)", animationDelay: "80ms" }}
        >
          <SubjectPanel
            snapshot={agent.snapshot}
            protocolId={protocol.protocolId}
            protocolTitle={protocol.title}
            investigationalProduct={protocol.investigationalProduct}
          />
        </aside>

        {/* Center: the call itself */}
        <section
          className="rise flex min-h-0 flex-col overflow-hidden"
          style={{ animationDelay: "150ms" }}
        >
          <div
            className="flex shrink-0 items-center justify-center gap-10 border-b px-6 py-7"
            style={{ borderColor: "var(--color-line)" }}
          >
            <CallOrb state={agent.state} alarm={alarm} />

            <div className="flex max-w-xs flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="stamp stamp-lit">Solicited this visit</span>
                <div className="flex flex-wrap gap-1.5">
                  {protocol.solicitedSymptoms.map((term) => {
                    const done = (agent.snapshot?.solicitedReviewed ?? []).some(
                      (t) => t.toLowerCase() === term.toLowerCase(),
                    );
                    return (
                      <span
                        key={term}
                        className="font-mono text-[9.5px] tracking-wide px-1.5 py-[3px] transition-colors"
                        style={{
                          color: done ? "var(--color-mint)" : "var(--color-bone-faint)",
                          border: `1px solid ${done ? "#1d4433" : "var(--color-line)"}`,
                          background: done ? "var(--color-mint-ghost)" : "transparent",
                        }}
                      >
                        {term}
                      </span>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    className="focus-ring h-3 w-3 accent-[var(--color-amber)]"
                    checked={agent.bargeInEnabled}
                    onChange={(e) => agent.setBargeInEnabled(e.target.checked)}
                  />
                  <span className="stamp" style={{ color: "var(--color-bone-dim)" }}>
                    Barge-in
                  </span>
                </label>

                <label
                  className={`flex items-center gap-2.5 ${
                    callActive ? "cursor-not-allowed opacity-45" : "cursor-pointer"
                  }`}
                  title={
                    callActive
                      ? "The voice is fixed for the duration of a call."
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    className="focus-ring h-3 w-3 accent-[var(--color-amber)]"
                    checked={agent.neuralVoice}
                    disabled={callActive}
                    onChange={(e) => agent.setNeuralVoice(e.target.checked)}
                  />
                  <span className="stamp" style={{ color: "var(--color-bone-dim)" }}>
                    Neural voice · {agent.voiceName}
                  </span>
                  {agent.voiceFallbacks > 0 ? (
                    <span
                      className="font-mono text-[9px] px-1 py-[1px]"
                      style={{
                        color: "var(--color-rust)",
                        border: "1px solid #6b4416",
                      }}
                      title="Sentences spoken by the browser because synthesis was unavailable"
                    >
                      {agent.voiceFallbacks} fallback
                    </span>
                  ) : null}
                </label>
              </div>
              <p
                className="text-[10.5px] leading-relaxed"
                style={{ color: "var(--color-bone-faint)" }}
              >
                {agent.bargeInEnabled
                  ? "Headphones required. On speakers the mic hears the agent's own voice and captures it as the subject."
                  : "Half-duplex: the mic closes while the agent speaks. Cannot echo, but you cannot interrupt."}
              </p>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            <Transcript lines={agent.transcript} interim={agent.interim} />
          </div>

          <form
            onSubmit={onTypedSubmit}
            className="flex shrink-0 items-center gap-2 border-t px-4 py-3"
            style={{ borderColor: "var(--color-line)" }}
          >
            <span className="stamp shrink-0">Type</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={!callActive}
              placeholder={
                callActive
                  ? "Speak, or type here to stand in for the subject…"
                  : "Start a check-in to open the channel"
              }
              className="focus-ring min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[13px] outline-none disabled:opacity-40"
              style={{ color: "var(--color-bone)" }}
            />
            <button
              type="submit"
              className="btn focus-ring shrink-0"
              disabled={!callActive || !typed.trim()}
            >
              Send
            </button>
          </form>
        </section>

        {/* Right: the record being built */}
        <aside
          className="rise flex min-h-0 flex-col overflow-hidden border-l"
          style={{ borderColor: "var(--color-line)", animationDelay: "220ms" }}
        >
          <div
            className="flex shrink-0"
            style={{
              borderBottom: "1px solid var(--color-line)",
              background: "var(--color-ink-000)",
            }}
          >
            {TABS.map((t) => {
              const active = tab === t.id;
              const badge = badgeFor(t.id);
              const isAlarmTab = t.id === "safety" && escalationCount > 0;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className="focus-ring relative flex flex-1 items-center justify-center gap-1.5 py-3 transition-colors"
                  style={{
                    color: active
                      ? isAlarmTab
                        ? "var(--color-oxide)"
                        : "var(--color-amber)"
                      : "var(--color-bone-faint)",
                    borderBottom: active
                      ? `1px solid ${isAlarmTab ? "var(--color-oxide)" : "var(--color-amber)"}`
                      : "1px solid transparent",
                    marginBottom: "-1px",
                  }}
                >
                  <span className="stamp" style={{ color: "inherit" }}>
                    {t.label}
                  </span>
                  {badge !== null ? (
                    <span
                      className="font-mono text-[9px] tabular-nums px-1 py-[1px]"
                      style={{
                        color: isAlarmTab ? "var(--color-oxide)" : "var(--color-bone-dim)",
                        border: `1px solid ${isAlarmTab ? "#5c2320" : "var(--color-line-lit)"}`,
                      }}
                    >
                      {badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "record" ? (
              <RecordPanel snapshot={agent.snapshot} />
            ) : tab === "safety" ? (
              <SafetyPanel snapshot={agent.snapshot} hits={agent.safetyHits} />
            ) : tab === "audit" ? (
              <AuditPanel snapshot={agent.snapshot} />
            ) : (
              <ActivityPanel
                toolCalls={agent.toolCalls}
                usage={agent.usage}
                echoSuppressed={agent.echoSuppressed}
                voiceFallbacks={agent.voiceFallbacks}
                voiceName={agent.voiceName}
                neuralVoice={agent.neuralVoice}
              />
            )}
          </div>
        </aside>
      </main>

      <footer
        className="shrink-0 border-t px-6 py-2.5"
        style={{ borderColor: "var(--color-line)", background: "var(--color-ink-000)" }}
      >
        <p className="stamp" style={{ color: "var(--color-bone-faint)" }}>
          Prototype · synthetic protocol and subjects · not a validated system ·
          no PHI
        </p>
      </footer>
    </div>
  );
}
