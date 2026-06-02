-- Property expenses for per-property cost tracking and break-even analysis
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
