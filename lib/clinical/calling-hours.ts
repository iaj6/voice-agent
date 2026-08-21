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
 * it, which is what `npm run verify` reports and what the README says.
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

export function configuredWindow(): CallWindow | null {
  const spec = process.env.VOICE_AGENT_CALL_WINDOW?.trim();
  return spec ? parseCallWindow(spec) : null;
}

/** Local wall-clock parts for an instant, in the window's zone. */
function localParts(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
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
  const cursor = new Date(from.getTime());
  // Round up to the next minute so "now" cannot satisfy a closed window.
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 14; i++) {
    cursor.setTime(cursor.getTime() + 60_000);
    const { day, minute } = localParts(cursor, window.timeZone);
    if (window.days.includes(day) && minute === window.startMinute) return cursor;
  }
  // A window that never opens in a fortnight is a misconfiguration, and saying
  // so beats returning a date nobody should trust.
  throw new Error("Call window does not open within the next two weeks.");
}

function describe(at: Date, window: CallWindow): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: window.timeZone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}${get("dayPeriod")?.toLowerCase() ?? ""}`;
  return `${get("weekday")} at ${time}`;
}
