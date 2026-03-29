-- ============================================================
-- CueDeck Migration 008 — Signage Sequence Playlist
-- Adds a per-display sequence column so each display can
-- auto-rotate through multiple content panels (e.g. sponsors
-- → agenda → schedule) on configurable timers.
-- Run in Supabase SQL Editor.
-- ============================================================

ALTER TABLE leod_signage_displays ADD COLUMN IF NOT EXISTS sequence JSONB;

-- Example value:
-- [{"mode":"sponsors","duration":15},{"mode":"agenda","duration":20}]
-- duration is in seconds (min 5, max 300)
-- When null/empty the display uses its static content_mode (existing behaviour)
