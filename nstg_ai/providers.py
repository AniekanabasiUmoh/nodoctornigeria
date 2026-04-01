from __future__ import annotations

from dataclasses import dataclass

import httpx

from .settings import AppSettings, get_settings


@dataclass(frozen=True)
class SendResult:
    provider: str
    status: str
    detail: str | None = None


class BaseMessenger:
    provider_name = "base"

    def send_text(self, *, to: str, text: str) -> SendResult:
        raise NotImplementedError


class NullMessenger(BaseMessenger):
    provider_name = "null"

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def send_text(self, *, to: str, text: str) -> SendResult:
        return SendResult(provider=self.provider_name, status="skipped", detail=self.reason)


class TwilioWhatsAppMessenger(BaseMessenger):
    provider_name = "twilio_whatsapp"

    def __init__(self, *, account_sid: str, auth_token: str, from_number: str) -> None:
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.from_number = from_number

    def send_text(self, *, to: str, text: str) -> SendResult:
        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages.json"
        payload = {
            "From": self.from_number,
            "To": to,
            "Body": text,
        }
        with httpx.Client(auth=(self.account_sid, self.auth_token), timeout=20.0) as client:
            response = client.post(url, data=payload)
            response.raise_for_status()
        return SendResult(provider=self.provider_name, status="sent")


class TelegramMessenger(BaseMessenger):
    provider_name = "telegram"

    def __init__(self, *, bot_token: str) -> None:
        self.bot_token = bot_token

    def send_text(self, *, to: str, text: str) -> SendResult:
        url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        payload = {"chat_id": to, "text": text}
        with httpx.Client(timeout=20.0) as client:
            response = client.post(url, json=payload)
            response.raise_for_status()
        return SendResult(provider=self.provider_name, status="sent")


def get_twilio_messenger(settings: AppSettings | None = None) -> BaseMessenger:
    resolved = settings or get_settings()
    if not resolved.twilio_account_sid or not resolved.twilio_auth_token or not resolved.twilio_whatsapp_number:
        return NullMessenger("Twilio credentials are not configured yet.")
    return TwilioWhatsAppMessenger(
        account_sid=resolved.twilio_account_sid,
        auth_token=resolved.twilio_auth_token,
        from_number=resolved.twilio_whatsapp_number,
    )


def get_telegram_messenger(settings: AppSettings | None = None) -> BaseMessenger:
    resolved = settings or get_settings()
    if not resolved.telegram_bot_token:
        return NullMessenger("Telegram bot token is not configured yet.")
    return TelegramMessenger(bot_token=resolved.telegram_bot_token)


def get_telegram_clinical_messenger(settings: AppSettings | None = None) -> BaseMessenger:
    resolved = settings or get_settings()
    if not resolved.telegram_bot_token_clinical:
        return NullMessenger("Telegram clinical bot token is not configured yet.")
    return TelegramMessenger(bot_token=resolved.telegram_bot_token_clinical)
