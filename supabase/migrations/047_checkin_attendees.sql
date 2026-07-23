-- ============================================================
-- CueDeck — Migration 047: Check-in module — attendees
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_checkin_attendees (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  first_name       TEXT        NOT NULL,
  last_name        TEXT        NOT NULL,
  email            TEXT,
  company          TEXT,
  role_title       TEXT,
  ticket_type      TEXT        NOT NULL DEFAULT 'attendee',
  qr_token         TEXT        NOT NULL,
  badge_printed_at TIMESTAMPTZ,
  checked_in_at    TIMESTAMPTZ,
  external_ref     TEXT,
  custom_fields    JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (qr_token)
);

CREATE INDEX IF NOT EXISTS idx_checkin_attendees_event    ON leod_checkin_attendees (event_id);
CREATE INDEX IF NOT EXISTS idx_checkin_attendees_ext_ref  ON leod_checkin_attendees (event_id, external_ref);

ALTER TABLE leod_checkin_attendees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_att_read ON leod_checkin_attendees;
CREATE POLICY checkin_att_read ON leod_checkin_attendees
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

DROP POLICY IF EXISTS checkin_att_write ON leod_checkin_attendees;
CREATE POLICY checkin_att_write ON leod_checkin_attendees
  FOR INSERT TO authenticated
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');

DROP POLICY IF EXISTS checkin_att_update ON leod_checkin_attendees;
CREATE POLICY checkin_att_update ON leod_checkin_attendees
  FOR UPDATE TO authenticated
  USING (checkin_role_for_event(event_id) IN ('organizer', 'crew'));

DROP POLICY IF EXISTS checkin_att_delete ON leod_checkin_attendees;
CREATE POLICY checkin_att_delete ON leod_checkin_attendees
  FOR DELETE TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer');

-- checkin_att_update has no WITH CHECK, so it defaults to reusing
-- USING — which only constrains which ROWS are updatable, not which
-- COLUMNS change. That lets 'crew' reassign a row's event_id to any
-- other event they also hold a role on (moving an attendee out of
-- event A's roster entirely), or swap its qr_token. RLS can't compare
-- OLD vs NEW columns declaratively, so lock both down with a trigger,
-- matching the pattern in validate_event_log_role() (migration 039).
CREATE OR REPLACE FUNCTION checkin_lock_attendee_identity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Moving a row to a different event requires organizer on BOTH
  -- sides: organizer-of-A alone would otherwise let someone plant/move
  -- an attendee into event B's roster while holding only 'crew' there,
  -- bypassing checkin_att_write's organizer-only restriction on B.
  IF checkin_role_for_event(OLD.event_id) != 'organizer'
     OR (NEW.event_id IS DISTINCT FROM OLD.event_id
         AND checkin_role_for_event(NEW.event_id) != 'organizer') THEN
    NEW.event_id := OLD.event_id;
    NEW.qr_token := OLD.qr_token;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_lock_attendee_identity ON leod_checkin_attendees;
CREATE TRIGGER trg_checkin_lock_attendee_identity
  BEFORE UPDATE ON leod_checkin_attendees
  FOR EACH ROW EXECUTE FUNCTION checkin_lock_attendee_identity();
