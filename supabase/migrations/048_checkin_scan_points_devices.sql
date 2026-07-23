-- ============================================================
-- CueDeck — Migration 048: Check-in module — scan points & devices
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_checkin_scan_points (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  code        TEXT        NOT NULL,
  description TEXT,
  kind        TEXT        NOT NULL CHECK (kind IN ('entrance', 'interior')),
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE INDEX IF NOT EXISTS idx_checkin_scan_points_event ON leod_checkin_scan_points (event_id);

ALTER TABLE leod_checkin_scan_points ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_sp_read ON leod_checkin_scan_points;
CREATE POLICY checkin_sp_read ON leod_checkin_scan_points
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

DROP POLICY IF EXISTS checkin_sp_write ON leod_checkin_scan_points;
CREATE POLICY checkin_sp_write ON leod_checkin_scan_points
  FOR ALL TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer')
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');


CREATE TABLE IF NOT EXISTS leod_checkin_devices (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  label         TEXT        NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('checkin_station', 'scanner')),
  scan_point_id UUID        REFERENCES leod_checkin_scan_points(id) ON DELETE SET NULL,
  api_key_hash  TEXT        NOT NULL,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind != 'scanner' OR scan_point_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_checkin_devices_event   ON leod_checkin_devices (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_devices_api_key ON leod_checkin_devices (api_key_hash);

ALTER TABLE leod_checkin_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_dev_read ON leod_checkin_devices;
CREATE POLICY checkin_dev_read ON leod_checkin_devices
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

DROP POLICY IF EXISTS checkin_dev_write ON leod_checkin_devices;
CREATE POLICY checkin_dev_write ON leod_checkin_devices
  FOR ALL TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer')
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');

-- NOTE (flagged, not fixed — see Task 5 report): checkin_dev_write's
-- WITH CHECK only constrains this row's own event_id column. It does
-- NOT verify that scan_point_id (when set) points at a scan point
-- belonging to that SAME event. Neither the FK above nor any CHECK
-- constraint enforces devices.event_id == scan_points.event_id for
-- the referenced row. An organizer of event A can therefore point
-- their own device (event_id = A) at a scan_points row owned by
-- event B, without holding any role on B. This is a cross-event data
-- integrity gap analogous to Task 4's identity-lock finding; flagged
-- for follow-up, not fixed in this migration.
