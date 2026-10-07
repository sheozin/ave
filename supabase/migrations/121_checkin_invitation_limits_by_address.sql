-- 121_checkin_invitation_limits_by_address.sql
-- Security review of 120:
--   1. Race: a guest's first invitation had no row to lock, and the event's
--      24-hour count was read without a lock, so sends running side by
--      side could both pass. Issuing now takes a per-event advisory lock.
--   2. Bypass: the per-guest limits followed the guest record; removing
--      and re-adding the guest reset them. The limits now also follow the
--      address (leod_checkin_web_mail.email_key): one invitation every 10
--      minutes and five a day per address per event.

CREATE OR REPLACE FUNCTION checkin_web_invite_issue(p_event_id uuid, p_attendee_id uuid, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
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
                                          sent_at = now(), sent_count = leod_checkin_web_invites.sent_count + 1;
  RETURN jsonb_build_object('status', 'issued', 'first_name', v_a.first_name, 'email', v_a.email);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_invite_issue(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_invite_issue(uuid, uuid, text) TO service_role;
