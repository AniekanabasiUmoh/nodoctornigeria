from __future__ import annotations

import json
from pathlib import Path

from pydantic import ValidationError

from .models import (
    ChunkMetadata,
    ChunkRecord,
    ConditionRecord,
    GuidelineNode,
    NSTGDocument,
    hash_source_text,
)


def load_document(path: str | Path) -> NSTGDocument:
    input_path = Path(path)
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        raise ValueError("Expected a single NSTG document object, not a list.")
    try:
        return NSTGDocument.model_validate(payload)
    except ValidationError as exc:
        raise ValueError(f"Invalid NSTG document at {input_path}: {exc}") from exc


def load_condition_record(path: str | Path) -> ConditionRecord:
    input_path = Path(path)
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    try:
        return ConditionRecord.model_validate(payload)
    except ValidationError as exc:
        raise ValueError(f"Invalid processed condition file at {input_path}: {exc}") from exc


def load_condition_directory(path: str | Path) -> list[ConditionRecord]:
    base_path = Path(path)
    if not base_path.is_dir():
        raise ValueError(f"Expected a directory of condition JSON files, got: {base_path}")
    return [load_condition_record(file_path) for file_path in sorted(base_path.glob("*.json"))]


def build_chunks(document: NSTGDocument) -> list[ChunkRecord]:
    chunks: list[ChunkRecord] = []
    for chapter in document.chapters:
        _walk_node(
            document=document,
            node=chapter,
            lineage=[],
            inherited_metadata={},
            chunks=chunks,
        )
    return chunks


def build_condition_chunks(
    condition: ConditionRecord,
    *,
    country: str = "Nigeria",
    version: str = "2022",
    source_file: str | None = None,
) -> list[ChunkRecord]:
    chunks: list[ChunkRecord] = []
    condition_name = condition.condition_name
    base_meta = {
        "document_id": condition.condition_slug,
        "document_title": condition.condition_name,
        "source_file": source_file,
        "country": country,
        "version": version,
        "condition": condition.condition_name,
    }

    if condition.introduction:
        chunks.append(
            _build_section_chunk(
                base_meta=base_meta,
                section="Introduction",
                subsection=None,
                body=condition.introduction,
                node_id=f"{condition.condition_slug}::introduction",
                lineage=[condition_name, "Introduction"],
            )
        )

    for feature_group in condition.clinical_features:
        if feature_group.features:
            chunks.append(
                _build_section_chunk(
                    base_meta=base_meta,
                    section="Clinical Features",
                    subsection=feature_group.type,
                    body=_join_lines(feature_group.features),
                    node_id=f"{condition.condition_slug}::clinical_features::{_slugify(feature_group.type)}",
                    lineage=[condition_name, "Clinical Features", feature_group.type],
                    tags=["clinical_features"],
                )
            )

    section_mapping: list[tuple[str, str, list[str]]] = [
        ("Investigations", "investigations", condition.investigations),
        ("Differential Diagnoses", "differential_diagnoses", condition.differential_diagnoses),
        ("Complications", "complications", condition.complications),
        ("Prevention", "prevention", condition.prevention),
        ("Other Investigations", "other_investigations", condition.other_investigations),
        ("Definitive Treatment", "definitive_treatment", condition.definitive_treatment),
        ("Prognosis", "prognosis", condition.prognosis),
    ]
    for section_title, section_key, items in section_mapping:
        if items:
            chunks.append(
                _build_section_chunk(
                    base_meta=base_meta,
                    section=section_title,
                    subsection=None,
                    body=_join_lines(items),
                    node_id=f"{condition.condition_slug}::{section_key}",
                    lineage=[condition_name, section_title],
                    tags=[section_key],
                )
            )

    treatment_sections: list[tuple[str, str, list[str]]] = [
        ("Goals", "goals", condition.treatment.goals),
        ("Non-Drug", "non_drug", condition.treatment.non_drug),
        ("Drug", "drug", condition.treatment.drug),
        (
            "Adverse Reactions and Cautions",
            "adverse_reactions_and_cautions",
            condition.treatment.adverse_reactions_and_cautions,
        ),
        ("Supportive Measures", "supportive_measures", condition.treatment.supportive_measures),
    ]
    for subsection_title, section_key, items in treatment_sections:
        if items:
            chunks.append(
                _build_section_chunk(
                    base_meta=base_meta,
                    section="Treatment",
                    subsection=subsection_title,
                    body=_join_lines(items),
                    node_id=f"{condition.condition_slug}::treatment::{section_key}",
                    lineage=[condition_name, "Treatment", subsection_title],
                    tags=["treatment", section_key],
                )
            )

    return chunks


def build_condition_directory_chunks(
    path: str | Path,
    *,
    country: str = "Nigeria",
    version: str = "2022",
) -> list[ChunkRecord]:
    base_path = Path(path)
    all_chunks: list[ChunkRecord] = []
    for file_path, condition in iter_unique_condition_files(base_path):
        all_chunks.extend(
            build_condition_chunks(
                condition,
                country=country,
                version=version,
                source_file=file_path.name,
            )
        )
    return all_chunks


def iter_unique_condition_files(path: str | Path) -> list[tuple[Path, ConditionRecord]]:
    base_path = Path(path)
    best_by_slug: dict[str, tuple[Path, ConditionRecord]] = {}
    for file_path in sorted(base_path.glob("*.json")):
        condition = load_condition_record(file_path)
        existing = best_by_slug.get(condition.condition_slug)
        if existing is None or _condition_quality_score(condition) > _condition_quality_score(existing[1]):
            best_by_slug[condition.condition_slug] = (file_path, condition)
    return [best_by_slug[slug] for slug in sorted(best_by_slug)]


def write_chunks_jsonl(chunks: list[ChunkRecord], output_path: str | Path) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for chunk in chunks:
            handle.write(chunk.model_dump_json())
            handle.write("\n")
    return path


def _walk_node(
    document: NSTGDocument,
    node: GuidelineNode,
    lineage: list[str],
    inherited_metadata: dict[str, object],
    chunks: list[ChunkRecord],
) -> None:
    current_lineage = [*lineage, node.title]
    merged_metadata = {
        **inherited_metadata,
        "condition": node.metadata.condition or inherited_metadata.get("condition"),
        "demographic": node.metadata.demographic or inherited_metadata.get("demographic"),
        "severity": node.metadata.severity or inherited_metadata.get("severity"),
        "contraindications": _merge_lists(
            inherited_metadata.get("contraindications", []),
            node.metadata.contraindications,
        ),
        "tags": _merge_lists(
            inherited_metadata.get("tags", []),
            node.metadata.tags,
        ),
    }

    if node.body:
        chunks.append(_build_chunk(document=document, node=node, lineage=current_lineage, metadata=merged_metadata))

    for child in node.children:
        _walk_node(
            document=document,
            node=child,
            lineage=current_lineage,
            inherited_metadata=merged_metadata,
            chunks=chunks,
        )


def _build_chunk(
    document: NSTGDocument,
    node: GuidelineNode,
    lineage: list[str],
    metadata: dict[str, object],
) -> ChunkRecord:
    text = _format_chunk_text(lineage=lineage, body=node.body)
    chunk_metadata = ChunkMetadata(
        document_id=document.document_id,
        document_title=document.title,
        source_file=document.source_file,
        country=document.country,
        version=document.version,
        node_id=node.node_id,
        page=node.page,
        chapter=lineage[0],
        section=lineage[1] if len(lineage) > 1 else None,
        subsection=lineage[2] if len(lineage) > 2 else None,
        lineage=lineage,
        condition=_optional_str(metadata.get("condition")),
        demographic=_optional_str(metadata.get("demographic")),
        severity=_optional_str(metadata.get("severity")),
        contraindications=_coerce_string_list(metadata.get("contraindications")),
        tags=_coerce_string_list(metadata.get("tags")),
        source_text_hash=hash_source_text(node.body),
    )
    return ChunkRecord.build(text=text, metadata=chunk_metadata)


def _build_section_chunk(
    *,
    base_meta: dict[str, str | None],
    section: str,
    subsection: str | None,
    body: str,
    node_id: str,
    lineage: list[str],
    tags: list[str] | None = None,
) -> ChunkRecord:
    text = _format_chunk_text(lineage=lineage, body=body)
    chunk_metadata = ChunkMetadata(
        document_id=base_meta["document_id"] or "",
        document_title=base_meta["document_title"] or "",
        source_file=base_meta["source_file"],
        country=base_meta["country"] or "Nigeria",
        version=base_meta["version"] or "",
        node_id=node_id,
        page=None,
        chapter=lineage[0],
        section=section,
        subsection=subsection,
        lineage=lineage,
        condition=base_meta["condition"],
        demographic=None,
        severity=None,
        contraindications=[],
        tags=tags or [],
        source_text_hash=hash_source_text(body),
    )
    return ChunkRecord.build(text=text, metadata=chunk_metadata)


def _format_chunk_text(lineage: list[str], body: str) -> str:
    heading = " > ".join(lineage)
    return f"{heading}\n\n{body.strip()}"


def _join_lines(items: list[str]) -> str:
    return "\n".join(f"- {item}" for item in items)


def _merge_lists(left: object, right: object) -> list[str]:
    combined = [*_coerce_string_list(left), *_coerce_string_list(right)]
    deduplicated: list[str] = []
    for item in combined:
        if item not in deduplicated:
            deduplicated.append(item)
    return deduplicated


def _coerce_string_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        cleaned = value.strip()
        return [cleaned] if cleaned else []
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            text = str(item).strip()
            if text:
                result.append(text)
        return result
    raise TypeError("Expected a list of strings.")


def _optional_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _slugify(value: str) -> str:
    slug = value.lower()
    for char in (" ", "/", "\\", "(", ")", ",", ".", ":", ";"):
        slug = slug.replace(char, "-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-")


def _condition_quality_score(condition: ConditionRecord) -> tuple[int, int]:
    section_count = sum(
        bool(section)
        for section in (
            condition.introduction,
            condition.clinical_features,
            condition.investigations,
            condition.treatment.goals,
            condition.treatment.non_drug,
            condition.treatment.drug,
            condition.treatment.adverse_reactions_and_cautions,
            condition.treatment.supportive_measures,
            condition.differential_diagnoses,
            condition.complications,
            condition.prevention,
            condition.other_investigations,
            condition.definitive_treatment,
            condition.prognosis,
        )
    )
    text_volume = len(condition.model_dump_json(exclude_none=True, exclude_defaults=True))
    return section_count, text_volume
