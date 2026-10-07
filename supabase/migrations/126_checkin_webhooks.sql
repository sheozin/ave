-- 126_checkin_webhooks.sql
-- Webhooks: the organizer's own systems (Zapier, Make, a CRM) hear about
--   guest.created         a guest was added (any source), live events only
--   guest.checked_in      a guest checked in
--   order.paid            a ticket was paid
--   invitation.answered   an invited guest said coming or not coming
--
-- Triggers write a delivery per subscribed webhook into
-- leod_checkin_webhook_deliveries (an outbox); they never fail the write
-- that fired them (errors go to leod_checkin_link_errors, guard G18). The
-- Edge Function checkin-webhooks sends the outbox every minute (pg_cron, a
-- watched job), signed: header X-CueDeck-Signature "t=<unix>,v1=<hex>",
-- v1 = HMAC-SHA256(secret, "<t>.<body>"). Failures retry after 1, 5, 30,
-- 120 and 360 minutes, then the delivery is marked failed. Guard G20
-- reports deliveries overdue by 15 minutes (the sender is not running).
--
-- Only https URLs; the sender refuses private, loopback and link-local
-- addresses after resolving the name, and does not follow redirects.

CREATE TABLE IF NOT EXISTS leod_checkin_webhooks (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  url        text        NOT NULL CHECK (url ~ '^https://[^\s/?#]+[^\s]*$' AND char_length(url) <= 500),
  secret     text        NOT NULL,
  topics     text[]      NOT NULL CHECK (topics <@ ARRAY['guest.created', 'guest.checked_in', 'order.paid', 'invitation.answered'] AND cardinality(topics) > 0),
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_status text,
  last_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_checkin_webhooks_event ON leod_checkin_webhooks (event_id) WHERE active;
ALTER TABLE leod_checkin_webhooks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_webhooks FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS leod_checkin_webhook_deliveries (
  id          bigserial   PRIMARY KEY,
  webhook_id  uuid        NOT NULL REFERENCES leod_checkin_webhooks(id) ON DELETE CASCADE,
  topic       text        NOT NULL,
  payload     jsonb       NOT NULL,
  status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    int         NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_checkin_webhook_deliveries_due ON leod_checkin_webhook_deliveries (next_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_checkin_webhook_deliveries_hook ON leod_checkin_webhook_deliveries (webhook_id, created_at DESC);
ALTER TABLE leod_checkin_webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_webhook_deliveries FROM anon, authenticated;
REVOKE ALL ON SEQUENCE leod_checkin_webhook_deliveries_id_seq FROM anon, authenticated;

-- Queue one topic for an event's subscribed webhooks.
CREATE OR REPLACE FUNCTION checkin_webhook_enqueue(p_event_id uuid, p_topic text, p_data jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO leod_checkin_webhook_deliveries (webhook_id, topic, payload)
  SELECT w.id, p_topic, jsonb_build_object('topic', p_topic, 'event_id', p_event_id,
           'event_name', (SELECT name FROM leod_events WHERE id = p_event_id), 'occurred_at', now(), 'data', p_data)
    FROM leod_checkin_webhooks w
   WHERE w.event_id = p_event_id AND w.active AND p_topic = ANY (w.topics);
$$;
REVOKE ALL ON FUNCTION checkin_webhook_enqueue(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_webhook_guest(a leod_checkin_attendees)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object('guest_id', a.id, 'first_name', a.first_name, 'last_name', a.last_name, 'email', a.email,
    'company', a.company, 'ticket_type', a.ticket_type, 'source', a.source, 'registered_via', a.reg_source,
    'guest_of', a.plus_one_of, 'answers', a.custom_fields, 'checked_in_at', a.checked_in_at, 'created_at', a.created_at);
$$;
REVOKE ALL ON FUNCTION checkin_webhook_guest(leod_checkin_attendees) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_webhook_on_guest()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NEW.is_test OR NOT EXISTS (SELECT 1 FROM leod_checkin_webhooks WHERE event_id = NEW.event_id AND active) THEN RETURN NULL; END IF;
    IF TG_OP = 'INSERT' THEN
      PERFORM checkin_webhook_enqueue(NEW.event_id, 'guest.created', checkin_webhook_guest(NEW));
      IF NEW.checked_in_at IS NOT NULL THEN PERFORM checkin_webhook_enqueue(NEW.event_id, 'guest.checked_in', checkin_webhook_guest(NEW)); END IF;
    ELSIF OLD.checked_in_at IS NULL AND NEW.checked_in_at IS NOT NULL THEN
      PERFORM checkin_webhook_enqueue(NEW.event_id, 'guest.checked_in', checkin_webhook_guest(NEW));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN INSERT INTO leod_checkin_link_errors (event_id, detail) VALUES (NEW.event_id, left('webhook guest: ' || SQLSTATE || ' ' || SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhook_on_guest() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_checkin_webhook_guest_ins ON leod_checkin_attendees;
CREATE TRIGGER trg_checkin_webhook_guest_ins AFTER INSERT ON leod_checkin_attendees FOR EACH ROW EXECUTE FUNCTION checkin_webhook_on_guest();
DROP TRIGGER IF EXISTS trg_checkin_webhook_guest_upd ON leod_checkin_attendees;
CREATE TRIGGER trg_checkin_webhook_guest_upd AFTER UPDATE OF checked_in_at ON leod_checkin_attendees FOR EACH ROW EXECUTE FUNCTION checkin_webhook_on_guest();

CREATE OR REPLACE FUNCTION checkin_webhook_on_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
      PERFORM checkin_webhook_enqueue(NEW.event_id, 'order.paid', jsonb_build_object('order_id', NEW.id, 'guest_id', NEW.attendee_id,
        'first_name', NEW.first_name, 'last_name', NEW.last_name, 'email', NEW.email, 'ticket', NEW.ticket_name,
        'amount_cents', NEW.amount_cents, 'currency', NEW.currency, 'paid_at', NEW.paid_at));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN INSERT INTO leod_checkin_link_errors (event_id, detail) VALUES (NEW.event_id, left('webhook order: ' || SQLSTATE || ' ' || SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhook_on_order() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_checkin_webhook_order ON leod_checkin_web_orders;
CREATE TRIGGER trg_checkin_webhook_order AFTER UPDATE OF status ON leod_checkin_web_orders FOR EACH ROW EXECUTE FUNCTION checkin_webhook_on_order();

CREATE OR REPLACE FUNCTION checkin_webhook_on_rsvp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a leod_checkin_attendees;
BEGIN
  BEGIN
    IF NEW.rsvp IS NOT NULL AND NEW.rsvp IS DISTINCT FROM OLD.rsvp THEN
      SELECT * INTO a FROM leod_checkin_attendees WHERE id = NEW.attendee_id;
      PERFORM checkin_webhook_enqueue(NEW.event_id, 'invitation.answered',
        checkin_webhook_guest(a) || jsonb_build_object('answer', NEW.rsvp, 'answered_at', NEW.rsvp_at,
          'plus_ones', (SELECT COALESCE(jsonb_agg(jsonb_build_object('first_name', p.first_name, 'last_name', p.last_name)), '[]'::jsonb)
                          FROM leod_checkin_attendees p WHERE p.plus_one_of = a.id)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN INSERT INTO leod_checkin_link_errors (event_id, detail) VALUES (NEW.event_id, left('webhook rsvp: ' || SQLSTATE || ' ' || SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhook_on_rsvp() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_checkin_webhook_rsvp ON leod_checkin_web_invites;
CREATE TRIGGER trg_checkin_webhook_rsvp AFTER UPDATE OF rsvp ON leod_checkin_web_invites FOR EACH ROW EXECUTE FUNCTION checkin_webhook_on_rsvp();

-- ── Organizer ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_webhooks_list(p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see webhooks' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', w.id, 'url', w.url, 'topics', w.topics, 'active', w.active,
            'created_at', w.created_at, 'last_status', w.last_status, 'last_at', w.last_at,
            'pending', (SELECT count(*) FROM leod_checkin_webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending'),
            'failed', (SELECT count(*) FROM leod_checkin_webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed'))
            ORDER BY w.created_at), '[]'::jsonb)
            FROM leod_checkin_webhooks w WHERE w.event_id = p_event_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhooks_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_webhooks_list(uuid) TO authenticated;

-- Returns the signing secret: shown to the organizer once, here.
CREATE OR REPLACE FUNCTION checkin_webhook_add(p_event_id uuid, p_url text, p_topics text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row leod_checkin_webhooks; v_host text;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can add webhooks' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(p_url, '') !~ '^https://[^\s/?#]+[^\s]*$' OR char_length(p_url) > 500 THEN
    RAISE EXCEPTION 'The address must start with https://' USING ERRCODE = 'check_violation';
  END IF;
  v_host := lower(split_part(split_part(substr(p_url, 9), '/', 1), ':', 1));
  IF v_host ~ '^(localhost|.*\.local|.*\.internal|[0-9.]+|\[.*\])$' THEN
    RAISE EXCEPTION 'Use a public web address, not a local one or an IP address' USING ERRCODE = 'check_violation';
  END IF;
  IF p_topics IS NULL OR cardinality(p_topics) = 0 OR NOT (p_topics <@ ARRAY['guest.created', 'guest.checked_in', 'order.paid', 'invitation.answered']) THEN
    RAISE EXCEPTION 'Choose what to send' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM leod_checkin_webhooks WHERE event_id = p_event_id) >= 5 THEN
    RAISE EXCEPTION 'At most 5 webhooks per event' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO leod_checkin_webhooks (event_id, url, secret, topics)
  VALUES (p_event_id, p_url, 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex'), (SELECT array_agg(DISTINCT t) FROM unnest(p_topics) t))
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'secret', v_row.secret);
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhook_add(uuid, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_webhook_add(uuid, text, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION checkin_webhook_delete(p_event_id uuid, p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can remove webhooks' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM leod_checkin_webhooks WHERE id = p_id AND event_id = p_event_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhook_delete(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_webhook_delete(uuid, uuid) TO authenticated;

-- A sample delivery, so the organizer can set up the other side.
CREATE OR REPLACE FUNCTION checkin_webhook_test(p_event_id uuid, p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can test webhooks' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT count(*) FROM leod_checkin_webhook_deliveries d JOIN leod_checkin_webhooks w ON w.id = d.webhook_id
       WHERE w.id = p_id AND d.topic = 'test' AND d.created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'Ten tests an hour at most' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO leod_checkin_webhook_deliveries (webhook_id, topic, payload)
  SELECT w.id, 'test', jsonb_build_object('topic', 'test', 'event_id', p_event_id, 'event_name', (SELECT name FROM leod_events WHERE id = p_event_id),
           'occurred_at', now(), 'data', jsonb_build_object('guest_id', '00000000-0000-4000-8000-000000000000', 'first_name', 'Test',
           'last_name', 'Guest', 'email', 'test@example.com', 'company', 'Example', 'ticket_type', 'attendee'))
    FROM leod_checkin_webhooks w WHERE w.id = p_id AND w.event_id = p_event_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhook_test(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_webhook_test(uuid, uuid) TO authenticated;

-- ── Sender (service) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_webhooks_due(p_limit int)
RETURNS TABLE (id bigint, webhook_id uuid, topic text, payload jsonb, attempts int, url text, secret text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.webhook_id, d.topic, d.payload, d.attempts, w.url, w.secret
    FROM leod_checkin_webhook_deliveries d JOIN leod_checkin_webhooks w ON w.id = d.webhook_id
   WHERE d.status = 'pending' AND d.next_at <= now() AND w.active
   ORDER BY d.next_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;
REVOKE ALL ON FUNCTION checkin_webhooks_due(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_webhooks_due(int) TO service_role;

CREATE OR REPLACE FUNCTION checkin_webhook_result(p_id bigint, p_ok boolean, p_detail text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d leod_checkin_webhook_deliveries; v_status text;
BEGIN
  UPDATE leod_checkin_webhook_deliveries SET attempts = attempts + 1 WHERE id = p_id AND status = 'pending' RETURNING * INTO d;
  IF d.id IS NULL THEN RETURN 'gone'; END IF;
  IF p_ok THEN
    UPDATE leod_checkin_webhook_deliveries SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = p_id;
    v_status := 'sent';
  ELSIF d.attempts >= 6 THEN
    UPDATE leod_checkin_webhook_deliveries SET status = 'failed', last_error = left(p_detail, 300) WHERE id = p_id;
    v_status := 'failed';
  ELSE
    UPDATE leod_checkin_webhook_deliveries SET last_error = left(p_detail, 300),
           next_at = now() + (ARRAY[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours', interval '6 hours'])[d.attempts]
     WHERE id = p_id;
    v_status := 'retry';
  END IF;
  UPDATE leod_checkin_webhooks SET last_status = CASE WHEN p_ok THEN 'ok' ELSE left(p_detail, 120) END, last_at = now() WHERE id = d.webhook_id;
  RETURN v_status;
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhook_result(bigint, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_webhook_result(bigint, boolean, text) TO service_role;

-- ── The cron ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'checkin_webhooks_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'checkin_webhooks_cron_secret',
                                'x-cron-secret for the checkin-webhooks Edge Function (126)');
  END IF;
END $$;
CREATE OR REPLACE FUNCTION checkin_webhooks_cron_ok(p_secret text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(length(p_secret) >= 32 AND p_secret = (
           SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'checkin_webhooks_cron_secret'), false);
$$;
REVOKE ALL ON FUNCTION checkin_webhooks_cron_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_webhooks_cron_ok(text) TO service_role;

INSERT INTO leod_checkin_jobs (job_name, expected_interval, note)
VALUES ('checkin-webhooks', interval '1 minute', 'pg_cron -> pg_net -> Edge Function checkin-webhooks: the webhook outbox (126)')
ON CONFLICT (job_name) DO UPDATE SET expected_interval = EXCLUDED.expected_interval, note = EXCLUDED.note, active = true;
DO $$
BEGIN
  PERFORM cron.unschedule('checkin-webhooks') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkin-webhooks');
END $$;
SELECT cron.schedule('checkin-webhooks', '* * * * *', $cron$
  SELECT net.http_post(
    url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-webhooks',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'checkin_webhooks_cron_secret')),
    body    := '{}'::jsonb, timeout_milliseconds := 55000);
$cron$);

-- ── Guard G20 ─────────────────────────────────────────────────────
-- The live checkin_guard_results (through 125) with G20 added at the end.
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

  -- G18 (112): the speaker arrival link raised no error in 24 hours. The
  -- trigger swallows its errors so a check-in always goes through, and
  -- records them in leod_checkin_link_errors; this makes them visible.
  BEGIN
    SELECT count(*), string_agg(DISTINCT COALESCE(event_id::text, '?'), ', ') INTO v_n, v_detail
      FROM leod_checkin_link_errors WHERE at > now() - interval '24 hours';
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no speaker arrival link error in 24 h'
                     ELSE v_n || ' speaker arrival link errors in 24 h, events: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_speaker_link_ok'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G19 (124): no event's automatic waitlist is stuck. An event whose first
  -- waiting party fits now (checkin_web_waitlist_due) and whose waitlist
  -- was not looked at in 15 minutes means the job is not reaching it, so
  -- people stay waiting for places that are free.
  BEGIN
    SELECT count(*), string_agg(d.event_id::text, ', ') INTO v_n, v_detail
      FROM checkin_web_waitlist_due() d
      JOIN leod_checkin_entitlements e ON e.event_id = d.event_id
     WHERE e.waitlist_checked_at IS NULL OR e.waitlist_checked_at < now() - interval '15 minutes';
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no automatic waitlist left waiting with free places'
                     ELSE v_n || ' events have free places and a waitlist not moved in 15 min: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_waitlist_moving'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G20 (126): no webhook delivery overdue by 15 minutes. The sender runs
  -- every minute; a pending delivery that late means it is not running.
  BEGIN
    SELECT count(*), string_agg(DISTINCT w.event_id::text, ', ') INTO v_n, v_detail
      FROM leod_checkin_webhook_deliveries d JOIN leod_checkin_webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND w.active AND d.next_at < now() - interval '15 minutes';
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no webhook delivery overdue'
                     ELSE v_n || ' webhook deliveries overdue by 15 min, events: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_webhooks_flowing'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;
END;
$function$
;
