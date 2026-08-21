import { getDeliveryStore } from "@/lib/store/deliveries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A coordinator acknowledging an escalation.
 *
 * GET, because it is the target of a link in an email and that is the only way a
 * one-click acknowledgement works. The token is single-use in effect — the first
 * acknowledgement is the one recorded, and a later click reports the original
 * rather than overwriting who actually responded.
 *
 * **Not authenticated**, and that is a real limitation rather than an oversight:
 * possession of the link is the credential, exactly as it is for a password
 * reset. It is adequate while the roster is fabricated and it is not adequate
 * the day a real coordinator exists, because "who acknowledged this" is the
 * whole point of the record. Sits behind site auth before a pilot — same
 * sentence as the withdrawal endpoint, and the same reason.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t");
  if (!token) return page("Missing link", "That link is incomplete.", false);

  const by =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "link recipient";

  const record = await getDeliveryStore().acknowledge(token, by);
  if (!record) {
    return page(
      "Link not recognised",
      "This acknowledgement link is not valid. It may belong to a record that " +
        "has since been removed. Contact the study team directly.",
      false,
    );
  }

  const when = record.acknowledgedAt
    ? record.acknowledgedAt.replace("T", " ").slice(0, 16) + " UTC"
    : "just now";
  const late =
    record.acknowledgedAt && Date.parse(record.acknowledgedAt) > Date.parse(record.deadlineAt);

  return page(
    "Acknowledged",
    `Escalation ${record.escalationId} for subject ${record.subjectId ?? "unidentified"} ` +
      `was acknowledged at ${when}.` +
      (late ? " This was after the response window closed, which is recorded." : "") +
      " Open the call record in the coordinator console to review what was captured.",
    true,
  );
}

function page(title: string, body: string, ok: boolean): Response {
  const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;line-height:1.6;color:#202124">
  <p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${ok ? "#137333" : "#b3261e"};margin:0 0 .5rem">${ok ? "Recorded" : "Not recorded"}</p>
  <h1 style="font-size:1.5rem;margin:0 0 1rem">${title}</h1>
  <p style="margin:0;color:#3c4043">${body}</p>
</div>`;
  return new Response(html, {
    status: ok ? 200 : 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
