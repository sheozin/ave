-- 157_checkin_client_report.sql
-- The report, sent to the organizer's client the morning after. An
-- organizer names up to 5 addresses; at 08:00 event time on the day after
-- the event, the 15-minute report run (checkin-post-event-report, 089)
-- emails each of them the headline numbers and arrivals by ticket type.
-- Replies go to the event owner. The guest list goes along as a CSV only
-- if the organizer ticks it, because that hands guests' names to someone
-- outside CueDeck.
--
-- Live events only: a test event never emails anyone outside the team.
--
-- The addresses sit in their own table with no grants, not on the
-- entitlement row: desk staff can read that row, and a client's address is
-- the organizer's business. Organizers read and write it through the two
-- RPCs below.
--
-- Sending mirrors the owner report (088/092): claim first so overlapping
-- runs cannot both send, give the claim back on failure, park after 5.

CREATE TABLE IF NOT EXISTS leod_checkin_client_reports (
  event_id      uuid        PRIMARY KEY REFERENCES leod_events(id) ON DELETE CASCADE,
  recipients    text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(recipients) <= 5),
  attach_guests boolean     NOT NULL DEFAULT false,
  sent_at       timestamptz,
  attempts      int         NOT NULL DEFAULT 0,
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE leod_checkin_client_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_client_reports FROM anon, authenticated;

-- 08:00 event time on the day after the event. NULL if the event has no
-- date or an unknown zone.
CREATE OR REPLACE FUNCTION checkin_client_report_at(p_event_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_date date; v_tz text;
BEGIN
  SELECT date, timezone INTO v_date, v_tz FROM leod_events WHERE id = p_event_id;
  IF v_date IS NULL OR v_tz IS NULL THEN RETURN NULL; END IF;
  RETURN ((v_date + 1)::timestamp + interval '8 hours') AT TIME ZONE v_tz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION checkin_client_report_at(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_client_report_at(uuid) TO service_role;

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
    'sends_at', checkin_client_report_at(p_event_id));
END;
$$;
REVOKE ALL ON FUNCTION checkin_client_report_get(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_client_report_get(uuid) TO authenticated;

-- Saves the list: trimmed, lower-cased, de-duplicated, each a plausible
-- address. Changing it after a failed send starts the attempts again.
-- Once sent it is not sent again, whatever is saved later.
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

-- For the sender: live events with someone to send to, past 08:00 the
-- morning after, within a week of it, not sent, not parked.
CREATE OR REPLACE FUNCTION checkin_client_reports_due()
RETURNS TABLE (event_id uuid, owner_id uuid, recipients text[], attach_guests boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v record; v_at timestamptz;
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
      event_id := v.eid; owner_id := v.owner; recipients := v.rc; attach_guests := v.ag;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION checkin_client_reports_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_client_reports_due() TO service_role;

CREATE OR REPLACE FUNCTION checkin_claim_client_report(p_event_id uuid)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  WITH w AS (
    UPDATE leod_checkin_client_reports SET sent_at = now()
     WHERE event_id = p_event_id AND sent_at IS NULL AND attempts < 5
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM w);
$$;
REVOKE ALL ON FUNCTION checkin_claim_client_report(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_claim_client_report(uuid) TO service_role;

CREATE OR REPLACE FUNCTION checkin_client_report_failed(p_event_id uuid, p_error text)
RETURNS int
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE leod_checkin_client_reports
     SET sent_at = NULL, attempts = attempts + 1, last_error = left(p_error, 500)
   WHERE event_id = p_event_id
  RETURNING attempts;
$$;
REVOKE ALL ON FUNCTION checkin_client_report_failed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_client_report_failed(uuid, text) TO service_role;

-- The guest list for the CSV, live guests only (test guests left out).
CREATE OR REPLACE FUNCTION checkin_client_report_guests(p_event_id uuid)
RETURNS TABLE (first_name text, last_name text, company text, ticket_type text, checked_in_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.first_name, a.last_name, a.company, a.ticket_type, a.checked_in_at
    FROM leod_checkin_attendees a
   WHERE a.event_id = p_event_id AND NOT a.is_test
   ORDER BY a.checked_in_at IS NULL, a.checked_in_at, lower(a.last_name), lower(a.first_name);
$$;
REVOKE ALL ON FUNCTION checkin_client_report_guests(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_client_report_guests(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
