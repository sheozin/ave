INSERT INTO blog_posts (slug, title, excerpt, body, status, tags, read_time_minutes, published_at)
VALUES
(
  'run-of-show-template',
  'Run of Show Template for Live Events (With Examples)',
  'A run of show keeps every operator on the same page from load-in to wrap. Here is what a professional ROS looks like, what to include, and how to make it live.',
  'A run of show (ROS) is the master document that keeps every person on your production team coordinated from the first load-in to the final wrap. It''s the single source of truth for what happens, when it happens, who is responsible, and what the technical requirements are.

Done well, a run of show eliminates the need for constant radio check-ins. Done poorly — or done on a static spreadsheet — it creates the coordination problems it was supposed to solve.

This guide covers what a professional run of show includes, a template structure you can adapt, and how production teams are making their ROS live and dynamic.

## What Is a Run of Show?

A run of show is a chronological breakdown of every element in an event. Unlike a simple agenda handed to attendees, the ROS is an internal operations document — it includes technical cues, responsible parties, room assignments, AV requirements, and timing down to the minute.

It answers:
- What is happening right now?
- What is happening next?
- Who needs to be where?
- What does AV need to do at each transition?
- What changes if something runs long?

## What to Include in a Run of Show

A complete run of show template should have these columns at minimum:

### Session Information
- **Session title** — the name as it appears on the schedule
- **Room / stage** — which space it''s in
- **Planned start time** — when it''s supposed to begin
- **Planned end time** — when it''s supposed to finish
- **Duration** — how long it runs

### Speaker & Talent
- **Speaker name(s)**
- **Speaker handler / escort** — who is responsible for getting them to the right place
- **Language** — especially important for multilingual events with interpretation

### Technical Requirements
- **AV notes** — microphone type, presentation format, video playback, lighting cue
- **Slides** — whether slides are loaded, format, filename
- **Recording** — yes/no, which cameras, ISO or mixed

### Status Tracking
- **Status** — PLANNED, READY, LIVE, ENDED (or your equivalent)
- **Notes** — last-minute changes, confirmed/unconfirmed, dependencies

## Run of Show Template (Single Room)

Here''s a simplified single-room template structure:

| Time | Session | Speaker | Duration | AV Notes | Handler | Status |
|------|---------|---------|----------|----------|---------|--------|
| 09:00 | Opening Remarks | CEO | 15 min | Lav mic, no slides | Sarah | READY |
| 09:15 | Keynote | Dr. Martens | 45 min | Handheld mic, deck loaded | James | PLANNED |
| 10:00 | Coffee Break | — | 30 min | Music playlist, sponsor loop | — | PLANNED |
| 10:30 | Panel: Future of Work | 4 panellists | 60 min | 4× lav mics, moderator handheld | Emma | PLANNED |
| 11:30 | Networking Lunch | — | 90 min | Background music | — | PLANNED |

For multi-room events, you''ll need a separate view per room, plus a master view that shows all rooms by time slot.

## Run of Show Template (Multi-Room)

Multi-room events require a grid format — time on one axis, rooms on the other. This lets you see:
- Which rooms are running simultaneously
- When a speaker needs to transition between spaces
- Where AV team members need to be at any given moment
- Gaps and overlaps

A typical multi-room grid looks like:

| Time | Main Stage | Room A | Room B | Lobby |
|------|-----------|--------|--------|-------|
| 09:00 | Opening (CEO) | — | — | Registration |
| 09:30 | Keynote (Dr. Martens) | Workshop A | Workshop B | — |
| 10:30 | Break | Break | Break | Sponsor Showcase |
| 11:00 | Panel | Breakout C | Breakout D | — |

## The Problem with Static Run of Show Documents

Most ROS documents live in Google Sheets or Excel. They work reasonably well for planning, but they break down on the day:

**Version control.** When the director updates the ROS at 7am, does everyone have the new version? If someone printed it the night before, they''re operating on outdated information.

**Delay propagation.** When a session runs 15 minutes long, every downstream session time needs to be manually recalculated and re-communicated. On a large event with 30+ sessions across 5 rooms, this is a significant operational burden.

**Role filtering.** A stage manager doesn''t need to see the AV tech notes. An interpreter doesn''t need to see the handler assignments. A static spreadsheet gives everyone everything, which means everyone has to mentally filter out what isn''t relevant to them.

**Real-time status.** A spreadsheet can''t show you that Room B is currently LIVE, Room A is in OVERRUN, and the keynote speaker is in the green room waiting to be called. You need a phone call or radio for that.

## How Teams Are Making the Run of Show Live

The operational shift in event production over the last few years is moving the ROS from a static document to a live system.

A live run of show means:
- Every operator sees the current status of every session in real time
- When a delay is applied, it cascades automatically to all downstream sessions
- Role-specific views filter the information each person sees
- Signage updates automatically when the schedule changes

This is what CueDeck was built to do. Directors manage the run of show from a central console. Stage managers see their room''s sessions. AV operators see their tech notes and cues. The lobby displays update when the schedule shifts. Everything flows from one source.

The practical difference: when the keynote runs 12 minutes long, the director applies a 12-minute delay in CueDeck. Every operator''s console immediately shows the updated times. The lobby signage updates. No radio calls required.

## What to Do Before the Event

The run of show is only as good as the preparation behind it. Before your event:

1. **Lock the schedule 48 hours out** — late additions are fine, but the core structure should be stable
2. **Confirm all speakers** — unconfirmed sessions are a risk; flag them clearly
3. **Load all AV assets** — slides, videos, and playback files loaded and tested
4. **Brief every role** — each operator should understand their responsibilities and the escalation path
5. **Walk through transitions** — particularly between high-profile sessions or complex AV moments
6. **Plan for delays** — have a delay protocol agreed in advance (what gets cut, what gets shortened)

## On the Day

Your run of show becomes your real-time command interface. The key discipline is keeping it updated as the day evolves:

- Update session status as sessions go LIVE and END
- Log delays immediately when they happen
- Communicate changes through the system, not around it
- Keep the broadcast channel open for critical updates

## Try a Live Run of Show

If you''re still managing your ROS in a spreadsheet, the jump to a live system is smaller than it looks. CueDeck imports your existing session structure, and your team is operational in under 10 minutes.

[Start a free trial](https://app.cuedeck.io) — no credit card required.

Related reading: [How to Set Up Your First Event in CueDeck](/blog/setting-up-your-first-event) · [How to Manage Delays at Live Events](/blog/managing-delays-live-events) · [The Director''s Workflow](/blog/director-workflow-guide)',
  'published',
  ARRAY['production', 'planning', 'templates'],
  6,
  '2026-03-16T09:00:00Z'
),
(
  'live-event-production-software',
  'Live Event Production Software — What to Look For (2026 Guide)',
  'Choosing the right live event production software can mean the difference between a smooth show and a communications breakdown. Here is what actually matters.',
  'Live event production has a software problem. There''s plenty of tools for event registration, ticketing, and marketing — but when it comes to the actual production layer, most teams are still running on spreadsheets, WhatsApp groups, and radio calls.

The right live event production software changes how your entire team operates on the day. The wrong choice — or no choice — means every delay, every speaker change, and every AV cue has to travel through a chain of human communication before it reaches the right person.

This guide covers what live event production software actually needs to do, what to look for when evaluating options, and why the category is evolving fast.

## What Is Live Event Production Software?

Live event production software is the operational layer between your planning documents and your execution team. It gives every operator — director, stage manager, AV technician, interpreter, registration, signage — a real-time view of the event''s current state and their specific responsibilities.

It''s distinct from:
- **Event management software** (registration, ticketing, CRM)
- **Project management tools** (planning, budgets, task tracking)
- **AV control systems** (switchers, lighting boards, mixing consoles)

Production software sits in the middle of your team''s communication on the day itself. When a session goes live, when a delay is applied, when a speaker is called — every operator sees it instantly.

## What to Look For

### 1. Real-Time Status Synchronisation

The most important feature in production software is how fast changes propagate to the whole team.

When a session status changes — from PLANNED to LIVE, for example, or from LIVE to OVERRUN — every connected operator should see it in under a second. Not after a page refresh. Not after someone sends a message. Immediately.

This requires a real-time backend (WebSocket connections or database subscriptions), not a polling-based system that checks for updates every 30 or 60 seconds.

**What to ask vendors:** How are status updates propagated? What''s the typical latency between a state change and it appearing on all connected devices?

### 2. Role-Based Views

Different operators need different information. A stage manager''s console should show their room''s upcoming sessions, speaker cue status, and time remaining. An AV operator needs tech notes, playback cues, and transition timing. An interpreter needs language assignments and session context. Registration needs check-in flow and attendee information.

A single-view-for-everyone approach creates noise. When everyone sees everything, the important information gets buried, and operators spend time filtering rather than acting.

Good production software gives each role a focused, distraction-free view of exactly what they need.

**What to ask vendors:** Can different roles see different views? Can permissions be scoped by role? Can you customise what each view shows?

### 3. Delay Cascade

This is the feature most teams don''t know they need until they''ve lived through a major delay without it.

When a session runs 20 minutes long, every downstream session needs to shift. In a manual system, this means the director recalculates, communicates to each role, updates the spreadsheet, and hopes everyone got the message. In a multi-room event, this process multiplies by the number of rooms.

A delay cascade automates this. The director applies a delay to a session, and every downstream session''s time updates automatically across all operator views and signage displays.

**What to ask vendors:** How does the system handle delays? Is the cascade automatic or manual? Does it update signage?

### 4. Integrated Digital Signage

Lobby displays, wayfinding screens, and sponsor carousels shouldn''t require a separate system. When the schedule changes in your production console, your signage should update without anyone touching a keyboard.

Look for built-in signage modes that cover the display types you actually need: schedule grids, session lists, break countdowns, sponsor carousels, room directories, and stage confidence monitors.

**What to ask vendors:** Is signage integrated or a separate product? How many display types does it support? Does it update automatically when the schedule changes?

### 5. Offline Resilience

Event venues have notoriously unreliable WiFi. Your production software needs to handle intermittent connectivity gracefully — reconnecting automatically, catching up on missed state changes, and not requiring a manual reload every time a connection drops.

**What to ask vendors:** What happens when a device loses connectivity? Does it reconnect automatically? Is there any local state preservation?

### 6. Multi-Room Support

If you run events across more than one room, your production software needs to handle the full complexity: simultaneous sessions, room-specific views, and a master overview for the director.

Single-room tools often fall apart when you add a second stage, a breakout track, or a parallel workshop programme.

**What to ask vendors:** How does the system handle simultaneous sessions across multiple rooms? Can operators filter to their specific room?

### 7. Session State Machine

Events have a predictable lifecycle for each session: it''s planned, then ready, then the speaker is called, then it goes live, then it ends. Some sessions get put on hold. Some run over. Some get cancelled.

Good production software models this explicitly — with defined states and valid transitions — rather than leaving it to free-form notes or status fields.

**What to look for:** A clear state model (PLANNED → READY → CALLING → LIVE → ENDED, plus HOLD, OVERRUN, CANCELLED) with controlled transitions that trigger the right notifications.

### 8. Audit Trail

After the event, you need to know what happened. When did each session actually start and end? Where were the delays? Which sessions were cancelled? What was the variance between planned and actual timing?

A good audit trail is also useful in real time — if something goes wrong, you need to understand the sequence of events.

**What to ask vendors:** Does the system log all state changes with timestamps? Can you export a post-event report?

## What to Avoid

**Email and WhatsApp integrations as the primary communication channel.** These are fine for pre-event coordination, but using them as the real-time communication layer during an event creates unacceptable latency and no audit trail.

**Browser-only tools with no mobile support.** Stage managers and AV operators are often moving. They need a view that works on a phone or tablet, not just a laptop.

**Tools that require a technical setup team.** Production software should be set up by the event director, not an IT specialist. If you need a configuration consultant to go live, the tool is too complex.

**Systems where signage is a paid add-on.** If signage costs extra, you''ll end up with two separate systems that don''t talk to each other properly.

## How to Evaluate Options

1. **Run a test event.** Most serious production tools offer a free trial. Create a realistic multi-session event with multiple rooms and test the delay cascade, role switching, and signage sync.

2. **Stress test the real-time sync.** Open two browser windows on different devices, change a session status on one, and time how long it takes to appear on the other.

3. **Involve your operators.** The stage manager and AV team who use the tool on the day should test it before you commit. Adoption depends on it being intuitive for all roles, not just the director.

4. **Check the mobile experience.** Open it on your phone. If it''s unusable on mobile, that''s a problem for operators who aren''t at a desk.

## CueDeck

CueDeck is live event production software built by a team that has produced hundreds of events across Europe and the Middle East.

It covers the full operational layer: real-time status sync across all roles (Director, Stage, AV, Interpreter, Registration, Signage), automatic delay cascade, 10 digital signage modes, AI-assisted incident management, and a complete post-event report.

Sessions follow an 8-state machine (PLANNED → READY → CALLING → LIVE → OVERRUN → ENDED, plus HOLD and CANCELLED). Every state change propagates to all connected operators in under 100ms.

[Try CueDeck free](https://app.cuedeck.io) — no credit card required. Setup takes under 10 minutes.

Related reading: [Run of Show Template for Live Events](/blog/run-of-show-template) · [How to Manage Delays at Live Events](/blog/managing-delays-live-events) · [CueDeck vs Spreadsheets and WhatsApp](/blog/cuedeck-vs-spreadsheets-whatsapp)',
  'published',
  ARRAY['production', 'software', 'tools'],
  7,
  '2026-03-16T10:00:00Z'
)
ON CONFLICT (slug) DO NOTHING;