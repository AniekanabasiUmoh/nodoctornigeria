from __future__ import annotations

from hashlib import sha256
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator


class NodeMetadata(BaseModel):
    condition: str | None = None
    demographic: str | None = None
    severity: str | None = None
    contraindications: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

    @field_validator("contraindications", "tags", mode="before")
    @classmethod
    def normalize_string_lists(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [value.strip()] if value.strip() else []
        if isinstance(value, list):
            normalized = []
            for item in value:
                if item is None:
                    continue
                text = str(item).strip()
                if text:
                    normalized.append(text)
            return normalized
        raise TypeError("Expected a string or list of strings.")


class GuidelineNode(BaseModel):
    node_id: str
    title: str
    page: int | None = Field(default=None, ge=1)
    body: str = ""
    metadata: NodeMetadata = Field(default_factory=NodeMetadata)
    children: list["GuidelineNode"] = Field(default_factory=list)

    @field_validator("node_id", "title")
    @classmethod
    def require_non_empty_string(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Value must not be empty.")
        return cleaned

    @field_validator("body", mode="before")
    @classmethod
    def normalize_body(cls, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        raise TypeError("Body must be a string.")


GuidelineNode.model_rebuild()


class NSTGDocument(BaseModel):
    document_id: str
    title: str
    version: str
    country: str = "Nigeria"
    source_file: str | None = None
    chapters: list[GuidelineNode] = Field(default_factory=list)

    @field_validator("document_id", "title", "version", mode="before")
    @classmethod
    def require_non_empty_fields(cls, value: Any) -> str:
        if not isinstance(value, str):
            raise TypeError("Expected a string.")
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Value must not be empty.")
        return cleaned

    @model_validator(mode="after")
    def ensure_has_chapters(self) -> "NSTGDocument":
        if not self.chapters:
            raise ValueError("Document must contain at least one chapter.")
        return self


class ChunkMetadata(BaseModel):
    document_id: str
    document_title: str
    source_file: str | None = None
    country: str
    version: str
    node_id: str
    page: int | None = None
    chapter: str
    section: str | None = None
    subsection: str | None = None
    lineage: list[str]
    condition: str | None = None
    demographic: str | None = None
    severity: str | None = None
    contraindications: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    source_text_hash: str


class ChunkRecord(BaseModel):
    chunk_id: str
    text: str
    word_count: int
    metadata: ChunkMetadata

    @classmethod
    def build(cls, text: str, metadata: ChunkMetadata) -> "ChunkRecord":
        normalized_text = text.strip()
        digest = sha256(f"{metadata.node_id}|{normalized_text}".encode("utf-8")).hexdigest()
        return cls(
            chunk_id=digest,
            text=normalized_text,
            word_count=len(normalized_text.split()),
            metadata=metadata,
        )


def hash_source_text(value: str) -> str:
    return sha256(value.strip().encode("utf-8")).hexdigest()


class ClinicalFeatureGroup(BaseModel):
    type: str
    features: list[str] = Field(default_factory=list)

    @field_validator("type")
    @classmethod
    def validate_type(cls, value: str) -> str:
        cleaned = value.strip()
        return cleaned or "General"

    @field_validator("features", mode="before")
    @classmethod
    def normalize_features(cls, value: Any) -> list[str]:
        return NodeMetadata.normalize_string_lists(value)


class TreatmentSection(BaseModel):
    goals: list[str] = Field(default_factory=list)
    non_drug: list[str] = Field(default_factory=list)
    drug: list[str] = Field(default_factory=list)
    adverse_reactions_and_cautions: list[str] = Field(default_factory=list)
    supportive_measures: list[str] = Field(default_factory=list)

    @field_validator(
        "goals",
        "non_drug",
        "drug",
        "adverse_reactions_and_cautions",
        "supportive_measures",
        mode="before",
    )
    @classmethod
    def normalize_string_lists(cls, value: Any) -> list[str]:
        return NodeMetadata.normalize_string_lists(value)


class ConditionRecord(BaseModel):
    condition_name: str
    condition_slug: str
    source: str
    introduction: str = ""
    clinical_features: list[ClinicalFeatureGroup] = Field(default_factory=list)
    investigations: list[str] = Field(default_factory=list)
    treatment: TreatmentSection = Field(default_factory=TreatmentSection)
    differential_diagnoses: list[str] = Field(default_factory=list)
    complications: list[str] = Field(default_factory=list)
    prevention: list[str] = Field(default_factory=list)
    other_investigations: list[str] = Field(default_factory=list)
    definitive_treatment: list[str] = Field(default_factory=list)
    prognosis: list[str] = Field(default_factory=list)

    @field_validator("condition_name", "condition_slug", "source")
    @classmethod
    def require_non_empty_string(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Value must not be empty.")
        return cleaned

    @field_validator("introduction", mode="before")
    @classmethod
    def normalize_introduction(cls, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        raise TypeError("Introduction must be a string.")

    @field_validator(
        "investigations",
        "differential_diagnoses",
        "complications",
        "prevention",
        "other_investigations",
        "definitive_treatment",
        "prognosis",
        mode="before",
    )
    @classmethod
    def normalize_section_lists(cls, value: Any) -> list[str]:
        return NodeMetadata.normalize_string_lists(value)
