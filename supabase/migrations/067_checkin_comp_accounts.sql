-- 067: complimentary check-in accounts. Events created by a comp account go
-- live without payment. Paywall exception: only admin/service role may grant.
CREATE TABLE IF NOT EXISTS leod_checkin_comp_accounts (
  user_id    UUID        PRIMARY KEY,
  granted_by UUID,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE leod_checkin_comp_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_comp_accounts FROM anon, authenticated;
DROP POLICY IF EXISTS comp_admin_read ON leod_checkin_comp_accounts;
CREATE POLICY comp_admin_read ON leod_checkin_comp_accounts FOR SELECT TO authenticated USING (is_admin());
GRANT SELECT ON leod_checkin_comp_accounts TO authenticated;  -- RLS limits it to admins

INSERT INTO leod_checkin_comp_accounts (user_id, granted_by, note)
VALUES ('59f71f02-a381-4b8d-b0a3-f4316c031ffb', '28230d43-5524-493d-8e23-684836934b53', 'Full access granted by Sherif 2026-10-04')
ON CONFLICT (user_id) DO NOTHING;

-- One read for every check-in page. leod_events RLS is owner-scoped, so
-- invited desk staff and co-organizers cannot read the event row; this
-- returns what they need for events they hold a role on.
CREATE OR REPLACE FUNCTION public.checkin_my_events()
RETURNS TABLE (
  event_id UUID, name TEXT, date DATE, venue TEXT, timezone TEXT,
  event_start TIME, event_end TIME, created_via TEXT, is_owner BOOLEAN,
  role TEXT, status TEXT, attendees INTEGER, arrived INTEGER, test_used INTEGER,
  is_comp BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH mine AS (
    SELECT o.event_id, o.role FROM leod_checkin_operators o
     WHERE o.user_id = auth.uid() AND o.role IN ('organizer', 'crew')
    UNION
    SELECT e.id, 'organizer' FROM leod_events e WHERE e.created_by = auth.uid()
  ), best AS (
    SELECT DISTINCT ON (event_id) event_id, role FROM mine
     ORDER BY event_id, (role = 'organizer') DESC
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
REVOKE ALL ON FUNCTION public.checkin_my_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkin_my_events() TO authenticated;
