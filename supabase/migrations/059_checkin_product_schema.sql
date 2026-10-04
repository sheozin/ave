-- ============================================================
-- CueDeck — Migration 059: Check-in as a product — schema
-- ============================================================
-- Spec: docs/superpowers/specs/2026-10-04-checkin-product-design.md
-- Adds test/live state, test markers, purchases, check-in-only staff
-- accounts, event origin, and closes the organizer write path to
-- checked_in_at / is_test so the paywall cannot be stepped around with
-- a direct table write.
-- ============================================================

-- 1. Test / live state ----------------------------------------
ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'test',
  ADD COLUMN IF NOT EXISTS went_live_at TIMESTAMPTZ;

ALTER TABLE leod_checkin_entitlements DROP CONSTRAINT IF EXISTS leod_checkin_entitlements_status_check;
ALTER TABLE leod_checkin_entitlements
  ADD CONSTRAINT leod_checkin_entitlements_status_check CHECK (status IN ('test', 'live'));

-- Rows that existed before paid go-live keep working: they were
-- enabled by hand and are already in use.
UPDATE leod_checkin_entitlements
   SET status = 'live', went_live_at = created_at
 WHERE went_live_at IS NULL;

-- 2. Test markers ---------------------------------------------
ALTER TABLE leod_checkin_scan_events ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leod_checkin_attendees   ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_scan_events DROP CONSTRAINT IF EXISTS leod_checkin_scan_events_result_check;
ALTER TABLE leod_checkin_scan_events ADD CONSTRAINT leod_checkin_scan_events_result_check
  CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked', 'undo', 'test_cap', 'outside_window'));

-- 3. Purchases ------------------------------------------------
CREATE TABLE IF NOT EXISTS leod_checkin_purchases (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                    UUID        NOT NULL REFERENCES leod_events(id) ON DELETE RESTRICT,
  buyer_id                    UUID        NOT NULL,
  stripe_checkout_session_id  TEXT        NOT NULL UNIQUE,
  stripe_payment_intent_id    TEXT,
  stripe_customer_id          TEXT,
  amount_total                INTEGER,
  amount_tax                  INTEGER,
  currency                    TEXT,
  paid_at                     TIMESTAMPTZ,
  refunded_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leod_checkin_purchases_event_idx ON leod_checkin_purchases(event_id);
CREATE INDEX IF NOT EXISTS leod_checkin_purchases_pi_idx    ON leod_checkin_purchases(stripe_payment_intent_id);

ALTER TABLE leod_checkin_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkin_purchase_read ON leod_checkin_purchases;
CREATE POLICY checkin_purchase_read ON leod_checkin_purchases
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer');
-- No write policy: only checkin_mark_paid / checkin_mark_refunded write.

-- 4. Event origin ---------------------------------------------
ALTER TABLE leod_events ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'console';
ALTER TABLE leod_events DROP CONSTRAINT IF EXISTS leod_events_created_via_check;
ALTER TABLE leod_events ADD CONSTRAINT leod_events_created_via_check CHECK (created_via IN ('console', 'checkin'));

-- 5. Check-in-only staff accounts -----------------------------
ALTER TABLE leod_users DROP CONSTRAINT IF EXISTS leod_users_role_check;
ALTER TABLE leod_users ADD CONSTRAINT leod_users_role_check
  CHECK (role IN ('admin', 'director', 'stage', 'av', 'interp', 'reg', 'signage', 'pending', 'checkin_staff'));

-- Invited desk staff must never become directors: the console treats a
-- director as an account owner and starts a trial for them. A client
-- could set checkin_staff on its own signUp, but that only downgrades
-- itself, so trusting the metadata here is safe.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.leod_users (id, email, role, name, organization, active)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN NEW.raw_user_meta_data->>'checkin_staff' = 'true' THEN 'checkin_staff' ELSE 'director' END,
    COALESCE(NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'organization', ''),
    true
  )
  ON CONFLICT (id) DO NOTHING;  -- invited users already have their row, skip

  RETURN NEW;
END;
$function$;

-- 6. Attendee column guard: checked_in_at and is_test --------
-- Before 059 an organizer could write checked_in_at directly. With a
-- paid go-live that is a way round the paywall, so only the service
-- role (the Edge Functions) may change either column now, for every
-- role including organizer. Everything else is unchanged from 054.
CREATE OR REPLACE FUNCTION public.checkin_guard_attendee_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
  v_role   TEXT;
BEGIN
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;

  IF NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at THEN
    RAISE EXCEPTION 'checked_in_at may only be changed through the check-in desk' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'is_test may only be changed by CueDeck' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_role := checkin_role_for_event(OLD.event_id);
  IF v_role = 'organizer' THEN RETURN NEW; END IF;

  IF NEW.ticket_type IS DISTINCT FROM OLD.ticket_type THEN
    RAISE EXCEPTION 'ticket_type may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'email may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.external_ref IS DISTINCT FROM OLD.external_ref THEN
    RAISE EXCEPTION 'external_ref may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.consent_at IS DISTINCT FROM OLD.consent_at THEN
    RAISE EXCEPTION 'consent_at may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'source may only be changed by an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

-- Inserts from a client (organizer "Add person", CSV goes through the
-- service role) must not arrive already checked in or marked as test.
CREATE OR REPLACE FUNCTION public.checkin_guard_attendee_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF NEW.checked_in_at IS NOT NULL OR NEW.badge_printed_at IS NOT NULL OR NEW.is_test THEN
    RAISE EXCEPTION 'new attendees start not checked in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_guard_attendee_insert ON leod_checkin_attendees;
CREATE TRIGGER trg_checkin_guard_attendee_insert
  BEFORE INSERT ON leod_checkin_attendees
  FOR EACH ROW EXECUTE FUNCTION public.checkin_guard_attendee_insert();

-- 7. Date lock for live events -------------------------------
CREATE OR REPLACE FUNCTION public.checkin_lock_live_event_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF NEW.date IS NOT DISTINCT FROM OLD.date THEN RETURN NEW; END IF;
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(is_admin(), false) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_entitlements WHERE event_id = OLD.id AND status = 'live') THEN
    RAISE EXCEPTION 'This event is live for check-in, so its date is locked. Contact support@cuedeck.io to move it.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_lock_live_event_date ON leod_events;
CREATE TRIGGER trg_checkin_lock_live_event_date
  BEFORE UPDATE OF date ON leod_events
  FOR EACH ROW EXECUTE FUNCTION public.checkin_lock_live_event_date();
