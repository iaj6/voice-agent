/**
 * The gate in front of the review surface.
 *
 * `/api/review` enumerates every call and `/api/review/[id]` unseals what a
 * participant said, including the date of birth they spoke to verify identity.
 * They shipped with no gate at all, which made an enumeration endpoint and a
 * transcript endpoint available to anyone who could reach the host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_COOKIE,
  reviewAuthorised,
  reviewConfigured,
} from "../lib/review/auth.ts";

const SECRET = "s3cret-review-token";
const withHeaders = (headers: Record<string, string>) =>
  new Request("https://example.test/api/review", { headers });

test("with no secret configured the surface is closed, not open", () => {
  // Fail-closed is the whole point. A PHI surface whose protection is optional
  // is a PHI surface with no protection, because the day it matters is the day
  // nobody set the variable.
  delete process.env.VOICE_AGENT_REVIEW_SECRET;
  assert.equal(reviewConfigured(), false);
  assert.equal(reviewAuthorised(withHeaders({ authorization: `Bearer ${SECRET}` })), false);
  assert.equal(reviewAuthorised(withHeaders({})), false);
});

test("a bearer token opens it, and a wrong one does not", () => {
  process.env.VOICE_AGENT_REVIEW_SECRET = SECRET;
  assert.equal(reviewAuthorised(withHeaders({ authorization: `Bearer ${SECRET}` })), true);
  assert.equal(reviewAuthorised(withHeaders({ authorization: "Bearer wrong" })), false);
  assert.equal(reviewAuthorised(withHeaders({})), false);
  delete process.env.VOICE_AGENT_REVIEW_SECRET;
});

test("a cookie opens it, because a browser cannot header a navigation", () => {
  process.env.VOICE_AGENT_REVIEW_SECRET = SECRET;
  assert.equal(
    reviewAuthorised(withHeaders({ cookie: `${REVIEW_COOKIE}=${SECRET}` })),
    true,
  );
  assert.equal(
    reviewAuthorised(withHeaders({ cookie: `other=x; ${REVIEW_COOKIE}=${SECRET}; z=1` })),
    true,
  );
  assert.equal(reviewAuthorised(withHeaders({ cookie: `${REVIEW_COOKIE}=nope` })), false);
  delete process.env.VOICE_AGENT_REVIEW_SECRET;
});

test("a token that is a prefix of the secret is refused", () => {
  // Length is checked before the comparison, so a short guess cannot pass and
  // cannot be timed against the real thing either.
  process.env.VOICE_AGENT_REVIEW_SECRET = SECRET;
  assert.equal(reviewAuthorised(withHeaders({ authorization: "Bearer s3cret" })), false);
  assert.equal(reviewAuthorised(withHeaders({ authorization: "Bearer " })), false);
  delete process.env.VOICE_AGENT_REVIEW_SECRET;
});
