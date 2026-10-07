-- 110_checkin_reminder_emails.sql
-- Automatic guest emails for live events:
--
--   reminder   from 24 hours before doors open until they open, to every
--              guest with an email who has not checked in. Carries their
--              QR code, time, venue and the organizer's note.
--   thank-you  from 2 hours after the event ends, for 3 days, to every
--              guest who checked in. The organizer's note and an optional
--              link (survey, slides, photos).
--
-- Doors open at leod_events.event_start (09:00 when unset) and the event
-- ends at event_end (18:00 when unset), both in the event's timezone.
-- Test-mode events never send.
--
-- Sending: checkin-reminders (pg_cron every 5 minutes) calls
-- checkin_claim_reminders, which records each guest in
-- leod_checkin_reminder_sends BEFORE the email goes, so overlapping runs
-- cannot both send. A failed send gives the claim back
-- (checkin_unclaim_reminder) and the next run retries.
-- Guard G17 reports reminders still unsent after doors opened.
--
-- Defaults: on for events set up from now on; off for events that already
-- existed, so nobody's guests get an email their organizer never chose.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS reminder_enabled  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_message  text CHECK (reminder_message IS NULL OR char_length(reminder_message) <= 600),
  ADD COLUMN IF NOT EXISTS thankyou_enabled  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS thankyou_message  text CHECK (thankyou_message IS NULL OR char_length(thankyou_message) <= 600),
  ADD COLUMN IF NOT EXISTS thankyou_link     text CHECK (thankyou_link IS NULL OR (thankyou_link ~ '^https://[^\s<>"]+$' AND char_length(thankyou_link) <= 500));
-- Existing rows stay off (the columns were added as false); new ones start on.
ALTER TABLE leod_checkin_entitlements ALTER COLUMN reminder_enabled SET DEFAULT true;
ALTER TABLE leod_checkin_entitlements ALTER COLUMN thankyou_enabled SET DEFAULT true;

CREATE TABLE IF NOT EXISTS leod_checkin_reminder_sends (
  attendee_id uuid        NOT NULL REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('reminder', 'thankyou')),
  event_id    uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attendee_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_checkin_reminder_sends_event ON leod_checkin_reminder_sends (event_id, kind);
ALTER TABLE leod_checkin_reminder_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_reminder_sends FROM anon, authenticated;

-- When doors open and when the event ends, as instants. NULL without a date
-- or timezone (nothing is sent for such an event).
CREATE OR REPLACE FUNCTION checkin_event_doors(p_date date, p_start time, p_tz text)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN p_date IS NULL OR p_tz IS NULL THEN NULL
              ELSE (p_date + COALESCE(p_start, time '09:00'))::timestamp AT TIME ZONE p_tz END;
$$;
CREATE OR REPLACE FUNCTION checkin_event_ends(p_date date, p_start time, p_end time, p_tz text)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  -- An end before the start means the event runs past midnight.
  SELECT CASE WHEN p_date IS NULL OR p_tz IS NULL THEN NULL
              ELSE (p_date + CASE WHEN p_end IS NOT NULL AND p_start IS NOT NULL AND p_end <= p_start THEN 1 ELSE 0 END
                    + COALESCE(p_end, time '18:00'))::timestamp AT TIME ZONE p_tz END;
$$;

-- ── Organizer: settings ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_set_reminders(
  p_event_id uuid, p_reminder boolean, p_reminder_message text, p_thankyou boolean, p_thankyou_message text, p_thankyou_link text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link text := NULLIF(btrim(COALESCE(p_thankyou_link, '')), '');
  v_row  leod_checkin_entitlements;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change guest emails' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_link IS NOT NULL AND (v_link !~ '^https://[^\s<>"]+$' OR char_length(v_link) > 500) THEN
    RAISE EXCEPTION 'The link must be a full https:// address' USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(COALESCE(p_reminder_message, '')) > 600 OR char_length(COALESCE(p_thankyou_message, '')) > 600 THEN
    RAISE EXCEPTION 'Keep each note to 600 characters' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE leod_checkin_entitlements
     SET reminder_enabled = COALESCE(p_reminder, false),
         reminder_message = NULLIF(btrim(COALESCE(p_reminder_message, '')), ''),
         thankyou_enabled = COALESCE(p_thankyou, false),
         thankyou_message = NULLIF(btrim(COALESCE(p_thankyou_message, '')), ''),
         thankyou_link    = v_link
   WHERE event_id = p_event_id RETURNING * INTO v_row;
  IF v_row.event_id IS NULL THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('reminder_enabled', v_row.reminder_enabled, 'reminder_message', v_row.reminder_message,
    'thankyou_enabled', v_row.thankyou_enabled, 'thankyou_message', v_row.thankyou_message, 'thankyou_link', v_row.thankyou_link);
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_reminders(uuid, boolean, text, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_reminders(uuid, boolean, text, boolean, text, text) TO authenticated;

-- ── Organizer: when they go out, and how many went ─────────────────
CREATE OR REPLACE FUNCTION checkin_reminder_status(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev leod_events;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see guest emails' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_ev FROM leod_events WHERE id = p_event_id;
  RETURN jsonb_build_object(
    'reminder_from', checkin_event_doors(v_ev.date, v_ev.event_start, v_ev.timezone) - interval '24 hours',
    'thankyou_from', checkin_event_ends(v_ev.date, v_ev.event_start, v_ev.event_end, v_ev.timezone) + interval '2 hours',
    'reminder_sent', (SELECT count(*) FROM leod_checkin_reminder_sends WHERE event_id = p_event_id AND kind = 'reminder'),
    'thankyou_sent', (SELECT count(*) FROM leod_checkin_reminder_sends WHERE event_id = p_event_id AND kind = 'thankyou'));
END;
$$;
REVOKE ALL ON FUNCTION checkin_reminder_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_reminder_status(uuid) TO authenticated;

-- ── Service: claim the next batch ─────────────────────────────────
-- Inserts the claims and returns what the sender needs. A guest is claimed
-- once per kind, ever: the primary key is the guarantee against doubles.
CREATE OR REPLACE FUNCTION checkin_claim_reminders(p_limit int)
RETURNS TABLE (attendee_id uuid, kind text, event_id uuid, first_name text, email text, qr_token text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT a.id AS attendee_id, 'reminder'::text AS kind, a.event_id
      FROM leod_checkin_entitlements e
      JOIN leod_events ev ON ev.id = e.event_id
      JOIN leod_checkin_attendees a ON a.event_id = e.event_id
     WHERE e.status = 'live' AND e.checkin_core AND e.reminder_enabled AND ev.active IS NOT FALSE
       AND now() >= checkin_event_doors(ev.date, ev.event_start, ev.timezone) - interval '24 hours'
       AND now() <  checkin_event_doors(ev.date, ev.event_start, ev.timezone)
       AND NOT a.is_test AND a.email IS NOT NULL AND a.email <> '' AND a.checked_in_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM leod_checkin_reminder_sends s WHERE s.attendee_id = a.id AND s.kind = 'reminder')
    UNION ALL
    SELECT a.id, 'thankyou'::text, a.event_id
      FROM leod_checkin_entitlements e
      JOIN leod_events ev ON ev.id = e.event_id
      JOIN leod_checkin_attendees a ON a.event_id = e.event_id
     WHERE e.status = 'live' AND e.checkin_core AND e.thankyou_enabled AND ev.active IS NOT FALSE
       AND now() >= checkin_event_ends(ev.date, ev.event_start, ev.event_end, ev.timezone) + interval '2 hours'
       AND now() <  checkin_event_ends(ev.date, ev.event_start, ev.event_end, ev.timezone) + interval '3 days'
       AND NOT a.is_test AND a.email IS NOT NULL AND a.email <> '' AND a.checked_in_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM leod_checkin_reminder_sends s WHERE s.attendee_id = a.id AND s.kind = 'thankyou')
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
  ), claimed AS (
    INSERT INTO leod_checkin_reminder_sends (attendee_id, kind, event_id)
    SELECT d.attendee_id, d.kind, d.event_id FROM due d
    ON CONFLICT DO NOTHING
    RETURNING leod_checkin_reminder_sends.attendee_id, leod_checkin_reminder_sends.kind, leod_checkin_reminder_sends.event_id
  )
  SELECT c.attendee_id, c.kind, c.event_id, a.first_name, a.email, a.qr_token
    FROM claimed c JOIN leod_checkin_attendees a ON a.id = c.attendee_id;
END;
$$;
REVOKE ALL ON FUNCTION checkin_claim_reminders(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_claim_reminders(int) TO service_role;

CREATE OR REPLACE FUNCTION checkin_unclaim_reminder(p_attendee_id uuid, p_kind text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM leod_checkin_reminder_sends WHERE attendee_id = p_attendee_id AND kind = p_kind;
$$;
REVOKE ALL ON FUNCTION checkin_unclaim_reminder(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_unclaim_reminder(uuid, text) TO service_role;

-- ── The cron ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'checkin_reminders_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'),
                                'checkin_reminders_cron_secret',
                                'x-cron-secret for the checkin-reminders Edge Function (110)');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION checkin_reminders_cron_ok(p_secret text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(length(p_secret) >= 32 AND p_secret = (
           SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'checkin_reminders_cron_secret'), false);
$$;
REVOKE ALL ON FUNCTION checkin_reminders_cron_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_reminders_cron_ok(text) TO service_role;

INSERT INTO leod_checkin_jobs (job_name, expected_interval, note)
VALUES ('checkin-reminders', interval '5 minutes',
        'pg_cron -> pg_net -> Edge Function checkin-reminders: reminder and thank-you emails (110)')
ON CONFLICT (job_name) DO UPDATE
  SET expected_interval = EXCLUDED.expected_interval, note = EXCLUDED.note, active = true;

DO $$
BEGIN
  PERFORM cron.unschedule('checkin-reminders') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkin-reminders');
END $$;
SELECT cron.schedule(
  'checkin-reminders',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-reminders',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                                    WHERE name = 'checkin_reminders_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000);
  $cron$);

-- ── Guard G17 ─────────────────────────────────────────────────────
-- The live checkin_guard_results (through 109) with G17 added at the end.
CREATE OR REPLACE FUNCTION public.checkin_guard_results()
 RETURNS TABLE(guard text, ok boolean, detail text, checked_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_ok     BOOLEAN;
  v_detail TEXT;
  v_bad    TEXT[];
  v_roles  TEXT[];
  v_n      INT;
  v_total  INT;
  v_gf     INT;
  v_admin  UUID;
  v_fn     RECORD;
  v_noargs TEXT[];
  v_ev     UUID;   -- G10
  v_res    TEXT;   -- G10
  v_refused INT;   -- G10
BEGIN
  -- G1 (061, 064, 069): no leod_checkin_* table writable by anon. Writable
  -- = an INSERT/UPDATE/DELETE grant AND (RLS off OR a permissive write
  -- policy that applies to anon or PUBLIC). TRUNCATE is not counted:
  -- PostgREST cannot issue it, and Supabase grants it to anon by default.
  -- An empty in-scope set (prefix renamed, tables moved) is a failure: the
  -- guard must not pass by looking at nothing.
  BEGIN
    SELECT count(*),
           array_agg(c.relname::text ORDER BY c.relname) FILTER (WHERE
             has_table_privilege('anon', c.oid, 'INSERT, UPDATE, DELETE')
             AND (NOT c.relrowsecurity OR EXISTS (
                   SELECT 1 FROM pg_policy p
                    WHERE p.polrelid = c.oid
                      AND p.polpermissive
                      AND p.polcmd IN ('a', 'w', 'd', '*')
                      AND (0::oid = ANY (p.polroles) OR 'anon'::regrole::oid = ANY (p.polroles)))))
      INTO v_total, v_bad
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname LIKE 'leod\_checkin\_%';
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 leod_checkin_* tables found'
                     WHEN v_n = 0 THEN '0 of ' || v_total || ' leod_checkin_* tables writable by anon'
                     ELSE v_n || ' of ' || v_total || ' leod_checkin_* tables writable by anon: '
                          || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_tables_not_anon_writable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G2 (061, 064, 069): no table in public with RLS off.
  BEGIN
    SELECT array_agg(c.relname::text ORDER BY c.relname)
      INTO v_bad
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity;
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every table in public has RLS on'
                     ELSE 'RLS off: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'public_tables_rls_on'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G3 (069): leod_config not writable by authenticated (same definition
  -- of writable as G1).
  BEGIN
    IF to_regclass('public.leod_config') IS NULL THEN
      v_ok := false;
      v_detail := 'leod_config does not exist';
    ELSE
      SELECT NOT (has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE')
                  AND (NOT c.relrowsecurity OR EXISTS (
                        SELECT 1 FROM pg_policy p
                         WHERE p.polrelid = c.oid
                           AND p.polpermissive
                           AND p.polcmd IN ('a', 'w', 'd', '*')
                           AND (0::oid = ANY (p.polroles)
                                OR 'authenticated'::regrole::oid = ANY (p.polroles)))))
        INTO v_ok
        FROM pg_class c
       WHERE c.oid = to_regclass('public.leod_config');
      v_detail := CASE WHEN v_ok THEN 'authenticated cannot write leod_config'
                       ELSE 'authenticated can write leod_config' END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'leod_config_not_authenticated_writable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G4 (roles build): every leod_checkin_operators.role is allowed. Five
  -- roles once the roles build has widened the check constraint, three
  -- before it.
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.leod_checkin_operators'::regclass
                  AND contype = 'c'
                  AND pg_get_constraintdef(oid) LIKE '%''lead''%'
                  AND pg_get_constraintdef(oid) LIKE '%''viewer''%') THEN
      v_roles := ARRAY['organizer', 'lead', 'crew', 'viewer', 'api_consumer'];
    ELSE
      v_roles := ARRAY['organizer', 'crew', 'api_consumer'];
    END IF;
    SELECT array_agg(DISTINCT coalesce(o.role, '<null>'))
      INTO v_bad
      FROM leod_checkin_operators o
     WHERE o.role IS NULL OR NOT (o.role = ANY (v_roles));
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every role is one of: ' || array_to_string(v_roles, ', ')
                     ELSE 'roles outside {' || array_to_string(v_roles, ', ') || '}: '
                          || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_operator_roles_allowed'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G5 (billing invariants): no live event without a paid, unrefunded
  -- purchase unless its owner is a comp account. Rows that 059 made live
  -- when paid go-live shipped (went_live_at = created_at, created before
  -- 059 was applied at 2026-10-04 10:42:11 UTC) were enabled by hand and
  -- are grandfathered.
  BEGIN
    SELECT count(*),
           array_agg(x.event_id::text ORDER BY x.event_id) FILTER (WHERE x.unpaid AND NOT x.gf),
           count(*) FILTER (WHERE x.unpaid AND x.gf)
      INTO v_total, v_bad, v_gf
      FROM (SELECT n.event_id,
                   (NOT EXISTS (SELECT 1 FROM leod_checkin_purchases p
                                 WHERE p.event_id = n.event_id
                                   AND p.paid_at IS NOT NULL
                                   AND p.refunded_at IS NULL)
                    AND NOT EXISTS (SELECT 1 FROM leod_checkin_comp_accounts c WHERE c.user_id = e.created_by)) AS unpaid,
                   coalesce(n.went_live_at = n.created_at
                            AND n.created_at < timestamptz '2026-10-04 10:42:11+00', false) AS gf
              FROM leod_checkin_entitlements n
              JOIN leod_events e ON e.id = n.event_id
             WHERE n.status = 'live') x;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_n = 0;
    v_detail := v_n || ' of ' || v_total || ' live entitlements without a purchase (' || v_gf || ' grandfathered)'
                || CASE WHEN v_ok THEN '' ELSE ': ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'live_events_have_purchase'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G6 (billing invariants): no paid purchase without a matching
  -- entitlement: live while the purchase stands, any status once refunded
  -- (checkin_mark_refunded sets the entitlement back to 'test').
  BEGIN
    SELECT count(*),
           array_agg(p.id::text ORDER BY p.id) FILTER (WHERE n.event_id IS NULL
             OR (p.refunded_at IS NULL AND n.status IS DISTINCT FROM 'live'))
      INTO v_total, v_bad
      FROM leod_checkin_purchases p
      LEFT JOIN leod_checkin_entitlements n ON n.event_id = p.event_id
     WHERE p.paid_at IS NOT NULL;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_n = 0;
    v_detail := v_n || ' of ' || v_total || ' paid purchases without a matching entitlement'
                || CASE WHEN v_ok THEN '' ELSE ': ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'purchases_have_entitlement'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G7 (069): every SECURITY DEFINER function in public pins search_path.
  BEGIN
    SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                     ORDER BY p.proname)
      INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prosecdef
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                        WHERE cfg LIKE 'search\_path=%');
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every SECURITY DEFINER function in public sets search_path'
                     ELSE cardinality(v_bad) || ' without search_path: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'security_definer_search_path'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G9 (077): every admin read RPC (public admin_get_* / admin_list_*)
  -- that can be called without arguments runs cleanly as an admin.
  -- PL/pgSQL prepares a statement only when execution reaches it, so a
  -- broken query behind the admin check is invisible to a caller without a
  -- JWT. Each call therefore impersonates an existing admin (request.jwt.claims,
  -- transaction-local) inside its own subblock, and ends by raising a private
  -- SQLSTATE so the subblock rolls back: any write the RPC made and the
  -- impersonation itself are undone. Only that private SQLSTATE is a pass.
  -- Any other error is a failure, including Forbidden/Unauthorized, which as
  -- an admin means the admin check itself is broken. No admin to test as, or
  -- no callable RPC in scope, is a failure, not an all-clear. RPCs that need
  -- arguments without defaults are listed but do not fail the guard.
  BEGIN
    v_bad := NULL;
    v_noargs := NULL;
    v_total := 0;
    SELECT u.id INTO v_admin
      FROM leod_users u
     WHERE u.role = 'admin'
     ORDER BY u.id
     LIMIT 1;
    IF v_admin IS NULL THEN
      v_ok := false;
      v_detail := 'no admin user to test as';
    ELSE
      FOR v_fn IN
        SELECT p.proname::text AS fname,
               p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
               p.pronargs = p.pronargdefaults AS callable
          FROM pg_proc p
          JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.prokind = 'f'
           AND (p.proname LIKE 'admin\_get\_%' OR p.proname LIKE 'admin\_list\_%')
         ORDER BY 2
      LOOP
        IF NOT v_fn.callable THEN
          v_noargs := array_append(v_noargs, v_fn.sig);
          CONTINUE;
        END IF;
        v_total := v_total + 1;
        BEGIN
          PERFORM set_config('request.jwt.claims',
                             json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
          EXECUTE format('SELECT count(*) FROM public.%I()', v_fn.fname);
          RAISE EXCEPTION USING ERRCODE = 'ZZG09';
        EXCEPTION
          WHEN SQLSTATE 'ZZG09' THEN
            NULL;
          WHEN OTHERS THEN
            v_bad := array_append(v_bad, v_fn.sig || ' ' || SQLSTATE || ' ' || left(SQLERRM, 60));
        END;
      END LOOP;
      v_n := coalesce(cardinality(v_bad), 0);
      v_ok := v_total > 0 AND v_n = 0;
      v_detail := CASE WHEN v_total = 0 THEN '0 admin read RPCs callable without args found'
                       ELSE v_n || ' of ' || v_total || ' admin read RPCs fail when called as an admin'
                            || CASE WHEN v_n = 0 THEN '' ELSE ': ' || array_to_string(v_bad, '; ') END END
                  || CASE WHEN v_noargs IS NULL THEN ''
                          ELSE '; not callable without args: ' || array_to_string(v_noargs, ', ') END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'admin_read_rpcs_callable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G10 (078): no public admin_* function executable by anon, and none with
  -- an ACL entry for PUBLIC (grantee 0; a NULL proacl means the default
  -- PUBLIC EXECUTE, so acldefault is expanded). Written by exclusion over
  -- every admin_* function in public, all overloads. Zero admin_* functions
  -- found is a failure, not an all-clear. Supabase default privileges grant
  -- EXECUTE to anon on new functions, so a new admin_* function turns this
  -- red until it is revoked.
  BEGIN
    SELECT count(*),
           array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                     ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))
             FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
                        OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                    WHERE a.grantee = 0))
      INTO v_total, v_bad
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname LIKE 'admin\_%';
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 admin_* functions found'
                     ELSE v_n || ' of ' || v_total || ' admin_* functions executable by anon'
                          || CASE WHEN v_n = 0 THEN '' ELSE ': ' || array_to_string(v_bad, ', ') END END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'admin_rpcs_not_anon'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G10 (086): every check-in RPC a signed-in user can call with an event
  -- id refuses a stranger to that event. Written by exclusion: it covers
  -- every public function whose first argument is p_event_id uuid and that
  -- authenticated may EXECUTE, so a new RPC is checked the day it ships.
  -- The bug class it catches: `IF ... NOT (owner OR role = 'organizer')`
  -- where the role is NULL for a stranger, so the IF is NULL and the
  -- SECURITY DEFINER body runs (checkin_update_event_details and
  -- checkin_set_alert_ticket_types, both fixed in 086).
  -- Each call impersonates a random user id against a real check-in event
  -- (other arguments NULL) and ends in a private SQLSTATE so the subblock
  -- rolls back, as G9 does. Pass: 42501. A STABLE/IMMUTABLE function may
  -- instead answer NULL or false, which tells a stranger nothing
  -- (checkin_is_owner, checkin_role_for_event). A VOLATILE function that
  -- does not raise 42501 fails, whatever it returns. No event to test
  -- against, or no function in scope, is a failure, not an all-clear.
  BEGIN
    v_bad := NULL; v_total := 0; v_refused := 0;
    SELECT event_id INTO v_ev FROM leod_checkin_entitlements WHERE checkin_core ORDER BY event_id LIMIT 1;
    IF v_ev IS NULL THEN
      v_ok := false;
      v_detail := 'no check-in event to test against';
    ELSE
      FOR v_fn IN
        SELECT p.proname::text AS fname,
               p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
               p.provolatile = 'v' AS writes,
               (SELECT string_agg(', NULL::' || format_type(t, NULL), '' ORDER BY i)
                  FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(t, i) WHERE i > 1) AS rest
          FROM pg_proc p
          JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.prokind = 'f'
           AND p.pronargs >= 1
           AND p.proargtypes[0] = 'uuid'::regtype
           AND (p.proargnames)[1] = 'p_event_id'
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
         ORDER BY 2
      LOOP
        v_total := v_total + 1;
        BEGIN
          PERFORM set_config('request.jwt.claims',
                             json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
          EXECUTE format('SELECT public.%I(%L::uuid%s)::text', v_fn.fname, v_ev, coalesce(v_fn.rest, '')) INTO v_res;
          IF v_fn.writes OR NOT (v_res IS NULL OR v_res = 'false') THEN
            v_bad := array_append(v_bad, v_fn.sig || ' answered a stranger'
                                  || CASE WHEN v_fn.writes THEN ' (writes)' ELSE ': ' || left(v_res, 40) END);
          ELSE
            v_refused := v_refused + 1;
          END IF;
          RAISE EXCEPTION USING ERRCODE = 'ZZG10';
        EXCEPTION
          WHEN SQLSTATE 'ZZG10' THEN
            NULL;
          WHEN insufficient_privilege THEN
            v_refused := v_refused + 1;
          WHEN OTHERS THEN
            v_bad := array_append(v_bad, v_fn.sig || ' ' || SQLSTATE || ' ' || left(SQLERRM, 60));
        END;
      END LOOP;
      v_n := coalesce(cardinality(v_bad), 0);
      v_ok := v_total > 0 AND v_n = 0;
      v_detail := CASE WHEN v_total = 0 THEN '0 event RPCs callable by authenticated found'
                       ELSE v_n || ' of ' || v_total || ' event RPCs do not refuse a stranger'
                            || CASE WHEN v_n = 0 THEN '' ELSE ': ' || array_to_string(v_bad, '; ') END END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_rpcs_refuse_strangers'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G11 (092): no post-event report is parked. A report is parked after
  -- five failed sends (owner deleted, no email, address rejected); the
  -- sender stops retrying it, so without this guard the failure would go
  -- quiet after the fifth run. Event ids and the last error only.
  BEGIN
    SELECT count(*), array_agg(e.event_id::text || ': ' || left(coalesce(e.report_last_error, '?'), 80) ORDER BY e.event_id)
      INTO v_n, v_bad
      FROM leod_checkin_entitlements e
     WHERE e.status = 'live' AND e.report_sent_at IS NULL AND e.report_attempts >= 5;
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_ok THEN 'no post-event report is parked'
                     ELSE v_n || ' report(s) parked after 5 failed sends: ' || array_to_string(v_bad, '; ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_reports_not_parked'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G12 (094): leod_sessions_archive has every column leod_sessions has.
  -- The nightly archive upserts select('*') rows, so one missing column
  -- fails every run (seq did, from 004 until 094). By exclusion over the
  -- live columns of leod_sessions, so a column added tomorrow is caught.
  -- No leod_sessions columns found is a failure, not an all-clear; a
  -- missing archive table lists every column as missing.
  BEGIN
    SELECT count(*),
           array_agg(s.attname::text ORDER BY s.attnum) FILTER (WHERE a.attname IS NULL)
      INTO v_total, v_bad
      FROM pg_attribute s
      LEFT JOIN pg_attribute a
             ON a.attrelid = to_regclass('public.leod_sessions_archive')
            AND a.attname = s.attname
            AND a.attnum > 0
            AND NOT a.attisdropped
     WHERE s.attrelid = to_regclass('public.leod_sessions')
       AND s.attnum > 0
       AND NOT s.attisdropped;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 leod_sessions columns found'
                     WHEN v_n = 0 THEN 'leod_sessions_archive has all ' || v_total || ' leod_sessions columns'
                     ELSE v_n || ' of ' || v_total || ' leod_sessions columns missing from leod_sessions_archive: '
                          || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'sessions_archive_has_every_column'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G13 (095): no leod_* table has a write policy any signed-in user (or
  -- anyone) passes unconditionally. By exclusion over every permissive
  -- INSERT/UPDATE/DELETE/ALL policy on public.leod_* that applies to
  -- authenticated, anon or PUBLIC: it fails when its USING or WITH CHECK
  -- is missing where the command needs it, 'true', or only
  -- auth.role() = 'authenticated'. That is the shape that let any account
  -- write any event's log, broadcast, clock, commands and reports until
  -- 095. Also flagged: an expression that references neither a column
  -- (VAR) nor a function (FUNCEXPR), e.g. 1 = 1. No leod_* policy found
  -- is a failure.
  BEGIN
    SELECT count(*),
           array_agg(DISTINCT c.relname || '.' || p.polname) FILTER (WHERE
             (p.polcmd IN ('w', 'd', '*')
              AND (p.polqual IS NULL
                   OR pg_get_expr(p.polqual, p.polrelid) IN ('true', '(auth.role() = ''authenticated''::text)')
                   OR (p.polqual::text NOT LIKE '%{VAR %' AND p.polqual::text NOT LIKE '%{FUNCEXPR %')))
             OR (p.polcmd IN ('a', 'w', '*')
                 AND (coalesce(pg_get_expr(p.polwithcheck, p.polrelid), pg_get_expr(p.polqual, p.polrelid), 'true')
                        IN ('true', '(auth.role() = ''authenticated''::text)')
                      OR (coalesce(p.polwithcheck, p.polqual)::text NOT LIKE '%{VAR %'
                          AND coalesce(p.polwithcheck, p.polqual)::text NOT LIKE '%{FUNCEXPR %'))))
      INTO v_total, v_bad
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relname LIKE 'leod\_%'
       AND p.polpermissive
       AND p.polcmd IN ('a', 'w', 'd', '*')
       AND (0::oid = ANY (p.polroles)
            OR 'authenticated'::regrole::oid = ANY (p.polroles)
            OR 'anon'::regrole::oid = ANY (p.polroles));
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 leod_* write policies found'
                     WHEN v_n = 0 THEN 'none of ' || v_total || ' leod_* write policies is unconditional'
                     ELSE v_n || ' unconditional leod_* write policies: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'leod_writes_not_unconditional'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;
  -- G14 (101, 102): the public registration paths stay private. Written by
  -- exclusion over names, so a new checkin_web_* function or
  -- leod_checkin_web_* table is covered the day it ships: no such function
  -- may be executable by anon or authenticated, and every such table must
  -- have RLS on and no anon/authenticated privilege at all. The public caller
  -- reaches them only through the checkin-register Edge Function.
  BEGIN
    v_bad := NULL; v_total := 0;
    FOR v_fn IN
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig, p.oid
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname LIKE 'checkin\_web\_%'
    LOOP
      v_total := v_total + 1;
      IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
        v_bad := array_append(v_bad, v_fn.sig || ' executable by anon/authenticated');
      END IF;
    END LOOP;
    FOR v_fn IN
      SELECT c.relname::text AS sig, c.oid, c.relrowsecurity
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'leod\_checkin\_web\_%'
    LOOP
      v_total := v_total + 1;
      IF NOT v_fn.relrowsecurity THEN v_bad := array_append(v_bad, v_fn.sig || ' has RLS off'); END IF;
      IF has_table_privilege('anon', v_fn.oid, 'SELECT,INSERT,UPDATE,DELETE')
         OR has_table_privilege('authenticated', v_fn.oid, 'SELECT,INSERT,UPDATE,DELETE') THEN
        v_bad := array_append(v_bad, v_fn.sig || ' granted to anon/authenticated');
      END IF;
    END LOOP;
    -- (102) and their sequences, which a bigserial creates with its own grants.
    FOR v_fn IN
      SELECT c.relname::text AS sig, c.oid
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'S' AND c.relname LIKE 'leod\_checkin\_web\_%'
    LOOP
      v_total := v_total + 1;
      IF has_sequence_privilege('anon', v_fn.oid, 'USAGE,SELECT,UPDATE')
         OR has_sequence_privilege('authenticated', v_fn.oid, 'USAGE,SELECT,UPDATE') THEN
        v_bad := array_append(v_bad, v_fn.sig || ' (sequence) granted to anon/authenticated');
      END IF;
    END LOOP;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 checkin_web_* functions or tables found'
                     WHEN v_n = 0 THEN 'all ' || v_total || ' web registration functions and tables are private'
                     ELSE array_to_string(v_bad, '; ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_web_paths_private'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G15 (103): no event's registration mail cap was hit in the last 24
  -- hours. A hit means guests were told "check your email" and no email went
  -- (an attack, or a popular event outgrowing the cap); either way a person
  -- must look. Rows come from checkin_web_request.
  BEGIN
    SELECT count(*), string_agg(DISTINCT event_id::text, ', ') INTO v_n, v_detail
      FROM leod_checkin_web_trips WHERE at > now() - interval '24 hours';
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no registration mail cap hit in 24 h'
                     ELSE v_n || ' mail cap hits in 24 h, events: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_web_mail_cap_not_hit'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G16 (109): no paid-ticket order is left open well past its expiry. The
  -- checkin-orders-sweep cron settles every open order with Stripe within
  -- minutes of expiry; one still open 20 minutes later means the sweep is
  -- not running or cannot reach Stripe, and a guest who paid may have no
  -- ticket. Checks every order, so a new path that creates orders is
  -- covered without changes here.
  BEGIN
    SELECT count(*), string_agg(DISTINCT event_id::text, ', ') INTO v_n, v_detail
      FROM leod_checkin_web_orders WHERE status = 'open' AND expires_at < now() - interval '20 minutes';
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no paid-ticket order left open past its expiry'
                     ELSE v_n || ' orders still open 20 min past expiry, events: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_orders_settled'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G17 (110): no reminder left unsent once doors opened, for an event whose
  -- reminders were going out (some guests got theirs). Guests registered in
  -- the last 30 minutes before doors are not counted. A dead cron shows as a
  -- stale checkin-reminders job instead; this catches sends that keep failing.
  BEGIN
    SELECT count(*), string_agg(DISTINCT a.event_id::text, ', ') INTO v_n, v_detail
      FROM leod_checkin_attendees a
      JOIN leod_checkin_entitlements e ON e.event_id = a.event_id
      JOIN leod_events ev ON ev.id = a.event_id
     WHERE e.status = 'live' AND e.reminder_enabled AND NOT a.is_test AND a.email IS NOT NULL AND a.email <> ''
       AND now() >= checkin_event_doors(ev.date, ev.event_start, ev.timezone)
       AND now() <  checkin_event_doors(ev.date, ev.event_start, ev.timezone) + interval '3 days'
       AND a.created_at < checkin_event_doors(ev.date, ev.event_start, ev.timezone) - interval '30 minutes'
       AND (a.checked_in_at IS NULL OR a.checked_in_at >= checkin_event_doors(ev.date, ev.event_start, ev.timezone))
       AND EXISTS (SELECT 1 FROM leod_checkin_reminder_sends s WHERE s.event_id = a.event_id AND s.kind = 'reminder')
       AND NOT EXISTS (SELECT 1 FROM leod_checkin_reminder_sends s WHERE s.attendee_id = a.id AND s.kind = 'reminder');
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'every due reminder went out before doors opened'
                     ELSE v_n || ' guests got no reminder before doors opened, events: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_reminders_sent'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;
END;
$function$
;
