-- ============================================================
-- CueDeck — Migration 051: Check-in module — entitlement gating
-- & api_consumer scope restriction
-- ============================================================
-- Closes two of the three open questions from the final
-- whole-increment review of check-in Phase 1a (migrations 044-050):
--
-- 1. checkin_role_for_event() previously returned a role as soon as
--    a leod_checkin_operators row existed, regardless of whether the
--    event had ever actually enabled check-in. Since migration 045's
--    auto-grant trigger creates an 'organizer' row for EVERY new
--    event unconditionally, this meant an event owner already had
--    full read/write over their (empty) check-in tables the moment
--    the event was created — with or without ever calling
--    checkin-enable-event. "No entitlements row = module inert" was
--    only a UI/Edge-Function convention, never a technical gate.
--
--    Now requires a live leod_checkin_entitlements row with
--    checkin_core = true. This is the single choke point every RLS
--    policy on every leod_checkin_* table already goes through, so
--    changing it here closes the gap everywhere at once. Both
--    Edge Functions (checkin-enable-event, checkin-import-attendees)
--    use the service-role client and bypass RLS entirely — they are
--    unaffected by this change and get their own explicit checks
--    where needed (see the Edge Function diffs in this same commit).
--
-- 2. Every read policy on leod_checkin_operators, entitlements,
--    attendees, scan_points, devices, and print_jobs granted
--    api_consumer the same blanket access as organizer/crew — full
--    attendee PII, leod_checkin_devices.api_key_hash (a device
--    authentication secret), the operator roster, etc. The original
--    spec states the integration API returns "id, external_ref,
--    ticket_type only" and gates PII behind a per-event
--    pii_in_api flag. api_consumer's only legitimate target per its
--    own definition in migration 045 ("read-only scan events") is
--    leod_checkin_scan_events — restricted everywhere else to
--    organizer/crew only.
-- ============================================================

CREATE OR REPLACE FUNCTION checkin_role_for_event(p_event_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.role
  FROM leod_checkin_operators o
  WHERE o.event_id = p_event_id AND o.user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM leod_checkin_entitlements e
      WHERE e.event_id = p_event_id AND e.checkin_core = true
    )
$$;

-- ── Restrict api_consumer out of every read policy except scan_events ──

DROP POLICY IF EXISTS checkin_op_read ON leod_checkin_operators;
CREATE POLICY checkin_op_read ON leod_checkin_operators
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

DROP POLICY IF EXISTS checkin_ent_read ON leod_checkin_entitlements;
CREATE POLICY checkin_ent_read ON leod_checkin_entitlements
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

DROP POLICY IF EXISTS checkin_att_read ON leod_checkin_attendees;
CREATE POLICY checkin_att_read ON leod_checkin_attendees
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

DROP POLICY IF EXISTS checkin_sp_read ON leod_checkin_scan_points;
CREATE POLICY checkin_sp_read ON leod_checkin_scan_points
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

DROP POLICY IF EXISTS checkin_dev_read ON leod_checkin_devices;
CREATE POLICY checkin_dev_read ON leod_checkin_devices
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

DROP POLICY IF EXISTS checkin_pj_read ON leod_checkin_print_jobs;
CREATE POLICY checkin_pj_read ON leod_checkin_print_jobs
  FOR SELECT TO authenticated
  USING (
    attendee_id IN (
      SELECT id FROM leod_checkin_attendees
      WHERE checkin_role_for_event(event_id) IN ('organizer', 'crew')
    )
  );

-- checkin_se_read (leod_checkin_scan_events) is UNCHANGED — this is
-- api_consumer's one legitimate target, per migration 045's own
-- documented role definitions.

-- ── Fix a NULL-safety gap this migration's own change exposes ──────
-- checkin_lock_attendee_identity() (047) compares
-- checkin_role_for_event() to 'organizer' with `!=`. Now that the
-- function can return NULL far more often (whenever entitlements are
-- missing, not just when no operator row exists), `NULL != 'organizer'`
-- evaluates to NULL, and plpgsql's IF treats a NULL condition as
-- false — i.e. it would NOT revert event_id/qr_token for a NULL role.
-- Not exploitable today (RLS's own USING clause on checkin_att_update
-- already blocks any authenticated caller from reaching a NULL-role
-- state on OLD.event_id before this trigger ever runs), but a future
-- "disable check-in" admin flow that sets checkin_core = false on an
-- event with existing attendee rows would land exactly here. Switch
-- to IS DISTINCT FROM, which treats NULL as "not organizer" (the safe
-- outcome) instead of propagating it — identical behavior to != for
-- every non-NULL case, so no functional change for any reachable path
-- today.
CREATE OR REPLACE FUNCTION checkin_lock_attendee_identity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF checkin_role_for_event(OLD.event_id) IS DISTINCT FROM 'organizer'
     OR (NEW.event_id IS DISTINCT FROM OLD.event_id
         AND checkin_role_for_event(NEW.event_id) IS DISTINCT FROM 'organizer') THEN
    NEW.event_id := OLD.event_id;
    NEW.qr_token := OLD.qr_token;
  END IF;
  RETURN NEW;
END;
$$;
