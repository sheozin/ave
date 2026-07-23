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
