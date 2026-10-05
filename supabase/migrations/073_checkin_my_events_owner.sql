-- 073_checkin_my_events_owner.sql
-- checkin_my_events reports the event's creator as 'owner' (roles spec,
-- Server changes), so every screen reads one value. Shipped after the
-- pages that compute the role from is_owner were live (Task 15), because
-- the pages deployed before this plan treated only 'organizer' as an
-- organizer. Body otherwise identical to migration 070.
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
         e.created_via, (e.created_by = auth.uid()),
         CASE WHEN e.created_by = auth.uid() THEN 'owner' ELSE b.role END,
         ent.status,
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
