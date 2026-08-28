/**
 * The gate in front of the review surface.
 *
 * `/api/review` enumerates every call this study has taken and
 * `/api/review/[id]` unseals what a participant said — including the date of
 * birth they spoke aloud to verify their identity. Between them they are the
 * largest disclosure surface in this system, and they shipped without so much as
 * a shared secret in front of them: an enumeration endpoint next to a transcript
 * endpoint means an attacker never even has to guess a session id.
 *
 * The rest of the app being unauthenticated is a recorded posture decision
 * (4.10) about routes that create a session or stream audio. This is a different
 * thing — a bulk read of the whole study's PHI — and it does not inherit that
 * decision.
 *
 * **Fails closed.** With no secret configured, review is unavailable rather than
 * open. A PHI surface whose protection is optional is a PHI surface with no
 * protection, because the day it matters is the day nobody set the variable.
 *
 * This is a shared secret, not authentication. It stops the endpoint being open
 * to the internet; it does not say who read what, which is 5.7, and it does not
 * distinguish one coordinator from another, which is what the site's own SSO
 * would do (see D-E in docs/ONCALL.md, where the same argument was made about
 * acknowledgements).
 */

import { timingSafeEqual } from "node:crypto";

export const REVIEW_COOKIE = "voice_agent_review";

function secret(): string | null {
  return process.env.VOICE_AGENT_REVIEW_SECRET || null;
}

export function reviewConfigured(): boolean {
  return secret() !== null;
}

/** Constant-time, so the endpoint does not leak the secret one byte at a time. */
function matches(offered: string, expected: string): boolean {
  const a = Buffer.from(offered, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function fromCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === REVIEW_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function reviewAuthorised(request: Request): boolean {
  const expected = secret();
  if (!expected) return false;

  // Bearer for a script, cookie for the page. Both are the same secret; the
  // cookie exists because a browser cannot attach a header to a navigation.
  //
  // Either may satisfy it, and neither shadows the other.
  //
  // The first version short-circuited on any Authorization header, so a
  // coordinator behind a gateway was locked out with a perfectly good cookie.
  // The second only accepted `Bearer ` — which is exactly what such a gateway
  // injects (an OIDC token), so the same coordinator was locked out by the fix
  // for being locked out. Scheme matching is also case-insensitive per RFC 7235,
  // which the second version got wrong too.
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "") : null;

  for (const offered of [bearer, fromCookie(request)]) {
    if (typeof offered === "string" && offered.length > 0 && matches(offered, expected)) {
      return true;
    }
  }
  return false;
}

/** The refusal, worded so an operator knows which of the two problems they have. */
export function reviewRefusal(): Response {
  return reviewConfigured()
    ? Response.json({ error: "Not authorised to review calls." }, { status: 401 })
    : Response.json(
        {
          error:
            "Review is unavailable: VOICE_AGENT_REVIEW_SECRET is not set. " +
            "This surface reads participants' own words, so it stays closed until it is.",
        },
        { status: 503 },
      );
}
