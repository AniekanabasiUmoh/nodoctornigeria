from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, Field

from .service import QueryEngine, get_default_engine


class EvaluationCase(BaseModel):
    name: str
    mode: str
    query: str
    top_k: int = Field(default=5, ge=1, le=10)
    expected_disposition: str | None = None
    expected_condition: str | None = None
    expected_dose_mg: float | None = None
    expect_dose_absent: bool = False


class EvaluationResult(BaseModel):
    name: str
    passed: bool
    checks: dict[str, bool]
    actual_disposition: str
    actual_top_condition: str | None = None
    actual_dose_mg: float | None = None
    actual_citation_count: int = 0
    review_required: bool = False


class EvaluationReport(BaseModel):
    total_cases: int
    passed_cases: int
    failed_cases: int
    pass_rate: float
    metrics: dict[str, float]
    results: list[EvaluationResult]


def load_evaluation_cases(path: str | Path) -> list[EvaluationCase]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return [EvaluationCase.model_validate(item) for item in payload]


def run_evaluation(engine: QueryEngine, cases: list[EvaluationCase]) -> EvaluationReport:
    results: list[EvaluationResult] = []
    disposition_passes = 0
    retrieval_precision_passes = 0
    retrieval_recall_passes = 0
    dosage_passes = 0
    dosage_checks = 0
    citation_presence_passes = 0
    citation_presence_checks = 0
    refusal_passes = 0
    refusal_checks = 0
    triage_passes = 0
    triage_checks = 0
    faithfulness_proxy_passes = 0
    faithfulness_proxy_checks = 0

    for case in cases:
        run_result = (
            engine.run_community(case.query, top_k=case.top_k)
            if case.mode == "community"
            else engine.run_clinician(case.query, top_k=case.top_k)
        )
        response = run_result.response

        top_condition = response.citations[0].condition if response.citations else None
        actual_dose = response.dosage.dose_mg if response.dosage else None
        citation_count = len(response.citations)

        checks: dict[str, bool] = {}
        if case.expected_disposition is not None:
            checks["disposition"] = response.disposition == case.expected_disposition
            disposition_passes += int(checks["disposition"])
        if case.expected_condition is not None:
            checks["condition"] = top_condition == case.expected_condition
            retrieval_precision_passes += int(checks["condition"])
            checks["condition_recall"] = any(citation.condition == case.expected_condition for citation in response.citations)
            retrieval_recall_passes += int(checks["condition_recall"])
        if case.expected_dose_mg is not None:
            checks["dose"] = actual_dose == case.expected_dose_mg
            dosage_passes += int(checks["dose"])
            dosage_checks += 1
        if case.expect_dose_absent:
            checks["dose_absent"] = actual_dose is None
            dosage_passes += int(checks["dose_absent"])
            dosage_checks += 1

        if case.expected_disposition == "ANSWER":
            citation_presence_checks += 1
            citation_presence_passes += int(citation_count > 0)
            faithfulness_proxy_checks += 1
            faithfulness_proxy_passes += int(citation_count > 0 and len(run_result.trace.retrieved_chunks) > 0)

        if case.expected_disposition in {"INSUFFICIENT_EVIDENCE", "ASK_CLARIFY", "EMERGENCY_ESCALATE", "UNCERTAIN_ESCALATE"}:
            refusal_checks += 1
            refusal_passes += int(response.disposition == case.expected_disposition)

        if case.expected_disposition in {"EMERGENCY_ESCALATE", "UNCERTAIN_ESCALATE"}:
            triage_checks += 1
            triage_passes += int(response.disposition == case.expected_disposition)

        passed = all(checks.values()) if checks else True
        results.append(
            EvaluationResult(
                name=case.name,
                passed=passed,
                checks=checks,
                actual_disposition=response.disposition,
                actual_top_condition=top_condition,
                actual_dose_mg=actual_dose,
                actual_citation_count=citation_count,
                review_required=run_result.trace.review_required,
            )
        )

    total_cases = len(results)
    passed_cases = sum(result.passed for result in results)
    metrics = {
        "disposition_accuracy": round(disposition_passes / max(1, sum("disposition" in r.checks for r in results)), 4),
        "retrieval_precision": round(retrieval_precision_passes / max(1, sum("condition" in r.checks for r in results)), 4),
        "retrieval_recall": round(retrieval_recall_passes / max(1, sum("condition_recall" in r.checks for r in results)), 4),
        "condition_hit_rate": round(retrieval_precision_passes / max(1, sum("condition" in r.checks for r in results)), 4),
        "citation_correctness": round(retrieval_recall_passes / max(1, sum("condition_recall" in r.checks for r in results)), 4),
        "citation_presence_rate": round(citation_presence_passes / max(1, citation_presence_checks), 4),
        "faithfulness_proxy": round(faithfulness_proxy_passes / max(1, faithfulness_proxy_checks), 4),
        "refusal_accuracy": round(refusal_passes / max(1, refusal_checks), 4),
        "triage_recall": round(triage_passes / max(1, triage_checks), 4),
        "deterministic_calculation_correctness": round(dosage_passes / max(1, dosage_checks), 4),
        "dosage_accuracy": round(dosage_passes / max(1, dosage_checks), 4),
    }
    return EvaluationReport(
        total_cases=total_cases,
        passed_cases=passed_cases,
        failed_cases=total_cases - passed_cases,
        pass_rate=round(passed_cases / max(1, total_cases), 4),
        metrics=metrics,
        results=results,
    )


def write_evaluation_report(report: EvaluationReport, output_path: str | Path) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    return path


def run_default_evaluation(
    *,
    cases_path: str | Path,
    output_path: str | Path,
    engine: QueryEngine | None = None,
) -> Path:
    eval_engine = engine or get_default_engine()
    cases = load_evaluation_cases(cases_path)
    report = run_evaluation(eval_engine, cases)
    return write_evaluation_report(report, output_path)
