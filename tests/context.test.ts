import { test } from "node:test";
import assert from "node:assert/strict";
import { assessContext, suppressionReason, tokenize } from "../lib/clinical/context.ts";
import { scanForSafetySignals, assertedHits } from "../lib/clinical/safety.ts";
import { checkProvenance } from "../lib/clinical/provenance.ts";

/** Locates a concept in an utterance and returns its context reading. */
function read(text: string, concept: string) {
  const start = text.toLowerCase().indexOf(concept.toLowerCase());
  assert.notEqual(start, -1, `"${concept}" not found in "${text}"`);
  return assessContext(text, start, start + concept.length);
}

test("a bare mention is asserted, about the subject, happening now", () => {
  const v = read("I have had chest pain since last night", "chest pain");
  assert.equal(v.assertion, "asserted");
  assert.equal(v.experiencer, "subject");
  assert.equal(v.temporality, "current");
  assert.equal(suppressionReason(v), null);
});

test("negation before the concept suppresses it", () => {
  for (const [text, concept] of [
    ["no chest pain at all this week", "chest pain"],
    ["I have no trouble breathing", "trouble breathing"],
    ["I haven't had any bleeding", "bleeding"],
    ["I don't have a fever", "fever"],
  ] as const) {
    const v = read(text, concept);
    assert.equal(v.assertion, "negated", `should be negated: ${text}`);
  }
});

test("a terminator ends the negation scope", () => {
  // "but" closes the scope, so the second clause is asserted again.
  const v = read("no nausea this week, but I have had chest pain", "chest pain");
  assert.equal(v.assertion, "asserted");
});

test("scope does not cross a sentence boundary", () => {
  const v = read("I have had no nausea. Chest pain woke me up.", "Chest pain");
  assert.equal(v.assertion, "asserted");
});

test("negation does not reach past its window", () => {
  const v = read(
    "no nausea and my appetite has been steady and sleep was fine and chest pain started",
    "chest pain",
  );
  assert.equal(v.assertion, "asserted");
});

test("someone else's symptom is attributed to them", () => {
  for (const [text, concept] of [
    ["my husband had chest pain last year", "chest pain"],
    ["my daughter has been running a fever", "fever"],
    ["the doctor asked about chest pain", "chest pain"],
  ] as const) {
    const v = read(text, concept);
    assert.equal(v.experiencer, "other", `should be other: ${text}`);
  }
});

test("past events are marked historical", () => {
  for (const [text, concept] of [
    ["I had chest pain years ago before the study", "chest pain"],
    ["I used to get fevers like that", "fevers"],
    ["I was in the hospital a long time ago", "hospital"],
  ] as const) {
    const v = read(text, concept);
    assert.equal(v.temporality, "historical", `should be historical: ${text}`);
  }
});

test("conditional mentions are marked hypothetical", () => {
  for (const [text, concept] of [
    ["they told me to call if I get chest pain", "chest pain"],
    ["the nurse said to watch for a fever", "fever"],
  ] as const) {
    const v = read(text, concept);
    assert.equal(v.temporality, "hypothetical", `should be hypothetical: ${text}`);
  }
});

test("a negation inside the concept does not suppress it", () => {
  // Regression: several rules are negation-bearing idioms. Applying ConText
  // naively double-negated them and silently disarmed the highest-stakes rules
  // in the system.
  for (const text of [
    "I don't want to live anymore",
    "I can't breathe when I walk to the kitchen",
    "I can't feel my arm on the left side",
    "there's bleeding that won't stop",
  ]) {
    const live = assertedHits(scanForSafetySignals(text));
    assert.ok(live.length > 0, `must still fire: ${text}`);
  }
});

test("suppressed matches are returned, not silently discarded", () => {
  // A control that hides its own near-misses cannot be audited.
  const all = scanForSafetySignals("no chest pain at all this week");
  assert.equal(all.length, 1, "the raw match should still be reported");
  assert.equal(all[0].suppressed, true);
  assert.match(all[0].suppressionReason ?? "", /negated/);
  assert.equal(assertedHits(all).length, 0, "but it must not drive an escalation");
});

test("tokenizer keeps offsets and splits sentences", () => {
  const tokens = tokenize("No fever. Chest pain woke me.");
  assert.equal(tokens[0].text, "no");
  assert.equal(tokens[0].sentence, 0);
  const chest = tokens.find((t) => t.text === "chest");
  assert.equal(chest?.sentence, 1);
  assert.equal("No fever. Chest pain woke me.".slice(chest.start, chest.end), "Chest");
});

// --- stop-sequence prefix hold-back -----------------------------------------
// Mirrors the guard in lib/agent/runner.ts. Stop sequences protect the final
// message but not the streamed deltas: the opening characters of "\nuser" reach
// the browser before the API knows a sequence matched. Observed live, the leaked
// fragment fused with the next word into "usual bit rough honestly" and was
// spoken to the participant.
const STOPS = ["\nuser", "\nUser", "\nassistant", "\nSubject:"];
const MAX_STOP = Math.max(...STOPS.map((s) => s.length));

function holdBack(buffered: string): number {
  const max = Math.min(MAX_STOP - 1, buffered.length);
  for (let n = max; n > 0; n--) {
    const suffix = buffered.slice(buffered.length - n);
    if (STOPS.some((stop) => stop.startsWith(suffix))) return n;
  }
  return 0;
}

test("holds back a suffix that could still become a stop sequence", () => {
  assert.equal(holdBack("How have you been?\nus"), 3, "'\\nus' must not be emitted");
  assert.equal(holdBack("How have you been?\n"), 1);
  assert.equal(holdBack("How have you been?\nu"), 2);
});

test("releases text that cannot become a stop sequence", () => {
  assert.equal(holdBack("How have you been feeling?"), 0);
  assert.equal(holdBack("no fever this week"), 0);
  // "\nus" is a prefix of "\nuser"; "\nusual" is not.
  assert.equal(holdBack("it was the usual"), 0);
});

test("a completed stop sequence leaves nothing speakable behind", () => {
  // Simulates the streaming loop: nothing from the leaked prefix escapes.
  let held = "";
  const spoken: string[] = [];
  for (const delta of ["Have you had any chest pain?", "\n", "\nus", "er"]) {
    held += delta;
    const n = holdBack(held);
    const out = held.slice(0, held.length - n);
    held = held.slice(held.length - n);
    if (out) spoken.push(out);
  }
  const said = spoken.join("");
  assert.ok(!said.includes("us"), `leaked stop-sequence prefix: ${JSON.stringify(said)}`);
  assert.equal(said.trimEnd(), "Have you had any chest pain?");
});

// --- clause boundaries -------------------------------------------------------
// A trigger in one clause must not swallow a signal in the next. Before this,
// "I have no appetite and I've been vomiting blood" was suppressed as negated
// and produced no escalation at all.
test("a scope does not cross a coordinating conjunction", () => {
  for (const text of [
    "I have no appetite and I've been vomiting blood.",
    "I saw my doctor last week and now I'm coughing up blood.",
    "The nurse checked me, then I had a seizure.",
  ]) {
    assert.ok(
      assertedHits(scanForSafetySignals(text)).length > 0,
      `must still fire: ${text}`,
    );
  }
});

test("a scope does not cross a comma", () => {
  assert.ok(
    assertedHits(scanForSafetySignals("I don't know, I've been having chest pain.")).length > 0,
  );
});

test("'or' continues a list under the same negation", () => {
  // "or" must NOT terminate, or "no fever or chills" would assert chills.
  assert.equal(
    assertedHits(scanForSafetySignals("no fever or chills, nothing like that")).length,
    0,
  );
});

test("a negated list separated by commas stays negated", () => {
  // Each item carries its own trigger, so comma-as-terminator is safe here.
  assert.equal(
    assertedHits(scanForSafetySignals("no fever, no chills, no bleeding")).length,
    0,
  );
});

// --- provenance --------------------------------------------------------------
// The eCRF once received "AE-001 Dizziness G2" with the verbatim quote "the
// kitchen sort of went sideways on me" — words no subject spoke. Every guard in
// place at the time protected the channel; none protected the destination.
test("refuses a quote with no basis in the transcript", () => {
  const spoken = [
    "I've been very tired, I couldn't shower Tuesday, my daughter had to help me",
  ];
  const v = checkProvenance(
    "the kitchen sort of went sideways on me, I had to grab the counter",
    spoken,
  );
  assert.equal(v.grounded, false);
  assert.equal(v.score, 0);
  assert.match(v.reason ?? "", /appears in any single thing the subject said/);
});

test("accepts a genuine capture, including a trimmed one", () => {
  const spoken = [
    "I've been very tired, I couldn't shower Tuesday, my daughter had to help me",
  ];
  for (const quote of [
    "I've been very tired, I couldn't shower Tuesday, my daughter had to help me",
    "very tired, couldn't shower Tuesday",
    "couldn't shower, daughter had to help",
    "tired; showering needed help from my daughter",
  ]) {
    assert.equal(checkProvenance(quote, spoken).grounded, true, `refused: ${quote}`);
  }
});

test("a short quote must match completely", () => {
  // verbatim_term is by nature a short symptom phrase, so exempting short quotes
  // left the exact field the closed incident concerned still admitting brief
  // fabrications. They are held to a full match instead.
  const spoken = ["I've had dizzy spells when I stand up too fast"];
  assert.equal(checkProvenance("dizzy spells", spoken).grounded, true);
  assert.equal(checkProvenance("chest pain", spoken).grounded, false);
});

test("a short quote is not exempt from an empty transcript", () => {
  // Previously the short-quote exemption ran BEFORE the empty-transcript check,
  // so a brief invention passed even when the subject had said nothing.
  for (const quote of ["dizzy spells", "pins and needles", "the shakes"]) {
    assert.equal(checkProvenance(quote, []).grounded, false, `admitted: ${quote}`);
  }
});

test("pure stopword answers carry no evidential content", () => {
  // "Yes" / "None" cannot be scored and must not be refused.
  assert.equal(checkProvenance("yes", ["No, none at all."]).grounded, true);
  assert.equal(checkProvenance("none", ["No, none at all."]).grounded, true);
});

test("a quote that drops the subject's negation is refused", () => {
  // Word overlap alone scores this 1.00 — the quote reuses every word and
  // reverses the meaning.
  const v = checkProvenance("I have had chest pain this week", [
    "No, I have not had any chest pain this week",
  ]);
  assert.equal(v.grounded, false);
  assert.match(v.reason ?? "", /denied|negation/i);
});

test("a negation elsewhere in the sentence does not block a genuine quote", () => {
  // "I have no appetite AND I've been vomiting blood" legitimately yields the
  // second clause. A blunt negation-word count would refuse it; ConText's
  // clause handling is what tells them apart.
  assert.equal(
    checkProvenance("I've been vomiting blood", [
      "I have no appetite and I've been vomiting blood",
    ]).grounded,
    true,
  );
});

test("a quote cannot be assembled from unrelated turns", () => {
  // Pooling every utterance let a quote borrow words from turns that between
  // them contained the vocabulary and none of the meaning.
  const v = checkProvenance("I felt chest pain on Tuesday", [
    "I took ibuprofen for my knee",
    "My chest is fine",
    "I felt pain in my knee on Tuesday",
  ]);
  assert.equal(v.grounded, false);
});

test("a quote grounded in one turn passes even when the call spans several", () => {
  // Scoring is per-utterance, never pooled. This one clears the threshold on the
  // second utterance alone, which is the honest reading: those words were said,
  // together, in one breath.
  assert.equal(
    checkProvenance("could not shower Tuesday", [
      "I've been very tired this week",
      "I could not shower Tuesday",
    ]).grounded,
    true,
  );
});

test("swapping a body site is refused however well the rest overlaps", () => {
  // Word overlap alone scores this 0.75 — one word differs and it is the only
  // one that matters.
  const v = checkProvenance("I felt chest pain on Tuesday", [
    "I felt pain in my knee on Tuesday",
  ]);
  assert.equal(v.grounded, false);
  assert.match(v.reason ?? "", /chest/);
});

test("salient words present in the source are fine", () => {
  assert.equal(
    checkProvenance("I've been vomiting blood", [
      "I have no appetite and I've been vomiting blood",
    ]).grounded,
    true,
  );
});

test("a word matches its own plural", () => {
  // One-directional stemming turned "headaches" into "headach" while "headache"
  // stayed itself, so these scored 0.00 and were refused.
  assert.equal(
    checkProvenance("headaches doses nurses bruises", [
      "headache dose nurse bruise",
    ]).grounded,
    true,
  );
  assert.equal(
    checkProvenance("the nurses gave me doses of the rescue medicine", [
      "The nurse gave me a dose of the rescue medicine",
    ]).grounded,
    true,
  );
});

test("nothing is quotable before the subject has spoken", () => {
  const v = checkProvenance("I have had chest pain since last night", []);
  assert.equal(v.grounded, false);
  assert.match(v.reason ?? "", /has not said anything yet/);
});


test("a history stated in one sentence is not un-scoped by the next", () => {
  // The tokenizer drops terminators rather than emitting them, so a lookahead
  // that does not check the sentence walks into the following one: "I had a
  // seizure years ago. Days have been fine since." cancelled a correct
  // historical scope on the word "Days" and escalated a years-old seizure as a
  // current emergency.
  for (const text of [
    "I had a seizure years ago. Days have been fine since.",
    "I had convulsions a long time ago. Weeks go by now.",
    "I had a fever last year. A couple of days later it passed.",
  ]) {
    assert.equal(
      assertedHits(scanForSafetySignals(text)).length,
      0,
      `"${text}" escalated a history`,
    );
  }
});

test("only an ambiguous historical phrase is cancelled by what follows it", () => {
  // "years ago" is history whatever comes next. "in the past" is history on its
  // own and a recall window followed by a short unit — and it is listed as both a
  // forward and a backward trigger, so the cancellation cannot be keyed on
  // direction.
  assert.ok(
    assertedHits(scanForSafetySignals("I coughed up blood in the past few days")).length > 0,
    "a recall window was stood down as history",
  );
  assert.equal(
    assertedHits(scanForSafetySignals("I coughed up blood in the past, before the study")).length,
    0,
    "a genuine history fired",
  );
});
