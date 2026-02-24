-- Add dimension fields to items (stored in inches)
alter table items add column if not exists length_inches numeric default 0;
alter table items add column if not exists width_inches numeric default 0;
alter table items add column if not exists height_inches numeric default 0;
