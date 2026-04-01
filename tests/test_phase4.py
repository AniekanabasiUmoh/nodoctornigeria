from __future__ import annotations

import os
import unittest
from pathlib import Path

os.environ["DATA_PROVIDER"] = "local"
os.environ["ENABLE_GEMINI_ASSIST"] = "false"

from fastapi.testclient import TestClient

from nstg_ai.api import app
from nstg_ai.cli import _resolve_webhook_url
from nstg_ai.channels import determine_telegram_route, parse_telegram_webhook, parse_twilio_webhook
from nstg_ai.providers import NullMessenger, get_telegram_clinical_messenger, get_telegram_messenger, get_twilio_messenger
from nstg_ai.service import get_audit_store
from nstg_ai.settings import AppSettings


class Phase4TestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)
        cls.audit_store = get_audit_store()
        if hasattr(cls.audit_store, "clear_all"):
            cls.audit_store.clear_all()

    def test_settings_default_provider_is_valid(self) -> None:
        settings = AppSettings.from_env()
        self.assertIn(settings.data_provider, {"local", "supabase"})

    def test_twilio_parser_and_webhook(self) -> None:
        parsed = parse_twilio_webhook(b"Body=What+helps+acute+diarrhoea%3F&From=whatsapp%3A%2B234000&NumMedia=0")
        self.assertEqual(parsed.channel, "twilio_whatsapp")
        self.assertEqual(parsed.text, "What helps acute diarrhoea?")

        response = self.client.post(
            "/webhook/twilio/whatsapp",
            content="Body=What+helps+acute+diarrhoea%3F&From=whatsapp%3A%2B234000&NumMedia=0",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "accepted")
        self.assertIsNotNone(response.json()["job_id"])

    def test_telegram_parser_and_webhook(self) -> None:
        payload = {"message": {"text": "/clinical malaria treatment artemether lumefantrine", "from": {"id": 12345}}}
        parsed = parse_telegram_webhook(payload)
        self.assertEqual(parsed.channel, "telegram")
        self.assertEqual(determine_telegram_route(parsed.text), "clinical")

        settings = AppSettings.from_env()
        headers = {}
        if settings.telegram_webhook_secret:
            headers["X-Telegram-Bot-Api-Secret-Token"] = settings.telegram_webhook_secret

        response = self.client.post("/webhook/telegram", json=payload, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "accepted")
        self.assertEqual(response.json()["channel"], "telegram")
        self.assertIsNotNone(response.json()["preview"])

    def test_separate_telegram_webhooks_route_without_command_prefix(self) -> None:
        settings = AppSettings.from_env()
        headers = {}
        if settings.telegram_webhook_secret:
            headers["X-Telegram-Bot-Api-Secret-Token"] = settings.telegram_webhook_secret

        clinical_payload = {"message": {"text": "malaria treatment artemether lumefantrine", "from": {"id": 12345}}}
        clinical_response = self.client.post("/webhook/telegram/clinical", json=clinical_payload, headers=headers)
        self.assertEqual(clinical_response.status_code, 200)
        self.assertEqual(clinical_response.json()["status"], "accepted")

        community_payload = {"message": {"text": "What helps acute diarrhoea?", "from": {"id": 12345}}}
        community_response = self.client.post("/webhook/telegram/community", json=community_payload, headers=headers)
        self.assertEqual(community_response.status_code, 200)
        self.assertEqual(community_response.json()["status"], "accepted")

        items = self.audit_store.list_interactions(limit=10)
        self.assertTrue(any(item.channel == "telegram_clinical" and item.route == "/webhook/telegram/clinical" for item in items))
        self.assertTrue(any(item.channel == "telegram_community" and item.route == "/webhook/telegram/community" for item in items))

    def test_home_page_renders(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("NSTG Medical AI Assistant", response.text)
        self.assertIn("Ask Community Bot", response.text)
        self.assertIn("Review Queue", response.text)

    def test_review_queue_endpoint_and_status_update(self) -> None:
        created = self.client.post(
            "/api/community/query",
            json={"query": "My child is having convulsions and cannot drink."},
        )
        self.assertEqual(created.status_code, 200)
        interaction_id = created.json()["interaction_id"]

        listed = self.client.get("/api/review/interactions", params={"review_required_only": "true"})
        self.assertEqual(listed.status_code, 200)
        payload = listed.json()
        self.assertGreaterEqual(payload["summary"]["review_required_items"], 1)
        self.assertTrue(any(item["interaction_id"] == interaction_id for item in payload["items"]))

        updated = self.client.post(
            f"/api/review/interactions/{interaction_id}/status",
            json={"review_status": "approved"},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["review_status"], "approved")
        self.assertEqual(updated.json()["trace"]["operator_review_status"], "approved")

    def test_provider_stubs_without_credentials(self) -> None:
        settings = AppSettings(
            environment="test",
            app_name="NSTG Medical AI Assistant",
            data_provider="local",
            enable_gemini_assist=False,
            gemini_api_key=None,
            gemini_model="gemini-2.5-flash-lite",
            audit_storage_dir=Path("build/audit"),
            public_base_url=None,
            supabase_url=None,
            supabase_service_role_key=None,
            supabase_schema="public",
            twilio_account_sid=None,
            twilio_auth_token=None,
            twilio_whatsapp_number=None,
            telegram_bot_token=None,
            telegram_bot_token_clinical=None,
            telegram_webhook_secret=None,
        )
        twilio = get_twilio_messenger(settings)
        telegram = get_telegram_messenger(settings)
        clinical_telegram = get_telegram_clinical_messenger(settings)
        self.assertIsInstance(twilio, NullMessenger)
        self.assertIsInstance(telegram, NullMessenger)
        self.assertIsInstance(clinical_telegram, NullMessenger)
        self.assertEqual(twilio.send_text(to="x", text="hello").status, "skipped")
        self.assertEqual(telegram.send_text(to="x", text="hello").status, "skipped")
        self.assertEqual(clinical_telegram.send_text(to="x", text="hello").status, "skipped")

    def test_phase4_artifacts_exist(self) -> None:
        self.assertTrue(Path(".env.example").exists())
        self.assertTrue(Path("Dockerfile").exists())
        self.assertTrue(Path("supabase/migrations/001_phase4_core.sql").exists())
        self.assertTrue(Path("supabase/migrations/002_phase5_jobs_and_analytics.sql").exists())
        self.assertTrue(Path("supabase/migrations/003_guideline_chunks_and_search.sql").exists())
        self.assertTrue(Path("supabase/migrations/004_phase2_async_job_payload.sql").exists())
        self.assertTrue(Path("supabase/migrations/005_phase3_audit_trace.sql").exists())
        self.assertTrue(Path("supabase/functions/api/index.ts").exists())
        self.assertTrue(Path("supabase/config.toml").exists())

    def test_public_webhook_url_resolution(self) -> None:
        self.assertEqual(
            _resolve_webhook_url("https://api.example.com"),
            "https://api.example.com/webhook/telegram",
        )
        self.assertEqual(
            _resolve_webhook_url("https://api.example.com", route="community"),
            "https://api.example.com/webhook/telegram/community",
        )
        self.assertEqual(
            _resolve_webhook_url("https://api.example.com", route="clinical"),
            "https://api.example.com/webhook/telegram/clinical",
        )
        with self.assertRaises(SystemExit):
            _resolve_webhook_url("http://localhost:8000")


if __name__ == "__main__":
    unittest.main()
