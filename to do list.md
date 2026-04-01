# To Do List

## Credentials and API Keys

- [x] Supabase project URL
- [X] Supabase service role key
- [ ] Supabase anon key, if we later expose web or mobile auth flows
- [ ] Twilio Account SID
- [ ] Twilio Auth Token
- [ ] Twilio WhatsApp sender number
- [X] Telegram bot token
- [X] Telegram webhook secret token
- [x] Chosen LLM provider: Groq — `GROQ_API_KEY`, `GROQ_MODEL=llama-3.3-70b-versatile`, `ENABLE_GROQ_ASSIST=true` set in Supabase secrets
- [ ] Chosen embedding model provider credentials
- [ ] Chosen STT provider credentials
- [ ] Chosen TTS provider credentials

## Source Documents and Data

- [ ] NSTG 2022 PDF
- [ ] Any source-to-page mapping or citation aids for the NSTG PDF
- [ ] Real clinician query examples
- [ ] Real community query examples
- [ ] Nigerian drug brand and alias list
- [ ] Local phrasing, dialect, or slang examples for triage-sensitive symptoms

## Data Collection and Analytics Inputs

- [ ] Confirm what user and interaction data we are allowed to store
- [ ] Confirm what data should be anonymized before analytics
- [ ] Confirm retention windows for raw interactions versus aggregated analytics
- [ ] Confirm which product decisions you want dashboards to support
- [ ] Define the key metrics you care about most
- [ ] Confirm whether location or facility-level data will ever be collected
- [ ] Confirm whether consent text is needed for analytics and product improvement
- [ ] List the kinds of trends you most want to detect

## Product and Platform Decisions

- [ ] Confirm Supabase project structure and region
- [ ] Run Supabase SQL migrations from `supabase/migrations`
- [ ] Confirm deployment target for the backend
- [ ] Confirm whether Redis will be added now or later
- [ ] Confirm whether Twilio is the final WhatsApp provider
- [ ] Confirm whether Telegram is clinician-only, community-only, or both
- [ ] Confirm website auth requirements
- [ ] Confirm whether mobile app auth is needed in the first release

## Mobile and Web

- [ ] Real backend base URL for device testing
- [ ] App name and subtitle you want shown in web and mobile
- [ ] Brand colors or design direction, if you have one
- [ ] App icon and splash screen assets
- [ ] Privacy policy text
- [ ] Terms or disclaimer text for public-facing use

## Safety and Review

- [ ] Clinical reviewer list for sign-off
- [ ] Red-flag symptom list you want treated as non-negotiable
- [ ] Retention policy for logs, audio, and feedback
- [ ] Access policy for who can review audit logs
- [ ] Any regulatory or organizational constraints you already know about

## Nice to Have Later

- [ ] EHR or EMR integration requirements
- [ ] Analytics and dashboard requirements
- [ ] Image input requirements
- [ ] Hausa, Igbo, Yoruba rollout priorities
