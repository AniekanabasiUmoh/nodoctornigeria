alter table public.async_jobs
  add column if not exists channel text default 'community_voice_job',
  add column if not exists query text,
  add column if not exists top_k integer,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_error text;

update public.async_jobs
set
  channel = coalesce(channel, 'community_voice_job'),
  query = coalesce(query, ''),
  top_k = coalesce(top_k, 4),
  attempt_count = coalesce(attempt_count, 0)
where
  channel is null
  or query is null
  or top_k is null;

alter table public.async_jobs
  alter column channel set not null,
  alter column query set not null,
  alter column top_k set not null;

create index if not exists idx_async_jobs_channel on public.async_jobs(channel);
