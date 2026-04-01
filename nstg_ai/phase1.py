from __future__ import annotations

import json
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

from .models import ConditionRecord
from .pipeline import build_condition_chunks, iter_unique_condition_files, load_condition_record


@dataclass(slots=True)
class Phase1AuditReport:
    total_conditions: int
    unique_conditions: int
    total_raw_text_files: int
    unique_raw_text_conditions: int
    source_coverage_ratio: float
    total_chunks: int
    unique_chunk_ids: int
    duplicate_chunk_ids: int
    duplicate_condition_slugs: list[str]
    duplicate_condition_files: list[str]
    missing_raw_text_matches: list[str]
    orphan_raw_text_files: list[str]
    sparse_conditions: list[str]
    section_presence: dict[str, int]

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


def build_phase1_audit_report(
    *,
    processed_json_dir: str | Path,
    raw_text_dir: str | Path | None = None,
) -> Phase1AuditReport:
    processed_path = Path(processed_json_dir)
    raw_path = Path(raw_text_dir) if raw_text_dir else None

    condition_files = sorted(processed_path.glob("*.json"))
    conditions = [load_condition_record(path) for path in condition_files]
    unique_condition_entries = iter_unique_condition_files(processed_path)

    slug_counts = Counter(condition.condition_slug for condition in conditions)
    duplicate_condition_slugs = sorted(slug for slug, count in slug_counts.items() if count > 1)
    unique_paths = {path.name for path, _ in unique_condition_entries}
    duplicate_condition_files = sorted(path.name for path in condition_files if path.name not in unique_paths)

    raw_file_count = 0
    raw_names: set[str] = set()
    if raw_path and raw_path.exists():
        raw_files = list(raw_path.glob("*.txt"))
        raw_file_count = len(raw_files)
        raw_names = {_normalize_raw_text_stem(path.stem) for path in raw_files}

    missing_raw_text_matches: list[str] = []
    matched_raw_names: set[str] = set()
    total_chunks = 0
    chunk_ids: list[str] = []
    sparse_conditions: list[str] = []
    section_presence = Counter()

    for file_path, condition in unique_condition_entries:
        condition_keys = _condition_match_keys(file_path.name, condition)
        if raw_names:
            matched = condition_keys & raw_names
            if matched:
                matched_raw_names.update(matched)
            else:
                missing_raw_text_matches.append(file_path.name)

        chunks = build_condition_chunks(condition, source_file=file_path.name)
        total_chunks += len(chunks)
        chunk_ids.extend(chunk.chunk_id for chunk in chunks)

        for section_name, has_content in _condition_section_flags(condition).items():
            if has_content:
                section_presence[section_name] += 1

        populated_sections = sum(_condition_section_flags(condition).values())
        if populated_sections <= 2 or len(chunks) <= 2:
            sparse_conditions.append(condition.condition_name)

    unique_chunk_ids = len(set(chunk_ids))
    duplicate_chunk_ids = len(chunk_ids) - unique_chunk_ids

    orphan_raw_text_files = []
    if raw_names:
        orphan_raw_text_files = sorted(name for name in raw_names - matched_raw_names)

    source_coverage_ratio = 1.0
    if raw_names:
        source_coverage_ratio = len(matched_raw_names) / len(raw_names) if raw_names else 1.0

    return Phase1AuditReport(
        total_conditions=len(conditions),
        unique_conditions=len(unique_condition_entries),
        total_raw_text_files=raw_file_count,
        unique_raw_text_conditions=len(raw_names),
        source_coverage_ratio=round(source_coverage_ratio, 4),
        total_chunks=total_chunks,
        unique_chunk_ids=unique_chunk_ids,
        duplicate_chunk_ids=duplicate_chunk_ids,
        duplicate_condition_slugs=duplicate_condition_slugs,
        duplicate_condition_files=duplicate_condition_files,
        missing_raw_text_matches=missing_raw_text_matches,
        orphan_raw_text_files=orphan_raw_text_files,
        sparse_conditions=sorted(sparse_conditions),
        section_presence=dict(sorted(section_presence.items())),
    )


def write_phase1_audit_report(report: Phase1AuditReport, output_path: str | Path) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report.to_json(), encoding="utf-8")
    return path


def _condition_section_flags(condition: ConditionRecord) -> dict[str, bool]:
    return {
        "introduction": bool(condition.introduction),
        "clinical_features": any(group.features for group in condition.clinical_features),
        "investigations": bool(condition.investigations),
        "treatment_goals": bool(condition.treatment.goals),
        "treatment_non_drug": bool(condition.treatment.non_drug),
        "treatment_drug": bool(condition.treatment.drug),
        "treatment_cautions": bool(condition.treatment.adverse_reactions_and_cautions),
        "treatment_supportive": bool(condition.treatment.supportive_measures),
        "differential_diagnoses": bool(condition.differential_diagnoses),
        "complications": bool(condition.complications),
        "prevention": bool(condition.prevention),
        "other_investigations": bool(condition.other_investigations),
        "definitive_treatment": bool(condition.definitive_treatment),
        "prognosis": bool(condition.prognosis),
    }


def _normalize_raw_text_stem(value: str) -> str:
    cleaned = value.strip()
    while cleaned.endswith(("_2", "_3", "_4")):
        cleaned = cleaned[:-2]
    return _normalize_match_key(cleaned)


def _condition_match_keys(file_name: str, condition: ConditionRecord) -> set[str]:
    return {
        _normalize_match_key(condition.condition_slug),
        _normalize_match_key(Path(file_name).stem),
        _normalize_match_key(condition.condition_name),
    }


def _normalize_match_key(value: str) -> str:
    cleaned = value.lower().replace("_", " ").strip()
    for token in ("/", "\\", ",", ".", "(", ")", ":", ";"):
        cleaned = cleaned.replace(token, " ")
    while "  " in cleaned:
        cleaned = cleaned.replace("  ", " ")
    return cleaned.replace(" ", "-")
