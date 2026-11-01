-- 149_checkin_guest_invite_status.sql
-- Guest invitations show their whole state (Event admin > Guests): when an
-- invitation went out, how many times, when the guest answered, and that
-- the link was cancelled. Cancelling (119) rotated the token but left no
-- trace, so a cancelled guest still read "Invited".
--   revoked_at        set by checkin_invite_revoke; cleared when a new
--                     invitation is issued (the new link works again)
--   checkin_invite_status  now also returns sent_count and revoked_at
ALTER TABLE leod_checkin_web_invites ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

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
     SET token_hash = encode(extensions.gen_random_bytes(32), 'hex'), prev_token_hash = NULL, revoked_at = now()
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION checkin_invite_revoke(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_invite_revoke(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION checkin_invite_status(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see invitations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT COALESCE(jsonb_object_agg(i.attendee_id, jsonb_build_object(
            'sent_at', i.sent_at, 'sent_count', i.sent_count, 'rsvp', i.rsvp, 'rsvp_at', i.rsvp_at, 'revoked_at', i.revoked_at)), '{}'::jsonb)
            FROM leod_checkin_web_invites i WHERE i.event_id = p_event_id);
END;
$$;

-- Issuing a new invitation makes the link work again: clear revoked_at.
-- Otherwise exactly the live function (120/121).
CREATE OR REPLACE FUNCTION public.checkin_web_invite_issue(p_event_id uuid, p_attendee_id uuid, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_a leod_checkin_attendees;
  v_i leod_checkin_web_invites;
  v_key text;
BEGIN
  SELECT * INTO v_a FROM leod_checkin_attendees
   WHERE id = p_attendee_id AND event_id = p_event_id AND source = 'import' AND NOT is_test
     AND email IS NOT NULL AND email <> '';
  IF v_a.id IS NULL THEN RETURN jsonb_build_object('status', 'not_invitable'); END IF;
  -- (121) One event's invitations are issued one at a time, so the counts
  -- below cannot be passed by sends running side by side.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_invite:' || p_event_id::text, 0));
  v_key := checkin_web_email_key(v_a.email);
  -- (121) Per address, from the mail log: removing and re-adding a guest
  -- gives them a new record but not a fresh allowance.
  IF EXISTS (SELECT 1 FROM leod_checkin_web_mail WHERE email_key = v_key AND event_id = p_event_id AND kind = 'invite'
              AND sent_at > now() - interval '10 minutes') THEN
    RETURN jsonb_build_object('status', 'too_soon');
  END IF;
  IF (SELECT count(*) FROM leod_checkin_web_mail WHERE email_key = v_key AND event_id = p_event_id AND kind = 'invite'
       AND sent_at > now() - interval '24 hours') >= 5 THEN
    RETURN jsonb_build_object('status', 'limit');
  END IF;
  -- (120) Limits, so invitations cannot be used to flood an inbox: one
  -- per guest every 10 minutes, five per guest in all, and 1,000 per
  -- event in 24 hours (each recorded in leod_checkin_web_mail).
  SELECT * INTO v_i FROM leod_checkin_web_invites WHERE attendee_id = v_a.id FOR UPDATE;
  IF v_i.attendee_id IS NOT NULL AND v_i.sent_at > now() - interval '10 minutes' THEN RETURN jsonb_build_object('status', 'too_soon'); END IF;
  IF v_i.attendee_id IS NOT NULL AND v_i.sent_count >= 5 THEN RETURN jsonb_build_object('status', 'limit'); END IF;
  IF (SELECT count(*) FROM leod_checkin_web_mail WHERE event_id = p_event_id AND kind = 'invite' AND sent_at > now() - interval '24 hours') >= 1000 THEN
    RETURN jsonb_build_object('status', 'daily_cap');
  END IF;
  INSERT INTO leod_checkin_web_mail (email_key, event_id, kind) VALUES (v_key, p_event_id, 'invite');
  INSERT INTO leod_checkin_web_invites (attendee_id, event_id, token_hash)
  VALUES (v_a.id, p_event_id, p_token_hash)
  ON CONFLICT (attendee_id) DO UPDATE SET prev_token_hash = leod_checkin_web_invites.token_hash, token_hash = EXCLUDED.token_hash,
                                          sent_at = now(), sent_count = leod_checkin_web_invites.sent_count + 1, revoked_at = NULL;
  RETURN jsonb_build_object('status', 'issued', 'first_name', v_a.first_name, 'email', v_a.email);
END;
$function$;
