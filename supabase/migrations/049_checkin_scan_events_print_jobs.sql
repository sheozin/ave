-- ============================================================
-- CueDeck — Migration 049: Check-in module — scan events & print jobs
-- ============================================================
-- scan_events.id is CLIENT-GENERATED (crypto.randomUUID() on the
-- device) so an offline device can resend the same scan after
-- reconnecting; the primary key alone makes the insert a no-op on
-- retry. Unlike leod_commands, no separate idempotency table is
-- needed — a scan event has no second step to redo.

CREATE TABLE IF NOT EXISTS leod_checkin_scan_events (
  id            UUID        PRIMARY KEY,
  event_id      UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  attendee_id   UUID        REFERENCES leod_checkin_attendees(id) ON DELETE SET NULL,
  scan_point_id UUID        REFERENCES leod_checkin_scan_points(id) ON DELETE SET NULL,
  device_id     UUID        REFERENCES leod_checkin_devices(id) ON DELETE SET NULL,
  scanned_at    TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  result        TEXT        NOT NULL CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkin_scan_events_event_time      ON leod_checkin_scan_events (event_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_checkin_scan_events_attendee_point  ON leod_checkin_scan_events (attendee_id, scan_point_id);

ALTER TABLE leod_checkin_scan_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_se_read ON leod_checkin_scan_events;
CREATE POLICY checkin_se_read ON leod_checkin_scan_events
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

-- Direct client INSERT is for organizer/crew manual corrections only.
-- Real device scans go through the checkin-submit-scan Edge Function
-- (Plan 1b), which uses the service-role client and validates the
-- device's api_key_hash instead of a user session.
DROP POLICY IF EXISTS checkin_se_write ON leod_checkin_scan_events;
CREATE POLICY checkin_se_write ON leod_checkin_scan_events
  FOR INSERT TO authenticated
  WITH CHECK (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

-- checkin_se_write only checks event_id — attendee_id/scan_point_id/
-- device_id are nullable and unchecked against it, so an organizer or
-- crew member on event A could insert a manual-correction row that
-- cross-references an attendee/point/device from a different event,
-- corrupting reporting (e.g. Plan 1c's arrival-curve dashboard). No
-- SECURITY DEFINER: RLS on the referenced tables already hides
-- cross-event rows from an authenticated caller, so this fails closed
-- for them; service-role writes see the real tables and get the real
-- check.
CREATE OR REPLACE FUNCTION checkin_validate_scan_event_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.attendee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_attendees WHERE id = NEW.attendee_id AND event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'attendee_id must belong to the same event as the scan event';
  END IF;

  IF NEW.scan_point_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_scan_points WHERE id = NEW.scan_point_id AND event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'scan_point_id must belong to the same event as the scan event';
  END IF;

  IF NEW.device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_devices WHERE id = NEW.device_id AND event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'device_id must belong to the same event as the scan event';
  END IF;

  RETURN NEW;
END;
$$;

-- INSERT only: this table has no UPDATE policy (append-only log).
DROP TRIGGER IF EXISTS trg_checkin_validate_scan_event_refs ON leod_checkin_scan_events;
CREATE TRIGGER trg_checkin_validate_scan_event_refs
  BEFORE INSERT ON leod_checkin_scan_events
  FOR EACH ROW EXECUTE FUNCTION checkin_validate_scan_event_refs();


CREATE TABLE IF NOT EXISTS leod_checkin_print_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  attendee_id  UUID        NOT NULL REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  device_id    UUID        REFERENCES leod_checkin_devices(id) ON DELETE SET NULL,
  template_id  UUID,
  status       TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'printing', 'done', 'failed')),
  attempts     INT         NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkin_print_jobs_attendee ON leod_checkin_print_jobs (attendee_id);
CREATE INDEX IF NOT EXISTS idx_checkin_print_jobs_status   ON leod_checkin_print_jobs (device_id, status);

ALTER TABLE leod_checkin_print_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_pj_read ON leod_checkin_print_jobs;
CREATE POLICY checkin_pj_read ON leod_checkin_print_jobs
  FOR SELECT TO authenticated
  USING (
    attendee_id IN (
      SELECT id FROM leod_checkin_attendees
      WHERE checkin_role_for_event(event_id) IS NOT NULL
    )
  );

DROP POLICY IF EXISTS checkin_pj_write ON leod_checkin_print_jobs;
CREATE POLICY checkin_pj_write ON leod_checkin_print_jobs
  FOR ALL TO authenticated
  USING (
    attendee_id IN (
      SELECT id FROM leod_checkin_attendees
      WHERE checkin_role_for_event(event_id) IN ('organizer', 'crew')
    )
  )
  WITH CHECK (
    attendee_id IN (
      SELECT id FROM leod_checkin_attendees
      WHERE checkin_role_for_event(event_id) IN ('organizer', 'crew')
    )
  );

-- checkin_pj_write only checks attendee_id's event — device_id is
-- unchecked against it. Unlike scan_events (a log), a print job is an
-- actuator: a job with a cross-event device_id would dispatch a print
-- to the wrong physical printer at a different event's site. Same
-- no-SECURITY-DEFINER reasoning as above and as migration 048's
-- device/scan_point trigger.
CREATE OR REPLACE FUNCTION checkin_validate_print_job_device()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- attendee_id is an identity anchor like attendees.event_id/qr_token
  -- (047) — a print job is created FOR one attendee's badge and has no
  -- legitimate reason to be reassigned. Unlike device_id (which may
  -- legitimately change, e.g. retrying on a different printer), lock
  -- it on UPDATE. This also closes the common case the device_id
  -- check alone misses: a freshly queued job has device_id IS NULL,
  -- so that check never runs until a device is assigned later.
  IF TG_OP = 'UPDATE' AND NEW.attendee_id IS DISTINCT FROM OLD.attendee_id THEN
    RAISE EXCEPTION 'attendee_id cannot be changed after a print job is created';
  END IF;

  IF NEW.device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM leod_checkin_attendees a
    JOIN leod_checkin_devices d ON d.event_id = a.event_id
    WHERE a.id = NEW.attendee_id AND d.id = NEW.device_id
  ) THEN
    RAISE EXCEPTION 'device_id must belong to the same event as the attendee';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_validate_print_job_device ON leod_checkin_print_jobs;
CREATE TRIGGER trg_checkin_validate_print_job_device
  BEFORE INSERT OR UPDATE ON leod_checkin_print_jobs
  FOR EACH ROW EXECUTE FUNCTION checkin_validate_print_job_device();
