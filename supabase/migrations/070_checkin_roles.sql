-- 070_checkin_roles.sql
-- Five check-in roles: owner (leod_events.created_by), organizer, lead,
-- crew (shown as "Desk staff") and viewer.
-- Design: docs/superpowers/specs/2026-10-04-checkin-roles-design.md
--
-- Existing data needs no change: every organizer stays Organizer, every
-- crew member stays Desk staff, every creator stays Owner.

-- ── CHECK constraints ─────────────────────────────────────────────
-- Live 2026-10-04: role IN (organizer, crew, api_consumer).
ALTER TABLE leod_checkin_operators DROP CONSTRAINT leod_checkin_operators_role_check;
ALTER TABLE leod_checkin_operators ADD CONSTRAINT leod_checkin_operators_role_check
  CHECK (role IN ('organizer', 'lead', 'crew', 'viewer', 'api_consumer'));

-- Live: source IN (import, kiosk). Ruling 7 adds desk walk-ins.
ALTER TABLE leod_checkin_attendees DROP CONSTRAINT leod_checkin_attendees_source_check;
ALTER TABLE leod_checkin_attendees ADD CONSTRAINT leod_checkin_attendees_source_check
  CHECK (source IN ('import', 'kiosk', 'walk_in'));

-- Live: result IN (ok, duplicate, unknown_token, wrong_event, revoked, undo,
-- test_cap, outside_window). Ruling 8 adds 'forbidden' (crew undo of a
-- check-in someone else made).
ALTER TABLE leod_checkin_scan_events DROP CONSTRAINT leod_checkin_scan_events_result_check;
ALTER TABLE leod_checkin_scan_events ADD CONSTRAINT leod_checkin_scan_events_result_check
  CHECK (result IN ('ok', 'duplicate', 'unknown_token', 'wrong_event', 'revoked', 'undo',
                    'test_cap', 'outside_window', 'forbidden'));

-- ── Owner helper ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_is_owner(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM leod_events WHERE id = p_event_id AND created_by = auth.uid()
  );
$$;
REVOKE ALL ON FUNCTION checkin_is_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_is_owner(uuid) TO authenticated;

-- ── Policies ──────────────────────────────────────────────────────
-- ALTER POLICY keeps each policy's command and role list; only the
-- expressions change. checkin_att_write (INSERT, organizer) and
-- checkin_att_delete (organizer) are deliberately unchanged: desk
-- walk-ins arrive through the checkin-add-walk-in Edge Function
-- (service role), because checkin_guard_attendee_insert refuses
-- is_test from any JWT caller and a test-mode walk-in must be is_test.

-- attendees: read and update to organizer, lead, crew (was organizer, crew)
ALTER POLICY checkin_att_read ON leod_checkin_attendees
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));
ALTER POLICY checkin_att_update ON leod_checkin_attendees
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));

-- devices: read organizer, lead, crew; write organizer, lead (kiosks are a lead job)
ALTER POLICY checkin_dev_read ON leod_checkin_devices
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));
ALTER POLICY checkin_dev_write ON leod_checkin_devices
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead']::text[]))
  WITH CHECK (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead']::text[]));

-- entitlements and operators: readable by all four grant roles (the owner holds an organizer row)
ALTER POLICY checkin_ent_read ON leod_checkin_entitlements
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew', 'viewer']::text[]));
ALTER POLICY checkin_op_read ON leod_checkin_operators
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew', 'viewer']::text[]));

-- print jobs: organizer, lead, crew (via the attendee's event)
ALTER POLICY checkin_pj_read ON leod_checkin_print_jobs
  USING (attendee_id IN (SELECT a.id FROM leod_checkin_attendees a
                          WHERE checkin_role_for_event(a.event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[])));
ALTER POLICY checkin_pj_write ON leod_checkin_print_jobs
  USING (attendee_id IN (SELECT a.id FROM leod_checkin_attendees a
                          WHERE checkin_role_for_event(a.event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[])))
  WITH CHECK (attendee_id IN (SELECT a.id FROM leod_checkin_attendees a
                          WHERE checkin_role_for_event(a.event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[])));

-- purchases: the owner alone (was any organizer)
ALTER POLICY checkin_purchase_read ON leod_checkin_purchases
  USING (checkin_is_owner(event_id));

-- scan events: read organizer, lead, crew (was any role, which would have
-- included viewers). api_consumer keeps its read: migration 051 scoped that
-- role to exactly this table. No api_consumer rows exist on 2026-10-04.
ALTER POLICY checkin_se_read ON leod_checkin_scan_events
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew', 'api_consumer']::text[]));
ALTER POLICY checkin_se_write ON leod_checkin_scan_events
  WITH CHECK (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));

-- scan points: read organizer, lead, crew; write organizer, lead
ALTER POLICY checkin_sp_read ON leod_checkin_scan_points
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']::text[]));
ALTER POLICY checkin_sp_write ON leod_checkin_scan_points
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead']::text[]))
  WITH CHECK (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead']::text[]));

-- ── checkin_my_events: all four grant roles ───────────────────────
-- Same signature and body as live, with lead and viewer added. The owner
-- is still reported as 'organizer' (is_owner = true) so the pages deployed
-- today keep working; migration 073 switches it to 'owner' after the
-- pages that read is_owner are live.
CREATE OR REPLACE FUNCTION checkin_my_events()
 RETURNS TABLE(event_id uuid, name text, date date, venue text, timezone text,
               event_start time without time zone, event_end time without time zone,
               created_via text, is_owner boolean, role text, status text,
               attendees integer, arrived integer, test_used integer, is_comp boolean)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = public
AS $function$
  WITH mine AS (
    SELECT o.event_id, o.role FROM leod_checkin_operators o
     WHERE o.user_id = auth.uid() AND o.role IN ('organizer', 'lead', 'crew', 'viewer')
    UNION
    SELECT e.id, 'organizer' FROM leod_events e WHERE e.created_by = auth.uid()
  ), best AS (
    SELECT DISTINCT ON (event_id) event_id, role FROM mine
     ORDER BY event_id, array_position(ARRAY['organizer', 'lead', 'crew', 'viewer'], role)
  )
  SELECT b.event_id, e.name, e.date, e.venue, e.timezone, e.event_start, e.event_end,
         e.created_via, (e.created_by = auth.uid()), b.role, ent.status,
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id),
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id AND a.checked_in_at IS NOT NULL),
         (SELECT count(*)::int FROM leod_checkin_scan_events s WHERE s.event_id = b.event_id AND s.is_test AND s.result = 'ok')
           + (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = b.event_id AND a.is_test),
         EXISTS (SELECT 1 FROM leod_checkin_comp_accounts c WHERE c.user_id = e.created_by)
    FROM best b
    JOIN leod_events e ON e.id = b.event_id AND e.active
    LEFT JOIN leod_checkin_entitlements ent ON ent.event_id = b.event_id
   WHERE ent.event_id IS NOT NULL OR e.created_by = auth.uid();
$function$;

-- ── Event details for organizers ──────────────────────────────────
-- leod_events UPDATE is owner-only by RLS (owner_update_events), and the
-- table is shared with the console (branding, created_by, active). Widening
-- that policy would let an organizer change created_by or active, so
-- organizers edit the six detail columns through this function instead.
-- The live-date lock (trigger checkin_lock_live_event_date) still applies:
-- auth.role() is 'authenticated' inside this function.
CREATE OR REPLACE FUNCTION checkin_update_event_details(
  p_event_id uuid, p_name text, p_venue text, p_date date, p_timezone text,
  p_event_start time, p_event_end time)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name  text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_venue text := NULLIF(btrim(regexp_replace(coalesce(p_venue, ''), '\s+', ' ', 'g')), '');
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id) OR checkin_role_for_event(p_event_id) = 'organizer') THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change event details'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_name = '' OR length(v_name) > 160 THEN
    RAISE EXCEPTION 'The event name is required, at most 160 characters' USING ERRCODE = '22023';
  END IF;
  IF v_venue IS NOT NULL AND length(v_venue) > 160 THEN
    RAISE EXCEPTION 'The venue is at most 160 characters' USING ERRCODE = '22023';
  END IF;
  IF p_timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown timezone %', p_timezone USING ERRCODE = '22023';
  END IF;
  UPDATE leod_events
     SET name = v_name,
         venue = v_venue,
         date = COALESCE(p_date, date),
         timezone = COALESCE(p_timezone, timezone),
         event_start = COALESCE(p_event_start, event_start),
         event_end = COALESCE(p_event_end, event_end)
   WHERE id = p_event_id AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION checkin_update_event_details(uuid, text, text, date, text, time, time) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_update_event_details(uuid, text, text, date, text, time, time) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Fix round 1 (review): applied separately as checkin_roles_details_gate.
-- 1. Console events stay with their console owner (roles spec ruling 3):
--    a non-owner organizer may edit only events created_via = 'checkin'.
-- 2. p_venue NULL keeps the current venue; '' (or blanks) clears it.
-- 3. The event must end after it starts, judged after keeps are applied.
-- The permission check runs before the event lookup so that a caller
-- with no role cannot tell an existing event from a missing one.
CREATE OR REPLACE FUNCTION checkin_update_event_details(
  p_event_id uuid, p_name text, p_venue text, p_date date, p_timezone text,
  p_event_start time, p_event_end time)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name     text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_venue    text := btrim(regexp_replace(p_venue, '\s+', ' ', 'g'));
  v_is_owner boolean;
  v_via      text;
  v_start    time;
  v_end      time;
BEGIN
  v_is_owner := checkin_is_owner(p_event_id);
  IF auth.uid() IS NULL
     OR NOT (v_is_owner OR checkin_role_for_event(p_event_id) = 'organizer') THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change event details'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT created_via, event_start, event_end INTO v_via, v_start, v_end
    FROM leod_events WHERE id = p_event_id AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_is_owner AND v_via IS DISTINCT FROM 'checkin' THEN
    RAISE EXCEPTION 'Only the event owner can edit a console event'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_name = '' OR length(v_name) > 160 THEN
    RAISE EXCEPTION 'The event name is required, at most 160 characters' USING ERRCODE = '22023';
  END IF;
  IF v_venue IS NOT NULL AND length(v_venue) > 160 THEN
    RAISE EXCEPTION 'The venue is at most 160 characters' USING ERRCODE = '22023';
  END IF;
  IF p_timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown timezone %', p_timezone USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_event_end, v_end) <= COALESCE(p_event_start, v_start) THEN
    RAISE EXCEPTION 'The event must end after it starts' USING ERRCODE = '22023';
  END IF;
  UPDATE leod_events
     SET name = v_name,
         venue = CASE WHEN p_venue IS NULL THEN venue ELSE NULLIF(v_venue, '') END,
         date = COALESCE(p_date, date),
         timezone = COALESCE(p_timezone, timezone),
         event_start = COALESCE(p_event_start, event_start),
         event_end = COALESCE(p_event_end, event_end)
   WHERE id = p_event_id AND active;
END;
$$;
REVOKE ALL ON FUNCTION checkin_update_event_details(uuid, text, text, date, text, time, time) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_update_event_details(uuid, text, text, date, text, time, time) TO authenticated;

NOTIFY pgrst, 'reload schema';
