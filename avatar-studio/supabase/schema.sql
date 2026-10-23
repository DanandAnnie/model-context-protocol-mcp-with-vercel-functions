-- Avatar Studio persistence. One JSON document per video / avatar / translation / brand kit / API key / webhook settings / workspace / plan / agent.
create table if not exists public.studio_items (
  id          text primary key,
  kind        text not null,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Allowed kinds. Re-running this file after an upgrade refreshes the list.
alter table public.studio_items drop constraint if exists studio_items_kind_check;
alter table public.studio_items
  add constraint studio_items_kind_check check (kind in ('video', 'avatar', 'translation', 'brand', 'apikey', 'notify', 'workspace', 'invite', 'membership', 'plan', 'agent', 'conversation'));

create index if not exists studio_items_kind_created_idx
  on public.studio_items (kind, created_at desc);

-- Libraries are listed per owner (Supabase user id, or "local" without accounts).
create index if not exists studio_items_owner_idx
  on public.studio_items (kind, (data->>'ownerId'), created_at desc);

-- Provider webhooks look jobs up by their provider job id.
create index if not exists studio_items_provider_job_idx
  on public.studio_items (kind, (data->>'providerJobId'));

-- API keys are looked up by the hash of the presented secret.
create index if not exists studio_items_apikey_hash_idx
  on public.studio_items ((data->>'hash'))
  where kind = 'apikey';

-- The app talks to this table with the service-role key only, so RLS can stay
-- enabled with no policies: anonymous clients get nothing.
alter table public.studio_items enable row level security;
