-- ============================================================
-- CueDeck — Migration 061: security hardening
-- ============================================================

-- 1. leod_users privileged columns. Before this a non-admin could set
-- its own role to 'admin'.
CREATE OR REPLACE FUNCTION public.leod_users_guard_privileged()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(is_admin(), false) THEN RETURN NEW; END IF;
  IF NEW.role       IS DISTINCT FROM OLD.role
     OR NEW.active     IS DISTINCT FROM OLD.active
     OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.org_id     IS DISTINCT FROM OLD.org_id
     OR NEW.email      IS DISTINCT FROM OLD.email
     OR NEW.id         IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'role, active, invited_by, org_id and email can only be changed by an administrator'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_leod_users_guard_privileged ON leod_users;
CREATE TRIGGER trg_leod_users_guard_privileged
  BEFORE UPDATE ON leod_users
  FOR EACH ROW EXECUTE FUNCTION public.leod_users_guard_privileged();

-- 2. leod_events.created_via is immutable for clients.
CREATE OR REPLACE FUNCTION public.leod_events_guard_created_via()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF NEW.created_via IS NOT DISTINCT FROM OLD.created_via THEN RETURN NEW; END IF;
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(is_admin(), false) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'created_via cannot be changed' USING ERRCODE = 'insufficient_privilege';
END;
$function$;

DROP TRIGGER IF EXISTS trg_leod_events_guard_created_via ON leod_events;
CREATE TRIGGER trg_leod_events_guard_created_via
  BEFORE UPDATE OF created_via ON leod_events
  FOR EACH ROW EXECUTE FUNCTION public.leod_events_guard_created_via();

-- 3. Clients cannot insert test scan events.
CREATE OR REPLACE FUNCTION public.checkin_guard_scan_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF NEW.is_test THEN
    RAISE EXCEPTION 'is_test may only be set by CueDeck' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_guard_scan_insert ON leod_checkin_scan_events;
CREATE TRIGGER trg_checkin_guard_scan_insert
  BEFORE INSERT ON leod_checkin_scan_events
  FOR EACH ROW EXECUTE FUNCTION public.checkin_guard_scan_insert();

-- 4. Purchases table grants: read only, and only organizers via RLS.
REVOKE ALL ON leod_checkin_purchases FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON leod_checkin_purchases FROM authenticated;

-- 5. Refund: unique payment intent, row lock, only fall back to test
-- when no other un-refunded purchase covers the event.
CREATE UNIQUE INDEX IF NOT EXISTS leod_checkin_purchases_pi_uniq
  ON leod_checkin_purchases(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
DROP INDEX IF EXISTS leod_checkin_purchases_pi_idx;

CREATE OR REPLACE FUNCTION public.checkin_mark_refunded(p_payment_intent TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_event UUID;
  v_refunded TIMESTAMPTZ;
BEGIN
  SELECT id, event_id, refunded_at INTO v_id, v_event, v_refunded
    FROM leod_checkin_purchases WHERE stripe_payment_intent_id = p_payment_intent
    FOR UPDATE;
  IF v_id IS NULL THEN RETURN 'not_found'; END IF;
  IF v_refunded IS NOT NULL THEN RETURN 'already_refunded'; END IF;

  UPDATE leod_checkin_purchases SET refunded_at = now() WHERE id = v_id;

  IF EXISTS (SELECT 1 FROM leod_checkin_purchases
              WHERE event_id = v_event AND id <> v_id AND refunded_at IS NULL) THEN
    RETURN 'refunded_still_live';
  END IF;

  UPDATE leod_checkin_entitlements SET status = 'test' WHERE event_id = v_event;
  RETURN 'test';
END;
$function$;
REVOKE ALL ON FUNCTION public.checkin_mark_refunded(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_mark_refunded(TEXT) TO service_role;

-- 6. Trigger functions are not callable by clients.
REVOKE ALL ON FUNCTION public.checkin_guard_attendee_insert()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkin_lock_live_event_date()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leod_events_count_perevent_usage()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leod_users_guard_privileged()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leod_events_guard_created_via()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkin_guard_scan_insert()          FROM PUBLIC, anon, authenticated;
