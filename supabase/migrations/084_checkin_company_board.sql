-- 084_checkin_company_board.sql
-- Company arrival board (event-day spec, feature 4): per company, how
-- many are expected, how many arrived, and when the last one did.
-- Owner, organizer and lead only; desk staff and viewers are refused,
-- because company names are customer data the client view never shows.
-- Spellings that differ only in case or spacing are one company,
-- labelled with the spelling most guests carry. Guests with no company
-- are left out: "no company" is not a company to chase.
CREATE OR REPLACE FUNCTION checkin_company_board(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := checkin_role_for_event(p_event_id);
BEGIN
  IF auth.uid() IS NULL OR NOT (checkin_is_owner(p_event_id) OR COALESCE(v_role IN ('organizer', 'lead'), false)) THEN
    RAISE EXCEPTION 'Only the owner, organizers and desk leads see the company board'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'company', label, 'expected', expected, 'arrived', arrived, 'last_arrival_at', last_at)
             ORDER BY expected - arrived DESC, label), '[]'::jsonb)
      FROM (SELECT mode() WITHIN GROUP (ORDER BY nm) AS label,
                   count(*)::int AS expected,
                   (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int AS arrived,
                   max(checked_in_at) AS last_at
              FROM (SELECT checked_in_at,
                           regexp_replace(btrim(company), '\s+', ' ', 'g') AS nm
                      FROM leod_checkin_attendees
                     WHERE event_id = p_event_id AND NULLIF(btrim(company), '') IS NOT NULL) a
             GROUP BY lower(nm)) c);
END;
$$;
REVOKE ALL ON FUNCTION checkin_company_board(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_company_board(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
