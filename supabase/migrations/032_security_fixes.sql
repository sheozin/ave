-- Migration 032: Critical security fixes for admin dashboard
-- Fixes: missing admin checks in RPCs, column name mismatches, privilege escalation

-- ──────────────────────────────────────────
-- 1. CRITICAL: Restore admin checks to RPCs from migration 030
--    These were accidentally dropped when replacing the functions.
-- ──────────────────────────────────────────

-- 1a. admin_get_stats — add admin check
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
  -- ADMIN CHECK
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF v_p_days > 365 THEN v_p_days := 365; END IF;

  SELECT count(*) INTO v_total_users FROM leod_users;
  SELECT count(*) INTO v_active_subs FROM leod_subscriptions WHERE status = 'active';

  SELECT count(*) INTO v_dau FROM auth.users WHERE last_sign_in_at >= now() - interval '1 day';

  SELECT coalesce(sum(
    CASE
      WHEN plan = 'starter' AND billing_interval = 'month' THEN 59
      WHEN plan = 'starter' AND billing_interval = 'year'  THEN 49
      WHEN plan = 'pro'     AND billing_interval = 'month' THEN 99
      WHEN plan = 'pro'     AND billing_interval = 'year'  THEN 82
      WHEN plan = 'enterprise'                              THEN 299
      ELSE 0
    END
  ), 0) INTO v_mrr FROM leod_subscriptions WHERE status = 'active';

  SELECT CASE
    WHEN (SELECT count(*) FROM leod_subscriptions WHERE status IN ('active','canceled')) = 0 THEN 0
    ELSE round(
      (SELECT count(*) FROM leod_subscriptions WHERE status = 'canceled' AND updated_at >= now() - interval '30 days')::NUMERIC
      / (SELECT count(*) FROM leod_subscriptions WHERE status IN ('active','canceled'))::NUMERIC * 100
    , 1)
  END INTO v_churn_rate;

  SELECT CASE
    WHEN v_total_users = 0 THEN 0
    ELSE round(v_active_subs::NUMERIC / v_total_users::NUMERIC * 100, 1)
  END INTO v_conversion_rate;

  SELECT count(*) INTO v_new_users_30d FROM auth.users WHERE created_at >= now() - interval '30 days';
  SELECT count(*) INTO v_prev_users_30d FROM auth.users
  WHERE created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days';

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

-- 1b. admin_get_recent_signups — add admin check
DROP FUNCTION IF EXISTS admin_get_recent_signups(INT);
CREATE OR REPLACE FUNCTION admin_get_recent_signups(p_limit INT DEFAULT 10)
RETURNS TABLE(email TEXT, name TEXT, role TEXT, organization TEXT, created_at TIMESTAMPTZ, plan TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- ADMIN CHECK
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_limit > 100 THEN p_limit := 100; END IF;

  RETURN QUERY
  SELECT au.email::TEXT, lu.name::TEXT, lu.role::TEXT, lu.organization::TEXT, au.created_at,
    COALESCE(s.plan, 'none')::TEXT
  FROM auth.users au
  LEFT JOIN leod_users lu ON lu.id = au.id
  LEFT JOIN leod_subscriptions s ON s.director_id = au.id
  ORDER BY au.created_at DESC
  LIMIT p_limit;
END;
$$;

-- 1c. admin_get_recent_events — add admin check
DROP FUNCTION IF EXISTS admin_get_recent_events(INT);
CREATE OR REPLACE FUNCTION admin_get_recent_events(p_limit INT DEFAULT 10)
RETURNS TABLE(event_name TEXT, event_date DATE, created_at TIMESTAMPTZ, director_email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- ADMIN CHECK
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_limit > 100 THEN p_limit := 100; END IF;

  RETURN QUERY
  SELECT e.name::TEXT AS event_name, e.date AS event_date, e.created_at,
    u.email::TEXT AS director_email
  FROM leod_events e
  LEFT JOIN leod_users u ON u.id = e.created_by
  ORDER BY e.created_at DESC
  LIMIT p_limit;
END;
$$;

-- 1d. admin_get_audit_log — add admin check
CREATE OR REPLACE FUNCTION admin_get_audit_log(p_offset INT DEFAULT 0, p_limit INT DEFAULT 50)
RETURNS TABLE(id UUID, admin_email TEXT, action TEXT, target_type TEXT, target_id TEXT, details JSONB, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- ADMIN CHECK
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_limit > 100 THEN p_limit := 100; END IF;
  IF p_offset < 0 THEN p_offset := 0; END IF;

  RETURN QUERY
  SELECT a.id, au.email::TEXT AS admin_email, a.action::TEXT, a.target_type::TEXT,
    a.target_id::TEXT, a.details, a.created_at
  FROM leod_admin_audit a
  LEFT JOIN auth.users au ON au.id = a.admin_id
  ORDER BY a.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

-- ──────────────────────────────────────────
-- 2. CRITICAL: Fix admin_manage_promo column names
--    RPC used discount_pct/trial_days but table has stripe_coupon_id/extra_days
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
  p_expires_at      TIMESTAMPTZ DEFAULT NULL,
  p_stripe_coupon   TEXT DEFAULT NULL
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
    IF p_type NOT IN ('discount', 'trial_extension', 'plan_unlock') THEN
      RAISE EXCEPTION 'Invalid type: must be discount, trial_extension, or plan_unlock';
    END IF;
    INSERT INTO leod_promo_codes (code, type, stripe_coupon_id, extra_days, granted_plan, granted_months, max_uses, expires_at)
    VALUES (UPPER(TRIM(p_code)), p_type, p_stripe_coupon, p_trial_days, p_granted_plan, p_granted_months, p_max_uses, p_expires_at);

  ELSIF p_action = 'deactivate' THEN
    UPDATE leod_promo_codes SET active = false WHERE code = UPPER(TRIM(p_code));

  ELSIF p_action = 'activate' THEN
    UPDATE leod_promo_codes SET active = true WHERE code = UPPER(TRIM(p_code));

  ELSE
    RAISE EXCEPTION 'Invalid action: must be create, deactivate, or activate';
  END IF;

  INSERT INTO leod_admin_audit (admin_id, action, target_type, target_id, details)
  VALUES (auth.uid(), 'manage_promo.' || p_action, 'promo', COALESCE(p_code, ''),
    jsonb_build_object('action', p_action, 'code', p_code, 'type', p_type));

  RETURN json_build_object('ok', true, 'action', p_action);
END;
$$;

-- ──────────────────────────────────────────
-- 3. CRITICAL: Fix privilege escalation in admin_update_user
--    Block setting role='admin' via update_role (must use admin_promote_user)
--    Validate role against allowed values
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
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_action = 'update_role' THEN
    -- Validate role
    IF p_role IS NOT NULL AND p_role NOT IN ('director', 'stage', 'av', 'interp', 'reg', 'signage', 'pending') THEN
      RAISE EXCEPTION 'Invalid role: %. Use admin_promote_user to promote to admin.', p_role;
    END IF;
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
    -- Clean up subscription before removing user
    DELETE FROM leod_subscriptions WHERE director_id = p_user_id;
    DELETE FROM leod_users WHERE id = p_user_id;

  ELSE
    RAISE EXCEPTION 'Invalid action: must be update_role, suspend, reactivate, or remove';
  END IF;

  INSERT INTO leod_admin_audit (admin_id, action, target_type, target_id, details)
  VALUES (auth.uid(), 'manage_user.' || p_action, 'user', p_user_id::TEXT,
    jsonb_build_object('action', p_action, 'name', p_name, 'role', p_role, 'active', p_active));

  RETURN json_build_object('ok', true, 'action', p_action);
END;
$$;

-- ──────────────────────────────────────────
-- 4. Add upper bounds to admin_update_subscription
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
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_action NOT IN ('override_plan', 'extend_trial', 'gift_months') THEN
    RAISE EXCEPTION 'Invalid action: %', p_action;
  END IF;

  SELECT * INTO v_sub FROM leod_subscriptions WHERE director_id = p_director_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No subscription found for this director';
  END IF;

  IF p_action = 'override_plan' THEN
    IF p_plan IS NULL OR p_plan NOT IN ('trial', 'perevent', 'starter', 'pro', 'enterprise') THEN
      RAISE EXCEPTION 'Invalid plan: %', COALESCE(p_plan, 'null');
    END IF;
    UPDATE leod_subscriptions SET plan = p_plan, status = 'active' WHERE director_id = p_director_id;

  ELSIF p_action = 'extend_trial' THEN
    IF p_days IS NULL OR p_days <= 0 THEN RAISE EXCEPTION 'days must be a positive number'; END IF;
    IF p_days > 365 THEN RAISE EXCEPTION 'days cannot exceed 365'; END IF;
    v_new_trial_end := COALESCE(v_sub.trial_ends_at, now()) + (p_days || ' days')::INTERVAL;
    UPDATE leod_subscriptions SET trial_ends_at = v_new_trial_end, status = 'active' WHERE director_id = p_director_id;

  ELSIF p_action = 'gift_months' THEN
    IF p_plan IS NULL OR p_plan NOT IN ('trial', 'perevent', 'starter', 'pro', 'enterprise') THEN
      RAISE EXCEPTION 'Invalid plan: %', COALESCE(p_plan, 'null');
    END IF;
    IF p_months IS NULL OR p_months <= 0 THEN RAISE EXCEPTION 'months must be a positive number'; END IF;
    IF p_months > 36 THEN RAISE EXCEPTION 'months cannot exceed 36'; END IF;
    v_new_period_end := now() + (p_months || ' months')::INTERVAL;
    UPDATE leod_subscriptions SET plan = p_plan, status = 'active', current_period_end = v_new_period_end, trial_ends_at = NULL WHERE director_id = p_director_id;
  END IF;

  INSERT INTO leod_admin_audit (admin_id, action, target_type, target_id, details)
  VALUES (auth.uid(), 'manage_subscription.' || p_action, 'subscription', p_director_id::TEXT,
    jsonb_build_object('action', p_action, 'plan', p_plan, 'days', p_days, 'months', p_months));

  RETURN json_build_object('ok', true, 'action', p_action);
END;
$$;

-- ──────────────────────────────────────────
-- 5. Clamp p_per_page in admin_list_users and admin_list_subscriptions
-- ──────────────────────────────────────────
-- admin_list_users: already defined in 029, add bounds
CREATE OR REPLACE FUNCTION admin_list_users(
  p_search        TEXT    DEFAULT NULL,
  p_role_filter   TEXT    DEFAULT NULL,
  p_status_filter TEXT    DEFAULT NULL,
  p_page          INT     DEFAULT 1,
  p_per_page      INT     DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_offset INT;
  v_users  JSONB;
  v_total  BIGINT;
  v_result JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Clamp bounds
  IF p_per_page > 100 THEN p_per_page := 100; END IF;
  IF p_per_page < 1 THEN p_per_page := 25; END IF;
  IF p_page < 1 THEN p_page := 1; END IF;

  v_offset := ((p_page - 1) * p_per_page);

  SELECT
    jsonb_agg(row_to_json(q)),
    MAX(q.total_count)
  INTO v_users, v_total
  FROM (
    SELECT
      lu.id,
      lu.name,
      lu.role,
      lu.organization,
      lu.active,
      lu.invited_by,
      au.email,
      au.created_at,
      au.last_sign_in_at,
      count(*) OVER() AS total_count
    FROM leod_users lu
    JOIN auth.users au ON au.id = lu.id
    WHERE (p_search IS NULL
           OR au.email ILIKE '%' || p_search || '%'
           OR lu.name ILIKE '%' || p_search || '%'
           OR lu.organization ILIKE '%' || p_search || '%')
      AND (p_role_filter IS NULL OR lu.role = p_role_filter)
      AND (p_status_filter IS NULL
           OR (p_status_filter = 'active'   AND lu.active = true)
           OR (p_status_filter = 'inactive' AND lu.active = false))
    ORDER BY au.created_at DESC
    LIMIT p_per_page OFFSET v_offset
  ) q;

  v_result := jsonb_build_object(
    'total',    COALESCE(v_total, 0),
    'page',     p_page,
    'per_page', p_per_page,
    'users',    COALESCE(v_users, '[]'::JSONB)
  );

  RETURN v_result;
END;
$$;

-- admin_list_subscriptions: add bounds
CREATE OR REPLACE FUNCTION admin_list_subscriptions(
  p_filter   TEXT DEFAULT NULL,
  p_page     INT  DEFAULT 1,
  p_per_page INT  DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_offset       INT;
  v_subs         JSONB;
  v_total        BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Clamp bounds
  IF p_per_page > 100 THEN p_per_page := 100; END IF;
  IF p_per_page < 1 THEN p_per_page := 25; END IF;
  IF p_page < 1 THEN p_page := 1; END IF;

  v_offset := ((p_page - 1) * p_per_page);

  SELECT
    jsonb_agg(row_to_json(q)),
    MAX(q.total_count)
  INTO v_subs, v_total
  FROM (
    SELECT
      s.id, s.director_id, s.plan, s.status,
      s.stripe_customer_id, s.stripe_subscription_id,
      s.current_period_end, s.trial_ends_at,
      s.events_purchased, s.events_used, s.billing_interval,
      s.created_at, s.updated_at,
      au.email, lu.name, lu.organization,
      count(*) OVER() AS total_count
    FROM leod_subscriptions s
    JOIN auth.users au ON au.id = s.director_id
    LEFT JOIN leod_users lu ON lu.id = s.director_id
    WHERE (p_filter IS NULL OR s.status = p_filter)
    ORDER BY s.created_at DESC
    LIMIT p_per_page OFFSET v_offset
  ) q;

  RETURN jsonb_build_object(
    'total',         COALESCE(v_total, 0),
    'page',          p_page,
    'per_page',      p_per_page,
    'subscriptions', COALESCE(v_subs, '[]'::JSONB)
  );
END;
$$;
