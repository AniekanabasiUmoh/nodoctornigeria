import type {
  ChunkRecord,
  ClinicalDecision,
  ExtractedPatientFacts,
  InterpretedQuery,
  LlmFailure,
  LlmResult,
  ReferUrgency,
  SessionTurn,
  TaskType,
  UnifiedClinicalOutput,
} from "./types.ts";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TIMEOUT_MS = 10_000;

export async function rewriteQueryWithGemini(
  apiKey: string,
  model: string,
  query: string,
  audience: "community" | "clinician",
): Promise<LlmResult<string>> {
  const prompt = [
    "You normalize medical search queries for a Nigerian treatment-guideline retrieval system.",
    "Correct obvious spelling mistakes, preserve drug names, symptoms, weights, ages, and treatment intent words.",
    "Do not add new facts. Output only one short normalized query.",
    `Audience: ${audience}`,
    `User query: ${query}`,
  ].join("\n");
  return await generateText(apiKey, model, "rewrite", prompt, { temperature: 0.1, maxOutputTokens: 80 });
}

export async function normalizeCommunityTriageWithGemini(
  apiKey: string,
  model: string,
  query: string,
): Promise<LlmResult<string>> {
  const prompt = [
    "You normalize free-text community health messages for a deterministic emergency triage system.",
    "Rewrite the user's words into short plain English using canonical medical danger-sign terms when clearly supported.",
    "Examples of useful canonical terms include convulsion, unconscious, cannot drink, difficulty breathing, heavy bleeding.",
    "Do not add symptoms that are not present. Do not explain. Output only one short normalized line.",
    `User query: ${query}`,
  ].join("\n");
  return await generateText(apiKey, model, "triage_normalization", prompt, { temperature: 0.0, maxOutputTokens: 60 });
}

export async function summarizeChunkWithGemini(
  apiKey: string,
  model: string,
  params: {
    query: string;
    audience: "community" | "clinician";
    chunk: ChunkRecord;
    dosageLine?: string | null;
  },
): Promise<LlmResult<string>> {
  const { query, audience, chunk, dosageLine } = params;
  const prompt = [
    "You are formatting an answer for a medical decision-support tool.",
    "Use only the supplied guideline evidence. Do not add facts that are not present.",
    "Write a concise summary in plain text using very short sentences.",
    "Make community answers easy for a non-clinician to understand.",
    "Do not use numbered lists, markdown tables, or invented warnings.",
    "Do not invent ORS recipes, sachet quantities, teaspoons, ml amounts, mg amounts, or mg/kg values unless those exact numbers are present in the evidence or deterministic dosage line.",
    "Prefer one fact per sentence so the system can convert the answer into bullet points.",
    "If the evidence is too weak, return exactly: INSUFFICIENT_EVIDENCE",
    `Audience: ${audience}`,
    `User query: ${query}`,
    `Condition: ${chunk.metadata.condition ?? chunk.metadata.document_title ?? "Unknown"}`,
    `Section: ${chunk.metadata.section ?? "Unknown"}`,
    `Subsection: ${chunk.metadata.subsection ?? "None"}`,
    `Deterministic dosage line: ${dosageLine ?? "None"}`,
    "",
    "Guideline evidence:",
    chunk.text,
  ].join("\n");

  const summary = await generateText(apiKey, model, "summary", prompt, { temperature: 0.2, maxOutputTokens: 220 });
  if (!summary.value || summary.value.trim() === "INSUFFICIENT_EVIDENCE") {
    return {
      value: null,
      failure: summary.failure ?? null,
    };
  }
  return {
    value: summary.value.trim(),
    failure: summary.failure ?? null,
  };
}

export async function interpretQueryWithGemini(
  apiKey: string,
  model: string,
  params: {
    query: string;
    audience: "community" | "clinician";
    recentTurns: SessionTurn[];
    accumulatedFacts: ExtractedPatientFacts;
  },
): Promise<LlmResult<InterpretedQuery>> {
  const { query, audience, recentTurns, accumulatedFacts } = params;

  const contextLines: string[] = [];
  for (const turn of recentTurns.slice(-2)) {
    contextLines.push(`U: ${turn.query}`);
    contextLines.push(`S: [${turn.disposition}] ${turn.answer_excerpt}`);
  }

  const factLines: string[] = [];
  if (accumulatedFacts.age_years != null) factLines.push(`age=${accumulatedFacts.age_years}`);
  if (accumulatedFacts.weight_kg != null) factLines.push(`weight=${accumulatedFacts.weight_kg}`);
  if (accumulatedFacts.symptoms?.length) factLines.push(`symptoms=${accumulatedFacts.symptoms.slice(0, 5).join(",")}`);
  if (accumulatedFacts.patient_age_group) factLines.push(`group=${accumulatedFacts.patient_age_group}`);
  if (accumulatedFacts.speaker_role) factLines.push(`speaker=${accumulatedFacts.speaker_role}`);
  if (accumulatedFacts.caregiver_relationship) factLines.push(`caregiver=${accumulatedFacts.caregiver_relationship}`);
  if (accumulatedFacts.last_clarification) factLines.push(`last_question=${accumulatedFacts.last_clarification}`);
  if (accumulatedFacts.active_condition) factLines.push(`active_condition=${accumulatedFacts.active_condition}`);
  if (accumulatedFacts.active_task) factLines.push(`active_task=${accumulatedFacts.active_task}`);

  const prompt = [
    "Extract patient facts from a medical message.",
    "Return JSON only.",
    "Use short symptom names in English.",
    "List up to 2 likely candidate_conditions using common disease names.",
    "Treat short replies as follow-up context when prior context exists.",
    "Ask one clarification question only if a key missing fact blocks progress.",
    contextLines.length > 0 ? `History:\n${contextLines.join("\n")}` : "History: none",
    factLines.length > 0 ? `Known:\n${factLines.join("\n")}` : "Known: none",
    `Audience: ${audience}`,
    `Query: ${query}`,
    "JSON schema:",
    '{"age_years":null,"weight_kg":null,"symptoms":[],"candidate_conditions":[],"onset_days":null,"raw_summary":"","patient_age_group":null,"speaker_role":null,"caregiver_relationship":null,"last_suspected_differential":[],"confidence":"low","clarification_needed":null}',
  ].join("\n");

  const raw = await generateText(apiKey, model, "interpret", prompt, { temperature: 0.0, maxOutputTokens: 180 });
  if (!raw.value) {
    return { value: null, failure: raw.failure ?? null };
  }
  const parsed = parseInterpretedQuery(raw.value);
  if (!parsed) {
    return { value: null, failure: invalidJsonFailure("interpret") };
  }
  return { value: parsed, failure: raw.failure ?? null };
}

export async function reasonWithGemini(
  apiKey: string,
  model: string,
  params: {
    snapshot: ExtractedPatientFacts & { age_years?: number | null; symptoms?: string[]; severity_cues?: string[] };
    recentTurns: SessionTurn[];
    evidencePerCandidate: Map<string, ChunkRecord[]>;
    audience: "community" | "clinician";
    currentQuery: string;
  },
): Promise<LlmResult<ClinicalDecision>> {
  const { snapshot, recentTurns, evidencePerCandidate, audience, currentQuery } = params;

  // Build patient picture
  const patientLines: string[] = [];
  if (snapshot.age_years != null) patientLines.push(`Age: ${snapshot.age_years} years`);
  if (snapshot.weight_kg != null) patientLines.push(`Weight: ${snapshot.weight_kg} kg`);
  if (snapshot.symptoms?.length) patientLines.push(`Symptoms: ${snapshot.symptoms.join(", ")}`);
  if (snapshot.patient_age_group) patientLines.push(`Patient age group: ${snapshot.patient_age_group}`);
  if (snapshot.speaker_role) patientLines.push(`Speaker role: ${snapshot.speaker_role}`);
  if (snapshot.caregiver_relationship) patientLines.push(`Caregiver relationship: ${snapshot.caregiver_relationship}`);
  if (snapshot.last_clarification) patientLines.push(`Last clarification asked: ${snapshot.last_clarification}`);
  if ((snapshot as Record<string, unknown>).severity_cues) {
    const cues = (snapshot as Record<string, unknown>).severity_cues as string[];
    if (cues?.length) patientLines.push(`Severity cues: ${cues.join(", ")}`);
  }
  if (snapshot.onset_days != null) patientLines.push(`Onset: ${snapshot.onset_days} days`);
  if (snapshot.candidate_conditions?.length) {
    patientLines.push(`Prior candidates: ${snapshot.candidate_conditions.join(", ")}`);
  }

  // Build conversation context
  const contextLines: string[] = [];
  for (const turn of recentTurns.slice(-2)) {
    contextLines.push(`U: ${turn.query}`);
    contextLines.push(`S: [${turn.disposition}] ${turn.answer_excerpt}`);
  }

  // Build evidence blocks — one per candidate
  const evidenceLines: string[] = [];
  for (const [condition, chunks] of [...evidencePerCandidate.entries()].slice(0, 2)) {
    evidenceLines.push(`Condition: ${condition}`);
    if (chunks.length === 0) {
      evidenceLines.push("Evidence: none");
    } else {
      const top = chunks[0];
      evidenceLines.push(`Section: ${top.metadata.section ?? "Unknown"}${top.metadata.subsection ? ` > ${top.metadata.subsection}` : ""}`);
      evidenceLines.push(`Evidence: ${top.text.slice(0, 320)}`);
    }
  }

  const prompt = [
    "You are a clinical decision-support system for Nigerian frontline health workers (chemists, PPMVs, CHWs, nurses).",
    "You receive a patient picture, conversation history, and retrieved NSTG guideline evidence.",
    "Your job is to reason clinically and return a structured JSON decision in the frontline answer format.",
    "",
    "RULES:",
    "1. Output ONLY a JSON object. No prose, no markdown fences.",
    "2. You MUST assess whether the retrieved evidence actually fits the patient symptoms.",
    "3. If evidence fits one condition well: set disposition to ANSWER and populate all frontline fields.",
    "4. If two conditions are equally plausible: set disposition to ASK_CLARIFY, set clarifying_question to ONE differentiating clinical question, leave what_to_do_now null.",
    "5. If no evidence fits the symptoms: set disposition to INSUFFICIENT_EVIDENCE.",
    "6. If the current query is a follow-up challenge to a prior answer (e.g. 'are you sure?', 'is it really X?'), address it using the prior candidates — do NOT restart as if it is a new query.",
    "6b. If the current query asks about IV treatment, transfusion, severity criteria, investigations, or monitoring, keep the prior syndrome or candidate condition on-thread unless the new evidence clearly contradicts it.",
    "7. Never output treatment for a condition whose evidence does not match the patient's symptoms.",
    "8. response_text must be plain text, no markdown. Max 700 characters. It is the full formatted answer assembled from the structured fields.",
    `9. Audience is ${audience}. ${audience === "clinician" ? "Include a dose ONLY when the retrieved evidence or deterministic dosage line clearly provides it. If no explicit formula is present, set dose_line to null." : "Use plain language, avoid drug doses, set dose_line to null."}`,
    "10. EMERGENCY RULE: If the patient picture contains any danger signs — fast or laboured breathing, convulsions, unconsciousness, inability to drink or feed, severe weakness, heavy bleeding — set disposition to EMERGENCY_ESCALATE. Set treat_here to false. Do not populate what_to_do_now for emergencies.",
    "11. Never invent ORS recipes, sachet quantities, teaspoons, ml amounts, mg amounts, or mg/kg values unless those exact numbers appear in the retrieved evidence or deterministic dosage line.",
    "12. For ANSWER responses: treat_here must be true or false (never null). refer_if must list the red flag criteria. what_to_do_now must be an array of 2-4 plain-language steps.",
    "",
    patientLines.length > 0 ? `PATIENT:\n${patientLines.join("\n")}` : "PATIENT: Unknown",
    "",
    contextLines.length > 0 ? contextLines.join("\n") : "CONVERSATION HISTORY: none",
    "",
    `CURRENT QUERY: ${currentQuery}`,
    "",
    "RETRIEVED NSTG EVIDENCE:",
    evidenceLines.join("\n"),
    "",
    "OUTPUT (JSON only):",
    '{"disposition":"ANSWER","leading_condition":null,"also_considered":[],"reasoning":"","response_text":"","clarifying_question":null,"treat_here":null,"what_to_do_now":null,"ask_or_check":null,"refer_if":null,"dose_line":null}',
  ].join("\n");

  const raw = await generateText(apiKey, model, "reason", prompt, { temperature: 0.0, maxOutputTokens: 320 });
  if (!raw.value) {
    return { value: null, failure: raw.failure ?? null };
  }
  const parsed = parseClinicalDecision(raw.value);
  if (!parsed) {
    return { value: null, failure: invalidJsonFailure("reason") };
  }
  return { value: parsed, failure: raw.failure ?? null };
}

export async function unifyFrontlineWithGroq(
  apiKey: string,
  model: string,
  params: {
    query: string;
    audience: "community" | "clinician";
    recentTurns: SessionTurn[];
    accumulatedFacts: ExtractedPatientFacts;
    retrievedChunks: ChunkRecord[];
  },
): Promise<LlmResult<UnifiedClinicalOutput>> {
  const { query, audience, recentTurns, accumulatedFacts, retrievedChunks } = params;

  const contextLines: string[] = [];
  for (const turn of recentTurns.slice(-3)) {
    contextLines.push(`U: ${turn.query}`);
    contextLines.push(`S: [${turn.disposition}] ${turn.answer_excerpt}`);
  }

  const factLines: string[] = [];
  if (accumulatedFacts.age_years != null) factLines.push(`age_years=${accumulatedFacts.age_years}`);
  if (accumulatedFacts.weight_kg != null) factLines.push(`weight_kg=${accumulatedFacts.weight_kg}`);
  if (accumulatedFacts.symptoms?.length) factLines.push(`symptoms=${accumulatedFacts.symptoms.join(", ")}`);
  if (accumulatedFacts.candidate_conditions?.length) factLines.push(`prior_candidates=${accumulatedFacts.candidate_conditions.join(", ")}`);
  if (accumulatedFacts.patient_age_group) factLines.push(`patient_age_group=${accumulatedFacts.patient_age_group}`);
  if (accumulatedFacts.speaker_role) factLines.push(`speaker_role=${accumulatedFacts.speaker_role}`);
  if (accumulatedFacts.caregiver_relationship) factLines.push(`caregiver_relationship=${accumulatedFacts.caregiver_relationship}`);
  if (accumulatedFacts.last_clarification) factLines.push(`last_clarification=${accumulatedFacts.last_clarification}`);

  const evidenceLines = retrievedChunks.slice(0, 6).flatMap((chunk, index) => ([
    `Chunk ${index + 1}: ${chunk.metadata.condition ?? chunk.metadata.document_title ?? "Unknown condition"}`,
    `Section: ${chunk.metadata.section ?? "Unknown"}${chunk.metadata.subsection ? ` > ${chunk.metadata.subsection}` : ""}`,
    `Evidence: ${chunk.text.slice(0, 420)}`,
  ]));

  const prompt = [
    "You are a frontline clinical decision-support system grounded in the Nigerian Standard Treatment Guidelines (NSTG).",
    "Return JSON only.",
    "You own triage, interpretation, candidate condition selection, reasoning, and the frontline answer.",
    "If there is ANY doubt about a danger sign, escalate immediately.",
    "Better to over-refer than miss a dangerous case.",
    "Use only the supplied query, prior context, known facts, and retrieved NSTG evidence.",
    "Do not invent conditions that are not reasonably supported by the evidence or symptoms.",
    "Every response must include a practical frontline answer.",
    `Audience: ${audience}`,
    audience === "community"
      ? "Use plain language. Avoid drug dosing unless the retrieved evidence clearly states it. When the patient needs hospital-only interventions (oxygen, IV fluids, blood), ask about local access and emphasize referral, do not tell them to start treatments they cannot do."
      : "Use clinician-facing wording, but still stay grounded strictly in the retrieved evidence.",
    "",
    "Rules:",
    "1. triage_disposition must be one of NON_EMERGENCY_CONTINUE, EMERGENCY_ESCALATE, UNCERTAIN_ESCALATE.",
    "2. If danger signs are present or plausibly present, set triage_disposition to EMERGENCY_ESCALATE or UNCERTAIN_ESCALATE.",
    "3. If disposition is EMERGENCY_ESCALATE, set treat_here to false and refer_urgency to immediate.",
    "4. ASK_CLARIFY is appropriate when one specific piece of information (weight, Hb, SpO2, etc.) would change your next clinical decision.",
    "5. Use ASK_CLARIFY liberally: doctors need complete information before deciding treat-here vs. refer. Better to ask than to guess.",
    "6. If disposition is ASK_CLARIFY, populate ask_or_check with one specific, actionable question.",
    "7. Only use INSUFFICIENT_EVIDENCE if the query is outside NSTG scope or truly cannot be answered with clarifying questions.",
    "8. Village-unavailable tests (Hb, blood culture, imaging, etc.) are NOT reasons to ask for clarification. Instead, give ANSWER based on clinical signs and append caveat: 'it's okay if you don't have [test name]'.",
    "9. what_to_do_now must contain 2-5 short steps for ANSWER or EMERGENCY_ESCALATE responses.",
    "10. immediate_actions may overlap with what_to_do_now, but should focus on urgent first actions only.",
    "11. answer must be plain text only. No markdown tables. Keep it concise and actionable.",
    "",
    contextLines.length ? `Recent turns:\n${contextLines.join("\n")}` : "Recent turns: none",
    factLines.length ? `Known facts:\n${factLines.join("\n")}` : "Known facts: none",
    `Current query: ${query}`,
    "",
    "Retrieved NSTG evidence:",
    evidenceLines.length ? evidenceLines.join("\n") : "No retrieved evidence.",
    "",
    "JSON schema:",
    '{"disposition":"ANSWER","triage_disposition":"NON_EMERGENCY_CONTINUE","danger_signs_detected":[],"interpreted_facts":{"age_years":null,"weight_kg":null,"symptoms":[],"candidate_conditions":[],"onset_days":null,"raw_summary":"","patient_age_group":null,"speaker_role":null,"caregiver_relationship":null,"last_clarification":null,"last_suspected_differential":[],"active_condition":null,"active_task":null,"management_thread":false},"candidate_conditions":[],"reasoning":"","answer":"","treat_here":null,"refer_urgency":null,"what_to_do_now":[],"immediate_actions":[],"ask_or_check":null}',
  ].join("\n");

  const raw = await generateText(apiKey, model, "unified", prompt, { temperature: 0.0, maxOutputTokens: 700 });
  if (!raw.value) {
    return { value: null, failure: raw.failure ?? null };
  }
  const parsed = parseUnifiedClinicalOutput(raw.value);
  if (!parsed) {
    return { value: null, failure: invalidJsonFailure("unified") };
  }
  return { value: parsed, failure: raw.failure ?? null };
}

function parseClinicalDecision(raw: string): ClinicalDecision | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const validDispositions = ["ANSWER", "ASK_CLARIFY", "INSUFFICIENT_EVIDENCE", "EMERGENCY_ESCALATE"];
    const disposition = validDispositions.includes(parsed.disposition) ? parsed.disposition : "INSUFFICIENT_EVIDENCE";
    return {
      disposition,
      leading_condition: typeof parsed.leading_condition === "string" ? parsed.leading_condition : null,
      also_considered: Array.isArray(parsed.also_considered)
        ? parsed.also_considered.filter((c: unknown) => typeof c === "string")
        : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      response_text: typeof parsed.response_text === "string" ? parsed.response_text : "",
      clarifying_question: typeof parsed.clarifying_question === "string" && parsed.clarifying_question
        ? parsed.clarifying_question
        : null,
      treat_here: typeof parsed.treat_here === "boolean" ? parsed.treat_here : null,
      what_to_do_now: Array.isArray(parsed.what_to_do_now)
        ? parsed.what_to_do_now.filter((s: unknown) => typeof s === "string")
        : null,
      ask_or_check: typeof parsed.ask_or_check === "string" && parsed.ask_or_check ? parsed.ask_or_check : null,
      refer_if: typeof parsed.refer_if === "string" && parsed.refer_if ? parsed.refer_if : null,
      dose_line: typeof parsed.dose_line === "string" && parsed.dose_line ? parsed.dose_line : null,
    };
  } catch {
    return null;
  }
}

function parseUnifiedClinicalOutput(raw: string): UnifiedClinicalOutput | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const validDispositions = ["ANSWER", "ASK_CLARIFY", "INSUFFICIENT_EVIDENCE", "EMERGENCY_ESCALATE"];
    const validTriage = ["NON_EMERGENCY_CONTINUE", "EMERGENCY_ESCALATE", "UNCERTAIN_ESCALATE"];
    const interpreted = typeof parsed.interpreted_facts === "object" && parsed.interpreted_facts
      ? parsed.interpreted_facts as Record<string, unknown>
      : {};
    const referUrgency = [null, "immediate", "soon", "routine"].includes(parsed.refer_urgency)
      ? parsed.refer_urgency as ReferUrgency
      : null;

    return {
      disposition: validDispositions.includes(parsed.disposition) ? parsed.disposition : "INSUFFICIENT_EVIDENCE",
      triage_disposition: validTriage.includes(parsed.triage_disposition) ? parsed.triage_disposition : "NON_EMERGENCY_CONTINUE",
      danger_signs_detected: Array.isArray(parsed.danger_signs_detected)
        ? parsed.danger_signs_detected.filter((value: unknown) => typeof value === "string")
        : [],
      interpreted_facts: {
        age_years: typeof interpreted.age_years === "number" ? interpreted.age_years : null,
        weight_kg: typeof interpreted.weight_kg === "number" ? interpreted.weight_kg : null,
        symptoms: Array.isArray(interpreted.symptoms) ? interpreted.symptoms.filter((value: unknown) => typeof value === "string") : [],
        candidate_conditions: Array.isArray(interpreted.candidate_conditions)
          ? interpreted.candidate_conditions.filter((value: unknown) => typeof value === "string").slice(0, 4)
          : [],
        onset_days: typeof interpreted.onset_days === "number" ? interpreted.onset_days : null,
        raw_summary: typeof interpreted.raw_summary === "string" ? interpreted.raw_summary : null,
        patient_age_group: interpreted.patient_age_group === "child" || interpreted.patient_age_group === "adult"
          ? interpreted.patient_age_group
          : null,
        speaker_role: interpreted.speaker_role === "self" || interpreted.speaker_role === "caregiver" || interpreted.speaker_role === "clinician"
          ? interpreted.speaker_role
          : null,
        caregiver_relationship: typeof interpreted.caregiver_relationship === "string" ? interpreted.caregiver_relationship : null,
        last_clarification: typeof interpreted.last_clarification === "string" ? interpreted.last_clarification : null,
        last_suspected_differential: Array.isArray(interpreted.last_suspected_differential)
          ? interpreted.last_suspected_differential.filter((value: unknown) => typeof value === "string").slice(0, 4)
          : [],
        active_condition: typeof interpreted.active_condition === "string" ? interpreted.active_condition : null,
        active_task: isTaskType(interpreted.active_task) ? interpreted.active_task : null,
        management_thread: typeof interpreted.management_thread === "boolean" ? interpreted.management_thread : false,
      },
      candidate_conditions: Array.isArray(parsed.candidate_conditions)
        ? parsed.candidate_conditions.filter((value: unknown) => typeof value === "string").slice(0, 4)
        : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      answer: typeof parsed.answer === "string" ? parsed.answer : "",
      treat_here: typeof parsed.treat_here === "boolean" ? parsed.treat_here : null,
      refer_urgency: referUrgency,
      what_to_do_now: Array.isArray(parsed.what_to_do_now)
        ? parsed.what_to_do_now.filter((value: unknown) => typeof value === "string")
        : null,
      immediate_actions: Array.isArray(parsed.immediate_actions)
        ? parsed.immediate_actions.filter((value: unknown) => typeof value === "string")
        : null,
      ask_or_check: typeof parsed.ask_or_check === "string" && parsed.ask_or_check ? parsed.ask_or_check : null,
    };
  } catch {
    return null;
  }
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && [
    "diagnosis",
    "severity",
    "treatment",
    "dose",
    "referral",
    "investigation",
    "follow_up",
    "management_protocol",
  ].includes(value);
}

function parseInterpretedQuery(raw: string): InterpretedQuery | null {
  // Strip accidental markdown fences Gemini sometimes emits
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.candidate_conditions) || !Array.isArray(parsed.symptoms)) {
      return null;
    }
    return {
      age_years: typeof parsed.age_years === "number" ? parsed.age_years : null,
      weight_kg: typeof parsed.weight_kg === "number" ? parsed.weight_kg : null,
      symptoms: parsed.symptoms.filter((s: unknown) => typeof s === "string"),
      candidate_conditions: parsed.candidate_conditions
        .filter((c: unknown) => typeof c === "string")
        .slice(0, 3),
      onset_days: typeof parsed.onset_days === "number" ? parsed.onset_days : null,
      raw_summary: typeof parsed.raw_summary === "string" ? parsed.raw_summary : "",
      patient_age_group: parsed.patient_age_group === "child" || parsed.patient_age_group === "adult"
        ? parsed.patient_age_group
        : null,
      speaker_role: parsed.speaker_role === "self" || parsed.speaker_role === "caregiver" || parsed.speaker_role === "clinician"
        ? parsed.speaker_role
        : null,
      caregiver_relationship: typeof parsed.caregiver_relationship === "string" && parsed.caregiver_relationship
        ? parsed.caregiver_relationship
        : null,
      last_clarification: typeof parsed.last_clarification === "string" && parsed.last_clarification
        ? parsed.last_clarification
        : null,
      last_suspected_differential: Array.isArray(parsed.last_suspected_differential)
        ? parsed.last_suspected_differential.filter((c: unknown) => typeof c === "string").slice(0, 3)
        : [],
      confidence: ["high", "medium", "low"].includes(parsed.confidence)
        ? parsed.confidence as "high" | "medium" | "low"
        : "low",
      clarification_needed: typeof parsed.clarification_needed === "string" && parsed.clarification_needed
        ? parsed.clarification_needed
        : null,
    };
  } catch {
    return null;
  }
}

export async function classifyTaskWithGroq(
  apiKey: string,
  model: string,
  query: string,
  facts: ExtractedPatientFacts
): Promise<LlmResult<TaskType>> {
  const prompt = [
    "Classify the medical request.",
    "Return exactly one word from:",
    "diagnosis|severity|treatment|dose|referral|investigation|follow_up|management_protocol",
    `Query: ${query}`,
    `Known facts: ${JSON.stringify({
      active_condition: facts.active_condition ?? null,
      active_task: facts.active_task ?? null,
      symptoms: facts.symptoms?.slice(0, 5) ?? [],
      management_thread: facts.management_thread ?? false,
    })}`,
  ].join("\n");

  const result = await generateText(apiKey, model, "classify", prompt, { temperature: 0.0, maxOutputTokens: 12 });
  const raw = (result.value || "").trim().toLowerCase();
  
  const validTasks: TaskType[] = [
    "diagnosis", "severity", "treatment", "dose", 
    "referral", "investigation", "follow_up", "management_protocol"
  ];

  if (validTasks.includes(raw as TaskType)) {
    return {
      value: raw as TaskType,
      failure: result.failure ?? null,
    };
  }
  
  return {
    value: fallbackTaskType(facts),
    failure: result.failure ?? (raw ? invalidJsonFailure("classify") : null),
  };
}

async function generateText(
  apiKey: string,
  model: string,
  stage: LlmFailure["stage"],
  prompt: string,
  config: { temperature: number; maxOutputTokens: number },
): Promise<LlmResult<string>> {
  if (!apiKey) {
    return {
      value: null,
      failure: {
        stage,
        reason: "missing_api_key",
        detail: "No API key was configured for the Groq request.",
      },
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GROQ_TIMEOUT_MS);
  try {
    const response = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
      }),
    });
    if (!response.ok) {
      return {
        value: null,
        failure: {
          stage,
          reason: "http_error",
          status_code: response.status,
          detail: `Groq returned HTTP ${response.status}.`,
        },
      };
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return {
        value: null,
        failure: {
          stage,
          reason: "empty_response",
          detail: "Groq returned an empty completion.",
        },
      };
    }
    return {
      value: content.trim(),
      failure: null,
    };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return {
      value: null,
      failure: {
        stage,
        reason: timedOut ? "timeout" : "network_error",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackTaskType(facts: ExtractedPatientFacts): TaskType {
  if (facts.management_thread || facts.active_task === "treatment" || facts.active_task === "dose") {
    return facts.active_task ?? "treatment";
  }
  return "diagnosis";
}

function invalidJsonFailure(stage: LlmFailure["stage"]): LlmFailure {
  return {
    stage,
    reason: "invalid_json",
    detail: "Groq returned output that could not be parsed safely.",
  };
}
