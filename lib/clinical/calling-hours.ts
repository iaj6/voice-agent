/**
 * When the agent will take a call.
 *
 * The system had no answer to this, and made the decision by accident: it would
 * take a check-in at 03:00 and escalate into an inbox nobody was watching, which
 * made "your coordinator has been alerted" true by luck of the hour. D-C in
 * docs/ONCALL.md chose to close that gap by matching the promise to the cover —
 * the agent runs when somebody is on call, and not otherwise.
 *
 * **One window, not one per site.** The pilot is a single site (SPEC §2), so a
 * single window is the correct shape; the two-country roster is fixture data for
 * exercising the locale work. A trial that genuinely spans timezones needs
 * per-site windows, and the honest place to notice that is here rather than in
 * production.
 *
 * Unset means always open. A missing configuration must not make a development
 * checkout refuse every call — but a deployment that takes real calls should set
 * it. The README documents it; `npm run verify` does not check it, and claiming
 * otherwise here was a check that did not exist.
 */

export interface CallWindow {
  /** IANA zone. The site's local time is the only time that matters here. */
  timeZone: string;
  /** 0 = Sunday. Days the site is covered. */
  days: number[];
  /** Minutes from local midnight. */
  startMinute: number;
  endMinute: number;
}

export interface WindowState {
  open: boolean;
  /** Null when no window is configured, i.e. always open. */
  window: CallWindow | null;
  /** When it next opens, if closed. */
  opensAt: Date | null;
  /** Something a person can be told out loud. */
  reopensDescription: string | null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Parses `Mon-Fri 09:00-17:00 America/New_York`.
 *
 * One string rather than four environment variables, because the four can
 * disagree with each other and a half-configured window is worse than none — it
 * looks configured.
 */
export function parseCallWindow(spec: string): CallWindow {
  const match =
    /^([A-Za-z]{3})\s*-\s*([A-Za-z]{3})\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s+(\S+)$/.exec(
      spec.trim(),
    );
  if (!match) {
    throw new Error(
      `Could not read call window "${spec}". Expected e.g. ` +
        '"Mon-Fri 09:00-17:00 America/New_York".',
    );
  }
  const [, fromDay, toDay, h1, m1, h2, m2, timeZone] = match;
  const from = DAY_NAMES.findIndex((d) => d.toLowerCase() === fromDay.toLowerCase());
  const to = DAY_NAMES.findIndex((d) => d.toLowerCase() === toDay.toLowerCase());
  if (from === -1 || to === -1) throw new Error(`Unknown day in call window "${spec}".`);

  const days: number[] = [];
  for (let d = from; ; d = (d + 1) % 7) {
    days.push(d);
    if (d === to) break;
    if (days.length > 7) throw new Error(`Call window "${spec}" never ends.`);
  }

  const startMinute = Number(h1) * 60 + Number(m1);
  const endMinute = Number(h2) * 60 + Number(m2);
  if (endMinute <= startMinute) {
    // Overnight windows are a different shape and this pilot does not need one;
    // accepting the string and silently doing something else would be worse.
    throw new Error(
      `Call window "${spec}" ends before it starts. Overnight windows are not supported.`,
    );
  }
  // Validate the zone now rather than at 3am on a Sunday.
  new Intl.DateTimeFormat("en-GB", { timeZone });

  return { timeZone, days, startMinute, endMinute };
}

let cached: { spec: string; window: CallWindow | null } | null = null;

/**
 * The configured window, parsed once and never allowed to throw.
 *
 * It used to re-parse on every call and propagate a parse error, so a typo in
 * the environment variable produced a raw 500 on every session open — the whole
 * agent down — and threw from inside deliverEscalation's argument list, escaping
 * the wrapper that exists so "never silent" survives the parts that are not the
 * network. A malformed window now degrades to always-open and says so loudly
 * once, which is the failure that leaves a participant able to call.
 */
export function configuredWindow(): CallWindow | null {
  const spec = process.env.VOICE_AGENT_CALL_WINDOW?.trim() ?? "";
  if (cached?.spec === spec) return cached.window;

  let window: CallWindow | null = null;
  if (spec) {
    try {
      window = parseCallWindow(spec);
    } catch (err) {
      console.error(
        `VOICE_AGENT_CALL_WINDOW is not usable and is being ignored, so the ` +
          `check-in line will accept calls at any hour: ${String(err)}`,
      );
      window = null;
    }
  }
  cached = { spec, window };
  return window;
}

/** Test seam: forget the parsed window. */
export function __resetCallWindow(): void {
  cached = null;
}

/**
 * One formatter per zone, kept.
 *
 * Constructing an Intl.DateTimeFormat is the expensive part — building a fresh
 * one inside a minute-by-minute scan cost about 105ms per Friday-to-Monday
 * search, on an unauthenticated route, which makes a burst outside hours a way
 * to pin the event loop. The scan itself is cheap.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Local wall-clock parts for an instant, in the window's zone. */
function localParts(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = formatterFor(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = DAY_NAMES.findIndex((d) => d.toLowerCase() === get("weekday").toLowerCase());
  return { day, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function windowState(at: Date = new Date(), window = configuredWindow()): WindowState {
  if (!window) {
    return { open: true, window: null, opensAt: null, reopensDescription: null };
  }

  const { day, minute } = localParts(at, window.timeZone);
  const open =
    window.days.includes(day) && minute >= window.startMinute && minute < window.endMinute;
  if (open) return { open: true, window, opensAt: null, reopensDescription: null };

  const opensAt = nextOpening(at, window);
  return {
    open: false,
    window,
    opensAt,
    reopensDescription: describe(opensAt, window),
  };
}

/** The next instant the window is open, searched minute-coarse over a fortnight. */
export function nextOpening(from: Date, window: CallWindow): Date {
  // A plain minute scan, with the formatter hoisted. An earlier attempt stepped
  // by hour and required `minute < startMinute`, which silently never matched a
  // window opening on the hour — the kind of cleverness that buys microseconds
  // and costs correctness. The scan is now fast because the formatter is reused,
  // not because the loop is smart.
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 15; i++) {
    cursor.setTime(cursor.getTime() + 60_000);
    const { day, minute } = localParts(cursor, window.timeZone);
    if (window.days.includes(day) && minute === window.startMinute) {
      return new Date(cursor.getTime());
    }
  }
  // A window that never opens in a fortnight is a misconfiguration, and saying
  // so beats returning a date nobody should trust.
  throw new Error("Call window does not open within the next two weeks.");
}

/**
 * The end of the next open period — "by close of the next business day".
 *
 * The first version used the *opening* instant, so a routine escalation raised
 * on Friday afternoon fell due at 09:00:00 Monday and the one-minute sweep paged
 * the backup contact at 09:01, before anyone had opened their mail. A deadline
 * that expires as the office unlocks is not a deadline.
 */
export function endOfNextOpening(from: Date, window: CallWindow): Date {
  const opens = nextOpening(from, window);
  return new Date(opens.getTime() + (window.endMinute - window.startMinute) * 60_000);
}

function describe(at: Date, window: CallWindow): string {
  // With the zone named. A bare "Monday at 9:00am" spoken to a participant at a
  // UK site, against a New York window, sends them back four hours early.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: window.timeZone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}${get("dayPeriod")?.toLowerCase() ?? ""}`;
  return `${get("weekday")} at ${time} ${get("timeZoneName")}`;
}
