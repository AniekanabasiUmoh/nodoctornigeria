from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

os.environ["DATA_PROVIDER"] = "local"
os.environ["ENABLE_GEMINI_ASSIST"] = "false"

from fastapi.testclient import TestClient

from nstg_ai.api import app
from nstg_ai.evaluation import load_evaluation_cases, run_evaluation
from nstg_ai.pipeline import build_condition_directory_chunks, write_chunks_jsonl
from nstg_ai.retrieval import LexicalRetriever
from nstg_ai.service import QueryEngine, get_audit_store


class Phase3TestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        chunk_path = Path("build/nstg_dataset_chunks.jsonl")
        if not chunk_path.exists():
            dataset_dir = Path("nigeria-clinical-guidelines-dataset-main/processed_json")
            chunks = build_condition_directory_chunks(dataset_dir)
            write_chunks_jsonl(chunks, chunk_path)

        cls.engine = QueryEngine(LexicalRetriever.from_jsonl(chunk_path))
        cls.client = TestClient(app)
        cls.audit_store = get_audit_store()

    def setUp(self) -> None:
        self.audit_store.clear_all()

    def test_api_interactions_are_audited(self) -> None:
        before = self.audit_store.count_interactions()
        response = self.client.post("/api/clinical/query", json={"query": "malaria treatment artemether lumefantrine"})
        self.assertEqual(response.status_code, 200)
        interaction_id = response.json()["interaction_id"]
        self.assertIsNotNone(interaction_id)
        self.assertGreaterEqual(self.audit_store.count_interactions(), before + 1)

        matching = next(
            item for item in self.audit_store.list_interactions(limit=10)
            if item.interaction_id == interaction_id
        )
        self.assertEqual(matching.normalized_query, "malaria treatment artemether lumefantrine")
        self.assertEqual(matching.trace.final_disposition, "ANSWER")
        self.assertGreaterEqual(len(matching.trace.retrieved_chunks), 1)
        self.assertEqual(matching.trace.model_version, "deterministic-rag-v1")

    def test_emergency_interaction_captures_triage_terms(self) -> None:
        response = self.client.post("/api/community/query", json={"query": "My child is convulsing and cannot drink."})
        self.assertEqual(response.status_code, 200)
        latest = self.audit_store.latest_interaction()
        self.assertIsNotNone(latest)
        self.assertEqual(latest["trace"]["final_disposition"], "EMERGENCY_ESCALATE")
        self.assertGreaterEqual(len(latest["trace"]["triage_matched_terms"]), 1)

    def test_feedback_can_be_attached_to_logged_interaction(self) -> None:
        query_response = self.client.post("/api/community/query", json={"query": "What helps acute diarrhoea?"})
        self.assertEqual(query_response.status_code, 200)
        interaction_id = query_response.json()["interaction_id"]

        feedback_response = self.client.post(
            "/api/feedback",
            json={"interaction_id": interaction_id, "rating": "up", "comment": "Helpful"},
        )
        self.assertEqual(feedback_response.status_code, 200)
        self.assertEqual(feedback_response.json()["interaction_id"], interaction_id)
        self.assertGreaterEqual(self.audit_store.count_feedback(), 1)

    def test_evaluation_harness_passes_local_cases(self) -> None:
        cases = load_evaluation_cases(Path("sample_data/phase3_eval_cases.json"))
        report = run_evaluation(self.engine, cases)
        self.assertEqual(report.failed_cases, 0)
        self.assertEqual(report.total_cases, 5)
        self.assertGreaterEqual(report.metrics["condition_hit_rate"], 0.75)
        self.assertGreaterEqual(report.metrics["retrieval_recall"], 0.75)
        self.assertGreaterEqual(report.metrics["citation_presence_rate"], 0.75)
        self.assertGreaterEqual(report.metrics["triage_recall"], 1.0)


if __name__ == "__main__":
    unittest.main()
