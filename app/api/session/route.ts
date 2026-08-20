import { NextResponse } from "next/server";
import { createSession, getSession, snapshot } from "@/lib/store/session";
import { PROTOCOL } from "@/lib/clinical/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const session = await createSession();
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
