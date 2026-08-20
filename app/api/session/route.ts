import { NextResponse } from "next/server";
import { createSession, getSession, snapshot } from "@/lib/store/session";
import { PROTOCOL } from "@/lib/clinical/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // `resumable: false` opts a session out of being claimed by a later call as a
  // dropped one. Used by the eval harness; a real call never sets it.
  let resumable = true;
  try {
    const body = (await request.json()) as { resumable?: unknown };
    if (body?.resumable === false) resumable = false;
  } catch {
    /* no body is the normal case */
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
