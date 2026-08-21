import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateFabricatedTurn } from "../lib/agent/runner.ts";

const thinking = {
  type: "thinking" as const,
  thinking: "The subject has not answered yet.",
  signature: "sig",
};
const text = (t: string) => ({ type: "text" as const, text: t, citations: null });
const toolUse = (name: string) => ({
  type: "tool_use" as const,
  id: "tu_1",
  name,
  input: {},
});

test("only what the agent actually said survives", () => {
  const raw = [
    text(
      "Thank you. How have you been feeling since we last spoke?\n\nuseKind of a mixed bag.",
    ),
  ];
  const kept = truncateFabricatedTurn(
    raw,
    "Thank you. How have you been feeling since we last spoke?",
  );
  const joined = kept.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.equal(joined, "Thank you. How have you been feeling since we last spoke?");
  assert.ok(!joined.includes("mixed bag"), "the invented reply stayed in history");
});

test("thinking blocks are preserved, because they must replay unchanged", () => {
  const kept = truncateFabricatedTurn([thinking, text("Hello.\n\nuser: hi")], "Hello.");
  assert.equal(kept[0].type, "thinking");
});

test("a tool call after the fabrication is dropped, not executed", () => {
  const kept = truncateFabricatedTurn(
    [text("Thank you.\n\nuseI've been dizzy."), toolUse("record_adverse_event")],
    "Thank you.",
  );
  assert.ok(
    !kept.some((b) => b.type === "tool_use"),
    "a tool call from a turn that invented the subject's words was kept",
  );
});

test("a turn fabricated from its first token still yields a valid message", () => {
  const kept = truncateFabricatedTurn([thinking, text("\n\nuser: I feel fine.")], "");
  assert.ok(kept.some((b) => b.type === "text"), "the API rejects an empty assistant turn");
  const spoken = kept.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.ok(!spoken.includes("I feel fine"), "the invention survived as the whole turn");
});

test("a turn with no text block is returned untouched", () => {
  const raw = [thinking, toolUse("verify_subject")];
  assert.deepEqual(truncateFabricatedTurn(raw, ""), raw);
});
