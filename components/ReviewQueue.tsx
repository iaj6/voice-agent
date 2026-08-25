"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReviewReason, ReviewReasonKind } from "@/lib/review/queue";

interface QueueRow {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: string;
  verified: boolean;
  synthetic: boolean;
  events: number;
  escalations: number;
  screenAnswered: number;
  reasons: ReviewReason[];
}

/** Worst reasons wear the loudest colour; the rest stay quiet on purpose. */
const TONE: Record<ReviewReasonKind, string> = {
  emergency_escalation: "var(--color-oxide)",
  urgent_escalation: "var(--color-rust)",
  serious_event: "var(--color-rust)",
  high_grade_event: "var(--color-amber)",
  provenance_rejection: "var(--color-amber)",
  incomplete_screen: "var(--color-bone-dim)",
  dropped_call: "var(--color-bone-dim)",
  unverified: "var(--color-bone-faint)",
  routine_escalation: "var(--color-bone-dim)",
};

const LABEL: Record<ReviewReasonKind, string> = {
  emergency_escalation: "EMERGENCY",
  urgent_escalation: "URGENT",
  serious_event: "SERIOUS",
  high_grade_event: "GRADE 3+",
  provenance_rejection: "INVENTED QUOTE",
  incomplete_screen: "PARTIAL SCREEN",
  dropped_call: "DROPPED",
  unverified: "UNVERIFIED",
  routine_escalation: "ROUTINE",
};

export function ReviewQueue() {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [includeSynthetic, setIncludeSynthetic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [token, setToken] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams({ days: "30" });
    if (showAll) params.set("all", "1");
    if (includeSynthetic) params.set("synthetic", "1");

    // Guards against a slow earlier request landing after a fast later one and
    // repainting the queue with the wrong filter's results.
    let current = true;
    fetch(`/api/review?${params}`)
      .then(async (r) => {
        const data = await r.json();
        if (!current) return;
        if (r.status === 401) {
          setError(null);
          setNeedsToken(true);
          return;
        }
        if (data.error) throw new Error(data.error);
        // Cleared on success. Leaving it set meant one transient failure showed
        // a stale message forever, through every later successful refetch.
        setError(null);
        setNeedsToken(false);
        setRows(data.queue);
        setScanned(data.scanned);
      })
      .catch((e) => {
        if (current) setError(String(e.message ?? e));
      });
    return () => {
      current = false;
    };
  }, [showAll, includeSynthetic, attempt]);

  if (needsToken) {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        style={{ background: "var(--color-ink-000)" }}
      >
        <form
          className="flex w-80 flex-col gap-3 border p-5"
          style={{ borderColor: "var(--color-line)" }}
          onSubmit={(e) => {
            e.preventDefault();
            // Session cookie, not persistent: a review token left on disk on a
            // shared clinic machine is the same disclosure by a slower route.
            document.cookie = `voice_agent_review=${encodeURIComponent(token)}; path=/; SameSite=Strict`;
            setToken("");
            setAttempt((n) => n + 1);
          }}
        >
          <span className="stamp stamp-lit">Review access</span>
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--color-bone-faint)" }}>
            This surface reads what participants said, including the date of birth
            they spoke to verify their identity. It is closed without the review
            secret.
          </p>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="review secret"
            className="border bg-transparent px-2 py-1.5 text-[12px]"
            style={{ borderColor: "var(--color-line-lit)", color: "var(--color-bone)" }}
          />
          <button
            type="submit"
            className="border px-2 py-1.5 text-[11px]"
            style={{ borderColor: "var(--color-line-lit)", color: "var(--color-bone)" }}
          >
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--color-ink-000)" }}>
      <header
        className="flex items-baseline justify-between border-b px-6 py-4"
        style={{ borderColor: "var(--color-line)" }}
      >
        <div className="flex items-baseline gap-3">
          <span className="stamp stamp-lit">Review queue</span>
          <Link
            href="/"
            className="text-[11px] underline"
            style={{ color: "var(--color-bone-faint)" }}
          >
            back to console
          </Link>
        </div>
        <div className="flex items-center gap-4 text-[10px]" style={{ color: "var(--color-bone-faint)" }}>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            show calls with nothing flagged
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={includeSynthetic}
              onChange={(e) => setIncludeSynthetic(e.target.checked)}
            />
            include eval calls
          </label>
        </div>
      </header>

      <main className="px-6 py-5">
        {error ? (
          <p className="text-[12px]" style={{ color: "var(--color-oxide)" }}>
            {error}
          </p>
        ) : rows === null ? (
          <p className="text-[12px]" style={{ color: "var(--color-bone-faint)" }}>
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px]" style={{ color: "var(--color-bone)" }}>
              Nothing needs attention.
            </p>
            <p className="text-[11px] leading-relaxed" style={{ color: "var(--color-bone-faint)" }}>
              {scanned} call{scanned === 1 ? "" : "s"} in the last 30 days were checked
              {includeSynthetic ? "" : ", excluding the eval harness's own"}. An empty
              queue means every call was uneventful — not that the query found nothing.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/review/${row.id}`}
                  className="block border px-3.5 py-3 transition-colors"
                  style={{ borderColor: "var(--color-line)" }}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    {row.reasons.map((reason, i) => (
                      <span
                        key={`${reason.kind}-${i}`}
                        className="font-mono text-[9px] tracking-wider"
                        style={{ color: TONE[reason.kind] }}
                      >
                        {LABEL[reason.kind]}
                      </span>
                    ))}
                    {row.synthetic ? (
                      <span
                        className="font-mono text-[9px] tracking-wider"
                        style={{ color: "var(--color-slate-signal)" }}
                      >
                        EVAL
                      </span>
                    ) : null}
                    <span
                      className="ml-auto font-mono text-[10px] tabular-nums"
                      style={{ color: "var(--color-bone-faint)" }}
                    >
                      {new Date(row.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p
                    className="mt-1.5 text-[11.5px] leading-relaxed"
                    style={{ color: "var(--color-bone-dim)" }}
                  >
                    {row.reasons.map((r) => r.detail).join(" · ") || "nothing flagged"}
                  </p>
                  <p
                    className="mt-1 font-mono text-[10px] tabular-nums"
                    style={{ color: "var(--color-bone-faint)" }}
                  >
                    {row.events} event{row.events === 1 ? "" : "s"} · {row.escalations}{" "}
                    escalation{row.escalations === 1 ? "" : "s"} · screen{" "}
                    {row.screenAnswered}/9 · {row.status}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
