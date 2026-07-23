-- ============================================================
-- CueDeck — Migration 045: Check-in module — per-event operators
-- ============================================================
-- Authorization boundary for ALL leod_checkin_* tables. A user can
-- see/act on a given event's check-in data only if they hold a row
-- here for that event_id. Deliberately independent of leod_events
-- RLS (created_by / invited_by) so check-in can be sold and
-- administered without touching CueDeck's core event ownership.
--
-- role:
--   organizer    — full read/write (event owner, or anyone they grant)
--   crew         — scan + print, read attendees/scan points/devices
--   api_consumer — read-only scan events (used by the Phase 2 API)
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_checkin_operators (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('organizer', 'crew', 'api_consumer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_checkin_operators_event ON leod_checkin_operators (event_id);
CREATE INDEX IF NOT EXISTS idx_checkin_operators_user  ON leod_checkin_operators (user_id);

ALTER TABLE leod_checkin_operators ENABLE ROW LEVEL SECURITY;

-- Helper: caller's role for a given event, NULL if none.
-- SET search_path pins this SECURITY DEFINER function against search
-- path hijacking (existing CueDeck SECURITY DEFINER functions predate
-- this hardening — worth a separate follow-up migration, not fixed
-- here since it's out of scope for check-in).
CREATE OR REPLACE FUNCTION checkin_role_for_event(p_event_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM leod_checkin_operators
  WHERE event_id = p_event_id AND user_id = auth.uid()
$$;

DROP POLICY IF EXISTS checkin_op_read ON leod_checkin_operators;
CREATE POLICY checkin_op_read ON leod_checkin_operators
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

DROP POLICY IF EXISTS checkin_op_write ON leod_checkin_operators;
CREATE POLICY checkin_op_write ON leod_checkin_operators
  FOR INSERT TO authenticated
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');

DROP POLICY IF EXISTS checkin_op_update ON leod_checkin_operators;
CREATE POLICY checkin_op_update ON leod_checkin_operators
  FOR UPDATE TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer');

DROP POLICY IF EXISTS checkin_op_delete ON leod_checkin_operators;
CREATE POLICY checkin_op_delete ON leod_checkin_operators
  FOR DELETE TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer');

-- Auto-grant: whoever creates an event is its check-in organizer.
CREATE OR REPLACE FUNCTION checkin_auto_grant_organizer()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'organizer')
  ON CONFLICT (event_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_auto_grant_organizer ON leod_events;
CREATE TRIGGER trg_checkin_auto_grant_organizer
  AFTER INSERT ON leod_events
  FOR EACH ROW EXECUTE FUNCTION checkin_auto_grant_organizer();

-- Backfill: grant organizer to every existing event's creator.
INSERT INTO leod_checkin_operators (event_id, user_id, role)
SELECT id, created_by, 'organizer'
FROM leod_events
WHERE created_by IS NOT NULL
ON CONFLICT (event_id, user_id) DO NOTHING;
