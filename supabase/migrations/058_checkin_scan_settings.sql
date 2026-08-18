-- ============================================================
-- CueDeck — Migration 058: Check-in — per-event scan settings
-- ============================================================
-- Not every event wants door scanning, and fewer want session
-- scanning. A small seminar checks people in at a desk and nothing
-- else. These two settings make the scanner opt-in per event.
--
-- WHY THESE ARE NOT ENTITLEMENTS
--
-- leod_checkin_entitlements already mixes two kinds of flag:
-- commercial ones the plan permits (checkin_core,
-- multi_point_scanning, integration_api, pii_in_api) and operational
-- ones the organizer switched on (auto_send_qr_email, added in 052;
-- self_registration and kiosk_self_print, added in 053 — both
-- following the existing shape). The distinction matters here:
-- multi_point_scanning answers "may they", these answer "do they want
-- it, at this event". BOTH gates must pass — an event holding the
-- entitlement with the setting off does no session scanning.
--
-- Both default FALSE. A feature that appears without being asked for
-- is one an organizer discovers at 8am on a day they did not plan for
-- it.
--
-- The three settings already here are deliberately NOT moved out to a
-- table of their own: they are live in production and read by deployed
-- Edge Functions. Tidying that is a separate change with its own risk.
--
-- NO POLICY CHANGE, AND NO COLUMN GUARD
--
-- Migration 055 had to extend checkin_guard_attendee_columns() because
-- leod_checkin_attendees admits crew writes and its policy is
-- column-blind. This table is the opposite shape: its ONLY policy is
-- checkin_ent_read (046, re-scoped by 051), FOR SELECT. There has
-- never been a write policy — 046 deliberately declined to create one,
-- because every event owner is auto-granted 'organizer' on their own
-- event (045's trigger), so an organizer-scoped write policy would let
-- any owner self-grant every paid feature flag. RLS is enabled, so
-- with no permissive write policy an authenticated PATCH matches
-- nothing and updates zero rows. It fails closed at the policy layer
-- before any column is considered. A guard here would be machinery
-- that can never fire.
--
-- STATED AS AN INVARIANT SO A LATER EDIT HAS TO NOTICE IT: the day a
-- write policy is added to this table, these two columns need a guard,
-- exactly as 054's did — an organizer who can PATCH session_scanning
-- directly is an organizer switching on a scan point their plan may
-- not permit. Writes belong to the service role only.
--
-- ORDER OF OPERATIONS: apply this BEFORE deploying the updated
-- checkin-record-scans. That function selects these columns, and
-- PostgREST answers a select naming an unknown column with an error —
-- deploying first would fail every desk on the platform.
-- ============================================================

-- ── The two settings ──────────────────────────────────────────────

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS entrance_scanning BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS session_scanning BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN leod_checkin_entitlements.entrance_scanning IS
  'Organizer setting, not an entitlement: door scanning on for this event.';

COMMENT ON COLUMN leod_checkin_entitlements.session_scanning IS
  'Organizer setting: interior scanning on. Requires multi_point_scanning (the entitlement) to also be true.';


-- ── No policy changes ─────────────────────────────────────────────
--
-- Intentionally empty. checkin_ent_read (046/051) already scopes reads
-- to organizer and crew, and this table has no write policy by design.
-- Listed here so a future reader does not add one by accident. See the
-- header.
