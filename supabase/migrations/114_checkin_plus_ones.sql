-- 114_checkin_plus_ones.sql
-- Plus-ones on the registration page: the organizer allows each guest to
-- bring up to N people (0 to 5, registration_plus_ones). A plus-one is a
-- guest of their own (source 'plus_one', plus_one_of = the guest who
-- brought them, no email) with their own QR code, which is emailed to the
-- guest who brought them. Plus-ones need places together with their guest
-- (capacity, waitlist), come along through approval and the waitlist, and
-- leave with their guest (ON DELETE CASCADE). Paid tickets take no
-- plus-ones: each person buys their own.
--
-- 'plus_one' is a self-asserted name, so it never counts for the speaker
-- arrival link (113 trusts only 'import' and 'walk_in').

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS registration_plus_ones int NOT NULL DEFAULT 0 CHECK (registration_plus_ones BETWEEN 0 AND 5);
ALTER TABLE leod_checkin_attendees
  ADD COLUMN IF NOT EXISTS plus_one_of uuid REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_checkin_attendees_plus_one_of ON leod_checkin_attendees (plus_one_of) WHERE plus_one_of IS NOT NULL;
ALTER TABLE leod_checkin_attendees DROP CONSTRAINT IF EXISTS leod_checkin_attendees_source_check;
ALTER TABLE leod_checkin_attendees ADD CONSTRAINT leod_checkin_attendees_source_check
  CHECK (source = ANY (ARRAY['import', 'kiosk', 'walk_in', 'web', 'plus_one']));
ALTER TABLE leod_checkin_web_pending ADD COLUMN IF NOT EXISTS plus_ones jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE leod_checkin_held ADD COLUMN IF NOT EXISTS plus_ones jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The plus-ones as stored: at most p_max objects of a trimmed first and
-- last name each, 1 to 80 characters. The Edge Function validates the
-- names (letters, no links) first; this is the shape and the limit.
CREATE OR REPLACE FUNCTION checkin_web_plus_ones(p jsonb, p_max int)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('first_name', f, 'last_name', l) ORDER BY i)
    FROM (SELECT i, btrim(e->>'first_name') AS f, btrim(e->>'last_name') AS l
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) WITH ORDINALITY x(e, i)) r
   WHERE char_length(f) BETWEEN 1 AND 80 AND char_length(l) BETWEEN 1 AND 80 AND i <= GREATEST(0, COALESCE(p_max, 0))), '[]'::jsonb);
$$;
REVOKE ALL ON FUNCTION checkin_web_plus_ones(jsonb, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_plus_ones(jsonb, int) TO service_role;

-- Adds a guest's plus-ones and returns them as the senders need them.
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
       replace(gen_random_uuid()::text, '-', ''), 'plus_one', p_host.is_test, p_host.consent_at, '{}'::jsonb,
       p_host.ticket_type_id, p_host.ticket_type, p_host.id)
    RETURNING * INTO v_row;
    v_out := v_out || jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'last_name', v_row.last_name,
                                         'qr_token', v_row.qr_token);
  END LOOP;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_add_plus_ones(leod_checkin_attendees, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_add_plus_ones(leod_checkin_attendees, jsonb) TO service_role;

-- ── Organizer: how many each guest may bring ──────────────────────
CREATE OR REPLACE FUNCTION checkin_set_plus_ones(p_event_id uuid, p_n int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change registration' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_n IS NULL OR p_n NOT BETWEEN 0 AND 5 THEN
    RAISE EXCEPTION 'Plus-ones must be between 0 and 5' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE leod_checkin_entitlements SET registration_plus_ones = p_n WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN p_n;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_plus_ones(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_plus_ones(uuid, int) TO authenticated;

-- ── Submit, confirm and release, with plus-ones (bodies from 109) ──
DROP FUNCTION IF EXISTS checkin_web_request(text, text, text, text, text, jsonb, text, uuid);
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
    SELECT count(*) INTO v_n FROM leod_checkin_attendees
     WHERE event_id = v_ent.event_id AND is_test AND source = 'web';
    IF v_n >= c_test_cap THEN RETURN jsonb_build_object('status', 'test_cap'); END IF;
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
  v_need := 1 + jsonb_array_length(COALESCE(v_pend.plus_ones, '[]'::jsonb));
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
            v_pend.email, v_pend.company, v_pend.answers, false, now(), v_type.id, COALESCE(v_pend.plus_ones, '[]'::jsonb))
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
  v_plus := checkin_web_add_plus_ones(v_row, COALESCE(v_pend.plus_ones, '[]'::jsonb));
  RETURN jsonb_build_object('status', 'registered', 'first_name', v_row.first_name,
    'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                   'qr_token', v_row.qr_token, 'qr_email_sent_at', NULL),
    'plus_ones', v_plus);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_confirm(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_confirm(text, text) TO service_role;

CREATE OR REPLACE FUNCTION checkin_web_release_held(p_event_id uuid, p_held_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h    leod_checkin_held;
  v_row  leod_checkin_attendees;
  v_name text;
  v_plus jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || p_event_id::text, 0));
  DELETE FROM leod_checkin_held WHERE id = p_held_id AND event_id = p_event_id RETURNING * INTO v_h;
  IF v_h.id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT name INTO v_name FROM leod_checkin_ticket_types WHERE id = v_h.ticket_type_id;
  BEGIN
    INSERT INTO leod_checkin_attendees
      (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields, ticket_type_id, ticket_type)
    VALUES
      (p_event_id, v_h.first_name, v_h.last_name, v_h.email, v_h.company,
       replace(gen_random_uuid()::text, '-', ''), 'web', v_h.is_test, v_h.consent_at, v_h.answers,
       CASE WHEN v_name IS NULL THEN NULL ELSE v_h.ticket_type_id END, COALESCE(v_name, 'attendee'))
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'already');
  END;
  v_plus := checkin_web_add_plus_ones(v_row, COALESCE(v_h.plus_ones, '[]'::jsonb));
  RETURN jsonb_build_object('status', 'released', 'kind', v_h.kind, 'is_test', v_row.is_test,
    'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                   'qr_token', v_row.qr_token, 'qr_email_sent_at', NULL),
    'plus_ones', v_plus);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_release_held(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_release_held(uuid, uuid) TO service_role;
