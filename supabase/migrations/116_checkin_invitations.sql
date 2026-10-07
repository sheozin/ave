-- 116_checkin_invitations.sql
-- Invite-only events and personal invitations. Also (security review of
-- 115): held test guests and their plus-ones count toward the 25 free test
-- registrations, which before counted only guests on the list.
--
--   registration_mode 'open'    anyone with the link registers (as before)
--                     'invite'  the public form takes no registrations; with
--                               approval on it takes requests, all held
--
-- An invitation goes to a guest already on the list (the organizer's own,
-- source 'import'), from checkin-invite-guests, with a personal link
-- /r/<code>#i=<token>. The token's hash is in leod_checkin_web_invites;
-- sending again replaces it, so only the latest link works. On their page
-- the guest answers going or not going and names their plus-ones (up to
-- the event's limit, 114). Going sends the QR tickets; not going removes
-- their plus-ones. The guest stays on the list either way: the answer is
-- information for the organizer, the desk can still check them in.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS registration_mode text NOT NULL DEFAULT 'open' CHECK (registration_mode IN ('open', 'invite'));

CREATE TABLE IF NOT EXISTS leod_checkin_web_invites (
  attendee_id uuid        PRIMARY KEY REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  event_id    uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  sent_count  int         NOT NULL DEFAULT 1,
  rsvp        text        CHECK (rsvp IN ('going', 'not_going')),
  rsvp_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_checkin_web_invites_event ON leod_checkin_web_invites (event_id, rsvp);
ALTER TABLE leod_checkin_web_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_web_invites FROM anon, authenticated;

-- ── Organizer: mode ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_set_registration_mode(p_event_id uuid, p_mode text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change registration' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('open', 'invite') THEN
    RAISE EXCEPTION 'Unknown registration mode' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE leod_checkin_entitlements SET registration_mode = p_mode WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN p_mode;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_registration_mode(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_registration_mode(uuid, text) TO authenticated;

-- ── Organizer: who was invited and what they answered ─────────────
CREATE OR REPLACE FUNCTION checkin_invite_status(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see invitations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT COALESCE(jsonb_object_agg(i.attendee_id, jsonb_build_object('sent_at', i.sent_at, 'rsvp', i.rsvp, 'rsvp_at', i.rsvp_at)), '{}'::jsonb)
            FROM leod_checkin_web_invites i WHERE i.event_id = p_event_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_invite_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_invite_status(uuid) TO authenticated;

-- ── Service: issue an invitation (checkin-invite-guests) ──────────
-- Only the organizer's own guests with an email: never a plus-one or a
-- self-registration (they already registered).
CREATE OR REPLACE FUNCTION checkin_web_invite_issue(p_event_id uuid, p_attendee_id uuid, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a leod_checkin_attendees;
BEGIN
  SELECT * INTO v_a FROM leod_checkin_attendees
   WHERE id = p_attendee_id AND event_id = p_event_id AND source = 'import' AND NOT is_test
     AND email IS NOT NULL AND email <> '';
  IF v_a.id IS NULL THEN RETURN jsonb_build_object('status', 'not_invitable'); END IF;
  INSERT INTO leod_checkin_web_invites (attendee_id, event_id, token_hash)
  VALUES (v_a.id, p_event_id, p_token_hash)
  ON CONFLICT (attendee_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, sent_at = now(),
                                          sent_count = leod_checkin_web_invites.sent_count + 1;
  RETURN jsonb_build_object('status', 'issued', 'first_name', v_a.first_name, 'email', v_a.email);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_invite_issue(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_invite_issue(uuid, uuid, text) TO service_role;

-- A failed send takes the invitation back (only one that was never answered).
CREATE OR REPLACE FUNCTION checkin_web_invite_unissue(p_attendee_id uuid, p_token_hash text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM leod_checkin_web_invites WHERE attendee_id = p_attendee_id AND token_hash = p_token_hash AND rsvp IS NULL AND sent_count = 1;
$$;
REVOKE ALL ON FUNCTION checkin_web_invite_unissue(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_invite_unissue(uuid, text) TO service_role;

-- ── Service: the guest's page ─────────────────────────────────────
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
  SELECT * INTO v_i FROM leod_checkin_web_invites WHERE token_hash = p_token_hash AND event_id = v_ent.event_id;
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

-- The answer. Going replaces the plus-ones (those not yet checked in) with
-- the ones named now, if there are places for them; not going removes them.
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
  v_out  jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF v_ent.event_id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_ent.event_id::text, 0));
  SELECT * INTO v_i FROM leod_checkin_web_invites WHERE token_hash = p_token_hash AND event_id = v_ent.event_id FOR UPDATE;
  IF v_i.attendee_id IS NULL THEN RETURN jsonb_build_object('status', 'invalid'); END IF;
  SELECT * INTO v_ev FROM leod_events WHERE id = v_ent.event_id;
  IF v_ev.date IS NOT NULL AND v_ev.timezone IS NOT NULL AND now() >= ((v_ev.date + 3)::timestamp AT TIME ZONE v_ev.timezone) THEN
    RETURN jsonb_build_object('status', 'closed');
  END IF;
  SELECT * INTO v_a FROM leod_checkin_attendees WHERE id = v_i.attendee_id;

  -- Plus-ones not yet checked in are replaced; any already in stay.
  DELETE FROM leod_checkin_attendees WHERE plus_one_of = v_a.id AND checked_in_at IS NULL;
  SELECT count(*) INTO v_keep FROM leod_checkin_attendees WHERE plus_one_of = v_a.id;
  IF COALESCE(p_going, false) THEN
    v_plus := checkin_web_plus_ones(p_plus_ones, GREATEST(0, v_ent.registration_plus_ones - v_keep));
    IF v_ent.registration_capacity IS NOT NULL AND jsonb_array_length(v_plus) > 0
       AND checkin_web_places_taken(v_ent.event_id, v_a.is_test) + jsonb_array_length(v_plus) > v_ent.registration_capacity THEN
      UPDATE leod_checkin_web_invites SET rsvp = 'going', rsvp_at = now() WHERE attendee_id = v_a.id;
      RETURN jsonb_build_object('status', 'no_room_for_plus_ones', 'first_name', v_a.first_name);
    END IF;
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

-- ── Submit and confirm, invite-only aware (bodies from 115) ────────
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
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail
   WHERE email_key = v_key AND event_id = v_ent.event_id AND sent_at > now() - c_mail_window;
  IF v_n >= c_mail_event THEN RETURN jsonb_build_object('status', 'pending', 'send', false); END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail WHERE email_key = v_key AND sent_at > now() - c_mail_window;
  IF v_n >= c_mail_global THEN RETURN jsonb_build_object('status', 'pending', 'send', false); END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail WHERE event_id = v_ent.event_id AND sent_at > now() - interval '1 hour';
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

CREATE OR REPLACE FUNCTION checkin_web_confirm(p_code text, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent   leod_checkin_entitlements;
  v_ev    leod_events;
  v_pend  leod_checkin_web_pending;
  v_row   leod_checkin_attendees;
  v_n     int;
  v_full  boolean;
  v_held  leod_checkin_held;
  v_type  leod_checkin_ticket_types;
  v_acct  text;
  v_order leod_checkin_web_orders;
  v_fee   int;
  v_need  int;
  v_plus  jsonb;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements
   WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_ent.event_id::text, 0));

  SELECT * INTO v_pend FROM checkin_web_pending_by_token(p_code, p_token_hash);
  IF v_pend.id IS NULL THEN
    -- (109) The link of a request that is already an order.
    SELECT * INTO v_order FROM leod_checkin_web_orders
     WHERE event_id = v_ent.event_id AND p_token_hash = ANY (token_hashes)
     ORDER BY created_at DESC LIMIT 1;
    IF v_order.id IS NOT NULL THEN RETURN jsonb_build_object('status', 'order', 'order_id', v_order.id); END IF;
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT * INTO v_ev FROM leod_events WHERE id = v_ent.event_id;
  IF (v_ent.registration_closes_at IS NOT NULL AND now() >= v_ent.registration_closes_at)
     OR (v_ev.date IS NOT NULL AND v_ev.timezone IS NOT NULL
         AND now() >= ((v_ev.date + 3)::timestamp AT TIME ZONE v_ev.timezone)) THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'closed');
  END IF;

  -- (116) Invite-only: the public form takes no registrations, unless
  -- the organizer approves requests (then every request is held for them).
  IF v_ent.registration_mode = 'invite' AND NOT v_ent.registration_approval THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'invite_only');
  END IF;

  SELECT * INTO v_row FROM leod_checkin_attendees
   WHERE event_id = v_ent.event_id AND lower(email) = lower(v_pend.email);
  IF FOUND THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'already', 'first_name', v_row.first_name,
      'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                     'qr_token', v_row.qr_token, 'qr_email_sent_at', v_row.qr_email_sent_at));
  END IF;

  SELECT * INTO v_held FROM leod_checkin_held WHERE event_id = v_ent.event_id AND lower(email) = lower(v_pend.email);
  IF v_held.id IS NOT NULL THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', CASE WHEN v_held.kind = 'waitlist' THEN 'waitlisted' ELSE 'awaiting_approval' END,
                              'first_name', v_held.first_name);
  END IF;

  -- (109) A request made before the event sold tickets: tickets now exist,
  -- so it must go through the form again and pick one.
  IF v_pend.ticket_type_id IS NULL
     AND EXISTS (SELECT 1 FROM leod_checkin_ticket_types WHERE event_id = v_ent.event_id AND active) THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'bad_ticket');
  END IF;
  -- (109) The ticket picked at submit time. A type hidden or removed since
  -- is refused, so nobody is charged for, or given, a ticket no longer sold.
  IF v_pend.ticket_type_id IS NOT NULL THEN
    SELECT * INTO v_type FROM leod_checkin_ticket_types
     WHERE id = v_pend.ticket_type_id AND event_id = v_ent.event_id AND active;
    IF v_type.id IS NULL THEN
      DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
      RETURN jsonb_build_object('status', 'bad_ticket');
    END IF;
    IF checkin_web_ticket_left(v_type.id, false) = 0 THEN
      DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
      RETURN jsonb_build_object('status', 'sold_out');
    END IF;
  END IF;

  IF v_type.price_cents > 0 THEN
    IF v_ent.registration_capacity IS NOT NULL
       AND checkin_web_places_taken(v_ent.event_id, false) >= v_ent.registration_capacity THEN
      -- An order of this same address already holds a place: reuse it below.
      IF NOT EXISTS (SELECT 1 FROM leod_checkin_web_orders WHERE event_id = v_ent.event_id
                      AND lower(email) = lower(v_pend.email) AND status = 'open' AND expires_at > now()) THEN
        DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
        RETURN jsonb_build_object('status', 'full');
      END IF;
    END IF;
    SELECT stripe_account_id INTO v_acct FROM leod_checkin_payout_accounts
     WHERE user_id = v_ev.created_by AND charges_enabled;
    -- The pending row stays, so the same link works once payouts are back.
    IF v_acct IS NULL THEN RETURN jsonb_build_object('status', 'payments_unavailable'); END IF;

    SELECT * INTO v_order FROM leod_checkin_web_orders
     WHERE event_id = v_ent.event_id AND lower(email) = lower(v_pend.email) AND status = 'open';
    IF v_order.id IS NOT NULL THEN
      -- One open order per address: this link joins it.
      UPDATE leod_checkin_web_orders
         SET token_hashes = (SELECT array_agg(DISTINCT h) FROM unnest(token_hashes || ARRAY[v_pend.token_hash, p_token_hash]) h)
       WHERE id = v_order.id;
    ELSE
      SELECT (v_type.price_cents::bigint * fee_bps / 10000)::int INTO v_fee FROM leod_checkin_ticket_fee WHERE id;
      INSERT INTO leod_checkin_web_orders
        (event_id, ticket_type_id, ticket_name, token_hashes, first_name, last_name, email, company, answers,
         amount_cents, currency, fee_cents, stripe_account_id, expires_at)
      VALUES
        (v_ent.event_id, v_type.id, v_type.name,
         ARRAY(SELECT DISTINCT h FROM unnest(ARRAY[v_pend.token_hash, v_pend.prev_token_hash, p_token_hash]) h WHERE h IS NOT NULL),
         v_pend.first_name, v_pend.last_name, v_pend.email, v_pend.company, v_pend.answers,
         v_type.price_cents, v_type.currency, COALESCE(v_fee, 0), v_acct, now() + interval '35 minutes')
      RETURNING * INTO v_order;
    END IF;
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'payment_required', 'order_id', v_order.id, 'first_name', v_pend.first_name);
  END IF;

  -- (114) The guest and their plus-ones need places together.
  -- (115) The event's limit now, not when the request was made.
  v_plus := checkin_web_plus_ones(COALESCE(v_pend.plus_ones, '[]'::jsonb), v_ent.registration_plus_ones);
  v_need := 1 + jsonb_array_length(v_plus);
  v_full := false;
  IF v_ent.registration_capacity IS NOT NULL THEN
    v_full := checkin_web_places_taken(v_ent.event_id, false) + v_need > v_ent.registration_capacity;
    IF v_full AND NOT v_ent.registration_waitlist THEN
      DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
      RETURN jsonb_build_object('status', 'full');
    END IF;
  END IF;

  IF v_full OR v_ent.registration_approval THEN
    INSERT INTO leod_checkin_held (event_id, kind, first_name, last_name, email, company, answers, is_test, consent_at, ticket_type_id, plus_ones)
    VALUES (v_ent.event_id, CASE WHEN v_full THEN 'waitlist' ELSE 'approval' END, v_pend.first_name, v_pend.last_name,
            v_pend.email, v_pend.company, v_pend.answers, false, now(), v_type.id, v_plus)
    ON CONFLICT DO NOTHING;
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    IF v_full THEN
      SELECT count(*) INTO v_n FROM leod_checkin_held WHERE event_id = v_ent.event_id AND kind = 'waitlist' AND NOT is_test;
      RETURN jsonb_build_object('status', 'waitlisted', 'first_name', v_pend.first_name, 'position', v_n);
    END IF;
    RETURN jsonb_build_object('status', 'awaiting_approval', 'first_name', v_pend.first_name);
  END IF;

  BEGIN
    INSERT INTO leod_checkin_attendees
      (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields, ticket_type_id, ticket_type)
    VALUES
      (v_ent.event_id, v_pend.first_name, v_pend.last_name, v_pend.email, v_pend.company,
       replace(gen_random_uuid()::text, '-', ''), 'web', false, now(), v_pend.answers, v_type.id, COALESCE(v_type.name, 'attendee'))
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'already', 'first_name', v_pend.first_name, 'attendee', NULL);
  END;
  DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
  v_plus := checkin_web_add_plus_ones(v_row, v_plus);
  RETURN jsonb_build_object('status', 'registered', 'first_name', v_row.first_name,
    'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                   'qr_token', v_row.qr_token, 'qr_email_sent_at', NULL),
    'plus_ones', v_plus);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_confirm(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_confirm(text, text) TO service_role;
