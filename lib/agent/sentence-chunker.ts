/**
 * Splits a streaming token feed into speakable sentences.
 *
 * Time-to-first-audio is the metric that makes a voice agent feel alive, and it
 * is bounded by how early we can hand the first complete clause to the speech
 * engine. Waiting for the full response before speaking adds the entire
 * generation time to perceived latency; splitting too eagerly produces choppy,
 * unnatural prosody. This splits on sentence boundaries, with a soft comma flush
 * for long run-on clauses.
 */

const TERMINALS = new Set([".", "!", "?", "…"]);

/** Trailing tokens that look terminal but are not the end of a sentence. */
const ABBREVIATIONS = [
  "dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "vs.", "etc.",
  "e.g.", "i.e.", "a.m.", "p.m.", "approx.", "no.", "fig.",
];

/** Flush a partial clause once the buffer gets this long without a terminal. */
const SOFT_FLUSH_CHARS = 180;
const MIN_SOFT_FLUSH_CHARS = 45;

export class SentenceChunker {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];

    for (;;) {
      const boundary = this.findBoundary(this.buffer);
      if (boundary === -1) break;
      const sentence = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary);
      if (sentence) out.push(sentence);
    }

    if (this.buffer.length > SOFT_FLUSH_CHARS) {
      const cut = this.buffer.lastIndexOf(", ");
      if (cut > MIN_SOFT_FLUSH_CHARS) {
        const clause = this.buffer.slice(0, cut + 1).trim();
        this.buffer = this.buffer.slice(cut + 1);
        if (clause) out.push(clause);
      }
    }

    return out;
  }

  /** Emit whatever is left. Call once the model stops generating. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }

  private findBoundary(text: string): number {
    for (let i = 0; i < text.length; i++) {
      if (!TERMINALS.has(text[i])) continue;

      const next = text[i + 1];
      // No following character yet — we cannot tell a sentence end from "3.5".
      if (next === undefined) return -1;
      if (!/\s/.test(next)) continue;

      const preceding = text.slice(0, i + 1).toLowerCase();
      if (ABBREVIATIONS.some((abbr) => preceding.endsWith(abbr))) continue;

      return i + 1;
    }
    return -1;
  }
}
