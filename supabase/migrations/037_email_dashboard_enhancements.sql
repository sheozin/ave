-- ══════════════════════════════════════════════════════════════════
-- CueDeck — Migration 037: Email Dashboard Enhancements
-- Adds status filter to email listing and enhanced stats
-- ══════════════════════════════════════════════════════════════════

-- Drop existing functions to allow return type changes
DROP FUNCTION IF EXISTS admin_get_email_stats();
DROP FUNCTION IF EXISTS admin_list_emails(INT, INT, TEXT, TEXT);

-- ── 1. Update admin_list_emails with status filter ─────────────────
CREATE OR REPLACE FUNCTION admin_list_emails(
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_type TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
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
    COALESCE(el.status, 'sent') AS status,
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
    AND (p_status IS NULL OR COALESCE(el.status, 'sent') = p_status)
    AND (p_search IS NULL OR
         el.email_address ILIKE '%' || p_search || '%' OR
         u.name ILIKE '%' || p_search || '%')
  ORDER BY el.sent_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ── 2. Update admin_get_email_stats with delivery breakdown ────────
CREATE OR REPLACE FUNCTION admin_get_email_stats()
RETURNS TABLE (
  total_sent BIGINT,
  sent_today BIGINT,
  sent_this_week BIGINT,
  delivered BIGINT,
  opened BIGINT,
  clicked BIGINT,
  bounced BIGINT,
  failed BIGINT,
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
    COUNT(*) FILTER (WHERE el.sent_at >= CURRENT_DATE)::BIGINT AS sent_today,
    COUNT(*) FILTER (WHERE el.sent_at >= CURRENT_DATE - INTERVAL '7 days')::BIGINT AS sent_this_week,
    COUNT(*) FILTER (WHERE COALESCE(el.status, 'sent') IN ('delivered', 'opened', 'clicked'))::BIGINT AS delivered,
    COUNT(*) FILTER (WHERE COALESCE(el.status, 'sent') IN ('opened', 'clicked'))::BIGINT AS opened,
    COUNT(*) FILTER (WHERE COALESCE(el.status, 'sent') = 'clicked')::BIGINT AS clicked,
    COUNT(*) FILTER (WHERE COALESCE(el.status, 'sent') = 'bounced')::BIGINT AS bounced,
    COUNT(*) FILTER (WHERE COALESCE(el.status, 'sent') = 'failed')::BIGINT AS failed,
    (
      SELECT jsonb_object_agg(email_type, cnt)
      FROM (SELECT email_type, COUNT(*) as cnt FROM email_log GROUP BY email_type) t
    ) AS by_type,
    (
      SELECT jsonb_object_agg(st, cnt)
      FROM (SELECT COALESCE(status, 'sent') as st, COUNT(*) as cnt FROM email_log GROUP BY status) t
    ) AS by_status
  FROM email_log el;
END;
$$;
