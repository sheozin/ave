-- 082: session people (moderator, speakers, panelists).
--
-- Panels need a moderator plus several speakers or panelists, each with a
-- name, a company and a role. leod_sessions only had one free-text speaker
-- and one company.
--
-- 1. leod_sessions.people jsonb NOT NULL DEFAULT '[]': an ordered array of
--    { "name": text, "company": text|null, "role": "moderator"|"speaker"|"panelist" }.
--    The CHECK only guarantees it is an array; the console validates the
--    element shape. Existing rows get '[]' and behave exactly as before.
--    The console keeps writing speaker/company as a readable summary when
--    people is non-empty, so everything that reads speaker keeps working.
-- 2. display_feed: same body as live (080), plus 'people' in the session
--    object and 'date' + 'timezone' in the event object (the stage timer
--    counts to the real start in the event's timezone; before this it
--    compared time of day only). CREATE OR REPLACE keeps the existing
--    grants; they are restated below anyway so this file stands on its own.
--
-- Rollback (not run):
--   re-run the display_feed definition from 080 (without 'people'), then
--   ALTER TABLE public.leod_sessions DROP COLUMN people;

-- ── 1. Column ─────────────────────────────────────────────────
ALTER TABLE public.leod_sessions
  ADD COLUMN IF NOT EXISTS people jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.leod_sessions
  DROP CONSTRAINT IF EXISTS leod_sessions_people_is_array;
ALTER TABLE public.leod_sessions
  ADD CONSTRAINT leod_sessions_people_is_array CHECK (jsonb_typeof(people) = 'array');

-- ── 2. display_feed (live body from pg_get_functiondef; 'people', 'date', 'timezone' added) ──
CREATE OR REPLACE FUNCTION public.display_feed(p_display_id uuid, p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d leod_signage_displays%ROWTYPE;
BEGIN
  IF p_display_id IS NULL OR p_secret IS NULL OR length(p_secret) < 32 THEN
    RETURN NULL;
  END IF;
  SELECT * INTO d FROM leod_signage_displays
   WHERE id = p_display_id AND display_secret = p_secret;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF d.last_seen_at IS NULL OR d.last_seen_at < now() - interval '20 seconds' THEN
    UPDATE leod_signage_displays SET last_seen_at = now() WHERE id = d.id;
  END IF;
  RETURN jsonb_build_object(
    'server_time', clock_timestamp(),
    'display',     to_jsonb(d) - 'display_secret',
    'event', (SELECT jsonb_build_object('name', e.name, 'brand_color', e.brand_color,
                                        'date', e.date, 'timezone', e.timezone)
                FROM leod_events e WHERE e.id = d.event_id),
    'sessions', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
                'id',              s.id,
                'sort_order',      s.sort_order,
                'title',           s.title,
                'speaker',         s.speaker,
                'company',         s.company,
                'people',          s.people,
                'room',            s.room,
                'status',          s.status,
                'planned_start',   s.planned_start,
                'planned_end',     s.planned_end,
                'scheduled_start', s.scheduled_start,
                'scheduled_end',   s.scheduled_end,
                'actual_start',    s.actual_start)
              ORDER BY s.sort_order, s.id)
         FROM leod_sessions s
        WHERE s.event_id = d.event_id), '[]'::jsonb),
    'sponsors', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
                'id',         sp.id,
                'name',       sp.name,
                'logo_url',   sp.logo_url,
                'bg_color',   sp.bg_color,
                'sort_order', sp.sort_order)
              ORDER BY sp.sort_order, sp.name)
         FROM leod_signage_sponsors sp
        WHERE sp.event_id = d.event_id AND sp.active), '[]'::jsonb)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.display_feed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.display_feed(uuid, text) TO anon, authenticated, service_role;
