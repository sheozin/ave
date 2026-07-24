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
