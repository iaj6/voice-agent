/**
 * How an escalation leaves this system.
 *
 * Behind an interface because the destination is a site decision, not an
 * engineering one — D-2 chose email for the pilot, and a real site is more
 * likely to want a webhook into whatever already owns their on-call. The parts
 * that matter (a delivery record per attempt, an acknowledgement that is
 * attributable, an alarm when nobody acknowledges) are the same either way.
 */

export interface EscalationMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  providerId: string;
}

export interface EscalationTransport {
  readonly channel: string;
  send(message: EscalationMessage): Promise<SendResult>;
}

/** Thrown when a send did not happen. Never swallowed — see deliver.ts. */
export class DeliveryFailure extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Escalation delivery failed: ${detail}`);
    this.detail = detail;
  }
}

class ResendTransport implements EscalationTransport {
  readonly channel = "email:resend";
  private readonly apiKey: string;
  private readonly from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(message: EscalationMessage): Promise<SendResult> {
    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new DeliveryFailure(`could not reach the mail provider: ${String(err)}`);
    }

    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };

    if (!response.ok) {
      throw new DeliveryFailure(
        `provider returned ${response.status}: ${body.message ?? body.name ?? "no detail"}`,
      );
    }
    if (!body.id) {
      // A 200 with no id is not a send. Treating it as one is how a delivery
      // pipeline ends up reporting success it cannot evidence.
      throw new DeliveryFailure("provider accepted the request but returned no message id");
    }
    return { providerId: body.id };
  }
}

/**
 * What runs when nothing is configured.
 *
 * It fails, on purpose, and the failure is itself escalated (2.5). The tempting
 * alternative — log a warning and carry on — produces a system that looks like
 * it is paging coordinators and is not, which is the precise state this sprint
 * exists to end.
 */
class UnconfiguredTransport implements EscalationTransport {
  readonly channel = "none";
  private readonly why: string;

  constructor(why: string) {
    this.why = why;
  }

  async send(): Promise<SendResult> {
    throw new DeliveryFailure(this.why);
  }
}

let transport: EscalationTransport | null = null;

export function getTransport(): EscalationTransport {
  if (transport) return transport;

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ESCALATION_EMAIL_FROM;
  if (!apiKey) {
    transport = new UnconfiguredTransport("RESEND_API_KEY is not set");
  } else if (!from) {
    transport = new UnconfiguredTransport(
      "ESCALATION_EMAIL_FROM is not set, so there is no verified sender",
    );
  } else {
    transport = new ResendTransport(apiKey, from);
  }
  return transport;
}

/** Where escalations go. Absent is a failure, not a default. */
export function escalationRecipient(): string | null {
  return process.env.ESCALATION_EMAIL_TO?.trim() || null;
}

/** Test seam. */
export function __setTransport(next: EscalationTransport | null) {
  transport = next;
}
