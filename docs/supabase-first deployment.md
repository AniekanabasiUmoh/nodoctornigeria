# Supabase-Only Deployment Guide

The runtime is now ported into `Supabase Edge Functions`.

Current Supabase-managed backend pieces:

- public API routing
- community query endpoint
- clinician query endpoint
- Telegram webhook endpoint
- feedback endpoint
- async job state
- audit logging
- analytics/event storage foundation
- guideline chunk retrieval through Postgres search

The main Edge entrypoint is [index.ts](/c:/Dev/Where_there_is_no_doctor/supabase/functions/api/index.ts).

## 1. Run the SQL Migrations

In Supabase SQL Editor, run these files in order:

1. [001_phase4_core.sql](/c:/Dev/Where_there_is_no_doctor/supabase/migrations/001_phase4_core.sql)
2. [002_phase5_jobs_and_analytics.sql](/c:/Dev/Where_there_is_no_doctor/supabase/migrations/002_phase5_jobs_and_analytics.sql)
3. [003_guideline_chunks_and_search.sql](/c:/Dev/Where_there_is_no_doctor/supabase/migrations/003_guideline_chunks_and_search.sql)
4. [004_phase2_async_job_payload.sql](/c:/Dev/Where_there_is_no_doctor/supabase/migrations/004_phase2_async_job_payload.sql)
5. [005_phase3_audit_trace.sql](/c:/Dev/Where_there_is_no_doctor/supabase/migrations/005_phase3_audit_trace.sql)

That creates:

- audit tables
- feedback tables
- async job tables
- analytics tables
- `guideline_chunks`
- the `search_guideline_chunks(...)` RPC function

## 2. Import the Guideline Chunks

The Edge Function searches `guideline_chunks`, so the chunk data must be loaded into Supabase.

Use:

```powershell
node scripts/import_chunks_to_supabase.mjs build/nstg_dataset_chunks.jsonl
```

The importer script is [import_chunks_to_supabase.mjs](/c:/Dev/Where_there_is_no_doctor/scripts/import_chunks_to_supabase.mjs).

## 3. Configure Supabase Secrets

Set these secrets for your Edge Functions:

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_WEBHOOK_SECRET=your_random_secret
```

Keep the service role key server-side only.

## 4. Deploy the Edge Function

This repo includes [config.toml](/c:/Dev/Where_there_is_no_doctor/supabase/config.toml) with JWT verification disabled for the public API function because Telegram webhooks and public bot requests need unauthenticated access.

Deploy the function:

```powershell
supabase functions deploy api --no-verify-jwt
```

After deployment, your public function URL will look like:

`https://<project-ref>.supabase.co/functions/v1/api`

## 5. Public Endpoints

Once deployed, the main public routes are:

- `GET /functions/v1/api/health`
- `POST /functions/v1/api/community/query`
- `POST /functions/v1/api/clinical/query`
- `POST /functions/v1/api/community/voice-jobs`
- `POST /functions/v1/api/jobs/{job_id}/process`
- `GET /functions/v1/api/jobs/{job_id}`
- `POST /functions/v1/api/feedback`
- `POST /functions/v1/api/webhook/telegram`

## 6. Register Telegram

Set the Telegram webhook to:

`https://<project-ref>.supabase.co/functions/v1/api/webhook/telegram`

You can register it with Telegram's Bot API using your bot token and chosen secret token.

## 7. Smoke Test

Check:

1. `GET /functions/v1/api/health`
2. `POST /functions/v1/api/community/query`
3. `POST /functions/v1/api/clinical/query`
4. Telegram webhook accepts messages
5. rows are written into `audit_interactions`
6. `POST /functions/v1/api/community/voice-jobs` returns a queued job
7. `POST /functions/v1/api/jobs/{job_id}/process` moves the job into `completed` or `failed`
8. rows are written into `async_jobs` for voice-job flows

## 8. Remaining Work After Deployment

This gets you to a real Supabase-hosted backend surface. The next high-value steps are:

- connect the website and mobile clients to the function URL
- add Supabase RLS policies for frontend-safe tables
- add an admin dashboard over analytics and audit tables
- decide whether to move chunk ingestion from script-driven import to scheduled Supabase-native jobs
