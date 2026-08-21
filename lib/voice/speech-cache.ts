import { createHash } from "node:crypto";
import { FIXED_LINES } from "../agent/fixed-speech.ts";
import { SentenceChunker } from "../agent/sentence-chunker.ts";

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

/**
 * The only text allowed to reach the on-disk cache.
 *
 * A privacy control, not only a latency one. Caching every synthesised sentence
 * wrote a subject's own symptom descriptions to disk as audio — the agent is
 * instructed to read back what it recorded — under a filename that is a hash of
 * the text, so a given subject's audio could not be located again without
 * already knowing the exact words they used. Ten such files were on disk when
 * this was found.
 *
 * Restricting it costs nothing: the scripted questions are the only strings a
 * second call ever asks for again. Everything else is a one-off sentence with a
 * cache hit rate of about zero.
 *
 * Chunked through the same splitter the runtime uses, because the agent speaks
 * one sentence at a time — a two-sentence fixed line arrives as two separate
 * synthesis requests and would miss a cache warmed on the combined string.
 */
let cacheable: Set<string> | null = null;

export function cacheableUnits(): Set<string> {
  if (cacheable) return cacheable;
  const units = new Set<string>();
  for (const line of FIXED_LINES) {
    const chunker = new SentenceChunker();
    for (const sentence of chunker.push(line)) units.add(sentence);
    const trailing = chunker.flush();
    if (trailing) units.add(trailing);
  }
  cacheable = units;
  return units;
}
