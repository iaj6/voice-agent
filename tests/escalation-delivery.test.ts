/**
 * Escalation delivery: whether a page actually reached anyone, and whether the
 * record says so honestly.
 *
 * Before this, the tool returned `notified: <coordinator name>` and the agent
 * told the participant their coordinator had been alerted, while nothing had
 * been sent anywhere. SPEC.md's risk table named it: escalation not delivered,
 * participant harm, record claims otherwise.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/agent/tools.ts";
import { __setSessionStore, getSessionStore } from "../lib/store/session-store.ts";
import { __setKeyStore } from "../lib/store/keys.ts";
import { __setSubjectStore } from "../lib/store/subjects.ts";
import {
  __setDeliveryStore,
  getDeliveryStore,
} from "../lib/store/deliveries.ts";
import {
  __setTransport,
  DeliveryFailure,
  type EscalationMessage,
  type EscalationTransport,
} from "../lib/escalation/transport.ts";
import { ACK_SLA_MS } from "../lib/escalation/sla.ts";
import type { CheckInSession } from "../lib/store/session.ts";

const VERIFY = { subject_id: "001-0042", date_of_birth: "1958-03-11" };
const SPOKEN = "I've been very tired, my daughter Sarah drove me to Northlake";

class CapturingTransport implements EscalationTransport {
  readonly channel = "test";
  sent: EscalationMessage[] = [];
  async send(message: EscalationMessage) {
    this.sent.push(message);
    return { providerId: `test_${this.sent.length}` };
  }
}

class BrokenTransport implements EscalationTransport {
  readonly channel = "test";
  async send(): Promise<never> {
    throw new DeliveryFailure("the mail provider returned 500");
  }
}

let transport: CapturingTransport;

beforeEach(() => {
  __setSessionStore(null);
  __setKeyStore(null);
  __setSubjectStore(null);
  __setDeliveryStore(null);
  delete process.env.DATABASE_URL;
  process.env.ESCALATION_EMAIL_TO = "coordinator@example.test";
  transport = new CapturingTransport();
  __setTransport(transport);
});

async function verifiedCall(): Promise<CheckInSession> {
  const session = await getSessionStore().create();
  session.subjectUtterances = [SPOKEN];
  await executeTool(session, "verify_subject", VERIFY);
  return session;
}

const ESCALATE = {
  urgency: "emergency",
  reason: "Possible cardiac or respiratory emergency reported during check-in.",
  related_event_ids: [],
};

test("an escalation is actually sent, and the record says who to", async () => {
  const session = await verifiedCall();
  const out = await executeTool(session, "escalate_to_coordinator", ESCALATE);

  assert.equal(transport.sent.length, 1, "nothing was sent");
  assert.equal(transport.sent[0].to, "coordinator@example.test");
  assert.equal((out.result as Record<string, unknown>).delivered, true);

  const deliveries = await getDeliveryStore().forSession(session.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "sent");
  assert.equal(deliveries[0].providerId, "test_1");
});

test("the notification carries no transcript, verbatim or date of birth", async () => {
  const session = await verifiedCall();
  await executeTool(session, "escalate_to_coordinator", ESCALATE);

  const body = transport.sent[0].text + transport.sent[0].html + transport.sent[0].subject;
  assert.ok(!body.includes("Sarah"), "a name the subject spoke went out by email");
  assert.ok(!body.includes("1958-03-11"), "the date of birth went out by email");
  assert.ok(!body.includes(SPOKEN), "the transcript went out by email");
  // The site name is in there and belongs there: it comes from the roster, and
  // the person receiving this works at that site. What must not travel is
  // anything that is in the message *because the subject said it*.

  // What a coordinator genuinely needs to triage, and no more.
  assert.ok(body.includes("001-0042"), "the subject id is missing, so nobody can act");
  assert.ok(body.includes("cardiac or respiratory"), "the reason is missing");
});

test("a failed send never claims anyone was notified", async () => {
  __setTransport(new BrokenTransport());
  const session = await verifiedCall();
  const out = await executeTool(session, "escalate_to_coordinator", ESCALATE);
  const result = out.result as Record<string, unknown>;

  assert.equal(result.delivered, false);
  assert.equal(result.notified, null, "a failed send still named a coordinator");
  assert.equal(out.isError, true, "the model was told this call succeeded");
  assert.match(String(result.instruction), /did NOT go through/);
  assert.match(String(result.instruction), /911/, "the subject was left without a route");
  // Deliberately not a substring check for "coordinator has been alerted": the
  // instruction contains that phrase in order to forbid it, and matching on it
  // is the same double-negation mistake ConText made on "I can't breathe".
  // What matters is the machine-readable claim, asserted above as notified:null,
  // and that the instruction is phrased as a prohibition.
  assert.match(String(result.instruction), /Do not tell the subject/);
});

test("a failed send is itself escalated, never a silent log line", async () => {
  __setTransport(new BrokenTransport());
  const session = await verifiedCall();
  await executeTool(session, "escalate_to_coordinator", ESCALATE);

  const entry = session.audit
    .all()
    .find((e) => e.action === "ESCALATION_DELIVERY_FAILED");
  assert.ok(entry, "a delivery failure left no trace on the record");
  assert.match(String(entry.reason), /Nobody has been notified/);
  assert.equal(session.audit.verifyChain().valid, true);
});

test("no configured recipient is a failure, not a skip", async () => {
  delete process.env.ESCALATION_EMAIL_TO;
  const session = await verifiedCall();
  const out = await executeTool(session, "escalate_to_coordinator", ESCALATE);

  assert.equal((out.result as Record<string, unknown>).delivered, false);
  assert.equal(transport.sent.length, 0);
  assert.ok(
    session.audit.all().some((e) => e.action === "ESCALATION_DELIVERY_FAILED"),
    "no recipient configured and nothing was recorded",
  );
  assert.match(
    String((out.result as Record<string, unknown>).delivery_error),
    /ESCALATION_EMAIL_TO/,
    "the operator cannot see why nothing was sent",
  );
});

test("the acknowledgement deadline matches the urgency", async () => {
  const session = await verifiedCall();
  const before = Date.now();
  await executeTool(session, "escalate_to_coordinator", ESCALATE);

  const [delivery] = await getDeliveryStore().forSession(session.id);
  const window = Date.parse(delivery.deadlineAt) - before;
  assert.ok(
    Math.abs(window - ACK_SLA_MS.emergency) < 5_000,
    `emergency deadline was ${window}ms, expected about ${ACK_SLA_MS.emergency}ms`,
  );
});

test("acknowledging records who and when, and the first click is the one that counts", async () => {
  const session = await verifiedCall();
  await executeTool(session, "escalate_to_coordinator", ESCALATE);

  // The token only ever exists in the link; the store keeps its hash.
  const url = transport.sent[0].text.match(/ack\?t=([A-Za-z0-9_-]+)/);
  assert.ok(url, "no acknowledgement link was sent");
  const token = url[1];

  const store = getDeliveryStore();
  const first = await store.acknowledge(token, "Dana Whitfield, RN");
  assert.equal(first?.status, "acknowledged");
  assert.equal(first?.acknowledgedBy, "Dana Whitfield, RN");

  const second = await store.acknowledge(token, "Someone Else");
  assert.equal(
    second?.acknowledgedBy,
    "Dana Whitfield, RN",
    "a later click overwrote who actually responded first",
  );
});

test("an unknown token acknowledges nothing", async () => {
  assert.equal(await getDeliveryStore().acknowledge("not-a-real-token", "x"), null);
});

test("an unacknowledged escalation past its deadline shows up as overdue", async () => {
  const session = await verifiedCall();
  await executeTool(session, "escalate_to_coordinator", ESCALATE);

  const store = getDeliveryStore();
  assert.equal((await store.overdue()).length, 0, "it is overdue before the window closed");

  const past = new Date(Date.now() + ACK_SLA_MS.emergency + 1000);
  const late = await store.overdue(past);
  assert.equal(late.length, 1, "an unacknowledged emergency never became overdue");
  assert.equal(late[0].sessionId, session.id);
});

test("a delivery that failed is not counted as awaiting acknowledgement", async () => {
  __setTransport(new BrokenTransport());
  const session = await verifiedCall();
  await executeTool(session, "escalate_to_coordinator", ESCALATE);

  const past = new Date(Date.now() + ACK_SLA_MS.emergency + 1000);
  assert.deepEqual(
    await getDeliveryStore().overdue(past),
    [],
    "a failed send appears in the non-ack alarm, which is a different problem",
  );
});

test("a duplicate whose page never went out is retried, not suppressed", async () => {
  // The model is told isError when delivery fails, so it retries — and the
  // duplicate branch used to return "already raised" with no isError and no
  // delivery. Nothing in the system retries on its own and overdue() excludes
  // failed rows, so that page had no alarm surface at all: silently lost.
  __setTransport(new BrokenTransport());
  const session = await verifiedCall();
  const first = await executeTool(session, "escalate_to_coordinator", ESCALATE);
  assert.equal((first.result as Record<string, unknown>).delivered, false);

  __setTransport(transport);
  const second = await executeTool(session, "escalate_to_coordinator", ESCALATE);
  const result = second.result as Record<string, unknown>;

  assert.equal(result.already_raised, true, "a second escalation record was created");
  assert.equal(result.delivered, true, "the retry never attempted a send");
  assert.equal(transport.sent.length, 1, "the retry did not go out");
  assert.equal(session.escalations.length, 1, "one event became two escalations");
});

test("a duplicate emergency that still cannot be delivered ends the call", async () => {
  // Both halves matter. An emergency ends the call whether or not the page went
  // through, and a failed page is a stronger reason to end it, not a weaker one.
  __setTransport(new BrokenTransport());
  const session = await verifiedCall();
  await executeTool(session, "escalate_to_coordinator", ESCALATE);
  const second = await executeTool(session, "escalate_to_coordinator", ESCALATE);
  const instruction = String((second.result as Record<string, unknown>).instruction);

  assert.match(instruction, /ended_early/, "a duplicate emergency did not end the call");
  assert.match(instruction, /911/);
  assert.equal(second.isError, true);
});

test("a duplicate that was already delivered is suppressed, not sent twice", async () => {
  const session = await verifiedCall();
  await executeTool(session, "escalate_to_coordinator", ESCALATE);
  await executeTool(session, "escalate_to_coordinator", ESCALATE);

  assert.equal(transport.sent.length, 1, "one event paged the coordinator twice");
  assert.ok(
    session.audit.all().some((e) => e.action === "ESCALATION_SUPPRESSED_DUPLICATE"),
  );
});

test("a store failure is a recorded delivery failure, not a thrown error", async () => {
  // "Never silent" has to survive the parts that are not the network. Only the
  // send used to be guarded, so a database hiccup while queueing threw straight
  // out — no delivery row, no audit entry, and from the safety-net path no catch
  // at all, aborting the turn mid-emergency.
  const session = await verifiedCall();
  __setDeliveryStore({
    kind: "memory",
    queue: async () => {
      throw new Error("connection terminated unexpectedly");
    },
    markSent: async () => {},
    markFailed: async () => {},
    acknowledge: async () => null,
    forSession: async () => [],
    overdue: async () => [],
    attemptsFor: async () => 0,
  });

  const out = await executeTool(session, "escalate_to_coordinator", ESCALATE);
  assert.equal((out.result as Record<string, unknown>).delivered, false);
  assert.equal(out.isError, true);
  assert.ok(
    session.audit.all().some((e) => e.action === "ESCALATION_DELIVERY_FAILED"),
    "a store failure produced no record that the page did not go",
  );
});
