import re

with open("supabase/functions/_shared/service.ts", "r", encoding="utf-8") as f:
    content = f.read()

# 1. answerCommunity - Structured Interpretation block
community_interpret_old = """  // ── 3. Structured interpretation ──────────────────────────────────────────
  const gemini = getGroqConfig();
  let interpreted: InterpretedQuery | null = null;
  if (gemini.enabled && gemini.apiKey) {
    interpreted = await interpretQueryWithGemini(gemini.apiKey, gemini.model, {
      query: interpretationQuery,
      audience: "community",
      recentTurns: memory?.recent_turns ?? [],
      accumulatedFacts: memory?.facts ?? {},
    });
  }
  const candidates = resolveCandidateConditions(interpreted, memory);
  const symptoms = resolveSymptoms(interpreted, memory);"""

community_interpret_new = """  // ── 3. Structured interpretation ──────────────────────────────────────────
  const gemini = getGroqConfig();
  let interpreted: InterpretedQuery | null = null;
  let task: TaskType | null = null;
  if (gemini.enabled && gemini.apiKey) {
    interpreted = await interpretQueryWithGemini(gemini.apiKey, gemini.model, {
      query: interpretationQuery,
      audience: "community",
      recentTurns: memory?.recent_turns ?? [],
      accumulatedFacts: memory?.facts ?? {},
    });
  }
  const candidates = resolveCandidateConditions(interpreted, memory);
  const symptoms = resolveSymptoms(interpreted, memory);
  if (gemini.enabled && gemini.apiKey) {
    task = await classifyTaskWithGroq(
      gemini.apiKey,
      gemini.model,
      query,
      buildFactsUpdate({
        query,
        audience: "community",
        interpreted,
        memory,
        candidateConditions: candidates,
        symptoms,
      })
    );
  }"""
content = content.replace(community_interpret_old, community_interpret_new)

# 2. answerCommunity - Retrieval block
community_retrieval_old = """  // ── 5. Retrieval per candidate ────────────────────────────────────────────
  const evidencePerCandidate = await searchPerCandidate(supabase, candidates, query, topK, symptoms);
  const allChunks = [...evidencePerCandidate.values()].flat();"""

community_retrieval_new = """  // ── 5. Retrieval per candidate ────────────────────────────────────────────
  const evidencePerCandidate = await searchPerCandidate(supabase, candidates, query, topK, symptoms, task);
  const allChunks = [...evidencePerCandidate.values()].flat();

  // ── 5.5 High-risk protocol and Answerability Gates ─────────────────────────
  const highRiskResponse = evaluateHighRiskProtocol(query, candidates, allChunks);
  if (highRiskResponse) {
    if (sessionId) {
      await saveSessionMemory(supabase, sessionId, "community",
        { query, disposition: highRiskResponse.disposition, answer_excerpt: highRiskResponse.answer.slice(0, 200), candidate_conditions: candidates },
        buildFactsUpdate({
          query,
          audience: "community",
          interpreted,
          memory,
          candidateConditions: candidates,
          symptoms,
          lastClarification: highRiskResponse.disposition === "ASK_CLARIFY" ? highRiskResponse.answer : null,
        }),
        memory,
      );
    }
    return {
      ...highRiskResponse,
      triage: highRiskResponse.disposition === "EMERGENCY_ESCALATE" ? "EMERGENCY_ESCALATE" : triage.disposition,
      citations: toCitations(allChunks),
      follow_up_question: highRiskResponse.disposition === "ASK_CLARIFY" ? highRiskResponse.answer : undefined,
    };
  }

  const answerability = checkAnswerability(task, candidates, allChunks, null, query);
  if (answerability) {
    if (sessionId) {
      await saveSessionMemory(supabase, sessionId, "community",
        { query, disposition: answerability.disposition, answer_excerpt: answerability.answer.slice(0, 200), candidate_conditions: candidates },
        buildFactsUpdate({
          query,
          audience: "community",
          interpreted,
          memory,
          candidateConditions: candidates,
          symptoms,
          lastClarification: answerability.disposition === "ASK_CLARIFY" ? answerability.answer : null,
        }),
        memory,
      );
    }
    return {
      ...answerability,
      triage: triage.disposition,
      citations: [],
      follow_up_question: answerability.disposition === "ASK_CLARIFY" ? answerability.answer : undefined,
    };
  }"""
content = content.replace(community_retrieval_old, community_retrieval_new)

# 3. answerCommunity - Validation
community_validation_old = """  if (decision.disposition === "ANSWER") {
    decision = {
      ...decision,
      response_text: stripUnsafeTreatmentText(decision.response_text, {
        evidenceChunks: allChunks,
        dosage: null,
        audience: "community",
      }),
    };
  }"""

community_validation_new = """  let warningsList: string[] = [];
  if (decision.disposition === "ANSWER") {
    decision = {
      ...decision,
      response_text: stripUnsafeTreatmentText(decision.response_text, {
        evidenceChunks: allChunks,
        dosage: null,
        audience: "community",
      }),
    };
    const patientAgeGroup = inferPatientContext(query, "community", interpreted?.age_years ?? memory?.facts?.age_years ?? null, memory?.facts ?? {}).patient_age_group;
    const validated = validateResponse(decision.response_text, task, allChunks, null, patientAgeGroup);
    if (validated) {
      decision.response_text = validated.answer;
      if (validated.disposition !== "ANSWER") {
        decision.disposition = validated.disposition;
      }
      warningsList = validated.warnings ?? [];
    }
  }"""
content = content.replace(community_validation_old, community_validation_new)

community_return_old = """  return {
    answer: decision.response_text,
    disposition: decision.disposition,
    follow_up_question: decision.clarifying_question ?? undefined,
    triage: triage.disposition,
    citations: toCitations(allChunks),
    warnings: [],
  };"""

community_return_new = """  return {
    answer: decision.response_text,
    disposition: decision.disposition,
    follow_up_question: decision.clarifying_question ?? undefined,
    triage: triage.disposition,
    citations: toCitations(allChunks),
    warnings: warningsList,
  };"""
content = content.replace(community_return_old, community_return_new)


# 4. answerClinician - Structured Interpretation block
clinician_interpret_old = """  // ── 2. Structured interpretation ──────────────────────────────────────────
  const gemini = getGroqConfig();
  let interpreted: InterpretedQuery | null = null;
  if (gemini.enabled && gemini.apiKey) {
    interpreted = await interpretQueryWithGemini(gemini.apiKey, gemini.model, {
      query: interpretationQuery,
      audience: "clinician",
      recentTurns: memory?.recent_turns ?? [],
      accumulatedFacts: memory?.facts ?? {},
    });
  }

  // ── 3. Dosage weight clarification (uses interpreted + memory weight) ──────
  const candidates = resolveCandidateConditions(interpreted, memory);
  const symptoms = resolveSymptoms(interpreted, memory);"""

clinician_interpret_new = """  // ── 2. Structured interpretation ──────────────────────────────────────────
  const gemini = getGroqConfig();
  let interpreted: InterpretedQuery | null = null;
  let task: TaskType | null = null;
  if (gemini.enabled && gemini.apiKey) {
    interpreted = await interpretQueryWithGemini(gemini.apiKey, gemini.model, {
      query: interpretationQuery,
      audience: "clinician",
      recentTurns: memory?.recent_turns ?? [],
      accumulatedFacts: memory?.facts ?? {},
    });
  }

  // ── 3. Dosage weight clarification (uses interpreted + memory weight) ──────
  const candidates = resolveCandidateConditions(interpreted, memory);
  const symptoms = resolveSymptoms(interpreted, memory);
  if (gemini.enabled && gemini.apiKey) {
    task = await classifyTaskWithGroq(
      gemini.apiKey,
      gemini.model,
      query,
      buildFactsUpdate({
        query,
        audience: "clinician",
        interpreted,
        memory,
        candidateConditions: candidates,
        symptoms,
      })
    );
  }"""
content = content.replace(clinician_interpret_old, clinician_interpret_new)

# 5. answerClinician - Retrieval block
clinician_retrieval_old = """  // ── 4. Retrieval per candidate ────────────────────────────────────────────
  const evidencePerCandidate = await searchPerCandidate(supabase, candidates, query, topK, symptoms);
  const allChunks = [...evidencePerCandidate.values()].flat();"""

clinician_retrieval_new = """  // ── 4. Retrieval per candidate ────────────────────────────────────────────
  const evidencePerCandidate = await searchPerCandidate(supabase, candidates, query, topK, symptoms, task);
  const allChunks = [...evidencePerCandidate.values()].flat();"""
content = content.replace(clinician_retrieval_old, clinician_retrieval_new)

# 6. answerClinician - Dosage and Answerability Gate
clinician_dose_old = """  // ── 5. Deterministic dosage (runs regardless, appended if available) ───────
  const retrievalTerms = buildRetrievalTerms(interpreted, query);
  const rankedChunks = rerankChunksForQuery(retrievalTerms, allChunks);
  const augmentedQuery = effectiveWeightKg != null && !queryLower.includes("kg")
    ? `${query} ${effectiveWeightKg}kg`
    : query;
  const doseQuery = isDoseRequest(query);
  const dosage = calculateDosage(augmentedQuery, rankedChunks);
  const warnings: string[] = [];
  let dosageInstruction: string | null = null;
  if (dosage) {
    if (dosage.dose_range_mg) {
      dosageInstruction = `Give ${dosage.dose_range_mg[0]}-${dosage.dose_range_mg[1]} mg for ${dosage.weight_kg} kg.`;
    } else if (typeof dosage.dose_mg === "number") {
      dosageInstruction = `Give ${dosage.dose_mg} mg for ${dosage.weight_kg} kg.`;
    } else if (dosage.note) {
      warnings.push(dosage.note);
    }
  }"""

clinician_dose_new = """  // ── 5. Deterministic dosage (runs regardless, appended if available) ───────
  const retrievalTerms = buildRetrievalTerms(interpreted, query);
  const rankedChunks = rerankChunksForQuery(retrievalTerms, allChunks);
  const augmentedQuery = effectiveWeightKg != null && !queryLower.includes("kg")
    ? `${query} ${effectiveWeightKg}kg`
    : query;
  const doseQuery = isDoseRequest(query);
  const dosage = calculateDosage(augmentedQuery, rankedChunks);
  let warnings: string[] = [];
  let dosageInstruction: string | null = null;
  if (dosage) {
    if (dosage.dose_range_mg) {
      dosageInstruction = `Give ${dosage.dose_range_mg[0]}-${dosage.dose_range_mg[1]} mg for ${dosage.weight_kg} kg.`;
    } else if (typeof dosage.dose_mg === "number") {
      dosageInstruction = `Give ${dosage.dose_mg} mg for ${dosage.weight_kg} kg.`;
    } else if (dosage.note) {
      warnings.push(dosage.note);
    }
  }

  // ── 5.5 High-risk protocol and Answerability Gates ─────────────────────────
  const highRiskResponse = evaluateHighRiskProtocol(query, candidates, allChunks);
  if (highRiskResponse) {
    if (sessionId) {
      await saveSessionMemory(supabase, sessionId, "clinical",
        { query, disposition: highRiskResponse.disposition, answer_excerpt: highRiskResponse.answer.slice(0, 200), candidate_conditions: candidates },
        buildFactsUpdate({
          query,
          audience: "clinician",
          interpreted,
          memory,
          candidateConditions: candidates,
          symptoms,
          lastClarification: highRiskResponse.disposition === "ASK_CLARIFY" ? highRiskResponse.answer : null,
        }),
        memory,
      );
    }
    return {
      ...highRiskResponse,
      citations: toCitations(allChunks),
      follow_up_question: highRiskResponse.disposition === "ASK_CLARIFY" ? highRiskResponse.answer : undefined,
    };
  }

  const answerability = checkAnswerability(task, candidates, allChunks, dosage, query);
  if (answerability) {
    if (sessionId) {
      await saveSessionMemory(supabase, sessionId, "clinical",
        { query, disposition: answerability.disposition, answer_excerpt: answerability.answer.slice(0, 200), candidate_conditions: candidates },
        buildFactsUpdate({
          query,
          audience: "clinician",
          interpreted,
          memory,
          candidateConditions: candidates,
          symptoms,
          lastClarification: answerability.disposition === "ASK_CLARIFY" ? answerability.answer : null,
        }),
        memory,
      );
    }
    return {
      ...answerability,
      citations: [],
      follow_up_question: answerability.disposition === "ASK_CLARIFY" ? answerability.answer : undefined,
    };
  }"""
content = content.replace(clinician_dose_old, clinician_dose_new)

# 7. answerClinician - Validation
clinician_validation_old = """  if (decision.disposition === "ANSWER") {
    decision = {
      ...decision,
      response_text: stripUnsafeTreatmentText(decision.response_text, {
        evidenceChunks: rankedChunks,
        dosage,
        audience: "clinician",
        isDoseQuery: isDoseRequest(query),
      }),
    };
  }"""

clinician_validation_new = """  if (decision.disposition === "ANSWER") {
    decision = {
      ...decision,
      response_text: stripUnsafeTreatmentText(decision.response_text, {
        evidenceChunks: rankedChunks,
        dosage,
        audience: "clinician",
        isDoseQuery: isDoseRequest(query),
      }),
    };
    const patientAgeGroup = inferPatientContext(query, "clinician", interpreted?.age_years ?? memory?.facts?.age_years ?? null, memory?.facts ?? {}).patient_age_group;
    const validated = validateResponse(decision.response_text, task, rankedChunks, dosage, patientAgeGroup);
    if (validated) {
      decision.response_text = validated.answer;
      if (validated.disposition !== "ANSWER") {
        decision.disposition = validated.disposition;
      }
      if (validated.warnings) warnings.push(...validated.warnings);
    }
  }"""
content = content.replace(clinician_validation_old, clinician_validation_new)

with open("supabase/functions/_shared/service.ts", "w", encoding="utf-8") as f:
    f.write(content)
print("Updated service.ts")
