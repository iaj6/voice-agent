import { NextResponse } from "next/server";
import { createSession, getSession, snapshot } from "@/lib/store/session";
import { PROTOCOL } from "@/lib/clinical/protocol";
import { windowState } from "@/lib/clinical/calling-hours";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // `resumable: false` opts a session out of being claimed by a later call as a
  // dropped one. The eval harness needs it, because personas that stop mid-call
  // are indistinguishable from dropped lines and contaminated the next run.
  //
  // It is refused outside development. Read straight off an unauthenticated body
  // it was a way for any caller to quietly disable dropped-call recovery for a
  // real participant — the exact failure this feature exists to prevent, offered
  // as a request field.
  const evalControlsAllowed = process.env.NODE_ENV !== "production";
  let resumable = true;
  // Marks a session the eval harness created. Escalations on it are recorded and
  // never actually sent — see deliver.ts. Dev-only, like resumable:false, and for
  // the same reason: a request field that changes safety behaviour has no
  // business being reachable in production.
  let synthetic = false;

  const raw = await request.text();
  if (raw.trim() !== "") {
    let body: { resumable?: unknown; synthetic?: unknown };
    try {
      body = JSON.parse(raw) as { resumable?: unknown; synthetic?: unknown };
    } catch {
      // Distinguished from an empty body on purpose. Swallowing this meant a
      // malformed harness request silently became a resumable session, and the
      // opt-out failed without saying so.
      return NextResponse.json(
        { error: "Request body is not valid JSON" },
        { status: 400 },
      );
    }
    if (body?.synthetic === true) {
      if (!evalControlsAllowed) {
        return NextResponse.json(
          {
            error:
              "synthetic:true is a development-only control and cannot be set " +
              "on this deployment.",
          },
          { status: 403 },
        );
      }
      synthetic = true;
    }
    if (body?.resumable === false) {
      if (!evalControlsAllowed) {
        return NextResponse.json(
          {
            error:
              "resumable:false is a development-only control and cannot be set " +
              "on this deployment.",
          },
          { status: 403 },
        );
      }
      resumable = false;
    }
  }
  // Refused before anything is collected, not after.
  //
  // The check sits at session open rather than at verification because the
  // alternative is asking a participant for their subject ID and date of birth
  // — which land in the record as free text — and only then telling them to call
  // back. Collecting identifying information we have no ability to act on is the
  // wrong order. See docs/ONCALL.md D-C.
  //
  // Synthetic sessions bypass it: the eval harness is not a participant, and a
  // test suite that only passes during office hours is a test suite that fails
  // for reasons unrelated to the code.
  const hours = windowState();
  if (!hours.open && !synthetic) {
    return NextResponse.json(
      {
        error: "closed",
        message:
          "The check-in line is closed right now. It reopens " +
          `${hours.reopensDescription}. If this is an emergency, call your local ` +
          "emergency number; for anything else, call your study site directly.",
        reopens_at: hours.opensAt?.toISOString() ?? null,
        reopens_description: hours.reopensDescription,
      },
      { status: 503, headers: { "Retry-After": retryAfterSeconds(hours.opensAt) } },
    );
  }

  const session = await createSession({ resumable, synthetic });
  return NextResponse.json({
    session: snapshot(session),
    protocol: {
      protocolId: PROTOCOL.protocolId,
      shortTitle: PROTOCOL.shortTitle,
      title: PROTOCOL.title,
      phase: PROTOCOL.phase,
      sponsor: PROTOCOL.sponsor,
      investigationalProduct: PROTOCOL.investigationalProduct,
      solicitedSymptoms: PROTOCOL.solicitedSymptoms.map((s) => s.term),
    },
  });
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing session id" }, { status: 400 });
  }
  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: "Unknown session" }, { status: 404 });
  }
  return NextResponse.json({ session: snapshot(session) });
}

/** Seconds until the line reopens, clamped to something a client will respect. */
function retryAfterSeconds(opensAt: Date | null): string {
  if (!opensAt) return "3600";
  const seconds = Math.max(60, Math.round((opensAt.getTime() - Date.now()) / 1000));
  return String(Math.min(seconds, 86_400));
}
