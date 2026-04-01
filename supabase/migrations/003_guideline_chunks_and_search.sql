create table if not exists public.guideline_chunks (
  chunk_id text primary key,
  text text not null,
  word_count integer not null,
  metadata jsonb not null,
  search_document tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(text, '') || ' ' ||
      coalesce(metadata->>'condition', '') || ' ' ||
      coalesce(metadata->>'section', '') || ' ' ||
      coalesce(metadata->>'subsection', '') || ' ' ||
      coalesce(metadata->>'chapter', '')
    )
  ) stored
);

create index if not exists idx_guideline_chunks_search_document
  on public.guideline_chunks using gin (search_document);

create or replace function public.search_guideline_chunks(query_text text, match_count integer default 5)
returns table (
  chunk_id text,
  text text,
  word_count integer,
  metadata jsonb,
  score real
)
language sql
stable
as $$
  with ts_query as (
    select websearch_to_tsquery('simple', coalesce(query_text, '')) as query
  )
  select
    gc.chunk_id,
    gc.text,
    gc.word_count,
    gc.metadata,
    ts_rank(gc.search_document, ts_query.query)
      + case
          when lower(coalesce(gc.metadata->>'condition', '')) = lower(coalesce(query_text, '')) then 2.0
          when lower(coalesce(query_text, '')) like '%' || lower(coalesce(gc.metadata->>'condition', '')) || '%' then 1.0
          else 0.0
        end as score
  from public.guideline_chunks gc
  cross join ts_query
  where gc.search_document @@ ts_query.query
  order by score desc, gc.word_count desc
  limit greatest(coalesce(match_count, 5), 1);
$$;
