# CueDeck Console — Engineering Backlog

**Authored by:** Product Owner + Engineering Leads
**Status:** Phase 2 — Awaiting approval before PR-001 begins
**Priority order:** Correctness → Security → Realtime Reliability → UI/UX

---

## Governance

- Each PR is a standalone, reviewable change
- All functional changes require tests (unit or E2E)
- State transitions must be server-validated (EF or RPC) — no direct client writes
- Reviewer sign-off required from: Staff Engineer + QA Lead
- Security-touching PRs also require: Security Engineer

---

## Backlog

---

### PR-001 — Fix XSS in broadcast banner

**Priority:** 🔴 Correctness + Security
**Effort:** XS (< 1 hour)
**Agent:** Frontend Tech Lead + Security Engineer review

**Problem:**
`showBCBanner()` sets the broadcast message via `innerHTML` or inner property without escaping. A malicious director could craft a broadcast containing HTML that executes in other operators' browsers.

**Files impacted:**
- `cuedeck-console.html` — `showBCBanner()` function (~line 2220)

**Change:**
Replace any innerHTML assignment of `message` with `textContent` assignment, or pass through `esc()`.

**Acceptance criteria:**
- Broadcast message `<img src=x onerror=alert(1)>` renders as literal text, not injected HTML
- Existing broadcast tests pass
- Security Engineer sign-off

**Test requirements:**
- Unit test: `esc('<img src=x onerror=alert(1)>')` returns escaped string
- E2E test: send broadcast with HTML content, verify rendered as plain text

---

### PR-002 — Make apply-delay transactional (RPC migration)

**Priority:** 🔴 Correctness
**Effort:** M (1–2 days)
**Agent:** DB/Transactions Engineer + Backend Tech Lead

**Problem:**
`apply-delay` Edge Function updates sessions one-by-one in a loop. If one UPDATE fails, earlier sessions are already shifted but later ones are not — leaving the schedule in a partially inconsistent state. There is no rollback.

**Files impacted:**
- `supabase/functions/apply-delay/index.ts`
- `supabase/migrations/003_rpc_apply_delay.sql` (new)
- `tests/delayPropagation.spec.ts` (update)

**Change:**
1. Create `rpc_apply_delay(session_id, minutes, command_id)` PostgreSQL function that updates all affected sessions in a single transaction
2. Refactor `apply-delay` EF to call the RPC instead of individual UPDATEs
3. RPC handles version guard and logs to `leod_event_log`

**Acceptance criteria:**
- If any session UPDATE fails inside the RPC, all updates roll back
- EF returns error, client shows "Delay failed — no changes applied"
- Existing cascade behaviour (skip ENDED/CANCELLED, stop at next anchor) preserved
- Idempotency via command_id still works

**Test requirements:**
- Unit test: cascade with mid-list failure → zero sessions shifted
- Unit test: cascade success → all N sessions shifted by M minutes
- Migration idempotent (IF NOT EXISTS guards)

---

### PR-003 — OVERRUN auto-detection

**Priority:** 🔴 Correctness
**Effort:** S (2–4 hours)
**Agent:** Realtime/State Engineer

**Problem:**
When a LIVE session runs past its `scheduled_end`, it should automatically display as OVERRUN. Currently this is display-only (client-side) — but the DB status stays `LIVE` until an operator manually ends it. The client compares `correctedNow()` to `actual_start + planned_duration` to render the OVERRUN badge, but this is purely cosmetic.

**Change:**
1. In the 1s tick, detect if a LIVE session has elapsed more than its planned duration
2. Call a new `set-overrun` EF (or extend existing) to write `OVERRUN` to DB
3. Realtime pushes the authoritative OVERRUN status to all clients

**Why not cron?** Cron requires pg_cron extension (not guaranteed on free tier). Tick-based detection from whichever operator client is online is sufficient for production use.

**Files impacted:**
- `cuedeck-console.html` — 1s tick handler (~line 2733)
- `supabase/functions/set-overrun/index.ts` (new)
- `supabase/functions/_shared/transition.ts` (add OVERRUN case)
- `tests/stateMachine.spec.ts` (add OVERRUN transition)

**Acceptance criteria:**
- When correctedNow() > actual_start + planned_duration_ms for a LIVE session, EF is called once
- Duplicate calls prevented by IN_FLIGHT idempotency
- Only director/stage/av clients trigger the EF (checked before calling)
- DB status becomes OVERRUN; all clients update within 2s

**Test requirements:**
- Unit test: tick handler calls set-overrun exactly once per overrun event
- Unit test: duplicate tick does not double-call EF

---

### PR-004 — Event log write failure feedback

**Priority:** 🟠 Correctness
**Effort:** XS (< 1 hour)
**Agent:** Frontend Tech Lead

**Problem:**
All event log writes use `.then().catch(() => {})` — errors are silently swallowed. If the audit log fails to write, the operator has no indication.

**Files impacted:**
- `cuedeck-console.html` — ~lines 1199, 1242, 1760 (all `.catch(() => {})` on log writes)

**Change:**
In the catch handler, push a local-only log entry: `ERROR — Audit log write failed`. This does not retry (log is best-effort), but operator is aware.

**Acceptance criteria:**
- If `leod_event_log` INSERT fails, a red log entry appears: `⚠ Log write failed`
- The session transition itself is not affected (log failure is non-blocking)
- No change to EF behaviour

**Test requirements:**
- Unit test: mock failed log insert → `pushLog('ERROR', 'Audit log write failed')` called

---

### PR-005 — Toast notification system

**Priority:** 🟠 UX / Operator Feedback
**Effort:** S (3–5 hours)
**Agent:** Frontend Tech Lead + UI Designer review

**Problem:**
All operator feedback (errors, successes) currently goes to the event log panel in the sidebar. This is:
- Not visible if the sidebar is scrolled to show older log entries
- Positioned far from the action buttons (Zone D vs Zone C)
- Shown as the same style as audit entries (no visual priority difference)

**Change:**
Implement a lightweight toast stack (top-right corner, above modals):
- `pushToast(message, type, duration)` function — `type`: `'success' | 'error' | 'warn' | 'info'`
- Max 3 toasts visible; queue additional
- Slide in from right (200ms ease-out), auto-dismiss, manually dismissible
- Replaces in-card error handling where it currently exists
- Event log still receives all entries (toast is supplemental)

**Files impacted:**
- `cuedeck-console.html` — new `#toast-container` div, `pushToast()` function, associated CSS

**Acceptance criteria:**
- Version conflict: toast `⚠ Updated by another operator — refreshing`
- EF success: no toast (log entry sufficient) — except delay applied
- Delay applied: toast `✓ Delay applied — N sessions shifted +Xm`
- Network error: toast `✕ Connection error — try again`
- Toasts do not overlap action buttons

**Test requirements:**
- E2E: trigger conflict → toast appears with correct text → auto-dismisses in 3s

---

### PR-006 — Realtime sequence gap detection

**Priority:** 🟠 Realtime Reliability
**Effort:** M (1–2 days)
**Agent:** Realtime/State Engineer

**Problem:**
Supabase realtime delivers `postgres_changes` events but provides no sequence number. If events arrive out of order or are dropped (network hiccup), the client silently holds a stale state without knowing.

**Change:**
1. Add `seq` column (BIGINT, auto-increment) to `leod_sessions` via trigger
2. Client tracks `_lastSeq` per session
3. In `onSessionChange()`: if incoming `seq < _lastSeq[sessionId]`, log warning and trigger `loadSessions()` to re-sync
4. If gap detected (`seq > _lastSeq + 1`), trigger `loadSessions()`

**Files impacted:**
- `supabase/migrations/003_add_seq_column.sql` (or next migration number)
- `cuedeck-console.html` — `onSessionChange()`, `S` object (add `_lastSeq`)
- `tests/timeSync.spec.ts` or new `tests/realtimeReliability.spec.ts`

**Acceptance criteria:**
- Out-of-order realtime events trigger `loadSessions()` instead of applying stale data
- Sequence gap detection logs a warning in the event log
- Normal operation: no extra `loadSessions()` calls

**Test requirements:**
- Unit test: simulated out-of-order event → loadSessions called
- Unit test: in-order events → loadSessions NOT called

---

### PR-007 — Restrict CORS on Edge Functions

**Priority:** 🟠 Security
**Effort:** S (2–3 hours)
**Agent:** Security Engineer + Backend Tech Lead

**Problem:**
All Edge Functions respond with `'Access-Control-Allow-Origin': '*'`. This means any website could invoke the functions with a stolen JWT. Should be restricted to known origins.

**Files impacted:**
- `supabase/functions/_shared/client.ts` or a new `_shared/cors.ts`
- All 8 `index.ts` files (update CORS headers)

**Change:**
Define an allowlist:
```typescript
const ALLOWED_ORIGINS = [
  'file://',        // local file:// loads
  'http://localhost:7230',
  'https://your-domain.com'  // production domain if hosted
];
```
Return `Access-Control-Allow-Origin` set to request origin if in allowlist, else omit header.

**Acceptance criteria:**
- Request from allowed origin: CORS header present, EF callable
- Request from unknown origin: CORS header absent, browser blocks preflight
- `_ping` still works from deploy script (no CORS needed for server-to-server)

**Test requirements:**
- Unit test: CORS helper returns correct header for allowed/denied origins

---

### PR-008 — leod_commands TTL cleanup

**Priority:** 🟠 Security / Operations
**Effort:** S (2–3 hours)
**Agent:** DB/Transactions Engineer

**Problem:**
`leod_commands` table accumulates one row per button click with no cleanup. After a large event (500 sessions × many transitions), this table could contain thousands of rows. Without pg_cron, no automated TTL exists.

**Change:**
1. Add a cleanup call at the start of `loadSnapshot()` — delete commands older than 24h via authenticated Supabase call
2. Alternatively: add trigger-based cleanup (delete when table exceeds 5000 rows, keep newest 1000)

Preferred: lightweight client-triggered cleanup on event load. Runs at most once per event switch — not per action.

**Files impacted:**
- `cuedeck-console.html` — `loadSnapshot()` function
- `supabase/migrations/004_commands_cleanup_rpc.sql` (new) — RPC `cleanup_old_commands()`

**Acceptance criteria:**
- Commands older than 24h are deleted when `loadSnapshot()` runs
- Cleanup failure is logged but does not block snapshot load
- Idempotent cleanup — safe to run multiple times

**Test requirements:**
- Unit test: cleanup called once per `loadSnapshot()`, not per action

---

### PR-009 — Operator presence indicator

**Priority:** 🟡 UX
**Effort:** M (1–2 days)
**Agent:** Realtime/State Engineer + UX Architect review

**Problem:**
Directors have no visibility into which roles are currently connected. In a multi-operator scenario, not knowing if the stage manager is online is a safety concern.

**Change:**
Use Supabase Realtime Presence on the `leod-ctrl-{eventId}` channel:
1. On subscribe, track presence: `channel.track({ role: S.role, userId: S.user.id })`
2. On `presence.sync`, update `S.presence` array
3. Show presence indicators in Zone A (header): coloured dots per role
   ```
   ● Director  ● Stage  ○ A/V  ○ Interp
   ```
   Green = online, grey = offline

**Files impacted:**
- `cuedeck-console.html` — channel subscription, presence tracking, header rendering

**Acceptance criteria:**
- When a stage manager logs in, director sees `● Stage` within 2s
- When stage manager disconnects, dot goes grey within 5s (Supabase presence timeout)
- Multiple clients same role: dot is green if any are connected

**Test requirements:**
- E2E: second browser tab logs in as `stage` role → director view shows Stage dot green

---

### PR-010 — Confidence monitor: Next Session preview

**Priority:** 🟡 UX
**Effort:** S (2–4 hours)
**Agent:** Frontend Tech Lead + UX Architect review

**Problem:**
The confidence monitor (`#confidence-overlay`) shows the current LIVE session but not what's coming next. Directors and stage managers frequently need to prepare for the handoff.

**Change:**
Add a "NEXT UP" section at the bottom of the confidence overlay:
- Title, speaker, planned start time, room
- Computed from: first PLANNED or READY session in `sort_order` after the current LIVE session

**Files impacted:**
- `cuedeck-console.html` — `updateStageMonitor()` function, confidence overlay HTML

**Acceptance criteria:**
- When LIVE session exists, "NEXT UP" shows next planned session
- When no next session exists, "NEXT UP" section is hidden
- Next session title truncated at 2 lines

**Test requirements:**
- Unit test: `getNextSession(sessions, liveSessionId)` returns correct next session

---

### PR-011 — NEXT UP label in session list

**Priority:** 🟡 UX
**Effort:** XS (1–2 hours)
**Agent:** Frontend Tech Lead

**Problem:**
In a long session list, stage managers need to identify which session they should prepare next. There is no visual marker.

**Change:**
In `renderSessions()`, inject a sticky `.next-up-label` div above the first non-ENDED/CANCELLED session after the current LIVE session.

**Files impacted:**
- `cuedeck-console.html` — `renderSessions()`, CSS for `.next-up-label`

**Acceptance criteria:**
- NEXT UP label appears only when a LIVE session exists
- Label is positioned correctly regardless of filter state
- Hidden for `signage` role

**Test requirements:**
- E2E: set a session to LIVE → NEXT UP label appears above the following session

---

### PR-012 — Vanilla JS module refactor (internal code organisation)

**Priority:** 🟡 Frontend Architecture
**Effort:** L (3–5 days)
**Agent:** Frontend Tech Lead

**Problem:**
cuedeck-console.html is a single 2980-line file. All functions are in one global scope. Adding new features increases collision risk and makes the file unmanageable. No module boundaries exist.

**Change:**
Extract logical modules as JS objects / namespaces within the single file (no build system required):

```javascript
const StateStore  = { /* S, F, mutations */ };
const ClockEngine = { /* syncClock, correctedNow, refreshClockUI */ };
const Realtime    = { /* subscribe, onSessionChange, doReconnect */ };
const Renderer    = { /* renderSessions, cardHTML, renderSignagePanel */ };
const Transitions = { /* transition, applyDelay, buildButtons */ };
const UI          = { /* modals, toasts, broadcast */ };
```

- Each module is a `const` object literal with methods
- No `export`/`import` (file:// compatible)
- Cross-module calls via named references (not global function calls)
- `// === MODULE: ClockEngine ===` section headers for navigation

**Files impacted:**
- `cuedeck-console.html` — significant internal restructuring, no behaviour change

**Acceptance criteria:**
- All 91 unit tests pass unchanged
- All 65 E2E tests pass unchanged
- `bash scripts/verify-leod.sh 7230` → 33/33
- No new global function names introduced

**Test requirements:**
- Existing tests are sufficient (no behaviour change)

---

### PR-013 — Design token audit and CSS variable consolidation

**Priority:** 🟡 Frontend Architecture
**Effort:** S (3–5 hours)
**Agent:** UI Designer + Frontend Tech Lead

**Problem:**
Some colours and spacing values are hardcoded inline (e.g., `#1c2030`, `272px`, `44px`) rather than using CSS variables. This makes token updates require grep-and-replace rather than single-point change.

**Change:**
1. Audit all hardcoded values in cuedeck-console.html CSS
2. Replace with tokens from `docs/DESIGN_TOKENS.md`
3. Add missing tokens to `:root`
4. Add `@media (prefers-reduced-motion: reduce)` block for all badge animations

**Files impacted:**
- `cuedeck-console.html` — CSS section

**Acceptance criteria:**
- No hardcoded colour hex values in CSS (except `transparent`, `#000`, `#fff`)
- All spacing values use `--sp-N` tokens or `calc()`
- Reduced motion media query suppresses all badge animations
- Visual appearance unchanged

**Test requirements:**
- `bash scripts/verify-leod.sh 7230` — 33/33
- Visual regression: screenshot before/after (manual comparison)

---

### PR-014 — Signage display mode E2E tests

**Priority:** 🟡 Test Coverage
**Effort:** M (1–2 days)
**Agent:** Frontend QA Engineer

**Problem:**
The 7 display content modes (schedule, wayfinding, sponsors, break, wifi, recall, custom) have no E2E test coverage. Changes to display rendering could silently break signage screens.

**Files impacted:**
- `tests/e2e/display-page.spec.ts` — extend with mode-specific tests

**Change:**
Add tests for each of the 7 content modes:
- Boot with `mode=schedule` → session list renders
- Boot with `mode=sponsors` → sponsor carousel renders
- Boot with `mode=break` → break message renders
- etc.

**Acceptance criteria:**
- Each of 7 modes has at least one E2E test covering basic render
- Tests use hash params (not query params) for file:// compatibility
- All new tests pass in CI

**Test requirements:**
- 7 new E2E tests (one per display mode minimum)

---

### PR-015 — Inline cancel confirmation (remove modal dependency)

**Priority:** 🟡 UX
**Effort:** S (2–3 hours)
**Agent:** Interaction Designer + Frontend Tech Lead

**Problem:**
CANCEL currently has no confirmation flow. An accidental tap on CANCEL in a high-stress environment causes a hard-to-reverse state change (requires REINSTATE). A confirm dialog would add a full modal (slow, context-switching). Spec calls for inline 2s timeout confirmation.

**Change:**
Implement inline confirm per INTERACTIONS.md §1:
- On first CANCEL click: button label → `CONFIRM CANCEL` (red background), starts 2s timer
- Second click within 2s: proceeds with cancel
- Timer expires: reverts to original CANCEL label
- No modal, no global block

**Files impacted:**
- `cuedeck-console.html` — `buildButtons()`, `transition()` pre-hook, CSS for `.sc-btn.confirm-pending`

**Acceptance criteria:**
- First CANCEL click does not trigger transition
- Second click within 2s triggers transition
- After 2s with no second click: button resets
- Works correctly with multi-director scenario (another client cancels first → 409 rollback)

**Test requirements:**
- E2E: first click → label changes to CONFIRM CANCEL
- E2E: wait 2.5s → label reverts
- E2E: first click + second click within 2s → transition proceeds

---

### PR-016 — Diag bar "Last sync" timestamp

**Priority:** 🟢 UX / Operations
**Effort:** XS (1 hour)
**Agent:** Frontend Tech Lead

**Problem:**
During a prolonged disconnect, operators cannot tell when the data was last known-good. The diag bar shows the current connection status but not the last successful sync time.

**Change:**
Add `S.lastSyncAt` timestamp (set on each successful `loadSnapshot()`).
Display in diag bar tooltip when hovering the DB or RT pill:
`Last sync: HH:MM:SS (Ns ago)`

**Files impacted:**
- `cuedeck-console.html` — diag bar tooltip, `loadSnapshot()` sets `S.lastSyncAt`

**Acceptance criteria:**
- Tooltip shows last sync time on hover of DB/RT pills
- After reconnect, timestamp updates
- While offline: timestamp stays at last successful sync

**Test requirements:**
- Unit test: `S.lastSyncAt` updates on `loadSnapshot()` completion

---

### PR-017 — Session card keyboard navigation

**Priority:** 🟢 Accessibility
**Effort:** M (1–2 days)
**Agent:** Frontend Tech Lead + UI Designer review

**Problem:**
Session cards and action buttons are only accessible via mouse/touch. Keyboard users (and operators who prefer keyboard) cannot tab through cards and press buttons without a mouse.

**Change:**
1. Session cards (`.sc`): `tabindex="0"`, `role="article"`, `aria-label="[title] — [status]"`
2. Action buttons: standard tab order within card
3. Card focus: highlights card with `--accent` outline
4. Arrow keys navigate between cards when a card is focused

**Files impacted:**
- `cuedeck-console.html` — `cardHTML()`, CSS for focus states

**Acceptance criteria:**
- Tab moves focus through cards in sort_order
- Within a card, Tab moves through action buttons
- Enter/Space activates focused button
- WCAG 2.1 AA keyboard compliance

**Test requirements:**
- E2E: keyboard-only navigation to first action button → activate → transition occurs

---

### PR-018 — Role-adaptive filter bar defaults

**Priority:** 🟢 UX
**Effort:** S (2–3 hours)
**Agent:** Frontend Tech Lead + UX Architect review

**Problem:**
All roles see the full filter bar by default. Stage managers and A/V typically only care about LIVE/CALLING/HOLD sessions. Reg staff only care about PLANNED sessions. Showing all sessions by default creates noise.

**Change:**
On role switch (not login), apply role-appropriate filter defaults:
| Role | Default status filter |
|------|-----------------------|
| director | All |
| stage | All (they need full visibility) |
| av | All |
| interp | All |
| reg | PLANNED |

Operator can always clear the filter. Role switch resets filter to role default.

**Files impacted:**
- `cuedeck-console.html` — `setRole()` function, `F` filter state

**Acceptance criteria:**
- Switching to `reg` role: status filter set to PLANNED
- Switching back to `director`: status filter reset to All
- Operator-changed filters: respected until role is switched again

**Test requirements:**
- Unit test: `setRole('reg')` → `F.status === 'PLANNED'`
- Unit test: `setRole('director')` → `F.status === ''`

---

### PR-019 — Keyboard shortcuts (director only)

**Priority:** 🟢 UX / Power Users
**Effort:** S (3–4 hours)
**Agent:** Interaction Designer + Frontend Tech Lead

**Problem:**
No keyboard shortcuts exist. Experienced directors prefer keyboard to mouse for speed. Particularly useful during live events.

**Change:**
Implement shortcuts per INTERACTIONS.md §8:
- `F` — toggle confidence monitor
- `Escape` — dismiss confidence monitor / close modal
- `B` — focus broadcast input
- `R` — trigger manual snapshot reload
- `/` — focus text filter

All shortcuts suppressed when input focused. Director role only (checked against `S.role`).

**Files impacted:**
- `cuedeck-console.html` — `document.addEventListener('keydown', ...)` handler

**Acceptance criteria:**
- All shortcuts work as documented
- No shortcuts trigger when user is typing in an input
- Non-director roles: no shortcuts active (key presses ignored)

**Test requirements:**
- E2E: director role → press `F` → confidence monitor opens
- E2E: reg role → press `F` → nothing happens

---

### PR-020 — Timeline view mode (session list alternative)

**Priority:** 🟢 UX / Director
**Effort:** L (3–5 days)
**Agent:** Frontend Tech Lead + UX Architect + UI Designer review

**Problem:**
The current list view shows sessions by sort_order but gives no visual sense of timing. Directors managing a complex multi-track schedule benefit from a time-axis view.

**Change:**
Add a List/Timeline toggle above the session list (Zone B):
- **List view** (default): current card-based view
- **Timeline view**: horizontal bars on a time axis
  - One row per room
  - Bar width = planned duration
  - Bar position = offset from event start
  - Bar colour = status colour
  - Clicking bar selects session (context panel updates)
  - Current time marker (correctedNow()) scrolls with time

Implemented as pure JS + SVG (no library required). Viewport: scroll horizontally for full day.

**Files impacted:**
- `cuedeck-console.html` — `renderTimeline()` function, toggle button, SVG generation

**Acceptance criteria:**
- Toggle switch between list and timeline view
- Timeline shows correct session durations and positions
- Current time marker advances in real time
- Clicking session bar selects session (same as clicking a card)
- Works for all roles (but action buttons only shown for write-capable roles)
- Realtime updates reflected in timeline without full re-render

**Test requirements:**
- E2E: toggle to timeline view → sessions visible as bars
- E2E: switch to timeline, session goes LIVE → bar colour changes

---

## Summary

| PR | Title | Priority | Effort | Category |
|----|-------|----------|--------|----------|
| PR-001 | Fix XSS in broadcast banner | 🔴 | XS | Security |
| PR-002 | Make apply-delay transactional (RPC) | 🔴 | M | Correctness |
| PR-003 | OVERRUN auto-detection | 🔴 | S | Correctness |
| PR-004 | Event log write failure feedback | 🟠 | XS | Correctness |
| PR-005 | Toast notification system | 🟠 | S | UX |
| PR-006 | Realtime sequence gap detection | 🟠 | M | Reliability |
| PR-007 | Restrict CORS on Edge Functions | 🟠 | S | Security |
| PR-008 | leod_commands TTL cleanup | 🟠 | S | Operations |
| PR-009 | Operator presence indicator | 🟡 | M | UX |
| PR-010 | Confidence monitor: Next Session | 🟡 | S | UX |
| PR-011 | NEXT UP label in session list | 🟡 | XS | UX |
| PR-012 | Vanilla JS module refactor | 🟡 | L | Architecture |
| PR-013 | Design token CSS consolidation | 🟡 | S | Architecture |
| PR-014 | Signage display mode E2E tests | 🟡 | M | Testing |
| PR-015 | Inline cancel confirmation | 🟡 | S | UX |
| PR-016 | Diag bar "Last sync" timestamp | 🟢 | XS | UX |
| PR-017 | Session card keyboard navigation | 🟢 | M | Accessibility |
| PR-018 | Role-adaptive filter bar defaults | 🟢 | S | UX |
| PR-019 | Keyboard shortcuts (director) | 🟢 | S | UX |
| PR-020 | Timeline view mode | 🟢 | L | UX |

**Recommended first sprint (PR-001 → PR-005):** All correctness + security fixes + toast foundation.
**Do NOT start PR-001 until this backlog is approved.**
