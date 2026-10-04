-- 069: final hardening for the check-in branch.
--  1. leod_config: authenticated users could write every key (auth_all_config,
--     FOR ALL USING (true)), including signup_code and the Stripe price IDs.
--     No page or function writes it; admin changes go through SQL.
--  2. Client writes revoked on entitlements (service role only) and on scan
--     events (append-only; authenticated keeps INSERT under its RLS policy).
--  3. get_subscription_for_user() gets a fixed search_path.
--  4. The live-event lock now covers timezone as well as date: moving the
--     timezone moves the paid check-in window just like moving the date.
--  5. checkin_account_is_comp(): lets the front page show comp copy before a
--     comp account owns any event.

-- 1 ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS auth_all_config ON leod_config;
DROP POLICY IF EXISTS auth_read_config ON leod_config;
CREATE POLICY auth_read_config ON leod_config FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON leod_config FROM anon, authenticated;

-- 2 ─────────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON leod_checkin_entitlements FROM anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON leod_checkin_scan_events FROM anon, authenticated;
REVOKE INSERT ON leod_checkin_scan_events FROM anon;

-- 3 ─────────────────────────────────────────────────────────────────────
ALTER FUNCTION public.get_subscription_for_user() SET search_path = public;

-- 4 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.checkin_lock_live_event_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF NEW.date IS NOT DISTINCT FROM OLD.date
     AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN
    RETURN NEW;
  END IF;
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(is_admin(), false) THEN RETURN NEW; END IF;
  IF OLD.created_by IS NOT NULL
     AND EXISTS (SELECT 1 FROM leod_checkin_comp_accounts WHERE user_id = OLD.created_by) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_entitlements WHERE event_id = OLD.id AND status = 'live') THEN
    RAISE EXCEPTION 'This event is live for check-in, so its date is locked. Contact support@cuedeck.io to move it.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_lock_live_event_date ON leod_events;
CREATE TRIGGER trg_checkin_lock_live_event_date
  BEFORE UPDATE OF date, timezone ON leod_events
  FOR EACH ROW EXECUTE FUNCTION checkin_lock_live_event_date();

-- 5 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.checkin_account_is_comp()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM leod_checkin_comp_accounts WHERE user_id = auth.uid());
$function$;
REVOKE ALL ON FUNCTION public.checkin_account_is_comp() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkin_account_is_comp() TO authenticated;
