import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import { getReviewDashboardConfig, getSupabaseAdminClient, getTelegramConfig, getWhatsAppConfig } from "../_shared/config.ts";
import { corsHeaders, htmlResponse, jsonResponse } from "../_shared/http.ts";
import {
  answerClinician,
  answerCommunity,
  createJob,
  enrichFrontlineResponse,
  getJob,
  listReviewInteractions,
  logFeedback,
  logInteraction,
  processCommunityJob,
  updateReviewStatus,
} from "../_shared/service.ts";
import { clearSessionMemory } from "../_shared/memory.ts";
import { determineTelegramRoute, parseTelegramWebhook, sendTelegramMessage, stripTelegramCommand } from "../_shared/telegram.ts";
import { parseWhatsAppWebhook, sendWhatsAppMessage, truncateForWhatsApp } from "../_shared/whatsapp.ts";
import { renderWebAppPage } from "../_shared/webapp.ts";
import type { FeedbackRequest } from "../_shared/types.ts";

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  try {
    const supabase = getSupabaseAdminClient();

    if (request.method === "GET" && path === "/health") {
      return jsonResponse({ status: "ok", runtime: "supabase-edge" });
    }

    if (request.method === "GET" && path === "/app") {
      return htmlResponse(renderWebAppPage());
    }

    if (request.method === "GET" && path === "/review") {
      const reviewAccessError = requireReviewAccess(request, url);
      if (reviewAccessError) {
        return reviewAccessError;
      }
      return htmlResponse(renderReviewDashboardPage());
    }

    if (request.method === "GET" && path === "/review/interactions") {
      const reviewAccessError = requireReviewAccess(request, url);
      if (reviewAccessError) {
        return reviewAccessError;
      }
      const reviewQueue = await listReviewInteractions(supabase, {
        limit: clampReviewLimit(url.searchParams.get("limit")),
        reviewRequiredOnly: url.searchParams.get("review_required_only") === "true",
      });
      return jsonResponse(reviewQueue);
    }

    if (request.method === "POST" && path.startsWith("/review/interactions/") && path.endsWith("/status")) {
      const reviewAccessError = requireReviewAccess(request, url);
      if (reviewAccessError) {
        return reviewAccessError;
      }
      const parts = path.split("/");
      const interactionId = parts[3] ?? "";
      const payload = await request.json();
      const reviewStatus = String(payload.review_status ?? "");
      if (!interactionId || !reviewStatus.trim()) {
        return jsonResponse({ detail: "interaction_id and review_status are required." }, 400);
      }
      const updated = await updateReviewStatus(supabase, interactionId, reviewStatus);
      return jsonResponse(updated);
    }

    if (request.method === "POST" && path === "/community/query") {
      const payload = await request.json();
      const topK = clampTopK(payload.top_k);
      const sessionId = sanitizeSessionId(payload.session_id);
      const response = enrichFrontlineResponse(await answerCommunity(supabase, String(payload.query ?? ""), topK, sessionId));
      const interactionId = await logInteraction(supabase, {
        route: "/community/query",
        channel: "community",
        query: String(payload.query ?? ""),
        top_k: topK,
        response,
      });
      return jsonResponse({ ...response, interaction_id: interactionId });
    }

    if (request.method === "POST" && path === "/clinical/query") {
      const payload = await request.json();
      const topK = clampTopK(payload.top_k);
      const sessionId = sanitizeSessionId(payload.session_id);
      const response = enrichFrontlineResponse(await answerClinician(supabase, String(payload.query ?? ""), topK, sessionId));
      const interactionId = await logInteraction(supabase, {
        route: "/clinical/query",
        channel: "clinical",
        query: String(payload.query ?? ""),
        top_k: topK,
        response,
      });
      return jsonResponse({ ...response, interaction_id: interactionId });
    }

    if (request.method === "POST" && path === "/community/voice-jobs") {
      const payload = await request.json();
      const topK = clampTopK(payload.top_k);
      const job = await createJob(supabase, {
        query: String(payload.query ?? ""),
        topK,
        channel: "community_voice_job",
      });
      return jsonResponse(job, 202);
    }

    if (request.method === "GET" && path.startsWith("/jobs/")) {
      const jobId = path.split("/").pop() ?? "";
      const job = await getJob(supabase, jobId);
      if (!job) {
        return jsonResponse({ detail: "Job not found." }, 404);
      }
      return jsonResponse(job);
    }

    if (request.method === "POST" && path.startsWith("/jobs/") && path.endsWith("/process")) {
      const parts = path.split("/");
      const jobId = parts[2] ?? "";
      const job = await processCommunityJob(supabase, jobId);
      return jsonResponse(job);
    }

    if (request.method === "POST" && path === "/feedback") {
      const payload = (await request.json()) as FeedbackRequest;
      if (!payload.interaction_id || !payload.rating) {
        return jsonResponse({ detail: "interaction_id and rating are required." }, 400);
      }
      const response = await logFeedback(supabase, payload);
      return jsonResponse(response);
    }

    if (request.method === "POST" && path === "/webhook/telegram") {
      const { webhookSecret, botToken } = getTelegramConfig();
      const providedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (webhookSecret && providedSecret !== webhookSecret) {
        return jsonResponse({ detail: "Invalid Telegram webhook secret." }, 403);
      }

      const payload = await request.json();
      const message = parseTelegramWebhook(payload);

      // /start command: clear session memory and greet
      if (message.text && message.text.trim().toLowerCase().startsWith("/start")) {
        const { botToken } = getTelegramConfig();
        const sessionId = message.user_id ? `telegram:${message.user_id}` : null;
        if (sessionId) await clearSessionMemory(supabase, sessionId);
        if (message.user_id && botToken) {
          await sendTelegramMessage(
            botToken,
            message.user_id,
            "Session cleared. Ready for a new consultation.\n\nAsk about assessment, treatment, dosing, or referral.",
          ).catch(() => {});
        }
        return jsonResponse({ status: "start_handled" });
      }

      const queryText = stripTelegramCommand(message.text);
      if (!queryText) {
        return jsonResponse({ status: "ignored", channel: message.channel });
      }

      const route = determineTelegramRoute(message.text);
      // Telegram session_id is keyed by chat_id for persistent memory per user
      const telegramSessionId = message.user_id ? `telegram:${message.user_id}` : null;
      const response =
        route === "clinical"
          ? enrichFrontlineResponse(await answerClinician(supabase, queryText, 5, telegramSessionId))
          : enrichFrontlineResponse(await answerCommunity(supabase, queryText, 4, telegramSessionId));
      const interactionId = await logInteraction(supabase, {
        route: "/webhook/telegram",
        channel: route === "clinical" ? "telegram_clinical" : "telegram_community",
        query: queryText,
        top_k: route === "clinical" ? 5 : 4,
        response,
      });

      if (message.user_id && botToken) {
        try {
          await sendTelegramMessage(botToken, message.user_id, truncateForTelegram(response.answer));
        } catch (error) {
          console.warn("Outbound telegram send failed", error);
        }
      }

      return jsonResponse({
        status: "accepted",
        channel: message.channel,
        preview: { ...response, interaction_id: interactionId },
      });
    }

    if (request.method === "GET" && path === "/webhook/whatsapp") {
      const { webhookToken } = getWhatsAppConfig();
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === webhookToken) {
        return new Response(challenge || "");
      }
      return jsonResponse({ detail: "Webhook verification failed." }, 403);
    }

    if (request.method === "POST" && path === "/webhook/whatsapp") {
      const payload = await request.json();
      const message = parseWhatsAppWebhook(payload);

      if (!message || !message.text.trim()) {
        return jsonResponse({ status: "ignored" });
      }

      const queryText = message.text.trim();
      const whatsappSessionId = message.user_id ? `whatsapp:${message.user_id}` : null;
      const response = enrichFrontlineResponse(
        await answerCommunity(supabase, queryText, 4, whatsappSessionId),
      );
      const interactionId = await logInteraction(supabase, {
        route: "/webhook/whatsapp",
        channel: "whatsapp_community",
        query: queryText,
        top_k: 4,
        response,
      });

      const { phoneNumberId, accessToken } = getWhatsAppConfig();
      if (phoneNumberId && accessToken && message.user_id) {
        try {
          await sendWhatsAppMessage(
            phoneNumberId,
            accessToken,
            message.user_id,
            truncateForWhatsApp(response.answer),
          );
        } catch (error) {
          console.warn("Outbound WhatsApp send failed", error);
        }
      }

      return jsonResponse({
        status: "accepted",
        channel: "whatsapp",
        preview: { ...response, interaction_id: interactionId },
      });
    }

    return jsonResponse({ detail: "Not found." }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return jsonResponse({ detail: message }, 500);
  }
});

function clampTopK(value: unknown): number {
  const parsed = Number(value ?? 5);
  if (!Number.isFinite(parsed)) {
    return 5;
  }
  return Math.max(1, Math.min(10, Math.trunc(parsed)));
}

function normalizePath(pathname: string): string {
  for (const prefix of ["/functions/v1/api", "/api"]) {
    if (pathname === prefix) {
      return "/";
    }
    if (pathname.startsWith(prefix + "/")) {
      return pathname.slice(prefix.length) || "/";
    }
  }
  return pathname || "/";
}

/**
 * Smart Telegram truncation — preserves the high-priority sections of the
 * structured frontline format. Drops "Source:" last since it is the least
 * critical section. Hard cap at 1000 chars (Telegram message limit for bots
 * without special permissions is 4096, but we keep answers short).
 */
function truncateForTelegram(text: string, maxChars = 1000): string {
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

function clampReviewLimit(value: string | null): number {
  const parsed = Number(value ?? 12);
  if (!Number.isFinite(parsed)) {
    return 12;
  }
  return Math.max(1, Math.min(50, Math.trunc(parsed)));
}

function requireReviewAccess(request: Request, url: URL): Response | null {
  const { dashboardToken } = getReviewDashboardConfig();
  if (!dashboardToken) {
    return jsonResponse({ detail: "REVIEW_DASHBOARD_TOKEN is not configured." }, 503);
  }
  const providedToken = request.headers.get("x-review-token") ?? url.searchParams.get("token") ?? "";
  if (providedToken !== dashboardToken) {
    return jsonResponse({ detail: "Invalid review dashboard token." }, 403);
  }
  return null;
}

function sanitizeSessionId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, 128);
}

function renderReviewDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NSTG Review Dashboard</title>
  <style>
    :root {
      --bg: #efe4d2;
      --panel: rgba(255, 251, 245, 0.9);
      --panel-strong: rgba(255, 251, 245, 0.96);
      --ink: #1f261f;
      --muted: #5e675f;
      --accent: #1f6b5f;
      --accent-2: #a34e30;
      --accent-3: #264653;
      --line: rgba(31, 38, 31, 0.12);
      --danger: #8f2d1e;
      --warn: #8b6300;
      --good: #2c6b43;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(31, 107, 95, 0.16), transparent 25%),
        radial-gradient(circle at top right, rgba(163, 78, 48, 0.14), transparent 24%),
        linear-gradient(135deg, #f6efe2 0%, #efe0ca 100%);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 18px 56px;
    }
    .hero,
    .queue {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 26px;
      padding: 24px;
      box-shadow: 0 18px 48px rgba(58, 44, 25, 0.1);
      backdrop-filter: blur(10px);
    }
    .queue { margin-top: 20px; }
    .hero-top,
    .queue-top,
    .toolbar,
    .badges,
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
    }
    .kicker,
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 11px;
      font-size: 0.78rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      background: rgba(38, 70, 83, 0.1);
      color: var(--accent-3);
    }
    .badge.warn {
      background: rgba(139, 99, 0, 0.14);
      color: var(--warn);
    }
    .badge.danger {
      background: rgba(143, 45, 30, 0.14);
      color: var(--danger);
    }
    .badge.good {
      background: rgba(44, 107, 67, 0.14);
      color: var(--good);
    }
    h1 {
      margin: 16px 0 10px;
      font-size: clamp(2.2rem, 4.6vw, 4rem);
      line-height: 0.96;
      letter-spacing: -0.05em;
    }
    h2, h3 {
      margin: 0;
    }
    p {
      margin: 0 0 14px;
      color: var(--muted);
      line-height: 1.6;
    }
    .stat-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin-top: 18px;
    }
    .stat,
    .item {
      border-radius: 18px;
      border: 1px solid var(--line);
      background: var(--panel-strong);
    }
    .stat {
      padding: 16px;
    }
    .stat strong {
      display: block;
      margin-top: 8px;
      font-size: 1.8rem;
      color: var(--accent-3);
    }
    .toolbar {
      justify-content: flex-start;
      margin-top: 8px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 11px 15px;
      cursor: pointer;
      font: inherit;
      transition: transform 120ms ease;
    }
    button:hover { transform: translateY(-1px); }
    .primary { background: var(--accent); color: white; }
    .secondary { background: var(--accent-2); color: white; }
    .ghost { background: rgba(38, 70, 83, 0.1); color: var(--accent-3); }
    .mini { padding: 7px 12px; font-size: 0.86rem; }
    .status-line {
      min-height: 1.2em;
      color: var(--muted);
      font-size: 0.92rem;
      margin-top: 10px;
    }
    .items {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }
    .item {
      padding: 16px;
      display: grid;
      gap: 12px;
    }
    .item-top {
      display: flex;
      gap: 10px;
      justify-content: space-between;
      flex-wrap: wrap;
      align-items: flex-start;
    }
    .query {
      font-size: 1rem;
      line-height: 1.55;
      color: var(--ink);
    }
    .meta {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .snippet {
      border-left: 3px solid rgba(31, 107, 95, 0.24);
      padding-left: 12px;
      color: var(--muted);
      line-height: 1.55;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 18px;
      padding: 20px;
      text-align: center;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.54);
    }
    @media (max-width: 960px) {
      .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .stat-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="hero-top">
        <span class="kicker">Secured Edge Review Surface</span>
      </div>
      <h1>NSTG Review Dashboard</h1>
      <p>
        This operator view is served directly from the Supabase Edge function and reads the same structured audit logs
        that power the live Telegram and API workflows.
      </p>
      <div class="stat-grid">
        <article class="stat"><h3>Loaded</h3><strong id="stat-total">0</strong></article>
        <article class="stat"><h3>Needs Review</h3><strong id="stat-review">0</strong></article>
        <article class="stat"><h3>Reviewed</h3><strong id="stat-reviewed">0</strong></article>
        <article class="stat"><h3>Emergency</h3><strong id="stat-emergency">0</strong></article>
      </div>
    </section>

    <section class="queue">
      <div class="queue-top">
        <div>
          <h2>Review Queue</h2>
          <p>Flagged, emergency, and insufficient-evidence interactions can be marked from here.</p>
        </div>
        <div class="toolbar">
          <label><input type="checkbox" id="review-required-only" /> Needs review only</label>
          <button class="ghost" type="button" id="refresh-review">Refresh Queue</button>
        </div>
      </div>
      <div class="status-line" id="status-line"></div>
      <div class="items" id="items">
        <div class="empty">Loading the review queue...</div>
      </div>
    </section>
  </div>

  <script>
    const token = new URLSearchParams(window.location.search).get("token") || "";
    const basePath = window.location.pathname.replace(/\/review$/, "");
    const statusLine = document.getElementById("status-line");
    const itemsRoot = document.getElementById("items");
    const reviewRequiredOnly = document.getElementById("review-required-only");

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function authHeaders() {
      return token ? { "x-review-token": token } : {};
    }

    function badgeClass(item) {
      if (item.trace.final_disposition === "EMERGENCY_ESCALATE" || item.trace.final_disposition === "UNCERTAIN_ESCALATE") {
        return "danger";
      }
      if (item.review_required) {
        return "warn";
      }
      if (item.review_status) {
        return "good";
      }
      return "";
    }

    function renderItem(item) {
      const matchedTerms = (item.trace.triage_matched_terms || []).join(", ");
      const warnings = (item.response.warnings || []).join(" | ");
      const snippet = item.response.answer.length > 260 ? item.response.answer.slice(0, 257) + "..." : item.response.answer;
      const reviewLabel = item.review_status ? item.review_status.replaceAll("_", " ") : "unreviewed";
      return \`
        <article class="item">
          <div class="item-top">
            <div class="badges">
              <span class="badge \${badgeClass(item)}">\${escapeHtml(item.trace.final_disposition)}</span>
              <span class="badge">\${escapeHtml(item.channel)}</span>
              <span class="badge \${item.review_status ? "good" : item.review_required ? "warn" : ""}">\${escapeHtml(reviewLabel)}</span>
            </div>
            <div>\${escapeHtml(item.created_at || "")}</div>
          </div>
          <div class="query">\${escapeHtml(item.query)}</div>
          <div class="meta">
            <div>\${escapeHtml("Triage: " + (item.trace.triage_disposition || "none"))}</div>
            <div>\${escapeHtml("Matched terms: " + (matchedTerms || "none"))}</div>
            <div>\${escapeHtml("Warnings: " + (warnings || "none"))}</div>
            <div>\${escapeHtml("Citations: " + String((item.response.citations || []).length))}</div>
          </div>
          <div class="snippet">\${escapeHtml(snippet)}</div>
          <div class="actions">
            <button class="mini primary" type="button" data-interaction-id="\${escapeHtml(item.interaction_id)}" data-review-status="approved">Mark Approved</button>
            <button class="mini secondary" type="button" data-interaction-id="\${escapeHtml(item.interaction_id)}" data-review-status="needs_follow_up">Needs Follow-up</button>
          </div>
        </article>
      \`;
    }

    async function loadReviewQueue() {
      statusLine.textContent = "Loading review queue...";
      const params = new URLSearchParams({ limit: "12" });
      if (reviewRequiredOnly.checked) {
        params.set("review_required_only", "true");
      }
      try {
        const response = await fetch(\`\${basePath}/review/interactions?\${params.toString()}\`, {
          headers: authHeaders(),
        });
        if (!response.ok) {
          throw new Error(\`Status \${response.status}\`);
        }
        const payload = await response.json();
        document.getElementById("stat-total").textContent = String(payload.summary.total_items);
        document.getElementById("stat-review").textContent = String(payload.summary.review_required_items);
        document.getElementById("stat-reviewed").textContent = String(payload.summary.reviewed_items);
        document.getElementById("stat-emergency").textContent = String(payload.summary.emergency_items);
        itemsRoot.innerHTML = payload.items.length
          ? payload.items.map(renderItem).join("")
          : '<div class="empty">No interactions matched this filter yet.</div>';
        statusLine.textContent = "Review queue loaded.";
      } catch (error) {
        itemsRoot.innerHTML = '<div class="empty">Review queue failed to load.</div>';
        statusLine.textContent = "Review queue failed to load: " + error;
      }
    }

    async function updateReviewStatus(interactionId, reviewStatus) {
      statusLine.textContent = "Saving review status...";
      try {
        const response = await fetch(\`\${basePath}/review/interactions/\${interactionId}/status\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders(),
          },
          body: JSON.stringify({ review_status: reviewStatus }),
        });
        if (!response.ok) {
          throw new Error(\`Status \${response.status}\`);
        }
        statusLine.textContent = "Review status updated.";
        await loadReviewQueue();
      } catch (error) {
        statusLine.textContent = "Review status update failed: " + error;
      }
    }

    document.getElementById("refresh-review").addEventListener("click", () => loadReviewQueue());
    reviewRequiredOnly.addEventListener("change", () => loadReviewQueue());
    itemsRoot.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }
      const interactionId = target.dataset.interactionId;
      const reviewStatus = target.dataset.reviewStatus;
      if (!interactionId || !reviewStatus) {
        return;
      }
      updateReviewStatus(interactionId, reviewStatus);
    });

    loadReviewQueue();
  </script>
</body>
</html>`;
}
