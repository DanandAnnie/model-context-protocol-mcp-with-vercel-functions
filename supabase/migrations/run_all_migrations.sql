-- ============================================================
-- Staging Inventory Manager — Combined Migration Script
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- ============================================================
-- Migration 001: Initial Schema
-- ============================================================

-- Properties table
create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  city text not null default '',
  bedrooms integer not null default 0,
  bathrooms numeric(3,1) not null default 0,
  sqft integer not null default 0,
  property_type text not null default 'house',
  notes text not null default '',
  photo_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Storage units table
create table if not exists storage_units (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  unit_number text not null default '',
  size text not null default '',
  monthly_cost numeric(10,2) not null default 0,
  notes text not null default '',
  photo_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Items table
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'other',
  subcategory text not null default '',
  value numeric(10,2) not null default 0,
  condition text not null default 'good',
  date_acquired date,
  notes text not null default '',
  photo_url text not null default '',
  current_location_type text not null default 'storage',
  current_storage_id uuid references storage_units(id) on delete set null,
  current_property_id uuid references properties(id) on delete set null,
  status text not null default 'available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Item images table
create table if not exists item_images (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id) on delete cascade,
  image_url text not null,
  is_primary boolean not null default false,
  uploaded_at timestamptz not null default now()
);

-- Staging history table
create table if not exists staging_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id) on delete cascade,
  from_location_type text,
  from_storage_id uuid references storage_units(id) on delete set null,
  from_property_id uuid references properties(id) on delete set null,
  to_location_type text not null,
  to_storage_id uuid references storage_units(id) on delete set null,
  to_property_id uuid references properties(id) on delete set null,
  moved_at timestamptz not null default now(),
  notes text not null default ''
);

-- Indexes
create index if not exists idx_items_storage on items(current_storage_id) where current_location_type = 'storage';
create index if not exists idx_items_property on items(current_property_id) where current_location_type = 'property';
create index if not exists idx_items_status on items(status);
create index if not exists idx_item_images_item on item_images(item_id);
create index if not exists idx_staging_history_item on staging_history(item_id);

-- RLS policies
alter table properties enable row level security;
alter table storage_units enable row level security;
alter table items enable row level security;
alter table item_images enable row level security;
alter table staging_history enable row level security;

-- Allow all operations for authenticated users (will be replaced by team-scoped policies in migration 006)
create policy "Allow all for authenticated" on properties for all using (true);
create policy "Allow all for authenticated" on storage_units for all using (true);
create policy "Allow all for authenticated" on items for all using (true);
create policy "Allow all for authenticated" on item_images for all using (true);
create policy "Allow all for authenticated" on staging_history for all using (true);

-- Storage bucket for item images
insert into storage.buckets (id, name, public) values ('item-images', 'item-images', true)
on conflict (id) do nothing;

-- Updated_at trigger function
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger properties_updated_at before update on properties
  for each row execute function update_updated_at();

create trigger storage_units_updated_at before update on storage_units
  for each row execute function update_updated_at();

create trigger items_updated_at before update on items
  for each row execute function update_updated_at();

-- ============================================================
-- Migration 002: Add photo_url (idempotent)
-- ============================================================

alter table properties add column if not exists photo_url text not null default '';
alter table items add column if not exists photo_url text not null default '';
alter table storage_units add column if not exists photo_url text not null default '';

-- ============================================================
-- Migration 003: Property Expenses
-- ============================================================

create table if not exists property_expenses (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  category text not null default 'other',
  description text not null default '',
  amount numeric(10,2) not null default 0,
  expense_date date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_property_expenses_property on property_expenses(property_id);
create index if not exists idx_property_expenses_category on property_expenses(category);

alter table property_expenses enable row level security;
create policy "Allow all for authenticated" on property_expenses for all using (true);

create trigger property_expenses_updated_at before update on property_expenses
  for each row execute function update_updated_at();

-- ============================================================
-- Migration 004: Staging Payments
-- ============================================================

create table if not exists staging_payments (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  amount numeric(10,2) not null default 0,
  payment_date date not null default current_date,
  payment_method text not null default 'other',
  month_covered text not null default '',
  square_transaction_id text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_staging_payments_property on staging_payments(property_id);
create index if not exists idx_staging_payments_month on staging_payments(month_covered);

alter table staging_payments enable row level security;
create policy "Allow all for authenticated" on staging_payments for all using (true);

-- ============================================================
-- Migration 005: Deal Finder
-- ============================================================

create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  source text not null default 'other',
  source_url text not null default '',
  image_url text not null default '',
  original_price numeric(10,2) not null default 0,
  sale_price numeric(10,2) not null default 0,
  discount_percent numeric(5,1) not null default 0,
  category text not null default '',
  retailer text not null default '',
  found_at timestamptz not null default now(),
  expires_at timestamptz,
  is_saved boolean not null default false,
  is_dismissed boolean not null default false,
  added_to_inventory boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists deal_watches (
  id uuid primary key default gen_random_uuid(),
  keywords text not null default '',
  category text not null default '',
  max_price numeric(10,2) not null default 0,
  min_discount numeric(5,1) not null default 0,
  sources text[] not null default '{}',
  notify boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_deals_source on deals(source);
create index if not exists idx_deals_saved on deals(is_saved) where is_saved = true;
create index if not exists idx_deals_found_at on deals(found_at);

alter table deals enable row level security;
alter table deal_watches enable row level security;

create policy "Allow all for authenticated" on deals for all using (true);
create policy "Allow all for authenticated" on deal_watches for all using (true);

create trigger deal_watches_updated_at before update on deal_watches
  for each row execute function update_updated_at();

-- ============================================================
-- Migration 006: Auth, Teams & Team-Scoped RLS
-- ============================================================

-- Teams (households / workspaces)
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Team',
  invite_code text unique default substr(md5(random()::text), 1, 8),
  created_at timestamptz default now()
);

-- User profiles linked to auth.users and a team
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  team_id uuid references teams(id),
  role text not null default 'member',
  created_at timestamptz default now()
);

-- Add team_id to all data tables
alter table properties add column if not exists team_id uuid references teams(id);
alter table storage_units add column if not exists team_id uuid references teams(id);
alter table items add column if not exists team_id uuid references teams(id);
alter table deals add column if not exists team_id uuid references teams(id);
alter table deal_watches add column if not exists team_id uuid references teams(id);
alter table property_expenses add column if not exists team_id uuid references teams(id);
alter table staging_payments add column if not exists team_id uuid references teams(id);
alter table staging_history add column if not exists team_id uuid references teams(id);
alter table item_images add column if not exists team_id uuid references teams(id);

-- RLS for teams
alter table teams enable row level security;
create policy "Team members can read own team" on teams for select
  using (id in (select team_id from profiles where profiles.id = auth.uid()));
create policy "Team members can update own team" on teams for update
  using (id in (select team_id from profiles where profiles.id = auth.uid()));

-- RLS for profiles
alter table profiles enable row level security;
create policy "Can read own team profiles" on profiles for select
  using (team_id in (select team_id from profiles p where p.id = auth.uid()));
create policy "Can update own profile" on profiles for update
  using (id = auth.uid());
create policy "Can insert own profile" on profiles for insert
  with check (id = auth.uid());

-- Replace overly-permissive policies with team-scoped ones
drop policy if exists "Allow all for authenticated" on properties;
create policy "Team access" on properties for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

drop policy if exists "Allow all for authenticated" on storage_units;
create policy "Team access" on storage_units for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

drop policy if exists "Allow all for authenticated" on items;
create policy "Team access" on items for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

drop policy if exists "Allow all for authenticated" on deals;
create policy "Team access" on deals for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

drop policy if exists "Allow all for authenticated" on deal_watches;
create policy "Team access" on deal_watches for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

drop policy if exists "Allow all for authenticated" on property_expenses;
create policy "Team access" on property_expenses for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

drop policy if exists "Allow all for authenticated" on staging_payments;
create policy "Team access" on staging_payments for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

drop policy if exists "Allow all for authenticated" on staging_history;
create policy "Team access" on staging_history for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

drop policy if exists "Allow all for authenticated" on item_images;
create policy "Team access" on item_images for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Auto-create profile + team on signup
create or replace function handle_new_user()
returns trigger as $$
declare
  new_team_id uuid;
begin
  insert into teams (name) values (coalesce(split_part(new.email, '@', 1), 'My Team') || '''s Team')
  returning id into new_team_id;

  insert into profiles (id, email, display_name, team_id, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new_team_id,
    'owner'
  );

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- Migration 007: Item Dimensions
-- ============================================================

alter table items add column if not exists length_inches numeric default 0;
alter table items add column if not exists width_inches numeric default 0;
alter table items add column if not exists height_inches numeric default 0;

-- ============================================================
-- Migration 008: Property Rooms with Realtime Sync
-- ============================================================

create table if not exists property_rooms (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  name text not null default '',
  length_ft numeric(8,2) not null default 0,
  width_ft numeric(8,2) not null default 0,
  team_id uuid references teams(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_property_rooms_property on property_rooms(property_id);

alter table property_rooms enable row level security;
create policy "Team access" on property_rooms for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

create trigger property_rooms_updated_at before update on property_rooms
  for each row execute function update_updated_at();

-- Enable realtime for cross-device sync
alter publication supabase_realtime add table property_rooms;

-- ============================================================
-- Migration 009: Enable Realtime on ALL tables for cross-device sync
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'properties'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE properties;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE items;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'storage_units'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE storage_units;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'staging_payments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE staging_payments;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'property_expenses'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE property_expenses;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'deals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE deals;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'deal_watches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE deal_watches;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'staging_history'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE staging_history;
  END IF;
END
$$;
