// Relative, not the "@/" alias: Node runs these sources directly in tests and
// cannot resolve the alias, and the acknowledgement route is exactly the piece
// that needs a test — a link scanner silently acknowledging every escalation is
// not something a build-only check would ever surface.
import { getDeliveryStore } from "../../../../lib/store/deliveries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A coordinator acknowledging an escalation.
 *
 * **GET shows a page. POST records the acknowledgement.** That split is not
 * ceremony about HTTP verbs — enterprise mail security fetches every URL in an
 * inbound message before a human sees it. Outlook SafeLinks, Proofpoint URL
 * Defense, Mimecast and Gmail prefetch would all have acknowledged the page at
 * delivery time, from a scanner's IP, seconds after it was sent. Because the
 * non-acknowledgement alarm keys on `acknowledged_at is null`, the only alarm
 * for "nobody responded to an emergency" would have been disarmed by a robot,
 * and first-click-wins would have recorded that robot as the responder forever.
 *
 * So the GET is safe in the HTTP sense: it renders a button and changes nothing.
 *
 * **Not authenticated**, and that is a real limitation rather than an oversight:
 * possession of the link is the credential, exactly as it is for a password
 * reset. Adequate while the roster is fabricated; not adequate the day a real
 * coordinator exists, because "who acknowledged this" is the whole point of the
 * record. Sits behind site auth before a pilot.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t");
  if (!token) return page("Missing link", "That link is incomplete.", false);

  const record = await getDeliveryStore().find(token);
  if (!record) {
    return page(
      "Link not recognised",
      "This acknowledgement link is not valid. It may belong to a record that " +
        "has since been removed. Contact the study team directly.",
      false,
    );
  }

  if (record.acknowledgedAt) {
    return page(
      "Already acknowledged",
      `Escalation ${esc(record.escalationId)} for subject ${esc(record.subjectId ?? "unidentified")} ` +
        `was acknowledged at ${esc(when(record.acknowledgedAt))} by ` +
        `${esc(record.acknowledgedBy ?? "an unnamed recipient")}.`,
      true,
    );
  }

  return page(
    `${record.urgency.toUpperCase()} escalation`,
    `Escalation ${esc(record.escalationId)} for subject ${esc(record.subjectId ?? "unidentified")}. ` +
      `Response deadline ${esc(when(record.deadlineAt))}. ` +
      "Confirm below that you have seen it. Nothing is recorded until you do.",
    true,
    token,
  );
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const token = String(form?.get("t") ?? "") || new URL(request.url).searchParams.get("t");
  if (!token) return page("Missing link", "That link is incomplete.", false);

  // `||`, not `??`. A present-but-empty X-Forwarded-For is common behind some
  // proxies, and `??` only fires when the header is absent — so acknowledged_by
  // came out blank on the one field this route exists to record.
  const by =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "link recipient";

  const record = await getDeliveryStore().acknowledge(token, by);
  if (!record) {
    return page("Link not recognised", "This acknowledgement link is not valid.", false);
  }

  const late =
    record.acknowledgedAt &&
    Date.parse(record.acknowledgedAt) > Date.parse(record.deadlineAt);

  return page(
    "Acknowledged",
    `Escalation ${esc(record.escalationId)} for subject ${esc(record.subjectId ?? "unidentified")} ` +
      `was acknowledged at ${esc(when(record.acknowledgedAt))}.` +
      (late ? " This was after the response window closed, which is recorded." : "") +
      " Open the call record in the coordinator console to review what was captured.",
    true,
  );
}

function when(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "just now";
}

/** Every interpolated value is escaped. message.ts does this; this file did not. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string, ok: boolean, confirmToken?: string): Response {
  const form = confirmToken
    ? `<form method="POST" style="margin-top:1.75rem">
  <input type="hidden" name="t" value="${esc(confirmToken)}">
  <button type="submit" style="background:#1a73e8;color:#fff;border:0;padding:.7rem 1.3rem;border-radius:6px;font-size:1rem;cursor:pointer">
    I have seen this escalation</button>
</form>`
    : "";
  const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;line-height:1.6;color:#202124">
  <p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${ok ? "#137333" : "#b3261e"};margin:0 0 .5rem">${ok ? "Study escalation" : "Not recorded"}</p>
  <h1 style="font-size:1.5rem;margin:0 0 1rem">${esc(title)}</h1>
  <p style="margin:0;color:#3c4043">${body}</p>
  ${form}
</div>`;
  return new Response(html, {
    status: ok ? 200 : 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
