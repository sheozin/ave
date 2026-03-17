-- ============================================================
-- CueDeck — Migration 029: Fix admin RPC field mismatches
-- ============================================================

-- Fix admin_list_users: add name, active; fix subscription join (director_id not user_id)
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
      lu.name,
      lu.role,
      lu.active,
      lu.organization,
      au.created_at,
      au.last_sign_in_at,
      COALESCE(s.plan, 'none')   AS plan,
      COALESCE(s.status, 'none') AS status,
      count(*) OVER()            AS total_count
    FROM leod_users lu
    JOIN auth.users au ON au.id = lu.id
    LEFT JOIN leod_subscriptions s ON s.director_id = lu.id
    WHERE (p_search IS NULL OR au.email ILIKE '%' || p_search || '%'
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

-- Fix admin_list_subscriptions: use director_id not user_id
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
      s.director_id,
      s.plan,
      s.status,
      s.stripe_customer_id,
      s.stripe_subscription_id,
      s.current_period_end,
      s.trial_ends_at,
      s.events_purchased,
      s.events_used,
      s.billing_interval,
      s.created_at,
      s.updated_at,
      au.email,
      lu.name,
      lu.organization,
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
