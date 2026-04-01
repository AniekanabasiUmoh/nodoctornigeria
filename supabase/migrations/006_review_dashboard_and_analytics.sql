-- Migration 006: Review dashboard views and analytics aggregates
-- Adds read-only views for the nodoctor.ng review dashboard and product analytics.

-- ── 1. REVIEW QUEUE VIEW ──────────────────────────────────────────────────────
-- Flat view of interactions that need clinical review, ordered by urgency.

create or replace view public.v_review_queue as
select
  ai.interaction_id,
  ai.created_at,
  ai.channel,
  ai.route,
  ai.query,
  ai.normalized_query,
  ai.review_required,
  ai.review_status,
  ai.response->>'answer'          as answer,
  ai.response->>'disposition'     as disposition,
  ai.trace->>'triage_disposition' as triage_disposition,
  ai.trace->>'final_disposition'  as final_disposition,
  ai.trace->>'model_version'      as model_version,
  (
    select count(*)
    from public.feedback_events fe
    where fe.interaction_id = ai.interaction_id
  )                                as feedback_count,
  (
    select string_agg(fe.rating, ',' order by fe.created_at)
    from public.feedback_events fe
    where fe.interaction_id = ai.interaction_id
  )                                as feedback_ratings
from public.audit_interactions ai
where ai.review_required = true
order by
  -- Emergencies first
  case
    when ai.trace->>'final_disposition' in ('EMERGENCY_ESCALATE','UNCERTAIN_ESCALATE') then 0
    when ai.trace->>'final_disposition' = 'INSUFFICIENT_EVIDENCE' then 1
    else 2
  end,
  ai.created_at desc;


-- ── 2. DAILY QUERY VOLUME ────────────────────────────────────────────────────

create or replace view public.v_daily_query_volume as
select
  date_trunc('day', created_at at time zone 'Africa/Lagos') as day,
  channel,
  count(*)                                                    as query_count,
  count(*) filter (where review_required = true)              as flagged_count,
  count(*) filter (
    where trace->>'final_disposition' in ('EMERGENCY_ESCALATE','UNCERTAIN_ESCALATE')
  )                                                           as emergency_count,
  count(*) filter (
    where trace->>'final_disposition' = 'INSUFFICIENT_EVIDENCE'
  )                                                           as insufficient_count,
  count(*) filter (
    where trace->>'final_disposition' = 'ANSWER'
  )                                                           as answered_count
from public.audit_interactions
group by 1, 2
order by 1 desc, 2;


-- ── 3. TOP CONDITIONS ────────────────────────────────────────────────────────
-- Most queried conditions based on what the retriever matched.

create or replace view public.v_top_conditions as
select
  chunk->>'condition'  as condition,
  count(*)             as mention_count,
  count(distinct ai.interaction_id) as interaction_count
from public.audit_interactions ai,
     jsonb_array_elements(ai.trace->'retrieved_chunks') as chunk
where chunk->>'condition' is not null
group by 1
order by 2 desc
limit 50;


-- ── 4. FEEDBACK SUMMARY ──────────────────────────────────────────────────────

create or replace view public.v_feedback_summary as
select
  ai.channel,
  date_trunc('day', fe.created_at at time zone 'Africa/Lagos') as day,
  count(*) filter (where fe.rating = 'up')   as helpful_count,
  count(*) filter (where fe.rating = 'down') as needs_review_count,
  count(*)                                   as total_feedback
from public.feedback_events fe
join public.audit_interactions ai on ai.interaction_id = fe.interaction_id
group by 1, 2
order by 2 desc, 1;


-- ── 5. UNANSWERED QUERY LOG ──────────────────────────────────────────────────
-- Queries that hit INSUFFICIENT_EVIDENCE — these are the product gaps.

create or replace view public.v_unanswered_queries as
select
  interaction_id,
  created_at,
  channel,
  query,
  normalized_query,
  trace->>'triage_disposition' as triage_disposition
from public.audit_interactions
where trace->>'final_disposition' = 'INSUFFICIENT_EVIDENCE'
order by created_at desc;


-- ── 6. JOB HEALTH VIEW ───────────────────────────────────────────────────────

create or replace view public.v_job_health as
select
  date_trunc('day', created_at at time zone 'Africa/Lagos') as day,
  channel,
  status,
  count(*)                    as job_count,
  avg(attempt_count)          as avg_attempts,
  max(attempt_count)          as max_attempts
from public.async_jobs
group by 1, 2, 3
order by 1 desc, 2, 3;


-- ── 7. ADD updated_at TO audit_interactions ──────────────────────────────────
-- Must come before the function that references it.

alter table public.audit_interactions
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_audit_interactions_updated_at
  on public.audit_interactions(updated_at desc);


-- ── 8. REVIEW DASHBOARD SUMMARY FUNCTION ────────────────────────────────────
-- Single call to get the dashboard header counts.

create or replace function public.review_dashboard_summary()
returns table (
  total_interactions      bigint,
  pending_review          bigint,
  reviewed_today          bigint,
  emergency_unreviewed    bigint,
  total_feedback          bigint,
  helpful_pct             numeric,
  unanswered_queries      bigint
)
language sql
stable
as $$
  select
    (select count(*) from public.audit_interactions)                               as total_interactions,
    (select count(*) from public.audit_interactions
      where review_required = true and review_status is null)                      as pending_review,
    (select count(*) from public.audit_interactions
      where review_status is not null
        and date_trunc('day', updated_at at time zone 'Africa/Lagos')
            = date_trunc('day', now() at time zone 'Africa/Lagos'))                as reviewed_today,
    (select count(*) from public.audit_interactions
      where review_required = true
        and review_status is null
        and trace->>'final_disposition' in ('EMERGENCY_ESCALATE','UNCERTAIN_ESCALATE')) as emergency_unreviewed,
    (select count(*) from public.feedback_events)                                  as total_feedback,
    (select round(
        100.0 * count(*) filter (where rating = 'up')
        / nullif(count(*), 0), 1
      ) from public.feedback_events)                                               as helpful_pct,
    (select count(*) from public.audit_interactions
      where trace->>'final_disposition' = 'INSUFFICIENT_EVIDENCE')                as unanswered_queries;
$$;
