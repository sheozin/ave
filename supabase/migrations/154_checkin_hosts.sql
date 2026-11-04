-- 154_checkin_hosts.sql
-- Hosts: people who want to know the moment their guests arrive (a sales
-- lead and their clients, speaker care and the speakers). The organizer
-- adds a host with a name and email and says which guests are theirs: by
-- company, by ticket type, or picked one by one. When one of those guests
-- checks in, the host gets an email (checkin-host-notices, every minute).
--
-- Abuse limits, because the organizer types the email address of someone
-- who never signed up:
--   * every email carries a stop link (checkin_host_stop); a stopped
--     address is kept in leod_checkin_host_stops, apart from the host row, so
--     deleting and re-adding the host, or editing it, cannot undo the stop;
--   * at most 50 hosts an event, and the sender caps each address at 60
--     emails a day and each event at 600 (several arrivals in one minute are
--     one email, at most 25 guests each). Counted from leod_checkin_host_emails,
--     one row per email sent, which deleting a host does not touch;
--   * test mode never emails: the notice is recorded as 'test' so the
--     organizer can see who would have been told.
-- The trigger that queues notices can never block a check-in: any error in
-- it is caught and logged.

CREATE TABLE IF NOT EXISTS leod_checkin_hosts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email        text        NOT NULL CHECK (length(email) <= 254 AND email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$'),
  companies    text[]      NOT NULL DEFAULT '{}',
  ticket_types text[]      NOT NULL DEFAULT '{}',
  attendee_ids uuid[]      NOT NULL DEFAULT '{}',
  stop_token   text        NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(24), 'hex'),
  stopped_at   timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS leod_checkin_hosts_email ON leod_checkin_hosts (event_id, lower(email));
ALTER TABLE leod_checkin_hosts ENABLE ROW LEVEL SECURITY;
-- No policies: read and written only through the functions below, so the
-- stop token never reaches a browser.
REVOKE ALL ON leod_checkin_hosts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS leod_checkin_host_notices (
  id            bigserial   PRIMARY KEY,
  event_id      uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  host_id       uuid        NOT NULL REFERENCES leod_checkin_hosts(id) ON DELETE CASCADE,
  attendee_id   uuid        NOT NULL REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  checked_in_at timestamptz NOT NULL,
  is_test       boolean     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  resend_id     text,
  skipped       text        CHECK (skipped IN ('test', 'stopped', 'undone', 'cap', 'failed', 'late')),
  claimed_at    timestamptz,  -- taken by a sender run (checkin_host_notices_claim)
  UNIQUE (host_id, attendee_id, checked_in_at)
);
CREATE INDEX IF NOT EXISTS leod_checkin_host_notices_open ON leod_checkin_host_notices (created_at)
  WHERE sent_at IS NULL AND skipped IS NULL;
CREATE INDEX IF NOT EXISTS leod_checkin_host_notices_event ON leod_checkin_host_notices (event_id, created_at DESC);
ALTER TABLE leod_checkin_host_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_host_notices FROM anon, authenticated;
REVOKE ALL ON SEQUENCE leod_checkin_host_notices_id_seq FROM anon, authenticated;

-- Addresses that pressed stop, per event. Not tied to the host row.
CREATE TABLE IF NOT EXISTS leod_checkin_host_stops (
  event_id   uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  email      text        NOT NULL,
  stopped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, email)
);
ALTER TABLE leod_checkin_host_stops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_host_stops FROM anon, authenticated;

-- One row per email sent, for the caps. Not tied to the host row either.
CREATE TABLE IF NOT EXISTS leod_checkin_host_emails (
  id        bigserial   PRIMARY KEY,
  event_id  uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  email     text        NOT NULL,
  resend_id text        NOT NULL,
  guests    int         NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leod_checkin_host_emails_event ON leod_checkin_host_emails (event_id, sent_at);
CREATE INDEX IF NOT EXISTS leod_checkin_host_emails_to ON leod_checkin_host_emails (event_id, email, sent_at);
ALTER TABLE leod_checkin_host_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_host_emails FROM anon, authenticated;
REVOKE ALL ON SEQUENCE leod_checkin_host_emails_id_seq FROM anon, authenticated;

-- Same matching as the alert ticket types (087): trimmed, inner spaces
-- collapsed, case-insensitive.
CREATE OR REPLACE FUNCTION checkin_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT NULLIF(lower(btrim(regexp_replace(COALESCE(p, ''), '\s+', ' ', 'g'))), '') $$;

CREATE OR REPLACE FUNCTION checkin_queue_host_notices()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.checked_in_at IS NULL OR (TG_OP = 'UPDATE' AND OLD.checked_in_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  BEGIN
    INSERT INTO leod_checkin_host_notices (event_id, host_id, attendee_id, checked_in_at, is_test)
    SELECT NEW.event_id, h.id, NEW.id, NEW.checked_in_at, en.status IS DISTINCT FROM 'live'
      FROM leod_checkin_hosts h
      JOIN leod_checkin_entitlements en ON en.event_id = h.event_id
     WHERE h.event_id = NEW.event_id
       AND h.stopped_at IS NULL
       AND (NEW.id = ANY (h.attendee_ids)
            OR checkin_norm(NEW.company) IN (SELECT checkin_norm(x) FROM unnest(h.companies) x)
            OR checkin_norm(NEW.ticket_type) IN (SELECT checkin_norm(x) FROM unnest(h.ticket_types) x))
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- A host email is a courtesy; the check-in is not.
    RAISE WARNING 'checkin_queue_host_notices: % %', SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION checkin_queue_host_notices() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS checkin_host_notices ON leod_checkin_attendees;
CREATE TRIGGER checkin_host_notices AFTER INSERT OR UPDATE OF checked_in_at ON leod_checkin_attendees
  FOR EACH ROW EXECUTE FUNCTION checkin_queue_host_notices();

-- Clean a list typed by the organizer: trimmed, inner spaces collapsed,
-- blanks and repeats (case-insensitive) dropped, first spelling kept.
CREATE OR REPLACE FUNCTION checkin_clean_list(p text[])
RETURNS text[] LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(t ORDER BY first_i), '{}')
    FROM (SELECT min(i) AS first_i, (array_agg(t ORDER BY i))[1] AS t
            FROM (SELECT btrim(regexp_replace(x, '\s+', ' ', 'g')) AS t, i
                    FROM unnest(COALESCE(p, '{}')) WITH ORDINALITY AS u(x, i)) s
           WHERE t <> ''
           GROUP BY lower(t)) d
$$;

-- The hosts of an event, with how many guests are theirs and how many
-- arrivals they were told about. Organizer only. No stop token.
CREATE OR REPLACE FUNCTION checkin_hosts_list(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can manage hosts' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', h.id, 'name', h.name, 'email', h.email,
      'companies', to_jsonb(h.companies), 'ticket_types', to_jsonb(h.ticket_types), 'attendee_ids', to_jsonb(h.attendee_ids),
      'stopped_at', h.stopped_at,
      'guests', (SELECT count(*) FROM leod_checkin_attendees a
                  WHERE a.event_id = h.event_id
                    AND (a.id = ANY (h.attendee_ids)
                         OR checkin_norm(a.company) IN (SELECT checkin_norm(x) FROM unnest(h.companies) x)
                         OR checkin_norm(a.ticket_type) IN (SELECT checkin_norm(x) FROM unnest(h.ticket_types) x))),
      'told', (SELECT count(*) FROM leod_checkin_host_notices n WHERE n.host_id = h.id AND n.sent_at IS NOT NULL),
      'would_tell', (SELECT count(*) FROM leod_checkin_host_notices n WHERE n.host_id = h.id AND n.is_test),
      'not_sent', (SELECT count(*) FROM leod_checkin_host_notices n WHERE n.host_id = h.id AND n.skipped IN ('cap', 'late', 'failed')),
      'last_told_at', (SELECT max(n.sent_at) FROM leod_checkin_host_notices n WHERE n.host_id = h.id)
    ) ORDER BY h.created_at), '[]'::jsonb)
      FROM leod_checkin_hosts h WHERE h.event_id = p_event_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_hosts_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_hosts_list(uuid) TO authenticated;

-- Add (p_host_id NULL) or change a host. A new email address is a new
-- person: it gets a new stop token and starts unstopped. The same address
-- keeps its stop.
CREATE OR REPLACE FUNCTION checkin_host_save(p_event_id uuid, p_host_id uuid, p_name text, p_email text,
  p_companies text[], p_ticket_types text[], p_attendee_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name  text := btrim(regexp_replace(COALESCE(p_name, ''), '\s+', ' ', 'g'));
  v_email text := lower(btrim(COALESCE(p_email, '')));
  v_comp  text[] := checkin_clean_list(p_companies);
  v_tix   text[] := checkin_clean_list(p_ticket_types);
  v_ids   uuid[];
  v_old   text;
  v_id    uuid;
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can manage hosts' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'The host needs a name, at most 120 characters' USING ERRCODE = '22023';
  END IF;
  IF length(v_email) > 254 OR v_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$' THEN
    RAISE EXCEPTION 'Enter the host''s email address' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_comp) > 50 OR cardinality(v_tix) > 50 OR cardinality(COALESCE(p_attendee_ids, '{}')) > 500
     OR EXISTS (SELECT 1 FROM unnest(v_comp || v_tix) t WHERE length(t) > 120) THEN
    RAISE EXCEPTION 'At most 50 companies, 50 ticket types and 500 guests a host' USING ERRCODE = '22023';
  END IF;
  -- Only guests of this event.
  SELECT COALESCE(array_agg(a.id ORDER BY a.id), '{}') INTO v_ids
    FROM leod_checkin_attendees a WHERE a.event_id = p_event_id AND a.id = ANY (COALESCE(p_attendee_ids, '{}'));
  IF cardinality(v_comp) + cardinality(v_tix) + cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'Choose which guests are this host''s: a company, a ticket type or guests' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('checkin_hosts:' || p_event_id::text));
  IF p_host_id IS NULL THEN
    IF (SELECT count(*) FROM leod_checkin_hosts WHERE event_id = p_event_id) >= 50 THEN
      RAISE EXCEPTION 'At most 50 hosts an event' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM leod_checkin_hosts WHERE event_id = p_event_id AND lower(email) = v_email) THEN
      RAISE EXCEPTION 'A host with this email address is already on the list' USING ERRCODE = '23505';
    END IF;
    -- An address that pressed stop stays stopped, however it comes back.
    INSERT INTO leod_checkin_hosts (event_id, name, email, companies, ticket_types, attendee_ids, created_by, stopped_at)
    VALUES (p_event_id, v_name, v_email, v_comp, v_tix, v_ids, auth.uid(),
            (SELECT s.stopped_at FROM leod_checkin_host_stops s WHERE s.event_id = p_event_id AND s.email = v_email))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  SELECT lower(email) INTO v_old FROM leod_checkin_hosts WHERE id = p_host_id AND event_id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Host not found' USING ERRCODE = 'P0002'; END IF;
  IF v_old <> v_email AND EXISTS (SELECT 1 FROM leod_checkin_hosts WHERE event_id = p_event_id AND lower(email) = v_email) THEN
    RAISE EXCEPTION 'A host with this email address is already on the list' USING ERRCODE = '23505';
  END IF;
  UPDATE leod_checkin_hosts
     SET name = v_name, email = v_email, companies = v_comp, ticket_types = v_tix, attendee_ids = v_ids,
         stop_token = CASE WHEN v_old = v_email THEN stop_token ELSE encode(extensions.gen_random_bytes(24), 'hex') END,
         stopped_at = CASE WHEN v_old = v_email THEN stopped_at
                           ELSE (SELECT s.stopped_at FROM leod_checkin_host_stops s WHERE s.event_id = p_event_id AND s.email = v_email) END
   WHERE id = p_host_id;
  -- Arrivals queued for the old address are not the new person's news.
  IF v_old <> v_email THEN
    UPDATE leod_checkin_host_notices SET skipped = 'stopped' WHERE host_id = p_host_id AND sent_at IS NULL AND skipped IS NULL;
  END IF;
  RETURN p_host_id;
END;
$$;
REVOKE ALL ON FUNCTION checkin_host_save(uuid, uuid, text, text, text[], text[], uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_host_save(uuid, uuid, text, text, text[], text[], uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION checkin_host_delete(p_event_id uuid, p_host_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can manage hosts' USING ERRCODE = '42501';
  END IF;
  DELETE FROM leod_checkin_hosts WHERE id = p_host_id AND event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Host not found' USING ERRCODE = 'P0002'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION checkin_host_delete(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_host_delete(uuid, uuid) TO authenticated;

-- The stop link. Called by the public page /checkin/host-stop after the
-- host presses the button (a plain link visit stops nothing, so a mail
-- scanner opening the link cannot). Answers the event name either way, so
-- the page can say what was stopped; an unknown token answers NULL.
CREATE OR REPLACE FUNCTION checkin_host_stop(p_token text, p_confirm boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_host leod_checkin_hosts%ROWTYPE;
  v_event text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{48}$' THEN RETURN NULL; END IF;
  SELECT * INTO v_host FROM leod_checkin_hosts WHERE stop_token = p_token;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT name INTO v_event FROM leod_events WHERE id = v_host.event_id;
  IF COALESCE(p_confirm, false) AND v_host.stopped_at IS NULL THEN
    UPDATE leod_checkin_hosts SET stopped_at = now() WHERE id = v_host.id;
    INSERT INTO leod_checkin_host_stops (event_id, email) VALUES (v_host.event_id, lower(v_host.email)) ON CONFLICT DO NOTHING;
    UPDATE leod_checkin_host_notices SET skipped = 'stopped' WHERE host_id = v_host.id AND sent_at IS NULL AND skipped IS NULL;
    v_host.stopped_at := now();
  END IF;
  RETURN jsonb_build_object('event', v_event, 'stopped', v_host.stopped_at IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION checkin_host_stop(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkin_host_stop(text, boolean) TO anon, authenticated;

-- The sender takes its rows here, so two runs that overlap (a slow Resend)
-- never pick the same notice. A claim older than 5 minutes is a run that
-- died, and its rows are taken again.
CREATE OR REPLACE FUNCTION checkin_host_notices_claim(p_limit int)
RETURNS SETOF bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE leod_checkin_host_notices n SET claimed_at = now()
   WHERE n.id IN (SELECT x.id FROM leod_checkin_host_notices x
                   WHERE x.sent_at IS NULL AND x.skipped IS NULL AND NOT x.is_test
                     AND x.created_at < now() - interval '30 seconds'
                     AND (x.claimed_at IS NULL OR x.claimed_at < now() - interval '5 minutes')
                   ORDER BY x.created_at LIMIT LEAST(GREATEST(p_limit, 1), 1000)
                   FOR UPDATE SKIP LOCKED)
  RETURNING n.id
$$;
REVOKE ALL ON FUNCTION checkin_host_notices_claim(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_host_notices_claim(int) TO service_role;

-- The sender's secret check (same pattern as 150).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'checkin_host_notices_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'checkin_host_notices_cron_secret',
      'x-cron-secret for checkin-host-notices (migration 154)');
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.checkin_host_notices_cron_ok(p_secret text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(length(p_secret) >= 32 AND p_secret = (
    SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'checkin_host_notices_cron_secret'), false);
$$;
REVOKE ALL ON FUNCTION public.checkin_host_notices_cron_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_host_notices_cron_ok(text) TO service_role;

SELECT cron.unschedule('checkin-host-notices') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkin-host-notices');
SELECT cron.schedule('checkin-host-notices', '* * * * *', $cron$
  SELECT net.http_post(
    url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-host-notices',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'checkin_host_notices_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);
$cron$);

-- Watched like the other jobs (075).
INSERT INTO leod_checkin_jobs (job_name, expected_interval, note)
VALUES ('checkin-host-notices', interval '10 minutes', 'Emails hosts when their guests check in (migration 154)')
ON CONFLICT (job_name) DO NOTHING;
