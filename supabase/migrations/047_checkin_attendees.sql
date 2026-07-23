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
