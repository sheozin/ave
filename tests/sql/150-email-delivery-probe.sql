-- tests/sql/150-email-delivery-probe.sql. Ends in 'PROBE OK 150'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid; v_att uuid; v_st jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, source, is_test, qr_token)
  VALUES (E, 'Probe', 'Mail', 'probe150b@cuedeck-test.io', 'import', false, md5(random()::text) || md5(random()::text)) RETURNING id INTO v_att;
  BEGIN INSERT INTO leod_checkin_emails (event_id, kind, resend_id) VALUES (E, 'qr', 'probe-noone'); RAISE EXCEPTION 'row with nobody accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO leod_checkin_emails (event_id, kind, attendee_id, resend_id, sent_at, status) VALUES
    (E, 'qr', v_att, 'probe-old-2', now() - interval '2 hours', 'bounced'),
    (E, 'qr', v_att, 'probe-new-2', now() - interval '1 hour', 'delivered'),
    (E, 'guest_invite', v_att, 'probe-inv-2', now(), 'sent');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_email_status(E); RAISE EXCEPTION 'stranger read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_st := checkin_email_status(E)->'guests'->(v_att::text);
  IF v_st->'qr'->>'status' <> 'delivered' OR v_st->'guest_invite'->>'status' <> 'sent' THEN RAISE EXCEPTION 'latest per kind: %', v_st; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  IF has_table_privilege('authenticated', 'leod_checkin_emails', 'SELECT') THEN RAISE EXCEPTION 'emails readable'; END IF;
  IF checkin_email_status_cron_ok('nope') OR checkin_email_status_cron_ok(repeat('x', 64)) THEN RAISE EXCEPTION 'cron secret accepts junk'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkin-email-status') THEN RAISE EXCEPTION 'no cron'; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_jobs WHERE job_name = 'checkin-email-status' AND active) THEN RAISE EXCEPTION 'not watched'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leod_checkin_operators' AND column_name = 'invite_sent_by') THEN RAISE EXCEPTION 'rename'; END IF;
  RAISE EXCEPTION 'PROBE OK 150';
END;
$probe$;
