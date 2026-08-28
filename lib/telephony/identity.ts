/**
 * Which call a turn belongs to.
 *
 * The telephony shim derived this from a hash of the caller's first utterance,
 * because ElevenLabs resends the whole history each turn and does not guarantee
 * a conversation id. Two participants who answer the phone the same way —
 * "Hello?", "Yes, speaking" — hash to the same key and share a clinical record.
 *
 * That is the same cross-participant contamination as a drained final landing in
 * the next call, arriving by a different route, and it is not a risk a record
 * should carry to make a demo convenient.
 *
 * Lives here rather than in the route so it can be tested: route files use `@/`
 * path aliases that only the bundler resolves.
 */

export interface IdentifiableTurn {
  user_id?: string;
  user?: string;
  elevenlabs_extra_body?: { conversation_id?: unknown };
}

/** The caller-supplied conversation id, if there is one. */
export function explicitConversationId(body: IdentifiableTurn): string | null {
  const offered =
    body.user_id ??
    body.user ??
    (body.elevenlabs_extra_body?.conversation_id as string | undefined);
  return typeof offered === "string" && offered.trim() !== "" ? offered : null;
}

/**
 * Whether identity has to be refused rather than inferred.
 *
 * Production only. A real integration carries the conversation id through
 * `elevenlabs_extra_body`, which this shim's own docstring has said since it was
 * written; requiring it is the difference between saying that and meaning it.
 * Outside production the calls are the eval harness's own, and derivation stays
 * available so the suite and the demo keep working.
 */
export function mustRefuseInferredIdentity(
  body: IdentifiableTurn,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  return nodeEnv === "production" && explicitConversationId(body) === null;
}

export const NO_CONVERSATION_ID =
  "No conversation id. This endpoint will not infer which call a turn belongs " +
  "to from its transcript: two participants who answer the phone the same way " +
  "would share a clinical record. Send the conversation id in " +
  "elevenlabs_extra_body.conversation_id, user_id, or user.";
