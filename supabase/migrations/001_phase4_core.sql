create table if not exists public.audit_interactions (
  interaction_id text primary key,
  created_at timestamptz not null default now(),
  route text not null,
  channel text not null,
  query text not null,
  top_k integer not null,
  job_id text,
  response jsonb not null
);

create table if not exists public.feedback_events (
  feedback_id text primary key,
  interaction_id text not null references public.audit_interactions(interaction_id) on delete cascade,
  created_at timestamptz not null default now(),
  rating text not null check (rating in ('up', 'down')),
  comment text
);

create table if not exists public.channel_messages (
  message_id bigserial primary key,
  created_at timestamptz not null default now(),
  channel text not null,
  external_user_id text,
  message_type text not null,
  payload jsonb not null
);

create index if not exists idx_audit_interactions_created_at on public.audit_interactions(created_at desc);
create index if not exists idx_audit_interactions_channel on public.audit_interactions(channel);
create index if not exists idx_feedback_events_interaction_id on public.feedback_events(interaction_id);
create index if not exists idx_channel_messages_channel on public.channel_messages(channel);
