from __future__ import annotations

import json
import re
from dataclasses import dataclass
from difflib import get_close_matches
from pathlib import Path

import httpx

from .models import ChunkMetadata, ChunkRecord

TOKEN_RE = re.compile(r"[a-z0-9]+")
SEARCH_STOPWORDS = {
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
}
COMMON_QUERY_CORRECTIONS = {
    "tyhoid": "typhoid",
    "doosage": "dosage",
    "diarrohea": "diarrhoea",
    "diarhoea": "diarrhoea",
    "arthemeter": "artemether",
    "lumafantrine": "lumefantrine",
}

_SUPABASE_SEARCH_RPC = "search_guideline_chunks"


def normalize_tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def normalize_query_text(text: str, *, vocabulary: set[str] | None = None) -> str:
    tokens = normalize_tokens(text)
    if not tokens:
        return text.strip()

    normalized: list[str] = []
    for token in tokens:
        corrected = COMMON_QUERY_CORRECTIONS.get(token, token)
        if vocabulary and corrected not in vocabulary and corrected.isalpha() and len(corrected) >= 5:
            matches = get_close_matches(corrected, vocabulary, n=1, cutoff=0.88)
            if matches:
                corrected = matches[0]
        normalized.append(corrected)
    return " ".join(normalized)


@dataclass(slots=True)
class IndexedChunk:
    chunk: ChunkRecord
    tokens: set[str]
    source_text: str


class LexicalRetriever:
    def __init__(self, indexed_chunks: list[IndexedChunk]) -> None:
        self._chunks = indexed_chunks
        self._vocabulary = {
            token
            for indexed_chunk in indexed_chunks
            for token in indexed_chunk.tokens
            if token.isalpha() and len(token) >= 4
        }

    @classmethod
    def from_jsonl(cls, path: str | Path) -> "LexicalRetriever":
        file_path = Path(path)
        indexed_chunks: list[IndexedChunk] = []
        with file_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                chunk = ChunkRecord.model_validate(json.loads(line))
                indexed_chunks.append(
                    IndexedChunk(
                        chunk=chunk,
                        tokens=set(normalize_tokens(chunk.text)),
                        source_text=chunk.text.lower(),
                    )
                )
        return cls(indexed_chunks)

    def search(self, query: str, *, top_k: int = 5) -> list[ChunkRecord]:
        normalized_query = normalize_query_text(query, vocabulary=self._vocabulary)
        query_tokens = normalize_tokens(normalized_query)
        if not query_tokens:
            return []

        ranked: list[tuple[float, ChunkRecord]] = []
        query_text = normalized_query.lower()
        query_token_set = set(query_tokens)

        for indexed_chunk in self._chunks:
            overlap = len(query_token_set & indexed_chunk.tokens)
            if overlap == 0:
                continue

            score = float(overlap)
            condition_name = (indexed_chunk.chunk.metadata.condition or "").lower()
            section = (indexed_chunk.chunk.metadata.section or "").lower()
            subsection = (indexed_chunk.chunk.metadata.subsection or "").lower()

            if condition_name and condition_name in query_text:
                score += 4.0
            if section and section in query_text:
                score += 1.5
            if subsection and subsection in query_text:
                score += 1.0
            if any(token in indexed_chunk.source_text for token in query_tokens):
                score += 0.25

            ranked.append((score, indexed_chunk.chunk))

        ranked.sort(key=lambda item: item[0], reverse=True)
        return [chunk for _, chunk in ranked[:top_k]]


class SupabaseRetriever:
    """Retriever that calls the search_guideline_chunks RPC in Supabase."""

    def __init__(self, *, supabase_url: str, service_role_key: str, schema: str = "public") -> None:
        self._url = supabase_url.rstrip("/")
        self._key = service_role_key
        self._schema = schema

    def search(self, query: str, *, top_k: int = 5) -> list[ChunkRecord]:
        if not query.strip():
            return []
        endpoint = f"{self._url}/rest/v1/rpc/{_SUPABASE_SEARCH_RPC}"
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self._schema != "public":
            headers["Accept-Profile"] = self._schema
        payload = {"query_text": _prepare_supabase_search_query(query), "match_count": top_k}
        with httpx.Client(timeout=15.0) as client:
            response = client.post(endpoint, headers=headers, json=payload)
            response.raise_for_status()
        rows: list[dict] = response.json()
        chunks: list[ChunkRecord] = []
        for row in rows:
            raw_meta = row.get("metadata") or {}
            meta = ChunkMetadata(
                document_id=raw_meta.get("document_id") or "",
                document_title=raw_meta.get("document_title") or raw_meta.get("condition") or "",
                source_file=raw_meta.get("source_file"),
                country=raw_meta.get("country") or "Nigeria",
                version=raw_meta.get("version") or "",
                node_id=raw_meta.get("node_id") or row.get("chunk_id") or "",
                page=raw_meta.get("page"),
                chapter=raw_meta.get("chapter") or "",
                section=raw_meta.get("section"),
                subsection=raw_meta.get("subsection"),
                lineage=raw_meta.get("lineage") or [],
                condition=raw_meta.get("condition"),
                demographic=raw_meta.get("demographic"),
                severity=raw_meta.get("severity"),
                contraindications=raw_meta.get("contraindications") or [],
                tags=raw_meta.get("tags") or [],
                source_text_hash=raw_meta.get("source_text_hash") or "",
            )
            chunks.append(
                ChunkRecord(
                    chunk_id=row["chunk_id"],
                    text=row["text"],
                    word_count=row.get("word_count") or len(row["text"].split()),
                    metadata=meta,
                )
            )
        return chunks


def _prepare_supabase_search_query(query: str) -> str:
    normalized_query = normalize_query_text(query)
    tokens = [
        token
        for token in normalize_tokens(normalized_query)
        if not any(char.isdigit() for char in token) and token not in SEARCH_STOPWORDS and len(token) > 2
    ]
    if not tokens:
        return normalized_query or query
    unique_tokens: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        if token in seen:
            continue
        seen.add(token)
        unique_tokens.append(token)
    return " ".join(unique_tokens[:6])
