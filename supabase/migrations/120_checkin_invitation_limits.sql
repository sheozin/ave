-- 120_checkin_invitation_limits.sql
-- Security review of checkin-invite-guests: nothing limited how often an
-- invitation could be sent, so Invite again could flood one inbox and an
-- event could send without ceiling. Now, in checkin_web_invite_issue: one
-- invitation per guest every 10 minutes, five per guest in all, and 1,000
-- per event in 24 hours. Invitations are recorded in leod_checkin_web_mail
-- with kind 'invite'; the registration mail caps (101-103) keep counting
-- only kind 'confirm', so invitations do not use up guests' confirmations.

ALTER TABLE leod_checkin_web_mail ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'confirm' CHECK (kind IN ('confirm', 'invite'));
CREATE INDEX IF NOT EXISTS idx_checkin_web_mail_event_kind ON leod_checkin_web_mail (event_id, kind, sent_at);

CREATE OR REPLACE FUNCTION checkin_web_invite_issue(p_event_id uuid, p_attendee_id uuid, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a leod_checkin_attendees;
  v_i leod_checkin_web_invites;
BEGIN
  SELECT * INTO v_a FROM leod_checkin_attendees
   WHERE id = p_attendee_id AND event_id = p_event_id AND source = 'import' AND NOT is_test
     AND email IS NOT NULL AND email <> '';
  IF v_a.id IS NULL THEN RETURN jsonb_build_object('status', 'not_invitable'); END IF;
  -- (120) Limits, so invitations cannot be used to flood an inbox: one
  -- per guest every 10 minutes, five per guest in all, and 1,000 per
  -- event in 24 hours (each recorded in leod_checkin_web_mail).
  SELECT * INTO v_i FROM leod_checkin_web_invites WHERE attendee_id = v_a.id FOR UPDATE;
  IF v_i.attendee_id IS NOT NULL AND v_i.sent_at > now() - interval '10 minutes' THEN RETURN jsonb_build_object('status', 'too_soon'); END IF;
  IF v_i.attendee_id IS NOT NULL AND v_i.sent_count >= 5 THEN RETURN jsonb_build_object('status', 'limit'); END IF;
  IF (SELECT count(*) FROM leod_checkin_web_mail WHERE event_id = p_event_id AND kind = 'invite' AND sent_at > now() - interval '24 hours') >= 1000 THEN
    RETURN jsonb_build_object('status', 'daily_cap');
  END IF;
  INSERT INTO leod_checkin_web_mail (email_key, event_id, kind) VALUES (checkin_web_email_key(v_a.email), p_event_id, 'invite');
  INSERT INTO leod_checkin_web_invites (attendee_id, event_id, token_hash)
  VALUES (v_a.id, p_event_id, p_token_hash)
  ON CONFLICT (attendee_id) DO UPDATE SET prev_token_hash = leod_checkin_web_invites.token_hash, token_hash = EXCLUDED.token_hash,
                                          sent_at = now(), sent_count = leod_checkin_web_invites.sent_count + 1;
  RETURN jsonb_build_object('status', 'issued', 'first_name', v_a.first_name, 'email', v_a.email);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_invite_issue(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_invite_issue(uuid, uuid, text) TO service_role;

-- The registration caps count confirmation emails only (body from 116).
CREATE OR REPLACE FUNCTION checkin_web_request(
  p_code text, p_first_name text, p_last_name text, p_email text, p_company text, p_answers jsonb, p_token_hash text,
  p_ticket_type_id uuid DEFAULT NULL, p_plus_ones jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_test_cap    CONSTANT int      := 25;
  c_resend_gap  CONSTANT interval := interval '10 minutes';
  c_mail_window CONSTANT interval := interval '24 hours';
  c_mail_event  CONSTANT int      := 3;
  c_mail_global CONSTANT int      := 10;
  c_event_hour  CONSTANT int      := 150;
  v_ent  leod_checkin_entitlements;
  v_ev   leod_events;
  v_test boolean;
  v_n    int;
  v_row  leod_checkin_attendees;
  v_pend leod_checkin_web_pending;
  v_key  text := checkin_web_email_key(p_email);
  v_full boolean;
  v_kind text;
  v_type leod_checkin_ticket_types;
  v_paid boolean := false;
  v_plus jsonb;
  v_need int;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements
   WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_ent.event_id::text, 0));

  SELECT * INTO v_ev FROM leod_events WHERE id = v_ent.event_id;
  IF (v_ent.registration_closes_at IS NOT NULL AND now() >= v_ent.registration_closes_at)
     OR (v_ev.date IS NOT NULL AND v_ev.timezone IS NOT NULL
         AND now() >= ((v_ev.date + 3)::timestamp AT TIME ZONE v_ev.timezone)) THEN
    RETURN jsonb_build_object('status', 'closed');
  END IF;

  -- (116) Invite-only: the public form takes no registrations, unless
  -- the organizer approves requests (then every request is held for them).
  IF v_ent.registration_mode = 'invite' AND NOT v_ent.registration_approval THEN
    RETURN jsonb_build_object('status', 'invite_only');
  END IF;

  v_test := v_ent.status IS DISTINCT FROM 'live';

  -- (109) The ticket. Without active types the page has no picker and the
  -- registration is free, as before.
  IF EXISTS (SELECT 1 FROM leod_checkin_ticket_types WHERE event_id = v_ent.event_id AND active) THEN
    SELECT * INTO v_type FROM leod_checkin_ticket_types
     WHERE id = p_ticket_type_id AND event_id = v_ent.event_id AND active;
    IF v_type.id IS NULL THEN RETURN jsonb_build_object('status', 'bad_ticket'); END IF;
    IF checkin_web_ticket_left(v_type.id, v_test) = 0 THEN RETURN jsonb_build_object('status', 'sold_out'); END IF;
    v_paid := v_type.price_cents > 0;
  END IF;

  -- (114) Plus-ones: free registrations only, at most the event's limit.
  v_plus := CASE WHEN v_paid THEN '[]'::jsonb ELSE checkin_web_plus_ones(p_plus_ones, v_ent.registration_plus_ones) END;
  v_need := 1 + jsonb_array_length(v_plus);

  IF v_test THEN
    -- (115) Plus-ones count toward the free test allowance, party and all.
    SELECT count(*) INTO v_n FROM leod_checkin_attendees
     WHERE event_id = v_ent.event_id AND is_test AND source IN ('web', 'plus_one');
    -- (116) Held test guests (waitlist, approval) and their plus-ones count
    -- too: without this the public form could add held rows without end.
    v_n := v_n + COALESCE((SELECT sum(1 + jsonb_array_length(plus_ones)) FROM leod_checkin_held
                            WHERE event_id = v_ent.event_id AND is_test), 0);
    IF v_n + v_need > c_test_cap THEN RETURN jsonb_build_object('status', 'test_cap'); END IF;
    -- Capacity before the duplicate check, so 'full' is the same for every address (F4).
    v_full := false;
    IF v_ent.registration_capacity IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND is_test;
      v_full := v_n + v_need > v_ent.registration_capacity;
      IF v_full AND (NOT v_ent.registration_waitlist OR v_paid) THEN RETURN jsonb_build_object('status', 'full'); END IF;
    END IF;
    -- (108) Full with a waitlist, or approval required: the guest is held,
    -- and a listed or already held address gets the same answer (F4 again).
    IF NOT v_paid AND (v_full OR v_ent.registration_approval) THEN
      v_kind := CASE WHEN v_full THEN 'waitlist' ELSE 'approval' END;
      IF NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email)))
         AND NOT EXISTS (SELECT 1 FROM leod_checkin_held WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email))) THEN
        INSERT INTO leod_checkin_held (event_id, kind, first_name, last_name, email, company, answers, is_test, consent_at, ticket_type_id, plus_ones)
        VALUES (v_ent.event_id, v_kind, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
                COALESCE(p_answers, '{}'::jsonb), true, now(), v_type.id, v_plus)
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN jsonb_build_object('status', CASE WHEN v_kind = 'waitlist' THEN 'waitlisted' ELSE 'awaiting_approval' END, 'test', true);
    END IF;
    IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email))) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'test', true);
    END IF;
    BEGIN
      INSERT INTO leod_checkin_attendees
        (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields, ticket_type_id, ticket_type)
      VALUES
        (v_ent.event_id, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
         replace(gen_random_uuid()::text, '-', ''), 'web', true, now(), COALESCE(p_answers, '{}'::jsonb), v_type.id, COALESCE(v_type.name, 'attendee'))
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('status', 'duplicate', 'test', true);
    END;
    PERFORM checkin_web_add_plus_ones(v_row, v_plus);
    RETURN jsonb_build_object('status', 'registered', 'test', true);
  END IF;

  -- (108) With a waitlist a full event still takes requests: the guest is
  -- waitlisted when they confirm. (109) Not for a paid ticket.
  IF v_ent.registration_capacity IS NOT NULL AND (NOT v_ent.registration_waitlist OR v_paid) THEN
    IF checkin_web_places_taken(v_ent.event_id, false) + v_need > v_ent.registration_capacity THEN
      RETURN jsonb_build_object('status', 'full');
    END IF;
  END IF;

  SELECT * INTO v_pend FROM leod_checkin_web_pending
   WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email));
  IF FOUND AND v_pend.last_sent_at > now() - c_resend_gap THEN
    RETURN jsonb_build_object('status', 'pending', 'send', false);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_mail:' || v_key, 0));
  -- (120) Confirmation emails only: invitations have their own limits.
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail
   WHERE email_key = v_key AND event_id = v_ent.event_id AND kind = 'confirm' AND sent_at > now() - c_mail_window;
  IF v_n >= c_mail_event THEN RETURN jsonb_build_object('status', 'pending', 'send', false); END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail WHERE email_key = v_key AND kind = 'confirm' AND sent_at > now() - c_mail_window;
  IF v_n >= c_mail_global THEN RETURN jsonb_build_object('status', 'pending', 'send', false); END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail WHERE event_id = v_ent.event_id AND kind = 'confirm' AND sent_at > now() - interval '1 hour';
  IF v_n >= c_event_hour THEN
    INSERT INTO leod_checkin_web_trips (event_id) VALUES (v_ent.event_id);
    RETURN jsonb_build_object('status', 'pending', 'send', false);
  END IF;

  IF v_pend.id IS NOT NULL THEN
    UPDATE leod_checkin_web_pending
       SET prev_token_hash = token_hash, token_hash = p_token_hash, last_sent_at = now()
     WHERE id = v_pend.id;
  ELSE
    INSERT INTO leod_checkin_web_pending (event_id, first_name, last_name, email, company, answers, token_hash, ticket_type_id, plus_ones)
    VALUES (v_ent.event_id, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
            COALESCE(p_answers, '{}'::jsonb), p_token_hash, v_type.id, v_plus);
  END IF;
  INSERT INTO leod_checkin_web_mail (email_key, event_id) VALUES (v_key, v_ent.event_id);
  RETURN jsonb_build_object('status', 'pending', 'send', true, 'event_id', v_ent.event_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_request(text, text, text, text, text, jsonb, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_request(text, text, text, text, text, jsonb, text, uuid, jsonb) TO service_role;
