export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints a short-lived Deepgram key for the browser.
 *
 * The recogniser runs in the page, because that is where the microphone is, and
 * the obvious way to do that is to put DEEPGRAM_API_KEY in a NEXT_PUBLIC_ var
 * and be done. That ships a long-lived credential for a paid transcription
 * account to anyone who opens devtools, and the account it belongs to can read
 * every recording the project has ever made.
 *
 * So the key stays on the server and the browser gets a scoped one that expires.
 * Ten minutes is longer than any check-in and short enough that a leaked token
 * is not a leaked account.
 */
const TTL_SECONDS = 600;

export async function POST() {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    return Response.json(
      { error: "DEEPGRAM_API_KEY is not set; speech recognition is unavailable." },
      { status: 503 },
    );
  }

  const projects = await fetch("https://api.deepgram.com/v1/projects", {
    headers: { Authorization: `Token ${key}` },
  });
  if (!projects.ok) {
    return Response.json({ error: "Could not reach the transcription provider." }, { status: 502 });
  }
  const projectId = (await projects.json()).projects?.[0]?.project_id;
  if (!projectId) {
    return Response.json({ error: "No transcription project is configured." }, { status: 502 });
  }

  const minted = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      comment: "voice-agent browser session",
      // Listening only. A browser token that could create further keys, or read
      // past transcripts, would defeat the point of scoping it at all.
      scopes: ["usage:write"],
      time_to_live_in_seconds: TTL_SECONDS,
    }),
  });
  if (!minted.ok) {
    const detail = await minted.text();
    // Named precisely, because the fix is a console setting and a generic 502
    // sends someone looking through code for it. A key without keys:write can
    // transcribe perfectly well and cannot mint the short-lived token a browser
    // needs — which leaves two options, and both are decisions rather than bugs:
    // grant the scope, or relay audio through this server so the key never
    // leaves it. The second is the better answer for a clinical system anyway.
    const scoped = /keys:write|INSUFFICIENT_PERMISSIONS/.test(detail);
    return Response.json(
      {
        error: scoped
          ? "The transcription key cannot mint short-lived browser tokens: it is " +
            "missing the keys:write scope. Either grant it, or route audio " +
            "through this server instead of the browser."
          : `Could not mint a session token: ${minted.status}`,
      },
      { status: scoped ? 501 : 502 },
    );
  }

  const body = await minted.json();
  return Response.json(
    { token: body.key, expiresIn: TTL_SECONDS },
    { headers: { "Cache-Control": "no-store" } },
  );
}
