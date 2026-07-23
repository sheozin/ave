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

-- Deliberately no client-side write policy. These flags are a billing/
-- entitlement gate — every event owner is auto-granted 'organizer' on
-- their own event (migration 045's trigger), so a write policy scoped
-- to 'organizer' would let any owner self-grant every paid feature
-- flag directly, bypassing checkin-enable-event's authorization and
-- hardcoded checkin_core value entirely. Writes go through that
-- Edge Function's service-role client only, which enforces caller ==
-- event creator or admin before upserting.
DROP POLICY IF EXISTS checkin_ent_write ON leod_checkin_entitlements;
