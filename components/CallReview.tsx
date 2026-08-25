"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Detail {
  call: {
    id: string;
    createdAt: string;
    completedAt: string | null;
    status: string;
    synthetic: boolean;
    shredded: boolean;
    subject: { subjectId?: string } | null;
    verificationAttempts: number;
    provenanceRejections: number;
    summary: string | null;
  };
  reasons: { kind: string; detail: string }[];
  saidByParticipant: string[];
  record: {
    adverseEvents: {
      verbatimTerm: string;
      codedTerm: string;
      grade: number;
      gradeRationale: string;
      spontaneous: boolean;
      seriousness: { isSerious?: boolean } | null;
    }[];
    safetyScreen: { items: { itemId: string; answer: boolean | null; verbatim: string | null }[] } | null;
    adherence: { dosesMissedSinceLastCheckIn: number; reasonVerbatim: string | null } | null;
    conMeds: { name: string; indicationVerbatim: string }[];
    escalations: { urgency: string; reason: string; triggeredBy: string }[];
  };
  auditChain: { valid: boolean; detail?: string; brokenAtSeq?: number };
  audit: { seq: number; action: string; entity: string; reason: string; timestamp: string }[];
  latency: { turnIndex: number; firstAudioMs: number | null; firstSentenceMs: number | null }[];
}

/**
 * Sealed *strings* come back as these; sealed arrays come back empty.
 *
 * Which is why the call's own `shredded` flag decides the banner rather than the
 * contents of the transcript: an erased transcript and an absent one look
 * identical from here, and guessing wrong tells a reviewer a completed call
 * never got past verification.
 */
const SHRED_MARKERS = ["[destroyed]", "[unreadable]"];
const isShredded = (v: string | null) => v !== null && SHRED_MARKERS.includes(v);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <span className="stamp stamp-lit">{title}</span>
      {children}
    </section>
  );
}

export function CallReview({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/review/${id}`)
      .then((r) => r.json())
      .then((d) => (d.error ? Promise.reject(new Error(d.error)) : setData(d)))
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  if (error) {
    return (
      <p className="p-6 text-[12px]" style={{ color: "var(--color-oxide)" }}>
        {error}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="p-6 text-[12px]" style={{ color: "var(--color-bone-faint)" }}>
        Loading…
      </p>
    );
  }

  const shredded = data.call.shredded;

  return (
    <div className="min-h-screen" style={{ background: "var(--color-ink-000)" }}>
      <header
        className="flex flex-wrap items-baseline gap-3 border-b px-6 py-4"
        style={{ borderColor: "var(--color-line)" }}
      >
        <span className="stamp stamp-lit">Call review</span>
        <Link href="/review" className="text-[11px] underline" style={{ color: "var(--color-bone-faint)" }}>
          back to queue
        </Link>
        <span className="ml-auto font-mono text-[10px] tabular-nums" style={{ color: "var(--color-bone-faint)" }}>
          {new Date(data.call.createdAt).toLocaleString()} · {data.call.status}
          {data.call.synthetic ? " · EVAL" : ""}
        </span>
      </header>

      {/* The chain first, because a record whose audit trail does not hash is a
          record nobody can sign off on, and that has to be seen before the
          content rather than after it. */}
      {!data.auditChain.valid ? (
        <div
          className="border-b px-6 py-3 text-[12px]"
          style={{ borderColor: "var(--color-oxide)", color: "var(--color-oxide)" }}
        >
          The audit chain for this call does not verify
          {data.auditChain.brokenAtSeq !== undefined ? ` at entry ${data.auditChain.brokenAtSeq}` : ""}.
          Do not sign off on this record.
        </div>
      ) : null}

      {shredded ? (
        <div
          className="border-b px-6 py-3 text-[11.5px] leading-relaxed"
          style={{ borderColor: "var(--color-line)", color: "var(--color-bone-dim)" }}
        >
          This participant&rsquo;s key has been destroyed, so everything they said is
          gone. The structured record below survives by design — grades, item ids
          and timestamps sit outside the seal — which is what keeps the trial data
          reportable after an erasure request.
        </div>
      ) : null}

      <main className="grid gap-6 px-6 py-5 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Section title="What the participant said">
            {data.saidByParticipant.length === 0 ? (
              <p className="text-[11.5px]" style={{ color: "var(--color-bone-faint)" }}>
                {shredded
                  ? "Erased at this participant's request. The structured record below is what survives."
                  : "Nothing recorded — the call did not get past verification."}
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {data.saidByParticipant.map((utterance, i) => (
                  <li
                    key={i}
                    className="border-l-2 pl-3 text-[12px] leading-relaxed"
                    style={{
                      borderColor: "var(--color-line-lit)",
                      color: isShredded(utterance)
                        ? "var(--color-bone-faint)"
                        : "var(--color-bone)",
                      fontStyle: isShredded(utterance) ? "italic" : undefined,
                    }}
                  >
                    {utterance}
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Turn latency">
            {data.latency.length === 0 ? (
              <p className="text-[11px]" style={{ color: "var(--color-bone-faint)" }}>
                No timings recorded for this call.
              </p>
            ) : (
              <table className="w-full text-[10.5px] tabular-nums">
                <thead style={{ color: "var(--color-bone-faint)" }}>
                  <tr className="text-left">
                    <th className="font-normal">turn</th>
                    <th className="font-normal">to first audio</th>
                    <th className="font-normal">to first sentence</th>
                  </tr>
                </thead>
                <tbody style={{ color: "var(--color-bone-dim)" }}>
                  {data.latency.map((t) => (
                    <tr key={t.turnIndex}>
                      <td>{t.turnIndex}</td>
                      <td
                        style={{
                          color:
                            t.firstAudioMs !== null && t.firstAudioMs > 2000
                              ? "var(--color-rust)"
                              : undefined,
                        }}
                      >
                        {t.firstAudioMs === null ? "—" : `${t.firstAudioMs} ms`}
                      </td>
                      <td>{t.firstSentenceMs === null ? "—" : `${t.firstSentenceMs} ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>

        <div className="flex flex-col gap-6">
          {data.reasons.length ? (
            <Section title="Why this is in the queue">
              <ul className="flex flex-col gap-1">
                {data.reasons.map((r, i) => (
                  <li key={i} className="text-[11.5px]" style={{ color: "var(--color-amber)" }}>
                    {r.detail}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="What was recorded">
            {data.record.adverseEvents.length === 0 ? (
              <p className="text-[11.5px]" style={{ color: "var(--color-bone-faint)" }}>
                No adverse events.
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {data.record.adverseEvents.map((e, i) => (
                  <li key={i} className="border px-3 py-2" style={{ borderColor: "var(--color-line)" }}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-[12px]" style={{ color: "var(--color-bone)" }}>
                        {e.codedTerm}
                      </span>
                      <span
                        className="font-mono text-[10px]"
                        style={{
                          color: e.grade >= 3 ? "var(--color-rust)" : "var(--color-bone-faint)",
                        }}
                      >
                        grade {e.grade}
                        {e.seriousness?.isSerious ? " · SERIOUS" : ""}
                        {e.spontaneous ? " · spontaneous" : ""}
                      </span>
                    </div>
                    {/* The subject's own words next to the coded term, because
                        coding replacing the source is the failure this record
                        is shaped to prevent. */}
                    <p
                      className="mt-1 text-[11px] italic leading-relaxed"
                      style={{ color: "var(--color-bone-dim)" }}
                    >
                      &ldquo;{e.verbatimTerm}&rdquo;
                    </p>
                    <p className="mt-1 text-[10.5px]" style={{ color: "var(--color-bone-faint)" }}>
                      {e.gradeRationale}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {data.record.safetyScreen ? (
            <Section title="Safety screen">
              <ul className="flex flex-col gap-1">
                {data.record.safetyScreen.items.map((item) => (
                  <li key={item.itemId} className="flex items-baseline gap-2 text-[11px]">
                    <span
                      className="font-mono"
                      style={{
                        color:
                          item.answer === true
                            ? "var(--color-rust)"
                            : item.answer === null
                              ? "var(--color-bone-faint)"
                              : "var(--color-mint)",
                      }}
                    >
                      {item.answer === true ? "YES" : item.answer === null ? "N/A" : " NO"}
                    </span>
                    <span style={{ color: "var(--color-bone-dim)" }}>{item.itemId}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {data.record.escalations.length ? (
            <Section title="Escalations">
              <ul className="flex flex-col gap-1.5">
                {data.record.escalations.map((e, i) => (
                  <li key={i} className="text-[11.5px]" style={{ color: "var(--color-bone-dim)" }}>
                    <span
                      className="font-mono text-[10px]"
                      style={{ color: "var(--color-rust)" }}
                    >
                      {e.urgency.toUpperCase()}
                    </span>{" "}
                    {e.reason}{" "}
                    <span style={{ color: "var(--color-bone-faint)" }}>({e.triggeredBy})</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="Audit trail">
            <p className="mb-1 text-[10.5px]" style={{ color: "var(--color-bone-faint)" }}>
              {data.audit.length} entries, chain{" "}
              {data.auditChain.valid ? "verified" : "BROKEN"}.
            </p>
            <ol className="flex flex-col gap-0.5">
              {data.audit.map((entry) => (
                <li
                  key={entry.seq}
                  className="font-mono text-[10px]"
                  style={{ color: "var(--color-bone-faint)" }}
                >
                  {String(entry.seq).padStart(2, "0")} {entry.action} {entry.entity}
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </main>
    </div>
  );
}
