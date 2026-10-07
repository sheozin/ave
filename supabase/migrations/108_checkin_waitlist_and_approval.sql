-- 108_checkin_waitlist_and_approval.sql
-- Registration page: a waitlist when the event is full, and optional
-- approval of each registration. Both keep the double opt-in (101): a live
-- guest is held only after confirming their email, and every live answer
-- before that stays "check your email".
--
--   held kind 'waitlist'  the event was full when they confirmed
--   held kind 'approval'  the organizer approves each registration
--
-- The organizer releases a held guest from the Event admin (Registration):
-- the checkin-held Edge Function checks their role, calls
-- checkin_web_release_held (service role) and sends the QR email.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS registration_waitlist boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registration_approval boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS leod_checkin_held (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  kind       text        NOT NULL CHECK (kind IN ('waitlist', 'approval')),
  first_name text        NOT NULL,
  last_name  text        NOT NULL,
  email      text        NOT NULL,
  company    text,
  answers    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_test    boolean     NOT NULL DEFAULT false,
  consent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_held_email ON leod_checkin_held (event_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_checkin_held_queue ON leod_checkin_held (event_id, kind, created_at);
ALTER TABLE leod_checkin_held ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_held FROM anon, authenticated;

-- Going live clears test rows everywhere; held test rows go with them.
CREATE OR REPLACE FUNCTION checkin_held_clear_test()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'live' AND OLD.status IS DISTINCT FROM 'live' THEN
    DELETE FROM leod_checkin_held WHERE event_id = NEW.event_id AND is_test;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION checkin_held_clear_test() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_checkin_held_clear_test ON leod_checkin_entitlements;
CREATE TRIGGER trg_checkin_held_clear_test AFTER UPDATE OF status ON leod_checkin_entitlements
  FOR EACH ROW EXECUTE FUNCTION checkin_held_clear_test();

-- ── Organizer: the two switches ───────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_set_registration_flow(p_event_id uuid, p_waitlist boolean, p_approval boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row leod_checkin_entitlements;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change registration' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE leod_checkin_entitlements
     SET registration_waitlist = COALESCE(p_waitlist, false), registration_approval = COALESCE(p_approval, false)
   WHERE event_id = p_event_id RETURNING * INTO v_row;
  IF v_row.event_id IS NULL THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('waitlist', v_row.registration_waitlist, 'approval', v_row.registration_approval);
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_registration_flow(uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_registration_flow(uuid, boolean, boolean) TO authenticated;

-- ── Organizer: who is held ────────────────────────────────────────
-- Once live, test rows are hidden (go-live deletes them; this is the
-- defensive copy, as checkin_recent_alerts does).
CREATE OR REPLACE FUNCTION checkin_held_list(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live boolean;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see held registrations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status = 'live' INTO v_live FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', h.id, 'kind', h.kind, 'first_name', h.first_name, 'last_name', h.last_name, 'email', h.email,
            'company', h.company, 'answers', h.answers, 'is_test', h.is_test, 'created_at', h.created_at)
            ORDER BY h.kind DESC, h.created_at), '[]'::jsonb)
            FROM leod_checkin_held h
           WHERE h.event_id = p_event_id AND NOT (COALESCE(v_live, false) AND h.is_test));
END;
$$;
REVOKE ALL ON FUNCTION checkin_held_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_held_list(uuid) TO authenticated;

-- ── Organizer: turn a held guest away ─────────────────────────────
CREATE OR REPLACE FUNCTION checkin_held_remove(p_event_id uuid, p_held_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change held registrations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM leod_checkin_held WHERE id = p_held_id AND event_id = p_event_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION checkin_held_remove(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_held_remove(uuid, uuid) TO authenticated;

-- ── Service: release a held guest onto the guest list ─────────────
-- Called by checkin-held after it has checked the caller. The organizer
-- decides, so capacity does not block a release (raising it is their call).
CREATE OR REPLACE FUNCTION checkin_web_release_held(p_event_id uuid, p_held_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h   leod_checkin_held;
  v_row leod_checkin_attendees;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || p_event_id::text, 0));
  DELETE FROM leod_checkin_held WHERE id = p_held_id AND event_id = p_event_id RETURNING * INTO v_h;
  IF v_h.id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  BEGIN
    INSERT INTO leod_checkin_attendees
      (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields)
    VALUES
      (p_event_id, v_h.first_name, v_h.last_name, v_h.email, v_h.company,
       replace(gen_random_uuid()::text, '-', ''), 'web', v_h.is_test, v_h.consent_at, v_h.answers)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'already');
  END;
  RETURN jsonb_build_object('status', 'released', 'kind', v_h.kind, 'is_test', v_row.is_test,
    'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                   'qr_token', v_row.qr_token, 'qr_email_sent_at', NULL));
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_release_held(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_release_held(uuid, uuid) TO service_role;

-- ── Submit and confirm, with waitlist and approval ────────────────
CREATE OR REPLACE FUNCTION checkin_web_request(
  p_code text, p_first_name text, p_last_name text, p_email text, p_company text, p_answers jsonb, p_token_hash text)
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

  IF v_test THEN
    SELECT count(*) INTO v_n FROM leod_checkin_attendees
     WHERE event_id = v_ent.event_id AND is_test AND source = 'web';
    IF v_n >= c_test_cap THEN RETURN jsonb_build_object('status', 'test_cap'); END IF;
    -- Capacity before the duplicate check, so 'full' is the same for every address (F4).
    v_full := false;
    IF v_ent.registration_capacity IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND is_test;
      v_full := v_n >= v_ent.registration_capacity;
      IF v_full AND NOT v_ent.registration_waitlist THEN RETURN jsonb_build_object('status', 'full'); END IF;
    END IF;
    -- (108) Full with a waitlist, or approval required: the guest is held,
    -- and a listed or already held address gets the same answer (F4 again).
    IF v_full OR v_ent.registration_approval THEN
      v_kind := CASE WHEN v_full THEN 'waitlist' ELSE 'approval' END;
      IF NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email)))
         AND NOT EXISTS (SELECT 1 FROM leod_checkin_held WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email))) THEN
        INSERT INTO leod_checkin_held (event_id, kind, first_name, last_name, email, company, answers, is_test, consent_at)
        VALUES (v_ent.event_id, v_kind, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
                COALESCE(p_answers, '{}'::jsonb), true, now())
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN jsonb_build_object('status', CASE WHEN v_kind = 'waitlist' THEN 'waitlisted' ELSE 'awaiting_approval' END, 'test', true);
    END IF;
    IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email))) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'test', true);
    END IF;
    BEGIN
      INSERT INTO leod_checkin_attendees
        (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields)
      VALUES
        (v_ent.event_id, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
         replace(gen_random_uuid()::text, '-', ''), 'web', true, now(), COALESCE(p_answers, '{}'::jsonb))
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('status', 'duplicate', 'test', true);
    END;
    RETURN jsonb_build_object('status', 'registered', 'test', true);
  END IF;

  -- (108) With a waitlist a full event still takes requests: the guest is
  -- waitlisted when they confirm.
  IF v_ent.registration_capacity IS NOT NULL AND NOT v_ent.registration_waitlist THEN
    SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND NOT is_test;
    IF v_n >= v_ent.registration_capacity THEN RETURN jsonb_build_object('status', 'full'); END IF;
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
  -- Per-event hourly cap (F1). Only this event is affected when it is hit,
  -- and the hit is recorded for guard G15.
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail WHERE event_id = v_ent.event_id AND sent_at > now() - interval '1 hour';
  IF v_n >= c_event_hour THEN
    INSERT INTO leod_checkin_web_trips (event_id) VALUES (v_ent.event_id);
    RETURN jsonb_build_object('status', 'pending', 'send', false);
  END IF;

  -- v_pend.id, not FOUND: the budget counts above have reset FOUND.
  IF v_pend.id IS NOT NULL THEN
    -- A resend (F3): the first submission's details stand, and the previous
    -- link keeps working beside the new one until 48 hours after it was sent.
    UPDATE leod_checkin_web_pending
       SET prev_token_hash = token_hash, token_hash = p_token_hash, last_sent_at = now()
     WHERE id = v_pend.id;
  ELSE
    INSERT INTO leod_checkin_web_pending (event_id, first_name, last_name, email, company, answers, token_hash)
    VALUES (v_ent.event_id, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
            COALESCE(p_answers, '{}'::jsonb), p_token_hash);
  END IF;
  INSERT INTO leod_checkin_web_mail (email_key, event_id) VALUES (v_key, v_ent.event_id);
  RETURN jsonb_build_object('status', 'pending', 'send', true, 'event_id', v_ent.event_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_request(text, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_request(text, text, text, text, text, jsonb, text) TO service_role;

CREATE OR REPLACE FUNCTION checkin_web_confirm(p_code text, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent  leod_checkin_entitlements;
  v_ev   leod_events;
  v_pend leod_checkin_web_pending;
  v_row  leod_checkin_attendees;
  v_n    int;
  v_full boolean;
  v_held leod_checkin_held;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements
   WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_ent.event_id::text, 0));

  SELECT * INTO v_pend FROM checkin_web_pending_by_token(p_code, p_token_hash);
  IF v_pend.id IS NULL THEN RETURN jsonb_build_object('status', 'invalid'); END IF;

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

  -- (108) Already held (waitlist or awaiting approval): say so to the owner.
  SELECT * INTO v_held FROM leod_checkin_held WHERE event_id = v_ent.event_id AND lower(email) = lower(v_pend.email);
  IF v_held.id IS NOT NULL THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', CASE WHEN v_held.kind = 'waitlist' THEN 'waitlisted' ELSE 'awaiting_approval' END,
                              'first_name', v_held.first_name);
  END IF;

  v_full := false;
  IF v_ent.registration_capacity IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = v_ent.event_id AND NOT is_test;
    v_full := v_n >= v_ent.registration_capacity;
    IF v_full AND NOT v_ent.registration_waitlist THEN
      DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
      RETURN jsonb_build_object('status', 'full');
    END IF;
  END IF;

  -- (108) Full with a waitlist, or approval required: hold the guest.
  IF v_full OR v_ent.registration_approval THEN
    INSERT INTO leod_checkin_held (event_id, kind, first_name, last_name, email, company, answers, is_test, consent_at)
    VALUES (v_ent.event_id, CASE WHEN v_full THEN 'waitlist' ELSE 'approval' END, v_pend.first_name, v_pend.last_name,
            v_pend.email, v_pend.company, v_pend.answers, false, now())
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
      (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields)
    VALUES
      (v_ent.event_id, v_pend.first_name, v_pend.last_name, v_pend.email, v_pend.company,
       replace(gen_random_uuid()::text, '-', ''), 'web', false, now(), v_pend.answers)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
    RETURN jsonb_build_object('status', 'already', 'first_name', v_pend.first_name, 'attendee', NULL);
  END;
  DELETE FROM leod_checkin_web_pending WHERE id = v_pend.id;
  RETURN jsonb_build_object('status', 'registered', 'first_name', v_row.first_name,
    'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                   'qr_token', v_row.qr_token, 'qr_email_sent_at', NULL));
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_confirm(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_confirm(text, text) TO service_role;
