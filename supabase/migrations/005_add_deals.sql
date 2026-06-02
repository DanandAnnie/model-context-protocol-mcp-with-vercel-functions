-- Deal Finder tables

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
