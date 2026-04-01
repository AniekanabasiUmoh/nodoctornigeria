from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import parse_qs


@dataclass(slots=True)
class ChannelMessage:
    channel: str
    user_id: str | None
    text: str | None
    message_type: str
    raw_payload: dict[str, object]


def parse_twilio_webhook(body: bytes) -> ChannelMessage:
    parsed = parse_qs(body.decode("utf-8"), keep_blank_values=True)
    text = _first(parsed.get("Body"))
    num_media = _first(parsed.get("NumMedia")) or "0"
    message_type = "media" if num_media != "0" else "text"
    return ChannelMessage(
        channel="twilio_whatsapp",
        user_id=_first(parsed.get("From")),
        text=text,
        message_type=message_type,
        raw_payload={key: values[0] if len(values) == 1 else values for key, values in parsed.items()},
    )


def parse_telegram_webhook(payload: dict[str, object]) -> ChannelMessage:
    message = payload.get("message") or payload.get("edited_message") or {}
    if not isinstance(message, dict):
        message = {}
    text = message.get("text")
    from_user = message.get("from") or {}
    user_id = None
    if isinstance(from_user, dict) and from_user.get("id") is not None:
        user_id = str(from_user["id"])
    return ChannelMessage(
        channel="telegram",
        user_id=user_id,
        text=text if isinstance(text, str) else None,
        message_type="text" if isinstance(text, str) else "unknown",
        raw_payload=payload,
    )


def determine_telegram_route(text: str | None) -> str:
    if not text:
        return "community"
    return "clinical" if text.strip().lower().startswith("/clinical") else "community"


def strip_telegram_command(text: str | None) -> str | None:
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.lower().startswith("/clinical"):
        return cleaned[len("/clinical") :].strip() or None
    if cleaned.lower().startswith("/community"):
        return cleaned[len("/community") :].strip() or None
    return cleaned


def _first(values: list[str] | None) -> str | None:
    return values[0] if values else None
