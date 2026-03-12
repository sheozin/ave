-- ============================================================
--  CueDeck Demo Reset — "Tech Summit 2026"
--  Run in Supabase SQL Editor while logged in as service_role.
--  Wipes and re-seeds all demo data for demo@cuedeck.io.
-- ============================================================

DO $$
DECLARE
  demo_uid   UUID;
  ev_id      UUID;
BEGIN

  -- ── 1. Resolve demo user ──────────────────────────────────
  SELECT id INTO demo_uid
    FROM auth.users
   WHERE email = 'demo@cuedeck.io'
   LIMIT 1;

  IF demo_uid IS NULL THEN
    RAISE EXCEPTION 'demo@cuedeck.io not found. Create the account first.';
  END IF;

  -- ── 2. Nuke existing demo events ─────────────────────────
  DELETE FROM leod_events
   WHERE created_by = demo_uid;
  -- (sessions cascade-delete via FK)

  -- ── 3. Create event ──────────────────────────────────────
  INSERT INTO leod_events
    (name, date, timezone, event_start, event_end, venue, active, created_by)
  VALUES
    ('Tech Summit 2026',
     '2026-04-15',
     'Europe/London',
     '09:00', '18:00',
     'Grand Convention Centre — London',
     true,
     demo_uid)
  RETURNING id INTO ev_id;

  -- ── 4. Seed sessions (10 across 3 rooms) ─────────────────
  INSERT INTO leod_sessions
    (event_id, title, type, room, speaker, company,
     planned_start, planned_end,
     scheduled_start, scheduled_end,
     sort_order, is_anchor, recording, streaming, remote,
     interpretation, mics, notes,
     status, version, cumulative_delay, delay_minutes,
     speaker_arrived, actual_start, actual_end)
  VALUES

  -- 1 · Registration & Welcome Coffee
  (ev_id, 'Registration & Welcome Coffee', 'break', 'Main Stage', NULL, NULL,
   '09:00', '09:30', '09:00', '09:30',
   1, true, false, false, false, false, 0,
   'Doors open. Badge collection at lobby desks.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 2 · Opening Keynote
  (ev_id, 'Opening Keynote: Building the Future', 'keynote', 'Main Stage', 'Sarah Chen', 'Nexovate',
   '09:30', '10:15', '09:30', '10:15',
   2, true, true, true, false, false, 2,
   'Live-streamed. Sarah to demo new AI product on stage.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 3 · AI Ethics Panel
  (ev_id, 'Panel: AI Ethics & Governance in 2026', 'panel', 'Main Stage', 'James Wright (mod)', 'TechPolicy.io',
   '10:30', '11:30', '10:30', '11:30',
   3, false, true, true, false, false, 5,
   '4 panellists — confirm bios with James by 8 Apr.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 4 · Workshop: Realtime Apps (Room B, parallel)
  (ev_id, 'Workshop: Realtime Apps with Supabase', 'workshop', 'Workshop Room B', 'Marcus Webb', 'Supabase',
   '10:00', '11:00', '10:00', '11:00',
   4, false, false, false, false, false, 3,
   'Max 30 attendees. Laptops required. Code repo shared day before.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 5 · Sponsor Spotlight
  (ev_id, 'Sponsor Spotlight: CloudScale', 'sponsor', 'Main Stage', 'Emma Lawson', 'CloudScale',
   '11:30', '11:45', '11:30', '11:45',
   5, false, false, false, false, false, 1,
   '15 min product demo. Slide deck due 10 Apr.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 6 · Networking Lunch
  (ev_id, 'Networking Lunch', 'break', 'Main Stage', NULL, NULL,
   '12:00', '13:00', '12:00', '13:00',
   6, true, false, false, false, false, 0,
   'Buffet in the atrium. Sponsor banners to be set up by AV team.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 7 · Talk: Edge Computing
  (ev_id, 'Talk: Edge Computing in Production', 'talk', 'Main Stage', 'Priya Mehta', 'EdgeStack',
   '13:00', '13:45', '13:00', '13:45',
   7, false, true, false, false, false, 2,
   'Priya confirmed remote — joining via Zoom. AV: test link at 12:30.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 8 · Security Workshop (Room C, parallel)
  (ev_id, 'Workshop: Security Best Practices', 'workshop', 'Workshop Room C', 'David Kim', 'ShieldOps',
   '13:00', '14:00', '13:00', '14:00',
   8, false, false, false, false, false, 2,
   'Hands-on CTF challenge. Pre-install toolchain listed in signup email.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 9 · Fireside Chat
  (ev_id, 'Fireside Chat: Startup Journeys', 'fireside', 'Main Stage', 'Sofia Patel', 'VentureX',
   '14:00', '14:45', '14:00', '14:45',
   9, false, true, true, false, false, 2,
   'Conversational format. No slides. Moderator: James Wright.',
   'PLANNED', 0, 0, 0, false, NULL, NULL),

  -- 10 · Closing Keynote & Awards
  (ev_id, 'Closing Keynote & Innovation Awards', 'keynote', 'Main Stage', 'Alex Nowak', 'CueDeck',
   '15:30', '16:30', '15:30', '16:30',
   10, true, true, true, false, false, 2,
   'Award trophies in storage room B. Run through order with Alex at 14:45.',
   'PLANNED', 0, 0, 0, false, NULL, NULL);

  RAISE NOTICE 'Demo reset complete. Event ID: %', ev_id;
END $$;
