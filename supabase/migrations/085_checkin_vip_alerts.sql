-- 085_checkin_vip_alerts.sql
-- VIP arrival alerts (event-day spec, feature 5). Organizers pick ticket
-- types; an 'ok' scan of a guest with one of them writes an alert row in
-- the same transaction as the check-in. Owner, organizers and desk leads
-- read alerts; desk staff and viewers never do.
--
-- Realtime carries this table's rows to the dashboard and lead desks as a
-- wake-up only. A row holds ids and the ticket type, never a name; the
-- page then calls checkin_recent_alerts, which joins names under the
-- role check. RLS below is what stops Realtime delivering to crew.
-- Ticket types match case- and space-insensitively: CSV imports vary.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS alert_ticket_types text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS leod_checkin_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  attendee_id uuid NOT NULL REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  ticket_type text NOT NULL,
  desk_id     uuid,
  is_test     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leod_checkin_alerts_event_idx ON leod_checkin_alerts (event_id, created_at DESC);

ALTER TABLE leod_checkin_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON leod_checkin_alerts TO authenticated;
DROP POLICY IF EXISTS checkin_alerts_read ON leod_checkin_alerts;
CREATE POLICY checkin_alerts_read ON leod_checkin_alerts FOR SELECT TO authenticated
  USING (checkin_is_owner(event_id) OR COALESCE(checkin_role_for_event(event_id) IN ('organizer', 'lead'), false));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'leod_checkin_alerts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE leod_checkin_alerts;
  END IF;
END $$;

-- ── Setter: organizer or owner ──────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_set_alert_ticket_types(p_event_id uuid, p_types text[])
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out text[];
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id) OR checkin_role_for_event(p_event_id) = 'organizer') THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can choose alert ticket types'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Trim, drop blanks, keep the first spelling of each type (case-insensitive), in order given.
  SELECT COALESCE(array_agg(t ORDER BY first_i), '{}') INTO v_out
    FROM (SELECT min(i) AS first_i, (array_agg(t ORDER BY i))[1] AS t
            FROM (SELECT btrim(x) AS t, i FROM unnest(COALESCE(p_types, '{}')) WITH ORDINALITY AS u(x, i)) s
           WHERE t <> ''
           GROUP BY lower(t)) d;
  IF cardinality(v_out) > 20 OR EXISTS (SELECT 1 FROM unnest(v_out) t WHERE length(t) > 80) THEN
    RAISE EXCEPTION 'At most 20 ticket types, 80 characters each' USING ERRCODE = '22023';
  END IF;
  UPDATE leod_checkin_entitlements SET alert_ticket_types = v_out WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_alert_ticket_types(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_alert_ticket_types(uuid, text[]) TO authenticated;

-- ── Reader: owner, organizer, lead ──────────────────────────────
-- Newest 50. Once live, test alerts are excluded (go-live deletes them;
-- this is the defensive copy). still_in is false when the check-in that
-- raised the alert was undone, so the list never claims a guest is here
-- who is not.
CREATE OR REPLACE FUNCTION checkin_recent_alerts(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live boolean;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id) OR COALESCE(checkin_role_for_event(p_event_id) IN ('organizer', 'lead'), false)) THEN
    RAISE EXCEPTION 'Only the owner, organizers and desk leads see arrival alerts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status = 'live' INTO v_live FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', x.id, 'created_at', x.created_at,
             'name', btrim(concat_ws(' ', a.first_name, a.last_name)),
             'company', NULLIF(btrim(a.company), ''),
             'ticket_type', x.ticket_type,
             'desk_label', d.label,
             'still_in', a.checked_in_at IS NOT NULL) ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM leod_checkin_alerts
             WHERE event_id = p_event_id AND NOT (COALESCE(v_live, false) AND is_test)
             ORDER BY created_at DESC LIMIT 50) x
      JOIN leod_checkin_attendees a ON a.id = x.attendee_id
      LEFT JOIN leod_checkin_desks d ON d.event_id = x.event_id AND d.desk_id = x.desk_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_recent_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_recent_alerts(uuid) TO authenticated;

-- ── Go-live clears test alerts ─────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_clear_test_alerts_on_live()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF OLD.status = 'test' AND NEW.status = 'live' THEN
    DELETE FROM leod_checkin_alerts WHERE event_id = NEW.event_id AND is_test;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION checkin_clear_test_alerts_on_live() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_checkin_clear_test_alerts_on_live ON leod_checkin_entitlements;
CREATE TRIGGER trg_checkin_clear_test_alerts_on_live
  AFTER UPDATE OF status ON leod_checkin_entitlements
  FOR EACH ROW EXECUTE FUNCTION checkin_clear_test_alerts_on_live();

-- ── checkin_apply_scan: the alert insert ───────────────────────

-- ── checkin_apply_scan: the alert insert ───────────────────────
-- Body is the live definition (071; md5 of pg_get_functiondef
-- 8b0bb2a6021ef6e7252d0ed2e618006e, read 2026-10-05) with two additions
-- marked CHANGED (085). Same signature, so CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION checkin_apply_scan(
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
  v_alert_types text[];     -- CHANGED (085): VIP alerts
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
      -- CHANGED (085): VIP alerts. Same transaction as the check-in.
      SELECT alert_ticket_types INTO v_alert_types FROM leod_checkin_entitlements WHERE event_id = p_event_id;
      IF cardinality(v_alert_types) > 0 THEN
        INSERT INTO leod_checkin_alerts (event_id, attendee_id, ticket_type, desk_id, is_test)
        SELECT p_event_id, a.id, btrim(a.ticket_type), p_desk_id, v_test
          FROM leod_checkin_attendees a
         WHERE a.id = p_attendee_id
           AND lower(btrim(a.ticket_type)) IN (SELECT lower(t) FROM unnest(v_alert_types) t);
      END IF;
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
