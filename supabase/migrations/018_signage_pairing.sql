-- ============================================================
-- CueDeck — Migration 018: Signage Display Pairing
-- Run this in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_signage_pairing (
  code       TEXT PRIMARY KEY,
  display_id UUID,
  event_id   UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairing_code ON leod_signage_pairing (code);

ALTER TABLE leod_signage_pairing ENABLE ROW LEVEL SECURITY;

-- Both anon and authenticated need CRUD (display page is unauthenticated)
CREATE POLICY "anon_all_pairing" ON leod_signage_pairing FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_pairing" ON leod_signage_pairing FOR ALL TO authenticated USING (true) WITH CHECK (true);
