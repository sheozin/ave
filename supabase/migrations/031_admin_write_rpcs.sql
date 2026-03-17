-- Migration 031: Admin write RPCs
-- Replaces Edge Functions for admin dashboard write operations.
-- Edge Functions gateway doesn't support sb_publishable_ key format,
-- so all admin writes are done via SECURITY DEFINER RPCs instead.

-- ──────────────────────────────────────────
-- 1. admin_update_subscription
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_update_subscription(
  p_action      TEXT,
  p_director_id UUID,
  p_plan        TEXT    DEFAULT NULL,
  p_days        INT     DEFAULT NULL,
  p_months      INT     DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sub RECORD;
  v_new_trial_end TIMESTAMPTZ;
  v_new_period_end TIMESTAMPTZ;
BEGIN
  -- Admin check
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Validate action
  IF p_action NOT IN ('override_plan', 'extend_trial', 'gift_months') THEN
    RAISE EXCEPTION 'Invalid action: %', p_action;
  END IF;

  -- Fetch subscription
  SELECT * INTO v_sub FROM leod_subscriptions WHERE director_id = p_director_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No subscription found for director %', p_director_id;
  END IF;

  -- Execute action
  IF p_action = 'override_plan' THEN
    IF p_plan IS NULL OR p_plan NOT IN ('trial', 'perevent', 'starter', 'pro', 'enterprise') THEN
      RAISE EXCEPTION 'Invalid plan: %', COALESCE(p_plan, 'null');
    END IF;
    UPDATE leod_subscriptions SET plan = p_plan, status = 'active' WHERE director_id = p_director_id;

  ELSIF p_action = 'extend_trial' THEN
    IF p_days IS NULL OR p_days <= 0 THEN
      RAISE EXCEPTION 'days must be a positive number';
    END IF;
    v_new_trial_end := COALESCE(v_sub.trial_ends_at, now()) + (p_days || ' days')::INTERVAL;
    UPDATE leod_subscriptions SET trial_ends_at = v_new_trial_end, status = 'active' WHERE director_id = p_director_id;

  ELSIF p_action = 'gift_months' THEN
    IF p_plan IS NULL OR p_plan NOT IN ('trial', 'perevent', 'starter', 'pro', 'enterprise') THEN
      RAISE EXCEPTION 'Invalid plan: %', COALESCE(p_plan, 'null');
    END IF;
    IF p_months IS NULL OR p_months <= 0 THEN
      RAISE EXCEPTION 'months must be a positive number';
    END IF;
    v_new_period_end := now() + (p_months || ' months')::INTERVAL;
    UPDATE leod_subscriptions SET plan = p_plan, status = 'active', current_period_end = v_new_period_end, trial_ends_at = NULL WHERE director_id = p_director_id;
  END IF;

  -- Audit log
  INSERT INTO leod_admin_audit (admin_id, action, target_type, target_id, details)
  VALUES (auth.uid(), 'manage_subscription.' || p_action, 'subscription', p_director_id::TEXT,
    jsonb_build_object('action', p_action, 'plan', p_plan, 'days', p_days, 'months', p_months));

  RETURN json_build_object('ok', true, 'action', p_action);
END;
$$;

-- ──────────────────────────────────────────
-- 2. admin_update_user
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_update_user(
  p_action  TEXT,
  p_user_id UUID,
  p_name    TEXT DEFAULT NULL,
  p_org     TEXT DEFAULT NULL,
  p_role    TEXT DEFAULT NULL,
  p_active  BOOLEAN DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Admin check
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_action = 'update_role' THEN
    UPDATE leod_users SET
      name = COALESCE(p_name, name),
      organization = COALESCE(p_org, organization),
      role = COALESCE(p_role, role),
      active = COALESCE(p_active, active)
    WHERE id = p_user_id;

  ELSIF p_action = 'suspend' THEN
    UPDATE leod_users SET active = false WHERE id = p_user_id;

  ELSIF p_action = 'reactivate' THEN
    UPDATE leod_users SET active = true WHERE id = p_user_id;

  ELSIF p_action = 'remove' THEN
    DELETE FROM leod_users WHERE id = p_user_id;

  ELSE
    RAISE EXCEPTION 'Invalid action: %', p_action;
  END IF;

  -- Audit log
  INSERT INTO leod_admin_audit (admin_id, action, target_type, target_id, details)
  VALUES (auth.uid(), 'manage_user.' || p_action, 'user', p_user_id::TEXT,
    jsonb_build_object('action', p_action, 'name', p_name, 'role', p_role, 'active', p_active));

  RETURN json_build_object('ok', true, 'action', p_action);
END;
$$;

-- ──────────────────────────────────────────
-- 3. admin_promote_user
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_promote_user(p_user_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot promote yourself';
  END IF;

  UPDATE leod_users SET role = 'admin' WHERE id = p_user_id;

  INSERT INTO leod_admin_audit (admin_id, action, target_type, target_id, details)
  VALUES (auth.uid(), 'promote_to_admin', 'user', p_user_id::TEXT, '{}'::JSONB);

  RETURN json_build_object('ok', true);
END;
$$;

-- ──────────────────────────────────────────
-- 4. admin_manage_promo
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_manage_promo(
  p_action          TEXT,
  p_code            TEXT DEFAULT NULL,
  p_type            TEXT DEFAULT NULL,
  p_discount_pct    INT  DEFAULT NULL,
  p_trial_days      INT  DEFAULT NULL,
  p_granted_plan    TEXT DEFAULT NULL,
  p_granted_months  INT  DEFAULT NULL,
  p_max_uses        INT  DEFAULT NULL,
  p_expires_at      TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_action = 'create' THEN
    IF p_code IS NULL OR p_type IS NULL THEN
      RAISE EXCEPTION 'code and type are required';
    END IF;
    INSERT INTO leod_promo_codes (code, type, discount_pct, trial_days, granted_plan, granted_months, max_uses, expires_at)
    VALUES (UPPER(TRIM(p_code)), p_type, p_discount_pct, p_trial_days, p_granted_plan, p_granted_months, p_max_uses, p_expires_at);

  ELSIF p_action = 'deactivate' THEN
    UPDATE leod_promo_codes SET active = false WHERE code = UPPER(TRIM(p_code));

  ELSIF p_action = 'activate' THEN
    UPDATE leod_promo_codes SET active = true WHERE code = UPPER(TRIM(p_code));

  ELSE
    RAISE EXCEPTION 'Invalid action: %', p_action;
  END IF;

  INSERT INTO leod_admin_audit (admin_id, action, target_type, target_id, details)
  VALUES (auth.uid(), 'manage_promo.' || p_action, 'promo', COALESCE(p_code, ''),
    jsonb_build_object('action', p_action, 'code', p_code, 'type', p_type));

  RETURN json_build_object('ok', true, 'action', p_action);
END;
$$;
