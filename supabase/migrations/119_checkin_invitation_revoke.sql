-- 119_checkin_invitation_revoke.sql
-- Security review of 118: keeping the previous invitation link valid after
-- a resend removed the organizer's only way to kill a forwarded or leaked
-- link. Now:
--   * the previous link works for 48 hours after a resend (enough for a
--     resend that did not arrive), then only the latest one does;
--   * checkin_invite_revoke kills every link of a guest at once (their
--     answer is kept); a fresh invitation can be sent afterwards.

CREATE OR REPLACE FUNCTION checkin_web_invite_view(p_code text, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent leod_checkin_entitlements;
  v_i   leod_checkin_web_invites;
  v_a   leod_checkin_attendees;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF v_ent.event_id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  -- The latest link, or the one before it (a resend does not kill a link
  -- the guest already has).
  SELECT * INTO v_i FROM leod_checkin_web_invites
   WHERE (token_hash = p_token_hash OR (prev_token_hash = p_token_hash AND sent_at > now() - interval '48 hours')) AND event_id = v_ent.event_id;
  IF v_i.attendee_id IS NULL THEN RETURN jsonb_build_object('status', 'invalid'); END IF;
  SELECT * INTO v_a FROM leod_checkin_attendees WHERE id = v_i.attendee_id;
  RETURN jsonb_build_object('status', 'ok', 'first_name', v_a.first_name, 'last_name', v_a.last_name, 'rsvp', v_i.rsvp,
    'plus_max', v_ent.registration_plus_ones,
    'plus_ones', (SELECT COALESCE(jsonb_agg(jsonb_build_object('first_name', p.first_name, 'last_name', p.last_name) ORDER BY p.created_at), '[]'::jsonb)
                    FROM leod_checkin_attendees p WHERE p.plus_one_of = v_a.id));
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_invite_view(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_invite_view(text, text) TO service_role;

CREATE OR REPLACE FUNCTION checkin_web_rsvp(p_code text, p_token_hash text, p_going boolean, p_plus_ones jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent  leod_checkin_entitlements;
  v_ev   leod_events;
  v_i    leod_checkin_web_invites;
  v_a    leod_checkin_attendees;
  v_plus jsonb;
  v_keep int;
  v_old  int;
  v_out  jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF v_ent.event_id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_ent.event_id::text, 0));
  SELECT * INTO v_i FROM leod_checkin_web_invites
   WHERE (token_hash = p_token_hash OR (prev_token_hash = p_token_hash AND sent_at > now() - interval '48 hours')) AND event_id = v_ent.event_id FOR UPDATE;
  IF v_i.attendee_id IS NULL THEN RETURN jsonb_build_object('status', 'invalid'); END IF;
  SELECT * INTO v_ev FROM leod_events WHERE id = v_ent.event_id;
  IF v_ev.date IS NOT NULL AND v_ev.timezone IS NOT NULL AND now() >= ((v_ev.date + 3)::timestamp AT TIME ZONE v_ev.timezone) THEN
    RETURN jsonb_build_object('status', 'closed');
  END IF;
  -- (118) The organizer's registration deadline holds for answers too; a
  -- guest can still say they are not coming.
  IF COALESCE(p_going, false) AND v_ent.registration_closes_at IS NOT NULL AND now() >= v_ent.registration_closes_at THEN
    RETURN jsonb_build_object('status', 'closed');
  END IF;
  SELECT * INTO v_a FROM leod_checkin_attendees WHERE id = v_i.attendee_id;

  -- Plus-ones not yet checked in are replaced; any already in stay.
  -- (118) Capacity is checked first, counting the places the replaced
  -- plus-ones free, so a refused answer changes nothing.
  SELECT count(*) FILTER (WHERE checked_in_at IS NOT NULL), count(*) FILTER (WHERE checked_in_at IS NULL)
    INTO v_keep, v_old FROM leod_checkin_attendees WHERE plus_one_of = v_a.id;
  IF COALESCE(p_going, false) THEN
    v_plus := checkin_web_plus_ones(p_plus_ones, GREATEST(0, v_ent.registration_plus_ones - v_keep));
    IF v_ent.registration_capacity IS NOT NULL
       AND checkin_web_places_taken(v_ent.event_id, v_a.is_test) - v_old + jsonb_array_length(v_plus) > v_ent.registration_capacity THEN
      UPDATE leod_checkin_web_invites SET rsvp = 'going', rsvp_at = now() WHERE attendee_id = v_a.id;
      RETURN jsonb_build_object('status', 'no_room_for_plus_ones', 'first_name', v_a.first_name);
    END IF;
  END IF;
  DELETE FROM leod_checkin_attendees WHERE plus_one_of = v_a.id AND checked_in_at IS NULL;
  IF COALESCE(p_going, false) THEN
    v_out := checkin_web_add_plus_ones(v_a, v_plus);
  END IF;
  UPDATE leod_checkin_web_invites SET rsvp = CASE WHEN COALESCE(p_going, false) THEN 'going' ELSE 'not_going' END, rsvp_at = now()
   WHERE attendee_id = v_a.id;
  RETURN jsonb_build_object('status', CASE WHEN COALESCE(p_going, false) THEN 'going' ELSE 'not_going' END, 'first_name', v_a.first_name,
    'attendee', jsonb_build_object('id', v_a.id, 'first_name', v_a.first_name, 'email', v_a.email, 'qr_token', v_a.qr_token,
                                   'qr_email_sent_at', v_a.qr_email_sent_at),
    'plus_ones', v_out);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_rsvp(text, text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_rsvp(text, text, boolean, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION checkin_invite_revoke(p_event_id uuid, p_attendee_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can cancel invitation links' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A random hash nobody holds: every link this guest has stops working.
  UPDATE leod_checkin_web_invites
     SET token_hash = encode(extensions.gen_random_bytes(32), 'hex'), prev_token_hash = NULL
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION checkin_invite_revoke(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_invite_revoke(uuid, uuid) TO authenticated;
