import { createClient } from "npm:@supabase/supabase-js@2";

export function getSupabaseAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for Edge Functions.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function getTelegramConfig() {
  return {
    botToken: Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "",
    webhookSecret: Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "",
  };
}

export function getWhatsAppConfig() {
  return {
    phoneNumberId: Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "",
    accessToken: Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "",
    webhookToken: Deno.env.get("WHATSAPP_WEBHOOK_TOKEN") ?? "",
  };
}


export function getReviewDashboardConfig() {
  return {
    dashboardToken: Deno.env.get("REVIEW_DASHBOARD_TOKEN") ?? "",
  };
}

export function getGeminiConfig() {
  return {
    enabled: (Deno.env.get("ENABLE_GEMINI_ASSIST") ?? "false").trim().toLowerCase() === "true",
    apiKey: Deno.env.get("GEMINI_API_KEY") ?? "",
    model: Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash-lite",
  };
}

export function getGroqConfig() {
  return {
    enabled: (Deno.env.get("ENABLE_GROQ_ASSIST") ?? "false").trim().toLowerCase() === "true",
    apiKey: Deno.env.get("GROQ_API_KEY") ?? "",
    model: Deno.env.get("GROQ_MODEL") ?? "llama-3.3-70b-versatile",
    lightModel: Deno.env.get("GROQ_LIGHT_MODEL") ?? "llama-3.1-8b-instant",
  };
}
