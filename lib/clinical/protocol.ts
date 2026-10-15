/**
 * Mock study protocol + subject roster.
 *
 * In a real deployment this comes from the CTMS/EDC (Medidata Rave, Veeva CDMS,
 * OpenClinica, ...) over a validated interface. Everything here is synthetic —
 * no real subject data, no PHI.
 */

/**
 * One item of the directed safety screen.
 *
 * The screen exists because listening for danger in open-ended speech is the hard
 * version of this problem and the keyword net measures 27.0% sensitive on it —
 * blind to every colloquial phrasing in the corpus. Asking directly converts
 * open-domain detection into a yes/no, which is the reliable version. A positive
 * answer escalates deterministically, without the model deciding anything.
 */
export interface SafetyScreenItem {
  /** Field name in the eCRF and in the tool schema. */
  id: string;
  /** Verbatim instrument wording. Asked word for word, every call. */
  prompt: string;
  /** Short label for the coordinator's view. */
  label: string;
  /** A "yes" here leaves the automated pathway. */
  redFlag: boolean;
  urgencyIfPositive: "routine" | "urgent" | "emergency";
  /** Omit to ask everyone. */
  appliesTo?: "childbearing_potential";
  /**
   * For items where a "yes" ends the call with a specific instruction rather than
   * the generic emergency line. The page goes out on the "yes" itself; the
   * follow-up only adds the measurement to the record, and nothing waits on it.
   */
  onPositive?: {
    /** Asked once, word for word, after the page has gone out. */
    followUpPrompt: string;
    /**
     * What the participant is told, word for word. Protocol-set wording: in a
     * real study this sentence is approved by the investigator and the IRB, not
     * written by an engineer, and it is placeholder text until then.
     */
    closingInstruction: string;
  };
}

/**
 * Who may answer a check-in on the participant's behalf.
 *
 * "not_permitted" is right for an adult self-report instrument: a spouse's
 * account of how the participant feels, recorded as the participant's own words,
 * is a data-integrity failure and a consent failure at once. A pediatric study
 * flips this, because there the caregiver answering is the normal case, and the
 * instrument then needs its own validated proxy form rather than the adult one.
 */
export type ProxyPolicy = "not_permitted" | "permitted";

export interface ProtocolDefinition {
  protocolId: string;
  title: string;
  shortTitle: string;
  phase: string;
  sponsor: string;
  indication: string;
  investigationalProduct: string;
  /** Symptoms the protocol requires be actively solicited at every check-in. */
  solicitedSymptoms: SolicitedSymptom[];
  checkInCadence: string;
  /** Asked before the symptom review — safety first, script second. */
  safetyScreen: SafetyScreenItem[];
  /** Hours the site has to report an SAE to the sponsor once aware. */
  saeReportingWindowHours: number;
  /** Whether a caregiver may answer for the participant. See ProxyPolicy. */
  proxyReporting: ProxyPolicy;
}

export interface SolicitedSymptom {
  /** Canonical term used in the eCRF. */
  term: string;
  /** How the agent should ask about it out loud — plain language, no jargon. */
  prompt: string;
  /** Anchors that help translate a patient's description into a CTCAE grade. */
  gradingHints: string;
}

export const PROTOCOL: ProtocolDefinition = {
  protocolId: "ONX-301",
  title:
    "A Phase 2, Open-Label, Single-Arm Study of Onvatinib in Adults with " +
    "Locally Advanced or Metastatic Non-Small Cell Lung Cancer",
  shortTitle: "ONX-301 Onvatinib NSCLC",
  phase: "Phase 2",
  sponsor: "Onyxa Therapeutics (synthetic)",
  indication: "Advanced non-small cell lung cancer",
  investigationalProduct: "Onvatinib 120 mg oral tablet, once daily",
  checkInCadence: "Weekly, between scheduled site visits",
  saeReportingWindowHours: 24,
  // Adult self-report instrument. See ProxyPolicy for why this is not a default.
  proxyReporting: "not_permitted",
  safetyScreen: [
    {
      id: "unplanned_care",
      label: "Unplanned medical care",
      prompt:
        "Since we last spoke, have you been to a hospital, an emergency room, or seen a doctor unexpectedly?",
      redFlag: true,
      urgencyIfPositive: "urgent",
    },
    {
      id: "chest_or_breathing",
      label: "Chest pain or breathlessness",
      prompt: "Have you had any chest pain, or any trouble breathing?",
      redFlag: true,
      urgencyIfPositive: "emergency",
    },
    {
      /**
       * Emergency, and the call stops.
       *
       * This paged at urgent while the safety net's own fever rule called it "an
       * oncologic emergency" in the same breath, and after the page the agent
       * carried on through fifteen more turns of screen, symptoms and adherence.
       * Febrile neutropenia is measured against a one-hour door-to-antibiotics
       * window; a check-in that spends part of it collecting data has its
       * priorities backwards. The simulated clinical review (docs/CLINICAL-REVIEW.md
       * section 5.1) made this its first pre-pilot change.
       */
      id: "fever",
      label: "Fever or chills",
      prompt: "Have you had a fever, or felt hot and shivery?",
      redFlag: true,
      urgencyIfPositive: "emergency",
      onPositive: {
        followUpPrompt:
          "What was the highest temperature you measured, if you took it?",
        closingInstruction:
          "Because you're on this study, a fever needs to be checked by a doctor today. " +
          "Please call your study site's 24-hour number now, or go to your nearest " +
          "emergency department if you can't reach them.",
      },
    },
    {
      id: "bleeding_or_fainting",
      label: "Bleeding or fainting",
      prompt:
        "Have you had any bleeding that worried you, or passed out or felt faint?",
      redFlag: true,
      urgencyIfPositive: "urgent",
    },
    {
      /**
       * Stroke, asked in the words a person would use about themselves.
       *
       * Added because the deterministic net catches 5 of 22 stroke utterances in
       * the corpus, and the ones it misses are the ordinary ones — "my arm went
       * dead", "my words came out wrong". You cannot pattern-match your way to
       * that. Asking outright is the only thing that reliably works, which is why
       * the screen exists at all.
       */
      id: "stroke_signs",
      label: "Sudden neurological symptoms",
      // Asked as a change from their own baseline, which is how a clinician asks
      // it and is not optional here. Subject 002-0027's baseline is "Migraine
      // with aura" — unilateral numbness and a severe headache are what that
      // *is*. The first wording would have paged an emergency and ended the
      // call on a truthful answer about a known condition, every week, which is
      // the alert fatigue this system's own measurement page warns about.
      //
      // The deterministic escalation path cannot see baselineConditions at all —
      // they reach the model as prose and nothing else. That is the general
      // problem behind this specific one, and wording is a patch on it rather
      // than a fix; see the note in BACKLOG under Sprint 5.
      prompt:
        "Have you had any sudden weakness, numbness on one side, or trouble speaking that is new or different from your usual? Or the worst headache you have ever had?",
      redFlag: true,
      urgencyIfPositive: "emergency",
    },
    {
      /**
       * Severe cutaneous reaction and angioedema.
       *
       * Emergency rather than urgent: Stevens-Johnson and toxic epidermal
       * necrolysis start as a rash and a fever and are lethal, and airway
       * swelling has no useful waiting period. "Blistering or peeling" is the
       * phrasing that distinguishes them from the ordinary drug rash a subject on
       * an oncology trial will otherwise report every week.
       */
      id: "severe_skin",
      label: "Severe skin reaction or swelling",
      prompt:
        "Have you had any rash that's blistering or peeling, or any swelling of your face, lips or tongue?",
      redFlag: true,
      urgencyIfPositive: "emergency",
    },
    {
      /**
       * Intent to stop, asked before the adherence question rather than after.
       *
       * Urgent, not emergency: this needs the investigator to know today, not an
       * ambulance. The net catches 2 of 21 withdrawal utterances — the worst
       * topic in the corpus — because people say "I've had enough of these
       * tablets", not "I intend to withdraw from the study". Asking directly also
       * separates it cleanly from missed doses, which is a different fact about a
       * different problem.
       */
      id: "study_drug_intent",
      label: "Intent to stop treatment or leave the study",
      prompt:
        "Have you thought about stopping the study medication, or about leaving the study?",
      redFlag: true,
      urgencyIfPositive: "urgent",
    },
    {
      /**
       * Deliberately an open probe rather than a direct question about self-harm.
       * Asking a cancer patient about suicidal thoughts weekly, cold, over the
       * phone, is not something to improvise — production should use a validated
       * distress instrument (PHQ-2, or the NCCN Distress Thermometer) with its
       * own scoring and its own IRB approval. This wording opens the door and
       * lets the safety net and the agent handle what comes back.
       *
       * Left as an open probe when the other three items were added in Sprint 3,
       * deliberately. Self-harm is the one topic where the honest answer is a
       * validated instrument and an ethics submission rather than a question an
       * engineer wrote, and closing the coverage gap by inventing wording would
       * have been worse than leaving it open and saying so.
       */
      id: "spirits",
      label: "Mood and distress",
      prompt: "How have your spirits been since we last spoke?",
      redFlag: false,
      urgencyIfPositive: "routine",
    },
    {
      id: "pregnancy",
      label: "Possible pregnancy",
      prompt: "Is there any chance you could be pregnant?",
      redFlag: true,
      urgencyIfPositive: "urgent",
      appliesTo: "childbearing_potential",
    },
  ],
  solicitedSymptoms: [
    {
      term: "Fatigue",
      prompt: "How has your energy been since we last spoke?",
      gradingHints:
        "Grade 1 = tired but doing everything as usual. Grade 2 = cutting back on " +
        "errands, chores, hobbies. Grade 3 = needs help with self-care such as " +
        "bathing or dressing, or mostly in bed.",
    },
    {
      term: "Nausea",
      prompt: "Have you had any nausea or upset stomach?",
      gradingHints:
        "Grade 1 = queasy but eating normally. Grade 2 = eating less than usual " +
        "but no weight loss or dehydration. Grade 3 = little or no food or fluid " +
        "intake, or needing IV fluids.",
    },
    {
      term: "Diarrhea",
      prompt: "Any changes in your bowel movements?",
      gradingHints:
        "Grade by stools above the patient's own baseline per day. Grade 1 = up to " +
        "3 more. Grade 2 = 4 to 6 more. Grade 3 = 7 or more, incontinence, or " +
        "hospitalization indicated. Grade 4 = life-threatening consequences.",
    },
    {
      term: "Rash",
      prompt: "Have you noticed any rash or changes to your skin?",
      gradingHints:
        "Grade 1 = covers less than about a tenth of the body, no symptoms. " +
        "Grade 2 = up to about a third of the body, or itching that bothers them. " +
        "Grade 3 = widespread, painful, blistering, or limiting self care.",
    },
    {
      term: "Decreased appetite",
      prompt: "How has your appetite been?",
      gradingHints:
        "Grade 1 = eating less but weight steady. Grade 2 = eating less with " +
        "weight loss or needing supplements. Grade 3 = needing a feeding tube or IV " +
        "nutrition.",
    },
    {
      term: "Peripheral sensory neuropathy",
      prompt:
        "Any numbness, tingling, or pins and needles in your hands or feet?",
      gradingHints:
        "Grade 1 = noticeable but not getting in the way. Grade 2 = interferes with " +
        "things like buttons, keys, or writing. Grade 3 = interferes with self care, " +
        "or the patient is dropping things or unsteady.",
    },
  ],
};

export interface Subject {
  subjectId: string;
  /** ISO date. Used only as a knowledge-based verification factor. */
  dateOfBirth: string;
  initials: string;
  siteId: string;
  siteName: string;
  /**
   * ISO 3166-1 alpha-2 for the site, which decides which emergency and crisis
   * numbers the agent may say out loud. Sites, not subjects: a participant is
   * enrolled at a site and that is where their care is.
   */
  siteCountry: string;
  cohort: string;
  enrollmentDate: string;
  studyDay: number;
  currentCycle: string;
  coordinatorName: string;
  coordinatorPhone: string;
  /**
   * Gates the pregnancy screen item. A screen asked of the wrong population is
   * not merely noise — it is an inappropriate question put to a participant.
   */
  childbearingPotential: boolean;
  /** Conditions already recorded at baseline — NOT adverse events if unchanged. */
  baselineConditions: string[];
  knownConMeds: string[];
  lastCheckIn: string | null;
}

export const SUBJECTS: Subject[] = [
  {
    subjectId: "001-0042",
    dateOfBirth: "1958-03-11",
    initials: "R.M.",
    siteId: "001",
    siteName: "Northlake Cancer Center",
    siteCountry: "US",
    cohort: "Cohort B",
    enrollmentDate: "2026-06-24",
    studyDay: 29,
    currentCycle: "Cycle 2 Day 1",
    coordinatorName: "Dana Whitfield, RN",
    coordinatorPhone: "555-0142",
    childbearingPotential: false,
    baselineConditions: ["Type 2 diabetes", "Hypertension", "Mild hearing loss"],
    knownConMeds: ["Metformin 1000 mg BID", "Lisinopril 10 mg daily"],
    lastCheckIn: "2026-08-11",
  },
  {
    subjectId: "001-0055",
    dateOfBirth: "1971-11-02",
    initials: "T.A.",
    siteId: "001",
    siteName: "Northlake Cancer Center",
    siteCountry: "US",
    cohort: "Cohort B",
    enrollmentDate: "2026-07-15",
    studyDay: 15,
    currentCycle: "Cycle 1 Day 15",
    coordinatorName: "Dana Whitfield, RN",
    coordinatorPhone: "555-0142",
    childbearingPotential: false,
    baselineConditions: ["Osteoarthritis, both knees"],
    knownConMeds: ["Acetaminophen 500 mg PRN"],
    lastCheckIn: "2026-08-11",
  },
  {
    subjectId: "002-0013",
    dateOfBirth: "1949-07-24",
    initials: "E.K.",
    siteId: "002",
    siteName: "Riverbend Oncology Associates",
    siteCountry: "GB",
    cohort: "Cohort A",
    enrollmentDate: "2026-05-02",
    studyDay: 57,
    currentCycle: "Cycle 3 Day 1",
    coordinatorName: "Marcus Oyelaran, CRC",
    coordinatorPhone: "555-0177",
    childbearingPotential: false,
    baselineConditions: ["Atrial fibrillation", "Chronic lower back pain"],
    knownConMeds: ["Apixaban 5 mg BID", "Gabapentin 300 mg TID"],
    lastCheckIn: "2026-08-10",
  },
  {
    // Younger never-smoker with a driver mutation — an uncommon but real NSCLC
    // presentation, and the reason the pregnancy screen item has to exist and be
    // gated rather than asked of everyone.
    subjectId: "002-0027",
    dateOfBirth: "1992-05-19",
    initials: "J.N.",
    siteId: "002",
    siteName: "Riverbend Oncology Associates",
    siteCountry: "GB",
    cohort: "Cohort A",
    enrollmentDate: "2026-07-28",
    studyDay: 22,
    currentCycle: "Cycle 1 Day 22",
    coordinatorName: "Marcus Oyelaran, CRC",
    coordinatorPhone: "555-0177",
    childbearingPotential: true,
    baselineConditions: ["Migraine with aura"],
    knownConMeds: ["Sumatriptan 50 mg PRN"],
    lastCheckIn: "2026-08-12",
  },
];

export function findSubject(
  subjectId: string,
  dateOfBirth: string,
): Subject | null {
  const normalizedId = subjectId.replace(/[^0-9]/g, "");
  const match = SUBJECTS.find(
    (s) => s.subjectId.replace(/[^0-9]/g, "") === normalizedId,
  );
  if (!match) return null;
  // Both factors must match. A wrong DOB is a failed verification, not a lookup miss.
  if (match.dateOfBirth !== dateOfBirth.trim()) return null;
  return match;
}

/** The country of a site, by its numeric prefix. Used for pre-verification hints. */
export function siteCountryForPrefix(prefix: string): string | null {
  return SUBJECTS.find((s) => s.siteId === prefix)?.siteCountry ?? null;
}
