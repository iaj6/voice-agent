/**
 * Which number to give someone, where they actually are.
 *
 * The system told every participant to call 911 and, in a crisis, to text 988.
 * Both are US numbers. A multi-site trial is routinely multi-country, and giving
 * a participant in Manchester a US number during a cardiac event costs them the
 * seconds that matter most; giving someone in crisis a dead line is worse than
 * giving them nothing, because they will try it and it will not answer.
 *
 * **A wrong number is worse than no number.** So an unknown region gets
 * "your local emergency number" rather than a guess. That phrasing is weaker
 * guidance and it cannot send anyone to the wrong place, which is the trade this
 * table is here to make deliberately rather than by omission.
 */

export interface CrisisLine {
  /** What to call it out loud. Named services answer faster than bare digits. */
  name: string;
  /** How to reach it, spoken. */
  contact: string;
}

export interface Region {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  /** Emergency services. Null where we will not assert one. */
  emergency: string | null;
  crisis: CrisisLine | null;
}

/**
 * Deliberately short.
 *
 * Every row here is a number somebody may be told to dial while frightened, so
 * the list holds only what has been checked, and unlisted countries fall through
 * to the honest hedge rather than to a plausible-looking default. 112 reaches
 * emergency services across the EU and in the UK, but "probably 112" is not a
 * standard this list applies to itself.
 */
const REGIONS: Region[] = [
  {
    code: "US",
    name: "United States",
    emergency: "911",
    crisis: { name: "the 988 Suicide and Crisis Lifeline", contact: "calling or texting 988" },
  },
  {
    code: "CA",
    name: "Canada",
    emergency: "911",
    crisis: { name: "the 988 Suicide Crisis Helpline", contact: "calling or texting 988" },
  },
  {
    code: "GB",
    name: "United Kingdom",
    emergency: "999",
    crisis: { name: "Samaritans", contact: "calling 116 123" },
  },
  {
    code: "IE",
    name: "Ireland",
    emergency: "112",
    crisis: { name: "Samaritans", contact: "calling 116 123" },
  },
  {
    code: "AU",
    name: "Australia",
    emergency: "000",
    crisis: { name: "Lifeline", contact: "calling 13 11 14" },
  },
  {
    code: "NZ",
    name: "New Zealand",
    emergency: "111",
    crisis: { name: "the 1737 helpline", contact: "calling or texting 1737" },
  },
];

/** What to say when we do not know where someone is. */
export const UNKNOWN_REGION: Region = {
  code: "??",
  name: "unknown",
  emergency: null,
  crisis: null,
};

export function regionFor(code: string | null | undefined): Region {
  if (!code) return UNKNOWN_REGION;
  return (
    REGIONS.find((r) => r.code === code.trim().toUpperCase()) ?? UNKNOWN_REGION
  );
}

export function knownRegions(): readonly Region[] {
  return REGIONS;
}

/** How to refer to emergency services out loud, wherever the subject is. */
export function emergencyPhrase(region: Region): string {
  return region.emergency ?? "your local emergency number";
}

/**
 * How to refer to a crisis line out loud.
 *
 * Null where none is known, and callers must handle that by saying nothing about
 * a crisis line rather than substituting something — a participant told to
 * contact a service that does not operate where they are has been sent away from
 * help, not towards it.
 */
export function crisisPhrase(region: Region): string | null {
  return region.crisis ? `${region.crisis.name} by ${region.crisis.contact}` : null;
}

/**
 * Placeholders the rule instructions carry, resolved when a message is built.
 *
 * The rules stay declarative and country-free; substitution happens once, at the
 * point a session is known, so no rule text has to be duplicated per region and
 * none of them can drift.
 */
export const EMERGENCY_TOKEN = "{{EMERGENCY_NUMBER}}";
export const CRISIS_TOKEN = "{{CRISIS_LINE}}";

export function localise(text: string, region: Region): string {
  const crisis = crisisPhrase(region);
  return text
    .split(EMERGENCY_TOKEN)
    .join(emergencyPhrase(region))
    .split(CRISIS_TOKEN)
    .join(
      crisis ??
        // No known line: name the fallback that does exist everywhere rather
        // than a service that does not.
        "their study site, or emergency services if they are in immediate danger",
    );
}

/**
 * The region implied by a subject ID that has been spoken but not yet verified.
 *
 * Verification happens several turns in, and the deterministic net fires on the
 * first utterance — "March 11th 1958, sorry, I've been coughing up blood since
 * last night" is the case this codebase already documents as routine. Resolving
 * the region only from a *verified* subject meant that at the single most
 * time-critical moment the agent had, it said "your local emergency number"
 * instead of a number.
 *
 * The site prefix of a subject ID is enough to answer "which country's emergency
 * services", and it is said before the date of birth. This is a hint and nothing
 * else: it decides which number to speak aloud and is never used to unlock a
 * clinical write, which stays behind two-factor verification. The worst case is
 * someone mis-stating their ID and hearing the wrong country's number — no worse
 * than the hedge it replaces, and better for everyone who states it correctly.
 */
export function regionFromSpokenId(
  utterances: readonly string[],
  siteCountryFor: (sitePrefix: string) => string | null,
): Region {
  for (const utterance of [...utterances].reverse()) {
    const match = /\b(\d{3})\s*[-–—]?\s*(\d{4})\b/.exec(utterance);
    if (!match) continue;
    const country = siteCountryFor(match[1]);
    if (country) return regionFor(country);
  }
  return UNKNOWN_REGION;
}

/**
 * The region to speak numbers for, best available answer first.
 *
 * A verified subject is authoritative. Failing that, the site prefix of an ID the
 * subject has already said. Failing that, the hedge — which is correct when the
 * country is genuinely unknowable and wrong as a default when it is not.
 */
export function speakingRegion(
  subjectCountry: string | null | undefined,
  utterances: readonly string[],
  siteCountryFor: (sitePrefix: string) => string | null,
): Region {
  const verified = regionFor(subjectCountry);
  if (verified !== UNKNOWN_REGION) return verified;
  return regionFromSpokenId(utterances, siteCountryFor);
}
