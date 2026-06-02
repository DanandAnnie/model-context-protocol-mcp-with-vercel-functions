-- Room measurements synced across devices (previously localStorage-only)
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
