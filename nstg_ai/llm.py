from __future__ import annotations

import json
from dataclasses import dataclass

import httpx

from .models import ChunkRecord


_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


@dataclass(frozen=True)
class GeminiAssistant:
    api_key: str
    model: str = "gemini-2.5-flash-lite"

    def rewrite_query(self, query: str, *, audience: str) -> str:
        prompt = (
            "You normalize medical search queries for a Nigerian treatment-guideline retrieval system.\n"
            "Correct obvious spelling mistakes, preserve drug names, symptoms, weights, ages, and treatment intent words.\n"
            "Do not add new facts. Output only one short normalized query.\n\n"
            f"Audience: {audience}\n"
            f"User query: {query}"
        )
        result = self._generate_text(prompt, temperature=0.1, max_output_tokens=80)
        if not result:
            return query
        cleaned = " ".join(result.replace("\n", " ").split())
        return cleaned or query

    def normalize_community_triage(self, query: str) -> str:
        prompt = (
            "You normalize free-text community health messages for a deterministic emergency triage system.\n"
            "Rewrite the user's words into short plain English using canonical medical danger-sign terms when clearly supported.\n"
            "Examples of useful canonical terms include convulsion, unconscious, cannot drink, difficulty breathing, heavy bleeding.\n"
            "Do not add symptoms that are not present. Do not explain. Output only one short normalized line.\n\n"
            f"User query: {query}"
        )
        result = self._generate_text(prompt, temperature=0.0, max_output_tokens=60)
        if not result:
            return query
        cleaned = " ".join(result.replace("\n", " ").split())
        return cleaned or query

    def summarize_chunk(
        self,
        *,
        query: str,
        audience: str,
        chunk: ChunkRecord,
        dosage_line: str | None = None,
    ) -> str | None:
        prompt = (
            "You are formatting an answer for a medical decision-support tool.\n"
            "Use only the supplied guideline evidence. Do not add facts that are not present.\n"
            "Write a concise summary in plain text using very short sentences.\n"
            "Make community answers easy for a non-clinician to understand.\n"
            "Do not use numbered lists, markdown tables, or invented warnings.\n"
            "Prefer one fact per sentence so the system can convert the answer into bullet points.\n"
            "If the evidence is too weak, return exactly: INSUFFICIENT_EVIDENCE\n\n"
            f"Audience: {audience}\n"
            f"User query: {query}\n"
            f"Condition: {chunk.metadata.condition or chunk.metadata.document_title}\n"
            f"Section: {chunk.metadata.section or 'Unknown'}\n"
            f"Subsection: {chunk.metadata.subsection or 'None'}\n"
            f"Deterministic dosage line: {dosage_line or 'None'}\n\n"
            "Guideline evidence:\n"
            f"{chunk.text}"
        )
        result = self._generate_text(prompt, temperature=0.2, max_output_tokens=220)
        if not result:
            return None
        cleaned = result.strip()
        if cleaned == "INSUFFICIENT_EVIDENCE":
            return None
        return cleaned

    def _generate_text(self, prompt: str, *, temperature: float, max_output_tokens: int) -> str | None:
        url = _GEMINI_ENDPOINT.format(model=self.model)
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_output_tokens,
            },
        }
        headers = {
            "x-goog-api-key": self.api_key,
            "Content-Type": "application/json",
        }
        try:
            with httpx.Client(timeout=20.0, trust_env=False) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
        except httpx.HTTPError:
            return None

        data = response.json()
        return _extract_text_from_gemini_response(data)


def _extract_text_from_gemini_response(payload: dict[str, object]) -> str | None:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return None
    first = candidates[0]
    if not isinstance(first, dict):
        return None
    content = first.get("content")
    if not isinstance(content, dict):
        return None
    parts = content.get("parts")
    if not isinstance(parts, list):
        return None
    texts: list[str] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    if not texts:
        return None
    return "\n".join(texts)


def serialize_gemini_debug(payload: dict[str, object]) -> str:
    return json.dumps(payload, ensure_ascii=True)
