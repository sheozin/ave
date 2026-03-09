# CueDeck Console — Interaction Specification

**Authored by:** Interaction Designer
**Status:** Phase 1 — Design Output
**Scope:** Micro-interactions, error states, reconnect UX, delay propagation, operator feedback

---

## 1. Button Interactions

### State Machine for Action Buttons

```
[enabled] → click → [loading] → success → [enabled] (state updated)
                              → conflict → [enabled] (rollback, error toast)
                              → in-flight → [enabled] (ignored, no feedback)
                              → error     → [enabled] (error toast)
```

### Press Feedback (< 150ms)

1. **mousedown:** Button scale `transform: scale(0.96)` — immediate tactile response
2. **click:** Button enters `loading` class — text replaced with spinner icon, pointer-events disabled
3. **EF response:** loading class removed — state updated (or rolled back on error)

No confirm dialog for LIVE, CALLING, ENDED transitions — speed is operationally required.

**Exception — CANCEL only:** Single inline confirmation:
- Button label changes to `"CONFIRM CANCEL"` (red, 2s timeout)
- If clicked within 2s: proceeds
- If not clicked: reverts to original label
- No modal — stays in the card to maintain spatial context

### Double-Click Protection

`command_id` is generated on first click and stored per-session (`_cmdMap.set(sessionId, id)`).
If a second click arrives before the first EF response:
- Same `command_id` sent → EF returns `IN_FLIGHT` → client silently ignores
- Button stays in loading state from first click
- Result: visually no-op, operationally safe

---

## 2. State Transition Feedback

### Optimistic Update

On button click (before EF response):
1. Session card status badge updates immediately to target status
2. Card left-border transitions to target status colour (`transition: border-color 150ms`)
3. New action buttons render for the new status (the EF call locks the state server-side)

### Conflict / Rollback

If EF returns 409 (version conflict):
1. Badge reverts to pre-click status (< 250ms)
2. Border reverts
3. Inline error toast slides in below the card:
   ```
   ⚠ Updated by another operator — refreshing
   ```
   Auto-dismisses after 3s. No operator action required.
4. `loadSessions()` called to pull latest state

### Network Error / EF Unavailable

If EF invoke throws network error (not 409):
1. Optimistic update rolls back
2. Inline error toast:
   ```
   ✕ Connection error — try again
   ```
3. Button re-enabled immediately so operator can retry

---

## 3. Reconnect Behavior

### Trigger Conditions

| Trigger | Detection | Response |
|---------|-----------|----------|
| WebSocket drop | `CHANNEL_ERROR` from Supabase | Schedule reconnect |
| Laptop sleep/wake | 1s tick gap > 5000ms | Immediate reconnect + clock sync |
| Tab visibility restore | `document.visibilitychange` visible | Reconnect + clock sync if channel not joined |
| Manual | None currently | *(Future: add manual retry button)* |

### Reconnect UX States

**State 1 — Drop detected (0–1s):**
- Connection pill → RECONNECTING (amber)
- `#rc-overlay` fades in (opacity 0 → 1 over 400ms): semi-transparent amber top banner
  ```
  ↺ Reconnecting… (attempt 1)
  ```
- Session cards become non-interactive (pointer-events: none overlay)
- Cards do NOT flash or disappear — last known state stays visible

**State 2 — Attempting (1s–30s):**
- Attempt counter increments in overlay: `↺ Reconnecting… (attempt 3)`
- Exponential backoff displayed: `Next attempt in Xs`
- Log entry: `SYSTEM — Connection lost, reconnecting`

**State 3 — Reconnected:**
- Overlay fades out (400ms)
- Connection pill → LIVE (green)
- `loadSnapshot()` runs — session cards update to server truth
- Log entry: `SYSTEM — Reconnected, state reloaded`
- Clock re-syncs silently

**State 4 — Prolonged disconnect (> 60s):**
- Overlay changes to:
  ```
  ✕ Connection lost
  Last sync: HH:MM:SS
  [Retry now]
  ```
- `[Retry now]` button triggers `doReconnect()` immediately (skips backoff wait)
- Session cards shown with dim overlay: `(offline — state may be stale)`

### Data Safety During Disconnect

- No button presses are silently dropped. If EF call fails during disconnect, error toast shows.
- Operator must re-press the button after reconnect.
- State loaded from server on reconnect may differ from last known local state.
- If a transition happened on another terminal during disconnect, the reconnected client will show the server-authoritative state.

---

## 4. Delay Propagation UX

### Applying a Delay

1. Operator enters minutes in delay input on anchor session card
2. `[Apply +Xm]` button → loading state
3. `apply-delay` EF called → cascade computed server-side
4. Success response returns `{ affected: N, minutes: X }`
5. Realtime pushes updated sessions → `onSessionChange` fires for each affected session
6. Cards update cascade: scheduled times shift, delay badges appear

**Visual feedback during cascade:**
- As each realtime update arrives, affected cards briefly highlight (`background-color` flash: `--warn-bg` → `--surface`, 800ms)
- Delay strip updates: `⚠ Event is running Xm behind schedule`
- Toast (top-right, 3s): `Delay applied — X sessions shifted +Ym`

**Cascade visualizer in delay strip:**
```
⚠  Running 12m behind schedule   [Show affected ▾]   [Reset Delays]
```
Expanding `[Show affected ▾]` lists session titles that are delayed (inline in strip, not a modal).

### Resetting Delays

1. `[Reset Delays]` button → confirm-style: label changes to `"CONFIRM RESET"` (2s)
2. On confirm: calls `applyDelay(anchor, 0)` on earliest delayed anchor
3. All downstream sessions revert to original scheduled times
4. Delay strip disappears
5. Toast: `Delays cleared`

### Conflict During Delay Application

If apply-delay EF returns 409 (IN_FLIGHT — someone else applying delay simultaneously):
- Toast: `⚠ Another delay is being applied — wait and retry`
- Button re-enabled after 2s
- No rollback needed (no optimistic update for delay)

---

## 5. Error States

### Error Taxonomy

| Error Type | Source | Operator Sees | Recovery |
|-----------|--------|--------------|----------|
| Version conflict | 409 from EF | Inline card toast, auto-refresh | Automatic |
| IN_FLIGHT | 409 from EF (duplicate) | Silent (already in flight) | Automatic |
| Network error | fetch throw | Inline card toast | Manual retry |
| EF unavailable | 500/404 | Inline card toast + diag bar `EF ✗` | Check deployment |
| RLS denied | 403 from Supabase | Inline card toast: "Permission denied" | Check role |
| Session not found | 404 from EF | Inline card toast: "Session not found — reload" | Reload event |
| Clock drift | > 500ms offset | Log entry warning, diag bar CK amber | Auto-resync |
| Broadcast fail | DB write error | Broadcast bar error state (red border) | Manual retry |

### Toast System

All error/success feedback uses a toast notification stack (top-right corner):

```
┌──────────────────────────────────┐
│ ✕  Connection error — try again  │ ← error (red left border)
├──────────────────────────────────┤
│ ✓  Delay applied — 3 sessions    │ ← success (green left border)
└──────────────────────────────────┘
```

- Max 3 toasts visible at once (queue)
- Auto-dismiss: 3s (error), 2s (success)
- Manual dismiss: click ×
- Toasts do NOT cover action buttons (positioned top-right, not over content)

*Current implementation uses the event log panel for feedback. Toast system is a backlogged improvement (PR-009).*

---

## 6. Loading States

### Page Boot Sequence

```
1. #loading-overlay visible (full screen, z-index 1000)
2. Auth check → if not logged in: show login form (overlay stays)
3. Login success:
   a. syncClock() → diag CK pill updates
   b. loadEvents() → event selector populates
   c. loadSnapshot(eventId) → session cards render
   d. subscribe(channel) → diag RT pill goes green
   e. checkEF() → diag EF pill updates
4. #loading-overlay fades out (250ms)
```

During boot, the overlay must not be dismissed prematurely — all 5 steps must complete.

### Per-Card Loading

When a session card action is in flight:
- Action buttons in that card: `loading` class (spinner, non-interactive)
- Other cards: fully interactive (no global block)
- Multiple cards can have in-flight actions simultaneously (multi-director scenario)

### Event Switch Loading

When operator changes event via dropdown:
- Session list: rendered with `<div class="loading-placeholder">Loading…</div>` (skeleton)
- Sidebar: clock and log preserved from previous event until new data arrives
- New channel subscription starts; old channel unsubscribed

---

## 7. Operator Feedback Loops

### Confirmed Action Pattern

After a successful transition, operator gets three confirmation signals:
1. **Visual:** Card status badge + border colour changes immediately (optimistic)
2. **Audit:** Event log entry appears in sidebar: `[HH:MM:SS] LIVE — Session Title`
3. **Realtime:** Within 2s, the realtime update arrives and confirms server truth matches

If signals 1 and 3 disagree (conflict), toast appears and signal 1 reverts.

### Speaker Arrived Flag

Interp role and above can set `speaker_arrived = true` on a PLANNED or READY session:
- Toggle button on card: `Speaker: Not arrived / ✓ Arrived`
- Direct DB update (not EF — not a state transition)
- No confirmation required — easily reversed
- Visual: small green dot on speaker name when arrived

### Broadcast Feedback

After broadcast is sent:
1. Broadcast bar: input clears, send button shows `✓ Sent` (1.5s) then resets
2. `#bc-banner` appears at top of session list showing active broadcast
3. All logged-in clients see the banner within 2s (realtime push)
4. Operator who sent it: banner has `[Dismiss locally]` — only hides from their view, not others

### Clock Offset Warning

If `Math.abs(S.clockOffset) > 1000` (>1s drift):
- Diag CK pill → amber
- Server clock display: red left border
- Log entry: `SYSTEM — Clock drift detected: +Xms`
- Auto-resolves on next 60s sync cycle

---

## 8. Keyboard Shortcuts (Director Role Only)

These are not yet implemented — backlogged in PR-019.

| Key | Action |
|-----|--------|
| `F` | Toggle confidence monitor fullscreen |
| `Escape` | Dismiss confidence monitor / close modal |
| `B` | Focus broadcast input |
| `R` | Refresh / reload snapshot |
| `/` | Focus text filter |

All shortcuts are suppressed when an input field is focused.

---

## 9. Micro-Interaction Summary

| Interaction | Duration | Easing | Notes |
|-------------|----------|--------|-------|
| Button press (scale) | 100ms | ease-out | mousedown |
| Status badge colour change | 150ms | ease | on optimistic update |
| Card border colour change | 150ms | ease | on optimistic update |
| Conflict rollback | 250ms | ease | same transitions reversed |
| Toast slide in | 200ms | ease-out | transform: translateX |
| Toast fade out | 150ms | ease-in | opacity 1→0 |
| Reconnect overlay fade | 400ms | ease | opacity |
| Card highlight (delay) | 800ms | ease | background-color flash |
| Modal open | 200ms | ease-out | opacity + scale(0.97→1) |
| Modal close | 150ms | ease-in | opacity |
| Loading overlay dismiss | 250ms | ease | opacity fade |
