# CueDeck UI Polish — Design Spec

**Date:** 2026-03-11
**File:** `cuedeck-console.html` (only file changed)
**Status:** Approved

---

## Overview

Five visual improvements to the CueDeck header and filter bar:

1. **Operators and Billing buttons** — make them visually distinct and actionable
2. **Timeline toggle** — replace the hidden single button with a clear pill toggle
3. **Timezone dropdown** — replace free-text input with a validated select
4. **User chip** — replace the bare power icon logout with a name+role identity chip
5. **Profile panel** — clicking the chip opens a plan/usage/actions panel
6. **Help button** — replace the bare `?` with a labelled "Help" button

All changes are purely additive UI polish. No new API calls, no new database tables, no new files.

---

## Feature 1 — Operators and Billing Buttons

### Problem
Both buttons use `background:none; border:1px solid var(--border); color:var(--dim)` — they look like disabled placeholders, not interactive controls.

### Design
- Replace dim grey styling with a **blue-tinted pill**: `background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.3); color:#60A5FA; font-weight:600`
- Add **icon prefix**: emoji 👥 for Operators, emoji 💳 for Billing
- Add **red approval badge** on Operators button: shown only when `pendingCount > 0`, hidden otherwise
- Badge style: `background:#ef4444; color:#fff; border-radius:8px; padding:1px 5px; font-size:9px; font-weight:700`

### Scope
- Header button styling only
- Billing modal plan cards — **unchanged**
- `pendingCount` = count of leod_users where role='pending', already tracked in `S.pendingOperators`

---

## Feature 2 — Timeline Toggle Pill

### Problem
`buildFilterBar()` renders a single button `id="fb-view"` pushed to the far right. It only shows the inactive option — you can't see "List" when in List mode.

### Design
Replace the single button with a **pill toggle** containing both states always visible:

```html
<div class="fb-view-pill">
  <button class="fvp-btn" id="fvp-list" onclick="setViewMode('list')">List</button>
  <button class="fvp-btn" id="fvp-tl"   onclick="setViewMode('timeline')">Timeline</button>
</div>
```

CSS rules:
- `.fb-view-pill`: flex row, dark background, 1px border, 100px border-radius, 2px padding
- `.fvp-btn`: no border, dim color, 11px font, 100px border-radius, 4px 12px padding
- `.fvp-btn.active`: `background:#1e3a5f; color:#60A5FA; font-weight:600`

Active state driven by `S.viewMode` — `buildFilterBar()` already re-renders on state change, so `active` class is set during render.

---

## Feature 3 — Timezone Dropdown

### Problem
`input id="evm-tz" type="text"` and `input id="wiz-ev-tz" readonly` require the user to know the exact IANA timezone string. Typos silently break display logic.

### Design
Replace both inputs with a `select` populated by a shared helper `buildTzSelect(selectId, currentTz)`:

- Calls `Intl.supportedValuesOf('timeZone')` to get all valid IANA zone names
- Groups zones by region (prefix before first `/`)
- Calculates UTC offset for display using `toLocaleString` with `timeZoneName:'shortOffset'`
- Renders as `optgroup` elements: Africa, America, Asia, Europe, Pacific, etc.
- Pre-selects `currentTz` if provided, otherwise defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`

**Event modal:** `select id="evm-tz"` replaces `input id="evm-tz" type="text"`
**Setup Wizard step 0:** `select id="wiz-ev-tz"` replaces `input id="wiz-ev-tz" readonly`

Reading the value is unchanged: `document.getElementById('evm-tz').value`

The helper uses `innerHTML` to build the option list — this is safe because all strings come from `Intl.supportedValuesOf()` (browser API, not user input).

---

## Feature 4 — User Identity Chip

### Problem
The header shows a bare power icon for logout. Users have no visual confirmation of who they are or what role they hold.

### Design (Option A — Compact Pill)

```html
<div id="user-chip" class="user-chip" onclick="toggleProfilePanel()">
  <div id="user-chip-avatar" class="uc-avatar"></div>
  <div>
    <div id="user-chip-name" class="uc-name"></div>
    <div id="user-chip-role" class="uc-role"></div>
  </div>
  <div class="uc-sep"></div>
  <span class="uc-caret">▾</span>
</div>
```

CSS rules:
- `.user-chip`: flex row, `background:rgba(59,130,246,0.12)`, `border:1px solid rgba(59,130,246,0.35)`, 20px border-radius, `position:relative`
- `.uc-avatar`: 26px circle, flex center, 10px font, role-colored background/border/color
- `.uc-name`: 11px, font-weight:600, color:#CBD5E1
- `.uc-role`: 9px, font-weight:700, uppercase, role-colored

**Role colors (applied to avatar and role text):**
- director → blue (#60A5FA / rgba(59,130,246,...))
- stage    → green (#4ade80 / rgba(34,197,94,...))
- av       → amber (#fb923c / rgba(249,115,22,...))
- interp   → purple (#a78bfa / rgba(139,92,246,...))
- reg/signage → slate (#94A3B8 / rgba(100,116,139,...))

**Avatar initials:** first letter of first name + first letter of last name from `S.userName`. Single word → first two letters.

**Populated in `renderForRole()`** after S.userName and S.userRole are set.

**Replaces `#logout-btn`** — old power icon button is hidden (`display:none`), Sign Out moves into the profile panel.

**Mobile:** chip hidden in header; mobile menu bottom section shows "Signed in as [Name] ([Role])" + Sign Out button.

---

## Feature 5 — Profile Panel

Opens when the chip is clicked. Closes on outside click or pressing Esc.

### HTML structure

```
#profile-panel.profile-panel
  .pp-identity
    #pp-avatar.pp-avatar        (initials, role-colored)
    div
      #pp-name.pp-name
      #pp-email.pp-email
      #pp-role-badge.pp-role-badge
  #pp-plan.pp-plan              (directors only, hidden for others)
    .pp-plan-row
      #pp-plan-name
      #pp-plan-status
    #pp-trial-note              (shown only when trialing)
    #pp-usage                   (usage bars rendered by JS)
  .pp-actions
    #pp-billing-btn.pp-action   (directors only; "Upgrade Plan" when trialing)
    .pp-divider
    button.pp-action.danger     → doLogout()
```

### Rendering logic

Called in `renderForRole()` as `renderProfilePanel()`.

**All roles:**
- Avatar: initials + role color
- Name: `S.userName`
- Email: `S.user.email`
- Role badge: `S.userRole` capitalised, role-colored

**Directors only (`S.userRole === 'director'`):**
- Show `#pp-plan` section
- Plan name: `S.planLimits.label`
- Status badge: active=green, trialing=amber "N days left", past_due=red
- Trial note: shown when trialing, "Trial ends [date] · Upgrade to keep your data"
- Usage bars: events (`S.subscription.events_used` / `S.planLimits.events`), operators (count / limit), displays (count / limit)
- Bar color thresholds: below 75% = blue, 75-99% = amber (.warn), 100% = red (.full)
- Billing button: "Manage Billing" → `openBillingModal()` when subscribed; "Upgrade Plan" → `openBillingModal()` when trialing

**Non-directors:** hide `#pp-plan`, hide billing button entirely.

### Key CSS

```
.profile-panel: position:absolute, top:calc(100%+8px), right:0, width:280px,
  background:#131C2C, border-radius:12px, box-shadow:0 16px 48px rgba(0,0,0,.6), z-index:220
```

Positioned relative to `#user-chip` (which is `position:relative`).

### JS functions

- `toggleProfilePanel()` — show/hide panel, call `renderProfilePanel()` on open, add outside-click listener
- `closeProfilePanel()` — hide panel, remove outside-click listener
- `renderProfilePanel()` — populate all DOM nodes from S state

---

## Feature 6 — Help Button

### Problem
The bare `?` character is ambiguous — easy to miss and unclear for first-time users under production pressure.

### Design (Option B — "Help" label)

```html
<button id="help-btn" class="hbtn hbtn-dim" onclick="toggleHelpMenu()" title="Help · Press ? anytime">
  Help <span id="cl-badge" class="cl-badge" style="display:none">●</span>
</button>
```

- Uses `hbtn hbtn-dim` (dim pill class already in codebase)
- Tooltip: "Help · Press ? anytime" — teaches the keyboard shortcut
- Changelog unread badge: the existing `id="cl-badge"` dot targets this button (no logic change)
- `?` keyboard shortcut — **unchanged**, still triggers `openShortcutsModal()`

---

## What Doesn't Change

- Billing modal plan cards — layout, pricing, and card styling unchanged
- All existing keyboard shortcuts
- All role-gated visibility logic
- All Supabase calls and subscriptions
- Mobile menu structure (additions only — sign-in info at bottom)

---

## Implementation Notes

- Approximately 40 CSS rules added, 80 JS lines, small HTML edits in header + filter bar
- `buildTzSelect()` — new shared helper, called from event modal open + wizard step render
- `renderProfilePanel()` — new function, called once from `renderForRole()`
- Outside-click listener: same pattern as existing `#help-dropdown` and `#mobile-menu`
- `#logout-btn` kept in DOM with `display:none !important` — Sign Out action moves to profile panel and mobile menu

---

## Verification Checklist

1. Desktop 1440px: Operators (blue, badge when pending), Billing (blue), Help (dim pill), user chip visible. Click chip opens profile panel. Click outside closes it.
2. Mobile 375px: Chip hidden. Mobile menu shows "Signed in as [Name] ([Role])" and Sign Out.
3. Role colors: Director=blue, Stage=green, AV=amber, Interp=purple.
4. Timezone: Event modal and wizard both show dropdown. Default = local timezone. Value saves correctly.
5. Timeline pill: Both List and Timeline buttons visible. Active state blue-highlighted.
6. Profile panel — trial: Shows days remaining, amber/red usage bars near limit, "Upgrade Plan" button.
7. Profile panel — non-director: No plan section shown, just identity and Sign Out.
8. Help button: "Help" visible, tooltip shows shortcut, clicking opens help dropdown, `?` key still works, changelog badge appears when unread.
9. Zero JS errors at all breakpoints.
