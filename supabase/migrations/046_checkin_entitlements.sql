-- ============================================================
-- CueDeck — Migration 046: Check-in module — entitlements
-- ============================================================
-- A row here means check-in is enabled for that event; no row means
-- the module is inert. Dropping this table (and the rest of
-- leod_checkin_*) removes the module entirely without touching
-- leod_events.
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_checkin_entitlements (
  event_id                UUID        PRIMARY KEY REFERENCES leod_events(id) ON DELETE CASCADE,
  checkin_core            BOOLEAN     NOT NULL DEFAULT true,
  multi_point_scanning    BOOLEAN     NOT NULL DEFAULT false,
  integration_api         BOOLEAN     NOT NULL DEFAULT false,
  personalization_station BOOLEAN     NOT NULL DEFAULT false,
  pii_in_api              BOOLEAN     NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leod_checkin_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_ent_read ON leod_checkin_entitlements;
CREATE POLICY checkin_ent_read ON leod_checkin_entitlements
  FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) IS NOT NULL);

DROP POLICY IF EXISTS checkin_ent_write ON leod_checkin_entitlements;
CREATE POLICY checkin_ent_write ON leod_checkin_entitlements
  FOR ALL TO authenticated
  USING (checkin_role_for_event(event_id) = 'organizer')
  WITH CHECK (checkin_role_for_event(event_id) = 'organizer');
