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

-- NOTE: trg_checkin_validate_device_scan_point (below, on
-- leod_checkin_devices) relies on this policy staying scoped to the
-- caller's own event(s) — broadening it would weaken that trigger's
-- fail-closed guarantee for authenticated callers.
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
  -- ON DELETE SET NULL is implemented as an UPDATE, so it's still
  -- subject to the CHECK below — deleting a scan point still
  -- referenced by a scanner-kind device fails the delete (by design,
  -- fails closed) rather than silently leaving an invalid scanner
  -- row. A future "delete scan point" admin flow must catch that and
  -- prompt to reassign/remove its devices first.
  scan_point_id UUID        REFERENCES leod_checkin_scan_points(id) ON DELETE SET NULL,
  api_key_hash  TEXT        NOT NULL,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind != 'scanner' OR scan_point_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_checkin_devices_event       ON leod_checkin_devices (event_id);
CREATE INDEX IF NOT EXISTS idx_checkin_devices_scan_point  ON leod_checkin_devices (scan_point_id);
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

-- checkin_dev_write's WITH CHECK only constrains this row's own
-- event_id column — it can't verify scan_point_id (when set) belongs
-- to that SAME event; CHECK constraints can't query other tables.
-- Without this, an organizer of event A could point their own device
-- at a scan_points row owned by event B. Enforce it with a trigger
-- instead. No SECURITY DEFINER needed: run as invoker, RLS on
-- leod_checkin_scan_points already hides cross-event rows from an
-- authenticated caller, so the EXISTS check below correctly fails
-- closed for them too; a service-role caller (RLS-bypassing) sees the
-- real table and gets the real invariant check.
CREATE OR REPLACE FUNCTION checkin_validate_device_scan_point()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scan_point_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM leod_checkin_scan_points
    WHERE id = NEW.scan_point_id AND event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'scan_point_id must belong to the same event as the device';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_validate_device_scan_point ON leod_checkin_devices;
CREATE TRIGGER trg_checkin_validate_device_scan_point
  BEFORE INSERT OR UPDATE ON leod_checkin_devices
  FOR EACH ROW EXECUTE FUNCTION checkin_validate_device_scan_point();
