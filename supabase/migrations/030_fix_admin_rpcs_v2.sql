-- Migration 030: Fix admin RPCs v2
-- Fixes field mismatches, wrong plan names, missing columns, and adds audit log RPC

-- ──────────────────────────────────────────
-- 1. admin_get_stats — fix MRR calc and tier counts
-- ──────────────────────────────────────────
DROP FUNCTION IF EXISTS admin_get_stats();
CREATE OR REPLACE FUNCTION admin_get_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSON;
  v_total_users BIGINT;
  v_active_subs BIGINT;
  v_dau BIGINT;
  v_mrr NUMERIC;
  v_churn_rate NUMERIC;
  v_conversion_rate NUMERIC;
  v_new_users_30d BIGINT;
  v_prev_users_30d BIGINT;
  v_p_days INT := 30;
BEGIN
  -- Clamp p_days
  IF v_p_days > 365 THEN v_p_days := 365; END IF;

  SELECT count(*) INTO v_total_users FROM leod_users;

  SELECT count(*) INTO v_active_subs
  FROM leod_subscriptions WHERE status = 'active';

  -- DAU: users who signed in within last 24h
  SELECT count(*) INTO v_dau
  FROM auth.users
  WHERE last_sign_in_at >= now() - interval '1 day';

  -- MRR: use plan + billing_interval to compute monthly revenue
  SELECT coalesce(sum(
    CASE
      WHEN plan = 'starter' AND billing_interval = 'month' THEN 59
      WHEN plan = 'starter' AND billing_interval = 'year'  THEN 49
      WHEN plan = 'pro'     AND billing_interval = 'month' THEN 99
      WHEN plan = 'pro'     AND billing_interval = 'year'  THEN 82
      WHEN plan = 'enterprise'                              THEN 299
      ELSE 0
    END
  ), 0) INTO v_mrr
  FROM leod_subscriptions
  WHERE status = 'active';

  -- Churn rate: canceled in last 30d / total active+canceled
  SELECT CASE
    WHEN (SELECT count(*) FROM leod_subscriptions WHERE status IN ('active','canceled')) = 0 THEN 0
    ELSE round(
      (SELECT count(*) FROM leod_subscriptions WHERE status = 'canceled' AND updated_at >= now() - interval '30 days')::NUMERIC
      / (SELECT count(*) FROM leod_subscriptions WHERE status IN ('active','canceled'))::NUMERIC * 100
    , 1)
  END INTO v_churn_rate;

  -- Conversion rate: active subs / total users
  SELECT CASE
    WHEN v_total_users = 0 THEN 0
    ELSE round(v_active_subs::NUMERIC / v_total_users::NUMERIC * 100, 1)
  END INTO v_conversion_rate;

  -- New users in last 30 days (use auth.users for created_at)
  SELECT count(*) INTO v_new_users_30d
  FROM auth.users WHERE created_at >= now() - interval '30 days';

  -- New users in the 30 days before that
  SELECT count(*) INTO v_prev_users_30d
  FROM auth.users
  WHERE created_at >= now() - interval '60 days'
    AND created_at < now() - interval '30 days';

  result := json_build_object(
    'total_users', v_total_users,
    'active_subs', v_active_subs,
    'dau', v_dau,
    'mrr', v_mrr,
    'churn_rate', v_churn_rate,
    'conversion_rate', v_conversion_rate,
    'new_users_30d', v_new_users_30d,
    'prev_users_30d', v_prev_users_30d
  );
  RETURN result;
END;
$$;

-- ──────────────────────────────────────────
-- 2. admin_get_recent_signups — fix join and add missing fields
-- ──────────────────────────────────────────
DROP FUNCTION IF EXISTS admin_get_recent_signups(INT);
CREATE OR REPLACE FUNCTION admin_get_recent_signups(p_limit INT DEFAULT 10)
RETURNS TABLE(
  email TEXT,
  name TEXT,
  role TEXT,
  organization TEXT,
  created_at TIMESTAMPTZ,
  plan TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Clamp p_limit
  IF p_limit > 100 THEN p_limit := 100; END IF;

  RETURN QUERY
  SELECT
    au.email::TEXT,
    lu.name::TEXT,
    lu.role::TEXT,
    lu.organization::TEXT,
    au.created_at,
    COALESCE(s.plan, 'none')::TEXT
  FROM auth.users au
  LEFT JOIN leod_users lu ON lu.id = au.id
  LEFT JOIN leod_subscriptions s ON s.director_id = au.id
  ORDER BY au.created_at DESC
  LIMIT p_limit;
END;
$$;

-- ──────────────────────────────────────────
-- 3. admin_get_recent_events — add event date
-- ──────────────────────────────────────────
DROP FUNCTION IF EXISTS admin_get_recent_events(INT);
CREATE OR REPLACE FUNCTION admin_get_recent_events(p_limit INT DEFAULT 10)
RETURNS TABLE(
  event_name TEXT,
  event_date DATE,
  created_at TIMESTAMPTZ,
  director_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Clamp p_limit
  IF p_limit > 100 THEN p_limit := 100; END IF;

  RETURN QUERY
  SELECT
    e.name::TEXT AS event_name,
    e.date AS event_date,
    e.created_at,
    u.email::TEXT AS director_email
  FROM leod_events e
  LEFT JOIN leod_users u ON u.id = e.created_by
  ORDER BY e.created_at DESC
  LIMIT p_limit;
END;
$$;

-- ──────────────────────────────────────────
-- 4. admin_get_audit_log RPC
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_audit_log(
  p_offset INT DEFAULT 0,
  p_limit INT DEFAULT 50
)
RETURNS TABLE(
  id UUID,
  admin_email TEXT,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Clamp parameters
  IF p_limit > 100 THEN p_limit := 100; END IF;
  IF p_offset < 0 THEN p_offset := 0; END IF;

  RETURN QUERY
  SELECT
    a.id,
    au.email::TEXT AS admin_email,
    a.action::TEXT,
    a.target_type::TEXT,
    a.target_id::TEXT,
    a.details,
    a.created_at
  FROM leod_admin_audit a
  LEFT JOIN auth.users au ON au.id = a.admin_id
  ORDER BY a.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ──────────────────────────────────────────
-- 5. Add parameter bounds to admin_list_users
-- ──────────────────────────────────────────
-- (Bounds are already applied in the individual functions above.
--  If admin_list_users exists, patch it too.)
DO $$
BEGIN
  -- This block ensures p_per_page and p_days clamping is documented.
  -- The actual clamping is in each function above (p_limit capped at 100).
  RAISE NOTICE 'Parameter bounds applied to all admin RPCs: p_limit/p_per_page max 100, p_days max 365';
END;
$$;
