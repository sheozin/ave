-- ============================================================
-- LEOD Post-Event Report Query
--
-- Returns one row per session with:
--   • planned vs actual start/end times
--   • start/end variance in minutes (positive = late)
--   • actual and planned duration in minutes
--   • delay and AV/production flags
--
-- Usage: replace '<YOUR_EVENT_ID>' with the event UUID, then
--        run in Supabase SQL Editor → Export CSV for post-event debrief.
--
-- Timezone handling: planned times (TIME columns) are combined
-- with the event date in the event's own timezone before comparing
-- against actual_start/actual_end (TIMESTAMPTZ).
-- ============================================================

SELECT
  -- ── Identity ─────────────────────────────────────────────
  s.sort_order,
  s.title,
  s.type,
  s.room,
  s.speaker,
  s.company,
  s.status,

  -- ── Planned times (converted to full timestamps) ──────────
  (e.date + s.planned_start)   AT TIME ZONE e.timezone  AS planned_start_ts,
  (e.date + s.planned_end)     AT TIME ZONE e.timezone  AS planned_end_ts,

  -- ── Scheduled times (after any delay cascade) ────────────
  (e.date + s.scheduled_start) AT TIME ZONE e.timezone  AS scheduled_start_ts,
  (e.date + s.scheduled_end)   AT TIME ZONE e.timezone  AS scheduled_end_ts,

  -- ── Actuals ───────────────────────────────────────────────
  s.actual_start,
  s.actual_end,

  -- ── Variance vs planned (minutes, positive = running late) ─
  CASE WHEN s.actual_start IS NOT NULL THEN
    ROUND(EXTRACT(EPOCH FROM (
      s.actual_start - ((e.date + s.planned_start) AT TIME ZONE e.timezone)
    )) / 60)::INTEGER
  END                                                    AS start_vs_planned_min,

  CASE WHEN s.actual_end IS NOT NULL THEN
    ROUND(EXTRACT(EPOCH FROM (
      s.actual_end - ((e.date + s.planned_end) AT TIME ZONE e.timezone)
    )) / 60)::INTEGER
  END                                                    AS end_vs_planned_min,

  -- ── Duration ──────────────────────────────────────────────
  CASE WHEN s.actual_start IS NOT NULL AND s.actual_end IS NOT NULL THEN
    ROUND(EXTRACT(EPOCH FROM (s.actual_end - s.actual_start)) / 60)::INTEGER
  END                                                    AS actual_duration_min,

  ROUND(EXTRACT(EPOCH FROM (s.planned_end - s.planned_start)) / 60)::INTEGER
                                                         AS planned_duration_min,

  -- ── Delay ─────────────────────────────────────────────────
  s.delay_minutes,
  s.cumulative_delay,

  -- ── AV / production flags ─────────────────────────────────
  s.speaker_arrived,
  s.mics,
  s.mic_type,
  s.recording,
  s.streaming,
  s.interpretation,
  s.languages

FROM leod_sessions s
JOIN leod_events   e ON e.id = s.event_id
WHERE s.event_id = '<YOUR_EVENT_ID>'   -- ← replace with your event UUID
ORDER BY s.sort_order;

-- ── Optional: summary stats ──────────────────────────────────────────────────
-- Uncomment to get aggregate totals at the bottom of the report.

-- SELECT
--   COUNT(*)                                                         AS total_sessions,
--   COUNT(*) FILTER (WHERE status = 'ENDED')                        AS completed,
--   COUNT(*) FILTER (WHERE status = 'CANCELLED')                    AS cancelled,
--   ROUND(AVG(
--     EXTRACT(EPOCH FROM (
--       actual_start - ((e.date + planned_start) AT TIME ZONE e.timezone)
--     )) / 60
--   ) FILTER (WHERE actual_start IS NOT NULL))::INTEGER              AS avg_start_variance_min,
--   MAX(cumulative_delay)                                            AS max_cumulative_delay_min
-- FROM leod_sessions s
-- JOIN leod_events   e ON e.id = s.event_id
-- WHERE s.event_id = '<YOUR_EVENT_ID>';
