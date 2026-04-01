import type { ChannelMessage } from "./types.ts";

export function parseTelegramWebhook(payload: Record<string, unknown>): ChannelMessage {
  const maybeMessage = payload.message ?? payload.edited_message ?? {};
  const message = isRecord(maybeMessage) ? maybeMessage : {};
  const maybeFrom = message.from ?? {};
  const from = isRecord(maybeFrom) ? maybeFrom : {};
  const text = typeof message.text === "string" ? message.text : null;
  const userId = from.id !== undefined && from.id !== null ? String(from.id) : null;

  return {
    channel: "telegram",
    user_id: userId,
    text,
    message_type: typeof text === "string" ? "text" : "unknown",
    raw_payload: payload,
  };
}

export function determineTelegramRoute(text?: string | null): "community" | "clinical" {
  if (!text) {
    return "community";
  }
  return text.trim().toLowerCase().startsWith("/clinical") ? "clinical" : "community";
}

export function stripTelegramCommand(text?: string | null): string | null {
  if (!text) {
    return null;
  }
  const cleaned = text.trim();
  if (cleaned.toLowerCase().startsWith("/clinical")) {
    return cleaned.slice("/clinical".length).trim() || null;
  }
  if (cleaned.toLowerCase().startsWith("/community")) {
    return cleaned.slice("/community".length).trim() || null;
  }
  return cleaned;
}

export async function sendTelegramMessage(botToken: string, to: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: to, text }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${detail}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
