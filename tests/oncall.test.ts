/**
 * The on-call decisions from docs/ONCALL.md, as they behave.
 *
 * The windows were placeholders an engineer invented; these are the ones the
 * site agreed to. The calling window is the one that changes what a participant
 * experiences, and it exists so that "your coordinator has been alerted" is true
 * when it is said rather than true by luck of the hour.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  configuredWindow,
  nextOpening,
  parseCallWindow,
  windowState,
} from "../lib/clinical/calling-hours.ts";
import { ACK_SLA_MS, ackDeadline } from "../lib/escalation/sla.ts";
import { composeDigest } from "../lib/escalation/digest.ts";
import type { DeliveryRecord } from "../lib/store/deliveries.ts";

const OFFICE = "Mon-Fri 09:00-17:00 America/New_York";

beforeEach(() => {
  delete process.env.VOICE_AGENT_CALL_WINDOW;
});

test("the agreed windows are what the code uses", () => {
  assert.equal(ACK_SLA_MS.emergency, 15 * 60 * 1000, "emergency is not 15 minutes");
  assert.equal(ACK_SLA_MS.urgent, 4 * 60 * 60 * 1000, "urgent is not 4 hours");
});

test("a malformed window is refused, not half-understood", () => {
  // A window that parses into something other than what was meant is worse than
  // one that fails: it looks configured.
  for (const bad of ["", "Mon-Fri 9-5", "Funday-Fri 09:00-17:00 UTC", "Mon-Fri 17:00-09:00 UTC"]) {
    assert.throws(() => parseCallWindow(bad), `"${bad}" was accepted`);
  }
  assert.throws(() => parseCallWindow("Mon-Fri 09:00-17:00 Mars/Olympus"));
});

test("no configured window means always open", () => {
  const state = windowState(new Date("2026-08-22T03:00:00Z"));
  assert.equal(state.open, true, "a checkout with no window configured refused a call");
  assert.equal(state.window, null);
});

test("the line is closed outside cover, and says when it reopens", () => {
  const window = parseCallWindow(OFFICE);

  const saturday = windowState(new Date("2026-08-22T03:00:00Z"), window);
  assert.equal(saturday.open, false);
  assert.match(saturday.reopensDescription!, /Monday at 9:00am/);

  const overnight = windowState(new Date("2026-08-26T06:00:00Z"), window);
  assert.equal(overnight.open, false, "2am on a Wednesday should be closed");
  assert.match(overnight.reopensDescription!, /Wednesday at 9:00am/);

  const midday = windowState(new Date("2026-08-26T15:00:00Z"), window);
  assert.equal(midday.open, true, "11am on a Wednesday should be open");
});

test("the boundaries are inclusive at the start and exclusive at the end", () => {
  const window = parseCallWindow(OFFICE);
  // 09:00 ET on a Wednesday, and 17:00 ET the same day.
  assert.equal(windowState(new Date("2026-08-26T13:00:00Z"), window).open, true);
  assert.equal(windowState(new Date("2026-08-26T21:00:00Z"), window).open, false);
});

test("routine escalations are due the next business day, not in 24 hours", () => {
  // Raised 4pm Friday. A fixed 24-hour deadline lands Saturday afternoon, passes
  // unseen, and alarms into an empty office.
  process.env.VOICE_AGENT_CALL_WINDOW = OFFICE;
  const fridayAfternoon = Date.parse("2026-08-21T20:00:00Z");
  const due = ackDeadline("routine", fridayAfternoon);

  const window = configuredWindow()!;
  assert.equal(windowState(due, window).open, true, "the deadline is when nobody is on call");
  assert.ok(
    due.getTime() > fridayAfternoon + 24 * 3600 * 1000,
    "the deadline fell on the weekend",
  );
  assert.equal(
    due.getTime(),
    nextOpening(new Date(fridayAfternoon), window).getTime(),
    "not the next opening",
  );
});

test("emergency and urgent deadlines ignore the window", () => {
  // They are meant to interrupt whoever is covering, and an interruption that
  // waits for opening hours is not one.
  process.env.VOICE_AGENT_CALL_WINDOW = OFFICE;
  const saturday = Date.parse("2026-08-22T03:00:00Z");
  assert.equal(ackDeadline("emergency", saturday).getTime(), saturday + ACK_SLA_MS.emergency);
  assert.equal(ackDeadline("urgent", saturday).getTime(), saturday + ACK_SLA_MS.urgent);
});

const row = (over: Partial<DeliveryRecord>): DeliveryRecord => ({
  id: "d",
  sessionId: "s",
  escalationId: "ESC-001",
  subjectId: "001-0042",
  urgency: "urgent",
  channel: "test",
  destination: "coordinator@example.test",
  attempt: 1,
  tier: "primary",
  status: "sent",
  providerId: "p",
  error: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  deadlineAt: new Date().toISOString(),
  ...over,
});

test("the digest names what is overdue and carries no clinical detail", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  const { subject, text } = composeDigest(
    [
      row({ escalationId: "ESC-001", deadlineAt: "2026-08-21T09:00:00Z" }),
      row({ escalationId: "ESC-002", deadlineAt: "2026-08-21T18:00:00Z" }),
    ],
    now,
  );

  assert.match(subject, /1 escalation\(s\) past their response window/);
  assert.match(text, /OVERDUE/);
  assert.match(text, /ESC-001/);
  assert.match(text, /ESC-002/);
  // Same reasoning as the notifications: detail stays behind the link.
  assert.ok(!/verbatim|symptom|chest|tired/i.test(text), "clinical detail reached the digest");
});

test("a quiet day sends nothing", () => {
  // A daily "all clear" trains people to delete it unread, which is how the one
  // that matters gets missed.
  const { subject } = composeDigest([row({})], new Date());
  assert.match(subject, /awaiting acknowledgement/);
});
