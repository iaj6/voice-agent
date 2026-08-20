"use client";

import type { SessionSnapshot } from "@/lib/store/session";

function Field({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="stamp">{label}</span>
      <span
        className={`text-[12.5px] leading-snug ${mono ? "font-mono" : ""}`}
        style={{ color: "var(--color-bone)" }}
      >
        {value}
      </span>
    </div>
  );
}

export function SubjectPanel({
  snapshot,
  protocolId,
  protocolTitle,
  investigationalProduct,
}: {
  snapshot: SessionSnapshot | null;
  protocolId: string;
  protocolTitle: string;
  investigationalProduct: string;
}) {
  const subject = snapshot?.subject ?? null;

  return (
    <div className="panel flex min-h-full flex-col">
      <div className="panel-header">
        <span className="stamp stamp-lit">Study &amp; Subject</span>
        <span
          className={`pip ${subject ? "pip-live" : "pip-idle"}`}
          title={subject ? "Verified" : "Unverified"}
        />
      </div>

      <div className="flex flex-col gap-5 p-4">
        <div className="flex flex-col gap-1">
          <span className="stamp">Protocol</span>
          <span
            className="font-mono text-[15px] tracking-wide"
            style={{ color: "var(--color-amber)" }}
          >
            {protocolId}
          </span>
          <p
            className="mt-1 text-[11.5px] leading-[1.55]"
            style={{ color: "var(--color-bone-faint)" }}
          >
            {protocolTitle}
          </p>
        </div>

        <div className="hairline" />

        <Field label="Investigational product" value={investigationalProduct} mono={false} />

        <div className="hairline" />

        {subject ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Subject" value={subject.subjectId} />
              <Field label="Initials" value={subject.initials} />
              <Field label="Cohort" value={subject.cohort} />
              <Field label="Study day" value={`D${subject.studyDay}`} />
            </div>
            <Field label="Visit window" value={subject.currentCycle} />
            <Field label="Site" value={subject.siteName} mono={false} />
            <Field label="Last check-in" value={subject.lastCheckIn ?? "—"} />

            <div className="hairline" />

            <div className="flex flex-col gap-2">
              <span className="stamp">Baseline conditions</span>
              <ul className="flex flex-col gap-1.5">
                {subject.baselineConditions.map((c) => (
                  <li
                    key={c}
                    className="border-l pl-2.5 text-[12px] leading-snug"
                    style={{
                      color: "var(--color-bone-dim)",
                      borderColor: "var(--color-line-lit)",
                    }}
                  >
                    {c}
                  </li>
                ))}
              </ul>
              <p
                className="mt-1 text-[10.5px] leading-relaxed"
                style={{ color: "var(--color-bone-faint)" }}
              >
                Documented at baseline. Not adverse events unless the subject
                reports worsening.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <span className="stamp">Known concomitant meds</span>
              <ul className="flex flex-col gap-1.5">
                {subject.knownConMeds.map((m) => (
                  <li
                    key={m}
                    className="font-mono text-[11.5px] leading-snug"
                    style={{ color: "var(--color-bone-dim)" }}
                  >
                    {m}
                  </li>
                ))}
              </ul>
            </div>

            <div className="hairline" />

            <Field label="Coordinator" value={subject.coordinatorName} mono={false} />
            <Field label="Coordinator line" value={subject.coordinatorPhone} />
          </>
        ) : (
          <div
            className="border border-dashed p-4 text-[12px] leading-relaxed"
            style={{
              borderColor: "var(--color-line-lit)",
              color: "var(--color-bone-faint)",
            }}
          >
            Subject not yet verified. The agent collects subject ID and date of
            birth before any clinical question is asked.
            <div
              className="mt-3 border-t pt-3 font-mono text-[10.5px] leading-relaxed"
              style={{ borderColor: "var(--color-line)" }}
            >
              <div className="stamp mb-1.5">Test identities</div>
              <div>001-0042 · 1958-03-11</div>
              <div>001-0055 · 1971-11-02</div>
              <div>002-0013 · 1949-07-24</div>
              <div>002-0027 · 1992-05-19</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
