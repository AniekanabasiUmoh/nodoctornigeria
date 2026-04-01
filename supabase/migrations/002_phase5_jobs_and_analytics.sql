create table if not exists public.async_jobs (
  job_id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  result jsonb
);

create table if not exists public.analytics_events (
  event_id bigserial primary key,
  created_at timestamptz not null default now(),
  event_name text not null,
  channel text,
  actor_type text,
  external_user_id text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_async_jobs_status on public.async_jobs(status);
create index if not exists idx_async_jobs_created_at on public.async_jobs(created_at desc);
create index if not exists idx_analytics_events_name on public.analytics_events(event_name);
create index if not exists idx_analytics_events_created_at on public.analytics_events(created_at desc);
