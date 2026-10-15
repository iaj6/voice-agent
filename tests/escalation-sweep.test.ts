/**
 * The escalation ladder: retry, backup contact, alarm.
 *
 * `overdue()` existed before this and nothing called it, which meant an
 * escalation nobody opened looked exactly like one that had been handled. These
 * tests move time rather than wait for it — an alarm that can only be observed
 * by sleeping for an hour is an alarm nobody tests.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/agent/tools.ts";
import { __setSessionStore, getSessionStore } from "../lib/store/session-store.ts";
import { __setKeyStore } from "../lib/store/keys.ts";
import { __setSubjectStore } from "../lib/store/subjects.ts";
import { __setDeliveryStore, getDeliveryStore } from "../lib/store/deliveries.ts";
import {
  __setTransport,
  DeliveryFailure,
  type EscalationMessage,
  type EscalationTransport,
} from "../lib/escalation/transport.ts";
import { ACK_SLA_MS } from "../lib/escalation/sla.ts";
import { MAX_RETRIES, sweepEscalations } from "../lib/escalation/sweep.ts";
import type { CheckInSession } from "../lib/store/session.ts";

process.env.VOICE_AGENT_PUBLIC_URL = "http://localhost:3100";

const VERIFY = { subject_id: "001-0042", date_of_birth: "1958-03-11", respondent: "self" };
const ESCALATE = {
  urgency: "emergency",
  reason: "Possible cardiac or respiratory emergency.",
  related_event_ids: [],
};

class Capturing implements EscalationTransport {
  readonly channel = "test";
  sent: EscalationMessage[] = [];
  failing = false;
  async send(message: EscalationMessage) {
    if (this.failing) throw new DeliveryFailure("provider is down");
    this.sent.push(message);
    return { providerId: `test_${this.sent.length}` };
  }
}

let transport: Capturing;

beforeEach(() => {
  __setSessionStore(null);
  __setKeyStore(null);
  __setSubjectStore(null);
  __setDeliveryStore(null);
  delete process.env.DATABASE_URL;
  process.env.ESCALATION_EMAIL_TO = "primary@example.test";
  process.env.ESCALATION_EMAIL_SECONDARY = "backup@example.test";
  delete process.env.ESCALATION_EMAIL_ALARM;
  transport = new Capturing();
  __setTransport(transport);
});

async function escalatedCall(): Promise<CheckInSession> {
  const session = await getSessionStore().create();
  session.subjectUtterances = ["I've been very tired"];
  await executeTool(session, "verify_subject", VERIFY);
  await executeTool(session, "escalate_to_coordinator", ESCALATE);
  // Persisted, as runTurn does after every tool batch. The sweeper reads the
  // record, not a caller's in-memory object.
  await getSessionStore().save(session);
  return session;
}

/** Comfortably past the retry backoff. */
const RETRY_WINDOW = 120_000;
const later = (ms: number) => new Date(Date.now() + ms);
const pastDeadline = () => later(ACK_SLA_MS.emergency + 60_000);

test("inside the response window, nothing happens", async () => {
  await escalatedCall();
  const result = await sweepEscalations(new Date());
  assert.equal(result.escalatedToSecondary, 0);
  assert.equal(result.alarmed, 0);
  assert.equal(result.stillWaiting, 1);
  assert.equal(transport.sent.length, 1, "the sweep sent something it should not have");
});

test("an unacknowledged page reaches the backup contact once the window closes", async () => {
  await escalatedCall();
  const result = await sweepEscalations(pastDeadline());

  assert.equal(result.escalatedToSecondary, 1);
  assert.equal(transport.sent.length, 2, "the backup was not paged");
  assert.equal(transport.sent[1].to, "backup@example.test");
  assert.match(transport.sent[1].subject, /ESCALATED — no response/);
  assert.match(transport.sent[1].text, /You are the backup contact/);
});

test("the sweep is idempotent — running it again pages nobody twice", async () => {
  await escalatedCall();
  const at = pastDeadline();
  await sweepEscalations(at);
  const second = await sweepEscalations(at);

  assert.equal(second.escalatedToSecondary, 0, "the backup was paged twice");
  assert.equal(transport.sent.length, 2);
});

test("acknowledging retires the whole ladder", async () => {
  const session = await escalatedCall();
  const token = transport.sent[0].text.match(/ack\?t=([A-Za-z0-9_-]+)/)![1];
  await getDeliveryStore().acknowledge(token, "Dana Whitfield, RN");

  const result = await sweepEscalations(pastDeadline());
  assert.equal(result.escalatedToSecondary, 0, "a handled escalation still climbed the ladder");
  assert.equal(result.alarmed, 0);
  assert.equal(transport.sent.length, 1);
  assert.ok(session.id);
});

test("when the backup also lets the window close, an alarm is raised", async () => {
  const session = await escalatedCall();
  await sweepEscalations(pastDeadline());

  // Far enough out that the backup's own window has closed too.
  const result = await sweepEscalations(later(ACK_SLA_MS.emergency * 4));
  assert.equal(result.alarmed, 1);
  assert.equal(transport.sent.length, 3);
  assert.match(transport.sent[2].subject, /UNACKNOWLEDGED/);
  assert.match(transport.sent[2].text, /NOBODY HAS ACKNOWLEDGED THIS/);

  const reloaded = (await getSessionStore().get(session.id))!;
  const alarm = reloaded.audit.all().find((e) => e.action === "ESCALATION_ALARM");
  assert.ok(alarm, "the alarm is not on the participant's record");
  assert.equal(reloaded.audit.verifyChain().valid, true);
});

test("with no backup configured, the ladder is one rung and alarms directly", async () => {
  delete process.env.ESCALATION_EMAIL_SECONDARY;
  await escalatedCall();

  const result = await sweepEscalations(pastDeadline());
  assert.equal(result.escalatedToSecondary, 0);
  assert.equal(result.alarmed, 1, "a missing backup silently swallowed the alarm");
  assert.match(transport.sent[1].subject, /UNACKNOWLEDGED/);
});

test("a send that failed is retried out of band, where a live call could not", async () => {
  transport.failing = true;
  await escalatedCall();
  assert.equal(transport.sent.length, 0, "nothing should have gone out");

  transport.failing = false;
  const result = await sweepEscalations(later(RETRY_WINDOW));
  assert.equal(result.retried, 1, "a failed page was never retried");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].to, "primary@example.test");
});

test("a provider that never recovers alarms instead of retrying forever", async () => {
  transport.failing = true;
  const { id: sessionId } = await escalatedCall();

  // Summed across passes: the alarm fires once, on whichever pass exhausts the
  // retries, and every pass after it is a no-op. Reading only the last result
  // would report zero and look like the alarm never happened.
  let alarms = 0;
  let attempts = 0;
  for (let i = 0; i < MAX_RETRIES + 3; i++) {
    const pass = await sweepEscalations(later(RETRY_WINDOW * (i + 1)));
    alarms += pass.alarmed;
    attempts += pass.retried;
  }
  assert.equal(alarms, 1, "a permanently broken provider retried forever, or never alarmed");
  assert.equal(attempts, 0, "a broken provider reported successful retries");

  // The alarm itself could not be delivered either — the provider is down — so
  // the durable record of it is the audit entry, not an email.
  const session = (await getSessionStore().get(sessionId))!;
  assert.ok(
    session.audit.all().some((e) => e.action === "ESCALATION_ALARM"),
    "nothing on the record says this escalation was never delivered to anyone",
  );
});


test("a repeat trigger never claims a page that failed", async () => {
  // The dedupe path passed a literal `true` for "delivered", so on the second
  // trigger the agent was told the coordinator HAS been paged and may say so —
  // reinstating, on the repeat path, the exact false claim this subsystem was
  // built to remove.
  const { runTurn } = await import("../lib/agent/runner.ts");
  transport.failing = true;
  const session = await getSessionStore().create();

  for (const utterance of ["I can't breathe", "I still can't breathe"]) {
    for await (const event of runTurn(session, { source: "subject", utterance })) {
      void event;
    }
  }

  const operator = session.messages.filter(
    (m) => m.role === "system" && typeof m.content === "string",
  );
  assert.ok(operator.length >= 2, "the repeat trigger produced no operator message");
  for (const message of operator) {
    assert.match(
      String(message.content),
      /did NOT go through/,
      "the agent was told a failed page had reached the coordinator",
    );
  }
});

test("two rules firing at once still dedupe on a repeat", async () => {
  // The key was sorted and the stored reason was not — and hits are ordered by
  // urgency rank, not alphabetically — so any two-rule utterance never matched
  // its own duplicate and paged twice for one event.
  const { runTurn } = await import("../lib/agent/runner.ts");
  const session = await getSessionStore().create();
  const utterance = "I can't breathe and I passed out";

  for (let i = 0; i < 2; i++) {
    for await (const event of runTurn(session, { source: "subject", utterance })) {
      void event;
    }
  }

  const raised = session.escalations.filter((e) => e.triggeredBy === "safety_net");
  assert.equal(raised.length, 1, "a two-rule emergency raised two escalations");
  assert.equal(transport.sent.length, 1, "a two-rule emergency paged twice");
});

test("an alarm whose own send fails does not re-alarm forever", async () => {
  // fail() hardcoded tier "primary", so an alarm that could not be delivered was
  // filed as a primary attempt — the sweep never saw an alarm row, alarmed again
  // on every pass, and wrote a fresh ESCALATION_ALARM onto a participant's audit
  // trail every minute indefinitely.
  transport.failing = true;
  const { id } = await escalatedCall();

  let alarms = 0;
  for (let i = 0; i < MAX_RETRIES + 6; i++) {
    alarms += (await sweepEscalations(later(RETRY_WINDOW * (i + 1)))).alarmed;
  }
  assert.equal(alarms, 1, "the sweep alarmed repeatedly for one escalation");

  const session = (await getSessionStore().get(id))!;
  const entries = session.audit.all().filter((e) => e.action === "ESCALATION_ALARM");
  assert.equal(entries.length, 1, "the audit trail collected duplicate alarms");
});

test("a churning sweep reports the churn instead of all zeros", async () => {
  transport.failing = true;
  await escalatedCall();
  const pass = await sweepEscalations(later(RETRY_WINDOW));

  assert.equal(pass.retried, 0);
  assert.equal(pass.retriesFailed, 1, "a failed retry reported as nothing happening");
});

test("an alarmed escalation leaves the sweeper's working set", async () => {
  delete process.env.ESCALATION_EMAIL_SECONDARY;
  await escalatedCall();
  await sweepEscalations(pastDeadline());

  const open = await getDeliveryStore().openLadder();
  assert.deepEqual(open, [], "an alarmed escalation is swept forever");
});

test("a failed routine page is retried, not stalled forever", async () => {
  // Backoff used to reconstruct the send time by subtracting the SLA from the
  // deadline. Once routine deadlines started resolving against the call window
  // that inversion stopped holding: the derived send time landed in the future,
  // elapsed time went negative, and the backoff never expired.
  process.env.VOICE_AGENT_CALL_WINDOW = "Mon-Fri 09:00-17:00 America/New_York";
  const { __resetCallWindow } = await import("../lib/clinical/calling-hours.ts");
  __resetCallWindow();

  transport.failing = true;
  const session = await getSessionStore().create();
  session.subjectUtterances = ["I've been very tired"];
  await executeTool(session, "verify_subject", VERIFY);
  await executeTool(session, "escalate_to_coordinator", {
    urgency: "routine",
    reason: "Worth a look at the next review.",
    related_event_ids: [],
  });
  await getSessionStore().save(session);

  transport.failing = false;
  const pass = await sweepEscalations(later(RETRY_WINDOW));
  assert.equal(pass.retried, 1, "a failed routine page was never retried");

  delete process.env.VOICE_AGENT_CALL_WINDOW;
  __resetCallWindow();
});

test("the digest still reports an escalation that has already alarmed", async () => {
  // openLadder retires an escalation once the ladder is exhausted, which is
  // precisely the one the digest exists to keep reporting the next morning. It
  // was reading that query and finding nothing.
  delete process.env.ESCALATION_EMAIL_SECONDARY;
  const session = await escalatedCall();
  await sweepEscalations(pastDeadline());

  const { getDeliveryStore } = await import("../lib/store/deliveries.ts");
  assert.deepEqual(await getDeliveryStore().openLadder(), [], "the ladder should be retired");

  const outstanding = await getDeliveryStore().unacknowledged();
  assert.ok(
    outstanding.some((d) => d.sessionId === session.id),
    "an alarmed, unacknowledged escalation vanished from the digest's view",
  );
});
