-- toon-video-production: characters + video jobs + storage buckets
-- Conventions: snake_case, uuid PKs, created_at/updated_at, RLS default-deny
-- (no policies -> only service_role can read/write).

create extension if not exists pgcrypto;

-- Namespaced trigger function so we never clobber another migration's helper.
create or replace function public.toon_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.toon_characters (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  style text not null check (style in ('classic-cartoon', 'flat-modern', '3d-soft')),
  description text not null default '',
  reference_image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One canonical sheet per character per style; the same slug may exist in
  -- several styles (the style token changes the render, not the character).
  unique (slug, style)
);

create table if not exists public.toon_video_jobs (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null unique,
  title text not null,
  style text not null check (style in ('classic-cartoon', 'flat-modern', '3d-soft')),
  status text not null default 'planning'
    check (status in ('planning', 'voicing', 'rendering', 'awaiting_approval', 'approved', 'killed')),
  scene_plan jsonb not null default '{}'::jsonb,
  output_url text,
  credit_cost_estimate numeric(10, 4),
  credit_cost_actual numeric(10, 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists toon_video_jobs_status_idx on public.toon_video_jobs (status);

drop trigger if exists toon_characters_updated_at on public.toon_characters;
create trigger toon_characters_updated_at
  before update on public.toon_characters
  for each row execute function public.toon_set_updated_at();

drop trigger if exists toon_video_jobs_updated_at on public.toon_video_jobs;
create trigger toon_video_jobs_updated_at
  before update on public.toon_video_jobs
  for each row execute function public.toon_set_updated_at();

-- Default-deny RLS: enabled with zero policies. The pipeline talks to these
-- tables with the service role key, which bypasses RLS.
alter table public.toon_characters enable row level security;
alter table public.toon_video_jobs enable row level security;

-- Private storage buckets. Previews go out as signed URLs, never public.
insert into storage.buckets (id, name, public)
values ('toon-videos', 'toon-videos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('toon-characters', 'toon-characters', false)
on conflict (id) do nothing;
