"use client";

import type { SessionSnapshot } from "@/lib/store/session";
import { PROTOCOL } from "@/lib/clinical/protocol";

const GRADE_TONE: Record<number, { fg: string; bg: string; bd: string }> = {
  1: { fg: "var(--color-mint)", bg: "var(--color-mint-ghost)", bd: "#1d4433" },
  2: { fg: "var(--color-amber)", bg: "var(--color-amber-ghost)", bd: "#5c451c" },
  3: { fg: "var(--color-rust)", bg: "#33200c", bd: "#6b4416" },
  4: { fg: "var(--color-oxide)", bg: "var(--color-oxide-ghost)", bd: "#5c2320" },
  5: { fg: "var(--color-oxide)", bg: "var(--color-oxide-ghost)", bd: "#5c2320" },
};

function GradeChip({ grade }: { grade: number }) {
  const tone = GRADE_TONE[grade] ?? GRADE_TONE[1];
  return (
    <span
      className="font-mono text-[10px] font-semibold tracking-[0.1em] px-1.5 py-[3px]"
      style={{ color: tone.fg, background: tone.bg, border: `1px solid ${tone.bd}` }}
    >
      G{grade}
    </span>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="border border-dashed px-3 py-2.5 text-[11.5px] leading-relaxed"
      style={{ borderColor: "var(--color-line)", color: "var(--color-bone-faint)" }}
    >
      {children}
    </p>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="stamp stamp-lit">{title}</span>
        {count !== undefined ? (
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: "var(--color-bone-faint)" }}
          >
            {String(count).padStart(2, "0")}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function RecordPanel({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const events = snapshot?.adverseEvents ?? [];
  const screen = snapshot?.safetyScreen ?? null;
  const conMeds = snapshot?.conMeds ?? [];
  const adherence = snapshot?.adherence ?? null;

  return (
    <div className="flex flex-col gap-6 p-4">
      <Section title="Directed safety screen">
        {!screen || screen.items.length === 0 ? (
          <EmptyRow>
            Not yet administered. Asked before the symptom review, so a red flag
            surfaces in the first minute of the call rather than the fifth.
          </EmptyRow>
        ) : (
          <div className="stamp-in flex flex-col gap-1.5">
            {PROTOCOL.safetyScreen.map((item) => {
              const rec = screen.items.find((i) => i.itemId === item.id);
              const answered = rec !== undefined;
              const answer = rec?.answer ?? null;
              const positive = answer === true;
              const flagged = positive && item.redFlag;
              return (
                <div key={item.id} className="flex flex-col gap-0.5">
                  <div
                    className="flex items-center justify-between gap-3 border-l-2 pl-2.5 py-[3px]"
                    style={{
                      borderColor: flagged
                        ? "var(--color-oxide)"
                        : !answered
                          ? "var(--color-line)"
                          : "var(--color-line-lit)",
                    }}
                  >
                    <span
                      className="text-[12px] leading-snug"
                      style={{
                        color: flagged
                          ? "var(--color-bone)"
                          : answered
                            ? "var(--color-bone-dim)"
                            : "var(--color-bone-faint)",
                      }}
                    >
                      {item.label}
                    </span>
                    <span
                      className="font-mono text-[9.5px] font-semibold tracking-[0.12em] px-1.5 py-[2px] shrink-0"
                      style={
                        !answered
                          ? {
                              color: "var(--color-bone-faint)",
                              border: "1px dashed var(--color-line)",
                            }
                          : answer === null
                            ? {
                                color: "var(--color-bone-faint)",
                                border: "1px solid var(--color-line)",
                              }
                            : flagged
                              ? {
                                  color: "var(--color-oxide)",
                                  background: "var(--color-oxide-ghost)",
                                  border: "1px solid #5c2320",
                                }
                              : positive
                                ? {
                                    color: "var(--color-rust)",
                                    background: "#33200c",
                                    border: "1px solid #6b4416",
                                  }
                                : {
                                    color: "var(--color-mint)",
                                    background: "var(--color-mint-ghost)",
                                    border: "1px solid #1d4433",
                                  }
                      }
                    >
                      {!answered
                        ? "PENDING"
                        : answer === null
                          ? "N/A"
                          : positive
                            ? "YES"
                            : "NO"}
                    </span>
                  </div>
                  {rec?.verbatim ? (
                    <p
                      className="pl-2.5 text-[11.5px] italic leading-[1.45]"
                      style={{ color: "var(--color-bone-faint)" }}
                    >
                      &ldquo;{rec.verbatim}&rdquo;
                    </p>
                  ) : null}
                </div>
              );
            })}

            <p
              className="mt-1 text-[10.5px] leading-relaxed"
              style={{ color: "var(--color-bone-faint)" }}
            >
              {screen.positiveRedFlags.length > 0
                ? `${screen.positiveRedFlags.length} red flag${screen.positiveRedFlags.length > 1 ? "s" : ""} — each escalated the moment it was answered, without model judgment.`
                : "Each item is recorded as it is answered. A yes escalates deterministically."}
            </p>
          </div>
        )}
      </Section>

      <div className="hairline" />

      <Section title="Adverse events" count={events.length}>
        {events.length === 0 ? (
          <EmptyRow>
            Nothing captured yet. Events are written the moment the agent has
            enough to grade them, not batched at the end of the call.
          </EmptyRow>
        ) : (
          <div className="flex flex-col gap-2.5">
            {events.map((e) => (
              <article
                key={e.id}
                className="stamp-in border-l-2 pl-3"
                style={{
                  borderColor:
                    e.grade >= 3 ? "var(--color-oxide)" : "var(--color-line-lit)",
                }}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span
                    className="font-mono text-[10px]"
                    style={{ color: "var(--color-bone-faint)" }}
                  >
                    {e.id}
                  </span>
                  <GradeChip grade={e.grade} />
                  {e.spontaneous ? (
                    <span
                      className="stamp"
                      style={{ color: "var(--color-slate-signal)" }}
                    >
                      Spontaneous
                    </span>
                  ) : null}
                  {e.seriousness?.isSerious ? (
                    <span
                      className="font-mono text-[9.5px] font-semibold tracking-[0.14em] px-1.5 py-[2px]"
                      style={{
                        color: "var(--color-oxide)",
                        background: "var(--color-oxide-ghost)",
                        border: "1px solid #5c2320",
                      }}
                    >
                      SAE
                    </span>
                  ) : null}
                </div>

                <h4
                  className="text-[13.5px] font-medium leading-snug"
                  style={{ color: "var(--color-bone)" }}
                >
                  {e.codedTerm}
                </h4>

                <p
                  className="mt-1 text-[12px] italic leading-[1.5]"
                  style={{ color: "var(--color-bone-dim)" }}
                >
                  &ldquo;{e.verbatimTerm}&rdquo;
                </p>

                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="stamp pt-[2px]">Onset</dt>
                  <dd
                    className="text-[11.5px]"
                    style={{ color: "var(--color-bone-dim)" }}
                  >
                    {e.onsetDescription} {e.ongoing ? "· ongoing" : "· resolved"}
                  </dd>
                  <dt className="stamp pt-[2px]">Basis</dt>
                  <dd
                    className="text-[11.5px] leading-[1.5]"
                    style={{ color: "var(--color-bone-dim)" }}
                  >
                    {e.gradeRationale}
                  </dd>
                  {e.seriousness?.isSerious ? (
                    <>
                      <dt className="stamp pt-[2px]">Criteria</dt>
                      <dd
                        className="text-[11.5px] leading-[1.5]"
                        style={{ color: "var(--color-oxide)" }}
                      >
                        {e.seriousness.criteria.join(", ")}
                      </dd>
                      <dt className="stamp pt-[2px]">Report</dt>
                      <dd
                        className="text-[11px] leading-[1.5]"
                        style={{ color: "var(--color-bone-faint)" }}
                      >
                        {e.seriousness.indSafetyReportNote}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </article>
            ))}
          </div>
        )}
      </Section>

      <div className="hairline" />

      <Section title="Study drug adherence">
        {!adherence ? (
          <EmptyRow>Not yet collected.</EmptyRow>
        ) : (
          <div className="stamp-in flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <span
                className="font-display text-[26px] leading-none"
                style={{
                  color:
                    adherence.dosesMissedSinceLastCheckIn > 0
                      ? "var(--color-rust)"
                      : "var(--color-mint)",
                }}
              >
                {adherence.dosesMissedSinceLastCheckIn}
              </span>
              <span className="stamp">doses missed since last check-in</span>
            </div>
            {adherence.reasonVerbatim ? (
              <p
                className="text-[12px] italic leading-[1.5]"
                style={{ color: "var(--color-bone-dim)" }}
              >
                &ldquo;{adherence.reasonVerbatim}&rdquo;
              </p>
            ) : null}
          </div>
        )}
      </Section>

      <div className="hairline" />

      <Section title="New concomitant meds" count={conMeds.length}>
        {conMeds.length === 0 ? (
          <EmptyRow>None reported.</EmptyRow>
        ) : (
          <div className="flex flex-col gap-2">
            {conMeds.map((m) => (
              <div key={m.id} className="stamp-in flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span
                    className="font-mono text-[10px]"
                    style={{ color: "var(--color-bone-faint)" }}
                  >
                    {m.id}
                  </span>
                  <span
                    className="text-[13px] font-medium"
                    style={{ color: "var(--color-bone)" }}
                  >
                    {m.name}
                  </span>
                </div>
                <p
                  className="text-[11.5px] italic"
                  style={{ color: "var(--color-bone-dim)" }}
                >
                  &ldquo;{m.indicationVerbatim}&rdquo; · started {m.startedDescription}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {snapshot?.summary ? (
        <>
          <div className="hairline" />
          <Section title="Coordinator summary">
            <p
              className="stamp-in border-l-2 pl-3 text-[12.5px] leading-[1.6]"
              style={{
                color: "var(--color-bone)",
                borderColor: "var(--color-amber-deep)",
              }}
            >
              {snapshot.summary}
            </p>
          </Section>
        </>
      ) : null}
    </div>
  );
}
