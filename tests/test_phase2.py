from __future__ import annotations

import os
import unittest
from pathlib import Path

os.environ["DATA_PROVIDER"] = "local"
os.environ["ENABLE_GEMINI_ASSIST"] = "false"

from fastapi.testclient import TestClient

from nstg_ai.api import app
from nstg_ai.pipeline import build_condition_directory_chunks, write_chunks_jsonl
from nstg_ai.retrieval import LexicalRetriever, _prepare_supabase_search_query, normalize_query_text
from nstg_ai.service import QueryEngine, get_default_engine
from nstg_ai.triage import assess_triage


class FakeAssistant:
    def rewrite_query(self, query: str, *, audience: str) -> str:
        return query

    def normalize_community_triage(self, query: str) -> str:
        if query.lower() == "my child body is jerking badly":
            return "child having convulsion"
        return query

    def summarize_chunk(self, *, query: str, audience: str, chunk, dosage_line=None):
        return None


class Phase2TestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        chunk_path = Path("build/nstg_dataset_chunks.jsonl")
        if not chunk_path.exists():
            dataset_dir = Path("nigeria-clinical-guidelines-dataset-main/processed_json")
            chunks = build_condition_directory_chunks(dataset_dir)
            write_chunks_jsonl(chunks, chunk_path)
        cls.engine = QueryEngine(LexicalRetriever.from_jsonl(chunk_path))
        cls.client = TestClient(app)

    def test_retriever_finds_malaria_content(self) -> None:
        response = self.engine.answer_clinician("malaria treatment artemether lumefantrine", top_k=3)
        self.assertEqual(response.disposition, "ANSWER")
        self.assertTrue(any(citation.condition == "Malaria" for citation in response.citations))

    def test_community_triage_escalates_danger_signs(self) -> None:
        triage = assess_triage("My child is having convulsions and cannot drink anything")
        self.assertEqual(triage.disposition, "EMERGENCY_ESCALATE")

        response = self.engine.answer_community("My child is having convulsions and cannot drink anything")
        self.assertEqual(response.disposition, "EMERGENCY_ESCALATE")
        self.assertIn("What To Do Now:", response.answer)
        self.assertIn("Lay the child on the side", response.answer)
        self.assertIn("Do not put anything in the mouth", response.answer)
        self.assertIn("Go to the nearest hospital", response.answer)

    def test_community_triage_can_use_normalized_phrase_before_rules(self) -> None:
        engine = QueryEngine(self.engine.retriever, assistant=FakeAssistant())
        response = engine.answer_community("My child body is jerking badly")
        self.assertEqual(response.disposition, "EMERGENCY_ESCALATE")
        self.assertEqual(response.triage, "EMERGENCY_ESCALATE")
        self.assertIn("convulsion or seizure", response.answer.lower())

    def test_triage_normalizes_dialect_and_noisy_emergency_phrases(self) -> None:
        triage = assess_triage("Pikin dey shake and no dey wake")
        self.assertEqual(triage.disposition, "EMERGENCY_ESCALATE")
        self.assertIn("convulsion", triage.matched_terms)
        self.assertIn("unconscious", triage.matched_terms)

        shaking_triage = assess_triage("My child body is shaking")
        self.assertEqual(shaking_triage.disposition, "EMERGENCY_ESCALATE")
        self.assertIn("convulsion", shaking_triage.matched_terms)

        jerking_triage = assess_triage("My child body is jerking badly")
        self.assertEqual(jerking_triage.disposition, "EMERGENCY_ESCALATE")
        self.assertIn("convulsion", jerking_triage.matched_terms)

        breathing_triage = assess_triage("The child is gasping and turning blue")
        self.assertEqual(breathing_triage.disposition, "EMERGENCY_ESCALATE")
        self.assertIn("respiratory_distress", breathing_triage.matched_terms)

    def test_triage_escalates_uncertain_red_flags_conservatively(self) -> None:
        triage = assess_triage("He has severe stomach pain and blood in stool")
        self.assertEqual(triage.disposition, "UNCERTAIN_ESCALATE")
        self.assertIn("severe_abdominal_pain", triage.matched_terms)
        self.assertIn("bloody_diarrhoea", triage.matched_terms)

    def test_clinician_query_can_compute_dose(self) -> None:
        response = self.engine.answer_clinician("Aminophylline dose for a 15 kg child with pulmonary oedema", top_k=5)
        self.assertEqual(response.disposition, "ANSWER")
        self.assertIsNotNone(response.dosage)
        self.assertEqual(response.dosage.dose_mg, 75.0)

    def test_clinician_treatment_query_prefers_treatment_chunk(self) -> None:
        response = self.engine.answer_clinician("malaria treatment for 18 kg child", top_k=5)
        self.assertEqual(response.disposition, "ANSWER")
        self.assertIn("Condition: Malaria", response.answer)
        self.assertIn("Section: Treatment", response.answer)
        self.assertIn("Citation: Malaria -> Treatment", response.answer)
        self.assertIn("Summary:", response.answer)
        self.assertIn("Action:", response.answer)

    def test_community_treatment_query_prefers_treatment_chunk(self) -> None:
        response = self.engine.answer_community("malaria treatment for 18 kg child", top_k=5)
        self.assertEqual(response.disposition, "ANSWER")
        self.assertIn("Condition: Malaria", response.answer)
        self.assertIn("Section: Treatment", response.answer)
        self.assertIn("What To Do Now:", response.answer)
        self.assertIn("- ", response.answer)
        self.assertIn("Citation: Malaria -> Treatment", response.answer)

    def test_clinician_query_asks_to_clarify_when_weight_is_missing(self) -> None:
        response = self.engine.answer_clinician("Aminophylline dose for child with pulmonary oedema", top_k=5)
        self.assertEqual(response.disposition, "ASK_CLARIFY")
        self.assertIsNotNone(response.follow_up_question)
        self.assertIn("weight in kg", response.follow_up_question.lower())

    def test_clinician_query_asks_to_clarify_when_typo_dosage_weight_is_missing(self) -> None:
        response = self.engine.answer_clinician("tyhoid doosage for child", top_k=5)
        self.assertEqual(response.disposition, "ASK_CLARIFY")
        self.assertIn("weight in kg", response.follow_up_question.lower())

    def test_clinician_answer_is_spaced_for_fast_scanning(self) -> None:
        response = self.engine.answer_clinician("malaria treatment for 18 kg child", top_k=5)
        self.assertIn("Action:\n\n- ", response.answer)
        self.assertIn("Summary:\n\n- ", response.answer)

    def test_community_answer_uses_simple_bullets(self) -> None:
        response = self.engine.answer_community("malaria treatment for child", top_k=5)
        self.assertEqual(response.disposition, "ANSWER")
        self.assertIn("What To Do Now:", response.answer)
        self.assertIn("- ", response.answer)

    def test_clinician_query_does_not_mix_drug_formulas(self) -> None:
        response = self.engine.answer_clinician("Furosemide dose for a 15 kg child with pulmonary oedema", top_k=5)
        self.assertEqual(response.disposition, "ANSWER")
        self.assertIsNotNone(response.dosage)
        self.assertIsNone(response.dosage.dose_mg)
        self.assertIn("no explicit mg/kg dosing formula", response.dosage.note.lower())

    def test_community_query_asks_to_clarify_when_too_vague(self) -> None:
        response = self.engine.answer_community("fever", top_k=3)
        self.assertEqual(response.disposition, "ASK_CLARIFY")
        self.assertIsNotNone(response.follow_up_question)
        self.assertIn("age or weight", response.follow_up_question.lower())

    def test_api_health(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_api_community_query(self) -> None:
        response = self.client.post("/api/community/query", json={"query": "What helps acute diarrhoea?", "top_k": 3})
        self.assertEqual(response.status_code, 200)
        self.assertIn(response.json()["disposition"], {"ANSWER", "INSUFFICIENT_EVIDENCE"})

    def test_api_voice_job_flow(self) -> None:
        create_response = self.client.post(
            "/api/community/voice-jobs",
            json={"query": "What helps acute diarrhoea?", "top_k": 3},
        )
        self.assertEqual(create_response.status_code, 202)
        self.assertEqual(create_response.json()["status"], "queued")

        job_id = create_response.json()["job_id"]

        process_response = self.client.post(f"/api/jobs/{job_id}/process")
        self.assertEqual(process_response.status_code, 200)
        self.assertEqual(process_response.json()["status"], "completed")

        status_response = self.client.get(f"/api/jobs/{job_id}")
        self.assertEqual(status_response.status_code, 200)
        self.assertEqual(status_response.json()["status"], "completed")
        self.assertIsNotNone(status_response.json()["result"])

    def test_supabase_query_preparation_removes_noisy_terms(self) -> None:
        prepared = _prepare_supabase_search_query("artemether lumefantrine dose for malaria in 15kg child")
        self.assertEqual(prepared, "artemether lumefantrine dose malaria")

    def test_query_normalization_corrects_common_typos(self) -> None:
        prepared = _prepare_supabase_search_query("tyhoid doosage for child")
        self.assertEqual(prepared, "typhoid dosage")
        self.assertEqual(normalize_query_text("tyhoid doosage"), "typhoid dosage")


if __name__ == "__main__":
    unittest.main()
