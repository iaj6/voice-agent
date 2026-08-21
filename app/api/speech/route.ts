import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MODEL_ID,
  OUTPUT_FORMAT,
  VOICE_ID,
  VOICE_SETTINGS,
} from "@/lib/voice/tts-config";
import {
  cacheableLines,
  isCacheable,
  speechCacheKey,
} from "@/lib/voice/speech-cache";

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

/**
 * Deletes anything in the cache that the allowlist would not write today.
 *
 * The allowlist gates writes, which stops the store growing more subject audio —
 * it does nothing about what is already there. Ten subject-derived files were
 * removed by hand from one machine; any other checkout or long-lived host that
 * ran the earlier code still holds its own, still serves them, and RETENTION.md
 * now says this store holds fixed instrument wording only.
 *
 * Because the key is a pure hash of (text, voice identity), the valid set is
 * computable, so the control can enforce itself rather than depending on someone
 * remembering to run a script. Cheap and safe: everything here is regenerable,
 * and anything not on the allowlist would never have been read again anyway.
 */
let pruned: Promise<void> | null = null;

function pruneCacheOnce(): Promise<void> {
  pruned ??= (async () => {
    try {
      const valid = new Set(cacheableLines().map((line) => cacheKey(line)));
      for (const file of await readdir(CACHE_DIR)) {
        if (!file.endsWith(".mp3")) continue;
        if (valid.has(file.slice(0, -4))) continue;
        await unlink(path.join(CACHE_DIR, file)).catch(() => {});
      }
    } catch {
      // No cache directory yet, or an unreadable one. Nothing to prune.
    }
  })();
  return pruned;
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
  return Response.json({ lines: cacheableLines() });
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

  await pruneCacheOnce();

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
  // Only the fixed instrument wording is written to disk.
  //
  // The cache existed to make the scripted questions fast, and those are the only
  // strings a second call ever asks for again — everything else is a one-off
  // sentence with a cache hit rate of about zero. It was caching all of it, and
  // the agent is instructed to read back what it recorded, so a subject's own
  // symptom description was being written to disk as audio. Nothing could find it
  // afterwards either: the filename is a hash of the text, so locating one
  // subject's audio required already knowing the exact words they used.
  if (isCacheable(text)) {
    await writeCache(key, audio);
  }

  return new Response(new Uint8Array(audio), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Speech-Cache": "miss",
    },
  });
}
