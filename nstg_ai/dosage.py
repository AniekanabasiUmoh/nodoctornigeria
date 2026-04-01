from __future__ import annotations

import re
from dataclasses import dataclass

from .models import ChunkRecord


@dataclass(slots=True)
class ParsedDosage:
    medication: str | None
    weight_kg: float | None
    formula: str | None
    dose_mg: float | None
    dose_range_mg: list[float] | None
    note: str | None


WEIGHT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*kg\b", re.I)
DOSAGE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*mg\s*/\s*kg|(\d+(?:\.\d+)?)\s*mg\s*/\s*kg", re.I)
QUERY_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9-]+")
STOPWORDS = {
    "dose",
    "dosage",
    "for",
    "with",
    "child",
    "adult",
    "patient",
    "severe",
    "acute",
    "chronic",
    "treatment",
    "management",
    "query",
    "pulmonary",
    "oedema",
    "edema",
    "kg",
}


def parse_weight_kg(query: str) -> float | None:
    match = WEIGHT_RE.search(query)
    return float(match.group(1)) if match else None


def calculate_dosage(query: str, chunks: list[ChunkRecord]) -> ParsedDosage | None:
    weight_kg = parse_weight_kg(query)
    if weight_kg is None:
        return None

    matching_lines: list[tuple[str, str | None]] = []
    fallback_lines: list[tuple[str, str | None]] = []

    for chunk in chunks:
        for line in chunk.text.splitlines():
            lowered_line = line.lower()
            if "mg" not in lowered_line:
                continue
            medication = _guess_medication_name(query, line)
            if medication:
                matching_lines.append((line, medication))
            fallback_lines.append((line, medication))

    matched_formula = _match_dosage_line(matching_lines, weight_kg)
    if matched_formula:
        return matched_formula

    if matching_lines:
        return ParsedDosage(
            medication=matching_lines[0][1],
            weight_kg=weight_kg,
            formula=None,
            dose_mg=None,
            dose_range_mg=None,
            note="The requested medication was found, but no explicit mg/kg dosing formula was present in the retrieved lines.",
        )

    matched_fallback = _match_dosage_line(fallback_lines, weight_kg)
    if matched_fallback:
        return matched_fallback

    return ParsedDosage(
        medication=None,
        weight_kg=weight_kg,
        formula=None,
        dose_mg=None,
        dose_range_mg=None,
        note="Weight was detected, but no explicit mg/kg dosing formula was found in the retrieved guideline chunks.",
    )


def _guess_medication_name(query: str, text: str) -> str | None:
    query_words = [word for word in QUERY_TOKEN_RE.findall(query)]
    lowered_text = text.lower()
    for word in query_words:
        if len(word) <= 3 or word.lower() in STOPWORDS:
            continue
        if re.search(rf"\b{re.escape(word.lower())}\b", lowered_text):
            return word
    return None


def _match_dosage_line(lines: list[tuple[str, str | None]], weight_kg: float) -> ParsedDosage | None:
    for line, medication in lines:
        match = DOSAGE_RE.search(line)
        if not match:
            continue
        if match.group(1) and match.group(2):
            low = round(float(match.group(1)) * weight_kg, 2)
            high = round(float(match.group(2)) * weight_kg, 2)
            return ParsedDosage(
                medication=medication,
                weight_kg=weight_kg,
                formula=f"{match.group(1)}-{match.group(2)} mg/kg",
                dose_mg=None,
                dose_range_mg=[low, high],
                note="Calculated from retrieved mg/kg dosing text. Final clinical verification is still required.",
            )

        mg_per_kg = float(match.group(3))
        return ParsedDosage(
            medication=medication,
            weight_kg=weight_kg,
            formula=f"{mg_per_kg} mg/kg",
            dose_mg=round(mg_per_kg * weight_kg, 2),
            dose_range_mg=None,
            note="Calculated from retrieved mg/kg dosing text. Final clinical verification is still required.",
        )
    return None
