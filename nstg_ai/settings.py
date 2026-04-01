from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class AppSettings:
    environment: str
    app_name: str
    data_provider: str
    enable_gemini_assist: bool
    gemini_api_key: str | None
    gemini_model: str
    audit_storage_dir: Path
    public_base_url: str | None
    supabase_url: str | None
    supabase_service_role_key: str | None
    supabase_schema: str
    twilio_account_sid: str | None
    twilio_auth_token: str | None
    twilio_whatsapp_number: str | None
    telegram_bot_token: str | None
    telegram_bot_token_clinical: str | None
    telegram_webhook_secret: str | None

    @classmethod
    def from_env(cls) -> "AppSettings":
        repo_root = Path(__file__).resolve().parent.parent
        load_dotenv(repo_root / ".env")
        build_dir = repo_root / "build"
        return cls(
            environment=os.getenv("APP_ENV", "development"),
            app_name=os.getenv("APP_NAME", "NSTG Medical AI Assistant"),
            data_provider=os.getenv("DATA_PROVIDER", "supabase").lower(),
            enable_gemini_assist=os.getenv("ENABLE_GEMINI_ASSIST", "false").strip().lower() in {"1", "true", "yes", "on"},
            gemini_api_key=os.getenv("GEMINI_API_KEY"),
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite"),
            audit_storage_dir=Path(os.getenv("AUDIT_STORAGE_DIR", build_dir / "audit")),
            public_base_url=os.getenv("PUBLIC_BASE_URL"),
            supabase_url=os.getenv("SUPABASE_URL"),
            supabase_service_role_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
            supabase_schema=os.getenv("SUPABASE_SCHEMA", "public"),
            twilio_account_sid=os.getenv("TWILIO_ACCOUNT_SID"),
            twilio_auth_token=os.getenv("TWILIO_AUTH_TOKEN"),
            twilio_whatsapp_number=os.getenv("TWILIO_WHATSAPP_NUMBER"),
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN"),
            telegram_bot_token_clinical=os.getenv("TELEGRAM_BOT_TOKEN_CLINICAL"),
            telegram_webhook_secret=os.getenv("TELEGRAM_WEBHOOK_SECRET"),
        )


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    return AppSettings.from_env()
