-- Add photo_url column to properties (for existing databases)
alter table properties add column if not exists photo_url text not null default '';
