-- Migration 009: Enable Realtime on all tables for cross-device sync
-- This ensures changes on Android reflect on iOS and vice versa.
-- Tables already in the publication will be skipped (idempotent).

DO $$
BEGIN
  -- Core tables
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'properties'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE properties;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE items;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'storage_units'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE storage_units;
  END IF;

  -- Financial tables
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'staging_payments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE staging_payments;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'property_expenses'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE property_expenses;
  END IF;

  -- Deal tables
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'deals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE deals;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'deal_watches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE deal_watches;
  END IF;

  -- History & rooms (rooms may already be added from migration 008)
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'staging_history'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE staging_history;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'property_rooms'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE property_rooms;
  END IF;
END
$$;
