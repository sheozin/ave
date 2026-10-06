-- 100_checkin_public_registration.sql
-- Public registration page: a shareable link (app.cuedeck.io/r/<code>)
-- where guests add themselves to an event's check-in list before the event.
-- Spec: docs/superpowers/specs/2026-10-06-checkin-public-registration-design.md
--
-- The public caller never touches these tables. The checkin-register Edge
-- Function (service role) is the only writer, through checkin_web_register,
-- which is granted to service_role alone. Organizers configure the page
-- through checkin_set_registration and checkin_new_registration_code.

-- ── 1. Settings, on the entitlement row ───────────────────────────
ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS registration_enabled   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registration_code      text,
  ADD COLUMN IF NOT EXISTS registration_capacity  integer,
  ADD COLUMN IF NOT EXISTS registration_closes_at timestamptz,
  ADD COLUMN IF NOT EXISTS registration_questions jsonb       NOT NULL DEFAULT '[]'::jsonb;

-- Ten characters from the unambiguous alphabet (no 0, 1, I, O): 32^10, so a
-- link cannot be guessed, and it reads cleanly if someone types it.
ALTER TABLE leod_checkin_entitlements
  DROP CONSTRAINT IF EXISTS checkin_registration_code_format,
  ADD  CONSTRAINT checkin_registration_code_format
       CHECK (registration_code IS NULL OR registration_code ~ '^[A-HJ-NP-Z2-9]{10}$'),
  DROP CONSTRAINT IF EXISTS checkin_registration_capacity_range,
  ADD  CONSTRAINT checkin_registration_capacity_range
       CHECK (registration_capacity IS NULL OR registration_capacity BETWEEN 1 AND 100000),
  DROP CONSTRAINT IF EXISTS checkin_registration_questions_array,
  ADD  CONSTRAINT checkin_registration_questions_array
       CHECK (jsonb_typeof(registration_questions) = 'array');

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_registration_code
  ON leod_checkin_entitlements (registration_code) WHERE registration_code IS NOT NULL;

-- ── 2. A web registration is its own source ───────────────────────
ALTER TABLE leod_checkin_attendees DROP CONSTRAINT IF EXISTS leod_checkin_attendees_source_check;
ALTER TABLE leod_checkin_attendees ADD CONSTRAINT leod_checkin_attendees_source_check
  CHECK (source IN ('import', 'kiosk', 'walk_in', 'web'));

-- ── 3. Code generator ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_make_registration_code()
RETURNS text
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
DECLARE
  c_alpha CONSTANT text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(10);  -- pgcrypto lives in extensions
  v_out   text  := '';
BEGIN
  FOR i IN 0..9 LOOP
    v_out := v_out || substr(c_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
  END LOOP;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_make_registration_code() FROM PUBLIC, anon, authenticated;

-- ── 4. Organizer: settings ────────────────────────────────────────
-- Questions: at most 5. Each {id, label, type, required, options}. id is the
-- key the answer is stored under, so it must be stable and unique; label is
-- what the guest reads; type is text or choice; a choice has 1 to 20 options.
-- The first time the page is turned on it gets a code; turning it off keeps
-- the code so turning it back on restores the same link.
CREATE OR REPLACE FUNCTION checkin_set_registration(
  p_event_id uuid, p_enabled boolean, p_capacity integer, p_closes_at timestamptz, p_questions jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q    jsonb := COALESCE(p_questions, '[]'::jsonb);
  v_item jsonb;
  v_ids  text[] := '{}';
  v_row  leod_checkin_entitlements;
BEGIN
  IF auth.uid() IS NULL
     OR NOT COALESCE(checkin_is_owner(p_event_id) OR checkin_role_for_event(p_event_id) = 'organizer', false) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change the registration page'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(v_q) <> 'array' OR jsonb_array_length(v_q) > 5 THEN
    RAISE EXCEPTION 'At most 5 questions' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_q) LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR NOT COALESCE((v_item->>'id') ~ '^[a-z0-9_]{1,24}$', false)
       OR COALESCE(length(btrim(v_item->>'label')), 0) NOT BETWEEN 1 AND 120
       OR COALESCE(v_item->>'type', '') NOT IN ('text', 'choice')
       OR jsonb_typeof(COALESCE(v_item->'required', 'null'::jsonb)) <> 'boolean' THEN
      RAISE EXCEPTION 'Each question needs an id, a label up to 120 characters, a type and a required flag'
        USING ERRCODE = '22023';
    END IF;
    IF (v_item->>'id') = ANY (v_ids) THEN
      RAISE EXCEPTION 'Question ids must be unique' USING ERRCODE = '22023';
    END IF;
    v_ids := v_ids || (v_item->>'id');
    IF v_item->>'type' = 'choice' AND (
         jsonb_typeof(v_item->'options') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_item->'options') NOT BETWEEN 1 AND 20
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_item->'options') o
                     WHERE jsonb_typeof(o) <> 'string' OR length(btrim(o #>> '{}')) NOT BETWEEN 1 AND 80)) THEN
      RAISE EXCEPTION 'A choice question needs 1 to 20 options of up to 80 characters' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_capacity IS NOT NULL AND p_capacity NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'Capacity must be between 1 and 100000' USING ERRCODE = '22023';
  END IF;

  -- Store a normalised copy: trimmed labels and options, nothing else kept.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', q->>'id', 'label', btrim(q->>'label'), 'type', q->>'type',
           'required', (q->>'required')::boolean,
           'options', CASE WHEN q->>'type' = 'choice'
                           THEN (SELECT jsonb_agg(btrim(o #>> '{}')) FROM jsonb_array_elements(q->'options') o)
                           ELSE '[]'::jsonb END) ORDER BY n), '[]'::jsonb)
    INTO v_q
    FROM jsonb_array_elements(v_q) WITH ORDINALITY AS t(q, n);

  UPDATE leod_checkin_entitlements
     SET registration_enabled   = COALESCE(p_enabled, false),
         registration_capacity  = p_capacity,
         registration_closes_at = p_closes_at,
         registration_questions = v_q,
         registration_code      = COALESCE(registration_code,
                                    CASE WHEN COALESCE(p_enabled, false) THEN checkin_make_registration_code() END)
   WHERE event_id = p_event_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;

  RETURN jsonb_build_object('enabled', v_row.registration_enabled, 'code', v_row.registration_code,
                            'capacity', v_row.registration_capacity, 'closes_at', v_row.registration_closes_at,
                            'questions', v_row.registration_questions);
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_registration(uuid, boolean, integer, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_registration(uuid, boolean, integer, timestamptz, jsonb) TO authenticated;

-- ── 5. Organizer: new link ────────────────────────────────────────
-- The answer to a leaked or spammed link: the old URL stops working at once.
CREATE OR REPLACE FUNCTION checkin_new_registration_code(p_event_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
BEGIN
  IF auth.uid() IS NULL
     OR NOT COALESCE(checkin_is_owner(p_event_id) OR checkin_role_for_event(p_event_id) = 'organizer', false) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change the registration link'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE leod_checkin_entitlements SET registration_code = checkin_make_registration_code()
   WHERE event_id = p_event_id RETURNING registration_code INTO v_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN v_code;
END;
$$;
REVOKE ALL ON FUNCTION checkin_new_registration_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_new_registration_code(uuid) TO authenticated;

-- ── 6. Rate limit for the public form ─────────────────────────────
-- ip_hash is an HMAC computed in the Edge Function; the raw address never
-- reaches the database. Rows older than the longest window are pruned on
-- every call, so nothing here outlives two hours.
CREATE TABLE IF NOT EXISTS leod_checkin_web_attempts (
  id           bigserial PRIMARY KEY,
  event_id     uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  ip_hash      text        NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkin_web_attempts_event ON leod_checkin_web_attempts (event_id, attempted_at);
CREATE INDEX IF NOT EXISTS idx_checkin_web_attempts_ip    ON leod_checkin_web_attempts (ip_hash, attempted_at);
ALTER TABLE leod_checkin_web_attempts ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the service role reads or writes this table.
REVOKE ALL ON TABLE leod_checkin_web_attempts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE leod_checkin_web_attempts_id_seq FROM anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_web_rate_check(p_event_id uuid, p_ip_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_ip_window    CONSTANT interval := interval '10 minutes';
  c_ip_limit     CONSTANT int      := 5;
  c_event_window CONSTANT interval := interval '1 hour';
  c_event_limit  CONSTANT int      := 300;
  c_retention    CONSTANT interval := interval '2 hours';  -- >= the longest window
  v_count int;
BEGIN
  IF p_ip_hash IS NULL OR length(p_ip_hash) < 32 THEN RETURN false; END IF;
  -- One lock per IP serialises that IP's check-and-insert across events;
  -- one per event serialises the event bucket.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_ip:' || p_ip_hash, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_ev:' || p_event_id::text, 0));
  DELETE FROM leod_checkin_web_attempts WHERE attempted_at < now() - c_retention;
  SELECT count(*) INTO v_count FROM leod_checkin_web_attempts
   WHERE ip_hash = p_ip_hash AND attempted_at > now() - c_ip_window;
  IF v_count >= c_ip_limit THEN RETURN false; END IF;
  SELECT count(*) INTO v_count FROM leod_checkin_web_attempts
   WHERE event_id = p_event_id AND attempted_at > now() - c_event_window;
  IF v_count >= c_event_limit THEN RETURN false; END IF;
  INSERT INTO leod_checkin_web_attempts (event_id, ip_hash) VALUES (p_event_id, p_ip_hash);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_rate_check(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_rate_check(uuid, text) TO service_role;

-- ── 7. The registration itself ────────────────────────────────────
-- One transaction under a per-event lock, so capacity and the test cap hold
-- under concurrent submissions. Outcomes:
--   registered  {attendee}            new row
--   duplicate   {attendee}            this email is already on the list
--   full | test_cap | closed | not_found
-- The attendee payload is for the Edge Function to send the QR email to the
-- address ON FILE; the function never returns it to the public caller.
CREATE OR REPLACE FUNCTION checkin_web_register(
  p_code text, p_first_name text, p_last_name text, p_email text, p_company text, p_answers jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_test_cap CONSTANT int := 25;
  v_ent  leod_checkin_entitlements;
  v_ev   leod_events;
  v_test boolean;
  v_n    int;
  v_row  leod_checkin_attendees;
BEGIN
  SELECT * INTO v_ent FROM leod_checkin_entitlements
   WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_web_reg:' || v_ent.event_id::text, 0));

  SELECT * INTO v_ev FROM leod_events WHERE id = v_ent.event_id;
  -- Closed by the organizer's time, or by the check-in window (end of day +2
  -- in the event's timezone), whichever comes first.
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
  END IF;

  -- A returning guest is not blocked by capacity: they are already counted.
  SELECT * INTO v_row FROM leod_checkin_attendees
   WHERE event_id = v_ent.event_id AND lower(email) = lower(btrim(p_email));
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'test', v_test, 'event_id', v_ent.event_id,
      'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                     'qr_token', v_row.qr_token, 'qr_email_sent_at', v_row.qr_email_sent_at));
  END IF;

  IF v_ent.registration_capacity IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM leod_checkin_attendees
     WHERE event_id = v_ent.event_id AND is_test = v_test;
    IF v_n >= v_ent.registration_capacity THEN RETURN jsonb_build_object('status', 'full'); END IF;
  END IF;

  BEGIN
  INSERT INTO leod_checkin_attendees
    (event_id, first_name, last_name, email, company, qr_token, source, is_test, consent_at, custom_fields)
  VALUES
    (v_ent.event_id, btrim(p_first_name), btrim(p_last_name), btrim(p_email), NULLIF(btrim(p_company), ''),
     replace(gen_random_uuid()::text, '-', ''), 'web', v_test, now(), COALESCE(p_answers, '{}'::jsonb))
  RETURNING * INTO v_row;
  -- The lookup above compares lower(btrim(email)); a stored address with
  -- stray spaces can still collide on the unique index. That is the same
  -- person, so it is a duplicate, never an error page.
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'duplicate', 'test', v_test, 'event_id', v_ent.event_id, 'attendee', NULL);
  END;

  RETURN jsonb_build_object('status', 'registered', 'test', v_test, 'event_id', v_ent.event_id,
    'attendee', jsonb_build_object('id', v_row.id, 'first_name', v_row.first_name, 'email', v_row.email,
                                   'qr_token', v_row.qr_token, 'qr_email_sent_at', NULL));
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_register(text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_register(text, text, text, text, text, jsonb) TO service_role;

-- ── 8. Dashboard: web registrations get their own source bar ──────
CREATE OR REPLACE FUNCTION public.checkin_event_stats(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role   text := checkin_role_for_event(p_event_id);
  v_owner  boolean := checkin_is_owner(p_event_id);
  v_eff    text;
  v_status text;
  v_core   boolean;
  v_live   boolean;
  v_out    jsonb;
  v_ops    jsonb := NULL;
BEGIN
  SELECT status, checkin_core INTO v_status, v_core FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  IF auth.uid() IS NULL
     OR NOT ((v_owner AND COALESCE(v_core, false))
             OR COALESCE(v_role IN ('organizer', 'lead', 'crew', 'viewer'), false)) THEN
    RAISE EXCEPTION 'Not on this event' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_eff := CASE WHEN v_owner THEN 'owner' ELSE v_role END;
  v_live := v_status = 'live';

  SELECT jsonb_build_object(
    'registered', count(*)::int,
    'checked_in', (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int,
    'walk_ins',   (count(*) FILTER (WHERE source IN ('kiosk', 'walk_in')))::int,
    'by_source',  jsonb_build_object(
                    'import',  (count(*) FILTER (WHERE source = 'import'))::int,
                    'kiosk',   (count(*) FILTER (WHERE source = 'kiosk'))::int,
                    'walk_in', (count(*) FILTER (WHERE source = 'walk_in'))::int,
                    'web',     (count(*) FILTER (WHERE source = 'web'))::int),
    'qr',         jsonb_build_object(
                    'sent',     (count(*) FILTER (WHERE qr_email_sent_at IS NOT NULL))::int,
                    'not_sent', (count(*) FILTER (WHERE qr_email_sent_at IS NULL AND NULLIF(btrim(email), '') IS NOT NULL))::int,
                    'no_email', (count(*) FILTER (WHERE qr_email_sent_at IS NULL AND NULLIF(btrim(email), '') IS NULL))::int)
  ) INTO v_out
  FROM leod_checkin_attendees WHERE event_id = p_event_id;

  v_out := v_out || jsonb_build_object(
    'role', v_eff,
    'status', COALESCE(v_status, 'test'),
    'generated_at', now(),
    'by_ticket', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('ticket_type', ticket_type, 'registered', reg, 'checked_in', arr)
                                ORDER BY reg DESC, ticket_type), '[]'::jsonb)
        FROM (SELECT ticket_type, count(*)::int AS reg,
                     (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int AS arr
                FROM leod_checkin_attendees WHERE event_id = p_event_id GROUP BY ticket_type) t),
    'arrivals', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('t', b, 'n', n) ORDER BY b), '[]'::jsonb)
        FROM (SELECT (floor(extract(epoch FROM checked_in_at) / 900) * 900)::bigint AS b, count(*)::int AS n
                FROM leod_checkin_attendees
               WHERE event_id = p_event_id AND checked_in_at IS NOT NULL
               GROUP BY 1) x),
    'last_25_min', (
      SELECT jsonb_agg(COALESCE(c.n, 0) ORDER BY m.i DESC)
        FROM generate_series(0, 24) AS m(i)
        LEFT JOIN (SELECT date_trunc('minute', checked_in_at) AS mm, count(*)::int AS n
                     FROM leod_checkin_attendees
                    WHERE event_id = p_event_id
                      AND checked_in_at >= date_trunc('minute', now()) - interval '24 minutes'
                    GROUP BY 1) c
          ON c.mm = date_trunc('minute', now()) - make_interval(mins => m.i))
  );

  IF v_eff IN ('owner', 'organizer', 'lead') THEN
    -- dk: the event's visible desks (test desks hidden once live), each
    -- numbered k. k is valid within one response only: it ties a desk's
    -- row to its speeds and gaps, and may change between calls.
    WITH dk AS (
      SELECT d.*, row_number() OVER (ORDER BY d.label, d.desk_id)::int AS k
        FROM leod_checkin_desks d
       WHERE d.event_id = p_event_id AND NOT (v_live AND d.is_test))
    SELECT jsonb_build_object(
      'desks', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'k', dk.k, 'label', dk.label,
                 'operator', COALESCE(NULLIF(btrim(u.name), ''), 'Unnamed'),
                 'last_seen_at', dk.last_seen_at,
                 'seconds_since_seen', floor(extract(epoch FROM now() - dk.last_seen_at))::int,
                 'pending_count', dk.pending_count) ORDER BY dk.k), '[]'::jsonb)
          FROM dk
          LEFT JOIN leod_users u ON u.id = dk.operator_id),
      'kiosks', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'label', kd.label, 'last_seen_at', kd.last_seen_at,
                 'seconds_since_seen', CASE WHEN kd.last_seen_at IS NULL THEN NULL
                                            ELSE floor(extract(epoch FROM now() - kd.last_seen_at))::int END)
                 ORDER BY kd.label), '[]'::jsonb)
          FROM leod_checkin_devices kd
         WHERE kd.event_id = p_event_id AND kd.kind = 'kiosk' AND kd.revoked_at IS NULL),
      -- Busiest 15 minutes per desk: for every 'ok' scan, the 'ok' scans of
      -- the same desk in the 15 minutes from it; the maximum is the busiest
      -- window. Speeds measure desk throughput, so they include scans that
      -- were later undone (by design; arrivals above do not).
      'speeds', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'k', dk.k, 'label', dk.label, 'busiest_15', s.busiest, 'active_minutes', s.active_minutes,
                 'first_at', s.first_at, 'last_at', s.last_at) ORDER BY dk.k), '[]'::jsonb)
          FROM (SELECT desk_id, max(c)::int AS busiest,
                       count(DISTINCT date_trunc('minute', scanned_at))::int AS active_minutes,
                       min(scanned_at) AS first_at, max(scanned_at) AS last_at
                  FROM (SELECT desk_id, scanned_at,
                               count(*) OVER (PARTITION BY desk_id ORDER BY scanned_at
                                              RANGE BETWEEN CURRENT ROW AND INTERVAL '15 minutes' FOLLOWING) AS c
                          FROM leod_checkin_scan_events
                         WHERE event_id = p_event_id AND desk_id IS NOT NULL AND result = 'ok') w
                 GROUP BY desk_id) s
          JOIN dk ON dk.desk_id = s.desk_id),
      -- Offline gaps proven: per desk, in scanned_at order, a run of scans
      -- that reached the server more than 60 s after they were made
      -- (gaps-and-islands). Latest 50 gaps, newest first.
      'gaps', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'k', g.k, 'label', g.label, 'start_at', g.start_at, 'end_at', g.end_at, 'synced_ok', g.synced_ok)
                 ORDER BY g.start_at DESC, g.k), '[]'::jsonb)
          FROM (SELECT dk.k, dk.label, min(b.scanned_at) AS start_at, max(b.scanned_at) AS end_at,
                       (count(*) FILTER (WHERE b.result = 'ok'))::int AS synced_ok
                  FROM (SELECT desk_id, scanned_at, result, late,
                               row_number() OVER (PARTITION BY desk_id ORDER BY scanned_at, id)
                             - row_number() OVER (PARTITION BY desk_id, late ORDER BY scanned_at, id) AS grp
                          FROM (SELECT desk_id, scanned_at, result, id,
                                       (received_at - scanned_at) > interval '60 seconds' AS late
                                  FROM leod_checkin_scan_events
                                 WHERE event_id = p_event_id AND desk_id IS NOT NULL) a) b
                  JOIN dk ON dk.desk_id = b.desk_id
                 WHERE b.late
                 GROUP BY dk.k, dk.label, b.grp
                 ORDER BY min(b.scanned_at) DESC
                 LIMIT 50) g)
    ) INTO v_ops;
  END IF;

  RETURN v_out || jsonb_build_object('ops', v_ops);
END;
$function$;
