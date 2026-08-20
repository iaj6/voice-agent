"use client";

import type { SafetyNetHit } from "@/lib/clinical/safety";
import type { SessionSnapshot } from "@/lib/store/session";

const URGENCY_TONE: Record<string, { fg: string; bg: string; bd: string }> = {
  emergency: {
    fg: "var(--color-oxide)",
    bg: "var(--color-oxide-ghost)",
    bd: "#5c2320",
  },
  urgent: { fg: "var(--color-rust)", bg: "#33200c", bd: "#6b4416" },
  routine: {
    fg: "var(--color-slate-signal)",
    bg: "#101a26",
    bd: "#26384c",
  },
};

function clockOf(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function SafetyPanel({
  snapshot,
  hits,
}: {
  snapshot: SessionSnapshot | null;
  hits: SafetyNetHit[];
}) {
  const escalations = snapshot?.escalations ?? [];

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <span className="stamp stamp-lit">Deterministic safety net</span>
          <span
            className="font-mono text-[10px]"
            style={{ color: "var(--color-bone-faint)" }}
          >
            {hits.length > 0 ? "TRIPPED" : "ARMED"}
          </span>
        </div>

        <p
          className="text-[11px] leading-[1.6]"
          style={{ color: "var(--color-bone-faint)" }}
        >
          Rule-based scan over every subject utterance, executed before the model
          sees it. Independent of model judgment, and not suppressible by anything
          said on the call.
        </p>

        {hits.length === 0 ? (
          <div
            className="flex items-center gap-2 border px-3 py-2.5"
            style={{ borderColor: "#1d4433", background: "var(--color-mint-ghost)" }}
          >
            <span className="pip pip-live" />
            <span
              className="font-mono text-[11px] tracking-wide"
              style={{ color: "var(--color-mint)" }}
            >
              No rule matched this call
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {hits.map((hit, i) => {
              const tone = URGENCY_TONE[hit.urgency] ?? URGENCY_TONE.routine;
              return (
                <div
                  key={`${hit.category}-${i}`}
                  className="stamp-in border px-3 py-2.5"
                  style={{ borderColor: tone.bd, background: tone.bg }}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="pip pip-alarm" />
                    <span
                      className="font-mono text-[9.5px] font-semibold tracking-[0.16em] uppercase"
                      style={{ color: tone.fg }}
                    >
                      {hit.urgency}
                    </span>
                  </div>
                  <p
                    className="text-[12.5px] font-medium leading-snug"
                    style={{ color: "var(--color-bone)" }}
                  >
                    {hit.category}
                  </p>
                  <p className="mt-1 font-mono text-[11px]" style={{ color: tone.fg }}>
                    matched &ldquo;{hit.matchedPhrase}&rdquo;
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="hairline" />

      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <span className="stamp stamp-lit">Escalations</span>
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: "var(--color-bone-faint)" }}
          >
            {String(escalations.length).padStart(2, "0")}
          </span>
        </div>

        {escalations.length === 0 ? (
          <p
            className="border border-dashed px-3 py-2.5 text-[11.5px] leading-relaxed"
            style={{
              borderColor: "var(--color-line)",
              color: "var(--color-bone-faint)",
            }}
          >
            None. Escalations arrive from two independent paths — the rule net
            above, and the agent&rsquo;s own judgment.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {escalations.map((esc) => {
              const tone = URGENCY_TONE[esc.urgency] ?? URGENCY_TONE.routine;
              return (
                <article
                  key={esc.id}
                  className="stamp-in border-l-2 pl-3"
                  style={{ borderColor: tone.fg }}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span
                      className="font-mono text-[10px]"
                      style={{ color: "var(--color-bone-faint)" }}
                    >
                      {esc.id}
                    </span>
                    <span
                      className="font-mono text-[9.5px] font-semibold tracking-[0.14em] uppercase px-1.5 py-[2px]"
                      style={{
                        color: tone.fg,
                        background: tone.bg,
                        border: `1px solid ${tone.bd}`,
                      }}
                    >
                      {esc.urgency}
                    </span>
                    <span
                      className="stamp"
                      style={{
                        color:
                          esc.triggeredBy === "safety_net"
                            ? "var(--color-oxide)"
                            : "var(--color-bone-faint)",
                      }}
                    >
                      via {esc.triggeredBy === "safety_net" ? "rule net" : "agent"}
                    </span>
                    <span
                      className="ml-auto font-mono text-[9.5px] tabular-nums"
                      style={{ color: "var(--color-bone-faint)" }}
                    >
                      {clockOf(esc.createdAt)}
                    </span>
                  </div>

                  <p
                    className="text-[12px] leading-[1.55]"
                    style={{ color: "var(--color-bone-dim)" }}
                  >
                    {esc.reason}
                  </p>

                  {esc.sponsorNotificationDeadline ? (
                    <p className="stamp mt-1.5" style={{ color: "var(--color-rust)" }}>
                      Sponsor notification due{" "}
                      {new Date(esc.sponsorNotificationDeadline).toLocaleString(
                        "en-US",
                        { dateStyle: "medium", timeStyle: "short" },
                      )}
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
