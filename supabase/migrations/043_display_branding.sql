-- ============================================================
-- Migration 043: Custom branding for signage displays
-- ============================================================
-- Adds branding fields to events so display screens can show
-- client logos and colors instead of CueDeck defaults.
-- ============================================================

-- Add branding columns to leod_events
ALTER TABLE leod_events ADD COLUMN IF NOT EXISTS client_name  TEXT;
ALTER TABLE leod_events ADD COLUMN IF NOT EXISTS client_logo  TEXT;  -- URL to logo image
ALTER TABLE leod_events ADD COLUMN IF NOT EXISTS brand_color  TEXT DEFAULT '#3b82f6';  -- hex color
ALTER TABLE leod_events ADD COLUMN IF NOT EXISTS brand_color2 TEXT;  -- optional secondary color
