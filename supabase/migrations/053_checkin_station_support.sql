-- ============================================================
-- CueDeck — Migration 053: Check-in module — station support
-- ============================================================
-- Three changes supporting the check-in station UI (see
-- docs/superpowers/specs/2026-08-03-checkin-station-ui-design.md):
--
-- 1. 'undo' added to leod_checkin_scan_events.result. Undoing a
--    mistaken check-in writes a NEW row rather than deleting the
--    original, so the timeline reads forward and a correction is
--    always attributable. Deleting would also make the existing
--    'duplicate' value unreachable in audit terms.
--
-- 2. operator_id on scan_events. The table had device_id but no
--    person, so "who undid this" was unrecordable. Nullable because
--    pre-existing rows have no operator, and ON DELETE SET NULL so
--    removing a user never destroys the scan history.
--
-- 3. self_registration / kiosk_self_print on entitlements. Per-event
--    config lives in this table already (personalization_station).
--    Both default FALSE: a kiosk that lets anyone issue themselves a
--    badge must be switched on deliberately, never inherited.
--
-- 4. client_id on scan_events, with a unique index. The station queues
--    actions locally and retries on reconnect, so if a flush response
--    is lost the same item is sent again. The unique index makes that
--    at-most-once at the DATABASE, which is the only place it can be
--    guaranteed: the client's own dedup is in-memory and cannot
--    survive the outbox pruning that a multi-day event requires.
--    Nullable with a partial index because rows written by other paths
--    (CSV import, the future door scanner) carry no client_id.
-- ============================================================

ALTER TABLE leod_checkin_scan_events
  DROP CONSTRAINT IF EXISTS leod_checkin_scan_events_result_check;

ALTER TABLE leod_checkin_scan_events
  ADD CONSTRAINT leod_checkin_scan_events_result_check
  CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked', 'undo'));

ALTER TABLE leod_checkin_scan_events
  ADD COLUMN IF NOT EXISTS operator_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_checkin_scan_events_attendee
  ON leod_checkin_scan_events (attendee_id, scanned_at DESC);

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS self_registration BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS kiosk_self_print BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_scan_events
  ADD COLUMN IF NOT EXISTS client_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_scan_events_client_id_unique
  ON leod_checkin_scan_events (client_id) WHERE client_id IS NOT NULL;
