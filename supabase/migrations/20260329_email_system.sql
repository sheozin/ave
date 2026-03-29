-- ══════════════════════════════════════════════════════════════════
-- CueDeck — Email System Migration
-- Creates tables for email logging, queue, and first-login tracking
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Email Log: Track all sent emails ───────────────────────────
CREATE TABLE IF NOT EXISTS email_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  email_type    TEXT        NOT NULL,
  email_address TEXT        NOT NULL,
  resend_id     TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at     TIMESTAMPTZ,
  clicked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_email_log_user_type ON email_log(user_id, email_type);
CREATE INDEX IF NOT EXISTS idx_email_log_sent_at ON email_log(sent_at DESC);

-- ── 2. Email Queue: Scheduled emails pending delivery ─────────────
CREATE TABLE IF NOT EXISTS email_queue (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  email_address TEXT        NOT NULL,
  user_name     TEXT,
  email_type    TEXT        NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'cancelled')),
  sent_at       TIMESTAMPTZ,
  resend_id     TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for queue processing
CREATE INDEX IF NOT EXISTS idx_email_queue_pending ON email_queue(status, scheduled_for)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_email_queue_user ON email_queue(user_id);

-- ── 3. User Login Tracking: First login detection ────────────────
-- Add first_login_at column to leod_users
ALTER TABLE leod_users
ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS welcome_email_sent BOOLEAN DEFAULT false;

-- ── 4. Function: Track login and trigger welcome email ───────────
CREATE OR REPLACE FUNCTION track_user_login()
RETURNS TRIGGER AS $$
DECLARE
  is_first_login BOOLEAN;
  user_email TEXT;
  user_name TEXT;
BEGIN
  -- Get user info
  SELECT email, raw_user_meta_data->>'name' INTO user_email, user_name
  FROM auth.users WHERE id = NEW.id;

  -- Check if this is first login
  SELECT (first_login_at IS NULL) INTO is_first_login
  FROM leod_users WHERE id = NEW.id;

  -- Update login tracking
  UPDATE leod_users SET
    first_login_at = COALESCE(first_login_at, now()),
    last_login_at = now(),
    login_count = COALESCE(login_count, 0) + 1
  WHERE id = NEW.id;

  -- If first login, queue welcome email via Edge Function
  IF is_first_login AND NOT COALESCE(
    (SELECT welcome_email_sent FROM leod_users WHERE id = NEW.id), false
  ) THEN
    -- Mark as queued to prevent duplicates
    UPDATE leod_users SET welcome_email_sent = true WHERE id = NEW.id;

    -- Insert into a trigger queue table for the Edge Function to process
    INSERT INTO welcome_email_trigger (user_id, email, name, triggered_at)
    VALUES (NEW.id, user_email, user_name, now())
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 5. Welcome Email Trigger Queue ────────────────────────────────
CREATE TABLE IF NOT EXISTS welcome_email_trigger (
  user_id      UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT        NOT NULL,
  name         TEXT,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed    BOOLEAN     DEFAULT false,
  processed_at TIMESTAMPTZ
);

-- ── 6. Create trigger on leod_users for login tracking ────────────
-- Note: This requires auth hook setup in Supabase Dashboard
-- Go to: Authentication → Hooks → After Sign In

-- For now, we'll create a simpler approach using a function that
-- can be called from the frontend on successful login
CREATE OR REPLACE FUNCTION handle_first_login(p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_is_first_login BOOLEAN;
  v_user_email TEXT;
  v_user_name TEXT;
  v_result JSONB;
BEGIN
  -- Get user info
  SELECT email, name INTO v_user_email, v_user_name
  FROM leod_users WHERE id = p_user_id;

  IF v_user_email IS NULL THEN
    RETURN jsonb_build_object('error', 'User not found');
  END IF;

  -- Check if first login
  SELECT (first_login_at IS NULL) INTO v_is_first_login
  FROM leod_users WHERE id = p_user_id;

  -- Update login info
  UPDATE leod_users SET
    first_login_at = COALESCE(first_login_at, now()),
    last_login_at = now(),
    login_count = COALESCE(login_count, 0) + 1
  WHERE id = p_user_id;

  -- If first login, queue welcome email
  IF v_is_first_login THEN
    INSERT INTO welcome_email_trigger (user_id, email, name)
    VALUES (p_user_id, v_user_email, v_user_name)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE leod_users SET welcome_email_sent = true WHERE id = p_user_id;

    v_result := jsonb_build_object(
      'first_login', true,
      'welcome_email_queued', true
    );
  ELSE
    v_result := jsonb_build_object(
      'first_login', false,
      'login_count', (SELECT login_count FROM leod_users WHERE id = p_user_id)
    );
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 7. RLS Policies ───────────────────────────────────────────────
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE welcome_email_trigger ENABLE ROW LEVEL SECURITY;

-- Users can only see their own email log
CREATE POLICY email_log_user_read ON email_log FOR SELECT
  USING (auth.uid() = user_id);

-- Email queue is service-only
CREATE POLICY email_queue_service ON email_queue FOR ALL
  USING (auth.role() = 'service_role');

-- Welcome trigger is service-only
CREATE POLICY welcome_trigger_service ON welcome_email_trigger FOR ALL
  USING (auth.role() = 'service_role');

-- ══════════════════════════════════════════════════════════════════
-- USAGE:
-- 1. Run this migration in Supabase SQL Editor
-- 2. Set up RESEND_API_KEY in Supabase Edge Function secrets:
--    supabase secrets set RESEND_API_KEY=re_xxxx
-- 3. Deploy Edge Functions:
--    supabase functions deploy send-welcome-email
--    supabase functions deploy process-email-queue
-- 4. Set up cron job for process-email-queue (hourly):
--    In Supabase Dashboard → Database → Cron
-- 5. Call handle_first_login(user_id) after successful auth in frontend
-- ══════════════════════════════════════════════════════════════════
