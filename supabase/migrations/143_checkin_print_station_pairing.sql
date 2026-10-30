-- 143_checkin_print_station_pairing.sql
-- Phase A of "printing without a terminal": the print station shows (or
-- prints) a code and the organizer types it in CueDeck, the reverse of the
-- kiosk flow. The station makes its own device key and sends only the
-- SHA-256 of it; the key never leaves the station, so nothing secret is
-- stored here or handed over the wire. Approving binds that hash to a new
-- 'printer' device of the event.
--
-- Also: what each station drives (printer_info, reported by the station on
-- every poll: model 'brother-ql' or 'zebra', dpi, print width), so desks
-- size badges for that printer, and the Printers list in Event admin.

CREATE TABLE IF NOT EXISTS leod_checkin_device_requests (
  code        text        PRIMARY KEY CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  key_hash    text        NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  kind        text        NOT NULL CHECK (kind = 'printer'),
  info        jsonb       CHECK (info IS NULL OR (jsonb_typeof(info) = 'object' AND length(info::text) <= 2000)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  event_id    uuid        REFERENCES leod_events(id) ON DELETE CASCADE,
  device_id   uuid        REFERENCES leod_checkin_devices(id) ON DELETE SET NULL,
  approved_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz
);
ALTER TABLE leod_checkin_device_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_device_requests FROM anon, authenticated;
-- No policies: only the checkin-kiosk-pair Edge Function (service role) reads or writes it.

ALTER TABLE leod_checkin_devices ADD COLUMN IF NOT EXISTS printer_info jsonb
  CHECK (printer_info IS NULL OR (jsonb_typeof(printer_info) = 'object' AND length(printer_info::text) <= 2000));

-- Approve: one transaction, so a code is used once and a device exists only
-- for an approved code that had not expired.
CREATE OR REPLACE FUNCTION checkin_approve_device_request(p_code text, p_event_id uuid, p_label text, p_user uuid)
RETURNS TABLE(device_id uuid, info jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r leod_checkin_device_requests;
  v_dev uuid;
BEGIN
  SELECT * INTO r FROM leod_checkin_device_requests WHERE code = p_code FOR UPDATE;
  IF NOT FOUND OR r.approved_at IS NOT NULL OR r.expires_at < now() THEN
    RAISE EXCEPTION 'That code is not waiting to be paired. Check it on the print station.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO leod_checkin_devices (event_id, label, kind, api_key_hash, printer_info, last_seen_at)
  VALUES (p_event_id, left(btrim(p_label), 60), r.kind, r.key_hash, r.info, now())
  RETURNING id INTO v_dev;
  UPDATE leod_checkin_device_requests
     SET event_id = p_event_id, device_id = v_dev, approved_by = p_user, approved_at = now()
   WHERE code = p_code;
  RETURN QUERY SELECT v_dev, r.info;
END;
$$;
REVOKE ALL ON FUNCTION checkin_approve_device_request(text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_approve_device_request(text, uuid, text, uuid) TO service_role;

-- The stations list now says what each one prints on and when it last
-- printed, for desks and for the Printers list in Event admin.
DROP FUNCTION IF EXISTS checkin_print_stations(uuid);
CREATE FUNCTION checkin_print_stations(p_event_id uuid)
RETURNS TABLE(id uuid, label text, last_seen_at timestamptz, online boolean, printer_info jsonb,
              last_printed_at timestamptz, printed_today integer, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF checkin_role_for_event(p_event_id) IS NULL OR checkin_role_for_event(p_event_id) NOT IN ('organizer', 'lead', 'crew') THEN
    RAISE EXCEPTION 'Only desk roles on this event can see its printers' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.id, d.label, d.last_seen_at, coalesce(d.last_seen_at > now() - interval '45 seconds', false), d.printer_info,
           (SELECT max(j.completed_at) FROM leod_checkin_print_jobs j WHERE j.device_id = d.id AND j.status = 'done'),
           (SELECT count(*)::integer FROM leod_checkin_print_jobs j WHERE j.device_id = d.id AND j.status = 'done' AND j.completed_at > date_trunc('day', now())),
           d.created_at
      FROM leod_checkin_devices d
     WHERE d.event_id = p_event_id AND d.kind = 'printer' AND d.revoked_at IS NULL
     ORDER BY d.label;
END;
$$;
REVOKE ALL ON FUNCTION checkin_print_stations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_print_stations(uuid) TO authenticated;

-- Old requests go with the print cron (142), a day after they expire.
CREATE OR REPLACE FUNCTION checkin_print_expire(p_device_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE leod_checkin_print_jobs
     SET status = 'failed', label_png = NULL, completed_at = now(),
         error = CASE WHEN status = 'queued' THEN 'Not printed within 10 minutes: is the print station running?'
                      ELSE 'The print station stopped before it confirmed this badge' END
   WHERE (p_device_id IS NULL OR device_id = p_device_id)
     AND ((status = 'queued' AND created_at < now() - interval '10 minutes')
       OR (status = 'printing' AND claimed_at < now() - interval '2 minutes'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE leod_checkin_print_jobs SET label_png = NULL
   WHERE label_png IS NOT NULL AND status IN ('done', 'failed');
  IF p_device_id IS NULL THEN
    DELETE FROM leod_checkin_device_requests WHERE expires_at < now() - interval '1 day';
  END IF;
  RETURN v_n;
END;
$$;

NOTIFY pgrst, 'reload schema';
