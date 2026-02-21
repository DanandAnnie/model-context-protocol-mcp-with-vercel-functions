-- Add photo_url column to properties and items (for existing databases)
alter table properties add column if not exists photo_url text not null default '';
alter table items add column if not exists photo_url text not null default '';
