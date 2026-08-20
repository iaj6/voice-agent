"use client";

import type { SessionSnapshot } from "@/lib/store/session";

const ACTOR_TONE: Record<string, string> = {
  subject: "var(--color-bone-dim)",
  agent: "var(--color-amber)",
  system: "var(--color-slate-signal)",
  safety_net: "var(--color-oxide)",
};

export function AuditPanel({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const entries = snapshot?.audit ?? [];
  const valid = snapshot?.auditChainValid ?? true;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <span className="stamp stamp-lit">Audit trail</span>
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: "var(--color-bone-faint)" }}
          >
            {String(entries.length).padStart(3, "0")} entries
          </span>
        </div>

        <p
          className="text-[11px] leading-[1.6]"
          style={{ color: "var(--color-bone-faint)" }}
        >
          Append-only, hash-chained. Each entry commits to its predecessor, so a
          retroactive edit anywhere breaks verification. Models the 21 CFR 11.10(e)
          audit-trail requirement.
        </p>

        <div
          className="flex items-center gap-2 border px-3 py-2"
          style={{
            borderColor: valid ? "#1d4433" : "#5c2320",
            background: valid ? "var(--color-mint-ghost)" : "var(--color-oxide-ghost)",
          }}
        >
          <span className={`pip ${valid ? "pip-live" : "pip-alarm"}`} />
          <span
            className="font-mono text-[11px] tracking-wide"
            style={{ color: valid ? "var(--color-mint)" : "var(--color-oxide)" }}
          >
            {valid ? "Chain intact" : "Chain broken — record compromised"}
          </span>
        </div>
      </div>

      <div className="hairline" />

      {entries.length === 0 ? (
        <p
          className="border border-dashed px-3 py-2.5 text-[11.5px]"
          style={{
            borderColor: "var(--color-line)",
            color: "var(--color-bone-faint)",
          }}
        >
          No entries yet.
        </p>
      ) : (
        <ol className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.hash}
              className="line-in grid grid-cols-[26px_1fr] gap-3 border-l py-2.5 pl-3"
              style={{ borderColor: "var(--color-line)" }}
            >
              <span
                className="font-mono text-[10px] tabular-nums pt-[2px]"
                style={{ color: "var(--color-bone-faint)" }}
              >
                {String(entry.seq).padStart(3, "0")}
              </span>

              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span
                    className="font-mono text-[11.5px] font-semibold tracking-wide"
                    style={{ color: ACTOR_TONE[entry.actor] ?? "var(--color-bone)" }}
                  >
                    {entry.action}
                  </span>
                  <span className="stamp">{entry.actor}</span>
                  {entry.entityId ? (
                    <span
                      className="font-mono text-[10px]"
                      style={{ color: "var(--color-bone-faint)" }}
                    >
                      {entry.entityId}
                    </span>
                  ) : null}
                  <span
                    className="ml-auto font-mono text-[9.5px] tabular-nums"
                    style={{ color: "var(--color-bone-faint)", opacity: 0.6 }}
                  >
                    {new Date(entry.timestamp).toLocaleTimeString("en-US", {
                      hour12: false,
                    })}
                  </span>
                </div>

                <p
                  className="mt-0.5 text-[11.5px] leading-[1.5]"
                  style={{ color: "var(--color-bone-dim)" }}
                >
                  {entry.reason}
                </p>

                <div
                  className="mt-1 flex items-center gap-1.5 font-mono text-[9.5px]"
                  style={{ color: "var(--color-bone-faint)", opacity: 0.65 }}
                >
                  <span title={`prev: ${entry.prevHash}`}>
                    ←{entry.prevHash.slice(0, 8)}
                  </span>
                  <span style={{ color: "var(--color-line-lit)" }}>·</span>
                  <span
                    title={`hash: ${entry.hash}`}
                    style={{ color: "var(--color-amber-deep)" }}
                  >
                    {entry.hash.slice(0, 12)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
