-- 153_checkin_staffing_plan.sql
-- Staffing plan: how many desks to open, and when, so the line stays under
-- five minutes. Two parts:
--   1. checkin_arrival_history: the organizer's OWN past live events (when
--      people arrived relative to the start, how many came, how fast the
--      desks went). It fills the plan's inputs; nothing here is an average
--      from anywhere else. An organizer with no past event gets no rows and
--      types their own estimates.
--   2. staffing_plan on the entitlement, saved by checkin_save_staffing_plan,
--      so the dashboard can draw the plan against real arrivals.
-- Both refuse anyone who is not an organizer of the event (42501, which is
-- what guard G10 checks for every p_event_id function).

ALTER TABLE leod_checkin_entitlements ADD COLUMN IF NOT EXISTS staffing_plan JSONB;
-- Read like the rest of the entitlement (column grants, see 072 onwards);
-- written only through the function below.
GRANT SELECT (staffing_plan) ON leod_checkin_entitlements TO authenticated;

-- One row per past event. buckets: arrivals per 15 minutes, o = slots from
-- the event start (negative = before). desk_busiest: for each desk, its
-- most check-ins in one 15-minute slot.
CREATE OR REPLACE FUNCTION checkin_arrival_history(p_event_id UUID)
RETURNS TABLE (
  event_id     UUID,
  name         TEXT,
  date         DATE,
  registered   INT,
  checked_in   INT,
  buckets      JSONB,
  desk_busiest INT[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can see past arrivals' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH past AS (
    SELECT ev.id, ev.name, ev.date,
           ((ev.date + ev.event_start) AT TIME ZONE ev.timezone) AS start_at
      FROM leod_checkin_entitlements en
      JOIN leod_events ev ON ev.id = en.event_id
     WHERE en.status = 'live'
       AND ev.id <> p_event_id
       AND ev.date < current_date
       AND ev.event_start IS NOT NULL
       AND ev.timezone IS NOT NULL
       AND checkin_role_for_event(ev.id) = 'organizer'
     ORDER BY ev.date DESC
     LIMIT 10
  ), arr AS (
    SELECT p.id, floor(extract(epoch FROM (a.checked_in_at - p.start_at)) / 900)::int AS o, count(*)::int AS n
      FROM past p
      JOIN leod_checkin_attendees a ON a.event_id = p.id AND NOT a.is_test AND a.checked_in_at IS NOT NULL
     GROUP BY 1, 2
    -- Eight hours either side of the start. Later arrivals still count in
    -- checked_in, so the shares the page derives stay honest.
    HAVING floor(extract(epoch FROM (min(a.checked_in_at) - p.start_at)) / 900) BETWEEN -32 AND 32
  ), desk AS (
    SELECT x.event_id AS id, x.desk_id, max(x.n)::int AS busiest
      FROM (SELECT s.event_id, s.desk_id, date_bin('15 minutes', s.scanned_at, timestamptz '2000-01-01') AS slot, count(*) AS n
              FROM leod_checkin_scan_events s
              JOIN past p ON p.id = s.event_id
             WHERE s.result = 'ok' AND NOT s.is_test AND s.desk_id IS NOT NULL
             GROUP BY 1, 2, 3) x
     GROUP BY 1, 2
  )
  SELECT p.id, p.name, p.date,
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = p.id AND NOT a.is_test),
         (SELECT count(*)::int FROM leod_checkin_attendees a WHERE a.event_id = p.id AND NOT a.is_test AND a.checked_in_at IS NOT NULL),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('o', arr.o, 'n', arr.n) ORDER BY arr.o) FROM arr WHERE arr.id = p.id), '[]'::jsonb),
         COALESCE((SELECT array_agg(desk.busiest ORDER BY desk.busiest DESC) FROM desk WHERE desk.id = p.id), '{}'::int[])
    FROM past p
   ORDER BY p.date DESC;
END;
$$;
REVOKE ALL ON FUNCTION checkin_arrival_history(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_arrival_history(UUID) TO authenticated;

-- The plan: the organizer's inputs, and (when it came from past events)
-- the arrival shape as [slot, share] pairs. NULL clears it. Every field is
-- range-checked here, so the dashboard can draw whatever is stored.
CREATE OR REPLACE FUNCTION checkin_save_staffing_plan(p_event_id UUID, p_plan JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan JSONB;
  v_pair JSONB;
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can save the staffing plan' USING ERRCODE = '42501';
  END IF;
  IF p_plan IS NOT NULL THEN
    IF jsonb_typeof(p_plan) <> 'object'
       OR jsonb_typeof(p_plan->'turnout_pct') <> 'number' OR (p_plan->>'turnout_pct')::numeric NOT BETWEEN 1 AND 100
       OR jsonb_typeof(p_plan->'seconds_per_guest') <> 'number' OR (p_plan->>'seconds_per_guest')::numeric NOT BETWEEN 3 AND 600
       OR jsonb_typeof(p_plan->'before_min') <> 'number' OR (p_plan->>'before_min')::numeric NOT BETWEEN 0 AND 480
       OR jsonb_typeof(p_plan->'after_min') <> 'number' OR (p_plan->>'after_min')::numeric NOT BETWEEN 0 AND 480
       OR (p_plan->>'before_min')::numeric + (p_plan->>'after_min')::numeric < 15 THEN
      RAISE EXCEPTION 'Check the plan: turnout 1 to 100 percent, 3 to 600 seconds a guest, and an arrival window of at least 15 minutes'
        USING ERRCODE = '22023';
    END IF;
    v_plan := jsonb_build_object(
      'turnout_pct', round((p_plan->>'turnout_pct')::numeric),
      'seconds_per_guest', round((p_plan->>'seconds_per_guest')::numeric),
      'before_min', round((p_plan->>'before_min')::numeric),
      'after_min', round((p_plan->>'after_min')::numeric),
      'saved_at', now());
    IF p_plan ? 'shape' AND jsonb_typeof(p_plan->'shape') <> 'null' THEN
      IF jsonb_typeof(p_plan->'shape') <> 'array' OR jsonb_array_length(p_plan->'shape') NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION 'The arrival shape is 1 to 64 slots' USING ERRCODE = '22023';
      END IF;
      FOR v_pair IN SELECT * FROM jsonb_array_elements(p_plan->'shape') LOOP
        IF jsonb_typeof(v_pair) <> 'array' OR jsonb_array_length(v_pair) <> 2
           OR jsonb_typeof(v_pair->0) <> 'number' OR (v_pair->>0)::numeric NOT BETWEEN -32 AND 32
           OR (v_pair->>0)::numeric <> trunc((v_pair->>0)::numeric)
           OR jsonb_typeof(v_pair->1) <> 'number' OR (v_pair->>1)::numeric NOT BETWEEN 0 AND 1 THEN
          RAISE EXCEPTION 'Each arrival slot is [slot from the start, share]' USING ERRCODE = '22023';
        END IF;
      END LOOP;
      v_plan := v_plan || jsonb_build_object('shape', p_plan->'shape');
    END IF;
  END IF;
  UPDATE leod_checkin_entitlements SET staffing_plan = v_plan WHERE event_id = p_event_id;
  RETURN v_plan;
END;
$$;
REVOKE ALL ON FUNCTION checkin_save_staffing_plan(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_save_staffing_plan(UUID, JSONB) TO authenticated;
