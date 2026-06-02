-- Staging Payments table (was referenced in code but missing migration)

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
