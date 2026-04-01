alter table public.audit_interactions
  add column if not exists normalized_query text,
  add column if not exists trace jsonb not null default '{}'::jsonb,
  add column if not exists review_required boolean not null default false,
  add column if not exists review_status text;

update public.audit_interactions
set normalized_query = coalesce(normalized_query, query)
where normalized_query is null;

alter table public.audit_interactions
  alter column normalized_query set not null;

create index if not exists idx_audit_interactions_review_required
  on public.audit_interactions(review_required);
