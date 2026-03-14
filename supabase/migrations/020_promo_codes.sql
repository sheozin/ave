-- ============================================================
-- CueDeck — Migration 020: Promo / Gift Codes
-- Run this in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_promo_codes (
  code           TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('discount', 'trial_extension', 'plan_unlock')),
  stripe_coupon_id TEXT,
  extra_days     INT,
  granted_plan   TEXT,
  granted_months INT,
  max_uses       INT,
  uses           INT DEFAULT 0,
  expires_at     TIMESTAMPTZ,
  active         BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE leod_promo_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_promo_codes"
  ON leod_promo_codes FOR SELECT TO authenticated
  USING (true);
