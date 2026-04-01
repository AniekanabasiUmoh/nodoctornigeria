# NSTG Frontline Care — Deployment Guide

## Overview

The NSTG Medical AI Assistant is a pure 70B LLM-based clinical decision support system for frontline care in Nigeria. All Phases (1–10) are complete and deployed to Supabase Edge Functions.

**Live endpoints:**
- Telegram webhook: `/webhook/telegram`
- WhatsApp webhook: `/webhook/whatsapp`
- Web app: `/app`
- Clinical API: `/clinical/query`
- Community API: `/community/query`
- Health check: `/health`

---

## Prerequisites

1. **Supabase project:** `dngooesshmbkntipqmxq`
2. **Groq API key** (1,000 req/day free tier)
3. **Telegram bot token** (for clinical bot)
4. **WhatsApp Business Account** (optional, for WhatsApp channel)

---

## Secrets Configuration

Set the following secrets in Supabase:

```bash
npx supabase secrets set --project-ref dngooesshmbkntipqmxq \
  GROQ_API_KEY="your_groq_key" \
  GROQ_MODEL="llama-3.3-70b-versatile" \
  ENABLE_GROQ_ASSIST="true" \
  TELEGRAM_BOT_TOKEN="8293127065:AAHuRkts76m72Y4qPottT5L-XDaA3fT9SlM" \
  TELEGRAM_WEBHOOK_SECRET="nstg_tg_2f84d1b6c7e94a30b5c2f8e1d4a7693c"
```

For WhatsApp (optional):
```bash
npx supabase secrets set --project-ref dngooesshmbkntipqmxq \
  WHATSAPP_PHONE_NUMBER_ID="your_phone_number_id" \
  WHATSAPP_ACCESS_TOKEN="your_access_token" \
  WHATSAPP_WEBHOOK_TOKEN="your_verify_token"
```

---

## Deployment

### Standard Deploy

```bash
cd c:\Dev\Where_there_is_no_doctor
npx supabase functions deploy --project-ref dngooesshmbkntipqmxq
```

This deploys the `api` function to Edge Functions. All endpoints are served from the single `api` function router.

### Verify Deployment

```bash
curl https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/health
# Response: {"status":"ok","runtime":"supabase-edge"}
```

---

## Channel Setup

### 1. Telegram

**Status:** ✅ Live

**Bot token:** `8293127065:AAHuRkts76m72Y4qPottT5L-XDaA3fT9SlM`

**Webhook registration:**
```bash
curl -X POST https://api.telegram.org/bot8293127065:AAHuRkts76m72Y4qPottT5L-XDaA3fT9SlM/setWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/webhook/telegram",
    "secret_token": "nstg_tg_2f84d1b6c7e94a30b5c2f8e1d4a7693c"
  }'
```

**Test:**
```
Send any message to bot @[bot_name]
```

**Session management:**
- `/start` clears session memory and returns greeting
- All messages routed to `answerCommunity()` by default
- Prefix with `/clinical ` to route to `answerClinician()`

---

### 2. WhatsApp

**Status:** ✅ Endpoint deployed (credentials required)

**Setup required:**

1. Create Meta WhatsApp Business Account
2. Get phone number ID and access token
3. Set Supabase secrets (see above)
4. Register webhook:

```bash
curl -X POST "https://graph.instagram.com/v18.0/[PHONE_NUMBER_ID]/subscribed_apps" \
  -H "Authorization: Bearer [ACCESS_TOKEN]" \
  -d '{"subscribed_apps":true}'
```

5. Configure webhook URL in Meta Business Manager:
   - URL: `https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/webhook/whatsapp`
   - Verify token: value of `WHATSAPP_WEBHOOK_TOKEN`
   - Subscribe to: `messages`, `message_template_status_update`

**Test:**
```
Send any message to WhatsApp bot
```

---

### 3. Web/App

**Status:** ✅ Live at `/app`

**Access:**
```
https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/app
```

**Features:**
- Query form (session ID optional)
- Live response with disposition, treat_here, refer_urgency
- Case history with timestamps and disposition badges
- Session dashboard: case count, emergencies, treat-here rate, need-info

**Mobile:** Fully responsive. Tested on low-end Android on 3G.

---

### 4. Voice (Async Job)

**Status:** ✅ Architecture designed, integration pending

**Flow:**

1. **Create job** (client sends audio):
```bash
curl -X POST "https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/community/voice-jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "audio_as_base64_or_raw",
    "session_id": "user_123",
    "top_k": 5
  }'
# Response: {"job_id": "uuid", "status": "pending"}
```

2. **Poll job status**:
```bash
curl "https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/jobs/{job_id}"
# Response when done: {...response, audio_url: "..."}
```

**To complete:** Wire transcription (Deno FFI or cloud API) and TTS synthesis.

---

### 5. API

**Status:** ✅ Live and partner-ready

**Endpoints:**

```bash
POST /clinical/query
{
  "query": "patient presentation",
  "session_id": "optional_session_id",
  "top_k": 5  # max 10
}

POST /community/query
{
  "query": "patient presentation",
  "session_id": "optional_session_id",
  "top_k": 4  # max 10
}
```

**Response schema:** `QueryResponse`

```json
{
  "interaction_id": "uuid",
  "disposition": "ANSWER|ASK_CLARIFY|EMERGENCY_ESCALATE|INSUFFICIENT_EVIDENCE",
  "answer": "plain text response",
  "treat_here": true|false|null,
  "refer_urgency": "immediate|soon|routine|null",
  "what_to_do_now": ["step 1", "step 2"],
  "ask_or_check": "specific question if ASK_CLARIFY",
  "immediate_actions": ["action 1", "action 2"],
  "danger_signs_detected": ["sign 1", "sign 2"],
  "triage": "string (deprecated, use disposition)",
  "citations": [{"condition": "...", "section": "...", ...}],
  "dosage": {"medication": "...", "dose_mg": 250, ...},
  "warnings": ["warning 1"]
}
```

**Session memory:**
- Session ID format: `channel:user_id` (e.g., `telegram:12345`)
- Persists across turns for multi-turn conversations
- `/start` (Telegram only) clears session

---

## Runtime Behavior

### Triage & Escalation

**No deterministic triage gate.** Single 70B unified call:
1. Triage the case (danger signs?)
2. Interpret facts (age, weight, symptoms, onset)
3. Reason about conditions
4. Return structured clinical decision

**Aggressive escalation bias:**
- If ANY doubt about danger signs → `EMERGENCY_ESCALATE`
- If critical info missing (weight, temp, visual exam) → `ASK_CLARIFY`
- Only `INSUFFICIENT_EVIDENCE` for truly out-of-scope queries

### Village-Aware Fallback

If a test/lab is unavailable in village settings (Hb, blood culture, imaging):
- Answer based on clinical signs
- Append caveat: "it's okay if you don't have [test name]"
- Example: "Based on pallor and weakness, suspect anaemia. It's okay if you don't have Hb — examine for conjunctival pallor and nail bed color."

### Audience Awareness

**Community endpoint** (`/community/query`):
- Plain language, Pidgin welcome
- No drug dosing unless NSTG explicitly states it
- Hospital-only interventions (oxygen, IV) → ask about local access, emphasize referral

**Clinical endpoint** (`/clinical/query`):
- Clinician-facing wording
- Dosing acceptable if grounded in evidence
- Assume access to common clinical tools

---

## Monitoring & Audit

All interactions logged to `interactions` table:
- `route` (endpoint)
- `channel` (telegram, whatsapp, clinical, community)
- `query` (user input)
- `top_k` (retrieval limit)
- `response` (full QueryResponse)
- `timestamp`

**Review dashboard:** `/review` (requires REVIEW_DASHBOARD_TOKEN)

**Feedback:** `POST /feedback` with `interaction_id` and rating (up/down)

---

## Troubleshooting

### Telegram webhook fails

**Check secret token:**
```bash
curl -X POST "https://api.telegram.org/bot[TOKEN]/getWebhookInfo" \
  -H "Content-Type: application/json"
```

Ensure `secret_token` matches `TELEGRAM_WEBHOOK_SECRET`.

### WhatsApp messages not received

1. Verify webhook URL in Meta Business Manager
2. Check `WHATSAPP_WEBHOOK_TOKEN` matches Meta verify token
3. Test webhook verification:
```bash
curl "https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=CHALLENGE"
# Should return CHALLENGE value
```

### LLM failures

If Groq is down or quota exhausted:
- Graceful degradation: `buildDegradedAnswer()` returns NSTG evidence excerpt
- User always receives a response
- Failure logged to `interactions.failure` field

### Session memory not persisting

Verify Supabase connection and `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are set.

---

## Performance Benchmarks

**Single request latency:**
- Retrieval + 70B reasoning: ~3–5 seconds (Groq)
- Telegram response: ~6–7 seconds (including network round-trips)
- WhatsApp response: ~6–8 seconds

**Throughput:**
- Groq free tier: 1,000 req/day (sustainable for 30–40 active users)
- Edge Functions: no explicit limit per function, but Supabase org-level quotas apply

**Storage:**
- `interactions` table grows ~1 KB per query
- Estimate: 1 GB per ~1 million interactions

---

## Multi-Provider Fallback (Planned)

When Groq quota exhausted, fallback to:
1. Gemini (free tier exhausted, requires paid tier)
2. Claude (Anthropic API)
3. Grok (multiple accounts possible)

Implementation: Update `unifyFrontlineWithGroq()` in `llm.ts` to try Groq first, then fallback to second provider.

---

## Offline Mode (Planned)

Local protocol cards (no LLM):
- Pre-computed decision trees for 5 highest-volume conditions
- Malaria, dehydration, pneumonia, anaemia, convulsion
- Cached in browser localStorage

---

## Next Steps

1. **Real-world validation:** Deploy to 5–10 clinics, collect feedback
2. **Multi-provider fallback:** Add Gemini + Claude + Grok as secondaries
3. **Offline mode:** Ship protocol cards with app
4. **Voice integration:** Complete TTS synthesis + audio output
5. **Analytics:** Dashboard for case patterns, referral outcomes, clinical insights

---

## Support & Contact

For issues or feature requests:
- GitHub Issues: [project repo]
- Email: [contact email]
