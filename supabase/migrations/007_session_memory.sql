-- ── MIGRATION 007: SESSION MEMORY ────────────────────────────────────────────
-- Enables short-term clinical conversation state across messages.
-- Each row is one active session (one user/channel combination).
-- Facts are merged across turns; recent_turns is a capped ring buffer.

-- ── 1. SESSION MEMORY TABLE ──────────────────────────────────────────────────

create table if not exists public.session_memory (
  session_id    text        primary key,
  channel       text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  turn_count    integer     not null default 0,

  -- Accumulated structured patient facts (merged each turn, overwritten by new values)
  facts         jsonb       not null default '{}'::jsonb,

  -- Ring buffer of last 5 turns: [{query, disposition, answer_excerpt, candidate_conditions}]
  recent_turns  jsonb       not null default '[]'::jsonb
);

create index if not exists idx_session_memory_channel
  on public.session_memory(channel);

create index if not exists idx_session_memory_updated_at
  on public.session_memory(updated_at desc);

-- ── 2. CLEANUP FUNCTION ───────────────────────────────────────────────────────
-- Purge sessions idle for more than 4 hours.
-- Run manually or via pg_cron if available.

create or replace function public.purge_expired_sessions()
returns integer
language sql
as $$
  with deleted as (
    delete from public.session_memory
    where updated_at < now() - interval '4 hours'
    returning session_id
  )
  select count(*)::integer from deleted;
$$;

-- ── 3. SESSION ENGAGEMENT ANALYTICS VIEW ─────────────────────────────────────

create or replace view public.v_session_engagement as
select
  channel,
  date_trunc('day', created_at at time zone 'Africa/Lagos') as day,
  count(*)                                                    as session_count,
  avg(turn_count)::numeric(6,1)                              as avg_turns,
  max(turn_count)                                             as max_turns,
  count(*) filter (where turn_count >= 3)                    as multi_turn_sessions
from public.session_memory
group by 1, 2
order by 2 desc, 1;
