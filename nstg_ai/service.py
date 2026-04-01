from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from dataclasses import dataclass

from .api_models import AuditTrace, Citation, DosageResult, QueryResponse, RetrievedChunkTrace
from .audit import JsonlAuditStore, SupabaseAuditStore
from .dosage import calculate_dosage
from .jobs import InMemoryJobStore, SupabaseJobStore
from .llm import GeminiAssistant
from .pipeline import build_condition_directory_chunks, write_chunks_jsonl
from .retrieval import LexicalRetriever, SupabaseRetriever, normalize_query_text
from .settings import get_settings
from .triage import assess_triage


@dataclass(slots=True)
class QueryRunResult:
    response: QueryResponse
    trace: AuditTrace


class QueryEngine:
    def __init__(self, retriever: LexicalRetriever, assistant: GeminiAssistant | None = None) -> None:
        self.retriever = retriever
        self.assistant = assistant

    def answer_community(self, query: str, *, top_k: int = 4) -> QueryResponse:
        return self.run_community(query, top_k=top_k).response

    def run_community(self, query: str, *, top_k: int = 4) -> QueryRunResult:
        clarification_question = _community_clarification_prompt(query)
        if clarification_question:
            response = QueryResponse(
                answer=clarification_question,
                disposition="ASK_CLARIFY",
                follow_up_question=clarification_question,
                warnings=["The query is too vague to answer safely without one more detail."],
            )
            return QueryRunResult(
                response=response,
                trace=_build_trace(
                    query=query,
                    response=response,
                    triage=None,
                    chunks=[],
                    dosage=None,
                ),
            )

        triage_query = self._normalize_community_triage_query(query)
        triage = _select_safer_triage_result(
            assess_triage(query),
            assess_triage(triage_query) if triage_query != query else None,
        )
        if triage.disposition != "NON_EMERGENCY_CONTINUE":
            response = QueryResponse(
                answer=_format_emergency_guidance(triage),
                disposition=triage.disposition,
                triage=triage.disposition,
                warnings=[triage.rationale],
            )
            return QueryRunResult(
                response=response,
                trace=_build_trace(query=query, response=response, triage=triage, chunks=[], dosage=None),
            )

        retrieval_query = self._normalize_retrieval_query(query, audience="community")
        chunks = self.retriever.search(retrieval_query, top_k=top_k)
        if not chunks:
            response = QueryResponse(
                answer="I could not find enough guideline evidence to answer safely. Please ask a clinician.",
                disposition="INSUFFICIENT_EVIDENCE",
                triage=triage.disposition,
                warnings=["No matching guideline chunks were found."],
            )
            return QueryRunResult(
                response=response,
                trace=_build_trace(query=query, response=response, triage=triage, chunks=[], dosage=None),
            )

        chunks = _rerank_chunks_for_query(retrieval_query, chunks)
        lead_chunk = chunks[0]
        grounded_summary = self._render_grounded_summary(
            query=query,
            audience="community",
            chunk=lead_chunk,
        ) or _excerpt(lead_chunk.text)
        answer = _format_community_answer(lead_chunk, grounded_summary)

        response = QueryResponse(
            answer=answer,
            disposition="ANSWER",
            triage=triage.disposition,
            citations=_to_citations(chunks),
        )
        return QueryRunResult(
            response=response,
            trace=_build_trace(query=query, response=response, triage=triage, chunks=chunks, dosage=None),
        )

    def answer_clinician(self, query: str, *, top_k: int = 5) -> QueryResponse:
        return self.run_clinician(query, top_k=top_k).response

    def run_clinician(self, query: str, *, top_k: int = 5) -> QueryRunResult:
        clarification_question = _clinician_clarification_prompt(query)
        if clarification_question:
            response = QueryResponse(
                answer=clarification_question,
                disposition="ASK_CLARIFY",
                follow_up_question=clarification_question,
                warnings=["Weight is required for deterministic mg/kg dose calculation."],
            )
            return QueryRunResult(
                response=response,
                trace=_build_trace(query=query, response=response, triage=None, chunks=[], dosage=None),
            )

        retrieval_query = self._normalize_retrieval_query(query, audience="clinician")
        chunks = self.retriever.search(retrieval_query, top_k=top_k)
        if not chunks:
            response = QueryResponse(
                answer="No sufficiently relevant guideline chunks were found for this clinician query.",
                disposition="INSUFFICIENT_EVIDENCE",
                warnings=["No matching guideline chunks were found."],
                )
            return QueryRunResult(
                response=response,
                trace=_build_trace(query=query, response=response, triage=None, chunks=[], dosage=None),
            )
        chunks = _rerank_chunks_for_query(retrieval_query, chunks)

        dosage = calculate_dosage(retrieval_query, chunks)
        warnings: list[str] = []
        dosage_payload: DosageResult | None = None
        dosage_instruction: str | None = None
        answer_lines = [
            f"Condition: {chunks[0].metadata.condition}",
            f"Section: {chunks[0].metadata.section}" + (f" -> {chunks[0].metadata.subsection}" if chunks[0].metadata.subsection else ""),
        ]

        if dosage:
            dosage_payload = DosageResult(
                medication=dosage.medication,
                weight_kg=dosage.weight_kg,
                formula=dosage.formula,
                dose_mg=dosage.dose_mg,
                dose_range_mg=dosage.dose_range_mg,
                note=dosage.note,
            )
            if dosage.dose_range_mg:
                dosage_instruction = f"Give {dosage.dose_range_mg[0]}-{dosage.dose_range_mg[1]} mg for {dosage.weight_kg} kg."
            elif dosage.dose_mg is not None:
                dosage_instruction = f"Give {dosage.dose_mg} mg for {dosage.weight_kg} kg."
            else:
                warnings.append(dosage.note or "No dosing formula found.")
        grounded_summary = self._render_grounded_summary(
            query=query,
            audience="clinician",
            chunk=chunks[0],
            dosage_line=dosage_instruction,
        ) or _excerpt(chunks[0].text)

        answer_lines.append("Action:")
        answer_lines.append(_format_action_block(grounded_summary, dosage_line=dosage_instruction))
        answer_lines.append("Summary:")
        answer_lines.append(_format_summary_block(grounded_summary))
        answer_lines.append(_format_primary_citation(chunks[0]))

        response = QueryResponse(
            answer="\n\n".join(answer_lines),
            disposition="ANSWER",
            citations=_to_citations(chunks),
            warnings=warnings,
            dosage=dosage_payload,
        )
        return QueryRunResult(
            response=response,
            trace=_build_trace(query=query, response=response, triage=None, chunks=chunks, dosage=dosage_payload),
        )

    def _normalize_retrieval_query(self, query: str, *, audience: str) -> str:
        corrected_query = normalize_query_text(query)
        if not self.assistant:
            return corrected_query
        rewritten = self.assistant.rewrite_query(corrected_query, audience=audience)
        return rewritten or corrected_query

    def _normalize_community_triage_query(self, query: str) -> str:
        corrected_query = normalize_query_text(query)
        if not self.assistant:
            return corrected_query
        rewritten = self.assistant.normalize_community_triage(corrected_query)
        return rewritten or corrected_query

    def _render_grounded_summary(
        self,
        *,
        query: str,
        audience: str,
        chunk,
        dosage_line: str | None = None,
    ) -> str | None:
        if not self.assistant:
            return None
        return self.assistant.summarize_chunk(
            query=query,
            audience=audience,
            chunk=chunk,
            dosage_line=dosage_line,
        )


@lru_cache(maxsize=1)
def get_default_engine() -> QueryEngine:
    settings = get_settings()
    assistant = _build_gemini_assistant()
    if settings.data_provider == "supabase":
        if not settings.supabase_url or not settings.supabase_service_role_key:
            raise RuntimeError("DATA_PROVIDER is set to supabase, but Supabase credentials are missing.")
        retriever = SupabaseRetriever(
            supabase_url=settings.supabase_url,
            service_role_key=settings.supabase_service_role_key,
            schema=settings.supabase_schema,
        )
        return QueryEngine(retriever, assistant=assistant)

    repo_root = Path(__file__).resolve().parent.parent
    chunk_path = repo_root / "build" / "nstg_dataset_chunks.jsonl"
    if not chunk_path.exists():
        dataset_dir = repo_root / "nigeria-clinical-guidelines-dataset-main" / "processed_json"
        chunks = build_condition_directory_chunks(dataset_dir)
        write_chunks_jsonl(chunks, chunk_path)
    retriever = LexicalRetriever.from_jsonl(chunk_path)
    return QueryEngine(retriever, assistant=assistant)


@lru_cache(maxsize=1)
def get_job_store():
    settings = get_settings()
    if settings.data_provider == "supabase":
        if not settings.supabase_url or not settings.supabase_service_role_key:
            raise RuntimeError("DATA_PROVIDER is set to supabase, but Supabase credentials are missing.")
        return SupabaseJobStore(
            supabase_url=settings.supabase_url,
            service_role_key=settings.supabase_service_role_key,
        )
    return InMemoryJobStore()


@lru_cache(maxsize=1)
def get_audit_store():
    repo_root = Path(__file__).resolve().parent.parent
    settings = get_settings()
    if settings.data_provider == "supabase":
        if not settings.supabase_url or not settings.supabase_service_role_key:
            raise RuntimeError("DATA_PROVIDER is set to supabase, but Supabase credentials are missing.")
        return SupabaseAuditStore(
            supabase_url=settings.supabase_url,
            service_role_key=settings.supabase_service_role_key,
            schema=settings.supabase_schema,
        )
    return JsonlAuditStore(repo_root / "build" / "audit")


def _to_citations(chunks) -> list[Citation]:
    citations: list[Citation] = []
    seen: set[tuple[str | None, str, str | None, str | None, int | None]] = set()
    for chunk in chunks:
        key = (
            chunk.metadata.source_file,
            chunk.metadata.condition or chunk.metadata.document_title,
            chunk.metadata.section,
            chunk.metadata.subsection,
            chunk.metadata.page,
        )
        if key in seen:
            continue
        seen.add(key)
        citations.append(
            Citation(
                source_file=chunk.metadata.source_file,
                condition=chunk.metadata.condition or chunk.metadata.document_title,
                section=chunk.metadata.section,
                subsection=chunk.metadata.subsection,
                page=chunk.metadata.page,
            )
        )
    return citations


def _excerpt(text: str, max_chars: int = 420) -> str:
    body = text.split("\n\n", 1)[1] if "\n\n" in text else text
    body = body.strip()
    if len(body) <= max_chars:
        return body
    return body[: max_chars - 3].rstrip() + "..."


def _format_primary_citation(chunk) -> str:
    lineage = [
        chunk.metadata.condition or chunk.metadata.document_title,
        chunk.metadata.section,
        chunk.metadata.subsection,
    ]
    location = " -> ".join(part for part in lineage if part)
    if chunk.metadata.page:
        return f"Citation: {location} (page {chunk.metadata.page})"
    return f"Citation: {location}"


def _extract_points(text: str, *, limit: int = 5) -> list[str]:
    cleaned = " ".join((text or "").replace("\r", " ").split())
    if not cleaned:
        return []
    bullet_like_parts = [
        segment.strip(" -•\t.")
        for segment in re.split(r"(?:^|[\s])[-•]\s+(?=[A-Z(])", cleaned)
        if segment.strip(" -•\t.")
    ]
    if len(bullet_like_parts) <= 1:
        bullet_like_parts = [
            segment.strip(" -•\t.")
            for segment in re.split(r"(?<=[.!?])\s+", cleaned)
            if segment.strip(" -•\t.")
        ]
    points: list[str] = []
    for part in bullet_like_parts:
        normalized = re.sub(r"\s+", " ", part).strip(" -•\t.")
        if not normalized:
            continue
        if normalized.lower().startswith(("summary:", "action:", "what to do now:", "key points:")):
            normalized = normalized.split(":", 1)[1].strip()
        if normalized:
            points.append(normalized)
        if len(points) >= limit:
            break
    return points


def _format_points(points: list[str]) -> str:
    return "\n\n".join(f"- {point.rstrip('.')}." for point in points if point)


def _format_action_block(text: str, *, dosage_line: str | None = None) -> str:
    if dosage_line:
        return _format_points([dosage_line])
    points = _extract_points(text, limit=2)
    if not points:
        return _format_points(["Use the NSTG treatment guidance below"])
    return _format_points(points[:2])


def _format_summary_block(text: str) -> str:
    points = _extract_points(text, limit=5)
    if not points:
        return text
    return _format_points(points)


def _format_community_answer(chunk, summary: str) -> str:
    condition = chunk.metadata.condition or chunk.metadata.document_title or "Guideline"
    location = chunk.metadata.section or "Guidance"
    if chunk.metadata.subsection:
        location += f" -> {chunk.metadata.subsection}"
    points = _extract_points(summary, limit=5)
    if not points:
        points = ["I could not turn this guideline section into simple steps."]
    first_group = points[:3]
    second_group = points[3:5]
    answer_lines = [
        f"Condition: {condition}",
        f"Section: {location}",
        "What To Do Now:",
        _format_points(first_group),
    ]
    if second_group:
        answer_lines.extend(["Key Points:", _format_points(second_group)])
    answer_lines.append(_format_primary_citation(chunk))
    return "\n\n".join(answer_lines)


def _format_emergency_guidance(triage) -> str:
    title = "This may be an emergency."
    what_may_be_happening = _emergency_label(triage)
    immediate_steps = _emergency_steps(triage)
    answer_lines = [
        title,
        "What May Be Happening:",
        _format_points([what_may_be_happening]),
        "What To Do Now:",
        _format_points(immediate_steps),
        "Get Help Urgently:",
        _format_points(["Go to the nearest hospital or urgent clinic now"]),
    ]
    return "\n\n".join(answer_lines)


def _emergency_label(triage) -> str:
    matched = set(triage.matched_terms)
    if "convulsion" in matched:
        return "The child may be having a convulsion or seizure"
    if "respiratory_distress" in matched:
        return "The child may be having serious trouble breathing"
    if "cannot_drink" in matched:
        return "The child may be too sick to drink or feed safely"
    if "unconscious" in matched:
        return "The child may not be fully conscious or may not be waking properly"
    if "severe_bleeding" in matched:
        return "There may be dangerous heavy bleeding"
    return "There may be a serious danger sign that needs urgent care"


def _emergency_steps(triage) -> list[str]:
    matched = set(triage.matched_terms)
    steps = ["Stay with the child and go for urgent in-person care now"]
    if "convulsion" in matched:
        steps.extend(
            [
                "Lay the child on the side",
                "Do not put anything in the mouth",
                "Move hard or sharp objects away from the child",
            ]
        )
    if "respiratory_distress" in matched:
        steps.extend(
            [
                "Keep the child sitting up or in the easiest position for breathing",
                "Loosen tight clothing around the neck and chest",
            ]
        )
    if "cannot_drink" in matched:
        steps.append("Do not force food or drink if the child cannot swallow safely")
    if "unconscious" in matched:
        steps.append("If the child is not waking well, keep the child on the side")
    if "severe_bleeding" in matched:
        steps.append("Press firmly on the bleeding area with a clean cloth if you can")
    steps.append("If the child stops breathing, collapses, or the shaking does not stop, shout for help immediately")

    seen: set[str] = set()
    unique_steps: list[str] = []
    for step in steps:
        if step not in seen:
            seen.add(step)
            unique_steps.append(step)
    return unique_steps[:5]


def _select_safer_triage_result(primary, candidate=None):
    if candidate is None:
        return primary
    priority = {
        "EMERGENCY_ESCALATE": 3,
        "UNCERTAIN_ESCALATE": 2,
        "NON_EMERGENCY_CONTINUE": 1,
    }
    if priority.get(candidate.disposition, 0) > priority.get(primary.disposition, 0):
        return candidate
    return primary


def _rerank_chunks_for_query(query: str, chunks):
    lowered = query.lower()

    def score(chunk) -> float:
        condition = (chunk.metadata.condition or chunk.metadata.document_title or "").lower()
        section = (chunk.metadata.section or "").lower()
        subsection = (chunk.metadata.subsection or "").lower()
        text = chunk.text.lower()
        value = 0.0

        if condition and condition in lowered:
            value += 6.0

        if any(token in lowered for token in ("treatment", "treat", "management")):
            if section == "treatment":
                value += 5.0
            if subsection in {"drug", "non-drug", "goals", "supportive measures", "adverse reactions and cautions"}:
                value += 2.0
            if section == "clinical features":
                value -= 2.5

        if any(token in lowered for token in ("dose", "dosage", "mg/kg", "mg per kg")):
            if section == "treatment":
                value += 4.0
            if subsection == "drug":
                value += 3.0
            if "mg/kg" in text or " mg / kg" in text or " mg/kg" in text:
                value += 2.0

        if any(token in lowered for token in ("investigation", "investigations", "test", "tests")):
            if section == "investigations":
                value += 5.0

        if any(token in lowered for token in ("prevention", "prevent")):
            if section == "prevention":
                value += 5.0

        if any(token in lowered for token in ("complication", "complications")):
            if section == "complications":
                value += 5.0

        if any(token in lowered for token in ("symptom", "symptoms", "sign", "signs", "feature", "features")):
            if section == "clinical features":
                value += 4.0

        if any(token in lowered for token in ("child", "children", "paediatric", "pediatric", "infant", "newborn")):
            if any(token in text for token in ("child", "children", "paediatric", "pediatric", "infant", "newborn")):
                value += 1.5

        return value

    return sorted(chunks, key=score, reverse=True)


def _clinician_clarification_prompt(query: str) -> str | None:
    lowered = normalize_query_text(query).lower()
    if any(token in lowered for token in ("dose", "dosage", "mg/kg", "mg per kg")) and "kg" not in lowered:
        medication = _extract_medication_hint(query)
        if medication:
            return f"What is the patient's weight in kg for the {medication} dose calculation?"
        return "What is the patient's weight in kg for this dose calculation?"
    return None


def _community_clarification_prompt(query: str) -> str | None:
    lowered = query.lower().strip(" ?.")
    symptom_terms = {
        "diarrhoea",
        "diarrhea",
        "vomiting",
        "fever",
        "cough",
        "rash",
        "headache",
        "pain",
    }
    if lowered in symptom_terms or (len(lowered.split()) <= 3 and any(term in lowered for term in symptom_terms)):
        return "Who is the patient, and what is the person's age or weight?"
    return None


def _extract_medication_hint(query: str) -> str | None:
    normalized_query = normalize_query_text(query)
    stopwords = {
        "dose",
        "dosage",
        "for",
        "with",
        "child",
        "adult",
        "patient",
        "treatment",
        "management",
        "query",
    }
    for token in normalized_query.replace("/", " ").split():
        cleaned = token.strip(" ,.?():;").lower()
        if len(cleaned) <= 3 or cleaned in stopwords:
            continue
        return cleaned
    return None


def _build_trace(*, query: str, response: QueryResponse, triage, chunks, dosage: DosageResult | None) -> AuditTrace:
    return AuditTrace(
        normalized_query=" ".join(query.lower().split()),
        triage_disposition=getattr(triage, "disposition", None),
        triage_matched_terms=list(getattr(triage, "matched_terms", [])),
        retrieved_chunks=[
            RetrievedChunkTrace(
                condition=chunk.metadata.condition or chunk.metadata.document_title,
                section=chunk.metadata.section,
                subsection=chunk.metadata.subsection,
                page=chunk.metadata.page,
                source_file=chunk.metadata.source_file,
            )
            for chunk in chunks
        ],
        prompt_template_version=None,
        model_version="deterministic-rag-v1",
        deterministic_calculation=dosage,
        final_disposition=response.disposition,
        review_required=_requires_review(response),
        operator_review_status=None,
    )


def _requires_review(response: QueryResponse) -> bool:
    return response.disposition in {
        "EMERGENCY_ESCALATE",
        "UNCERTAIN_ESCALATE",
        "INSUFFICIENT_EVIDENCE",
        "ASK_CLARIFY",
    } or bool(response.warnings)


def _build_gemini_assistant() -> GeminiAssistant | None:
    settings = get_settings()
    if not settings.enable_gemini_assist or not settings.gemini_api_key:
        return None
    return GeminiAssistant(api_key=settings.gemini_api_key, model=settings.gemini_model)
