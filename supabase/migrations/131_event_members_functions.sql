-- ============================================================
-- CueDeck Migration 131: event teams, part 2 (functions on the resolver)
-- ============================================================
-- Spec: docs/superpowers/specs/2026-10-08-event-teams-design.md §3, §6
-- Every function that carried its own copy of the old membership rule
-- (leod_users.invited_by) now asks the resolver from migration 130. Bodies
-- are the live ones (pg_get_functiondef, 2026-10-08) with only the
-- membership lines changed; each block says what changed.
--
-- The live lines that change:
--   rpc_apply_delay:  SELECT e.created_by INTO v_owner ...; IF v_owner = v_caller
--                     THEN 'director' ELSIF ... SELECT u.role FROM leod_users u
--                     WHERE u.id = v_caller AND u.invited_by = v_owner AND u.active
--   display_pair_link, display_rotate_secret: event owned by the caller or by
--                     the caller's invited_by (active), any member role
--   validate_event_log_role: operator_role := leod_users.role (global)
--   get_operators_with_last_seen: caller's global role = 'director'; rows
--                     u.id = caller OR u.invited_by = caller
--   get_subscription_for_user: self if role = 'director' OR invited_by IS NULL,
--                     else the inviter's subscription
-- ============================================================

-- ── rpc_apply_delay: role on the session's event ────────────
-- Changed: v_owner and the leod_users lookup become
-- cuedeck_event_role_of(v_event, v_caller). The rest is the live body.
CREATE OR REPLACE FUNCTION public.rpc_apply_delay(p_session_id uuid, p_minutes integer, p_operator_id uuid DEFAULT NULL::uuid, p_operator_role text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller   UUID;
  v_event    UUID;
  v_sort     SMALLINT;
  v_role     TEXT;
  v_stop_sort SMALLINT;
  v_stop_id  UUID;
  v_ids      UUID[];
  v_affected INT;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    IF coalesce(auth.role(), 'service_role') <> 'service_role' THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    v_caller := p_operator_id;
  ELSIF p_operator_id IS NOT NULL AND p_operator_id <> v_caller THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_minutes IS NULL OR p_minutes < 1 OR p_minutes > 240 THEN
    RAISE EXCEPTION 'minutes must be between 1 and 240, got %', p_minutes USING ERRCODE = '22023';
  END IF;

  SELECT s.event_id, s.sort_order INTO v_event, v_sort
    FROM leod_sessions s
   WHERE s.id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  -- event teams (131): the caller's role on this event, from the resolver
  v_role := cuedeck_event_role_of(v_event, v_caller);
  IF v_role IS NULL OR v_role NOT IN ('director', 'stage') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT s.sort_order, s.id INTO v_stop_sort, v_stop_id
    FROM leod_sessions s
   WHERE s.event_id = v_event
     AND (s.sort_order, s.id) > (v_sort, p_session_id)
     AND s.status NOT IN ('ENDED', 'CANCELLED')
     AND s.is_anchor
   ORDER BY s.sort_order, s.id
   LIMIT 1;

  WITH shifted AS (
    UPDATE leod_sessions s
       SET scheduled_start  = s.scheduled_start + make_interval(mins => p_minutes),
           scheduled_end    = s.scheduled_end   + make_interval(mins => p_minutes),
           cumulative_delay = s.cumulative_delay + p_minutes,
           delay_minutes    = CASE WHEN s.id = p_session_id
                                   THEN s.delay_minutes + p_minutes
                                   ELSE s.delay_minutes END,
           version          = s.version + 1
     WHERE s.event_id = v_event
       AND (s.sort_order, s.id) >= (v_sort, p_session_id)
       AND (v_stop_id IS NULL OR (s.sort_order, s.id) < (v_stop_sort, v_stop_id))
       AND s.status NOT IN ('ENDED', 'CANCELLED')
    RETURNING s.id, s.sort_order
  )
  SELECT array_agg(id ORDER BY sort_order, id), count(*)::int
    INTO v_ids, v_affected
    FROM shifted;

  INSERT INTO leod_event_log (event_id, session_id, action, operator_id, operator_role, payload, server_time_ms)
  VALUES (v_event, p_session_id, 'DELAY_APPLIED', v_caller, p_operator_role,
          jsonb_build_object('minutes', p_minutes, 'affected', v_affected,
                             'session_ids', coalesce(to_jsonb(v_ids), '[]'::jsonb),
                             'stopped_at_anchor', v_stop_id, 'via', 'rpc'),
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint);

  RETURN jsonb_build_object('ok', true, 'affected', v_affected, 'minutes', p_minutes);
END;
$function$;
REVOKE ALL ON FUNCTION public.rpc_apply_delay(uuid, integer, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_apply_delay(uuid, integer, uuid, text) TO authenticated, service_role;

-- ── display_pair_link: director or signage on the display's event ──
-- Changed: the owner-or-invited_by join becomes the resolver and the roles
-- narrow to director and signage (spec §3). The rest is the live body.
CREATE OR REPLACE FUNCTION public.display_pair_link(p_code text, p_display_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_event uuid;
  v_row   leod_signage_pairing%ROWTYPE;
BEGIN
  SELECT d.event_id INTO v_event FROM leod_signage_displays d WHERE d.id = p_display_id;
  IF v_uid IS NULL OR v_event IS NULL
     OR coalesce(cuedeck_event_role(v_event), '') NOT IN ('director', 'signage') THEN
    RETURN 'forbidden';
  END IF;
  UPDATE leod_signage_pairing
     SET display_id = p_display_id, event_id = v_event
   WHERE code = p_code AND display_id IS NULL AND expires_at > now()
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN 'linked';
  END IF;
  SELECT * INTO v_row FROM leod_signage_pairing WHERE code = p_code;
  IF NOT FOUND THEN
    RETURN 'not_found';
  ELSIF v_row.display_id IS NOT NULL THEN
    RETURN 'used';
  END IF;
  RETURN 'expired';
END
$function$;
REVOKE ALL ON FUNCTION public.display_pair_link(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.display_pair_link(text, uuid) TO authenticated, service_role;

-- ── display_rotate_secret: director or signage on the display's event ──
-- Changed: as display_pair_link. The rest is the live body.
CREATE OR REPLACE FUNCTION public.display_rotate_secret(p_display_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_event uuid;
BEGIN
  IF v_uid IS NULL OR p_display_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT d.event_id INTO v_event FROM leod_signage_displays d WHERE d.id = p_display_id;
  IF v_event IS NULL OR coalesce(cuedeck_event_role(v_event), '') NOT IN ('director', 'signage') THEN
    RETURN false;
  END IF;
  UPDATE leod_signage_displays d
     SET display_secret = encode(extensions.gen_random_bytes(24), 'hex')
   WHERE d.id = p_display_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM leod_signage_pairing WHERE display_id = p_display_id;
  RETURN true;
END
$function$;
REVOKE ALL ON FUNCTION public.display_rotate_secret(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.display_rotate_secret(uuid) TO authenticated, service_role;

-- ── validate_event_log_role: the role on THIS event ─────────
-- Changed: a row with an event gets the operator's role on that event
-- (spec §3); with no event, or no role on it (an admin), the live
-- behaviour stays (the account's leod_users.role).
CREATE OR REPLACE FUNCTION public.validate_event_log_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_actual_role TEXT;
BEGIN
  -- Skip validation for inserts with no operator (cron jobs)
  IF NEW.operator_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.event_id IS NOT NULL THEN
    v_actual_role := cuedeck_event_role_of(NEW.event_id, NEW.operator_id);
  END IF;
  IF v_actual_role IS NULL THEN
    SELECT role INTO v_actual_role FROM leod_users WHERE id = NEW.operator_id;
  END IF;

  IF v_actual_role IS NOT NULL AND NEW.operator_role IS DISTINCT FROM v_actual_role THEN
    NEW.operator_role := v_actual_role;
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.validate_event_log_role() FROM PUBLIC, anon, authenticated;

-- ── get_operators_with_last_seen: for consoles before Release B ──
-- The console after Release B uses cuedeck_event_team (133). Until the
-- leod_users.invited_by cleanup (spec §7) this keeps the old console's team
-- list working on memberships: the caller plus every member of the events
-- the caller directs (creator, or active director member), with the role on
-- that event. Same columns as the live function.
CREATE OR REPLACE FUNCTION public.get_operators_with_last_seen()
RETURNS TABLE(id uuid, name text, email text, role text, organization text, active boolean, last_sign_in_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  IF v_caller_id IS NULL OR NOT (
       EXISTS (SELECT 1 FROM leod_events e WHERE e.created_by = v_caller_id)
       OR EXISTS (SELECT 1 FROM leod_event_members m
                   WHERE m.user_id = v_caller_id AND m.active AND m.role = 'director')) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT x.id, x.name, x.email, x.role, x.organization, x.active, x.last_sign_in_at
    FROM (
      SELECT DISTINCT ON (u.id)
             u.id, u.name, u.email,
             CASE WHEN u.id = v_caller_id THEN 'director' ELSE m.role END AS role,
             u.organization,
             CASE WHEN u.id = v_caller_id THEN u.active ELSE m.active END AS active,
             a.last_sign_in_at
        FROM leod_users u
        LEFT JOIN auth.users a ON a.id = u.id
        LEFT JOIN leod_event_members m
               ON m.user_id = u.id
              AND cuedeck_event_role_of(m.event_id, v_caller_id) = 'director'
       WHERE u.id = v_caller_id OR m.user_id IS NOT NULL
       ORDER BY u.id, m.created_at
    ) x
   ORDER BY x.role, x.name;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_operators_with_last_seen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operators_with_last_seen() TO authenticated, service_role;

-- ── get_subscription_for_user: the caller's own plan only ───
-- Changed: no resolution to the inviter. A member's plan for an event is
-- the event owner's, returned per event by cuedeck_my_events (133).
CREATE OR REPLACE FUNCTION public.get_subscription_for_user()
RETURNS TABLE(plan text, status text, trial_ends_at timestamp with time zone, events_purchased integer, events_used integer, current_period_end timestamp with time zone, cancel_at timestamp with time zone, billing_interval text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN QUERY
  SELECT s.plan, s.status, s.trial_ends_at,
         s.events_purchased, s.events_used,
         s.current_period_end, s.cancel_at, s.billing_interval
    FROM leod_subscriptions s
   WHERE s.director_id = auth.uid();
END;
$function$;
REVOKE ALL ON FUNCTION public.get_subscription_for_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_subscription_for_user() TO authenticated, service_role;
