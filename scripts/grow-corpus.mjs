/**
 * Grows the safety corpus from simulated-patient speech.
 *
 *   node scripts/grow-corpus.mjs --topic cardiac_respiratory --n 20
 *   node scripts/grow-corpus.mjs --all --n 20        # every topic
 *
 * Writes to tests/corpus/staged.json for review. Nothing reaches the corpus
 * without a human reading it.
 *
 * **The generating context never sees the rules.** That is the whole design.
 * A corpus written by someone who has read `lib/clinical/safety.ts` measures how
 * well the regexes match sentences built to suit them, which is a number that
 * only ever goes up and means nothing. The prompt below carries a clinical topic
 * and an instruction to speak like a patient — no patterns, no examples drawn
 * from the corpus, no feedback about what does or does not currently fire.
 *
 * This is also why generation is a separate script rather than something done
 * inline while editing the net: the two jobs have to be done by different
 * contexts or the sample is not a sample.
 */

import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

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

const C = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  good: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * What a topic is, in clinical terms a patient would recognise — never in terms
 * of how the net looks for it.
 */
/**
 * Clinical severity, not net behaviour.
 *
 * This is the ground-truth label and it has to come from clinical reasoning —
 * what a coordinator would want paged now versus today — rather than from what
 * the net happens to do with the topic. It matches the existing corpus because
 * both derive from the same clinical fact, not because one was read off the
 * other.
 */
const URGENCY = {
  cardiac_respiratory: "emergency",
  stroke: "emergency",
  bleeding: "emergency",
  loss_of_consciousness: "emergency",
  anaphylaxis_skin: "emergency",
  self_harm: "emergency",
  fever: "urgent",
  hospitalization: "urgent",
  pregnancy: "urgent",
  withdrawal: "urgent",
};

const TOPICS = {
  cardiac_respiratory: "chest pain, chest pressure, or difficulty breathing",
  stroke: "sudden weakness or numbness on one side, drooping face, trouble speaking, or sudden severe headache",
  bleeding: "bleeding that will not stop, or blood where it should not be",
  loss_of_consciousness: "fainting, blacking out, or a seizure",
  anaphylaxis_skin: "a severe allergic reaction, swelling of the face or throat, or a blistering rash",
  fever: "fever, chills, or signs of infection",
  hospitalization: "an unplanned visit to hospital, an emergency room, or an ambulance",
  pregnancy: "being pregnant or thinking they might be",
  self_harm: "not wanting to go on, or thoughts of hurting themselves",
  withdrawal: "wanting to stop the study drug or leave the trial",
};

const KINDS = {
  direct: "State it plainly, the way someone reporting a symptom would.",
  colloquial:
    "Say it the way people actually talk — indirect, understated, with everyday metaphors. " +
    "Older people especially rarely use clinical words. Do not use the obvious medical term.",
  compound: "Bury it in the middle of a longer, rambling answer about something else.",
  negated: "DENY it clearly. The person does NOT have this. It must be obvious they are saying no.",
  historical:
    "Refer to it as something that happened long ago and is over. It is NOT happening now.",
  other_experiencer: "It happened to somebody else — a spouse, a neighbour, a friend. Not the speaker.",
  hypothetical: "Raise it as a worry or a what-if, not as something happening.",
};

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};
const perKind = Number(valueOf("--n", "6"));
const topics = args.includes("--all")
  ? Object.keys(TOPICS)
  : [valueOf("--topic", "")].filter((t) => TOPICS[t]);

if (topics.length === 0) {
  console.error(`\nPick --topic <${Object.keys(TOPICS).join("|")}> or --all\n`);
  process.exit(2);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You write realistic speech for clinical trial participants on a phone check-in.

You are producing test data for a safety system. Write what a real person would SAY OUT LOUD
to an automated check-in call — not what a clinician would write in a note.

Rules:
- One utterance per line. No numbering, no quotes, no commentary.
- Speak as the participant, first person, out loud.
- Vary age, register and verbosity. Many are elderly, tired, or on medication.
- Never use the phrase "adverse event" or other trial jargon.
- Do not repeat yourself. Each line must be a genuinely different way of speaking.`;

async function generate(topic, kind, n) {
  const message = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 1200,
    system: SYSTEM,
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content:
          `Topic: ${TOPICS[topic]}.\n\n${KINDS[kind]}\n\n` +
          `Write ${n} lines. Nothing else.`,
      },
    ],
  });
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .split("\n")
    .map((l) => l.replace(/^\s*[-–—*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 8);
}

const corpusFile = new URL("../tests/corpus/safety-corpus.json", import.meta.url);
const corpus = JSON.parse(readFileSync(corpusFile, "utf8"));
const normalise = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const existing = new Set(corpus.utterances.map((e) => normalise(e.text)));

// Which kinds should fire, and which are the specificity half of the corpus.
const SIGNAL_KINDS = ["direct", "colloquial", "compound"];
const QUIET_KINDS = ["negated", "historical", "other_experiencer", "hypothetical"];

const staged = [];
console.log(`\n${C.bold("growing corpus")} ${C.dim(`${topics.length} topic(s) × ${perKind} per kind`)}\n`);

for (const topic of topics) {
  const kinds = [...SIGNAL_KINDS, ...QUIET_KINDS];
  const results = await Promise.all(kinds.map((kind) => generate(topic, kind, perKind)));

  let added = 0;
  kinds.forEach((kind, i) => {
    for (const text of results[i]) {
      const key = normalise(text);
      if (existing.has(key)) continue;
      existing.add(key);
      staged.push({
        text,
        expect: SIGNAL_KINDS.includes(kind) ? URGENCY[topic] : null,
        topic,
        kind,
      });
      added += 1;
    }
  });
  console.log(`  ${C.good("+")} ${topic.padEnd(24)} ${added}`);
}

const out = new URL("../tests/corpus/staged.json", import.meta.url);
writeFileSync(out, JSON.stringify(staged, null, 2) + "\n");
console.log(
  `\n  ${staged.length} staged in tests/corpus/staged.json` +
    `\n  ${C.dim("`expect` is the generator's intent — read them before merging.")}\n`,
);
