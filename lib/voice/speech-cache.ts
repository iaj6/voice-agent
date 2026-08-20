import { createHash } from "node:crypto";

/**
 * Cache identity for a rendered utterance.
 *
 * The key deliberately covers the voice, model, output format, and voice
 * settings as well as the text. The cache exists to avoid re-rendering fixed
 * protocol wording, but the voice is part of the instrument — if it is
 * repinned, every cached file was produced by a different instrument and must
 * not be served. Keying only on text would silently mix two voices within a
 * single call.
 */
export interface SpeechIdentity {
  modelId: string;
  voiceId: string;
  outputFormat: string;
  voiceSettings: Record<string, unknown>;
}

export function speechCacheKey(text: string, identity: SpeechIdentity): string {
  return createHash("sha256")
    .update(
      [
        identity.modelId,
        identity.voiceId,
        identity.outputFormat,
        JSON.stringify(identity.voiceSettings),
        text,
      ].join("|"),
    )
    .digest("hex");
}
