import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MODEL_ID,
  OUTPUT_FORMAT,
  VOICE_ID,
  VOICE_SETTINGS,
} from "@/lib/voice/tts-config";
import { speechCacheKey } from "@/lib/voice/speech-cache";
import { FIXED_LINES } from "@/lib/agent/fixed-speech";
import { SentenceChunker } from "@/lib/agent/sentence-chunker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side speech synthesis.
 *
 * Exists so the ElevenLabs key never reaches the browser, and so repeated text
 * is rendered once rather than on every call. About two thirds of what the agent
 * says on a routine check-in is fixed protocol wording — the greeting and the six
 * solicited symptom questions are identical for every subject, every week. Those
 * serve from cache at disk speed, cost nothing after the first render, and are
 * never transmitted to a third party again.
 *
 * The cache key covers the voice, model, and voice settings as well as the text,
 * so changing any of them invalidates it rather than silently serving audio from
 * the old instrument.
 */

const CACHE_DIR = path.join(process.cwd(), ".speech-cache");

function cacheKey(text: string): string {
  return speechCacheKey(text, {
    modelId: MODEL_ID,
    voiceId: VOICE_ID,
    outputFormat: OUTPUT_FORMAT,
    voiceSettings: VOICE_SETTINGS,
  });
}

async function readCache(key: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(CACHE_DIR, `${key}.mp3`));
  } catch {
    return null;
  }
}

async function writeCache(key: string, audio: Buffer): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path.join(CACHE_DIR, `${key}.mp3`), audio);
  } catch {
    // A cache write failure must never fail the turn — the audio is already in hand.
  }
}

/**
 * The canonical fixed instrument wording, so the warm script never keeps its own
 * copy that could drift out of sync with what the agent is told to say.
 *
 * Split through the same chunker the runtime uses. The cache is keyed on exact
 * text, and at runtime the agent's output is spoken one sentence at a time — so
 * a two-sentence fixed line like "Thank you. And what is your date of birth?"
 * arrives as two separate synthesis requests and would miss a cache warmed on the
 * combined string. Warming the units the runtime will actually ask for is the
 * only way the two stay aligned.
 */
export async function GET() {
  const units = new Set<string>();
  for (const line of FIXED_LINES) {
    const chunker = new SentenceChunker();
    for (const sentence of chunker.push(line)) units.add(sentence);
    const trailing = chunker.flush();
    if (trailing) units.add(trailing);
  }
  return Response.json({ lines: [...units] });
}

export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    // 503 rather than 500: the client reads this as "fall back to local speech",
    // which is a degraded call rather than a silent one.
    return Response.json(
      { error: "Speech synthesis is not configured." },
      { status: 503 },
    );
  }

  let text: string;
  try {
    const body = (await request.json()) as { text?: unknown };
    if (typeof body.text !== "string" || !body.text.trim()) {
      return Response.json({ error: "Missing text" }, { status: 400 });
    }
    text = body.text.trim();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (text.length > 1000) {
    return Response.json({ error: "Text too long" }, { status: 413 });
  }

  const key = cacheKey(text);
  const cached = await readCache(key);
  if (cached) {
    return new Response(new Uint8Array(cached), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Speech-Cache": "hit",
      },
    });
  }

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
    `?output_format=${OUTPUT_FORMAT}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: VOICE_SETTINGS,
      }),
    });
  } catch (err) {
    return Response.json(
      {
        error: `Speech provider unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 503 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      {
        error: `Speech provider returned ${upstream.status}`,
        detail: detail.slice(0, 300),
      },
      { status: 503 },
    );
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  await writeCache(key, audio);

  return new Response(new Uint8Array(audio), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Speech-Cache": "miss",
    },
  });
}
