-- ============================================================
-- CueDeck — Migration 011: Subscription & Billing Support
-- Run this in Supabase SQL Editor
-- ============================================================

-- ── 1. leod_subscriptions table ──────────────────────────────
CREATE TABLE IF NOT EXISTS leod_subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner: the director who pays. Operators inherit the plan.
  director_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Stripe references
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,

  -- Plan state
  plan             TEXT NOT NULL DEFAULT 'trial'
                   CHECK (plan IN ('trial', 'perevent', 'starter', 'pro', 'enterprise')),
  billing_interval TEXT CHECK (billing_interval IN ('month', 'year', NULL)),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'past_due', 'canceled', 'expired')),

  -- Trial tracking
  trial_ends_at    TIMESTAMPTZ,

  -- Per-event tracking
  events_purchased INT NOT NULL DEFAULT 0,
  events_used      INT NOT NULL DEFAULT 0,

  -- Stripe sync timestamps
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at            TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One subscription per director
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_director ON leod_subscriptions (director_id);
CREATE INDEX IF NOT EXISTS idx_sub_stripe_cust ON leod_subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_sub_stripe_sub ON leod_subscriptions (stripe_subscription_id);

-- ── 2. Row Level Security ────────────────────────────────────
ALTER TABLE leod_subscriptions ENABLE ROW LEVEL SECURITY;

-- Directors can read their own subscription
CREATE POLICY "directors_read_own_sub"
  ON leod_subscriptions FOR SELECT TO authenticated
  USING (director_id = auth.uid());

-- Directors can insert their own trial row
CREATE POLICY "directors_insert_own_trial"
  ON leod_subscriptions FOR INSERT TO authenticated
  WITH CHECK (director_id = auth.uid() AND plan = 'trial');

-- ── 3. Auto-update updated_at ────────────────────────────────
CREATE OR REPLACE FUNCTION update_sub_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sub_updated ON leod_subscriptions;
CREATE TRIGGER trg_sub_updated
  BEFORE UPDATE ON leod_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_sub_timestamp();

-- ── 4. RPC: get_subscription_for_user ────────────────────────
-- Returns the subscription for the current user (director or operator).
-- Operators look up their director's subscription via invited_by.
CREATE OR REPLACE FUNCTION get_subscription_for_user()
RETURNS TABLE (
  plan TEXT,
  status TEXT,
  trial_ends_at TIMESTAMPTZ,
  events_purchased INT,
  events_used INT,
  current_period_end TIMESTAMPTZ,
  cancel_at TIMESTAMPTZ,
  billing_interval TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_director_id UUID;
BEGIN
  SELECT u.role, u.invited_by INTO v_role, v_director_id
  FROM leod_users u WHERE u.id = v_uid;

  -- Directors own their own subscription
  IF v_role = 'director' OR v_director_id IS NULL THEN
    v_director_id := v_uid;
  END IF;

  RETURN QUERY
  SELECT s.plan, s.status, s.trial_ends_at,
         s.events_purchased, s.events_used,
         s.current_period_end, s.cancel_at, s.billing_interval
  FROM leod_subscriptions s
  WHERE s.director_id = v_director_id;
END;
$$;
