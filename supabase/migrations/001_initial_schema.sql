-- Staging Inventory Manager — Initial Schema

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

-- Allow all operations for authenticated users (customize as needed)
create policy "Allow all for authenticated" on properties for all using (true);
create policy "Allow all for authenticated" on storage_units for all using (true);
create policy "Allow all for authenticated" on items for all using (true);
create policy "Allow all for authenticated" on item_images for all using (true);
create policy "Allow all for authenticated" on staging_history for all using (true);

-- Storage bucket for item images (run via Supabase dashboard or API)
-- insert into storage.buckets (id, name, public) values ('item-images', 'item-images', true);

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
