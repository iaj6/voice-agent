import { NextResponse } from "next/server";
import { createSession, getSession, snapshot } from "@/lib/store/session";
import { PROTOCOL } from "@/lib/clinical/protocol";

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

  const raw = await request.text();
  if (raw.trim() !== "") {
    let body: { resumable?: unknown };
    try {
      body = JSON.parse(raw) as { resumable?: unknown };
    } catch {
      // Distinguished from an empty body on purpose. Swallowing this meant a
      // malformed harness request silently became a resumable session, and the
      // opt-out failed without saying so.
      return NextResponse.json(
        { error: "Request body is not valid JSON" },
        { status: 400 },
      );
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
  const session = await createSession({ resumable });
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
