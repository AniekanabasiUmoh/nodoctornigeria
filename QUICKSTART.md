# NSTG Frontline Care — Quick Start Guide

Get the NSTG clinical decision support system running in 5 minutes.

---

## TL;DR

```bash
# 1. Get Groq API key from https://console.groq.com
# 2. Set secrets in Supabase
npx supabase secrets set --project-ref dngooesshmbkntipqmxq \
  GROQ_API_KEY="your_key" \
  ENABLE_GROQ_ASSIST="true"

# 3. Deploy
npx supabase functions deploy --project-ref dngooesshmbkntipqmxq

# 4. Test
bash tests/phase9_regression.sh

# 5. Access web app
open "https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/app"
```

---

## Prerequisites

- Supabase project: `dngooesshmbkntipqmxq`
- Groq account (free tier: 1,000 req/day)
- Node.js + npm (for Supabase CLI)

---

## Step 1: Get API Keys

### Groq
1. Go to https://console.groq.com
2. Create account or log in
3. Create API key
4. Copy the key

---

## Step 2: Set Secrets

```bash
npx supabase secrets set --project-ref dngooesshmbkntipqmxq \
  GROQ_API_KEY="gsk_..." \
  GROQ_MODEL="llama-3.3-70b-versatile" \
  ENABLE_GROQ_ASSIST="true"
```

**Verify:**
```bash
npx supabase secrets list --project-ref dngooesshmbkntipqmxq
```

---

## Step 3: Deploy

```bash
cd c:\Dev\Where_there_is_no_doctor
npx supabase functions deploy --project-ref dngooesshmbkntipqmxq
```

Expected output:
```
Deployed Functions on project dngooesshmbkntipqmxq: api, api
```

---

## Step 4: Test Endpoints

### Health Check
```bash
curl https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/health
# Response: {"status":"ok","runtime":"supabase-edge"}
```

### Clinical Query
```bash
curl -X POST https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/clinical/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "5 year old fast breathing 50/min and fever 38.5C",
    "top_k": 5
  }'
```

### Community Query
```bash
curl -X POST https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/community/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "pikin dey get fever since 2 days, no chop anything",
    "top_k": 4
  }'
```

---

## Step 5: Access Web App

Open in browser:
```
https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/app
```

Features:
- Query form (try: "fever and fast breathing")
- Live response with disposition
- Case history
- Session dashboard

---

## Step 6: Run Tests

```bash
bash tests/phase9_regression.sh
```

Expected output:
```
Phase 9 — Evaluation Harness: Regression Test Suite
─────────────────────────────────────────────────────
9.1 Live Regression Pack (Core Cases)
...
Results: 25 PASS, 0 FAIL out of 25 tests
Pass Rate: 100.0%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ All tests passed!
```

---

## Optional: Set Up Telegram

1. Create Telegram bot: [@BotFather](https://t.me/botfather) → `/newbot`
2. Get bot token
3. Set secret in Supabase:
```bash
npx supabase secrets set --project-ref dngooesshmbkntipqmxq \
  TELEGRAM_BOT_TOKEN="123:ABC..." \
  TELEGRAM_WEBHOOK_SECRET="nstg_..."
```
4. Register webhook:
```bash
curl -X POST https://api.telegram.org/bot{TOKEN}/setWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/webhook/telegram",
    "secret_token": "nstg_..."
  }'
```
5. Send message to bot and verify response

---

## Optional: Set Up WhatsApp

1. Create Meta WhatsApp Business Account
2. Get Phone Number ID and Access Token
3. Set secrets:
```bash
npx supabase secrets set --project-ref dngooesshmbkntipqmxq \
  WHATSAPP_PHONE_NUMBER_ID="12345..." \
  WHATSAPP_ACCESS_TOKEN="EAAxx..." \
  WHATSAPP_WEBHOOK_TOKEN="verify_token"
```
4. Register webhook in Meta Business Manager:
   - URL: `https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/webhook/whatsapp`
   - Verify token: your WHATSAPP_WEBHOOK_TOKEN
5. Send WhatsApp message to your bot number

---

## Troubleshooting

### "GROQ_API_KEY not found"
- Check secrets: `npx supabase secrets list --project-ref dngooesshmbkntipqmxq`
- Verify key is set: `npx supabase secrets list | grep GROQ`

### Tests fail with "EMERGENCY_ESCALATE expected ASK_CLARIFY"
- This is normal during prompt tuning
- System is being conservative to avoid missing danger signs
- See `DEPLOYMENT_GUIDE.md` troubleshooting section

### Telegram webhook not working
- Verify secret token matches in both Telegram API call and Supabase secret
- Check endpoint is correct: `/webhook/telegram`
- Test with: `curl -X POST https://...api/webhook/telegram -d '{...}'`

### Slow responses
- Groq API is rate-limited (1,000 req/day free tier)
- Each query uses 1 free request
- Consider upgrading Groq plan for higher volume

---

## Next Steps

1. **Read:** `DEPLOYMENT_GUIDE.md` (full setup guide)
2. **Read:** `API_REFERENCE.md` (endpoint details + examples)
3. **Read:** `COMPLETION_SUMMARY.md` (architecture overview)
4. **Deploy to pilot:** 5–10 clinics with real cases
5. **Collect feedback:** Use review dashboard at `/review`

---

## Key Concepts

### Disposition
System returns one of:
- `ANSWER` — Can manage locally; follow `what_to_do_now`
- `ASK_CLARIFY` — Need one critical piece of info; ask `ask_or_check`
- `EMERGENCY_ESCALATE` — Danger signs; refer now; do `immediate_actions`
- `INSUFFICIENT_EVIDENCE` — Out of scope or too vague

### Treat Here vs. Refer
Every response includes:
- `treat_here: true/false/null`
- `refer_urgency: "immediate"|"soon"|"routine"|null`

### Village-Aware
If test unavailable in village (Hb, imaging):
- Answer based on clinical signs
- Add caveat: "it's okay if you don't have [test]"

### Session Memory
Same session_id = continued conversation with full context.
Format: `channel:user_id` (e.g., `telegram:12345`)

---

## Support

- **Docs:** See DEPLOYMENT_GUIDE.md and API_REFERENCE.md
- **Logs:** Supabase dashboard → Functions → Logs
- **Tests:** `bash tests/phase9_regression.sh`
- **Review:** https://dngooesshmbkntipqmxq.supabase.co/functions/v1/api/review

---

**You're ready!** Test with `/api/health` and go from there. 🚀
