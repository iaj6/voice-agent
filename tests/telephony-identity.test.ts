/**
 * Which call a turn belongs to.
 *
 * The shim derived that from a hash of the caller's first utterance, so two
 * participants who answer the phone the same way — "Hello?", "Yes, speaking" —
 * hashed to the same key and shared a clinical record. Same cross-participant
 * contamination as a drained final landing in the next call, by another route.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explicitConversationId,
  mustRefuseInferredIdentity,
  NO_CONVERSATION_ID,
} from "../lib/telephony/identity.ts";

test("a turn with no conversation id is refused in production", () => {
  assert.equal(mustRefuseInferredIdentity({}, "production"), true);
  assert.match(NO_CONVERSATION_ID, /share a clinical record/);
});

test("any of the three id fields is enough", () => {
  for (const body of [
    { user_id: "conv-1" },
    { user: "conv-2" },
    { elevenlabs_extra_body: { conversation_id: "conv-3" } },
  ]) {
    assert.equal(mustRefuseInferredIdentity(body, "production"), false);
    assert.ok(explicitConversationId(body));
  }
});

test("an empty or blank id is not an id", () => {
  // A provider that sends the field but leaves it empty would otherwise pass the
  // check and fall straight back to inferring from content.
  assert.equal(mustRefuseInferredIdentity({ user_id: "" }, "production"), true);
  assert.equal(mustRefuseInferredIdentity({ user: "   " }, "production"), true);
  assert.equal(
    mustRefuseInferredIdentity({ elevenlabs_extra_body: { conversation_id: 42 } }, "production"),
    true,
    "a non-string id is not an id",
  );
});

test("derivation stays available outside production", () => {
  // The eval harness drives this endpoint and sends no conversation id. Refusing
  // there would break the suite without protecting anybody: those calls are the
  // harness's own.
  assert.equal(mustRefuseInferredIdentity({}, "development"), false);
  assert.equal(mustRefuseInferredIdentity({}, "test"), false);
  assert.equal(mustRefuseInferredIdentity({}, undefined), false);
});
