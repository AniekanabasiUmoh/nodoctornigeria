import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

import { getGroqConfig } from "./config.ts";
import { calculateDosage } from "./dosage.ts";
import { classifyTaskWithGroq, interpretQueryWithGemini, normalizeCommunityTriageWithGemini, reasonWithGemini, summarizeChunkWithGemini, unifyFrontlineWithGroq } from "./llm.ts";
import { loadSessionMemory, saveSessionMemory } from "./memory.ts";
import { assessTriage } from "./triage.ts";
import type {
  AnswerSource,
  AuditInteractionRecord,
  ChunkRecord,
  ClinicalDecision,
  Citation,
  DosageResult,
  ExtractedPatientFacts,
  FeedbackRequest,
  InterpretedQuery,
  JobStatusResponse,
  LlmFailure,
  QueryResponse,
  ReviewQueueResponse,
  SessionMemory,
  TaskType,
} from "./types.ts";

const MAX_CLARIFICATION_TURNS = 2;

function clarificationBudgetReached(memory: SessionMemory | null): boolean {
  const clarifyCount = (memory?.recent_turns ?? []).filter((turn) => turn.disposition === "ASK_CLARIFY").length;
  return clarifyCount >= MAX_CLARIFICATION_TURNS;
}

function isLikelyFollowUpReply(query: string, memory: SessionMemory | null): boolean {
  if (!memory?.recent_turns?.length) {
    return false;
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return false;
  }
  if (memory.facts?.last_clarification && /\b(yes|no|none|nil|weight|age|kg|month|months|year|years|day|days)\b/i.test(trimmed)) {
    return true;
  }
  const lowered = normalizeQueryText(trimmed).toLowerCase();
  if (
    /^((no|yes)\b|weight\s+is\b|age\s+is\b|he\s+is\b|she\s+is\b|it\s+is\b|since\b|for\b|\d+\s*kg\b|\d+\s*(year|month|week|day)s?\b)/i
      .test(trimmed)
  ) {
    return true;
  }
  return lowered.split(/\s+/).filter(Boolean).length <= 8;
}

function buildFollowUpInterpretationQuery(query: string, memory: SessionMemory | null): string {
  const trimmed = query.trim();
  const lastClarification = memory?.facts?.last_clarification?.trim();
  const stayingOnThread = shouldStayOnActiveCondition(trimmed, memory, null, null);
  if (!lastClarification && !stayingOnThread) {
    return trimmed;
  }
  const contextParts: string[] = [];
  if (memory?.facts?.raw_summary) contextParts.push(memory.facts.raw_summary);
  if (memory?.facts?.symptoms?.length) contextParts.push(`Known symptoms: ${memory.facts.symptoms.join(", ")}`);
  if (memory?.facts?.last_suspected_differential?.length) {
    contextParts.push(`Last suspected differential: ${memory.facts.last_suspected_differential.join(", ")}`);
  }
  if (memory?.facts?.active_condition) contextParts.push(`Active condition: ${memory.facts.active_condition}`);
  if (memory?.facts?.active_task) contextParts.push(`Active task: ${memory.facts.active_task}`);
  if (!lastClarification && !stayingOnThread && !isLikelyFollowUpReply(trimmed, memory)) {
    return trimmed;
  }
  return [
    "FOLLOW-UP REPLY TO PREVIOUS CLARIFICATION",
    lastClarification ? `PREVIOUS QUESTION: ${lastClarification}` : null,
    contextParts.length ? `KNOWN CONTEXT: ${contextParts.join(" | ")}` : null,
    `USER REPLY: ${trimmed}`,
  ].filter(Boolean).join("\n");
}

function mergeUnique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function resolveCandidateConditions(interpreted: InterpretedQuery | null, memory: SessionMemory | null): string[] {
  if (interpreted?.candidate_conditions?.length) {
    return mergeUnique(interpreted.candidate_conditions);
  }
  if (memory?.facts?.last_suspected_differential?.length) {
    return mergeUnique(memory.facts.last_suspected_differential);
  }
  if (memory?.facts?.candidate_conditions?.length) {
    return mergeUnique(memory.facts.candidate_conditions);
  }
  return [];
}

function resolveTaskScopedCandidateConditions(params: {
  query: string;
  interpreted: InterpretedQuery | null;
  memory: SessionMemory | null;
  task: TaskType | null;
}): string[] {
  const { query, interpreted, memory, task } = params;
  if (interpreted?.candidate_conditions?.length) {
    return mergeUnique(interpreted.candidate_conditions);
  }
  if (shouldStayOnActiveCondition(query, memory, task, interpreted) && memory?.facts?.active_condition) {
    return mergeUnique([
      memory.facts.active_condition,
      ...(memory.facts.last_suspected_differential ?? []),
      ...(memory.facts.candidate_conditions ?? []),
    ]);
  }
  return resolveCandidateConditions(interpreted, memory);
}

function resolveSymptoms(interpreted: InterpretedQuery | null, memory: SessionMemory | null): string[] {
  if (interpreted?.symptoms?.length) {
    return mergeUnique(interpreted.symptoms);
  }
  if (memory?.facts?.symptoms?.length) {
    return mergeUnique(memory.facts.symptoms);
  }
  return [];
}

type SyndromePattern = {
  condition: string;
  all?: string[];
  any?: string[];
  ageGroup?: "child" | "adult";
};

const SYNDROME_PATTERNS: SyndromePattern[] = [
  // Respiratory
  { condition: "Pneumonia", all: ["fever"], any: ["fast breathing", "difficulty breathing", "chest indrawing", "cough", "breathless"], ageGroup: "child" },
  { condition: "Pneumonia", any: ["fast breathing", "chest indrawing", "difficulty breathing", "breathless", "respiratory distress"] },
  { condition: "Asthma", any: ["wheeze", "wheezing", "tight chest", "difficulty breathing", "breathless"] },
  { condition: "Pulmonary Tuberculosis", any: ["cough for weeks", "cough for months", "night sweats", "weight loss", "haemoptysis", "bloody sputum"] },
  // Malaria
  { condition: "Severe Malaria", all: ["fever"], any: ["convulsion", "seizure", "unconscious", "cannot drink", "prostration", "very weak", "lethargic", "jaundice", "severe anaemia"] },
  { condition: "Uncomplicated Malaria", any: ["fever", "chills", "rigors", "headache", "body ache", "sweating"] },
  // Diarrhoea / dehydration
  { condition: "Acute Diarrhoea", any: ["diarrhoea", "diarrhea", "watery stool", "loose stool", "running stomach", "frequent stool"] },
  { condition: "Cholera", any: ["rice water stool", "profuse watery stool", "cholera", "watery stool vomiting"] },
  { condition: "Dehydration", any: ["sunken eyes", "cannot drink", "drinks eagerly", "skin turgor", "very weak", "fontanelle sunken", "dry mouth", "no urine"], ageGroup: "child" },
  { condition: "Bloody Diarrhoea / Dysentery", any: ["blood in stool", "bloody stool", "bloody diarrhoea", "mucus stool"] },
  // Fever / infection
  { condition: "Typhoid Fever", any: ["typhoid", "prolonged fever", "fever for days", "fever for weeks", "abdominal pain fever", "constipation fever"] },
  { condition: "Meningitis", any: ["stiff neck", "neck stiffness", "bulging fontanelle", "photophobia", "severe headache fever", "high pitched cry"] },
  { condition: "Sepsis", all: ["fever"], any: ["very weak", "lethargic", "cannot drink", "unconscious", "cold hands", "mottled skin", "fast pulse"] },
  { condition: "Neonatal Sepsis", any: ["newborn fever", "neonate not feeding", "neonate fits", "neonate lethargic", "umbilical redness", "jaundice newborn"] },
  { condition: "Measles", all: ["fever"], any: ["rash", "red eyes", "coryza", "koplik spots", "measles"] },
  { condition: "Upper Respiratory Tract Infection", any: ["runny nose", "sore throat", "common cold", "nasal discharge", "coryza"] },
  // Malnutrition
  { condition: "Severe Acute Malnutrition", any: ["muac", "wasting", "kwashiorkor", "marasmus", "severe wasting", "oedema feet", "very thin", "not eating for days"] },
  { condition: "Moderate Acute Malnutrition", any: ["muac yellow", "not gaining weight", "thin", "underweight"] },
  // Anaemia
  { condition: "Anaemia", any: ["pallor", "pale", "pale eyelids", "pale palms", "very pale", "weakness fatigue", "anaemia", "anemia"] },
  // Convulsion / altered consciousness
  { condition: "Febrile Convulsion", all: ["fever", "convulsion"] },
  { condition: "Epilepsy / Seizure Disorder", any: ["fits", "seizure", "convulsion", "shaking", "pikin dey shake", "epilepsy"] },
  { condition: "Altered Consciousness", any: ["unconscious", "unresponsive", "cannot wake", "drowsy", "confused", "AVPU V", "AVPU P", "AVPU U"] },
  // Neonatal
  { condition: "Neonatal Jaundice", any: ["yellow newborn", "jaundice newborn", "yellow eyes baby", "jaundice baby"] },
  { condition: "Birth Asphyxia", any: ["did not cry at birth", "no cry at birth", "blue at birth", "not breathing at birth"] },
  // Skin / other
  { condition: "Malaria with Severe Anaemia", all: ["fever", "pallor"] },
  { condition: "Wound Infection / Abscess", any: ["wound", "abscess", "pus", "swelling painful", "infected cut"] },
  { condition: "Urinary Tract Infection", any: ["burning urine", "painful urination", "frequency urine", "cloudy urine", "smelly urine", "uti"] },
  { condition: "Hypertension", any: ["high blood pressure", "hypertension", "headache dizziness", "bp elevated"] },
  { condition: "Diabetes Complication", any: ["high sugar", "diabetes", "diabetic", "hyperglycaemia", "hypoglycaemia", "low sugar"] },
  { condition: "Snake Bite / Envenomation", any: ["snake bite", "scorpion sting", "envenomation", "bit by snake"] },
];

// ── Assessment Guide (step 5 / step 9 paired instructions) ────────────────────
// Every protocol question that requires a physical finding must carry a paired
// how_to_check. This table is used to attach plain-language instructions inline
// with what_to_ask_next on Telegram and as expandable hints on web/app.

type AssessmentEntry = {
  finding: string;
  how_to_check: string;
  normal_range?: string;
  danger_threshold?: string;
};

export const ASSESSMENT_GUIDE: Record<string, AssessmentEntry> = {
  respiratory_rate: {
    finding: "Respiratory rate",
    how_to_check: "Count how many times the chest rises in 60 seconds while the child is calm and not crying. Use a watch or count on your fingers. Do not count if the child is upset — wait until they settle.",
    normal_range: "Under 2 months: < 60/min | 2–12 months: < 50/min | 1–5 years: < 40/min | Adult: 12–20/min",
    danger_threshold: "Fast breathing: ≥ 60/min (< 2 months), ≥ 50/min (2–12 months), ≥ 40/min (1–5 years)",
  },
  chest_indrawing: {
    finding: "Chest indrawing",
    how_to_check: "Watch the lower chest wall while the child breathes in. Does it pull inward? The whole lower chest should move inward — not just the skin between the ribs.",
    danger_threshold: "Any chest indrawing in a child = severe pneumonia. Refer now.",
  },
  pulse: {
    finding: "Pulse (heart rate)",
    how_to_check: "Place two fingers on the inside of the wrist just below the thumb, or on the neck beside the windpipe. Count beats for 30 seconds and multiply by 2.",
    normal_range: "Neonate: 120–160/min | Infant (1–12 months): 100–160/min | Child (1–5 years): 80–120/min | Adult: 60–100/min",
    danger_threshold: "Weak or rapid pulse (> 120 in a child, > 100 in an adult) with fever or pallor = danger sign.",
  },
  temperature: {
    finding: "Temperature",
    how_to_check: "If you have a thermometer: fever is ≥ 37.5°C axillary (armpit) or ≥ 38°C rectal. If no thermometer: feel the abdomen or back with the back of your hand — hot to touch compared to your own skin means fever is likely.",
    danger_threshold: "Axillary ≥ 39°C or any fever in a child under 2 months = refer.",
  },
  consciousness_avpu: {
    finding: "Consciousness (AVPU scale)",
    how_to_check: "A — Alert: child is awake, responds normally. V — Voice: responds only when you call their name loudly. P — Pain: responds only when you press firmly on the breastbone. U — Unresponsive: no response to voice or pain.",
    danger_threshold: "Any level below A (V, P, or U) is a danger sign. Refer now.",
  },
  ability_to_drink: {
    finding: "Ability to drink or feed",
    how_to_check: "Offer water, ORS, or breast milk directly. Can the child swallow? Does the child accept it? Cannot drink = refuses all fluids or vomits everything immediately. Drinks eagerly = may indicate dehydration.",
    danger_threshold: "Cannot drink at all = danger sign. Refer now.",
  },
  skin_turgor: {
    finding: "Skin turgor (dehydration)",
    how_to_check: "Pinch the skin on the abdomen between two fingers for 1 second, then release. Returns immediately = normal. Returns slowly (stays tented 1–2 seconds) = some dehydration. Returns very slowly (> 2 seconds) = severe dehydration.",
    danger_threshold: "Skin pinch very slow (> 2 seconds) = severe dehydration. Refer now.",
  },
  sunken_eyes: {
    finding: "Sunken eyes",
    how_to_check: "Look directly at the child's eyes from the front. Are they deeper in the socket than normal? Ask the mother: 'Do the eyes look different from usual?' Sunken eyes + reduced tears = dehydration sign.",
    danger_threshold: "Sunken eyes with inability to drink or very slow skin pinch = severe dehydration.",
  },
  pallor: {
    finding: "Pallor (anaemia)",
    how_to_check: "Look at: (1) the inside of the lower eyelid — pull down gently, should be pink/red not white/pale; (2) the palms — should have pink creases; (3) the lips and tongue — should be pink.",
    danger_threshold: "Severe pallor (very pale eyelid lining, pale palms, pale lips) = possible severe anaemia. Refer.",
  },
  muac: {
    finding: "MUAC (mid-upper arm circumference)",
    how_to_check: "Measure the mid-upper arm circumference with a MUAC tape on the left arm, midway between shoulder and elbow, arm relaxed.",
    normal_range: "≥ 12.5 cm (green) = normal | 11.5–12.5 cm (yellow) = moderate malnutrition | < 11.5 cm (red) = severe",
    danger_threshold: "MUAC < 11.5 cm (red zone) = severe acute malnutrition. Refer.",
  },
  prostration: {
    finding: "Prostration (severe weakness)",
    how_to_check: "Can the child sit up unaided? Can they stand if old enough? A child who cannot sit up without support, is floppy, or cannot be woken fully has prostration.",
    danger_threshold: "Prostration = danger sign for severe malaria or sepsis. Refer now.",
  },
  fontanelle: {
    finding: "Fontanelle (infants < 18 months)",
    how_to_check: "Feel the soft spot on top of the head (anterior fontanelle) when the child is upright and calm. Sunken = dehydration. Bulging = raised intracranial pressure.",
    danger_threshold: "Bulging fontanelle = refer now. Sunken fontanelle = dehydration sign.",
  },
  jaundice: {
    finding: "Jaundice",
    how_to_check: "Look at the whites of the eyes and the skin in good light. Yellow colour in the eyes or skin = jaundice. In a newborn, jaundice on the abdomen or below is significant.",
    danger_threshold: "Jaundice in newborn reaching abdomen or below = refer. Jaundice + fever = refer.",
  },
  oedema: {
    finding: "Oedema",
    how_to_check: "Press your thumb firmly on the top of the foot or the shin for 3 seconds. Does a dent (pit) remain after you lift your finger?",
    danger_threshold: "Bilateral pitting oedema in a child = kwashiorkor. Refer.",
  },
  spO2: {
    finding: "Oxygen saturation (SpO2)",
    how_to_check: "Use a pulse oximeter on the finger or toe. Read the percentage displayed. A reading below 95% warrants close monitoring; below 90% requires oxygen therapy.",
    danger_threshold: "SpO2 < 90% = refer now for oxygen.",
  },
};

/**
 * Returns the how_to_check instruction for a named physical finding.
 * Used to attach inline guidance to protocol questions on Telegram.
 */
export function getAssessmentHowTo(finding: string): string | null {
  const entry = ASSESSMENT_GUIDE[finding];
  return entry ? entry.how_to_check : null;
}

function inferSyndromeCandidates(params: {
  query: string;
  symptoms: string[];
  patientAgeGroup: "child" | "adult" | null;
}): string[] {
  const lowered = normalizeQueryText([params.query, ...params.symptoms].join(" ")).toLowerCase();
  const matches: string[] = [];
  for (const pattern of SYNDROME_PATTERNS) {
    if (pattern.ageGroup && params.patientAgeGroup && pattern.ageGroup !== params.patientAgeGroup) {
      continue;
    }
    const allMatched = (pattern.all ?? []).every((term) => lowered.includes(term));
    const anyMatched = !(pattern.any?.length) || pattern.any.some((term) => lowered.includes(term));
    if (allMatched && anyMatched) {
      matches.push(pattern.condition);
    }
  }
  return mergeUnique(matches).slice(0, 3);
}

function buildMergedFactQuery(query: string, facts: ExtractedPatientFacts, candidates: string[]): string {
  return [
    query,
    facts.raw_summary,
    ...(facts.symptoms ?? []),
    ...(candidates ?? []),
    facts.active_condition,
  ].filter(Boolean).join(" ");
}

/**
 * Triage-safe merged query: excludes active_condition and candidate condition
 * names from the merged triage input. Condition labels like "Convulsion" or
 * "Sepsis" would cause false-positive emergency matches if carried from prior
 * session turns into a new patient query.
 */
function buildTriageMergedQuery(query: string, facts: ExtractedPatientFacts): string {
  return [
    query,
    facts.raw_summary,
    ...(facts.symptoms ?? []),
  ].filter(Boolean).join(" ");
}

function selectSaferDisposition(
  current: ReturnType<typeof assessTriage>["disposition"],
  next: ReturnType<typeof assessTriage>["disposition"],
): ReturnType<typeof assessTriage>["disposition"] {
  const rank = new Map<string, number>([
    ["NON_EMERGENCY_CONTINUE", 0],
    ["UNCERTAIN_ESCALATE", 1],
    ["EMERGENCY_ESCALATE", 2],
  ]);
  return (rank.get(next) ?? 0) > (rank.get(current) ?? 0) ? next : current;
}

function inferFollowUpFromProtocol(answer: string, disposition: string): string | null {
  return disposition === "ASK_CLARIFY" ? answer : null;
}

function inferPatientContext(
  query: string,
  audience: "community" | "clinician",
  ageYears: number | null | undefined,
  existingFacts: ExtractedPatientFacts,
): Pick<ExtractedPatientFacts, "patient_age_group" | "speaker_role" | "caregiver_relationship"> {
  const lowered = normalizeQueryText(query).toLowerCase();
  let patientAgeGroup = existingFacts.patient_age_group ?? null;
  let speakerRole = existingFacts.speaker_role ?? null;
  let caregiverRelationship = existingFacts.caregiver_relationship ?? null;

  if (typeof ageYears === "number") {
    patientAgeGroup = ageYears < 18 ? "child" : "adult";
  }
  if (/\b(child|children|baby|infant|newborn|toddler|kid|pikin|son|daughter|boy|girl)\b/.test(lowered)) {
    patientAgeGroup = "child";
  } else if (/\b(adult|man|woman|husband|wife|mother|father)\b/.test(lowered) && !patientAgeGroup) {
    patientAgeGroup = "adult";
  }

  const caregiverPatterns: Array<[RegExp, string]> = [
    [/\bmy child\b/, "parent"],
    [/\bmy son\b/, "parent"],
    [/\bmy daughter\b/, "parent"],
    [/\bmy baby\b/, "parent"],
    [/\bmy husband\b/, "spouse"],
    [/\bmy wife\b/, "spouse"],
    [/\bmy mother\b/, "child"],
    [/\bmy father\b/, "child"],
    [/\bour patient\b|\bthe patient\b|\bpt\b/, "health_worker"],
  ];
  for (const [pattern, relationship] of caregiverPatterns) {
    if (pattern.test(lowered)) {
      caregiverRelationship = relationship;
      speakerRole = relationship === "health_worker" || audience === "clinician" ? "clinician" : "caregiver";
      break;
    }
  }

  if (!speakerRole) {
    if (audience === "clinician" && /\b(patient|pt)\b/.test(lowered)) {
      speakerRole = "clinician";
    } else if (/\b(i|my)\b/.test(lowered) && !/\bmy child\b|\bmy son\b|\bmy daughter\b|\bmy baby\b/.test(lowered)) {
      speakerRole = "self";
    } else if (patientAgeGroup === "child" && /\bmy\b/.test(lowered)) {
      speakerRole = "caregiver";
    }
  }

  return { patient_age_group: patientAgeGroup, speaker_role: speakerRole, caregiver_relationship: caregiverRelationship };
}

function buildFactsUpdate(params: {
  query: string;
  audience: "community" | "clinician";
  interpreted: InterpretedQuery | null;
  memory: SessionMemory | null;
  candidateConditions: string[];
  symptoms?: string[];
  lastClarification?: string | null;
  task?: TaskType | null;
}): ExtractedPatientFacts {
  const { query, audience, interpreted, memory, candidateConditions, symptoms, lastClarification, task } = params;
  const inferredContext = inferPatientContext(query, audience, interpreted?.age_years ?? memory?.facts?.age_years ?? null, memory?.facts ?? {});
  const context = {
    patient_age_group: interpreted?.patient_age_group ?? inferredContext.patient_age_group,
    speaker_role: interpreted?.speaker_role ?? inferredContext.speaker_role,
    caregiver_relationship: interpreted?.caregiver_relationship ?? inferredContext.caregiver_relationship,
  };
  
  const activeCondition = candidateConditions.length > 0 ? candidateConditions[0] : (memory?.facts?.active_condition ?? null);
  const activeTask = task ?? inferTaskFromQueryText(query, audience) ?? memory?.facts?.active_task ?? null;
  const managementThread = isManagementStyleTask(activeTask) || (memory?.facts?.management_thread ?? false);

  return {
    age_years: interpreted?.age_years ?? null,
    weight_kg: interpreted?.weight_kg ?? null,
    symptoms: symptoms ?? resolveSymptoms(interpreted, memory),
    candidate_conditions: candidateConditions,
    last_suspected_differential: interpreted?.last_suspected_differential?.length
      ? interpreted.last_suspected_differential
      : candidateConditions,
    onset_days: interpreted?.onset_days ?? null,
    raw_summary: interpreted?.raw_summary ?? null,
    last_clarification: lastClarification ?? interpreted?.last_clarification ?? null,
    active_condition: activeCondition,
    active_task: activeTask,
    management_thread: managementThread,
    ...context,
  };
}

function inferTaskFromQueryText(query: string, audience: "community" | "clinician"): TaskType | null {
  const lowered = normalizeQueryText(query).toLowerCase();
  if (/\b(dose|dosage|mg\/kg|mg per kg|how much|how many ml|how many tablets?|how many sachets?)\b/.test(lowered)) return "dose";
  if (/\b(should i refer|do i refer|refer|referral|send to hospital|admit|can i treat here|manage here)\b/.test(lowered)) return "referral";
  if (audience === "clinician" && /\b(investigation|investigations|test|tests|workup|lab|labs|scan)\b/.test(lowered)) return "investigation";
  if (/\b(protocol|pathway|algorithm)\b/.test(lowered)) return "management_protocol";
  if (/\b(severity|severe|mild|moderate|danger sign|danger signs|does this need oxygen|does this need transfusion|oxygen|transfusion)\b/.test(lowered)) return "severity";
  if (/\b(what should i give|what to give|what should i do|how do i treat|treat|treatment|management|manage|start amoxicillin|start ors|what to do)\b/.test(lowered)) return "treatment";
  if (/\b(follow up|follow-up|what next|next step|still)\b/.test(lowered)) return "follow_up";
  if (/\b(fever|cough|rash|diarrhoea|diarrhea|vomiting|weak|weakness|not eating|cannot eat|not feeding|breathing|breathless|fast breathing|pallor|convulsion|fits?|seizure|malaria|pneumonia|anaemia|dehydration|stool)\b/.test(lowered)) {
    return "diagnosis";
  }
  return null;
}

function resolveTaskDeterministically(params: {
  query: string;
  audience: "community" | "clinician";
  memory: SessionMemory | null;
  interpreted: InterpretedQuery | null;
  candidateConditions: string[];
  symptoms: string[];
}): TaskType | null {
  const { query, audience, memory, interpreted, candidateConditions, symptoms } = params;
  const explicitTask = inferTaskFromQueryText(query, audience);
  if (explicitTask) {
    return explicitTask;
  }
  if (memory?.facts?.active_task && shouldStayOnActiveCondition(query, memory, memory.facts.active_task, interpreted)) {
    return memory.facts.active_task;
  }
  if (candidateConditions.length > 0 || symptoms.length > 0 || interpreted?.raw_summary?.trim()) {
    return "diagnosis";
  }
  return null;
}

function isManagementStyleTask(task: TaskType | null | undefined): boolean {
  return task === "treatment" || task === "dose" || task === "management_protocol" || task === "referral" || task === "investigation";
}

function isNewPatientSignal(query: string): boolean {
  // Detect when the operator is describing a different patient entirely.
  // These phrases must break the active session thread.
  const lowered = normalizeQueryText(query).toLowerCase();
  return /\b(another person|another patient|new patient|someone else|different patient|second patient|third patient|ein body|anoterh|anther|new case|fresh case)\b/.test(lowered) ||
    // "another X just came / just come / just arrive"
    /\b(another|second|different|new)\s+(person|child|patient|man|woman|baby|infant|adult)\b/.test(lowered) ||
    /\b(just\s+come|just\s+came|just\s+arrived?|just\s+brought?)\b/.test(lowered);
}

function shouldStayOnActiveCondition(
  query: string,
  memory: SessionMemory | null,
  task: TaskType | null,
  interpreted: InterpretedQuery | null,
): boolean {
  if (!memory?.facts?.active_condition) {
    return false;
  }
  // New-patient signal always breaks the thread
  if (isNewPatientSignal(query)) {
    return false;
  }
  if (interpreted?.candidate_conditions?.length) {
    return false;
  }
  if (isLikelyFollowUpReply(query, memory)) {
    return true;
  }
  if (task && (task === "follow_up" || isManagementStyleTask(task) || task === "severity")) {
    return true;
  }
  const lowered = normalizeQueryText(query).toLowerCase();
  if (memory.facts.management_thread && /\b(dose|dosage|treat|treatment|management|protocol|refer|referral|investigation|test|monitor|iv|oxygen|transfusion)\b/.test(lowered)) {
    return true;
  }
  return /\b(it|this|that|same|again|still|what next|next step|follow up|follow-up)\b/.test(lowered);
}

function validateFactsForGate(
  query: string,
  facts: ExtractedPatientFacts,
): Pick<QueryResponse, "answer" | "disposition" | "warnings"> | null {
  const issues: string[] = [];
  if (facts.age_years != null && (facts.age_years < 0 || facts.age_years > 130)) {
    issues.push("age");
  }
  if (facts.weight_kg != null && (facts.weight_kg <= 0 || facts.weight_kg > 300)) {
    issues.push("weight");
  }
  if (facts.patient_age_group === "child" && facts.age_years != null && facts.age_years >= 18) {
    issues.push("age_group");
  }
  if (facts.patient_age_group === "adult" && facts.age_years != null && facts.age_years < 18) {
    issues.push("age_group");
  }

  const heartRate = extractHeartRateBpm(query);
  if (heartRate != null && heartRate > 300) {
    issues.push("heart_rate");
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    answer: "Some patient details look impossible or inconsistent. Please re-enter the age, weight, heart rate, or who the patient is before I continue.",
    disposition: "ASK_CLARIFY",
    warnings: ["invalid_patient_facts", ...issues.map((issue) => `invalid_patient_fact:${issue}`)],
  };
}

function extractHeartRateBpm(query: string): number | null {
  const match = normalizeQueryText(query).match(/\b(?:heart rate|pulse|hr)\s*(?:is|=)?\s*(\d{2,3})\s*(?:bpm)?\b/i);
  return match ? Number(match[1]) : null;
}

function buildGroqUnavailableResponse(
  audience: "community" | "clinician",
  failure: LlmFailure,
): Pick<QueryResponse, "answer" | "disposition" | "warnings" | "citations" | "follow_up_question" | "answer_source"> {
  return {
    answer: audience === "community"
      ? "I cannot reach the system right now. If this is an emergency, go to your nearest health facility immediately."
      : "System temporarily unavailable. Please retry or refer to your NSTG reference.",
    disposition: "INSUFFICIENT_EVIDENCE",
    follow_up_question: null,
    warnings: [formatGroqFailureWarning(failure)],
    citations: [],
    answer_source: "service_unavailable",
  };
}

/**
 * Graceful degradation when the 70B reasoning model fails (429, timeout, etc).
 * Serves a plain-text excerpt from the top retrieved chunk rather than an error.
 * This keeps the operator informed while the LLM quota recovers.
 */
function buildDegradedAnswer(
  chunks: ChunkRecord[],
  candidates: string[],
  failure: LlmFailure,
): Pick<QueryResponse, "answer" | "disposition" | "warnings" | "citations" | "answer_source"> {
  const topChunk = chunks[0];
  if (!topChunk) {
    return {
      answer: "Reasoning unavailable right now. Based on the query, refer to your NSTG directly for this condition. If there are any danger signs, refer immediately.",
      disposition: "INSUFFICIENT_EVIDENCE",
      warnings: [formatGroqFailureWarning(failure), "degraded_mode:no_chunks"],
      citations: [],
      answer_source: "deterministic_gate",
    };
  }
  const condition = topChunk.metadata.condition ?? candidates[0] ?? "the condition";
  const section = topChunk.metadata.section ?? "";
  const excerpt = topChunk.text.slice(0, 400).trim();
  const page = topChunk.metadata.page ? ` (p.${topChunk.metadata.page})` : "";
  return {
    answer: `Reasoning temporarily unavailable. Based on NSTG guideline text for ${condition}${section ? ` — ${section}` : ""}${page}:\n\n${excerpt}\n\nPlease verify against your physical NSTG reference. If any danger signs are present, refer immediately.`,
    disposition: "ANSWER",
    warnings: [formatGroqFailureWarning(failure), "degraded_mode:evidence_excerpt"],
    citations: toCitations(chunks.slice(0, 2)),
    answer_source: "grounded_summary",
  };
}

function formatGroqFailureWarning(failure: LlmFailure): string {
  const statusSuffix = failure.status_code != null ? `:${failure.status_code}` : "";
  return `groq_failure:${failure.stage}:${failure.reason}${statusSuffix}`;
}

function inferAnswerSource(response: QueryResponse): AnswerSource {
  if (response.answer_source) {
    return response.answer_source;
  }
  if (response.triage === "EMERGENCY_ESCALATE" || response.disposition === "EMERGENCY_ESCALATE") {
    return "emergency_gate";
  }
  if ((response.warnings ?? []).some((warning) => warning.startsWith("groq_failure:")) && !(response.citations?.length)) {
    return "service_unavailable";
  }
  if ((response.warnings ?? []).some((warning) => warning.endsWith("_protocol") || warning.includes("protocol_"))) {
    return "protocol";
  }
  if (response.dosage?.formula && (response.dosage.dose_mg != null || response.dosage.dose_range_mg?.length)) {
    return "dosage_engine";
  }
  if ((response.warnings ?? []).some((warning) => warning.startsWith("groq_failure:"))) {
    return "deterministic_gate";
  }
  if (response.disposition === "ASK_CLARIFY" || response.disposition === "INSUFFICIENT_EVIDENCE") {
    return "deterministic_gate";
  }
  if (response.citations?.length) {
    return "llm_reasoning";
  }
  return null;
}

function inferReferUrgency(response: QueryResponse): "immediate" | "soon" | "routine" | null {
  if (response.disposition === "EMERGENCY_ESCALATE" || response.triage === "EMERGENCY_ESCALATE") {
    return "immediate";
  }
  const answer = response.answer.toLowerCase();
  if (/\brefer now\b|\burgent\b|\bimmediately\b|\bnearest health facility immediately\b/.test(answer)) {
    return "immediate";
  }
  if (/\brefer soon\b|\bsame day\b|\bhospital\b/.test(answer)) {
    return "soon";
  }
  return null;
}

export function enrichFrontlineResponse(response: QueryResponse): QueryResponse {
  const whatToAskNext = response.what_to_ask_next
    ?? response.follow_up_question
    ?? (response.disposition === "ASK_CLARIFY" ? response.answer : null);
  const referUrgency = response.refer_urgency ?? inferReferUrgency(response);
  const treatHere = response.treat_here
    ?? (response.disposition === "EMERGENCY_ESCALATE" ? false
      : response.disposition === "ASK_CLARIFY" ? null
      : response.disposition === "INSUFFICIENT_EVIDENCE" ? false
      : referUrgency ? false
      : response.disposition === "ANSWER" ? true
      : null);

  // Append drug availability warning if answer mentions hospital-only drugs
  const drugWarning = flagHospitalOnlyDrugs(response.answer ?? "");
  const warnings = drugWarning
    ? [...(response.warnings ?? []), drugWarning]
    : response.warnings ?? [];

  return {
    ...response,
    treat_here: treatHere,
    refer_urgency: referUrgency,
    what_to_ask_next: whatToAskNext,
    what_to_do_now: response.what_to_do_now ?? null,
    ask_or_check: response.ask_or_check ?? whatToAskNext,
    immediate_actions: response.immediate_actions ?? null,
    answer_source: response.answer_source ?? inferAnswerSource(response),
    warnings,
  };
}

function buildBudgetExceededResponse(audience: "community" | "clinician"): Pick<QueryResponse, "answer" | "disposition" | "follow_up_question" | "warnings" | "citations"> {
  if (audience === "clinician") {
    return {
      answer: "I still do not have enough matched NSTG evidence to answer safely from this conversation alone. Please reassess the patient, refine the differential, or refer for in-person evaluation.",
      disposition: "INSUFFICIENT_EVIDENCE",
      follow_up_question: null,
      warnings: ["Clarification limit reached without enough evidence for a safe answer."],
      citations: [],
    };
  }
  return {
    answer: "I still do not have enough information matched to the guideline to answer safely. Please seek in-person care, especially if the person is getting worse or has any danger sign.",
    disposition: "INSUFFICIENT_EVIDENCE",
    follow_up_question: null,
    warnings: ["Clarification limit reached without enough evidence for a safe answer."],
    citations: [],
  };
}

function mergeUnifiedFacts(
  query: string,
  memory: SessionMemory | null,
  interpretedFacts: ExtractedPatientFacts,
  candidateConditions: string[],
  askOrCheck: string | null,
): ExtractedPatientFacts {
  const existing = memory?.facts ?? {};
  return {
    ...existing,
    ...interpretedFacts,
    symptoms: interpretedFacts.symptoms?.length ? interpretedFacts.symptoms : existing.symptoms ?? [],
    candidate_conditions: candidateConditions.length ? candidateConditions : interpretedFacts.candidate_conditions ?? existing.candidate_conditions ?? [],
    raw_summary: interpretedFacts.raw_summary ?? existing.raw_summary ?? query,
    last_suspected_differential: candidateConditions.length
      ? candidateConditions
      : interpretedFacts.last_suspected_differential ?? existing.last_suspected_differential ?? [],
    last_clarification: askOrCheck,
  };
}

async function answerUnifiedFrontline(params: {
  supabase: SupabaseClient;
  audience: "community" | "clinician";
  query: string;
  topK: number;
  sessionId?: string | null;
}): Promise<QueryResponse> {
  const { supabase, audience, query, topK, sessionId } = params;
  const memoryChannel = audience === "community" ? "community" : "clinical";
  const memory = sessionId ? await loadSessionMemory(supabase, sessionId) : null;
  const clarificationLimitReached = clarificationBudgetReached(memory);
  const interpretationQuery = buildFollowUpInterpretationQuery(query, memory);

  const groq = getGroqConfig();
  if (!groq.enabled || !groq.apiKey) {
    const unavailable = buildGroqUnavailableResponse(audience, {
      stage: "unified",
      reason: "missing_api_key",
      detail: "Unified 70B runtime is not configured.",
    });
    if (sessionId) {
      await saveSessionMemory(
        supabase,
        sessionId,
        memoryChannel,
        { query, disposition: unavailable.disposition, answer_excerpt: unavailable.answer.slice(0, 200) },
        memory?.facts ?? {},
        memory,
      );
    }
    return {
      ...unavailable,
      what_to_do_now: null,
      ask_or_check: null,
      immediate_actions: null,
      treat_here: null,
      refer_urgency: null,
      danger_signs_detected: [],
      patient_snapshot: memory?.facts ?? null,
    };
  }

  const retrievedChunks = await searchChunks(supabase, interpretationQuery || query, Math.max(topK * 2, 8));
  const rankedChunks = rerankChunksForQuery(interpretationQuery || query, retrievedChunks).slice(0, Math.max(topK, 4));
  const unifiedResult = await unifyFrontlineWithGroq(groq.apiKey, groq.model, {
    query,
    audience,
    recentTurns: memory?.recent_turns ?? [],
    accumulatedFacts: memory?.facts ?? {},
    retrievedChunks: rankedChunks,
  });

  if (unifiedResult.failure || !unifiedResult.value) {
    const unavailable = buildGroqUnavailableResponse(audience, unifiedResult.failure ?? {
      stage: "unified",
      reason: "empty_response",
      detail: "Unified runtime returned no usable output.",
    });
    if (sessionId) {
      await saveSessionMemory(
        supabase,
        sessionId,
        memoryChannel,
        { query, disposition: unavailable.disposition, answer_excerpt: unavailable.answer.slice(0, 200) },
        memory?.facts ?? {},
        memory,
      );
    }
    return {
      ...unavailable,
      citations: toCitations(rankedChunks.slice(0, 2)),
      what_to_do_now: null,
      ask_or_check: null,
      immediate_actions: null,
      treat_here: null,
      refer_urgency: null,
      danger_signs_detected: [],
      patient_snapshot: memory?.facts ?? null,
    };
  }

  const unifiedDraft = unifiedResult.value;
  const askOrCheck = unifiedDraft.ask_or_check ?? (unifiedDraft.disposition === "ASK_CLARIFY" ? unifiedDraft.answer : null);
  const mergedFacts = mergeUnifiedFacts(query, memory, unifiedDraft.interpreted_facts, unifiedDraft.candidate_conditions, askOrCheck);

  if (unifiedDraft.disposition === "ASK_CLARIFY" && clarificationLimitReached) {
    const budgetExceeded = buildBudgetExceededResponse(audience);
    if (sessionId) {
      await saveSessionMemory(
        supabase,
        sessionId,
        memoryChannel,
        {
          query,
          disposition: budgetExceeded.disposition,
          answer_excerpt: budgetExceeded.answer.slice(0, 200),
          candidate_conditions: unifiedDraft.candidate_conditions,
        },
        { ...mergedFacts, last_clarification: null },
        memory,
      );
    }
    return {
      ...budgetExceeded,
      triage: unifiedDraft.triage_disposition,
      what_to_do_now: null,
      ask_or_check: null,
      immediate_actions: null,
      treat_here: null,
      refer_urgency: null,
      answer_source: "llm_unified",
      danger_signs_detected: unifiedDraft.danger_signs_detected,
      patient_snapshot: mergedFacts,
    };
  }

  const answer = unifiedDraft.answer.trim()
    || (unifiedDraft.disposition === "ASK_CLARIFY"
      ? askOrCheck ?? "Please share one more key detail about the patient."
      : unifiedDraft.disposition === "INSUFFICIENT_EVIDENCE"
      ? "I do not have enough matched NSTG evidence to answer safely."
      : "Please reassess the patient and refer if the condition is worsening.");
  const citations = toCitations(rankedChunks.slice(0, topK));

  if (sessionId) {
    await saveSessionMemory(
      supabase,
      sessionId,
      memoryChannel,
      {
        query,
        disposition: unifiedDraft.disposition,
        answer_excerpt: answer.slice(0, 200),
        candidate_conditions: unifiedDraft.candidate_conditions,
      },
      mergedFacts,
      memory,
    );
  }

  return {
    answer,
    disposition: unifiedDraft.disposition,
    follow_up_question: askOrCheck ?? undefined,
    triage: unifiedDraft.triage_disposition,
    citations,
    warnings: ["llm_stage:unified"],
    what_to_ask_next: askOrCheck,
    what_to_do_now: unifiedDraft.what_to_do_now,
    ask_or_check: askOrCheck,
    immediate_actions: unifiedDraft.immediate_actions,
    treat_here: unifiedDraft.treat_here ?? (unifiedDraft.disposition === "EMERGENCY_ESCALATE" ? false : unifiedDraft.disposition === "ANSWER" ? true : null),
    refer_urgency: unifiedDraft.refer_urgency ?? (unifiedDraft.disposition === "EMERGENCY_ESCALATE" ? "immediate" : null),
    answer_source: "llm_unified",
    danger_signs_detected: unifiedDraft.danger_signs_detected,
    patient_snapshot: mergedFacts,
  };
}

export async function answerCommunity(
  supabase: SupabaseClient,
  query: string,
  topK = 4,
  sessionId?: string | null,
): Promise<QueryResponse> {
  return answerUnifiedFrontline({
    supabase,
    audience: "community",
    query,
    topK,
    sessionId,
  });
}

export async function answerClinician(
  supabase: SupabaseClient,
  query: string,
  topK = 5,
  sessionId?: string | null,
): Promise<QueryResponse> {
  return answerUnifiedFrontline({
    supabase,
    audience: "clinician",
    query,
    topK,
    sessionId,
  });
}

export async function logInteraction(
  supabase: SupabaseClient,
  params: {
    route: string;
    channel: string;
    query: string;
    top_k: number;
    response: QueryResponse;
    job_id?: string | null;
  },
): Promise<string> {
  const interactionId = crypto.randomUUID().replaceAll("-", "");
  const trace = buildAuditTrace(params.query, params.response);
  const { error } = await supabase.from("audit_interactions").insert({
    interaction_id: interactionId,
    route: params.route,
    channel: params.channel,
    query: params.query,
    normalized_query: normalizeQuery(params.query),
    top_k: params.top_k,
    job_id: params.job_id ?? null,
    response: params.response,
    trace,
    review_required: trace.review_required,
    review_status: trace.operator_review_status,
  });
  if (error) {
    throw new Error(`Failed to write audit interaction: ${error.message}`);
  }
  return interactionId;
}

export async function logFeedback(supabase: SupabaseClient, payload: FeedbackRequest) {
  const feedbackId = crypto.randomUUID().replaceAll("-", "");
  const { error } = await supabase.from("feedback_events").insert({
    feedback_id: feedbackId,
    interaction_id: payload.interaction_id,
    rating: payload.rating,
    comment: payload.comment ?? null,
  });
  if (error) {
    throw new Error(`Failed to write feedback: ${error.message}`);
  }
  return {
    feedback_id: feedbackId,
    interaction_id: payload.interaction_id,
    rating: payload.rating,
  };
}

export async function listReviewInteractions(
  supabase: SupabaseClient,
  params: { limit?: number; reviewRequiredOnly?: boolean } = {},
): Promise<ReviewQueueResponse> {
  const limit = clampReviewLimit(params.limit);
  let query = supabase
    .from("audit_interactions")
    .select("interaction_id,created_at,route,channel,query,normalized_query,top_k,job_id,response,trace,review_required,review_status")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (params.reviewRequiredOnly) {
    query = query.eq("review_required", true);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load review interactions: ${error.message}`);
  }

  const items = ((data ?? []) as AuditInteractionRecord[]).map((row) => ({
    ...row,
    response: row.response ?? {
      answer: "",
      disposition: "UNKNOWN",
      citations: [],
      warnings: [],
    },
    trace: row.trace ?? {
      normalized_query: row.normalized_query ?? normalizeQuery(row.query ?? ""),
      final_disposition: row.response?.disposition ?? "UNKNOWN",
      review_required: Boolean(row.review_required),
      triage_matched_terms: [],
      retrieved_chunks: [],
      operator_review_status: row.review_status ?? null,
    },
  }));

  return {
    items,
    summary: buildReviewSummary(items),
  };
}

export async function updateReviewStatus(
  supabase: SupabaseClient,
  interactionId: string,
  reviewStatus: string,
): Promise<AuditInteractionRecord> {
  const normalizedStatus = normalizeReviewStatus(reviewStatus);
  if (!normalizedStatus) {
    throw new Error("review_status must not be empty.");
  }

  const { data: existing, error: existingError } = await supabase
    .from("audit_interactions")
    .select("interaction_id,created_at,route,channel,query,normalized_query,top_k,job_id,response,trace,review_required,review_status")
    .eq("interaction_id", interactionId)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Failed to load review interaction: ${existingError.message}`);
  }
  if (!existing) {
    throw new Error("Interaction not found.");
  }

  const trace = {
    ...(existing.trace ?? {}),
    operator_review_status: normalizedStatus,
  };

  const { data, error } = await supabase
    .from("audit_interactions")
    .update({
      review_status: normalizedStatus,
      trace,
    })
    .eq("interaction_id", interactionId)
    .select("interaction_id,created_at,route,channel,query,normalized_query,top_k,job_id,response,trace,review_required,review_status")
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to update review status: ${error.message}`);
  }
  if (!data) {
    throw new Error("Updated interaction could not be reloaded.");
  }
  return data as AuditInteractionRecord;
}

export async function createJob(
  supabase: SupabaseClient,
  params: { query: string; topK: number; channel?: string },
): Promise<JobStatusResponse> {
  const jobId = crypto.randomUUID().replaceAll("-", "");
  const { error } = await supabase.from("async_jobs").insert({
    job_id: jobId,
    channel: params.channel ?? "community_voice_job",
    query: params.query,
    top_k: params.topK,
    status: "queued",
    attempt_count: 0,
    last_error: null,
    result: null,
  });
  if (error) {
    throw new Error(`Failed to create job: ${error.message}`);
  }
  return { job_id: jobId, status: "queued", result: null, error: null };
}

export async function markJobRunning(supabase: SupabaseClient, jobId: string): Promise<void> {
  const current = await getJobState(supabase, jobId);
  if (!current) {
    throw new Error("Job not found.");
  }
  const { error } = await supabase
    .from("async_jobs")
    .update({
      status: "running",
      result: null,
      last_error: null,
      attempt_count: (current.attempt_count ?? 0) + 1,
    })
    .eq("job_id", jobId);
  if (error) {
    throw new Error(`Failed to mark job running: ${error.message}`);
  }
}

export async function markJobComplete(
  supabase: SupabaseClient,
  jobId: string,
  result: QueryResponse,
): Promise<JobStatusResponse> {
  const { error } = await supabase.from("async_jobs").update({ status: "completed", result, last_error: null }).eq("job_id", jobId);
  if (error) {
    throw new Error(`Failed to mark job complete: ${error.message}`);
  }
  return { job_id: jobId, status: "completed", result, error: null };
}

export async function markJobFailed(supabase: SupabaseClient, jobId: string, errorText: string): Promise<JobStatusResponse> {
  const { error } = await supabase.from("async_jobs").update({ status: "failed", result: null, last_error: errorText }).eq("job_id", jobId);
  if (error) {
    throw new Error(`Failed to mark job failed: ${error.message}`);
  }
  return { job_id: jobId, status: "failed", result: null, error: errorText };
}

export async function getJob(supabase: SupabaseClient, jobId: string): Promise<JobStatusResponse | null> {
  const { data, error } = await supabase
    .from("async_jobs")
    .select("job_id,status,result,last_error")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load job: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  return {
    job_id: data.job_id,
    status: data.status,
    result: data.result ?? null,
    error: data.last_error ?? null,
  };
}

export async function getJobRequest(
  supabase: SupabaseClient,
  jobId: string,
): Promise<{ job_id: string; query: string; top_k: number; channel: string } | null> {
  const { data, error } = await supabase
    .from("async_jobs")
    .select("job_id,query,top_k,channel")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load job request: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  return {
    job_id: data.job_id,
    query: String(data.query ?? ""),
    top_k: Number(data.top_k ?? 4),
    channel: String(data.channel ?? "community_voice_job"),
  };
}

export async function processCommunityJob(supabase: SupabaseClient, jobId: string): Promise<JobStatusResponse> {
  const request = await getJobRequest(supabase, jobId);
  if (!request) {
    throw new Error("Job not found.");
  }

  try {
    await markJobRunning(supabase, jobId);
    const response = enrichFrontlineResponse(await answerCommunity(supabase, request.query, request.top_k));
    const interactionId = await logInteraction(supabase, {
      route: "/community/voice-jobs",
      channel: request.channel,
      query: request.query,
      top_k: request.top_k,
      response,
      job_id: jobId,
    });
    return await markJobComplete(supabase, jobId, { ...response, interaction_id: interactionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected job processing error.";
    return await markJobFailed(supabase, jobId, message);
  }
}

async function getJobState(supabase: SupabaseClient, jobId: string): Promise<{ attempt_count: number | null } | null> {
  const { data, error } = await supabase
    .from("async_jobs")
    .select("attempt_count")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load job state: ${error.message}`);
  }
  return data;
}

function sectionFilter(task: TaskType): string[] {
  switch (task) {
    case "treatment":
    case "management_protocol":
    case "dose":
      return ["treatment"];
    case "severity":
      return ["clinical features", "complications"];
    case "referral":
      return ["complications", "treatment"];
    case "investigation":
      return ["investigations", "other investigations"];
    case "diagnosis":
      return ["clinical features", "introduction"];
    case "follow_up":
      return ["treatment", "introduction"];
    default:
      return [];
  }
}

// Search separately for each candidate condition and return a Map of condition -> chunks.
// Falls back to symptom terms or raw query when no candidates are given.
async function searchPerCandidate(
  supabase: SupabaseClient,
  candidates: string[],
  fallbackQuery: string,
  topK: number,
  symptoms?: string[],
  task?: TaskType | null,
): Promise<Map<string, ChunkRecord[]>> {
  const result = new Map<string, ChunkRecord[]>();
  const allowedSections = task ? sectionFilter(task) : [];

  const isAllowed = (chunk: ChunkRecord) => {
    if (allowedSections.length === 0) return true;
    const section = (chunk.metadata.section || "").toLowerCase();
    const subsection = (chunk.metadata.subsection || "").toLowerCase();
    
    // Dose requires 'drug' subsection explicitly if available in the metadata schema, or we fallback to treatment filtering if subsection missing entirely.
    if (task === "dose") {
      return section.includes("treatment") && (subsection.includes("drug") || subsection === "");
    }
    
    return allowedSections.some((allowed) => section.includes(allowed));
  };

  if (candidates.length === 0) {
    // Use symptom terms directly if available — they survive the stopword filter better
    const fallbackQueries = buildSymptomSearchQueries(fallbackQuery, symptoms ?? []);
    if (fallbackQueries.length > 0) {
      const combined: ChunkRecord[] = [];
      for (const symptomQuery of fallbackQueries.slice(0, 6)) {
        const chunks = await searchChunks(supabase, symptomQuery, topK * 2);
        combined.push(...chunks);
      }
      const seen = new Set<string>();
      const deduped = combined.filter((chunk) => {
        if (!isAllowed(chunk)) return false;
        if (seen.has(chunk.chunk_id)) return false;
        seen.add(chunk.chunk_id);
        return true;
      });
      result.set("_symptom_fallback", deduped.slice(0, topK));
    } else {
      const chunks = await searchChunks(supabase, fallbackQuery, topK * 2);
      result.set("_fallback", chunks.filter(isAllowed).slice(0, topK));
    }
    return result;
  }

  for (const candidate of candidates.slice(0, 4)) {
    const candidateQueries = buildSearchQueriesForCandidate(candidate, fallbackQuery, symptoms ?? []);
    const combined: ChunkRecord[] = [];
    for (const candidateQuery of candidateQueries.slice(0, 5)) {
      const chunks = await searchChunks(supabase, candidateQuery, topK * 2);
      combined.push(...chunks);
    }
    const seen = new Set<string>();
    const deduped = combined.filter((chunk) => {
      if (!isAllowed(chunk)) return false;
      if (seen.has(chunk.chunk_id)) return false;
      seen.add(chunk.chunk_id);
      return true;
    });
    result.set(candidate, deduped.slice(0, topK));
  }

  return result;
}

async function searchChunks(
  supabase: SupabaseClient,
  query: string,
  topK: number,
): Promise<ChunkRecord[]> {
  // query may be a space-separated list of candidate conditions + symptoms.
  // websearch_to_tsquery treats spaces as AND — so multi-condition queries return nothing.
  // We search each term separately and deduplicate by chunk_id.
  const terms = query.split(/\s{2,}|\|/).map((t) => t.trim()).filter(Boolean);
  const searchTerms = terms.length > 0 ? terms : [query];

  const seen = new Set<string>();
  const results: ChunkRecord[] = [];

  for (const term of searchTerms.slice(0, 4)) {
    const preparedTerm = term.length > 40 ? term : prepareSearchQuery(term) || term;
    const { data, error } = await supabase.rpc("search_guideline_chunks", {
      query_text: preparedTerm,
      match_count: topK,
    });
    if (error) {
      throw new Error(`Failed to search guideline chunks: ${error.message}`);
    }
    for (const chunk of (data ?? []) as ChunkRecord[]) {
      if (!seen.has(chunk.chunk_id)) {
        seen.add(chunk.chunk_id);
        results.push(chunk);
      }
    }
  }

  return results;
}

function toCitations(chunks: ChunkRecord[]): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const key = JSON.stringify([
      chunk.metadata.source_file ?? null,
      chunk.metadata.condition ?? chunk.metadata.document_title ?? "",
      chunk.metadata.section ?? null,
      chunk.metadata.subsection ?? null,
      chunk.metadata.page ?? null,
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    citations.push({
      source_file: chunk.metadata.source_file ?? null,
      condition: chunk.metadata.condition ?? chunk.metadata.document_title ?? "Unknown",
      section: chunk.metadata.section ?? null,
      subsection: chunk.metadata.subsection ?? null,
      page: chunk.metadata.page ?? null,
    });
  }
  return citations;
}

function excerpt(text: string, maxChars = 420): string {
  const body = text.includes("\n\n") ? text.split("\n\n", 2)[1].trim() : text.trim();
  if (body.length <= maxChars) {
    return body;
  }
  return `${body.slice(0, maxChars - 3).trimEnd()}...`;
}

function formatPrimaryCitation(chunk: ChunkRecord): string {
  const lineage = [
    chunk.metadata.condition ?? chunk.metadata.document_title ?? "Unknown",
    chunk.metadata.section ?? null,
    chunk.metadata.subsection ?? null,
  ].filter(Boolean);
  const location = lineage.join(" -> ");
  if (chunk.metadata.page) {
    return `Citation: ${location} (page ${chunk.metadata.page})`;
  }
  return `Citation: ${location}`;
}

function formatSummaryBlock(text: string): string {
  const points = extractPoints(text, 5);
  if (!points.length) {
    return text;
  }
  return formatPoints(points);
}

function formatActionBlock(text: string, dosageLine: string | null): string {
  if (dosageLine) {
    return formatPoints([dosageLine]);
  }
  const points = extractPoints(text, 2);
  if (!points.length) {
    return formatPoints(["Use the NSTG treatment guidance below"]);
  }
  return formatPoints(points.slice(0, 2));
}

function isDoseRequest(query: string): boolean {
  return /\b(dose|dosage|mg\/kg|mg per kg|how much|how many ml)\b/i.test(query);
}

function extractProtocolIntents(query: string): string[] {
  const lowered = normalizeQueryText(query).toLowerCase();
  const intents: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/\b(dose|dosage|mg\/kg|mg per kg|how much|how many ml)\b/i, "dose"],
    [/\b(treat|treatment|management|manage|protocol)\b/i, "treatment"],
    [/\b(iv|intravenous|infusion)\b/i, "iv treatment"],
    [/\b(transfusion|blood transfusion)\b/i, "blood transfusion"],
    [/\b(investigation|investigations|test|tests|workup)\b/i, "investigations"],
    [/\b(complication|complications)\b/i, "complications"],
    [/\b(prevention|prevent)\b/i, "prevention"],
    [/\b(dka|diabetic ketoacidosis)\b/i, "diabetic ketoacidosis"],
    [/\b(severe malaria)\b/i, "severe malaria"],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(lowered)) {
      intents.push(label);
    }
  }

  return [...new Set(intents)];
}

function buildSearchQueriesForCandidate(candidate: string, query: string, symptoms: string[]): string[] {
  const queries = [candidate];
  const intents = extractProtocolIntents(query);
  for (const intent of intents.slice(0, 3)) {
    queries.push(`${candidate} ${intent}`);
  }
  if (/malaria/i.test(candidate) && /\b(severe|transfusion|iv|intravenous|anaemia|anemia)\b/i.test(query)) {
    queries.push("severe malaria");
    queries.push("blood transfusion");
  }
  for (const symptom of symptoms.slice(0, 2)) {
    queries.push(`${candidate} ${symptom}`);
  }
  return mergeUnique(queries);
}

function buildSymptomSearchQueries(query: string, symptoms: string[]): string[] {
  const queries: string[] = [];
  const intents = extractProtocolIntents(query);
  const topSymptoms = symptoms.slice(0, 3);
  if (topSymptoms.length >= 2) {
    queries.push(topSymptoms.join(" "));
  }
  for (const symptom of topSymptoms) {
    queries.push(symptom);
    for (const intent of intents.slice(0, 2)) {
      queries.push(`${symptom} ${intent}`);
    }
  }
  if (/\b(fever).*(rash)|(rash).*(fever)\b/i.test(query)) {
    queries.push("fever rash");
  }
  if (/\b(dka|diabetic ketoacidosis)\b/i.test(query)) {
    queries.push("diabetic ketoacidosis");
    queries.push("diabetes mellitus treatment");
    queries.push("hyperglycemia child treatment");
  }
  return mergeUnique(queries);
}

function hasSufficientContextForBestEffort(
  interpreted: InterpretedQuery | null,
  memory: SessionMemory | null,
  candidates: string[],
  symptoms: string[],
): boolean {
  const priorTurns = memory?.recent_turns?.length ?? 0;
  return candidates.length > 0 || symptoms.length >= 2 || interpreted?.raw_summary?.length !== 0 || priorTurns >= 2;
}

function buildBestEffortInsufficientEvidenceResponse(audience: "community" | "clinician", candidates: string[]): QueryResponse {
  const conditionText = candidates.length > 0 ? ` for ${candidates.slice(0, 2).join(" or ")}` : "";
  if (audience === "clinician") {
    return {
      answer: `I do not have enough matched NSTG evidence${conditionText} to answer safely. Reassess the patient, review the cited guideline sections directly, or refine the query with the key syndrome or protocol step.`,
      disposition: "INSUFFICIENT_EVIDENCE",
      follow_up_question: null,
      warnings: ["Best-effort safe refusal used after repeated clarification without enough grounded evidence."],
      citations: [],
    };
  }
  return {
    answer: `I do not have enough matched guideline evidence${conditionText} to answer safely from this conversation. Please seek in-person care or ask with the main symptoms and age if you can.`,
    disposition: "INSUFFICIENT_EVIDENCE",
    follow_up_question: null,
    warnings: ["Best-effort safe refusal used after repeated clarification without enough grounded evidence."],
    citations: [],
  };
}

function buildDeterministicClinicianDoseAnswer(
  chunk: ChunkRecord,
  dosage: DosageResult,
): ClinicalDecision {
  const section = `${chunk.metadata.section ?? "Unknown"}${chunk.metadata.subsection ? ` -> ${chunk.metadata.subsection}` : ""}`;
  const doseLine = dosage.dose_range_mg
    ? `Dose: ${dosage.dose_range_mg[0]}-${dosage.dose_range_mg[1]} mg for ${dosage.weight_kg} kg (${dosage.formula}).`
    : `Dose: ${dosage.dose_mg} mg for ${dosage.weight_kg} kg (${dosage.formula}).`;
  const lines = [
    `Condition: ${chunk.metadata.condition ?? chunk.metadata.document_title ?? "Guideline"}`,
    `Section: ${section}`,
    doseLine,
    dosage.note ?? "Calculated from explicit retrieved mg/kg guidance. Final clinical verification is still required.",
    formatPrimaryCitation(chunk),
  ];
  return {
    disposition: "ANSWER",
    leading_condition: chunk.metadata.condition ?? null,
    also_considered: [],
    reasoning: "Deterministic dosage answer generated from explicit retrieved mg/kg formula.",
    response_text: lines.join("\n\n"),
    clarifying_question: null,
    what_to_do_now: ["Verify the dose against the cited NSTG section before giving it."],
    ask_or_check: null,
    refer_if: null,
    dose_line: doseLine,
    treat_here: true,
  };
}

function detectPatientGroup(query: string): "child" | "adult" {
  const lowered = normalizeQueryText(query).toLowerCase();
  if (/\b(child|children|baby|infant|newborn|toddler|kid|pikin|son|daughter|boy|girl)\b/.test(lowered)) {
    return "child";
  }
  return "adult";
}

function stripUnsafeTreatmentText(
  text: string,
  params: { evidenceChunks: ChunkRecord[]; dosage: DosageResult | null; audience: "community" | "clinician"; isDoseQuery?: boolean },
): string {
  const { evidenceChunks, dosage, audience, isDoseQuery = false } = params;
  const evidenceText = evidenceChunks.map((chunk) => chunk.text.toLowerCase()).join("\n");
  const hasDeterministicDose = Boolean(dosage?.formula && (dosage.dose_mg != null || dosage.dose_range_mg?.length));
  const hasOrsRecipeEvidence = /\b(?:ors|oral rehydration|sugar|salt|teaspoon|sachet|lit(?:er|re)|ml)\b/i.test(evidenceText);
  const doseSentenceRe = /\b\d+(?:\.\d+)?\s*(?:mg\/kg|mg|ml)\b/i;
  const recipeSentenceRe = /\b(?:ors|oral rehydration).*(?:teaspoon|sugar|salt|lit(?:er|re)|ml|sachet)\b/i;

  const segments = text
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const safeSegments = segments.filter((segment) => {
    if (!hasDeterministicDose && doseSentenceRe.test(segment)) {
      return false;
    }
    if (!hasOrsRecipeEvidence && recipeSentenceRe.test(segment)) {
      return false;
    }
    return true;
  });
  const removedUnsafeSegment = safeSegments.length !== segments.length;

  const sanitized = safeSegments.join("\n\n").trim();
  if (sanitized) {
    return sanitized;
  }
  if (removedUnsafeSegment && audience === "community") {
    return "I found guidance, but not enough trusted detail here to give exact quantities safely. Please follow the cited guideline section or seek in-person care for exact preparation or dosing advice.";
  }
  if (audience === "clinician" && isDoseQuery) {
    return "NSTG evidence was retrieved, but no explicit dosing formula was found in the retrieved text. Recheck the cited guideline section directly before prescribing a dose.";
  }
  return text;
}

function formatCommunityAnswer(chunk: ChunkRecord, summary: string): string {
  const condition = chunk.metadata.condition ?? chunk.metadata.document_title ?? "Guideline";
  let location = chunk.metadata.section ?? "Guidance";
  if (chunk.metadata.subsection) {
    location += ` -> ${chunk.metadata.subsection}`;
  }
  const points = extractPoints(summary, 5);
  const usablePoints = points.length ? points : ["I could not turn this guideline section into simple steps."];
  const firstGroup = usablePoints.slice(0, 3);
  const secondGroup = usablePoints.slice(3, 5);
  const lines = [
    `Condition: ${condition}`,
    `Section: ${location}`,
    "What To Do Now:",
    formatPoints(firstGroup),
  ];
  if (secondGroup.length) {
    lines.push("Key Points:");
    lines.push(formatPoints(secondGroup));
  }
  lines.push(formatPrimaryCitation(chunk));
  return lines.join("\n\n");
}

function extractPoints(text: string, limit: number): string[] {
  const cleaned = text.replace(/\r/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return [];
  }
  let parts = cleaned
    .split(/\s[•-]\s+(?=[A-Z(])/)
    .map((segment) => segment.trim().replace(/^[•-]\s*/, "").replace(/[•\s.-]+$/g, ""))
    .filter(Boolean);
  if (parts.length <= 1) {
    parts = cleaned
      .split(/(?<=[.!?])\s+/)
      .map((segment) => segment.trim().replace(/[•\s.-]+$/g, ""))
      .filter(Boolean);
  }
  const points: string[] = [];
  for (const part of parts) {
    let normalized = part.replace(/\s+/g, " ").trim().replace(/^[•-]\s*/, "").replace(/[•\s.-]+$/g, "");
    const lower = normalized.toLowerCase();
    for (const prefix of ["summary:", "action:", "what to do now:", "key points:"]) {
      if (lower.startsWith(prefix)) {
        normalized = normalized.slice(prefix.length).trim();
        break;
      }
    }
    if (!normalized) {
      continue;
    }
    points.push(normalized);
    if (points.length >= limit) {
      break;
    }
  }
  return points;
}

function formatPoints(points: string[]): string {
  return points.map((point) => `- ${point.replace(/\.+$/g, "")}.`).join("\n\n");
}

/**
 * Formats a ClinicalDecision into the canonical frontline answer structure:
 *
 *   Likely problem: [condition]
 *   Treat here: Yes / No — refer now
 *   What to do now: [steps]
 *   Ask or check: [one missing datapoint if any]
 *   Refer if: [red flags]
 *   Dose: [if supported by evidence]
 *   Source: [NSTG citation]
 *
 * Falls back to `response_text` if the structured fields are absent (e.g. older
 * LLM calls that don't populate them yet).
 */
function formatFrontlineAnswer(
  decision: ClinicalDecision,
  citations: Citation[],
  dosage: DosageResult | null,
): string {
  // If the LLM didn't populate structured fields, return response_text as-is.
  if (!decision.what_to_do_now?.length && !decision.refer_if) {
    return decision.response_text;
  }

  const lines: string[] = [];

  // 1. Likely problem
  if (decision.leading_condition) {
    lines.push(`Likely problem: ${decision.leading_condition}`);
  }

  // 2. Treat here
  if (decision.treat_here === true) {
    lines.push("Treat here: Yes");
  } else if (decision.treat_here === false) {
    lines.push("Treat here: No — refer now");
  }

  // 3. What to do now
  if (decision.what_to_do_now?.length) {
    lines.push("\nWhat to do now:");
    decision.what_to_do_now.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`);
    });
  }

  // 4. Ask or check
  const askOrCheck = decision.ask_or_check ?? null;
  if (askOrCheck) {
    lines.push(`\nAsk or check: ${askOrCheck}`);
  }

  // 5. Refer if
  if (decision.refer_if) {
    lines.push(`\nRefer if: ${decision.refer_if}`);
  }

  // 6. Dose — prefer deterministic dosage engine result
  const doseText = dosage?.dose_mg != null
    ? `${dosage.dose_mg} mg${dosage.medication ? ` ${dosage.medication}` : ""}${dosage.note ? ` (${dosage.note})` : ""}`
    : dosage?.dose_range_mg?.length === 2
    ? `${dosage.dose_range_mg[0]}–${dosage.dose_range_mg[1]} mg${dosage.medication ? ` ${dosage.medication}` : ""}`
    : decision.dose_line ?? null;

  if (doseText) {
    lines.push(`\nDose: ${doseText}`);
  }

  // 7. Source
  if (citations.length > 0) {
    const citationText = citations
      .slice(0, 2)
      .map((c) => `${c.condition}${c.section ? ` > ${c.section}` : ""}${c.page ? ` (p.${c.page})` : ""}`)
      .join("; ");
    lines.push(`\nSource: NSTG — ${citationText}`);
  }

  return lines.join("\n").trim();
}

function formatEmergencyGuidance(query: string, triage: ReturnType<typeof assessTriage>): string {
  // Canonical emergency format (Phase 6):
  //   EMERGENCY — [danger sign]
  //   What to do now: [immediate steps]
  //   Go to: [nearest facility type]
  //   Show this to the nurse: [brief symptom summary]
  //   While travelling: [what to do en route]
  const patientGroup = detectPatientGroup(query);
  const label = emergencyLabel(triage, patientGroup);
  const steps = emergencySteps(triage, patientGroup);
  const matched = new Set(triage.matched_terms);

  const lines: string[] = [];
  lines.push(`EMERGENCY — ${label}`);
  lines.push("");
  lines.push("What to do now:");
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push("");
  lines.push("Go to: nearest hospital or urgent care facility immediately");
  lines.push("");

  // "Show this to the nurse" — brief symptom summary from matched terms
  const dangerSigns = triage.matched_terms.map((t) => t.replace(/_/g, " ")).join(", ");
  if (dangerSigns) {
    lines.push(`Show this to the nurse: ${dangerSigns}`);
    lines.push("");
  }

  // "While travelling" — condition-specific en-route guidance
  if (matched.has("convulsion")) {
    lines.push("While travelling: keep the patient on their side. Do not put anything in the mouth.");
  } else if (matched.has("respiratory_distress")) {
    lines.push("While travelling: keep the patient sitting upright. Loosen tight clothing.");
  } else if (matched.has("unconscious")) {
    lines.push("While travelling: keep the patient on their side. Monitor breathing.");
  } else if (matched.has("severe_bleeding")) {
    lines.push("While travelling: keep firm pressure on the bleeding area.");
  } else {
    lines.push("While travelling: keep the patient warm and monitor their breathing.");
  }

  return lines.join("\n").trim();
}

function emergencyLabel(triage: ReturnType<typeof assessTriage>, patientGroup: "child" | "adult"): string {
  const matched = new Set(triage.matched_terms);
  const subject = patientGroup === "child" ? "child" : "person";
  if (matched.has("convulsion")) {
    return `The ${subject} may be having a convulsion or seizure`;
  }
  if (matched.has("respiratory_distress")) {
    return `The ${subject} may be having serious trouble breathing`;
  }
  if (matched.has("cannot_drink")) {
    return patientGroup === "child"
      ? "The child may be too sick to drink or feed safely"
      : "The person may be too sick to drink safely";
  }
  if (matched.has("unconscious")) {
    return patientGroup === "child"
      ? "The child may not be fully conscious or may not be waking properly"
      : "The person may not be fully conscious or may not be waking properly";
  }
  if (matched.has("severe_bleeding")) {
    return "There may be dangerous heavy bleeding";
  }
  return "There may be a serious danger sign that needs urgent care";
}

function emergencySteps(triage: ReturnType<typeof assessTriage>, patientGroup: "child" | "adult"): string[] {
  const matched = new Set(triage.matched_terms);
  const subject = patientGroup === "child" ? "child" : "person";
  const steps = [`Stay with the ${subject} and go for urgent in-person care now`];
  if (matched.has("convulsion")) {
    steps.push(`Lay the ${subject} on the side`);
    steps.push("Do not put anything in the mouth");
    steps.push(`Move hard or sharp objects away from the ${subject}`);
  }
  if (matched.has("respiratory_distress")) {
    steps.push(`Keep the ${subject} sitting up or in the easiest position for breathing`);
    steps.push("Loosen tight clothing around the neck and chest");
  }
  if (matched.has("cannot_drink")) {
    steps.push(patientGroup === "child"
      ? "Do not force food or drink if the child cannot swallow safely"
      : "Do not force food or drink if the person cannot swallow safely");
  }
  if (matched.has("unconscious")) {
    steps.push(`If the ${subject} is not waking well, keep the ${subject} on the side`);
  }
  if (matched.has("severe_bleeding")) {
    steps.push("Press firmly on the bleeding area with a clean cloth if you can");
  }
  steps.push(`If the ${subject} stops breathing, collapses, or the shaking does not stop, shout for help immediately`);
  return [...new Set(steps)].slice(0, 5);
}

function selectSaferTriageResult(
  primary: ReturnType<typeof assessTriage>,
  candidate: ReturnType<typeof assessTriage> | null,
) {
  if (!candidate) {
    return primary;
  }
  const priority: Record<string, number> = {
    EMERGENCY_ESCALATE: 3,
    UNCERTAIN_ESCALATE: 2,
    NON_EMERGENCY_CONTINUE: 1,
  };
  if ((priority[candidate.disposition] ?? 0) > (priority[primary.disposition] ?? 0)) {
    return candidate;
  }
  return primary;
}

function stripCommandPrefix(query: string): string {
  return query.replace(/^\/(clinical|community)\s*/i, "").trim();
}

function prepareSearchQuery(query: string): string {
  const stopwords = new Set([
    "for",
    "with",
    "child",
    "adult",
    "patient",
    "severe",
    "acute",
    "chronic",
    "query",
    "kg",
    "in",
    "of",
    "the",
    "clinical",
    "community",
    "has",
    "have",
    "had",
    "also",
    "age",
    "old",
    "year",
    "years",
    "month",
    "months",
    "day",
    "days",
    "well",
    "not",
    "patient's",
  ]);
  const correctedQuery = normalizeQueryText(stripCommandPrefix(query));
  const tokens = (correctedQuery.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 2 && !/\d/.test(token) && !stopwords.has(token),
  );
  if (tokens.length === 0) {
    return correctedQuery || query;
  }
  const uniqueTokens = [...new Set(tokens)];
  return uniqueTokens.slice(0, 6).join(" ");
}

function clinicianClarificationPrompt(query: string): string | null {
  const lowered = normalizeQueryText(query).toLowerCase();
  if (["dose", "dosage", "mg/kg", "mg per kg"].some((token) => lowered.includes(token)) && !lowered.includes("kg")) {
    const medication = extractMedicationHint(query);
    return medication
      ? `What is the patient's weight in kg for the ${medication} dose calculation?`
      : "What is the patient's weight in kg for this dose calculation?";
  }
  return null;
}

function communityClarificationPrompt(query: string): string | null {
  const lowered = query.toLowerCase().trim().replace(/[ ?.]+$/g, "");
  const symptomTerms = new Set(["diarrhoea", "diarrhea", "vomiting", "fever", "feever", "cough", "rash", "headache", "pain"]);
  const hasConditionHint = ["malaria", "typhoid", "pneumonia", "measles", "cholera", "tuberculosis", "hiv", "anaemia"].some(
    (condition) => lowered.includes(condition),
  );
  // Don't re-ask if the query already contains age or weight context
  const hasAgeOrWeight = /\b(\d+\s*(year|yr|month|week|day|kg|pound)s?\b|age\s+\d+|\d+\s*years?\s*old)/i.test(query);
  if (hasAgeOrWeight) return null;
  // single-word symptom, or symptom-only query without a named condition (up to ~12 words)
  if (!hasConditionHint && (symptomTerms.has(lowered) || (lowered.split(/\s+/).length <= 12 && [...symptomTerms].some((term) => lowered.includes(term))))) {
    return "Who is the patient, and what is the person's age or weight? Any other symptoms?";
  }
  return null;
}

function extractMedicationHint(query: string): string | null {
  const normalizedQuery = normalizeQueryText(query);
  const stopwords = new Set(["dose", "dosage", "for", "with", "child", "adult", "patient", "treatment", "management", "query"]);
  for (const token of normalizedQuery.replace(/\//g, " ").split(/\s+/)) {
    const cleaned = token.replace(/[ ,.?():;]+/g, "").toLowerCase();
    if (cleaned.length <= 3 || stopwords.has(cleaned)) {
      continue;
    }
    return cleaned;
  }
  return null;
}

function rerankChunksForQuery(query: string, chunks: ChunkRecord[]): ChunkRecord[] {
  const lowered = query.toLowerCase();

  const score = (chunk: ChunkRecord): number => {
    const condition = (chunk.metadata.condition ?? chunk.metadata.document_title ?? "").toLowerCase();
    const section = (chunk.metadata.section ?? "").toLowerCase();
    const subsection = (chunk.metadata.subsection ?? "").toLowerCase();
    const text = chunk.text.toLowerCase();
    let value = 0;

    if (condition && lowered.includes(condition)) {
      value += 6;
    }

    if (["treatment", "treat", "management"].some((token) => lowered.includes(token))) {
      if (section === "treatment") {
        value += 5;
      }
      if (["drug", "non-drug", "goals", "supportive measures", "adverse reactions and cautions"].includes(subsection)) {
        value += 2;
      }
      if (section === "clinical features") {
        value -= 2.5;
      }
    }

    if (["dose", "dosage", "mg/kg", "mg per kg"].some((token) => lowered.includes(token))) {
      if (section === "treatment") {
        value += 4;
      }
      if (subsection === "drug") {
        value += 3;
      }
      if (text.includes("mg/kg") || text.includes(" mg / kg") || text.includes(" mg/kg")) {
        value += 2;
      }
    }

    if (["investigation", "investigations", "test", "tests"].some((token) => lowered.includes(token)) && section === "investigations") {
      value += 5;
    }

    if (["prevention", "prevent"].some((token) => lowered.includes(token)) && section === "prevention") {
      value += 5;
    }

    if (["complication", "complications"].some((token) => lowered.includes(token)) && section === "complications") {
      value += 5;
    }

    if (["symptom", "symptoms", "sign", "signs", "feature", "features"].some((token) => lowered.includes(token)) && section === "clinical features") {
      value += 4;
    }

    if (["child", "children", "paediatric", "pediatric", "infant", "newborn"].some((token) => lowered.includes(token))) {
      if (["child", "children", "paediatric", "pediatric", "infant", "newborn"].some((token) => text.includes(token))) {
        value += 1.5;
      }
    }

    return value;
  };

  return [...chunks].sort((left, right) => score(right) - score(left));
}

function buildAuditTrace(query: string, response: QueryResponse) {
  const gemini = getGroqConfig();
  const llmFailure = extractLlmFailureFromWarnings(response.warnings ?? []);
  const recomputedTriage = response.answer_source && ["llm_unified", "service_unavailable"].includes(response.answer_source)
    ? null
    : response.triage
    ? assessTriage(query)
    : null;
  return {
    normalized_query: normalizeQuery(query),
    triage_disposition: response.triage ?? recomputedTriage?.disposition ?? null,
    triage_matched_terms: response.danger_signs_detected ?? recomputedTriage?.matched_terms ?? [],
    retrieved_chunks: (response.citations ?? []).map((citation) => ({
      condition: citation.condition ?? null,
      section: citation.section ?? null,
      subsection: citation.subsection ?? null,
      page: citation.page ?? null,
      source_file: citation.source_file ?? null,
    })),
    prompt_template_version: null,
    model_version: gemini.enabled && gemini.apiKey ? gemini.model : "deterministic-rag-v1",
    deterministic_calculation: response.dosage ?? null,
    final_disposition: response.disposition,
    review_required: requiresReview(response),
    operator_review_status: null,
    gate_decision: extractGateDecision(response),
    llm_failure_stage: llmFailure?.stage ?? null,
    llm_failure_reason: llmFailure?.reason ?? null,
    interpreted_facts: response.patient_snapshot ?? null,
  };
}

function requiresReview(response: QueryResponse): boolean {
  return ["EMERGENCY_ESCALATE", "UNCERTAIN_ESCALATE", "INSUFFICIENT_EVIDENCE", "ASK_CLARIFY"].includes(response.disposition)
    || Boolean(response.warnings?.length);
}

function extractGateDecision(response: QueryResponse): string | null {
  const warnings = response.warnings ?? [];
  for (const warning of warnings) {
    if (
      warning === "candidate_missing" ||
      warning === "section_missing" ||
      warning === "dose_missing" ||
      warning === "invalid_patient_facts" ||
      warning.startsWith("invalid_patient_fact:")
    ) {
      return warning;
    }
  }
  if (warnings.some((warning) => warning.includes("Best-effort safe refusal"))) {
    return "best_effort_safe_refusal";
  }
  return null;
}

function extractLlmFailureFromWarnings(warnings: string[]): { stage: string; reason: string } | null {
  for (const warning of warnings) {
    const match = warning.match(/^groq_failure:([^:]+):([^:]+)$/);
    if (match) {
      return { stage: match[1], reason: match[2] };
    }
  }
  return null;
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, " ");
}

function normalizeQueryText(query: string): string {
  const corrections = new Map<string, string>([
    ["tyhoid", "typhoid"],
    ["doosage", "dosage"],
    ["diarrohea", "diarrhoea"],
    ["diarhoea", "diarrhoea"],
    ["arthemeter", "artemether"],
    ["lumafantrine", "lumefantrine"],
    ["feever", "fever"],
    ["fiver", "fever"],
    ["malaraia", "malaria"],
    ["malarai", "malaria"],
    ["pnuemonia", "pneumonia"],
    ["pnemonia", "pneumonia"],
    ["tyfoid", "typhoid"],
    ["diarrea", "diarrhoea"],
    ["diarreha", "diarrhoea"],
  ]);
  const tokens = normalizeQuery(query).match(/[a-z0-9]+/g) ?? [];
  if (!tokens.length) {
    return query.trim();
  }
  return tokens.map((token) => corrections.get(token) ?? token).join(" ");
}

function buildRetrievalTerms(interpreted: InterpretedQuery | null, originalQuery: string): string {
  const terms: string[] = [];

  if (interpreted) {
    // Primary: exact condition names (boosted by search_guideline_chunks scoring)
    for (const condition of interpreted.candidate_conditions) {
      terms.push(condition);
    }
    // Secondary: symptom terms (broadens to clinical features sections)
    for (const symptom of interpreted.symptoms.slice(0, 4)) {
      terms.push(symptom);
    }
  }

  // Fallback: keyword extraction when Gemini is off or returned nothing
  if (terms.length === 0) {
    const prepared = prepareSearchQuery(originalQuery);
    const fallbackTokens = prepared.split(/\s+/).map((term) => term.trim()).filter(Boolean);
    if (fallbackTokens.length > 0) {
      terms.push(...fallbackTokens.slice(0, 4));
    } else if (prepared) {
      terms.push(prepared);
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(term);
    }
  }

  return unique.slice(0, 8).join(" | ");
}

function buildNoChunkClarification(interpreted: InterpretedQuery | null, originalQuery: string): string {
  if (!interpreted || interpreted.candidate_conditions.length === 0) {
    return "Could you describe the main symptom or illness more specifically? For example, fever, cough, stomach pain, or a known condition name.";
  }
  const conditions = interpreted.candidate_conditions.slice(0, 2).join(" or ");
  return `I could not find a matching guideline section for ${conditions}. Could you describe the main problem in more detail or confirm the condition name?`;
}

async function normalizeCommunityTriageQuery(query: string): Promise<string> {
  const corrected = normalizeQueryText(stripCommandPrefix(query));
  const config = getGroqConfig();
  if (!config.enabled || !config.apiKey) {
    return corrected;
  }
  const rewritten = await normalizeCommunityTriageWithGemini(config.apiKey, config.lightModel, corrected);
  const normalizedRewrite = rewritten.value?.trim();
  if (!normalizedRewrite) {
    return corrected;
  }
  const originalTriage = assessTriage(corrected);
  const rewrittenTriage = assessTriage(normalizedRewrite);
  const originalHits = new Set(originalTriage.matched_terms);
  const introducedDangerSign = rewrittenTriage.matched_terms.some((term) => !originalHits.has(term));
  if (rewrittenTriage.disposition !== originalTriage.disposition && introducedDangerSign) {
    return corrected;
  }
  return normalizedRewrite;
}

async function renderGroundedSummary(params: {
  query: string;
  audience: "community" | "clinician";
  chunk: ChunkRecord;
  dosageLine?: string | null;
}): Promise<string | null> {
  const config = getGroqConfig();
  if (!config.enabled || !config.apiKey) {
    return null;
  }
  const summary = await summarizeChunkWithGemini(config.apiKey, config.lightModel, params);
  return summary.value;
}

function normalizeReviewStatus(reviewStatus: string): string {
  return reviewStatus.trim().toLowerCase().replace(/\s+/g, "_");
}

function clampReviewLimit(value: number | undefined): number {
  const parsed = Number(value ?? 12);
  if (!Number.isFinite(parsed)) {
    return 12;
  }
  return Math.max(1, Math.min(50, Math.trunc(parsed)));
}

function buildReviewSummary(items: AuditInteractionRecord[]) {
  const emergencyDispositions = new Set(["EMERGENCY_ESCALATE", "UNCERTAIN_ESCALATE"]);
  return {
    total_items: items.length,
    review_required_items: items.filter((item) => item.review_required).length,
    reviewed_items: items.filter((item) => Boolean(item.review_status)).length,
    emergency_items: items.filter((item) => emergencyDispositions.has(item.trace?.final_disposition ?? "")).length,
    clinician_items: items.filter((item) => item.channel.includes("clinical")).length,
  };
}

export function checkAnswerability(
  task: TaskType | null,
  candidates: string[],
  chunks: ChunkRecord[],
  dosageResult: DosageResult | null,
  query: string
): Pick<QueryResponse, "answer" | "disposition" | "warnings"> | null {
  if (candidates.length === 0 && chunks.length === 0) {
    return {
      answer: "Could you describe the main symptom or illness more specifically?",
      disposition: "ASK_CLARIFY",
      warnings: ["candidate_missing"],
    };
  }

  if (task && candidates.length > 0 && chunks.length === 0) {
    const sectionName = sectionFilter(task).join(" or ") || "guidance";
    return {
      answer: `The NSTG does not have a ${sectionName} section for ${candidates.join(" or ")} in the retrieved evidence.`,
      disposition: "INSUFFICIENT_EVIDENCE",
      warnings: ["section_missing"],
    };
  }

  if (task === "dose" && chunks.length > 0) {
    if (!dosageResult?.formula && !dosageResult?.dose_mg && !dosageResult?.dose_range_mg) {
      const drugName = extractMedicationHint(query) || "this drug";
      return {
        answer: `The dose for ${drugName} is not explicitly in the retrieved NSTG text; check the drug insert or refer.`,
        disposition: "INSUFFICIENT_EVIDENCE",
        warnings: ["dose_missing"],
      };
    }
  }

  return null;
}

export function validateResponse(
  responseText: string,
  task: TaskType | null,
  chunks: ChunkRecord[],
  dosageResult: DosageResult | null,
  patientAgeGroup: "child" | "adult" | null
): Pick<QueryResponse, "answer" | "disposition" | "warnings"> | null {
  let validatedText = responseText;
  const warnings: string[] = [];

  // Adult message must not say "child" unless patient is a child
  if (patientAgeGroup === "adult" && /\b(child|children|kid|kids|baby|babies|toddler)\b/i.test(validatedText)) {
    validatedText = validatedText.replace(/\b(child|children|kid|kids|baby|babies|toddler)\b/gi, "patient");
    warnings.push("Corrected patient age group from child to adult in response.");
  }

  // If dose value present, drug name must also be present — prepend from dosage.ts
  if (dosageResult?.medication && (dosageResult.dose_mg != null || dosageResult.dose_range_mg?.length)) {
    const doseValues = [
      dosageResult.dose_mg?.toString() ?? null,
      dosageResult.dose_range_mg?.[0]?.toString() ?? null,
      dosageResult.dose_range_mg?.[1]?.toString() ?? null,
    ].filter((value): value is string => Boolean(value));
    const mentionsDoseValue = doseValues.some((value) => new RegExp(`\\b${escapeRegExp(value)}\\b`, "i").test(validatedText));
    if (mentionsDoseValue && !new RegExp(`\\b${escapeRegExp(dosageResult.medication)}\\b`, "i").test(validatedText)) {
      validatedText = `Medication: ${dosageResult.medication}\n${validatedText}`;
      warnings.push("Prepended missing drug name to dosage instructions.");
    }
  }

  // No invented numbers (mg, ml, teaspoons) not present in retrieved chunks
  const evidenceText = chunks.map((c) => c.text).join("\n").toLowerCase();
  const mgMlMatch = /\b(\d+(?:\.\d+)?)\s*(mg|ml|teaspoons?|sachets?)\b/gi;
  let match;
  let hasHallucinatedNumbers = false;
  while ((match = mgMlMatch.exec(validatedText)) !== null) {
    const numberStr = match[1];
    if (!evidenceText.includes(numberStr)) {
      if (dosageResult?.dose_mg?.toString() !== numberStr && 
          !(dosageResult?.dose_range_mg?.[0]?.toString() === numberStr || dosageResult?.dose_range_mg?.[1]?.toString() === numberStr)) {
        hasHallucinatedNumbers = true;
        break;
      }
    }
  }

  if (hasHallucinatedNumbers) {
    return {
      answer: "I found guidance, but not enough trusted detail here to give exact quantities safely. Please follow the cited guideline section or seek in-person care for exact preparation or dosing advice.",
      disposition: "INSUFFICIENT_EVIDENCE",
      warnings: ["Invented numbers detected and stripped."],
    };
  }

  // Check task/section consistency
  if (task && chunks.length > 0) {
    const allowedSections = sectionFilter(task);
    if (allowedSections.length > 0) {
      const hasMatchingSection = chunks.some(chunk => {
        const section = (chunk.metadata.section || "").toLowerCase();
        return allowedSections.some(allowed => section.includes(allowed));
      });
      if (!hasMatchingSection) {
        return {
          answer: `I could not find a safe ${task} guidance section in the retrieved evidence to answer this.`,
          disposition: "INSUFFICIENT_EVIDENCE",
          warnings: ["Answer rejected: retrieved chunk sections did not match the required task type."],
        };
      }
    }
  }

  return {
    answer: validatedText,
    disposition: "ANSWER",
    warnings,
  };
}

export function evaluateHighRiskProtocol(params: {
  query: string;
  candidates: string[];
  chunks: ChunkRecord[];
  facts: ExtractedPatientFacts;
  task: TaskType | null;
  audience: "community" | "clinician";
}): Pick<QueryResponse, "answer" | "disposition" | "warnings" | "treat_here" | "refer_urgency" | "what_to_ask_next" | "immediate_actions" | "answer_source"> | null {
  const { query, candidates, facts, task, audience } = params;
  const lowered = normalizeQueryText(query).toLowerCase();
  const candidatePool = mergeUnique([...candidates, facts.active_condition ?? null]).map((value) => value.toLowerCase());

  // ── Malaria protocol ─────────────────────────────────────────────────────────
  if (candidatePool.some((candidate) => candidate.includes("malaria"))) {
    const severeMalariaSigns = collectMatchedPhrases(lowered, [
      "convulsion", "seizure", "unconscious", "coma", "prostration",
      "jaundice", "severe anaemia", "severe anemia", "vomiting everything",
      "lethargic", "cannot drink", "very weak",
    ]);
    if (severeMalariaSigns.length > 0) {
      return {
        answer: audience === "community"
          ? "This could be severe malaria. Go to a health facility immediately for urgent treatment."
          : `Severe malaria features detected (${severeMalariaSigns.join(", ")}). Escalate immediately for parenteral artesunate or quinine. Give rectal artesunate if available while arranging transport.`,
        disposition: "EMERGENCY_ESCALATE",
        warnings: ["severe_malaria_protocol"],
        treat_here: false,
        refer_urgency: "immediate",
        immediate_actions: ["Do not give food or fluids by mouth if unconscious", "Give rectal artesunate if available", "Arrange immediate transport to hospital"],
      };
    }

    // Check if we have enough facts to make a treat-here/refer decision for uncomplicated malaria
    const canDrink = /\b(can drink|drinking|accepts fluid|breastfeeding)\b/.test(lowered);
    const cannotDrink = /\b(cannot drink|not drinking|refuses fluid|vomiting everything|vomiting all)\b/.test(lowered);
    const hasProstration = /\b(prostration|cannot sit|too weak to sit|floppy)\b/.test(lowered);
    const hasDangerSign = severeMalariaSigns.length > 0 || cannotDrink || hasProstration;

    if (!hasDangerSign && (isManagementStyleTask(task) || task === "referral" || task === "treatment")) {
      if (!canDrink && !cannotDrink) {
        return {
          answer: `Can the child drink or breastfeed? Are they too weak to sit up?\n\n${ASSESSMENT_GUIDE.ability_to_drink.how_to_check}\n\n${ASSESSMENT_GUIDE.prostration.how_to_check}`,
          disposition: "ASK_CLARIFY",
          warnings: ["malaria_protocol_needs_drinking_status"],
          treat_here: null,
          refer_urgency: null,
          what_to_ask_next: "Can the child drink? Are they too weak to sit up?",
        };
      }
      // Can drink, no danger signs → treat here
      return {
        answer: "No danger signs identified. The patient can likely be managed here with artemether-lumefantrine (ACT) — confirm weight for correct dose.\n\nRefer immediately if: convulsion, cannot drink, severe weakness, or fast breathing develops.",
        disposition: "ANSWER",
        warnings: [],
        treat_here: true,
        refer_urgency: null,
        what_to_ask_next: facts.weight_kg == null ? "What is the patient's weight in kg? This is needed for the correct ACT dose." : null,
        answer_source: "protocol",
      };
    }
  }

  // ── Pneumonia protocol ───────────────────────────────────────────────────────
  const pneumoniaContext = candidatePool.some((c) => c.includes("pneumonia") || c.includes("respiratory")) ||
    /\b(fast breathing|chest indrawing|difficulty breathing|breathless|respiratory distress)\b/.test(lowered);
  if (pneumoniaContext) {
    const hasChestIndrawing = /\b(chest indrawing|chest wall indrawing|indrawing|retracting)\b/.test(lowered);
    const hasCyanosis = /\b(cyanosis|blue lips|blue tongue|central cyanosis)\b/.test(lowered);
    const cannotDrinkPneumo = /\b(cannot drink|not drinking|refuses fluid)\b/.test(lowered);

    if (hasCyanosis || cannotDrinkPneumo) {
      return {
        answer: "Severe pneumonia with danger signs detected. Refer immediately — this patient needs oxygen and IV antibiotics.\n\nWhile arranging transport: keep the child upright, do not give food.",
        disposition: "EMERGENCY_ESCALATE",
        warnings: ["pneumonia_severe_protocol"],
        treat_here: false,
        refer_urgency: "immediate",
        immediate_actions: ["Keep child upright", "Do not give food", "Arrange immediate transport — oxygen needed"],
      };
    }
    if (hasChestIndrawing) {
      return {
        answer: "Chest indrawing is present — this is severe pneumonia. Refer now for hospital antibiotics and monitoring.\n\nWhile arranging transport: give first dose of amoxicillin if available.",
        disposition: "EMERGENCY_ESCALATE",
        warnings: ["pneumonia_chest_indrawing_protocol"],
        treat_here: false,
        refer_urgency: "immediate",
        immediate_actions: ["Give first dose of amoxicillin (oral) before transport", "Refer to hospital"],
      };
    }

    // Check if we have respiratory rate to make a treat-here/refer decision
    const hasRespRate = /\b(\d+)\s*(breaths?|breath|bpm|per min|per minute)\b/.test(lowered) ||
      /\b(fast breathing|normal breathing|breathing fast|breathing normal)\b/.test(lowered);
    const hasChestIndrawingNegative = /\b(no chest indrawing|no indrawing|no retraction|not indrawing)\b/.test(lowered);

    if (!hasRespRate && !hasChestIndrawingNegative && (isManagementStyleTask(task) || task === "severity" || task === "referral")) {
      return {
        answer: `To decide on treatment or referral, count the respiratory rate and check for chest indrawing.\n\n${ASSESSMENT_GUIDE.respiratory_rate.how_to_check}\n\n${ASSESSMENT_GUIDE.chest_indrawing.how_to_check}`,
        disposition: "ASK_CLARIFY",
        warnings: ["pneumonia_protocol_needs_resp_rate"],
        treat_here: null,
        refer_urgency: null,
        what_to_ask_next: "Count the breaths in one minute. Is the chest pulling in?",
      };
    }

    // Fast breathing only, no chest indrawing, can drink → treat here
    if (hasRespRate && (hasChestIndrawingNegative || !hasChestIndrawing)) {
      return {
        answer: "Fast breathing without chest indrawing — this fits non-severe pneumonia. Treat here with oral amoxicillin (40 mg/kg/day in 2 doses for 5 days).\n\nRefer immediately if: chest indrawing develops, patient cannot drink, or condition worsens.",
        disposition: "ANSWER",
        warnings: [],
        treat_here: true,
        refer_urgency: null,
        what_to_ask_next: facts.weight_kg == null ? "What is the patient's weight in kg for the amoxicillin dose?" : null,
        answer_source: "protocol",
      };
    }
  }

  // ── Sepsis protocol ──────────────────────────────────────────────────────────
  const sepsisContext = candidatePool.some((c) => c.includes("sepsis") || c.includes("severe infection")) ||
    (candidatePool.some((c) => c.includes("malaria") || c.includes("pneumonia") || c.includes("meningitis")) &&
      /\b(very weak|lethargic|cannot drink|unconscious|cold hands|fast pulse)\b/.test(lowered));

  if (sepsisContext) {
    const hasDangerSignSepsis = /\b(cannot drink|unconscious|lethargic|very weak|cold hands|mottled|fast pulse|seizure|convulsion)\b/.test(lowered);
    const isNeonate = facts.patient_age_group === "child" && /\b(newborn|neonate|0 month|1 month|1 week|2 week|3 week)\b/.test(lowered);

    if (isNeonate || (hasDangerSignSepsis && facts.patient_age_group === "child")) {
      return {
        answer: isNeonate
          ? "Neonatal sepsis suspected. This is an emergency — refer immediately. If available, give first dose of ampicillin + gentamicin before transport."
          : "Danger signs present — possible sepsis. Refer immediately. If available, give first dose of IM/IV antibiotic before transport.",
        disposition: "EMERGENCY_ESCALATE",
        warnings: ["sepsis_protocol"],
        treat_here: false,
        refer_urgency: "immediate",
        immediate_actions: [
          isNeonate ? "Give first dose of ampicillin + gentamicin if available" : "Give first dose of IM antibiotic if available",
          "Keep patient warm",
          "Arrange immediate transport",
        ],
      };
    }
    if (!hasDangerSignSepsis && (isManagementStyleTask(task) || task === "severity")) {
      return {
        answer: `To assess severity, check for danger signs.\n\n${ASSESSMENT_GUIDE.consciousness_avpu.how_to_check}\n\n${ASSESSMENT_GUIDE.ability_to_drink.how_to_check}\n\n${ASSESSMENT_GUIDE.pulse.how_to_check}`,
        disposition: "ASK_CLARIFY",
        warnings: ["sepsis_protocol_needs_danger_signs"],
        treat_here: null,
        refer_urgency: null,
        what_to_ask_next: "Is the child alert? Can they drink? Is the pulse fast or weak?",
      };
    }
  }

  // ── Dehydration protocol ─────────────────────────────────────────────────────
  const dehydrationContext =
    candidatePool.some((candidate) => candidate.includes("diarrhoea") || candidate.includes("dehydration") || candidate.includes("cholera")) ||
    /\b(diarrhoea|diarrhea|dehydration|ors|rehydration)\b/.test(lowered);
  if (dehydrationContext) {
    const dehydrationSeverity = classifyDehydrationSeverity(lowered, facts.symptoms ?? []);
    if (dehydrationSeverity === "severe") {
      return {
        answer: audience === "community"
          ? "The patient may have severe dehydration. If IV fluids are available, start urgent care and go to a health facility now."
          : "Severe dehydration pattern detected. Prioritize IV fluid pathway and urgent referral. ORS alone is not enough.",
        disposition: "EMERGENCY_ESCALATE",
        warnings: ["severe_dehydration_protocol"],
        treat_here: false,
        refer_urgency: "immediate",
        immediate_actions: ["Do not give ORS if the patient cannot drink", "IV fluids needed — refer now", "Keep patient warm"],
      };
    }
    if (dehydrationSeverity === "some") {
      return {
        answer: "Signs fit some dehydration. Start ORS Plan B: give 75 ml/kg over 4 hours by mouth.\n\nRefer immediately if: patient cannot drink, becomes lethargic, skin pinch becomes very slow, or condition worsens.",
        disposition: "ANSWER",
        warnings: ["some_dehydration_protocol"],
        treat_here: true,
        refer_urgency: null,
        what_to_ask_next: null,
        answer_source: "protocol",
      };
    }
    // No clear dehydration severity — ask the key questions
    if (isManagementStyleTask(task) || task === "severity" || task === "referral") {
      return {
        answer: `To classify dehydration, check the following:\n\n${ASSESSMENT_GUIDE.ability_to_drink.how_to_check}\n\n${ASSESSMENT_GUIDE.sunken_eyes.how_to_check}\n\n${ASSESSMENT_GUIDE.skin_turgor.how_to_check}`,
        disposition: "ASK_CLARIFY",
        warnings: ["dehydration_protocol_needs_signs"],
        treat_here: null,
        refer_urgency: null,
        what_to_ask_next: "Can the child drink? Are the eyes sunken? Does the skin stay pinched for more than 2 seconds?",
      };
    }
  }

  // ── Convulsion / altered consciousness protocol ──────────────────────────────
  const convulsionContext = /\b(convulsion|seizure|fits?|shaking|pikin dey shake)\b/.test(lowered);
  if (convulsionContext) {
    const activeConvulsion = /\b(currently|active|ongoing|now|still shaking|still fitting|not stopped)\b/.test(lowered);
    return {
      answer: activeConvulsion
        ? "Active convulsion — emergency. Protect airway: lay child on side, clear mouth. Give diazepam PR (rectal) 0.5 mg/kg if available. Refer immediately after first dose — do not delay transport."
        : "Post-convulsion — refer now for investigation and monitoring. Give rectal diazepam if fits recur during transport.",
      disposition: "EMERGENCY_ESCALATE",
      warnings: ["convulsion_protocol"],
      treat_here: false,
      refer_urgency: "immediate",
      immediate_actions: activeConvulsion
        ? ["Turn child on their side", "Clear mouth of secretions", "Give rectal diazepam 0.5 mg/kg if available", "Refer immediately"]
        : ["Monitor breathing", "Give rectal diazepam if fits recur", "Refer now"],
    };
  }

  // ── Anaemia / transfusion protocol ──────────────────────────────────────────
  if (/\b(transfusion|blood transfusion)\b/.test(lowered)) {
    const hb = extractNumericValue(lowered, /\b(?:hb|haemoglobin|hemoglobin)\s*(?:is|=|of)?\s*(\d+(?:\.\d+)?)\b/i);
    if (hb == null) {
      return {
        answer: `Guidance on blood transfusion requires the haemoglobin (Hb) level.\n\nWhile awaiting: check for danger signs of severe anaemia.\n\n${ASSESSMENT_GUIDE.pallor.how_to_check}\n\n${ASSESSMENT_GUIDE.pulse.how_to_check}`,
        disposition: "ASK_CLARIFY",
        warnings: ["transfusion_protocol_needs_hb"],
        treat_here: null,
        refer_urgency: null,
        what_to_ask_next: "What is the patient's haemoglobin (Hb) result? Is there severe pallor or a fast weak pulse?",
      };
    }
    const transfusionDangerSigns = /\b(shock|heart failure|respiratory distress|collapse|ongoing bleeding|unconscious)\b/.test(lowered);
    if (hb < 5 || (hb < 7 && transfusionDangerSigns)) {
      return {
        answer: `Hb ${hb} g/dL with${transfusionDangerSigns ? " danger signs" : " severe anaemia"} — refer now for transfusion. Do not delay.`,
        disposition: "EMERGENCY_ESCALATE",
        warnings: ["transfusion_indicated"],
        treat_here: false,
        refer_urgency: "immediate",
        immediate_actions: ["Refer immediately for transfusion", "Monitor airway and breathing"],
      };
    }
    if (hb >= 6 && !transfusionDangerSigns) {
      return {
        answer: `Hb ${hb} g/dL without danger signs does not yet meet the threshold for emergency transfusion. Investigate the cause, treat underlying condition (malaria, iron deficiency, worm infestation). Monitor closely and refer if condition worsens.`,
        disposition: "INSUFFICIENT_EVIDENCE",
        warnings: ["transfusion_protocol_threshold_not_met"],
        treat_here: null,
        refer_urgency: "routine",
      };
    }
  }

  // ── Oxygen protocol ──────────────────────────────────────────────────────────
  if (/\boxygen\b/.test(lowered) || /\bspo2\b|\bsaturation\b|\bsat\b/.test(lowered)) {
    const saturation = extractNumericValue(lowered, /\b(?:spo2|oxygen saturation|saturation|sat)\s*(?:is|=|of)?\s*(\d{2,3})\b/i);
    if (saturation == null) {
      return {
        answer: `To guide oxygen therapy, check the oxygen saturation (SpO2).\n\n${ASSESSMENT_GUIDE.spO2.how_to_check}`,
        disposition: "ASK_CLARIFY",
        warnings: ["oxygen_protocol_needs_saturation"],
        treat_here: null,
        refer_urgency: null,
        what_to_ask_next: "What is the patient's oxygen saturation (SpO2%)?",
      };
    }
    if (saturation < 90) {
      return {
        answer: `SpO2 ${saturation}% — below threshold. Start oxygen immediately at 1–2 L/min by nasal prongs. Refer urgently — hospital oxygen and monitoring needed.`,
        disposition: "EMERGENCY_ESCALATE",
        warnings: ["oxygen_indicated"],
        treat_here: false,
        refer_urgency: "immediate",
        immediate_actions: [`Start oxygen ${saturation < 85 ? "at 2 L/min" : "at 1–2 L/min"} by nasal prongs`, "Refer urgently"],
      };
    }
    if (saturation >= 92) {
      return {
        answer: `SpO2 ${saturation}% does not currently require supplemental oxygen. Continue monitoring and reassess if condition changes.`,
        disposition: "INSUFFICIENT_EVIDENCE",
        warnings: ["oxygen_protocol_threshold_not_met"],
        treat_here: null,
        refer_urgency: null,
      };
    }
    // 90–91%: borderline
    return {
      answer: `SpO2 ${saturation}% is borderline. Give oxygen at 1 L/min and reassess after 15 minutes. Refer if no improvement or if breathing worsens.`,
      disposition: "ANSWER",
      warnings: ["oxygen_borderline"],
      treat_here: true,
      refer_urgency: "soon",
      what_to_ask_next: null,
      answer_source: "protocol",
    };
  }

  return null;
}

function collectMatchedPhrases(text: string, phrases: string[]): string[] {
  return phrases.filter((phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(text));
}

function classifyDehydrationSeverity(text: string, symptoms: string[]): "none" | "some" | "severe" {
  const symptomText = `${text} ${symptoms.join(" ").toLowerCase()}`;
  const severeSigns = [
    "lethargic",
    "unconscious",
    "cannot drink",
    "not able to drink",
    "sunken eyes",
    "very slow skin pinch",
  ];
  if (collectMatchedPhrases(symptomText, severeSigns).length > 0) {
    return "severe";
  }
  const someSigns = [
    "restless",
    "irritable",
    "thirsty",
    "drinks eagerly",
    "sunken eyes",
    "slow skin pinch",
  ];
  return collectMatchedPhrases(symptomText, someSigns).length >= 2 ? "some" : "none";
}

function extractNumericValue(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Drug availability guardrails ──────────────────────────────────────────────
// PPMV-realistic stock: drugs a chemist or PPMV in Nigeria typically holds.
// Hospital-only drugs: require IV setup, refrigeration, or controlled status.

export const PPMV_AVAILABLE_DRUGS = new Set([
  "artemether-lumefantrine", "al", "coartem",
  "artesunate amodiaquine", "asaq",
  "amoxicillin",
  "cotrimoxazole", "septrin", "trimethoprim-sulfamethoxazole",
  "metronidazole", "flagyl",
  "paracetamol", "acetaminophen",
  "ibuprofen",
  "ors", "oral rehydration salts", "oral rehydration solution",
  "zinc",
  "vitamin a",
  "mebendazole", "albendazole",
  "chloroquine",
  "folic acid",
  "ferrous sulphate", "iron tablet",
  "oral diazepam",
]);

export const HOSPITAL_ONLY_DRUGS = new Set([
  "artesunate iv", "iv artesunate", "parenteral artesunate",
  "quinine iv", "iv quinine",
  "ampicillin iv", "iv ampicillin",
  "gentamicin iv", "iv gentamicin",
  "ceftriaxone", "iv ceftriaxone",
  "benzylpenicillin", "crystalline penicillin",
  "dextrose iv", "iv glucose", "iv fluids", "ringers lactate", "normal saline iv",
  "blood transfusion",
  "oxygen", // requires cylinders or concentrators
  "diazepam iv", "iv diazepam",
  "rectal artesunate", // borderline — included for flagging
]);

/**
 * Returns a warning string if the response text mentions a hospital-only drug
 * that is unlikely to be available at a PPMV or chemist.
 */
export function flagHospitalOnlyDrugs(text: string): string | null {
  const lowered = text.toLowerCase();
  for (const drug of HOSPITAL_ONLY_DRUGS) {
    if (lowered.includes(drug)) {
      return `⚠ Note: "${drug}" requires hospital/clinical setup and is not available at most chemists or PPMVs.`;
    }
  }
  return null;
}
