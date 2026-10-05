-- ============================================================
-- CueDeck Migration 093: rpc_apply_delay, installed for real
-- ============================================================
-- The console's +5/+10/+15 buttons call the apply-delay Edge Function,
-- which calls rpc_apply_delay. Live has no such function (checked
-- 2026-10-05: to_regproc('public.rpc_apply_delay') is null, although
-- schema_migrations lists 003_rpc_apply_delay), so the EF has answered 500
-- on every delay and the console fell back to a client-side cascade: one
-- unchecked UPDATE per session, no transaction, no version bump, no log.
--
-- Numbered 093: 084-092 are taken by the check-in work merged into main.
--
-- Signature: exactly what apply-delay sends,
--   rpc({ p_session_id, p_minutes, p_operator_id, p_operator_role })
-- The EF calls with the service role and passes the signed-in user as
-- p_operator_id. A signed-in caller (authenticated role) is always
-- auth.uid() and may not name anyone else.
--
-- Cascade rules: the console's client fallback (applyDelay in
-- cuedeck-console.html), which is what operators have seen until now:
--   * walk the event's sessions in sort_order from the target onwards
--     (ties broken by id, the console's order among ties is arbitrary);
--   * ENDED and CANCELLED sessions are skipped and do NOT stop the walk,
--     not even when they are anchors; the target itself is skipped when
--     ENDED/CANCELLED (the console only offers delay on LIVE, OVERRUN,
--     HOLD, READY and CALLING);
--   * the first later session that is not ENDED/CANCELLED and is_anchor
--     stops the walk and is not shifted; an anchor target is shifted;
--   * each shifted session: scheduled_start/end + minutes (time wraps at
--     midnight, as addMinutes does), cumulative_delay + minutes; the target
--     also gets delay_minutes + minutes.
-- Added over the fallback: version + 1 on every shifted row (so a
-- transition built on the old version gets the M1 409), one
-- leod_event_log row in the same transaction.
--
-- Who may delay: the event owner, or an operator the owner invited whose
-- leod_users.active is true, with a role in the console's ROLE_DELAY
-- (director, stage). Owners count as directors. Same rule as eventRole()
-- in supabase/functions/_shared/transition.ts.
--
-- Grants: since 079 nothing is executable by default. REVOKE from PUBLIC
-- and anon, GRANT to authenticated and service_role.
--
-- Probe: tests/sql/093-apply-delay-probe.sql
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_apply_delay(
  p_session_id    UUID,
  p_minutes       INT,
  p_operator_id   UUID DEFAULT NULL,
  p_operator_role TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   UUID;
  v_event    UUID;
  v_sort     SMALLINT;
  v_owner    UUID;
  v_role     TEXT;
  v_stop_sort SMALLINT;
  v_stop_id  UUID;
  v_ids      UUID[];
  v_affected INT;
BEGIN
  -- Who is asking. The authenticated role always carries a user id; only
  -- the service role (or a direct database session, which has no JWT
  -- claims at all) may act for p_operator_id.
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

  SELECT e.created_by INTO v_owner FROM leod_events e WHERE e.id = v_event;
  IF v_owner IS NOT NULL AND v_owner = v_caller THEN
    v_role := 'director';
  ELSIF v_owner IS NOT NULL THEN
    SELECT u.role INTO v_role
      FROM leod_users u
     WHERE u.id = v_caller
       AND u.invited_by = v_owner
       AND u.active;
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('director', 'stage') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  -- First later session that is live in the running order and an anchor.
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

  -- Same transaction: no shifted schedule without its log row.
  -- validate_event_log_role (039) replaces operator_role with the real one.
  INSERT INTO leod_event_log (event_id, session_id, action, operator_id, operator_role, payload, server_time_ms)
  VALUES (v_event, p_session_id, 'DELAY_APPLIED', v_caller, p_operator_role,
          jsonb_build_object('minutes', p_minutes, 'affected', v_affected,
                             'session_ids', coalesce(to_jsonb(v_ids), '[]'::jsonb),
                             'stopped_at_anchor', v_stop_id, 'via', 'rpc'),
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint);

  RETURN jsonb_build_object('ok', true, 'affected', v_affected, 'minutes', p_minutes);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_apply_delay(UUID, INT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_apply_delay(UUID, INT, UUID, TEXT) TO authenticated, service_role;
