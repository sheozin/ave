-- 142_checkin_print_queue.sql
-- The print queue: any desk (any browser, any device) sends a badge to a
-- print station, a computer on the venue network that drives a Brother QL
-- label printer (print-helper/cuedeck-print-helper.mjs --pair). The
-- station is a paired device of kind 'printer', paired from the desk's
-- "Kiosk or scanner" dialog like kiosks and scanners, and authenticated by
-- its device key in the checkin-print-station Edge Function.
--
-- leod_checkin_print_jobs (049) was created for this and never used. It
-- gains the event, the label image (a 300 dpi PNG data URL, drawn by
-- checkin-badge.js badgePng) and the cut length. The image carries the
-- guest's name, so it is cleared the moment a job ends and by the
-- checkin-print-expire cron after ten minutes whatever happens.
--
-- Writes go through checkin_queue_print only; the table's direct write
-- policy and every anon grant are removed. Desks read job status (never
-- the image) through a column grant.

-- ── kinds ─────────────────────────────────────────────────────────
ALTER TABLE leod_checkin_devices DROP CONSTRAINT IF EXISTS leod_checkin_devices_kind_check;
ALTER TABLE leod_checkin_devices ADD CONSTRAINT leod_checkin_devices_kind_check
  CHECK (kind IN ('checkin_station', 'scanner', 'kiosk', 'printer'));

ALTER TABLE leod_checkin_kiosk_pairing DROP CONSTRAINT IF EXISTS leod_checkin_kiosk_pairing_kind_chk;
ALTER TABLE leod_checkin_kiosk_pairing ADD CONSTRAINT leod_checkin_kiosk_pairing_kind_chk
  CHECK (device_kind IN ('kiosk', 'scanner', 'printer') AND (device_kind <> 'scanner' OR scan_point_id IS NOT NULL));

-- ── jobs ──────────────────────────────────────────────────────────
ALTER TABLE leod_checkin_print_jobs
  ALTER COLUMN attendee_id DROP NOT NULL,           -- a test print from Badges has no guest
  ADD COLUMN IF NOT EXISTS event_id   uuid REFERENCES leod_events(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS label_png  text,
  ADD COLUMN IF NOT EXISTS cut_mm     numeric(5,1),
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
UPDATE leod_checkin_print_jobs j SET event_id = a.event_id
  FROM leod_checkin_attendees a WHERE a.id = j.attendee_id AND j.event_id IS NULL;
DELETE FROM leod_checkin_print_jobs WHERE event_id IS NULL;
ALTER TABLE leod_checkin_print_jobs ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE leod_checkin_print_jobs DROP CONSTRAINT IF EXISTS leod_checkin_print_jobs_png_chk;
ALTER TABLE leod_checkin_print_jobs ADD CONSTRAINT leod_checkin_print_jobs_png_chk
  CHECK (label_png IS NULL OR (label_png LIKE 'data:image/png;base64,%' AND length(label_png) <= 800000));
CREATE INDEX IF NOT EXISTS idx_checkin_print_jobs_queue ON leod_checkin_print_jobs (device_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_checkin_print_jobs_event ON leod_checkin_print_jobs (event_id, created_at);

-- The device, and the guest if there is one, belong to the job's event:
-- a job must never reach another event's printer.
CREATE OR REPLACE FUNCTION checkin_validate_print_job_device()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.attendee_id IS DISTINCT FROM OLD.attendee_id OR NEW.event_id IS DISTINCT FROM OLD.event_id) THEN
    RAISE EXCEPTION 'attendee_id and event_id cannot be changed after a print job is created';
  END IF;
  IF NEW.attendee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_attendees a WHERE a.id = NEW.attendee_id AND a.event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'attendee_id must belong to the print job''s event';
  END IF;
  IF NEW.device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_devices d WHERE d.id = NEW.device_id AND d.event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'device_id must belong to the print job''s event';
  END IF;
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS checkin_pj_write ON leod_checkin_print_jobs;
ALTER POLICY checkin_pj_read ON leod_checkin_print_jobs
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));
REVOKE ALL ON leod_checkin_print_jobs FROM anon, authenticated;
GRANT SELECT (id, event_id, attendee_id, device_id, status, attempts, error, created_at, claimed_at, completed_at)
  ON leod_checkin_print_jobs TO authenticated;

-- ── expiry ────────────────────────────────────────────────────────
-- A job nobody printed in ten minutes is dropped (a badge that appears an
-- hour late is worse than none); a job a station took and never reported
-- on in two minutes is failed, not requeued, so it can never print twice.
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
  -- Belt and braces: no finished job keeps an image.
  UPDATE leod_checkin_print_jobs SET label_png = NULL
   WHERE label_png IS NOT NULL AND status IN ('done', 'failed');
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION checkin_print_expire(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_print_expire(uuid) TO service_role;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'checkin-print-expire';
SELECT cron.schedule('checkin-print-expire', '*/5 * * * *', $cron$SELECT checkin_print_expire(NULL)$cron$);

-- ── desk: queue ───────────────────────────────────────────────────
-- p_labels: [{ "attendee_id": uuid|null, "png": "data:image/png;base64,...", "cut_mm": 76 }], 1..20.
CREATE OR REPLACE FUNCTION checkin_queue_print(p_event_id uuid, p_device_id uuid, p_labels jsonb)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role  text := checkin_role_for_event(p_event_id);
  v_ids   uuid[] := '{}';
  v_l     jsonb;
  v_att   uuid;
  v_cut   numeric;
  v_png   text;
  v_id    uuid;
  v_waiting integer;
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role NOT IN ('organizer', 'lead', 'crew') THEN
    RAISE EXCEPTION 'Only desk roles on this event can print badges' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_devices WHERE id = p_device_id AND event_id = p_event_id
                  AND kind = 'printer' AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'That print station is not paired to this event' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(p_labels) <> 'array' OR jsonb_array_length(p_labels) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Send 1 to 20 badges at a time' USING ERRCODE = '22023';
  END IF;
  PERFORM checkin_print_expire(p_device_id);
  SELECT count(*) INTO v_waiting FROM leod_checkin_print_jobs WHERE device_id = p_device_id AND status = 'queued';
  IF v_waiting + jsonb_array_length(p_labels) > 200 THEN
    RAISE EXCEPTION 'The print station has 200 badges waiting. Check that it is running.' USING ERRCODE = '54000';
  END IF;
  FOR v_l IN SELECT value FROM jsonb_array_elements(p_labels) LOOP
    v_png := v_l->>'png';
    v_cut := CASE WHEN jsonb_typeof(v_l->'cut_mm') = 'number' THEN (v_l->>'cut_mm')::numeric END;
    v_att := CASE WHEN v_l->>'attendee_id' ~ '^[0-9a-fA-F-]{36}$' THEN (v_l->>'attendee_id')::uuid END;
    IF v_png IS NULL OR v_png NOT LIKE 'data:image/png;base64,%' OR length(v_png) > 800000 THEN
      RAISE EXCEPTION 'A badge image is missing or too large' USING ERRCODE = '22023';
    END IF;
    IF v_cut IS NULL OR v_cut < 20 OR v_cut > 300 THEN
      RAISE EXCEPTION 'cut_mm must be 20 to 300' USING ERRCODE = '22023';
    END IF;
    INSERT INTO leod_checkin_print_jobs (event_id, attendee_id, device_id, label_png, cut_mm, created_by)
    VALUES (p_event_id, v_att, p_device_id, v_png, round(v_cut, 1), auth.uid())
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END LOOP;
  RETURN v_ids;
END;
$$;
REVOKE ALL ON FUNCTION checkin_queue_print(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_queue_print(uuid, uuid, jsonb) TO authenticated;

-- ── desk: the stations to choose from ─────────────────────────────
-- online: the station long-polls every ~20 s and each poll stamps
-- last_seen_at (checkin-device.ts), so 45 s of silence means it stopped.
CREATE OR REPLACE FUNCTION checkin_print_stations(p_event_id uuid)
RETURNS TABLE(id uuid, label text, last_seen_at timestamptz, online boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF checkin_role_for_event(p_event_id) IS NULL OR checkin_role_for_event(p_event_id) NOT IN ('organizer', 'lead', 'crew') THEN
    RAISE EXCEPTION 'Only desk roles on this event can see its printers' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.id, d.label, d.last_seen_at, coalesce(d.last_seen_at > now() - interval '45 seconds', false)
      FROM leod_checkin_devices d
     WHERE d.event_id = p_event_id AND d.kind = 'printer' AND d.revoked_at IS NULL
     ORDER BY d.label;
END;
$$;
REVOKE ALL ON FUNCTION checkin_print_stations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_print_stations(uuid) TO authenticated;

-- ── station (service role, from checkin-print-station) ────────────
CREATE OR REPLACE FUNCTION checkin_print_claim(p_device_id uuid, p_limit integer DEFAULT 5)
RETURNS TABLE(id uuid, label_png text, cut_mm numeric)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM checkin_print_expire(p_device_id);
  RETURN QUERY
    UPDATE leod_checkin_print_jobs j
       SET status = 'printing', claimed_at = now(), attempts = j.attempts + 1
     WHERE j.id IN (SELECT q.id FROM leod_checkin_print_jobs q
                     WHERE q.device_id = p_device_id AND q.status = 'queued'
                     ORDER BY q.created_at LIMIT greatest(1, least(p_limit, 20))
                     FOR UPDATE SKIP LOCKED)
    RETURNING j.id, j.label_png, j.cut_mm;
END;
$$;
REVOKE ALL ON FUNCTION checkin_print_claim(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_print_claim(uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION checkin_print_finish(p_device_id uuid, p_job_id uuid, p_ok boolean, p_error text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE leod_checkin_print_jobs
     SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END,
         error = CASE WHEN p_ok THEN NULL ELSE left(coalesce(p_error, 'The printer did not print'), 300) END,
         completed_at = now(), label_png = NULL
   WHERE id = p_job_id AND device_id = p_device_id AND status = 'printing';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION checkin_print_finish(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_print_finish(uuid, uuid, boolean, text) TO service_role;

NOTIFY pgrst, 'reload schema';
