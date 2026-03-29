-- ══════════════════════════════════════════════════════════════════
-- CueDeck — Migration 035: Admin Email Tracking
-- Adds admin functions to view email logs and activity
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Extend email_log with more useful fields ─────────────────────
ALTER TABLE email_log
ADD COLUMN IF NOT EXISTS subject TEXT,
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed')),
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES leod_invoices(id) ON DELETE SET NULL;

-- Index for admin queries
CREATE INDEX IF NOT EXISTS idx_email_log_type ON email_log(email_type);
CREATE INDEX IF NOT EXISTS idx_email_log_status ON email_log(status);

-- ── 2. Admin RPC: List all emails ───────────────────────────────────
CREATE OR REPLACE FUNCTION admin_list_emails(
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_type TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  email_type TEXT,
  email_address TEXT,
  subject TEXT,
  status TEXT,
  resend_id TEXT,
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  invoice_number TEXT,
  metadata JSONB
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    el.id,
    el.user_id,
    COALESCE(u.name, '') AS user_name,
    COALESCE(u.email, el.email_address) AS user_email,
    el.email_type,
    el.email_address,
    el.subject,
    el.status,
    el.resend_id,
    el.sent_at,
    el.opened_at,
    el.clicked_at,
    inv.invoice_number,
    el.metadata
  FROM email_log el
  LEFT JOIN leod_users u ON el.user_id = u.id
  LEFT JOIN leod_invoices inv ON el.invoice_id = inv.id
  WHERE (p_type IS NULL OR el.email_type = p_type)
    AND (p_search IS NULL OR
         el.email_address ILIKE '%' || p_search || '%' OR
         u.name ILIKE '%' || p_search || '%')
  ORDER BY el.sent_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ── 3. Admin RPC: Email statistics ──────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_email_stats()
RETURNS TABLE (
  total_sent BIGINT,
  sent_today BIGINT,
  sent_this_week BIGINT,
  by_type JSONB,
  by_status JSONB
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_sent,
    COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE)::BIGINT AS sent_today,
    COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE - INTERVAL '7 days')::BIGINT AS sent_this_week,
    (
      SELECT jsonb_object_agg(email_type, cnt)
      FROM (SELECT email_type, COUNT(*) as cnt FROM email_log GROUP BY email_type) t
    ) AS by_type,
    (
      SELECT jsonb_object_agg(status, cnt)
      FROM (SELECT COALESCE(status, 'sent') as status, COUNT(*) as cnt FROM email_log GROUP BY status) t
    ) AS by_status
  FROM email_log;
END;
$$;

-- ── 4. Admin RPC: Recent signups with email status ──────────────────
CREATE OR REPLACE FUNCTION admin_get_signups_with_emails(
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  user_id UUID,
  name TEXT,
  email TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  first_login_at TIMESTAMPTZ,
  welcome_email_sent BOOLEAN,
  emails_received INT,
  last_email_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    u.id AS user_id,
    u.name,
    u.email,
    u.role,
    u.created_at,
    u.first_login_at,
    COALESCE(u.welcome_email_sent, false) AS welcome_email_sent,
    COALESCE(e.email_count, 0)::INT AS emails_received,
    e.last_email_at
  FROM leod_users u
  LEFT JOIN (
    SELECT
      user_id,
      COUNT(*) as email_count,
      MAX(sent_at) as last_email_at
    FROM email_log
    GROUP BY user_id
  ) e ON e.user_id = u.id
  ORDER BY u.created_at DESC
  LIMIT p_limit;
END;
$$;

-- ── 5. Activity Log table (unified tracking) ────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  action        TEXT        NOT NULL,
  category      TEXT        NOT NULL CHECK (category IN ('auth', 'email', 'billing', 'event', 'system')),
  description   TEXT,
  metadata      JSONB       DEFAULT '{}',
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_activity_log_category ON activity_log(category);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);

-- RLS for activity_log
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY activity_log_service ON activity_log FOR ALL
  USING (auth.role() = 'service_role');

-- ── 6. Admin RPC: Activity feed ─────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_activity_feed(
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_category TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  action TEXT,
  category TEXT,
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.user_id,
    COALESCE(u.name, '') AS user_name,
    COALESCE(u.email, '') AS user_email,
    a.action,
    a.category,
    a.description,
    a.metadata,
    a.created_at
  FROM activity_log a
  LEFT JOIN leod_users u ON a.user_id = u.id
  WHERE (p_category IS NULL OR a.category = p_category)
  ORDER BY a.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ── 7. Helper function to log activity ──────────────────────────────
CREATE OR REPLACE FUNCTION log_activity(
  p_user_id UUID,
  p_action TEXT,
  p_category TEXT,
  p_description TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO activity_log (user_id, action, category, description, metadata)
  VALUES (p_user_id, p_action, p_category, p_description, p_metadata)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
