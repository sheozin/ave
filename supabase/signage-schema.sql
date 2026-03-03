-- ============================================================
-- LEOD Digital Signage — Database Schema
-- Run this in Supabase SQL Editor to enable the signage system
-- ============================================================

-- ── leod_signage_displays ─────────────────────────────────
-- One row per physical screen / display zone
CREATE TABLE IF NOT EXISTS leod_signage_displays (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID          NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  name            TEXT          NOT NULL,                          -- e.g. "Lobby Screen A"
  zone_type       TEXT          NOT NULL DEFAULT 'lobby'           -- lobby | registration | prefunction | breakroom | stage | custom
                  CHECK (zone_type IN ('lobby','registration','prefunction','breakroom','stage','custom')),
  orientation     TEXT          NOT NULL DEFAULT 'landscape'       -- landscape | portrait
                  CHECK (orientation IN ('landscape','portrait')),
  content_mode    TEXT          NOT NULL DEFAULT 'schedule'        -- schedule | wayfinding | sponsors | break | wifi | recall | custom
                  CHECK (content_mode IN ('schedule','wayfinding','sponsors','break','wifi','recall','custom')),
  filter_room     TEXT,                                            -- NULL = show all rooms; set = filter to specific room
  override_content JSONB,                                          -- { mode: 'break', message: '...', pushed_at: '...' }
  last_seen_at    TIMESTAMPTZ,                                     -- heartbeat from display page (updated every 30s)
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signage_displays_event ON leod_signage_displays (event_id);

-- ── leod_signage_sponsors ─────────────────────────────────
-- Sponsor logo library (shown in sponsor carousel mode)
CREATE TABLE IF NOT EXISTS leod_signage_sponsors (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID          NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  name        TEXT          NOT NULL,
  logo_url    TEXT,                                                -- Supabase Storage public URL
  bg_color    TEXT          NOT NULL DEFAULT '#0d0f17',           -- CSS color for display background
  sort_order  SMALLINT      NOT NULL DEFAULT 0,
  active      BOOLEAN       NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_signage_sponsors_event ON leod_signage_sponsors (event_id, active);

-- ── RLS Policies ─────────────────────────────────────────
-- Enable RLS
ALTER TABLE leod_signage_displays ENABLE ROW LEVEL SECURITY;
ALTER TABLE leod_signage_sponsors ENABLE ROW LEVEL SECURITY;

-- Anon (display pages) can SELECT only
CREATE POLICY "anon_read_displays"
  ON leod_signage_displays FOR SELECT TO anon
  USING (true);

CREATE POLICY "anon_read_sponsors"
  ON leod_signage_sponsors FOR SELECT TO anon
  USING (true);

-- Anon can UPDATE last_seen_at only (heartbeat from display page)
-- NOTE: RLS alone cannot restrict to a single column — we use column-level privileges.
-- The policy below allows the UPDATE operation; the GRANT below restricts which column.
CREATE POLICY "anon_heartbeat"
  ON leod_signage_displays FOR UPDATE TO anon
  USING (true)
  WITH CHECK (true);

-- Restrict anon to only the last_seen_at column (prevents display pages from
-- changing their own mode/content_json/name via the anon key).
-- Run these two statements AFTER creating the table (they are idempotent):
REVOKE UPDATE ON leod_signage_displays FROM anon;
GRANT  UPDATE (last_seen_at) ON leod_signage_displays TO anon;

-- Authenticated operators can do everything
CREATE POLICY "auth_all_displays"
  ON leod_signage_displays FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_sponsors"
  ON leod_signage_sponsors FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ── Supabase Storage Bucket ───────────────────────────────
-- Create the storage bucket for sponsor logos:
-- Dashboard → Storage → New bucket → Name: "leod-assets" → Public: ON
--
-- Or via SQL (requires superuser):
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('leod-assets', 'leod-assets', true)
-- ON CONFLICT DO NOTHING;

-- ── Realtime ─────────────────────────────────────────────
-- Enable realtime for both tables (Dashboard → Database → Replication → Tables)
-- Or via SQL:
-- ALTER PUBLICATION supabase_realtime ADD TABLE leod_signage_displays;
-- ALTER PUBLICATION supabase_realtime ADD TABLE leod_signage_sponsors;
