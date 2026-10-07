-- 117_checkin_plus_one_ticket_type.sql
-- Security review of 116: plus-ones took their guest's ticket type. A
-- guest on a VIP or Speaker ticket could name plus-ones who then carried
-- that label (badges, the desk's VIP arrival alerts, the company board),
-- and on a limited ticket type plus-ones used up its quantity without
-- being checked against it. A plus-one is now ticket type 'Guest' with no
-- ticket_type_id: they count toward the event's capacity, never toward a
-- ticket type, and never borrow a label.

CREATE OR REPLACE FUNCTION checkin_web_add_plus_ones(p_host leod_checkin_attendees, p_plus jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_p   jsonb;
  v_row leod_checkin_attendees;
BEGIN
  FOR v_p IN SELECT * FROM jsonb_array_elements(COALESCE(p_plus, '[]'::jsonb)) LOOP
    INSERT INTO leod_checkin_attendees
      (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields,
       ticket_type_id, ticket_type, plus_one_of)
    VALUES
      (p_host.event_id, v_p->>'first_name', v_p->>'last_name', NULL, p_host.company,
       replace(gen_random_uuid()::text, '-', ''), 'plus_one', p_host.is_test, NULL, '{}'::jsonb,
       NULL, 'Guest', p_host.id)
    RETURNING * INTO v_row;
    v_out := v_out || jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'last_name', v_row.last_name,
                                         'qr_token', v_row.qr_token);
  END LOOP;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_add_plus_ones(leod_checkin_attendees, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_add_plus_ones(leod_checkin_attendees, jsonb) TO service_role;

-- Plus-ones already added keep their place, without the borrowed label.
UPDATE leod_checkin_attendees SET ticket_type = 'Guest', ticket_type_id = NULL
 WHERE source = 'plus_one' AND (ticket_type IS DISTINCT FROM 'Guest' OR ticket_type_id IS NOT NULL);
