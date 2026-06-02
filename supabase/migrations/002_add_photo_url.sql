-- Add photo_url column to properties, items, and storage_units (for existing databases)
alter table properties add column if not exists photo_url text not null default '';
alter table items add column if not exists photo_url text not null default '';
alter table storage_units add column if not exists photo_url text not null default '';
