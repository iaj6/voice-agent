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
  const { content: kept } = truncateFabricatedTurn(
    raw,
    "Thank you. How have you been feeling since we last spoke?",
  );
  const joined = kept.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.equal(joined, "Thank you. How have you been feeling since we last spoke?");
  assert.ok(!joined.includes("mixed bag"), "the invented reply stayed in history");
});

test("thinking blocks are preserved, because they must replay unchanged", () => {
  const { content: kept } = truncateFabricatedTurn([thinking, text("Hello.\n\nuser: hi")], "Hello.");
  assert.equal(kept[0].type, "thinking");
});

test("a tool call after the fabrication is dropped, not executed", () => {
  const { content: kept } = truncateFabricatedTurn(
    [text("Thank you.\n\nuseI've been dizzy."), toolUse("record_adverse_event")],
    "Thank you.",
  );
  assert.ok(
    !kept.some((b) => b.type === "tool_use"),
    "a tool call from a turn that invented the subject's words was kept",
  );
});

test("a turn fabricated from its first token keeps nothing invented", () => {
  // No placeholder stands in for the missing speech: the runner retries the
  // turn instead. A parenthetical apology written into history is something the
  // model reads back as its own words on the next pass.
  const { content: kept } = truncateFabricatedTurn(
    [thinking, text("\n\nuser: I feel fine.")],
    "",
  );
  const spoken = kept.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.equal(spoken, "", "invented text survived as the whole turn");
});

test("a turn with no text block is returned untouched", () => {
  const raw = [thinking, toolUse("verify_subject")];
  assert.deepEqual(truncateFabricatedTurn(raw, "").content, raw);
});

test("a tool call BEFORE the fabrication is dropped too", () => {
  // Keeping it left an assistant tool_use with no tool_result behind it, and
  // the turn ends before anything executes — the next request is rejected and
  // the whole call dies, not just this turn.
  const { content: kept } = truncateFabricatedTurn(
    [toolUse("record_adverse_event"), text("Okay.\n\nuser: I feel fine.")],
    "Okay.",
  );
  assert.ok(!kept.some((b) => b.type === "tool_use"));
});

test("the audit entry counts what was actually discarded", () => {
  const { discarded } = truncateFabricatedTurn(
    [text("Okay.\n\nuseI've been dizzy."), toolUse("record_adverse_event")],
    "Okay.",
  );
  assert.equal(discarded, 1, "a dropped tool call was reported as nothing dropped");
});
