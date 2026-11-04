-- 158_checkin_email_limits.sql
-- Three follow-ups to hosts (154) and the client report (157):
--
--   1. What a host is told. Each host now says 'names' (each guest's name,
--      company and arrival time, as before) or 'count' (how many of their
--      guests arrived, and when, with no names). The registration page says
--      hosts may be told when an event has a host on 'names'.
--
--   2. Events nobody paid for. A live event with no paid purchase, whose
--      owner is not a comp account with full_email, could be used to send
--      CueDeck email to anyone. On such an event the client report goes
--      only to the owner's own domain (only the owner's own address when
--      that domain is a public mail provider), and host emails stop at 100
--      a day (checkin-host-notices). Comp accounts start without
--      full_email; the existing one (the founder's) keeps it.
--
--   3. The client report as a page. Each client report gets a random
--      128-bit token, and app.cuedeck.io/cr/<token> shows the same numbers
--      as the email, to save as a PDF. Numbers only, never names: the guest
--      list stays an email attachment the organizer chose to send. The link
--      works once the report has been sent, while the event is live, for
--      90 days after the event.

-- 1. Host detail ---------------------------------------------------------
ALTER TABLE leod_checkin_hosts
  ADD COLUMN IF NOT EXISTS detail text NOT NULL DEFAULT 'names' CHECK (detail IN ('names', 'count'));

DROP FUNCTION IF EXISTS checkin_host_save(uuid, uuid, text, text, text[], text[], uuid[]);
CREATE OR REPLACE FUNCTION checkin_host_save(p_event_id uuid, p_host_id uuid, p_name text, p_email text,
  p_companies text[], p_ticket_types text[], p_attendee_ids uuid[], p_detail text DEFAULT 'names')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name  text := btrim(regexp_replace(COALESCE(p_name, ''), '\s+', ' ', 'g'));
  v_email text := lower(btrim(COALESCE(p_email, '')));
  v_comp  text[] := checkin_clean_list(p_companies);
  v_tix   text[] := checkin_clean_list(p_ticket_types);
  v_detail text := COALESCE(p_detail, 'names');
  v_ids   uuid[];
  v_old   text;
  v_id    uuid;
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can manage hosts' USING ERRCODE = '42501';
  END IF;
  IF v_detail NOT IN ('names', 'count') THEN
    RAISE EXCEPTION 'Choose what the host is told: names or a count' USING ERRCODE = '22023';
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
    INSERT INTO leod_checkin_hosts (event_id, name, email, companies, ticket_types, attendee_ids, detail, created_by, stopped_at)
    VALUES (p_event_id, v_name, v_email, v_comp, v_tix, v_ids, v_detail, auth.uid(),
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
     SET name = v_name, email = v_email, companies = v_comp, ticket_types = v_tix, attendee_ids = v_ids, detail = v_detail,
         stop_token = CASE WHEN v_old = v_email THEN stop_token ELSE encode(extensions.gen_random_bytes(24), 'hex') END,
         stopped_at = CASE WHEN v_old = v_email THEN stopped_at
                           ELSE (SELECT s.stopped_at FROM leod_checkin_host_stops s WHERE s.event_id = p_event_id AND s.email = v_email) END
   WHERE id = p_host_id;
  IF v_old <> v_email THEN
    UPDATE leod_checkin_host_notices SET skipped = 'stopped' WHERE host_id = p_host_id AND sent_at IS NULL AND skipped IS NULL;
  END IF;
  RETURN p_host_id;
END;
$$;
REVOKE ALL ON FUNCTION checkin_host_save(uuid, uuid, text, text, text[], text[], uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_host_save(uuid, uuid, text, text, text[], text[], uuid[], text) TO authenticated;

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
      'id', h.id, 'name', h.name, 'email', h.email, 'detail', h.detail,
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

-- 2. Events nobody paid for ----------------------------------------------
ALTER TABLE leod_checkin_comp_accounts
  ADD COLUMN IF NOT EXISTS full_email boolean NOT NULL DEFAULT false;
-- The one comp account at the time of writing, "Full access granted by
-- Sherif 2026-10-04": the founder's own events.
UPDATE leod_checkin_comp_accounts SET full_email = true
 WHERE created_at < timestamptz '2026-11-05 00:00:00+00' AND note ILIKE 'Full access%';

-- True when the event may email anyone: paid for, or owned by a comp
-- account trusted with full email.
CREATE OR REPLACE FUNCTION checkin_event_full_email(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM leod_checkin_purchases p
                  WHERE p.event_id = p_event_id AND p.paid_at IS NOT NULL AND p.refunded_at IS NULL)
      OR EXISTS (SELECT 1 FROM leod_events e JOIN leod_checkin_comp_accounts c ON c.user_id = e.created_by
                  WHERE e.id = p_event_id AND c.full_email);
$$;
REVOKE ALL ON FUNCTION checkin_event_full_email(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_event_full_email(uuid) TO service_role;

-- Where an unpaid event's client report may go: the owner's own domain,
-- or only the owner's address when that domain is a public mail provider
-- (otherwise "gmail.com" would mean anyone). NULL owner email: nowhere.
CREATE OR REPLACE FUNCTION checkin_client_report_allowed(p_event_id uuid, p_email text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner text; v_dom text;
BEGIN
  IF checkin_event_full_email(p_event_id) THEN RETURN true; END IF;
  SELECT lower(u.email) INTO v_owner FROM leod_events e JOIN auth.users u ON u.id = e.created_by WHERE e.id = p_event_id;
  IF v_owner IS NULL OR p_email IS NULL THEN RETURN false; END IF;
  IF lower(p_email) = v_owner THEN RETURN true; END IF;
  v_dom := split_part(v_owner, '@', 2);
  IF v_dom IN ('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
               'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de',
               'gmx.net', 'web.de', 'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'yandex.ru', 'mail.ru', 'zoho.com') THEN
    RETURN false;
  END IF;
  RETURN split_part(lower(p_email), '@', 2) = v_dom;
END;
$$;
REVOKE ALL ON FUNCTION checkin_client_report_allowed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_client_report_allowed(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION checkin_client_report_set(p_event_id uuid, p_recipients text[], p_attach_guests boolean)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_list text[]; v_bad text;
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can change who gets the client report' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_list
    FROM (SELECT lower(btrim(e)) AS x FROM unnest(COALESCE(p_recipients, '{}')) e) s
   WHERE x <> '';
  SELECT x INTO v_bad FROM unnest(v_list) x
   WHERE length(x) > 254 OR x !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Not an email address: %', left(v_bad, 80) USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_list) > 5 THEN
    RAISE EXCEPTION 'Up to 5 addresses' USING ERRCODE = '22023';
  END IF;
  -- CHANGED (158): an unpaid event reports only inside the owner's domain.
  SELECT x INTO v_bad FROM unnest(v_list) x WHERE NOT checkin_client_report_allowed(p_event_id, x) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Until the event is paid for, the client report can only go to addresses at your own company: % is outside it', left(v_bad, 80)
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO leod_checkin_client_reports AS c (event_id, recipients, attach_guests)
  VALUES (p_event_id, v_list, COALESCE(p_attach_guests, false))
  ON CONFLICT (event_id) DO UPDATE
     SET recipients = EXCLUDED.recipients,
         attach_guests = EXCLUDED.attach_guests,
         attempts = CASE WHEN c.sent_at IS NULL THEN 0 ELSE c.attempts END,
         last_error = CASE WHEN c.sent_at IS NULL THEN NULL ELSE c.last_error END,
         updated_at = now();
  RETURN checkin_client_report_get(p_event_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_client_report_set(uuid, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_client_report_set(uuid, text[], boolean) TO authenticated;

-- The sender re-checks: a list saved before this migration, or an event
-- refunded since, still reports only where it may.
CREATE OR REPLACE FUNCTION checkin_client_reports_due()
RETURNS TABLE (event_id uuid, owner_id uuid, recipients text[], attach_guests boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v record; v_at timestamptz; v_to text[];
BEGIN
  FOR v IN
    SELECT c.event_id AS eid, ev.created_by AS owner, c.recipients AS rc, c.attach_guests AS ag
      FROM leod_checkin_client_reports c
      JOIN leod_checkin_entitlements e ON e.event_id = c.event_id
      JOIN leod_events ev ON ev.id = c.event_id
     WHERE e.status = 'live' AND c.sent_at IS NULL AND c.attempts < 5
       AND cardinality(c.recipients) > 0
  LOOP
    v_at := checkin_client_report_at(v.eid);
    IF v_at IS NOT NULL AND now() >= v_at AND now() < v_at + interval '7 days' THEN
      SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_to
        FROM unnest(v.rc) x WHERE checkin_client_report_allowed(v.eid, x);
      IF cardinality(v_to) > 0 THEN
        event_id := v.eid; owner_id := v.owner; recipients := v_to; attach_guests := v.ag;
        RETURN NEXT;
      END IF;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION checkin_client_reports_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_client_reports_due() TO service_role;

-- 3. The client report page ----------------------------------------------
ALTER TABLE leod_checkin_client_reports
  ADD COLUMN IF NOT EXISTS token text NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(16), 'hex')
  CHECK (token ~ '^[0-9a-f]{32}$');

-- For the sender, to put the link in the email.
CREATE OR REPLACE FUNCTION checkin_client_report_token(p_event_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT token FROM leod_checkin_client_reports WHERE event_id = p_event_id $$;
REVOKE ALL ON FUNCTION checkin_client_report_token(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_client_report_token(uuid) TO service_role;

-- The page. NULL until the report is sent, when the event is not live, or
-- 90 days after it. Numbers only, as listed here: no desk labels, no
-- companies, no names.
CREATE OR REPLACE FUNCTION checkin_client_report_view(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_event uuid; v_at timestamptz; r jsonb; e record;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{32}$' THEN RETURN NULL; END IF;
  SELECT c.event_id INTO v_event FROM leod_checkin_client_reports c
    JOIN leod_checkin_entitlements n ON n.event_id = c.event_id
   WHERE c.token = p_token AND c.sent_at IS NOT NULL AND n.status = 'live';
  IF v_event IS NULL THEN RETURN NULL; END IF;
  v_at := checkin_client_report_at(v_event);
  IF v_at IS NULL OR now() > v_at + interval '90 days' THEN RETURN NULL; END IF;
  r := checkin_event_report_data(v_event, false);
  SELECT registration_host_name, registration_brand_color, registration_logo_path, white_label INTO e
    FROM leod_checkin_entitlements WHERE event_id = v_event;
  RETURN jsonb_build_object(
    'event', r->'event',
    'registered', r->'registered', 'checked_in', r->'checked_in', 'walk_ins', r->'walk_ins',
    'first_arrival_at', r->'first_arrival_at', 'last_arrival_at', r->'last_arrival_at',
    'peak', r->'peak', 'by_ticket', r->'by_ticket',
    'host', NULLIF(btrim(e.registration_host_name), ''), 'brand_color', e.registration_brand_color,
    'logo_path', e.registration_logo_path, 'white_label', e.white_label);
END;
$$;
REVOKE ALL ON FUNCTION checkin_client_report_view(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkin_client_report_view(text) TO anon, authenticated;

-- The organizer's view gains the page's token once the report is sent, and
-- whether this event may report outside the owner's company.
CREATE OR REPLACE FUNCTION checkin_client_report_get(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record;
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can see who gets the client report' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM leod_checkin_client_reports WHERE event_id = p_event_id;
  RETURN jsonb_build_object(
    'recipients', COALESCE(to_jsonb(r.recipients), '[]'::jsonb),
    'attach_guests', COALESCE(r.attach_guests, false),
    'sent_at', r.sent_at,
    'failed', COALESCE(r.attempts, 0) > 0 AND r.sent_at IS NULL,
    'last_error', CASE WHEN r.sent_at IS NULL THEN r.last_error END,
    'sends_at', checkin_client_report_at(p_event_id),
    'page_token', CASE WHEN r.sent_at IS NOT NULL THEN r.token END,   -- CHANGED (158)
    'own_domain_only', NOT checkin_event_full_email(p_event_id));       -- CHANGED (158)
END;
$$;
REVOKE ALL ON FUNCTION checkin_client_report_get(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_client_report_get(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
