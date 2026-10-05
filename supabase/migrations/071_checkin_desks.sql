-- 071_checkin_desks.sql
-- Desk health (event-day spec, feature 1) and undo-own (roles ruling 8).
-- Design: docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md
--         docs/superpowers/specs/2026-10-04-checkin-roles-design.md

-- ── Which laptop recorded a scan ──────────────────────────────────
-- Browser desks send a stable desk_id; kiosks keep device_id.
ALTER TABLE leod_checkin_scan_events ADD COLUMN IF NOT EXISTS desk_id uuid;
CREATE INDEX IF NOT EXISTS leod_checkin_scan_events_desk_idx
  ON leod_checkin_scan_events (event_id, desk_id, scanned_at) WHERE desk_id IS NOT NULL;

-- ── Desks ─────────────────────────────────────────────────────────
-- Written only by checkin_desk_heartbeat, read only by checkin_event_stats.
-- Labels and operators are people data (organizer and lead only), so no
-- client role may read the table directly.
CREATE TABLE IF NOT EXISTS leod_checkin_desks (
  event_id      uuid NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  desk_id       uuid NOT NULL,
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  operator_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  is_test       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (event_id, desk_id)
);
ALTER TABLE leod_checkin_desks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_desks FROM PUBLIC, anon, authenticated;

-- ── Heartbeat ─────────────────────────────────────────────────────
-- Called by the desk every 30 s while online and once on reconnect.
-- p_label NULL keeps the stored label, or names a new desk "Desk N".
-- Returns the label so the desk can show it.
CREATE OR REPLACE FUNCTION checkin_desk_heartbeat(
  p_event_id uuid, p_desk_id uuid, p_label text, p_pending_count integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text := checkin_role_for_event(p_event_id);
  v_status text;
  v_label  text := NULLIF(btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g')), '');
  v_count  integer;
  v_exists boolean;
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role NOT IN ('organizer', 'lead', 'crew') THEN
    RAISE EXCEPTION 'Only desk roles on this event can report a desk' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_desk_id IS NULL THEN
    RAISE EXCEPTION 'desk_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_pending_count IS NULL OR p_pending_count < 0 OR p_pending_count > 100000 THEN
    RAISE EXCEPTION 'pending_count must be between 0 and 100000' USING ERRCODE = '22023';
  END IF;
  IF v_label IS NOT NULL THEN v_label := left(v_label, 40); END IF;

  -- Serialise per event so two new desks cannot both become "Desk 2".
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_desk:' || p_event_id::text, 0));
  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  SELECT EXISTS (SELECT 1 FROM leod_checkin_desks WHERE event_id = p_event_id AND desk_id = p_desk_id) INTO v_exists;
  IF NOT v_exists THEN
    SELECT count(*) INTO v_count FROM leod_checkin_desks WHERE event_id = p_event_id;
    IF v_count >= 50 THEN
      RAISE EXCEPTION 'This event already has 50 desks' USING ERRCODE = '54000';
    END IF;
    IF v_label IS NULL THEN v_label := 'Desk ' || (v_count + 1); END IF;
  ELSIF v_label IS NULL THEN
    SELECT label INTO v_label FROM leod_checkin_desks WHERE event_id = p_event_id AND desk_id = p_desk_id;
  END IF;

  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count, is_test)
  VALUES (p_event_id, p_desk_id, v_label, auth.uid(), now(), p_pending_count, v_status IS DISTINCT FROM 'live')
  ON CONFLICT (event_id, desk_id) DO UPDATE
    SET label = EXCLUDED.label, operator_id = EXCLUDED.operator_id, last_seen_at = EXCLUDED.last_seen_at,
        pending_count = EXCLUDED.pending_count, is_test = EXCLUDED.is_test;
  RETURN v_label;
END;
$$;
REVOKE ALL ON FUNCTION checkin_desk_heartbeat(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_desk_heartbeat(uuid, uuid, text, integer) TO authenticated;

-- ── checkin_apply_scan: desk id and undo-own ──────────────────────
-- Body is the live definition (migrations 062/063) with two changes,
-- marked CHANGED. Dropped and recreated because a new parameter changes
-- the signature; p_desk_id has a default so the deployed
-- checkin-record-scans, which does not send it yet, keeps working.
DROP FUNCTION IF EXISTS checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean);

CREATE FUNCTION checkin_apply_scan(
  p_event_id uuid, p_client_id uuid, p_attendee_id uuid, p_scanned_at timestamptz,
  p_action text, p_prev_checked_in_at timestamptz, p_operator_id uuid,
  p_scan_point_id uuid, p_live_time_ok boolean, p_desk_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prior  TEXT;
  v_prior_event UUID;
  v_status TEXT;
  v_test   BOOLEAN;
  v_att_event UUID;
  v_att_in    TIMESTAMPTZ;
  v_found  BOOLEAN;
  v_result TEXT;
  v_audit_attendee UUID := NULL;
  v_rows   INTEGER;
  v_op_role TEXT;           -- CHANGED: undo-own
  v_may_undo_any BOOLEAN;   -- CHANGED: undo-own
  v_last_op UUID;           -- CHANGED: undo-own
BEGIN
  IF p_action NOT IN ('checkin', 'undo') THEN RAISE EXCEPTION 'unknown action %', p_action; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_scan:' || p_event_id::text, 0));

  SELECT result, event_id INTO v_prior, v_prior_event FROM leod_checkin_scan_events WHERE client_id = p_client_id;
  IF FOUND THEN
    IF v_prior_event <> p_event_id THEN
      RAISE EXCEPTION 'client_id already used for another event' USING ERRCODE = 'CK001';
    END IF;
    RETURN v_prior;
  END IF;

  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'check-in is not enabled for event %', p_event_id; END IF;
  v_test := v_status IS DISTINCT FROM 'live';

  SELECT event_id, checked_in_at, true INTO v_att_event, v_att_in, v_found
    FROM leod_checkin_attendees WHERE id = p_attendee_id FOR UPDATE;

  IF NOT COALESCE(v_found, false) THEN
    v_result := 'unknown_token';
  ELSIF v_att_event <> p_event_id THEN
    v_result := 'wrong_event';
  ELSE
    v_audit_attendee := p_attendee_id;
    IF p_action = 'undo' THEN
      -- CHANGED (ruling 8): desk staff may undo only the check-in they
      -- made themselves, i.e. the 'ok' scan that set the current
      -- checked_in_at. Leads, organizers and the owner undo anyone.
      SELECT role INTO v_op_role FROM leod_checkin_operators
       WHERE event_id = p_event_id AND user_id = p_operator_id;
      v_may_undo_any := COALESCE(v_op_role IN ('organizer', 'lead'), false)
        OR EXISTS (SELECT 1 FROM leod_events WHERE id = p_event_id AND created_by = p_operator_id);
      IF NOT v_may_undo_any AND v_att_in IS NOT NULL THEN
        SELECT operator_id INTO v_last_op FROM leod_checkin_scan_events
         WHERE event_id = p_event_id AND attendee_id = p_attendee_id
           AND result = 'ok' AND scanned_at = v_att_in
         ORDER BY received_at DESC LIMIT 1;
      END IF;
      IF NOT v_may_undo_any AND v_att_in IS NOT NULL AND v_last_op IS DISTINCT FROM p_operator_id THEN
        v_result := 'forbidden';
      ELSE
        UPDATE leod_checkin_attendees SET checked_in_at = NULL
         WHERE id = p_attendee_id AND checked_in_at = p_prev_checked_in_at;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_result := CASE WHEN v_rows > 0 THEN 'undo' ELSE 'duplicate' END;
      END IF;
    ELSIF v_att_in IS NOT NULL THEN
      v_result := 'duplicate';
    ELSIF v_test AND COALESCE(checkin_test_usage(p_event_id), 25) >= 25 THEN
      v_result := 'test_cap';
    ELSIF NOT v_test AND NOT COALESCE(p_live_time_ok, false) THEN
      v_result := 'outside_window';
    ELSE
      UPDATE leod_checkin_attendees SET checked_in_at = p_scanned_at
       WHERE id = p_attendee_id AND checked_in_at IS NULL;
      v_result := 'ok';
    END IF;
  END IF;

  INSERT INTO leod_checkin_scan_events
    (id, event_id, client_id, attendee_id, scan_point_id, device_id, operator_id, scanned_at, result, is_test, desk_id)
  VALUES
    (gen_random_uuid(), p_event_id, p_client_id, v_audit_attendee, p_scan_point_id, NULL, p_operator_id,
     p_scanned_at, v_result, v_test, p_desk_id);   -- CHANGED: desk_id

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

-- Fix round 1 (review)
-- ── Scan rows written directly by clients carry no verdict ────────
-- checkin_se_write lets desk roles INSERT into leod_checkin_scan_events,
-- so without this a crew member could insert their own 'ok' row and
-- pass the undo-own check above. Verdicts come only from
-- checkin_apply_scan (service role); a client row is always attributed
-- to the caller. Live definition read 2026-10-05; the is_test rejection
-- and the service detection are unchanged.
CREATE OR REPLACE FUNCTION checkin_guard_scan_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF NEW.is_test THEN
    RAISE EXCEPTION 'is_test may only be set by CueDeck' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.result IN ('ok', 'undo', 'forbidden', 'duplicate', 'test_cap', 'outside_window') THEN
    RAISE EXCEPTION 'scan verdicts may only be recorded by CueDeck' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.operator_id := auth.uid();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION checkin_guard_scan_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_guard_scan_insert() TO service_role;

-- ── Test desks are cleared at go-live ─────────────────────────────
-- Like every other test row, desks reported while the event was in test
-- do not survive the switch to live.
CREATE OR REPLACE FUNCTION checkin_clear_test_desks_on_live()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF OLD.status = 'test' AND NEW.status = 'live' THEN
    DELETE FROM leod_checkin_desks WHERE event_id = NEW.event_id AND is_test;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION checkin_clear_test_desks_on_live() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_clear_test_desks_on_live() TO service_role;

DROP TRIGGER IF EXISTS trg_checkin_clear_test_desks_on_live ON leod_checkin_entitlements;
CREATE TRIGGER trg_checkin_clear_test_desks_on_live
  AFTER UPDATE OF status ON leod_checkin_entitlements
  FOR EACH ROW EXECUTE FUNCTION checkin_clear_test_desks_on_live();
