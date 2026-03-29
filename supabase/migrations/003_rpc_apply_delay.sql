-- Migration 003 — rpc_apply_delay
-- Replaces the non-transactional per-row loop in the apply-delay Edge Function
-- with a single atomic transaction. If any session UPDATE fails, all roll back.
--
-- Called by: supabase/functions/apply-delay/index.ts
-- Idempotent: CREATE OR REPLACE

CREATE OR REPLACE FUNCTION rpc_apply_delay(
  p_session_id   UUID,
  p_minutes      INT,
  p_operator_id  UUID    DEFAULT NULL,
  p_operator_role TEXT   DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id               UUID;
  v_anchor_sort_order      INT;
  v_next_anchor_sort_order INT;
  v_affected               INT;
BEGIN
  -- ── Load anchor session ───────────────────────────────────────────────────
  SELECT event_id, sort_order
    INTO v_event_id, v_anchor_sort_order
    FROM leod_sessions
   WHERE id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found: %', p_session_id;
  END IF;

  -- ── Find next anchor boundary ─────────────────────────────────────────────
  -- Cascade stops at the next session with is_anchor = TRUE after the anchor.
  SELECT sort_order
    INTO v_next_anchor_sort_order
    FROM leod_sessions
   WHERE event_id = v_event_id
     AND sort_order > v_anchor_sort_order
     AND is_anchor = TRUE
   ORDER BY sort_order
   LIMIT 1;

  -- ── Apply delay atomically ────────────────────────────────────────────────
  -- Updates all sessions in range [anchor.sort_order, next_anchor.sort_order)
  -- Skips ENDED and CANCELLED sessions.
  -- For the anchor session itself, also increments delay_minutes.
  UPDATE leod_sessions
     SET scheduled_start  = scheduled_start + (p_minutes * INTERVAL '1 minute'),
         scheduled_end    = scheduled_end   + (p_minutes * INTERVAL '1 minute'),
         cumulative_delay = COALESCE(cumulative_delay, 0) + p_minutes,
         delay_minutes    = CASE
                              WHEN id = p_session_id
                              THEN COALESCE(delay_minutes, 0) + p_minutes
                              ELSE delay_minutes
                            END
   WHERE event_id   = v_event_id
     AND sort_order >= v_anchor_sort_order
     AND (v_next_anchor_sort_order IS NULL
          OR sort_order < v_next_anchor_sort_order)
     AND status NOT IN ('ENDED', 'CANCELLED');

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  -- ── Write audit log (best-effort — does not affect transaction) ───────────
  BEGIN
    INSERT INTO leod_event_log (
      event_id, session_id, action,
      operator_id, operator_role,
      payload, server_time_ms
    ) VALUES (
      v_event_id, p_session_id, 'DELAY_APPLIED',
      p_operator_id, p_operator_role,
      jsonb_build_object(
        'minutes',  p_minutes,
        'affected', v_affected,
        'via',      'rpc'
      ),
      EXTRACT(EPOCH FROM NOW()) * 1000
    );
  EXCEPTION WHEN OTHERS THEN
    -- Log failure is non-fatal; state is already committed above.
    NULL;
  END;

  RETURN jsonb_build_object(
    'ok',       true,
    'affected', v_affected,
    'minutes',  p_minutes
  );
END;
$$;

-- Grant execute to authenticated role (Edge Function uses service role but
-- explicit grant ensures forward-compatibility if auth model changes).
GRANT EXECUTE ON FUNCTION rpc_apply_delay(UUID, INT, UUID, TEXT) TO authenticated;
