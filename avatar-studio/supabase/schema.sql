-- Avatar Studio persistence. One JSON document per video / avatar / translation.
create table if not exists public.studio_items (
  id          text primary key,
  kind        text not null check (kind in ('video', 'avatar', 'translation')),
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists studio_items_kind_created_idx
  on public.studio_items (kind, created_at desc);

-- The app talks to this table with the service-role key only, so RLS can stay
-- enabled with no policies: anonymous clients get nothing.
alter table public.studio_items enable row level security;
