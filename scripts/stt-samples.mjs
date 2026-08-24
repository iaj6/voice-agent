/**
 * Produces real recogniser output to measure, without a microphone.
 *
 *   node scripts/stt-samples.mjs --n 15 > tests/corpus/stt-samples.json
 *
 * Speaks corpus utterances with the TTS the agent already uses, transcribes the
 * audio, and writes {reference, hypothesis} pairs for scripts/measure-stt.mjs.
 *
 * **This measures a floor, not the field.** Synthesised speech is clean, evenly
 * paced, unaccented and never coughs, and the participants this study enrols are
 * elderly, tired and on medication. A recogniser that loses clinical terms on
 * this will lose more of them on a real call; one that scores perfectly here has
 * proved only that it can hear a synthesiser. Real numbers need recordings of
 * real speech, which needs consent, which is backlog 6.5.
 *
 * Transcribed by Deepgram's pre-recorded endpoint, which returns the same
 * per-word confidence the streaming socket does — so the threshold item 4.3
 * needs is chosen from measurement rather than from taste.
 */

import { readFileSync } from "node:fs";
import { MODEL_ID, OUTPUT_FORMAT, VOICE_ID, VOICE_SETTINGS } from "../lib/voice/tts-config.ts";

for (const file of [".env", ".env.local"]) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    /* optional */
  }
}

const valueOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 || !process.argv[i + 1] ? fallback : process.argv[i + 1];
};
const wanted = Number(valueOf("--n", "15"));

const { utterances } = JSON.parse(
  readFileSync(new URL("../tests/corpus/safety-corpus.json", import.meta.url), "utf8"),
);

// Signal-bearing utterances only: the question is whether the words that would
// have triggered an escalation survive the microphone.
const pool = utterances.filter((u) => u.expect !== null && u.text.split(" ").length >= 6);
const step = Math.max(1, Math.floor(pool.length / wanted));
const chosen = [];
for (let i = 0; i < pool.length && chosen.length < wanted; i += step) chosen.push(pool[i]);

async function speak(text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS }),
    },
  );
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Deepgram's pre-recorded endpoint, which returns per-word confidence.
 *
 * The same response shape the streaming socket produces, so what this harness
 * measures is what the live recogniser will report — including the confidence
 * that item 4.3 thresholds on.
 */
async function transcribe(audio) {
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL ?? "nova-3-medical",
    smart_format: "true",
    language: "en",
    punctuate: "true",
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/mpeg",
    },
    body: audio,
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  const alt = body.results?.channels?.[0]?.alternatives?.[0];
  return {
    text: String(alt?.transcript ?? "").trim(),
    words: (alt?.words ?? []).map((w) => ({
      word: w.punctuated_word ?? w.word,
      confidence: w.confidence,
    })),
  };
}

const samples = [];
for (const [i, entry] of chosen.entries()) {
  try {
    const audio = await speak(entry.text);
    const heard = await transcribe(audio);
    samples.push({
      reference: entry.text,
      hypothesis: heard.text,
      topic: entry.topic,
      kind: entry.kind,
      // Kept so 4.3's threshold can be chosen from measurement rather than taste.
      minWordConfidence: heard.words.length
        ? Math.min(...heard.words.map((w) => w.confidence))
        : null,
      words: heard.words,
    });
    process.stderr.write(`  ${i + 1}/${chosen.length} ${entry.topic}\n`);
  } catch (err) {
    process.stderr.write(`  ${i + 1}/${chosen.length} failed: ${err.message}\n`);
  }
}

process.stdout.write(JSON.stringify(samples, null, 2) + "\n");
