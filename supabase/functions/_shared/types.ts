export interface Citation {
  source_file?: string | null;
  condition: string;
  section?: string | null;
  subsection?: string | null;
  page?: number | null;
}

export interface DosageResult {
  medication?: string | null;
  weight_kg?: number | null;
  formula?: string | null;
  dose_mg?: number | null;
  dose_range_mg?: number[] | null;
  note?: string | null;
}

export type ReferUrgency = "immediate" | "soon" | "routine" | null;

export type AnswerSource =
  | "protocol"
  | "dosage_engine"
  | "grounded_summary"
  | "llm_reasoning"
  | "llm_unified"
  | "deterministic_gate"
  | "emergency_gate"
  | "service_unavailable"
  | null;

export interface QueryResponse {
  interaction_id?: string | null;
  answer: string;
  disposition: string;
  follow_up_question?: string | null;
  triage?: string | null;
  citations?: Citation[];
  warnings?: string[];
  dosage?: DosageResult | null;
  treat_here?: boolean | null;
  refer_urgency?: ReferUrgency;
  what_to_ask_next?: string | null;
  what_to_do_now?: string[] | null;
  ask_or_check?: string | null;
  immediate_actions?: string[] | null;
  answer_source?: AnswerSource;
  danger_signs_detected?: string[] | null;
  patient_snapshot?: ExtractedPatientFacts | null;
}

export interface JobStatusResponse {
  job_id: string;
  status: string;
  result?: QueryResponse | null;
  error?: string | null;
}

export interface FeedbackRequest {
  interaction_id: string;
  rating: "up" | "down";
  comment?: string | null;
}

export interface ChunkMetadata {
  document_id?: string | null;
  document_title?: string | null;
  source_file?: string | null;
  country?: string | null;
  version?: string | null;
  node_id?: string | null;
  page?: number | null;
  chapter?: string | null;
  section?: string | null;
  subsection?: string | null;
  lineage?: string[];
  condition?: string | null;
  demographic?: string | null;
  severity?: string | null;
  contraindications?: string[];
  tags?: string[];
  source_text_hash?: string | null;
}

export interface ChunkRecord {
  chunk_id: string;
  text: string;
  word_count: number;
  metadata: ChunkMetadata;
  score?: number;
}

export interface ChannelMessage {
  channel: string;
  user_id?: string | null;
  text?: string | null;
  message_type: string;
  raw_payload: Record<string, unknown>;
}

export interface TriageResult {
  disposition: string;
  matched_terms: string[];
  rationale: string;
}

export type LlmFailureStage =
  | "rewrite"
  | "triage_normalization"
  | "summary"
  | "interpret"
  | "reason"
  | "classify"
  | "unified";

export type LlmFailureReason =
  | "missing_api_key"
  | "timeout"
  | "network_error"
  | "http_error"
  | "empty_response"
  | "invalid_json";

export interface LlmFailure {
  stage: LlmFailureStage;
  reason: LlmFailureReason;
  status_code?: number | null;
  detail?: string | null;
}

export interface LlmResult<T> {
  value: T | null;
  failure?: LlmFailure | null;
}

export interface RetrievedChunkTrace {
  condition?: string | null;
  section?: string | null;
  subsection?: string | null;
  page?: number | null;
  source_file?: string | null;
}

export type TaskType =
  | "diagnosis"
  | "severity"
  | "treatment"
  | "dose"
  | "referral"
  | "investigation"
  | "follow_up"
  | "management_protocol";

export interface ExtractedPatientFacts {
  age_years?: number | null;
  weight_kg?: number | null;
  symptoms?: string[];
  candidate_conditions?: string[];
  onset_days?: number | null;
  raw_summary?: string | null;
  patient_age_group?: "child" | "adult" | null;
  speaker_role?: "self" | "caregiver" | "clinician" | null;
  caregiver_relationship?: string | null;
  last_clarification?: string | null;
  last_suspected_differential?: string[];
  active_condition?: string | null;
  active_task?: TaskType | null;
  management_thread?: boolean;
}

export interface SessionTurn {
  query: string;
  disposition: string;
  answer_excerpt: string;
  candidate_conditions?: string[];
}

export interface SessionMemory {
  session_id: string;
  channel: string;
  turn_count: number;
  facts: ExtractedPatientFacts;
  recent_turns: SessionTurn[];
  updated_at: string;
}

export interface ClinicalDecision {
  disposition: "ANSWER" | "ASK_CLARIFY" | "INSUFFICIENT_EVIDENCE" | "EMERGENCY_ESCALATE";
  leading_condition: string | null;
  also_considered: string[];
  reasoning: string;
  response_text: string;
  clarifying_question: string | null;
  // Structured frontline output fields (Phase 6)
  what_to_do_now: string[] | null;      // numbered action steps
  ask_or_check: string | null;          // one missing datapoint
  refer_if: string | null;              // red flag criteria
  dose_line: string | null;             // dose string if supported by evidence
  treat_here: boolean | null;
}

export interface UnifiedClinicalOutput {
  disposition: "ANSWER" | "ASK_CLARIFY" | "INSUFFICIENT_EVIDENCE" | "EMERGENCY_ESCALATE";
  triage_disposition: "NON_EMERGENCY_CONTINUE" | "EMERGENCY_ESCALATE" | "UNCERTAIN_ESCALATE";
  danger_signs_detected: string[];
  interpreted_facts: ExtractedPatientFacts;
  candidate_conditions: string[];
  reasoning: string;
  answer: string;
  treat_here: boolean | null;
  refer_urgency: ReferUrgency;
  what_to_do_now: string[] | null;
  immediate_actions: string[] | null;
  ask_or_check: string | null;
}

export interface InterpretedQuery {
  age_years: number | null;
  weight_kg: number | null;
  symptoms: string[];
  candidate_conditions: string[];
  onset_days: number | null;
  raw_summary: string;
  patient_age_group?: "child" | "adult" | null;
  speaker_role?: "self" | "caregiver" | "clinician" | null;
  caregiver_relationship?: string | null;
  last_clarification?: string | null;
  last_suspected_differential?: string[];
  confidence: "high" | "medium" | "low";
  clarification_needed: string | null;
}

export interface AuditTrace {
  normalized_query: string;
  triage_disposition?: string | null;
  triage_matched_terms?: string[];
  retrieved_chunks?: RetrievedChunkTrace[];
  prompt_template_version?: string | null;
  model_version?: string | null;
  deterministic_calculation?: DosageResult | null;
  final_disposition: string;
  review_required: boolean;
  operator_review_status?: string | null;
  interpreted_facts?: ExtractedPatientFacts | null;
  retrieval_terms?: string[] | null;
  session_id?: string | null;
  gate_decision?: string | null;
  llm_failure_stage?: string | null;
  llm_failure_reason?: string | null;
}

export interface AuditInteractionRecord {
  interaction_id: string;
  created_at?: string | null;
  route: string;
  channel: string;
  query: string;
  normalized_query: string;
  top_k: number;
  job_id?: string | null;
  response: QueryResponse;
  trace: AuditTrace;
  review_required: boolean;
  review_status?: string | null;
}

export interface ReviewQueueSummary {
  total_items: number;
  review_required_items: number;
  reviewed_items: number;
  emergency_items: number;
  clinician_items: number;
}

export interface ReviewQueueResponse {
  items: AuditInteractionRecord[];
  summary: ReviewQueueSummary;
}
