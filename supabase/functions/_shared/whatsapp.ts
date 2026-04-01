/**
 * WhatsApp webhook handler and message utilities.
 * Supports Meta WhatsApp Business API.
 */

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      value?: {
        messaging_product?: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        messages?: Array<{
          from: string;
          id: string;
          timestamp?: string;
          type?: string;
          text?: {
            body: string;
          };
        }>;
        statuses?: Array<{
          id: string;
          status?: string;
          timestamp?: string;
          recipient_id?: string;
        }>;
      };
    }>;
  }>;
}

export interface WhatsAppMessage {
  user_id: string;
  message_id: string;
  text: string;
  timestamp: string;
  phone_number_id: string;
}

export function parseWhatsAppWebhook(payload: unknown): WhatsAppMessage | null {
  try {
    const data = payload as WhatsAppWebhookPayload;
    if (!data.entry || !Array.isArray(data.entry)) {
      return null;
    }

    for (const entry of data.entry) {
      if (!entry.changes || !Array.isArray(entry.changes)) {
        continue;
      }

      for (const change of entry.changes) {
        const value = change.value;
        if (!value?.messages || !Array.isArray(value.messages)) {
          continue;
        }

        const message = value.messages[0];
        if (!message || message.type !== "text" || !message.text?.body) {
          continue;
        }

        return {
          user_id: message.from || "",
          message_id: message.id || "",
          text: message.text.body,
          timestamp: message.timestamp || new Date().toISOString(),
          phone_number_id: value.metadata?.phone_number_id || "",
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function sendWhatsAppMessage(
  phoneNumberId: string,
  accessToken: string,
  recipientPhoneNumber: string,
  messageBody: string,
): Promise<{ message_id: string } | null> {
  try {
    const url = `https://graph.instagram.com/v18.0/${phoneNumberId}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipientPhoneNumber,
        type: "text",
        text: {
          preview_url: false,
          body: messageBody,
        },
      }),
    });

    if (!response.ok) {
      console.error("WhatsApp send failed:", await response.text());
      return null;
    }

    const result = (await response.json()) as { messages?: Array<{ id: string }> };
    const messageId = result.messages?.[0]?.id;
    if (messageId) {
      return { message_id: messageId };
    }
    return null;
  } catch (error) {
    console.error("WhatsApp send error:", error);
    return null;
  }
}

export function stripWhatsAppCommand(text: string): string {
  return text.trim();
}

/**
 * Smart WhatsApp truncation — preserves high-priority sections.
 * WhatsApp has a 4096 char limit, but we keep answers short for mobile UX.
 */
export function truncateForWhatsApp(text: string, maxChars = 1024): string {
  if (text.length <= maxChars) return text;

  // Try to drop the Source section first
  const sourceIdx = text.lastIndexOf("\nSource:");
  if (sourceIdx > 0 && sourceIdx < maxChars) {
    const withoutSource = text.slice(0, sourceIdx).trim();
    if (withoutSource.length <= maxChars) return withoutSource;
  }

  // Try to drop the Dose section next
  const doseIdx = text.lastIndexOf("\nDose:");
  if (doseIdx > 0 && doseIdx < maxChars) {
    const withoutDose = text.slice(0, doseIdx).trim();
    if (withoutDose.length <= maxChars) return withoutDose;
  }

  // Hard truncate at a line boundary near maxChars
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > maxChars * 0.7
    ? truncated.slice(0, lastNewline).trim()
    : truncated.trim();
}
