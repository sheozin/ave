-- 159_checkin_exit_scans.sql
-- Exit scan points, and time at the event on certificates.
--
-- A scan point can now be an exit. A scanner there records the guest
-- leaving; it never checks anyone in, so a guest who skipped the desk is
-- not counted as arrived by walking out. Results:
--   out     the guest is checked in, and left
--   not_in  the guest is on the list but never checked in (let them out;
--           the desk may want to know)
--   unknown_token / wrong_event as at any other point
-- Exits follow the door-scanning switch (entrance_scanning): an exit is a
-- door. Scanned through checkin_apply_exit_scan, service role only, from
-- checkin-record-scans; checkin_apply_scan is unchanged.
--
-- The certificate (156) gains "time at the event": per day, the minutes
-- between an entry (check-in, door or room scan) and the next exit scan,
-- added up, so an hour out at lunch between two exits is not counted. A
-- stay with no exit scan after it is left out. Nothing is assumed about
-- when someone left.
--
-- Also fixed: the certificate listed a room only for scans whose result was
-- 'ok'. checkin_apply_scan answers 'duplicate' for anyone already checked
-- in, which is every guest who came through the desk first, so rooms were
-- almost never listed. Rooms now count 'ok' and 'duplicate'.

ALTER TABLE leod_checkin_scan_points DROP CONSTRAINT IF EXISTS leod_checkin_scan_points_kind_check;
ALTER TABLE leod_checkin_scan_points ADD CONSTRAINT leod_checkin_scan_points_kind_check
  CHECK (kind IN ('entrance', 'interior', 'exit'));

ALTER TABLE leod_checkin_scan_events DROP CONSTRAINT IF EXISTS leod_checkin_scan_events_result_check;
ALTER TABLE leod_checkin_scan_events ADD CONSTRAINT leod_checkin_scan_events_result_check
  CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked', 'undo', 'test_cap',
                    'outside_window', 'forbidden', 'out', 'not_in'));

CREATE OR REPLACE FUNCTION checkin_apply_exit_scan(p_event_id uuid, p_client_id uuid, p_attendee_id uuid,
  p_scanned_at timestamptz, p_operator_id uuid, p_scan_point_id uuid, p_device_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prior text; v_prior_event uuid; v_status text; v_test boolean;
  v_att_event uuid; v_att_in timestamptz; v_found boolean; v_result text; v_audit uuid := NULL;
BEGIN
  -- Same lock as checkin_apply_scan: one event's scans apply one at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_scan:' || p_event_id::text, 0));
  SELECT result, event_id INTO v_prior, v_prior_event FROM leod_checkin_scan_events WHERE client_id = p_client_id;
  IF FOUND THEN
    IF v_prior_event <> p_event_id THEN
      RAISE EXCEPTION 'client_id already used for another event' USING ERRCODE = 'CK001';
    END IF;
    RETURN v_prior;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_scan_points WHERE id = p_scan_point_id AND event_id = p_event_id AND kind = 'exit') THEN
    RAISE EXCEPTION 'not an exit of this event' USING ERRCODE = '22023';
  END IF;
  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'check-in is not enabled for event %', p_event_id; END IF;
  v_test := v_status IS DISTINCT FROM 'live';

  SELECT event_id, checked_in_at, true INTO v_att_event, v_att_in, v_found
    FROM leod_checkin_attendees WHERE id = p_attendee_id;
  IF NOT COALESCE(v_found, false) THEN v_result := 'unknown_token';
  ELSIF v_att_event <> p_event_id THEN v_result := 'wrong_event';
  ELSE
    v_audit := p_attendee_id;
    v_result := CASE WHEN v_att_in IS NOT NULL THEN 'out' ELSE 'not_in' END;
  END IF;

  INSERT INTO leod_checkin_scan_events
    (id, event_id, client_id, attendee_id, scan_point_id, device_id, operator_id, scanned_at, result, is_test, desk_id)
  VALUES (gen_random_uuid(), p_event_id, p_client_id, v_audit, p_scan_point_id, p_device_id, p_operator_id,
          p_scanned_at, v_result, v_test, NULL);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION checkin_apply_exit_scan(uuid, uuid, uuid, timestamptz, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_apply_exit_scan(uuid, uuid, uuid, timestamptz, uuid, uuid, uuid) TO service_role;

-- People scanned per point (Setup, dashboard): an exit counts the guests
-- it saw leave ('out', 'not_in'). Otherwise as before.
CREATE OR REPLACE FUNCTION public.checkin_scan_point_counts(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_live boolean;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id)
             OR COALESCE(checkin_role_for_event(p_event_id) IN ('organizer', 'lead', 'viewer'), false)) THEN
    RAISE EXCEPTION 'Only the owner, organizers, desk leads and viewers see scan point counts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status = 'live' INTO v_live FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'name', sp.name, 'kind', sp.kind, 'scans', COALESCE(c.scans, 0), 'people', COALESCE(c.people, 0))
             ORDER BY sp.sort_order, sp.name), '[]'::jsonb)
      FROM leod_checkin_scan_points sp
      LEFT JOIN (SELECT scan_point_id, count(*)::int AS scans, count(DISTINCT attendee_id)::int AS people
                   FROM leod_checkin_scan_events
                  WHERE event_id = p_event_id AND result IN ('ok', 'duplicate', 'out', 'not_in')   -- CHANGED (159)
                    AND attendee_id IS NOT NULL
                    AND NOT (COALESCE(v_live, false) AND is_test)
                  GROUP BY scan_point_id) c ON c.scan_point_id = sp.id
     WHERE sp.event_id = p_event_id);
END;
$function$;

-- The certificate, with rooms fixed and 'visits' added: one entry per day
-- with at least one closed stay, in the event's time zone
-- ({day, from, to, minutes}). Everything else as in 156.
CREATE OR REPLACE FUNCTION checkin_certificate(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v jsonb; v_att uuid; v_event uuid; v_in timestamptz; v_tz text;
        rec record; v_day date; v_open timestamptz; v_stays jsonb := '[]'::jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{32}$' THEN RETURN NULL; END IF;
  SELECT jsonb_build_object(
           'guest', btrim(a.first_name || ' ' || a.last_name),
           'company', NULLIF(btrim(a.company), ''),
           'event', ev.name,
           'venue', ev.venue,
           'date', ev.date,
           'timezone', ev.timezone,
           'checked_in_at', a.checked_in_at,
           'host', NULLIF(btrim(e.registration_host_name), ''),
           'brand_color', e.registration_brand_color,
           'logo_path', e.registration_logo_path,
           'white_label', e.white_label,
           'code', upper(substr(c.token, 1, 4) || '-' || substr(c.token, 5, 4)),
           'rooms', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('name', r.name, 'first_at', r.first_at) ORDER BY r.first_at)
               FROM (SELECT sp.name, min(se.scanned_at) AS first_at
                       FROM leod_checkin_scan_events se
                       JOIN leod_checkin_scan_points sp ON sp.id = se.scan_point_id
                      WHERE se.attendee_id = a.id AND se.event_id = a.event_id
                        AND se.result IN ('ok', 'duplicate') AND sp.kind = 'interior'   -- CHANGED (159)
                      GROUP BY sp.id, sp.name) r), '[]'::jsonb)),
         a.id, a.event_id, a.checked_in_at, ev.timezone
    INTO v, v_att, v_event, v_in, v_tz
    FROM leod_checkin_certificates c
    JOIN leod_checkin_attendees a ON a.id = c.attendee_id
    JOIN leod_events ev ON ev.id = a.event_id
    JOIN leod_checkin_entitlements e ON e.event_id = a.event_id
   WHERE c.token = p_token
     AND a.checked_in_at IS NOT NULL AND NOT a.is_test
     AND e.status = 'live' AND e.certificate_enabled;
  IF v IS NULL THEN RETURN NULL; END IF;
  -- An unknown zone would make AT TIME ZONE throw; days fall back to UTC.
  IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN v_tz := 'UTC'; END IF;
  -- Walk the guest's records in time order. An entry (check-in, door or
  -- room scan) opens a stay if none is open; an exit closes the open one.
  -- A stay still open at the end of its day (no exit scan) is dropped, and
  -- an exit with no open stay counts for nothing.
  FOR rec IN
    SELECT t, is_out, (t AT TIME ZONE v_tz)::date AS d FROM (
      SELECT v_in AS t, false AS is_out
      UNION ALL
      SELECT se.scanned_at, se.result = 'out'
        FROM leod_checkin_scan_events se
       WHERE se.attendee_id = v_att AND se.event_id = v_event AND NOT se.is_test
         AND se.result IN ('ok', 'duplicate', 'out')) s
     ORDER BY t, is_out
  LOOP
    IF v_day IS DISTINCT FROM rec.d THEN v_day := rec.d; v_open := NULL; END IF;
    IF NOT rec.is_out THEN
      v_open := COALESCE(v_open, rec.t);
    ELSIF v_open IS NOT NULL AND rec.t > v_open THEN
      v_stays := v_stays || jsonb_build_object('day', rec.d, 'from', v_open, 'to', rec.t,
                                               'minutes', floor(extract(epoch FROM rec.t - v_open) / 60)::int);
      v_open := NULL;
    END IF;
  END LOOP;
  -- One line per day: first entry, last exit, minutes inside.
  RETURN v || jsonb_build_object('visits', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('day', day, 'from', f, 'to', l, 'minutes', m) ORDER BY day)
      FROM (SELECT (x->>'day')::date AS day, min((x->>'from')::timestamptz) AS f, max((x->>'to')::timestamptz) AS l,
                   sum((x->>'minutes')::int)::int AS m
              FROM jsonb_array_elements(v_stays) x GROUP BY 1) g), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION checkin_certificate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkin_certificate(text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
