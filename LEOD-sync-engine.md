# CueDeck — Runtime Synchronization Engine
## Technical Architecture & Implementation Specification

**Document version:** 1.0  
**System:** CueDeck — Live Event Production Console  
**Scope:** Server logic, client state machines, WebSocket transport, time engine, failure recovery

---

## Part 1 — System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CUEDECK SYSTEM TOPOLOGY                               │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                    SUPABASE BACKEND                                │     │
│  │                                                                    │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐   │     │
│  │  │  PostgreSQL  │  │  Realtime    │  │  Edge Functions        │   │     │
│  │  │  Database    │←→│  Engine      │  │  (time authority,      │   │     │
│  │  │              │  │  (WebSocket  │  │   state transitions,   │   │     │
│  │  │  leod_*      │  │   channels)  │  │   conflict resolution) │   │     │
│  │  └──────────────┘  └──────┬───────┘  └────────────────────────┘   │     │
│  └─────────────────────────── │ ──────────────────────────────────────┘     │
│                               │  PUSH (WebSocket)                           │
│           ┌───────────────────┼───────────────────────────┐                 │
│           │                   │                           │                 │
│  ┌────────▼──────┐  ┌────────▼──────┐          ┌────────▼──────┐           │
│  │  OPERATOR     │  │  CONFIDENCE   │          │  PUBLIC       │           │
│  │  CONSOLES     │  │  MONITOR      │          │  SIGNAGE      │           │
│  │               │  │  (read-only)  │          │  (read-only)  │           │
│  │ • Director    │  │               │          │               │           │
│  │ • Stage Mgr   │  │  backstage    │          │  lobby        │           │
│  │ • AV Tech     │  │  screens      │          │  screens      │           │
│  │ • Interp.     │  │               │          │               │           │
│  │ • Reg. Desk   │  └───────────────┘          └───────────────┘           │
│  └───────────────┘                                                          │
│     ↑ sends commands                                                        │
│     ↓ receives state                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Authoritative sources

| Concern | Authority |
|---------|-----------|
| Current time | Supabase server (UTC) — never client clock |
| Session state | PostgreSQL row — single source of truth |
| State transitions | Edge Function validation — never client-side |
| Conflict resolution | Database row-level locking + Edge Function |
| Timeline offset | Stored as `delay_minutes` INT per session |

---

## Part 2 — Full Data Model

### 2.1 Core tables

```sql
-- ─────────────────────────────────────────────
-- SESSIONS: one row per agenda item
-- ─────────────────────────────────────────────
CREATE TABLE leod_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID REFERENCES leod_events(id),
  sort_order       SMALLINT NOT NULL,

  -- Identity
  title            TEXT NOT NULL,
  type             TEXT NOT NULL,           -- Keynote | Panel | Break | Workshop | Other
  room             TEXT,
  speaker          TEXT,
  company          TEXT,

  -- Planned schedule (immutable after event starts)
  planned_start    TIME(0) NOT NULL,        -- HH:MM
  planned_end      TIME(0) NOT NULL,

  -- Live schedule (shifts with delays)
  scheduled_start  TIME(0) NOT NULL,        -- = planned_start + accumulated upstream delay
  scheduled_end    TIME(0) NOT NULL,

  -- Actuals (written by time engine on transitions)
  actual_start     TIMESTAMPTZ,
  actual_end       TIMESTAMPTZ,

  -- Delay tracking
  delay_minutes    SMALLINT NOT NULL DEFAULT 0,   -- delay on THIS session specifically
  cumulative_delay SMALLINT NOT NULL DEFAULT 0,   -- total delay from start of event

  -- State machine (see Part 3)
  status           TEXT NOT NULL DEFAULT 'PLANNED'
                   CHECK (status IN ('PLANNED','READY','CALLING','LIVE',
                                     'OVERRUN','HOLD','ENDED','CANCELLED')),

  -- Technical requirements
  remote           BOOLEAN DEFAULT false,
  mics             SMALLINT DEFAULT 0,
  mic_type         TEXT,
  slides           BOOLEAN DEFAULT false,
  video_file       BOOLEAN DEFAULT false,
  recording        BOOLEAN DEFAULT false,
  streaming        BOOLEAN DEFAULT false,
  interpretation   BOOLEAN DEFAULT false,
  languages        TEXT[],
  notes            TEXT,
  speaker_arrived  BOOLEAN DEFAULT false,

  -- Preflight checklist
  checks           JSONB DEFAULT '[]',

  -- Audit
  state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state_changed_by UUID REFERENCES auth.users(id),
  version          INT NOT NULL DEFAULT 1,  -- optimistic lock counter
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- EVENTS: one row per conference day/event
-- ─────────────────────────────────────────────
CREATE TABLE leod_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  date             DATE NOT NULL,
  venue            TEXT,
  timezone         TEXT NOT NULL DEFAULT 'Europe/Warsaw',
  active           BOOLEAN DEFAULT true,
  event_start      TIME(0),
  event_end        TIME(0),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- USERS: authenticated users + roles
-- ─────────────────────────────────────────────
CREATE TABLE leod_users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id),
  email       TEXT NOT NULL,
  name        TEXT,
  organization TEXT,
  role        TEXT NOT NULL DEFAULT 'pending'
              CHECK (role IN (
                'pending','director','stage','av','interp','reg','signage')),
  active      BOOLEAN DEFAULT true,
  invited_by  UUID REFERENCES auth.users(id)
);

-- ─────────────────────────────────────────────
-- BROADCAST: cross-department messages
-- ─────────────────────────────────────────────
CREATE TABLE leod_broadcast (
  id           TEXT PRIMARY KEY DEFAULT 'global',
  message      TEXT DEFAULT '',
  priority     TEXT DEFAULT 'info',   -- info | warn | critical
  sent_at      TIMESTAMPTZ DEFAULT NOW(),
  sent_by      UUID REFERENCES auth.users(id),
  expires_at   TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- EVENT LOG: every action, immutable audit trail
-- ─────────────────────────────────────────────
CREATE TABLE leod_event_log (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID REFERENCES leod_events(id),
  session_id     UUID REFERENCES leod_sessions(id),
  ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operator_id    UUID REFERENCES auth.users(id),
  operator_role  TEXT,
  action         TEXT NOT NULL,        -- see Action Vocabulary below
  from_status    TEXT,
  to_status      TEXT,
  payload        JSONB,                -- full context snapshot
  server_time_ms BIGINT,               -- epoch ms from server at moment of action
  ip_address     INET
);

-- ─────────────────────────────────────────────
-- CLOCK: server time anchor for clients
-- ─────────────────────────────────────────────
CREATE TABLE leod_clock (
  id          TEXT PRIMARY KEY DEFAULT 'master',
  server_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- refreshed every second by Edge Function cron
  -- clients compute offset: serverTime - clientTime
  tick        BIGINT DEFAULT 0
);
```

### 2.2 Action Vocabulary (event log `action` column)

```
SESSION_STATUS_CHANGE     DELAY_ADDED            DELAY_CLEARED
SPEAKER_ARRIVED           SPEAKER_NO_SHOW        SPEAKER_CALLED
STREAM_STARTED            STREAM_STOPPED
RECORDING_ARMED           RECORDING_STARTED      RECORDING_STOPPED
INTERPRETATION_READY      CHANNEL_ACTIVATED
BROADCAST_SENT            BROADCAST_CLEARED
OPERATOR_CONNECTED        OPERATOR_DISCONNECTED
HOLD_ACTIVATED            HOLD_RELEASED
SESSION_EXTENDED          SESSION_SHORTENED
EVENT_START               EVENT_END
SYSTEM_RESTART            CLIENT_RESYNC
```

---

## Part 3 — Session State Machine

### 3.1 State definitions

| State | Meaning | Visual |
|-------|---------|--------|
| `PLANNED` | Scheduled, not yet in play | Blue dim |
| `READY` | Cued — operator has armed this session | Amber glow |
| `CALLING` | Speaker being called to stage | Amber pulse |
| `LIVE` | Session is running | Red glow + pulse |
| `OVERRUN` | Session still running past scheduled end | Magenta |
| `HOLD` | Live but paused — technical/delay hold | Amber blink |
| `ENDED` | Session completed | Grey dim |
| `CANCELLED` | Will not happen | Strikethrough |

### 3.2 Allowed state transitions

```
PLANNED    → READY       (operator arms next session)
PLANNED    → CANCELLED   (director cancels)

READY      → CALLING     (stage manager calls speaker)
READY      → LIVE        (skip calling — direct start)
READY      → PLANNED     (de-arm, push back)
READY      → CANCELLED   (director cancels)

CALLING    → LIVE        (speaker confirmed on stage)
CALLING    → HOLD        (speaker not arrived, stage manager holds)
CALLING    → READY       (pulled back to armed)
CALLING    → CANCELLED   (speaker no-show confirmed)

LIVE       → OVERRUN     (automatic — time engine detects past scheduled_end)
LIVE       → HOLD        (stage manager pauses session)
LIVE       → ENDED       (operator ends session)

OVERRUN    → ENDED       (operator ends the overrunning session)
OVERRUN    → HOLD        (emergency hold on overrunning session)

HOLD       → LIVE        (hold released — session resumes)
HOLD       → ENDED       (session cancelled from hold state)
HOLD       → CALLING     (re-calling speaker after hold)

ENDED      → (terminal — no transitions allowed)
CANCELLED  → PLANNED     (director reinstates session)
```

### 3.3 State transition table (X = forbidden)

```
FROM ╲ TO    PLANNED  READY  CALLING  LIVE  OVERRUN  HOLD  ENDED  CANCELLED
─────────────────────────────────────────────────────────────────────────────
PLANNED        —       ✓       X       X       X       X     X       ✓
READY          ✓       —       ✓       ✓       X       X     X       ✓
CALLING        ✓       ✓       —       ✓       X       ✓     X       ✓
LIVE           X       X       X       —       AUTO    ✓     ✓       X
OVERRUN        X       X       X       X       —       ✓     ✓       X
HOLD           X       ✓       ✓       ✓       X       —     ✓       X
ENDED          X       X       X       X       X       X     —       X
CANCELLED      ✓       X       X       X       X       X     X       —
```

### 3.4 Server-side transition validator (Edge Function pseudocode)

```javascript
// supabase/functions/transition-session/index.ts

const ALLOWED = {
  PLANNED:   ['READY', 'CANCELLED'],
  READY:     ['CALLING', 'LIVE', 'PLANNED', 'CANCELLED'],
  CALLING:   ['LIVE', 'HOLD', 'READY', 'CANCELLED'],
  LIVE:      ['HOLD', 'ENDED'],        // OVERRUN is automatic, not operator
  OVERRUN:   ['ENDED', 'HOLD'],
  HOLD:      ['LIVE', 'ENDED', 'CALLING', 'READY'],
  ENDED:     [],                       // terminal
  CANCELLED: ['PLANNED'],
};

// Role permission matrix — who can trigger what transition
const CAN_TRANSITION = {
  director: '*',                       // all transitions
  stage:    {
    to: ['CALLING', 'LIVE', 'HOLD', 'READY', 'ENDED'],
  },
  av:       {
    to: ['HOLD'],                      // AV can only hold, not start/end
  },
  interp:   { to: [] },               // read-only for session state
  reg:      { to: [] },
  signage:  { to: [] },
};

export async function transitionSession(
  sessionId: string,
  toStatus: string,
  operator: Operator,
  payload: Record<string, unknown> = {}
) {
  // 1. Fetch current row WITH locking
  const { data: session } = await supabase
    .from('leod_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  // 2. Validate transition is allowed
  if (!ALLOWED[session.status]?.includes(toStatus)) {
    throw new TransitionError(
      `FORBIDDEN: ${session.status} → ${toStatus}`
    );
  }

  // 3. Validate role permission
  if (!canTransition(operator.role, toStatus)) {
    throw new PermissionError(
      `Role ${operator.role} cannot set status ${toStatus}`
    );
  }

  // 4. Optimistic lock — reject stale clients
  if (payload.version && payload.version !== session.version) {
    throw new ConflictError(
      'Version mismatch — another operator changed this session'
    );
  }

  // 5. Build update object
  const update: Record<string, unknown> = {
    status: toStatus,
    state_changed_at: new Date().toISOString(),
    state_changed_by: operator.id,
    version: session.version + 1,
  };

  if (toStatus === 'LIVE' && !session.actual_start) {
    update.actual_start = new Date().toISOString();
  }
  if (toStatus === 'ENDED') {
    update.actual_end = new Date().toISOString();
  }

  // 6. Write to DB (triggers Realtime broadcast automatically)
  const { error } = await supabase
    .from('leod_sessions')
    .update(update)
    .eq('id', sessionId)
    .eq('version', session.version);   // atomic check on version

  if (error) throw new ConflictError('Concurrent update — retry');

  // 7. Log to event log
  await supabase.from('leod_event_log').insert({
    session_id: sessionId,
    operator_id: operator.id,
    operator_role: operator.role,
    action: 'SESSION_STATUS_CHANGE',
    from_status: session.status,
    to_status: toStatus,
    payload,
    server_time_ms: Date.now(),
  });

  // 8. If ENDED, auto-advance next session to READY
  if (toStatus === 'ENDED') {
    await autoAdvanceNext(sessionId, operator);
  }
}
```

---

## Part 4 — Time Engine

### 4.1 The fundamental rule

> **The server is the only clock.**  
> Clients never compute time independently.  
> All timers are driven by server timestamps, not `Date.now()`.

### 4.2 Clock synchronization protocol

```
CLIENT BOOT SEQUENCE:
━━━━━━━━━━━━━━━━━━━━

1. Client records local timestamp T_client_before
2. Client fetches: GET /functions/v1/server-time
   Response: { serverTime: 1717500000123, tick: 98234 }
3. Client records local timestamp T_client_after
4. Round-trip latency = (T_client_after - T_client_before) / 2
5. Clock offset = serverTime - T_client_after + (latency / 2)

CLIENT TIME FORMULA:
  correctedNow() = Date.now() + clockOffset

DRIFT CORRECTION:
  Re-sync clock offset every 5 minutes.
  If drift > 500ms, re-sync immediately.
  Always use correctedNow() — never raw Date.now()
```

### 4.3 Scheduled vs actual time model

Each session tracks two parallel timelines:

```
PLANNED:    Immutable. What was in the programme.
            planned_start = '09:00'
            planned_end   = '09:45'

SCHEDULED:  Live. Shifts as delays accumulate.
            scheduled_start = planned_start + cumulative_delay
            scheduled_end   = planned_end   + cumulative_delay

ACTUAL:     Written by server when LIVE/ENDED transitions occur.
            actual_start = TIMESTAMPTZ (server time at LIVE)
            actual_end   = TIMESTAMPTZ (server time at ENDED)
```

### 4.4 Delay propagation — exact algorithm

**Trigger:** Stage Manager clicks `+8 MIN DELAY` on session index `i`.

```javascript
// Edge Function: add-delay/index.ts

export async function addDelay(
  sessionId: string,
  additionalMinutes: number,
  operator: Operator
) {
  // 1. Find the session being delayed
  const { data: sessions } = await supabase
    .from('leod_sessions')
    .select('*')
    .order('sort_order');

  const idx = sessions.findIndex(s => s.id === sessionId);
  const target = sessions[idx];

  // Only LIVE, OVERRUN, HOLD, READY sessions can receive delay
  const activeStates = ['LIVE','OVERRUN','HOLD','READY','CALLING'];
  if (!activeStates.includes(target.status)) {
    throw new Error('Cannot delay a completed or planned session');
  }

  // 2. Calculate new delay for this session
  const newDelay = target.delay_minutes + additionalMinutes;

  // 3. Cascade to ALL following sessions that are not ENDED/CANCELLED
  const updates = [];

  for (let j = idx; j < sessions.length; j++) {
    const s = sessions[j];
    if (s.status === 'ENDED' || s.status === 'CANCELLED') continue;

    // Add delay to scheduled times (not planned — those stay pristine)
    const newStart = addMinutes(s.scheduled_start, additionalMinutes);
    const newEnd   = addMinutes(s.scheduled_end,   additionalMinutes);

    updates.push(supabase
      .from('leod_sessions')
      .update({
        scheduled_start:  newStart,
        scheduled_end:    newEnd,
        cumulative_delay: s.cumulative_delay + additionalMinutes,
        // Only update delay_minutes on the source session
        ...(j === idx ? { delay_minutes: newDelay, status: 'OVERRUN' } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', s.id)
    );
  }

  // 4. Execute all updates in parallel (Realtime broadcasts each)
  await Promise.all(updates);

  // 5. Log
  await supabase.from('leod_event_log').insert({
    session_id: sessionId,
    action: 'DELAY_ADDED',
    payload: {
      added_minutes: additionalMinutes,
      sessions_affected: updates.length,
      new_cumulative: target.cumulative_delay + additionalMinutes,
    },
    operator_id: operator.id,
    operator_role: operator.role,
    server_time_ms: Date.now(),
  });
}
```

**Result:** All screens update simultaneously through Supabase Realtime. Every client redraws the timeline from the new `scheduled_start`/`scheduled_end` values. Playhead position stays derived from server time. The timeline shifts right visually for all downstream sessions at the same moment.

### 4.5 OVERRUN detection — server-side cron

Sessions do not self-transition. A server cron job checks every 30 seconds:

```javascript
// supabase/functions/time-engine/index.ts  (invoked by pg_cron every 30s)

export async function checkOverruns() {
  const now = new Date();

  // Find LIVE sessions that have passed their scheduled_end
  const { data: overdue } = await supabase
    .from('leod_sessions')
    .select('*')
    .eq('status', 'LIVE')
    .lt('scheduled_end', now.toTimeString().substring(0,5)); // HH:MM comparison

  for (const session of overdue ?? []) {
    await supabase
      .from('leod_sessions')
      .update({
        status: 'OVERRUN',
        state_changed_at: now.toISOString(),
        version: session.version + 1,
      })
      .eq('id', session.id)
      .eq('status', 'LIVE');   // Guard: only update if still LIVE

    await supabase.from('leod_event_log').insert({
      session_id: session.id,
      action: 'SESSION_STATUS_CHANGE',
      from_status: 'LIVE',
      to_status: 'OVERRUN',
      payload: {
        scheduled_end: session.scheduled_end,
        overrun_by_ms: now.getTime() - timeToMs(session.scheduled_end),
        auto: true,
      },
      server_time_ms: Date.now(),
    });
  }
}
```

### 4.6 Playhead position formula

The playhead is not animated by CSS. It is positioned by data:

```javascript
// Client-side (runs in tick() every second)

function getPlayheadPosition(sessions, scrollWidth) {
  if (!sessions.length) return 0;

  const eventStart = toMinutes(sessions[0].scheduled_start);
  const eventEnd   = toMinutes(sessions[sessions.length - 1].scheduled_end);
  const totalMin   = eventEnd - eventStart;

  // Use correctedNow() — server-offset clock, never raw Date.now()
  const nowMs  = correctedNow();
  const nowMin = toMinutesFromMs(nowMs);

  const position = ((nowMin - eventStart) / totalMin) * scrollWidth;
  return Math.max(0, Math.min(scrollWidth, position));
}
```

---

## Part 5 — WebSocket Transport

### 5.1 Channel architecture

```
Supabase Realtime channels used:

leod:control        — session state changes, operator commands, delays
leod:clock          — server time tick (every 1 second)
leod:alerts         — broadcast messages, system alerts
leod:presence       — which operators are currently online

Passive clients subscribe to:
leod:control        — session changes only (no presence needed)
leod:clock          — time sync
```

### 5.2 Message schema

All WebSocket messages follow this envelope:

```typescript
interface LEODMessage {
  type:      string;           // event type — see vocabulary below
  id:        string;           // unique message ID (UUID)
  ts:        number;           // server epoch ms at time of send
  session_id?: string;
  event_id:  string;
  payload:   Record<string, unknown>;
  version?:  number;           // session version at time of message
}
```

### 5.3 Sample WebSocket messages

**SESSION_STATE_CHANGE — Keynote goes LIVE:**
```json
{
  "type":       "SESSION_STATE_CHANGE",
  "id":         "msg_3f9a2b1c",
  "ts":         1717500312847,
  "session_id": "sess_0082",
  "event_id":   "evt_infoshare25",
  "payload": {
    "from_status":    "READY",
    "to_status":      "LIVE",
    "title":          "The Future of AI in Enterprise",
    "speaker":        "Anna Kowalska",
    "room":           "Main Stage",
    "scheduled_start": "09:15",
    "scheduled_end":   "10:00",
    "actual_start":   "2025-05-29T09:18:32Z",
    "operator_id":    "op_stage_01",
    "operator_role":  "stage",
    "version":        4
  }
}
```

**DELAY_ADDED — 8-minute cascade:**
```json
{
  "type":       "DELAY_ADDED",
  "id":         "msg_7d4e1f2a",
  "ts":         1717501827340,
  "session_id": "sess_0082",
  "event_id":   "evt_infoshare25",
  "payload": {
    "source_session":     "sess_0082",
    "source_title":       "The Future of AI in Enterprise",
    "added_minutes":      8,
    "sessions_cascaded":  5,
    "new_schedule": [
      { "id": "sess_0082", "scheduled_start": "09:15", "scheduled_end": "10:08" },
      { "id": "sess_0083", "scheduled_start": "10:08", "scheduled_end": "10:23" },
      { "id": "sess_0084", "scheduled_start": "10:23", "scheduled_end": "11:08" },
      { "id": "sess_0085", "scheduled_start": "11:08", "scheduled_end": "12:08" },
      { "id": "sess_0086", "scheduled_start": "12:30", "scheduled_end": "13:00" }
    ],
    "operator_id":   "op_stage_01",
    "operator_role": "stage"
  }
}
```

**CLOCK_TICK — server time authority:**
```json
{
  "type":    "CLOCK_TICK",
  "id":      "msg_clock_98234",
  "ts":      1717500313000,
  "payload": {
    "server_time":    1717500313000,
    "tick":           98234,
    "timezone":       "Europe/Warsaw",
    "local_time":     "09:18:33",
    "event_progress": 22.4
  }
}
```

**OPERATOR_PRESENCE:**
```json
{
  "type":    "PRESENCE_UPDATE",
  "id":      "msg_p_44f1",
  "ts":      1717500290000,
  "payload": {
    "online": [
      { "id": "op_01", "role": "director", "name": "Sherif", "since": 1717498800000 },
      { "id": "op_02", "role": "stage",    "name": "Marta",  "since": 1717498810000 },
      { "id": "op_03", "role": "av",       "name": "Piotr",  "since": 1717498820000 }
    ],
    "count": 3
  }
}
```

**BROADCAST_MESSAGE:**
```json
{
  "type":    "BROADCAST_MESSAGE",
  "id":      "msg_bc_991a",
  "ts":      1717501200000,
  "payload": {
    "message":   "Panel speakers: please move to green room NOW",
    "priority":  "critical",
    "sent_by":   "op_stage_01",
    "expires_at": "2025-05-29T10:30:00Z"
  }
}
```

**SESSION_ENDED + AUTO_ADVANCE:**
```json
{
  "type":       "SESSION_ENDED",
  "id":         "msg_end_0082",
  "ts":         1717501945000,
  "session_id": "sess_0082",
  "payload": {
    "actual_start":       "2025-05-29T09:18:32Z",
    "actual_end":         "2025-05-29T10:09:05Z",
    "planned_duration":   45,
    "actual_duration":    51,
    "overrun_minutes":    6,
    "next_advanced": {
      "session_id":   "sess_0083",
      "title":        "Coffee Break",
      "from_status":  "PLANNED",
      "to_status":    "READY"
    }
  }
}
```

### 5.4 Client subscription setup

```javascript
// client/sync-engine.js

class LEODSyncEngine {
  constructor(supabase, eventId) {
    this.sb       = supabase;
    this.eventId  = eventId;
    this.state    = { sessions: [], broadcast: null, operators: [] };
    this.handlers = new Map();
    this.clockOffset = 0;
    this.retryCount  = 0;
  }

  async init() {
    // 1. Sync server clock first
    await this.syncClock();

    // 2. Load full state snapshot
    await this.loadSnapshot();

    // 3. Subscribe to channels
    this.subscribeControl();
    this.subscribeAlerts();
    this.subscribePresence();

    // 4. Start local clock tick (uses correctedNow())
    setInterval(() => this.localTick(), 1000);

    // 5. Re-sync clock every 5 minutes
    setInterval(() => this.syncClock(), 300_000);
  }

  subscribeControl() {
    this.controlChannel = this.sb
      .channel(`leod:control:${this.eventId}`)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'leod_sessions',
            filter: `event_id=eq.${this.eventId}` },
          (payload) => this.handleSessionChange(payload)
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.retryCount = 0;
          this.emit('connection', { status: 'live' });
        } else if (status === 'CHANNEL_ERROR') {
          this.handleDisconnect();
        }
      });
  }

  handleSessionChange(payload) {
    const updated = mapRow(payload.new);
    const idx = this.state.sessions.findIndex(s => s.id === updated.id);

    if (payload.eventType === 'DELETE') {
      this.state.sessions = this.state.sessions.filter(s => s.id !== updated.id);
    } else if (idx >= 0) {
      // Optimistic update: discard if our local version is newer
      if (this.state.sessions[idx].version > updated.version) return;
      this.state.sessions[idx] = updated;
    } else {
      this.state.sessions.push(updated);
      this.state.sessions.sort((a, b) => a.sortOrder - b.sortOrder);
    }

    this.emit('state', this.state);
  }

  correctedNow() {
    return Date.now() + this.clockOffset;
  }

  async syncClock() {
    const before = Date.now();
    const { data } = await this.sb
      .from('leod_clock')
      .select('server_time')
      .eq('id', 'master')
      .single();
    const after = Date.now();
    const rtt = after - before;
    const serverMs = new Date(data.server_time).getTime();
    this.clockOffset = serverMs - after + (rtt / 2);
  }
}
```

---

## Part 6 — Role Permissions & Conflict Resolution

### 6.1 Command authorization matrix

| Action | Director | Stage Mgr | AV Tech | Interp | Reg | Signage |
|--------|----------|-----------|---------|--------|-----|---------|
| PLANNED → READY | ✓ | ✓ | — | — | — | — |
| READY → LIVE | ✓ | ✓ | — | — | — | — |
| LIVE → ENDED | ✓ | ✓ | — | — | — | — |
| LIVE → HOLD | ✓ | ✓ | ✓ | — | — | — |
| HOLD → LIVE | ✓ | ✓ | — | — | — | — |
| ANY → CANCELLED | ✓ | — | — | — | — | — |
| Add delay | ✓ | ✓ | — | — | — | — |
| Speaker arrived | ✓ | ✓ | — | — | — | — |
| Stream control | ✓ | — | ✓ | — | — | — |
| Recording | ✓ | — | ✓ | — | — | — |
| Interp ready | ✓ | — | — | ✓ | — | — |
| Broadcast send | ✓ | ✓ | — | — | — | — |
| View only | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### 6.2 Race condition: two operators click GO LIVE simultaneously

**Scenario:** Stage Manager and Production Director both click LIVE on the same session at `T+0ms`.

```
T+0ms   Stage Manager sends:  POST /transition { sessionId, to: 'LIVE', version: 3 }
T+1ms   Director sends:       POST /transition { sessionId, to: 'LIVE', version: 3 }

SERVER RECEIVES BOTH:
  Request A (Stage Mgr, T+0ms) enters Edge Function
  Request B (Director, T+1ms)  enters Edge Function

DATABASE EXECUTION:
  A runs UPDATE ... WHERE id=sess AND version=3
    → Rows matched: 1 ✓
    → Sets version=4, status=LIVE, actual_start=now()
    → Returns: success

  B runs UPDATE ... WHERE id=sess AND version=3
    → Rows matched: 0 (version is now 4)
    → Returns: no rows affected

SERVER RESPONSE:
  A → { success: true, new_version: 4 }
  B → { success: false, error: 'CONFLICT', current_version: 4 }

CLIENT B RECEIVES CONFLICT:
  1. Fetches current session (version: 4, status: LIVE)
  2. Discards its pending command
  3. Updates local state from server snapshot
  4. Shows to Director: "Already set LIVE by Stage Manager"
  5. Director UI updates to show LIVE — no double-trigger
```

This works because the Edge Function uses `WHERE version = :expected_version` as an atomic check. PostgreSQL serializable isolation guarantees only one UPDATE wins.

### 6.3 HOLD conflict — AV Tech and Stage Manager simultaneously

AV and Stage can both issue HOLD. The second HOLD on an already-HOLD session is a no-op (same state → same state is not a valid transition in the state machine). Server returns a soft rejection: "Session already on hold" — not an error, just a state sync.

---

## Part 7 — Confidence Monitor & Passive Clients

### 7.1 Architecture

Confidence monitor opens in a separate browser tab or dedicated display. It never sends commands. It never authenticates as an operator. It connects with an anon key that has read-only RLS policies.

```sql
-- Row Level Security for read-only clients
CREATE POLICY "anon_read_sessions"
  ON leod_sessions FOR SELECT
  USING (true);                -- all sessions visible

CREATE POLICY "anon_no_write"
  ON leod_sessions FOR INSERT, UPDATE, DELETE
  USING (false);               -- no writes from anon
```

### 7.2 Resync after network interruption

```javascript
class ConfidenceMonitor extends LEODSyncEngine {

  constructor(supabase, eventId) {
    super(supabase, eventId);
    this.isPassive = true;
    this.lastKnownState = null;
    this.gapDetected = false;
  }

  handleDisconnect() {
    this.emit('connection', { status: 'reconnecting' });
    this.showReconnectOverlay();   // "⟳ RECONNECTING..." banner on screen
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30_000);
    this.retryCount++;
    setTimeout(() => this.reconnect(), delay);
  }

  async reconnect() {
    try {
      // 1. Re-sync clock (device may have slept, clock drifted)
      await this.syncClock();

      // 2. Fetch full state snapshot — skip any events we missed
      await this.loadSnapshot();

      // 3. Re-subscribe to channels
      await this.controlChannel?.unsubscribe();
      this.subscribeControl();

      // 4. Log resync event
      await this.sb.from('leod_event_log').insert({
        action:  'CLIENT_RESYNC',
        payload: {
          client_type:    'confidence_monitor',
          reconnect_at:   new Date().toISOString(),
          retry_count:    this.retryCount,
          gap_detected:   this.gapDetected,
        }
      });

      this.retryCount = 0;
      this.gapDetected = false;
      this.hideReconnectOverlay();
      this.emit('connection', { status: 'live' });

    } catch (err) {
      // Failed to reconnect — try again
      this.scheduleReconnect();
    }
  }

  async loadSnapshot() {
    // On reconnect: always get a fresh full state, don't trust local state
    const { data: sessions } = await this.sb
      .from('leod_sessions')
      .select('*')
      .eq('event_id', this.eventId)
      .order('sort_order');

    this.state.sessions = (sessions || []).map(mapRow);
    this.lastKnownState = JSON.stringify(this.state.sessions);
    this.emit('state', this.state);
  }
}
```

**What the screen shows during disconnect (3-second grace period, then overlay):**

```
┌──────────────────────────────────┐
│                                  │
│      THE FUTURE OF AI IN         │
│           ENTERPRISE             │
│                                  │
│         Anna Kowalska            │
│                                  │
│            14:32                 │
│         REMAINING                │
│                                  │
│   ⟳ RECONNECTING — DATA MAY     │
│         BE STALE                 │
│                                  │
└──────────────────────────────────┘
```

The last known state remains frozen on screen — better than a blank screen backstage.

---

## Part 8 — Failure Handling

### 8.1 Failure matrix

| Failure | Detection | Recovery behaviour |
|---------|-----------|-------------------|
| Browser refresh | Page load | `loadSnapshot()` on init — full state reload |
| WiFi drop | WS `CHANNEL_ERROR` | Exponential backoff reconnect + full snapshot on reconnect |
| Server restart | All WS connections drop | Supabase handles auto-reconnect, clients detect and re-sync |
| Laptop sleep/wake | `visibilitychange` event | Clock re-sync on `document.visibilitychange = visible` |
| Stale JWT | 401 on reconnect | Supabase JS auto-refreshes JWT, transparent to UI |
| Second operator takeover | Version conflict | Server returns `CONFLICT` — client discards local stale state and reloads from server snapshot |
| DB overload | Slow query | Edge Function 10s timeout — client shows degraded mode indicator |
| Partial cascade failure | Some delay updates fail | Retry logic in Edge Function; event log marks partial failure |

### 8.2 Operator browser refresh (most common failure)

```javascript
// On DOMContentLoaded — always run before render

async function initOnRefresh() {
  // 1. Show loading overlay (don't render stale state)
  showLoading();

  // 2. Re-authenticate from stored session
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { redirectToLogin(); return; }

  // 3. Sync clock first
  await syncEngine.syncClock();

  // 4. Load complete current state
  await syncEngine.loadSnapshot();

  // 5. Subscribe to real-time channels
  syncEngine.subscribeControl();
  syncEngine.subscribeAlerts();
  syncEngine.subscribePresence();

  // 6. Log reconnect
  await logAction('OPERATOR_CONNECTED', {
    reconnect: true,
    session_state_at_reconnect: syncEngine.state.sessions
                                          .find(s => s.status === 'LIVE')?.id
  });

  hideLoading();
  render();   // draw UI from fresh server state — never from localStorage
}
```

### 8.3 Sleep/wake detection

```javascript
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    // Device woke up — clock may have drifted by minutes
    await syncEngine.syncClock();

    // Check if realtime channel is still alive
    const channelState = syncEngine.controlChannel?.state;
    if (channelState !== 'joined') {
      await syncEngine.reconnect();
    } else {
      // Channel alive but we may have missed events during sleep
      await syncEngine.loadSnapshot();
    }
  }
});
```

### 8.4 Second operator taking over control

When an operator hands over to another person mid-event:

1. New operator opens browser on new machine
2. Logs in with their credentials
3. `init()` runs → loads full snapshot → subscribes
4. Presence channel shows both operators online
5. Director sees both in the presence indicator
6. No special handoff needed — state lives in DB, not in the leaving operator's browser
7. When the first operator closes their browser: presence leaves, Supabase presence detects departure, all clients see their indicator go offline

---

## Part 9 — Event Log & Post-Event Report

### 9.1 Log schema (detailed)

```json
{
  "id":            98234,
  "event_id":      "evt_infoshare25",
  "session_id":    "sess_0082",
  "ts":            "2025-05-29T09:18:32.841Z",
  "operator_id":   "op_stage_01",
  "operator_role": "stage",
  "action":        "SESSION_STATUS_CHANGE",
  "from_status":   "READY",
  "to_status":     "LIVE",
  "payload": {
    "session_title":    "The Future of AI in Enterprise",
    "speaker":          "Anna Kowalska",
    "room":             "Main Stage",
    "planned_start":    "09:00",
    "scheduled_start":  "09:15",
    "actual_start":     "2025-05-29T09:18:32Z",
    "delay_at_start":   18,
    "operator_name":    "Marta Nowak"
  },
  "server_time_ms": 1717500312841,
  "ip_address":     "10.0.1.42"
}
```

### 9.2 Post-event report query

```sql
-- Generate post-event timeline report
SELECT
  s.sort_order,
  s.title,
  s.speaker,
  s.room,
  s.planned_start,
  s.scheduled_end   AS final_scheduled_end,
  TO_CHAR(s.actual_start AT TIME ZONE 'Europe/Warsaw', 'HH24:MI:SS') AS started_at,
  TO_CHAR(s.actual_end   AT TIME ZONE 'Europe/Warsaw', 'HH24:MI:SS') AS ended_at,
  EXTRACT(EPOCH FROM (s.actual_end - s.actual_start))/60  AS actual_duration_min,
  s.delay_minutes,
  s.cumulative_delay,
  s.status,

  -- Operators who touched this session
  (SELECT json_agg(DISTINCT l.operator_role)
   FROM leod_event_log l
   WHERE l.session_id = s.id) AS roles_involved,

  -- Number of operational actions
  (SELECT COUNT(*) FROM leod_event_log l WHERE l.session_id = s.id) AS action_count

FROM leod_sessions s
WHERE s.event_id = 'evt_infoshare25'
ORDER BY s.sort_order;
```

**Output example:**

| # | Title | Planned | Started | Ended | Duration | Delay |
|---|-------|---------|---------|-------|----------|-------|
| 1 | Opening Ceremony | 09:00 | 09:02 | 09:17 | 15 min | +2m |
| 2 | Keynote: AI Future | 09:15 | 09:18 | 10:09 | 51 min | +18m |
| 3 | Coffee Break | 10:00 | 10:09 | 10:26 | 17 min | +18m |
| 4 | Panel: Startups | 10:30 | 10:26 | 11:45 | 79 min | +18m |

---

## Part 10 — Implementation Checklist

### Server (Supabase)
- [ ] Create all tables with constraints and RLS policies
- [ ] Deploy `transition-session` Edge Function with version locking
- [ ] Deploy `add-delay` Edge Function with cascade logic
- [ ] Deploy `time-engine` Edge Function (pg_cron every 30s for OVERRUN detection)
- [ ] Set up `leod_clock` table + cron update every second
- [ ] Configure Realtime publications for all `leod_*` tables
- [ ] Set up Row Level Security — operators write, anon reads

### Client (browser)
- [ ] Implement `LEODSyncEngine` class with clock sync
- [ ] Replace all `Date.now()` calls with `correctedNow()`
- [ ] Implement exponential backoff reconnect
- [ ] Wire `visibilitychange` handler for sleep/wake
- [ ] Implement version check before applying optimistic updates
- [ ] Implement `loadSnapshot()` — called on boot, reconnect, and wake
- [ ] Remove all client-side state transitions (server only)

### Operations
- [ ] Test with 6 simultaneous operator connections
- [ ] Simulate WiFi drop mid-session
- [ ] Test 2-operator simultaneous GO LIVE conflict
- [ ] Verify delay cascade with 8 sessions downstream
- [ ] Confirm confidence monitor reconnects without manual refresh
- [ ] Validate post-event log completeness

---

*CueDeck Sync Engine Specification v1.0*
*CueDeck — Internal Technical Document*
