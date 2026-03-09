# CueDeck Console — UI Specification

**Authored by:** UX Architect (Console Systems)
**Status:** Phase 1 — Design Output
**Architecture constraint:** Pure HTML/CSS/JS — no framework, no build system

---

## 1. Zone Model

The console is divided into four named zones. All UI changes must be scoped to a zone; cross-zone side effects require explicit justification.

```
┌─────────────────────────────────────────────────────────┐
│  ZONE A — Header Bar                                    │
├──────────────┬──────────────────────────────────────────┤
│              │  ZONE B — Role + Filter Bar              │
│  ZONE C      ├──────────────────────────────────────────┤
│  Session     │                                          │
│  List /      │  ZONE D — Sidebar                        │
│  Timeline    │  (Clock · Log · Broadcast · Context)     │
│              │                                          │
└──────────────┴──────────────────────────────────────────┘
```

---

## 2. Zone A — Header Bar

**Purpose:** Event identity + system health at a glance. Read-only from operator perspective.

**Elements (left → right):**
| Element | ID/Class | Content | Notes |
|---------|----------|---------|-------|
| Logo mark | `#logo` | "CueDeck" wordmark | Links to reload |
| Event name | `#ev-name` | Current event title | Truncated with ellipsis at 240px |
| Server clock | `#server-clock` | HH:MM:SS (monospace) | Corrected server time; red border if clock offset >1s |
| Connection pill | `#conn-pill` | LIVE / RECONNECTING / OFFLINE | Colour: green / amber / red |
| Logout | `#logout-btn` | Icon + "Logout" | Right-aligned |

**Diagnostic Bar** (below header, collapsible):
`#diag-bar` — 5 pill indicators: DB · RT · CK · EF · OFFSET
- Collapsed by default for non-director roles
- Director: always visible
- Clicking any pill opens a detail tooltip

**Behaviour:**
- Clock ticks every second via `refreshClockUI()`
- Connection pill transitions: OFFLINE → LIVE on SUBSCRIBED, → RECONNECTING on CHANNEL_ERROR
- Header is sticky (`position: sticky; top: 0; z-index: 100`)

---

## 3. Zone B — Role + Filter Bar

**Purpose:** Role switching and session filtering. Controls what Zone C displays.

### 3a. Role Bar (`#role-bar`)

Six role buttons + event selector:

| Button | `data-role` | Visible sessions | Write access |
|--------|-------------|-----------------|--------------|
| Director | `director` | All | Full |
| Stage | `stage` | All | READY→CALLING→LIVE→ENDED |
| A/V | `av` | All | HOLD only |
| Interp | `interp` | All | None (read + speaker-arrived flag) |
| Reg | `reg` | All | None |
| Signage | `signage` | Replaces session list with signage panel | None |

- Active role button: highlighted with `--accent` border + background tint
- Event selector (`#ev-select`): dropdown, right-aligned in role bar
- Role persists for session (localStorage not used — role loaded from `leod_users` at login)

### 3b. Filter Bar (`#filter-bar`)

Three filter controls, all live (no submit button):

| Control | ID | Type | Filters by |
|---------|-----|------|-----------|
| Text search | `#f-text` | `<input type="search">` | title, speaker, room (case-insensitive) |
| Status | `#f-status` | `<select>` | Exact status match or "All" |
| Room | `#f-room` | `<select>` | Exact room match or "All" |

- Room dropdown populates dynamically from distinct rooms in `S.sessions`
- Active filters: filter bar has amber left-border when any filter is set
- "Clear filters" × button appears when any filter active

**Role-specific visibility:**
- `interp`, `reg`: filter bar shown, but status/room may be pre-filtered to avoid cognitive load (future PR)
- `signage`: filter bar hidden (not relevant)

---

## 4. Zone C — Session List / Timeline

**Purpose:** Primary operational view. One card per session. Ordered by `sort_order` (ascending).

### 4a. Session Card (`.sc`)

Each card has four rows:

```
┌────────────────────────────────────────────────────┐
│ [STATUS BADGE] Title                    [ROOM TAG] │  ← .sc-top
│ Speaker • HH:MM – HH:MM           [delay badge?]  │  ← .sc-meta
│ [live timer or scheduled time]                     │  ← .sc-times
│ [Action buttons]                                   │  ← .sc-actions
└────────────────────────────────────────────────────┘
```

**Status badge (`.sc-badge`):**
| Status | Colour | Animation |
|--------|--------|-----------|
| PLANNED | dim grey | none |
| READY | blue | none |
| CALLING | amber | `pulse-amber` 1.2s |
| LIVE | red | `pulse-red` 2s |
| OVERRUN | magenta | `pulse-magenta` 1.5s |
| HOLD | orange | `blink` 1s |
| ENDED | muted green | none |
| CANCELLED | dim grey | strikethrough on title |

**Card left border:** 3px solid matching status colour (CSS variable `--status-{status}`).

**Live timer (`.live-timer`):**
- Visible only for LIVE and OVERRUN sessions
- Format: `+MM:SS` elapsed (LIVE) or `+MM:SS OVERRUN` in magenta (OVERRUN)
- Updates every second via 1s tick
- Progress bar (`.live-bar`): fills from 0→100% across planned duration; red when over

**Delay badge:**
- Shown when `session.cumulative_delay > 0`
- Format: `+Xm` in amber
- Tooltip: "Running Xm behind schedule"

**Action buttons (`.sc-actions`):**
- Generated by `buildButtons(session)` based on `ALLOWED` + `ROLE_WRITE`
- Buttons hidden if role has no write access
- Button states: enabled (default) / disabled (greyed, not hidden) / loading (spinner, non-interactive during EF call)
- Confirmation required for: CANCEL, ENDED (single click for LIVE/CALLING — speed is operational requirement)

### 4b. Delay Strip (`#delay-strip`)

Amber banner above session list:
`⚠ Event is running Xm behind schedule — [Reset Delays]`
- Visible when any session has `cumulative_delay > 0`
- Reset Delays button calls `applyDelay(anchor, 0)` on earliest delayed session

### 4c. NEXT UP Indicator

A sticky "NEXT UP" label appears above the first non-ENDED, non-CANCELLED session
when there is a LIVE session above it in the list. Helps stage operators identify handoff.
- CSS class: `.next-up-label` (injected once per render)
- Not shown in `reg` or `signage` roles

### 4d. Timeline View Mode (future — PR-012)

Toggle between **List View** (default) and **Timeline View**:
- Timeline: sessions rendered as horizontal bars on a time axis
- Each bar: width = planned duration, position = planned_start offset from event start
- Bars colour-coded by status
- Not in current implementation — backlogged

---

## 5. Zone D — Sidebar

Fixed 272px right column. Sections from top to bottom:

### 5a. Active Session Monitor (`#stage-monitor`)

- Shows the currently LIVE or CALLING session prominently
- Elements: status badge (large), title, speaker, room, elapsed time, planned end
- Collapsed when no active session
- Director: also shows "Next" session preview below
- Clicking expands to fullscreen confidence overlay (`#confidence-overlay`)

### 5b. Event Log (`#event-log`)

- Scrollable list, newest at top
- Each entry: `[HH:MM:SS] ACTION — detail`
- Colour-coded: STATUS_CHANGE (white), ERROR (red), DELAY (amber), BROADCAST (blue)
- Max 200 entries in memory (`S.log` capped)
- "Clear" button (director only) clears local display only (DB log immutable)

### 5c. Broadcast Bar (`#broadcast-bar`)

- Text area (max 120 chars) + char counter
- Preset buttons: Break · Fire Drill · Lunch · Return
- Send button → writes to `leod_broadcast` via authenticated insert
- Active broadcast shown as dismissible banner at top of Zone C

### 5d. Signage Panel (`#signage-panel`)

Replaces session list in Zone C AND shows control summary in Zone D when `S.role === 'signage'`.
- Zone D shows: display count, how many online (heartbeat < 90s), global override controls
- Zone C shows: display card grid

---

## 6. Role-Based View Matrix

| Zone | director | stage | av | interp | reg | signage |
|------|----------|-------|----|--------|-----|---------|
| A (header) | Full | Full | Full | Full | Full | Full |
| A (diag-bar) | Visible | Collapsed | Collapsed | Collapsed | Hidden | Hidden |
| B (role bar) | All 6 btns | All 6 btns | All 6 btns | All 6 btns | All 6 btns | All 6 btns |
| B (filter) | Full | Full | Full | Full | Full | Hidden |
| C (sessions) | Full cards | Full cards | Full cards | Read-only | Read-only | Hidden (→ signage panel) |
| C (actions) | All | Stage subset | HOLD only | None | None | None |
| D (monitor) | Full + Next | Active only | Active only | Active only | Active only | Display count |
| D (log) | Full | Full | Full | Full | Read | Hidden |
| D (broadcast) | Full | Read | Read | Read | Read | Read |
| D (signage) | Summary | Hidden | Hidden | Hidden | Hidden | Full |

---

## 7. Confidence Monitor (Fullscreen Overlay)

**Trigger:** Click the stage monitor in Zone D, or keyboard shortcut `F` (director only).
**ID:** `#confidence-overlay`
**Purpose:** Large-format display for director to confirm live status from distance.

**Elements:**
```
┌─────────────────────────────────────────┐
│  ● LIVE                                 │  ← large status badge
│                                         │
│  Session Title                          │  ← 48px font
│  Speaker Name                           │  ← 24px dim
│                                         │
│  +12:34          ends at 14:30          │  ← elapsed / end time
│                                         │
│  ─────── NEXT UP ─────────────────────  │
│  Next Session Title                     │  ← 20px, dimmed
└─────────────────────────────────────────┘
```

- Click anywhere to dismiss
- Keyboard `Escape` to dismiss
- Updates live via 1s tick
- Read-only — no action buttons

---

## 8. Modals

All modals share the `.ev-modal-backdrop` + `.ev-modal-card` pattern.
`display: flex` to open, `display: none` to close.
Clicking backdrop closes modal. `Escape` key closes modal.

| Modal | ID | Trigger | Purpose |
|-------|-----|---------|---------|
| Session | `#sess-modal` | Add/Edit session | Create or edit session fields |
| Display | `#disp-modal` | Add/Edit display | Signage display registration |
| Sponsor | `#spon-modal` | Add/Edit sponsor | Sponsor library management |
| Event | `#ev-modal` | New event | Create new event |

---

## 9. Accessibility Notes

- All interactive elements must have visible focus states (`:focus-visible` outline)
- Status badges use both colour AND text label (not colour-only)
- Animations respect `prefers-reduced-motion` media query — pulse/blink → static where applicable
- Font size minimum 14px for operational text; 16px for action buttons
- Buttons readable from 2m distance in dim lighting (target: operator at mixing desk)
- Role buttons minimum 44×44px tap target
