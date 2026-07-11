-- ============================================================
-- Migration 039: Validate operator_role on event log inserts
-- ============================================================
-- Previously: client could set any operator_role value in
-- leod_event_log without server-side validation.
--
-- Fix: Trigger validates that operator_role matches the actual
-- role in leod_users for the authenticated user.
-- ============================================================

CREATE OR REPLACE FUNCTION validate_event_log_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_actual_role TEXT;
BEGIN
  -- Skip validation for service-role inserts (Edge Functions, cron jobs)
  IF NEW.operator_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Look up the user's actual role
  SELECT role INTO v_actual_role
  FROM leod_users
  WHERE id = NEW.operator_id;

  -- If user exists and role doesn't match, override with actual role
  IF v_actual_role IS NOT NULL AND NEW.operator_role IS DISTINCT FROM v_actual_role THEN
    NEW.operator_role := v_actual_role;
  END IF;

  RETURN NEW;
END;
$$;

-- Apply trigger on INSERT only (event log is append-only)
DROP TRIGGER IF EXISTS trg_validate_log_role ON leod_event_log;
CREATE TRIGGER trg_validate_log_role
  BEFORE INSERT ON leod_event_log
  FOR EACH ROW
  EXECUTE FUNCTION validate_event_log_role();
