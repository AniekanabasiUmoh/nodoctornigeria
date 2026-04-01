from __future__ import annotations

import json
import unittest
from pathlib import Path

from nstg_ai.pipeline import (
    build_chunks,
    build_condition_chunks,
    load_condition_record,
    load_document,
    write_chunks_jsonl,
)
from nstg_ai.phase1 import build_phase1_audit_report, write_phase1_audit_report


class PipelineTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.sample_path = Path("sample_data/nstg_sample.json")

    def test_build_chunks_preserves_lineage_and_metadata(self) -> None:
        document = load_document(self.sample_path)
        chunks = build_chunks(document)

        self.assertEqual(len(chunks), 2)

        pediatric_chunk = chunks[0]
        self.assertEqual(pediatric_chunk.metadata.chapter, "Malaria")
        self.assertEqual(pediatric_chunk.metadata.section, "Uncomplicated Malaria")
        self.assertEqual(pediatric_chunk.metadata.subsection, "Pediatric Treatment")
        self.assertEqual(pediatric_chunk.metadata.condition, "Malaria")
        self.assertEqual(pediatric_chunk.metadata.demographic, "Pediatric")
        self.assertIn("First trimester", pediatric_chunk.metadata.contraindications)
        self.assertTrue(pediatric_chunk.text.startswith("Malaria > Uncomplicated Malaria > Pediatric Treatment"))

    def test_write_chunks_jsonl(self) -> None:
        document = load_document(self.sample_path)
        chunks = build_chunks(document)
        output_dir = Path("build/test_outputs")
        output_path = output_dir / "chunks.jsonl"

        write_chunks_jsonl(chunks, output_path)

        lines = output_path.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 2)

        payload = json.loads(lines[0])
        self.assertIn("chunk_id", payload)
        self.assertIn("metadata", payload)

    def test_build_condition_chunks_from_real_dataset_shape(self) -> None:
        condition = load_condition_record(
            Path("nigeria-clinical-guidelines-dataset-main/processed_json/ACUTE DIARRHOEA.json")
        )
        chunks = build_condition_chunks(condition, source_file="ACUTE DIARRHOEA.json")

        self.assertGreaterEqual(len(chunks), 6)

        introduction_chunk = chunks[0]
        self.assertEqual(introduction_chunk.metadata.condition, "Acute Diarrhoea")
        self.assertEqual(introduction_chunk.metadata.section, "Introduction")
        self.assertEqual(introduction_chunk.metadata.source_file, "ACUTE DIARRHOEA.json")

        treatment_chunks = [chunk for chunk in chunks if chunk.metadata.section == "Treatment"]
        self.assertTrue(any(chunk.metadata.subsection == "Drug" for chunk in treatment_chunks))

    def test_phase1_audit_report_covers_dataset_and_raw_text(self) -> None:
        report = build_phase1_audit_report(
            processed_json_dir=Path("nigeria-clinical-guidelines-dataset-main/processed_json"),
            raw_text_dir=Path("nigeria-clinical-guidelines-dataset-main/raw data/NSTG 2022"),
        )

        self.assertGreater(report.total_conditions, 200)
        self.assertGreaterEqual(report.total_conditions, report.unique_conditions)
        self.assertGreater(report.total_chunks, report.total_conditions)
        self.assertEqual(report.duplicate_chunk_ids, 0)
        self.assertGreater(len(report.duplicate_condition_slugs), 0)
        self.assertGreater(len(report.duplicate_condition_files), 0)
        self.assertGreaterEqual(report.source_coverage_ratio, 0.95)
        self.assertIn("treatment_drug", report.section_presence)

    def test_phase1_audit_report_can_be_written(self) -> None:
        report = build_phase1_audit_report(
            processed_json_dir=Path("nigeria-clinical-guidelines-dataset-main/processed_json"),
        )
        output_path = Path("build/test_outputs/phase1_audit_report.json")
        write_phase1_audit_report(report, output_path)

        payload = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["total_conditions"], report.total_conditions)
        self.assertIn("section_presence", payload)


if __name__ == "__main__":
    unittest.main()
