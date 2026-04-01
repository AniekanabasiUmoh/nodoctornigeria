from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class QueryRequest(BaseModel):
    query: str
    top_k: int = Field(default=5, ge=1, le=10)

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Query must not be empty.")
        return cleaned


class VoiceJobRequest(QueryRequest):
    pass


class Citation(BaseModel):
    source_file: str | None = None
    condition: str
    section: str | None = None
    subsection: str | None = None
    page: int | None = None


class DosageResult(BaseModel):
    medication: str | None = None
    weight_kg: float | None = None
    formula: str | None = None
    dose_mg: float | None = None
    dose_range_mg: list[float] | None = None
    note: str | None = None


class RetrievedChunkTrace(BaseModel):
    condition: str | None = None
    section: str | None = None
    subsection: str | None = None
    page: int | None = None
    source_file: str | None = None


class AuditTrace(BaseModel):
    normalized_query: str
    triage_disposition: str | None = None
    triage_matched_terms: list[str] = Field(default_factory=list)
    retrieved_chunks: list[RetrievedChunkTrace] = Field(default_factory=list)
    prompt_template_version: str | None = None
    model_version: str | None = None
    deterministic_calculation: DosageResult | None = None
    final_disposition: str
    review_required: bool = False
    operator_review_status: str | None = None


class QueryResponse(BaseModel):
    interaction_id: str | None = None
    answer: str
    disposition: str
    follow_up_question: str | None = None
    triage: str | None = None
    citations: list[Citation] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    dosage: DosageResult | None = None


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    result: QueryResponse | None = None
    error: str | None = None


class FeedbackRequest(BaseModel):
    interaction_id: str
    rating: str
    comment: str | None = None

    @field_validator("interaction_id")
    @classmethod
    def validate_interaction_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("interaction_id must not be empty.")
        return cleaned

    @field_validator("rating")
    @classmethod
    def validate_rating(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if cleaned not in {"up", "down"}:
            raise ValueError("rating must be either 'up' or 'down'.")
        return cleaned

    @field_validator("comment", mode="before")
    @classmethod
    def normalize_comment(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class FeedbackResponse(BaseModel):
    feedback_id: str
    interaction_id: str
    rating: str


class WebhookAckResponse(BaseModel):
    status: str
    channel: str
    job_id: str | None = None
    preview: QueryResponse | None = None


class AuditInteractionRecord(BaseModel):
    interaction_id: str
    created_at: str | None = None
    route: str
    channel: str
    query: str
    normalized_query: str
    top_k: int
    job_id: str | None = None
    response: QueryResponse
    trace: AuditTrace
    review_required: bool = False
    review_status: str | None = None


class ReviewQueueSummary(BaseModel):
    total_items: int
    review_required_items: int
    reviewed_items: int
    emergency_items: int
    clinician_items: int


class ReviewQueueResponse(BaseModel):
    items: list[AuditInteractionRecord]
    summary: ReviewQueueSummary


class ReviewStatusUpdateRequest(BaseModel):
    review_status: str

    @field_validator("review_status")
    @classmethod
    def validate_review_status(cls, value: str) -> str:
        cleaned = "_".join(value.strip().lower().split())
        if not cleaned:
            raise ValueError("review_status must not be empty.")
        return cleaned
