-- ============================================================
-- CueDeck — Migration 027: Admin Dashboard
-- Run this in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- Section 1 — Role constraint
-- ============================================================

ALTER TABLE leod_users DROP CONSTRAINT IF EXISTS leod_users_role_check;
ALTER TABLE leod_users ADD CONSTRAINT leod_users_role_check
  CHECK (role IN ('admin','director','stage','av','interp','reg','signage','pending'));

-- ============================================================
-- Section 2 — Audit table
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_admin_audit (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id    UUID REFERENCES auth.users(id),
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON leod_admin_audit(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON leod_admin_audit(created_at DESC);

ALTER TABLE leod_admin_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_audit_read ON leod_admin_audit FOR SELECT
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_audit_insert ON leod_admin_audit FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

-- ============================================================
-- Section 3 — Admin RLS on existing tables
-- ============================================================

CREATE POLICY admin_read_all_users ON leod_users FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users u WHERE u.id = auth.uid() AND u.role = 'admin'));
CREATE POLICY admin_update_all_users ON leod_users FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users u WHERE u.id = auth.uid() AND u.role = 'admin'));

CREATE POLICY admin_read_all_subs ON leod_subscriptions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_update_all_subs ON leod_subscriptions FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY admin_read_all_promos ON leod_promo_codes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_insert_promos ON leod_promo_codes FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_update_promos ON leod_promo_codes FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY admin_read_all_events ON leod_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY admin_read_all_sessions ON leod_sessions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY admin_read_all_logs ON leod_event_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

-- ============================================================
-- Section 4 — Analytics RPC functions
-- ============================================================

-- 4a. admin_get_stats()
CREATE OR REPLACE FUNCTION admin_get_stats()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_users       BIGINT;
  v_new_users_30d     BIGINT;
  v_prev_users_30d    BIGINT;
  v_active_subs       BIGINT;
  v_tier_perevent     BIGINT;
  v_tier_starter      BIGINT;
  v_tier_pro          BIGINT;
  v_tier_enterprise   BIGINT;
  v_dau               BIGINT;
  v_mrr               NUMERIC;
  v_churn_rate        NUMERIC;
  v_conversion_rate   NUMERIC;
  v_total_subs_30d    BIGINT;
  v_churned_30d       BIGINT;
  v_directors         BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT COUNT(*) INTO v_total_users FROM auth.users;

  SELECT COUNT(*) INTO v_new_users_30d
    FROM auth.users
   WHERE created_at >= now() - INTERVAL '30 days';

  SELECT COUNT(*) INTO v_prev_users_30d
    FROM auth.users
   WHERE created_at >= now() - INTERVAL '60 days'
     AND created_at <  now() - INTERVAL '30 days';

  SELECT COUNT(*) INTO v_active_subs
    FROM leod_subscriptions
   WHERE status = 'active';

  SELECT COUNT(*) INTO v_tier_perevent
    FROM leod_subscriptions
   WHERE status = 'active' AND plan = 'perevent';

  SELECT COUNT(*) INTO v_tier_starter
    FROM leod_subscriptions
   WHERE status = 'active' AND plan IN ('starter_month','starter_year');

  SELECT COUNT(*) INTO v_tier_pro
    FROM leod_subscriptions
   WHERE status = 'active' AND plan IN ('pro_month','pro_year');

  SELECT COUNT(*) INTO v_tier_enterprise
    FROM leod_subscriptions
   WHERE status = 'active' AND plan = 'enterprise';

  SELECT COUNT(DISTINCT u.id) INTO v_dau
    FROM leod_users u
    JOIN leod_events e ON e.created_by = u.id
   WHERE e.created_at >= now() - INTERVAL '1 day';

  SELECT COALESCE(SUM(
    CASE plan
      WHEN 'starter_month' THEN 59
      WHEN 'starter_year'  THEN 49
      WHEN 'pro_month'     THEN 99
      WHEN 'pro_year'      THEN 82
      WHEN 'enterprise'    THEN 299
      ELSE 0
    END
  ), 0) INTO v_mrr
    FROM leod_subscriptions
   WHERE status = 'active';

  SELECT COUNT(*) INTO v_total_subs_30d
    FROM leod_subscriptions
   WHERE created_at >= now() - INTERVAL '30 days';

  SELECT COUNT(*) INTO v_churned_30d
    FROM leod_subscriptions
   WHERE status = 'canceled'
     AND updated_at >= now() - INTERVAL '30 days';

  IF v_total_subs_30d > 0 THEN
    v_churn_rate := ROUND((v_churned_30d::NUMERIC / v_total_subs_30d::NUMERIC) * 100, 2);
  ELSE
    v_churn_rate := 0;
  END IF;

  SELECT COUNT(*) INTO v_directors
    FROM leod_users
   WHERE role = 'director';

  IF v_directors > 0 THEN
    v_conversion_rate := ROUND((v_active_subs::NUMERIC / v_directors::NUMERIC) * 100, 2);
  ELSE
    v_conversion_rate := 0;
  END IF;

  RETURN jsonb_build_object(
    'total_users',       v_total_users,
    'new_users_30d',     v_new_users_30d,
    'prev_users_30d',    v_prev_users_30d,
    'active_subs',       v_active_subs,
    'tier_perevent',     v_tier_perevent,
    'tier_starter',      v_tier_starter,
    'tier_pro',          v_tier_pro,
    'tier_enterprise',   v_tier_enterprise,
    'dau',               v_dau,
    'mrr',               v_mrr,
    'churn_rate',        v_churn_rate,
    'conversion_rate',   v_conversion_rate
  );
END;
$$;

-- 4b. admin_get_signups_per_day(p_days INT DEFAULT 30)
CREATE OR REPLACE FUNCTION admin_get_signups_per_day(p_days INT DEFAULT 30)
RETURNS TABLE(day DATE, signup_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
    SELECT
      gs.day::DATE,
      COUNT(u.id)::BIGINT AS signup_count
    FROM generate_series(
      (now() - ((p_days - 1) || ' days')::INTERVAL)::DATE,
      now()::DATE,
      '1 day'::INTERVAL
    ) AS gs(day)
    LEFT JOIN auth.users u
      ON u.created_at::DATE = gs.day::DATE
    GROUP BY gs.day
    ORDER BY gs.day;
END;
$$;

-- 4c. admin_get_dau_per_day(p_days INT DEFAULT 14)
CREATE OR REPLACE FUNCTION admin_get_dau_per_day(p_days INT DEFAULT 14)
RETURNS TABLE(day DATE, active_users BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
    SELECT
      gs.day::DATE,
      COUNT(DISTINCT e.created_by)::BIGINT AS active_users
    FROM generate_series(
      (now() - ((p_days - 1) || ' days')::INTERVAL)::DATE,
      now()::DATE,
      '1 day'::INTERVAL
    ) AS gs(day)
    LEFT JOIN leod_events e
      ON e.created_at::DATE = gs.day::DATE
    GROUP BY gs.day
    ORDER BY gs.day;
END;
$$;

-- 4d. admin_get_tier_breakdown()
CREATE OR REPLACE FUNCTION admin_get_tier_breakdown()
RETURNS TABLE(plan TEXT, count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
    SELECT
      s.plan::TEXT,
      COUNT(*)::BIGINT
    FROM leod_subscriptions s
   WHERE s.status = 'active'
   GROUP BY s.plan
   ORDER BY COUNT(*) DESC;
END;
$$;

-- 4e. admin_get_recent_signups(p_limit INT DEFAULT 10)
CREATE OR REPLACE FUNCTION admin_get_recent_signups(p_limit INT DEFAULT 10)
RETURNS TABLE(email TEXT, created_at TIMESTAMPTZ, plan TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
    SELECT
      u.email::TEXT,
      u.created_at,
      COALESCE(s.plan, 'none')::TEXT AS plan
    FROM auth.users u
    LEFT JOIN leod_subscriptions s
      ON s.user_id = u.id AND s.status = 'active'
    ORDER BY u.created_at DESC
    LIMIT p_limit;
END;
$$;

-- 4f. admin_get_recent_events(p_limit INT DEFAULT 10)
CREATE OR REPLACE FUNCTION admin_get_recent_events(p_limit INT DEFAULT 10)
RETURNS TABLE(event_name TEXT, operator_email TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
    SELECT
      e.name::TEXT AS event_name,
      au.email::TEXT AS operator_email,
      e.created_at
    FROM leod_events e
    LEFT JOIN auth.users au ON au.id = e.created_by
    ORDER BY e.created_at DESC
    LIMIT p_limit;
END;
$$;

-- 4g. admin_list_users(p_search, p_role_filter, p_status_filter, p_page, p_per_page)
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
  v_offset     INT;
  v_result     JSONB;
  v_users      JSONB;
  v_total      BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  v_offset := ((p_page - 1) * p_per_page);

  SELECT
    jsonb_agg(row_to_json(q)),
    MAX(q.total_count)
  INTO v_users, v_total
  FROM (
    SELECT
      lu.id,
      au.email,
      lu.role,
      lu.organization,
      au.created_at,
      au.last_sign_in_at,
      COALESCE(s.plan, 'none')  AS plan,
      COALESCE(s.status, 'none') AS sub_status,
      count(*) OVER()           AS total_count
    FROM leod_users lu
    JOIN auth.users au ON au.id = lu.id
    LEFT JOIN leod_subscriptions s ON s.user_id = lu.id AND s.status = 'active'
    WHERE (p_search IS NULL OR au.email ILIKE '%' || p_search || '%'
                            OR lu.organization ILIKE '%' || p_search || '%')
      AND (p_role_filter IS NULL OR lu.role = p_role_filter)
      AND (p_status_filter IS NULL
           OR (p_status_filter = 'active'   AND s.id IS NOT NULL)
           OR (p_status_filter = 'inactive' AND s.id IS NULL))
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

-- 4h. admin_list_promo_codes(p_page, p_per_page)
CREATE OR REPLACE FUNCTION admin_list_promo_codes(
  p_page     INT DEFAULT 1,
  p_per_page INT DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_offset  INT;
  v_codes   JSONB;
  v_total   BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  v_offset := ((p_page - 1) * p_per_page);

  SELECT
    jsonb_agg(row_to_json(q)),
    MAX(q.total_count)
  INTO v_codes, v_total
  FROM (
    SELECT
      pc.*,
      count(*) OVER() AS total_count
    FROM leod_promo_codes pc
    ORDER BY pc.created_at DESC
    LIMIT p_per_page OFFSET v_offset
  ) q;

  RETURN jsonb_build_object(
    'total',    COALESCE(v_total, 0),
    'page',     p_page,
    'per_page', p_per_page,
    'codes',    COALESCE(v_codes, '[]'::JSONB)
  );
END;
$$;

-- 4i. admin_list_subscriptions(p_filter, p_page, p_per_page)
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

  v_offset := ((p_page - 1) * p_per_page);

  SELECT
    jsonb_agg(row_to_json(q)),
    MAX(q.total_count)
  INTO v_subs, v_total
  FROM (
    SELECT
      s.id,
      s.user_id,
      s.plan,
      s.status,
      s.stripe_customer_id,
      s.stripe_subscription_id,
      s.current_period_end,
      s.created_at,
      s.updated_at,
      au.email,
      lu.organization,
      count(*) OVER() AS total_count
    FROM leod_subscriptions s
    JOIN auth.users au ON au.id = s.user_id
    LEFT JOIN leod_users lu ON lu.id = s.user_id
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

-- 4j. admin_get_promo_redemptions(p_code TEXT)
CREATE OR REPLACE FUNCTION admin_get_promo_redemptions(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT row_to_json(pc) INTO v_result
    FROM leod_promo_codes pc
   WHERE pc.code = p_code;

  RETURN COALESCE(v_result, 'null'::JSONB);
END;
$$;
