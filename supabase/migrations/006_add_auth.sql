-- Teams (households / workspaces) for sharing data between users
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

-- RLS for teams: members can read/write their own team
alter table teams enable row level security;
create policy "Team members can read own team" on teams for select
  using (id in (select team_id from profiles where profiles.id = auth.uid()));
create policy "Team members can update own team" on teams for update
  using (id in (select team_id from profiles where profiles.id = auth.uid()));

-- RLS for profiles: can read teammates, update own
alter table profiles enable row level security;
create policy "Can read own team profiles" on profiles for select
  using (team_id in (select team_id from profiles p where p.id = auth.uid()));
create policy "Can update own profile" on profiles for update
  using (id = auth.uid());
create policy "Can insert own profile" on profiles for insert
  with check (id = auth.uid());

-- Drop existing overly-permissive policies and replace with team-scoped ones
-- Properties
drop policy if exists "Allow all for authenticated" on properties;
create policy "Team access" on properties for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Storage units
drop policy if exists "Allow all for authenticated" on storage_units;
create policy "Team access" on storage_units for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Items
drop policy if exists "Allow all for authenticated" on items;
create policy "Team access" on items for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Deals
drop policy if exists "Allow all for authenticated" on deals;
create policy "Team access" on deals for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Deal watches
drop policy if exists "Allow all for authenticated" on deal_watches;
create policy "Team access" on deal_watches for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Property expenses
drop policy if exists "Allow all for authenticated" on property_expenses;
create policy "Team access" on property_expenses for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Staging payments
drop policy if exists "Allow all for authenticated" on staging_payments;
create policy "Team access" on staging_payments for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Staging history
drop policy if exists "Allow all for authenticated" on staging_history;
create policy "Team access" on staging_history for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Item images
drop policy if exists "Allow all for authenticated" on item_images;
create policy "Team access" on item_images for all
  using (team_id in (select team_id from profiles where profiles.id = auth.uid()));

-- Auto-create profile + team on signup via trigger
create or replace function handle_new_user()
returns trigger as $$
declare
  new_team_id uuid;
begin
  -- Create a new team for this user
  insert into teams (name) values (coalesce(split_part(new.email, '@', 1), 'My Team') || '''s Team')
  returning id into new_team_id;

  -- Create profile linked to team
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

-- Drop trigger if exists, then create
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
