# Command center redesign: direction B (Now and next)

Date: 2026-10-06. Status: direction B chosen by Sherif ("fix the safety bugs now, then go with option B"). Spec approved with decisions in section 8.
Demo: https://claude.ai/artifact/WqQ6EYTKocovRAVFqo7eLp (tab "B · Now and next").
Inputs: four specialist audits run on 66 screenshots of the console at 2x with GTR example data (visual and contrast, layout and information architecture, live show operations, design system), 6 Oct 2026. Their raw reports and measurement scripts live in the session scratchpad (`console-audit/`, `viz/`, `ds_scan.py`); the numbers below are copied from them.
Separate and first: the show-safety bug fixes (branch `fix/show-safety`), which this redesign builds on.

## Goal

An operator in a dark control room can tell, in under a second and from two metres away, what is live in each room, how long is left, what is next, and whether anything is wrong, and can act on it without risk of pressing the wrong button. The page looks calm and layered instead of one dark block.

Success criteria (all measurable):
- Every section divider is visible: ≥ 1.78:1 against its surface (the section token measures 1.79 on the page background and 1.84 or more on panels); every control boundary (input, select, secondary button) ≥ 3:1. Today: 1.08 to 1.43:1.
- All text meets 4.5:1 except disabled controls (≥ 3.7:1). Today the most used grey is 3.11 to 3.98:1.
- At 1440×900 the live session and the next session of every room (up to 3 rooms) are on screen without scrolling, and at least 8 list rows are visible. Today: LIVE is the third card and NEXT is never visible; 3 cards fit.
- At 1280×720 the band plus at least 6 list rows are visible.
- Top chrome (banner excluded) ≤ 100 px at 1440. Today 197 px.
- The event log is always visible in the director view at 1440×900 and 1280×720 (≥ 200 px).
- Each status has one colour used identically in badge, card edge, timeline, sidebar and stage monitor, and a shape, so no two states are confused under normal, protan or deutan vision (worst pair ΔE ≥ 20).
- HOLD and END never change position between statuses. Destructive actions are separated from the primary action.
- No emoji used as icons in the console chrome.

## Non-goals

- No change to how sessions, roles, permissions or Edge Functions work (the safety branch handles behaviour bugs).
- No light theme in this round. The token layer makes a later manual "Daylight" theme about 40 overrides; not built now. The console stays dark and does not follow the OS setting.
- The stage monitor overlay and the signage display page keep their own layouts; they only adopt the shared status tokens.
- No new framework or build step: single-file vanilla HTML, CSS, JS, as today.

## 1. Tokens (single source of truth)

All colours, type sizes, spacing and radii come from `:root` custom properties. JS reads status colours from CSS (`getComputedStyle`), never its own map. Aliases become `var()` references (`--dim: var(--text-tertiary)`), never copies.

**Surfaces.** Adjacent steps are calm (1.07 to 1.13:1); borders carry the boundaries.
`--bg #0A0E14`, `--panel #10161F` (bars, sidebar), `--card #161E2B`, `--raised #1D2737` (chips, hover, selected), `--overlay #243044` (modals, menus), `--input-bg #0D121A`.

**Borders** (slate-300 alpha).
`--border-divider rgba(203,213,225,.14)` inside cards (1.34 to 1.41:1),
`--border-section rgba(203,213,225,.24)` bars, columns, card outline (1.79 to 1.87:1),
`--border-control rgba(203,213,225,.44)` inputs, selects, secondary buttons, checkboxes (3.0 to 3.33:1).

**Text.** `--text-primary #E6E9EF`, `--text-secondary #B4BCC8`, `--text-tertiary #98A2B3` (labels, meta, placeholder; 5.16 to 7.51:1), `--text-disabled #768091`. `--text-dim #4B5563` is retired.

**Status.** Each has a solid, a 16% tint background, a foreground for text on the tint, and an outline:
| State | Solid | Shape |
|---|---|---|
| PLANNED | #94A3B8 | hollow edge, quiet |
| READY | #34D399 | solid edge |
| CALLING | #FACC15 | pulse ring on the badge only |
| LIVE | #EF4444 | dot in the badge |
| OVERRUN | #E879F9 | count-up with "+", solid badge |
| HOLD | #FB923C | pause icon, dashed edge, no blinking |
| ENDED | #64748B | folded into a summary row |
| CANCELLED | #4B5563 | folded, struck through |
Text on a solid status fill is `#0A0E14` (5.14 to 12.63:1). Worst pair ΔE 21.3 across normal, protan, deutan.

**Accent and focus.** `--accent #2563EB` (one primary blue; white text 5.17:1), `--accent-fg #60A5FA`, focus ring `0 0 0 2px var(--bg), 0 0 0 4px #93C5FD` on every interactive element via `:focus-visible`.

**Action colour rule.** Action colour follows the action, state colour follows the status, and red is never used for a non-destructive action (controller ruling, 2026-10-06). Set ready and the actions that put a session on stage (On stage, Go live, Resume) are solid green (`--st-ready`, dark text); Call speaker is solid yellow (`--st-calling`); Hold is solid amber; End and Cancel are red outlined (danger); solid red is reserved for the armed confirm state; everything else is secondary.

**Type.** 8 sizes: 11 (labels, captions; the minimum), 12 (meta), 13 (body, buttons), 14 (row title), 16 (section and inspector title), 20, 28 (countdowns in the band), 40 (inspector countdown on phone). Weights 400/500/600/700. Letter-spacing: .06em uppercase labels, .04em uppercase badges, -.01em large numbers, 0 otherwise. Inter everywhere with `tabular-nums` for times; mono only for codes and the clock offset.

**Space and shape.** Space 4/8/12/16/24/32. Row heights 32/40/48/56/64. Radius 4 (chips), 8 (buttons, inputs, cards), 12 (modals, phone cards), 999 (pills). Buttons 32 px desktop, 48 px on `pointer: coarse`.

**Motion.** Only exceptions animate (CALLING ring, OVERRUN lane, connection lost). All animation off under `prefers-reduced-motion: reduce`. Countdowns keep their existing wrap-up cues without animation: amber under 5 min, red under 1 min, tenths of a second in the final minute.

## 2. Layout at 1440×900

```
broadcast banner (only while active)                                     28
header: event ▾ · date · time zone | clock | ● All systems | crew 3/5 |
        view as ▾ | help | account                                       52
┌─────────────────────────────── main ────────────────────┬─ inspector ─┐
│ NOW AND NEXT BAND: one lane per room (≤3 shown in full)  │ selected     │
│   lane: room | status | title + speaker | countdown |    │ session:     │
│         [primary] gap [End…]  ; next row underneath      │ all controls │
│ filter row: search, status, room, list/timeline,          │──────────────│
│   delay chip + reset                                 48   │ event log    │
│ compact list: 56 px rows, finished sessions folded        │ (≥ 240,      │
│                                                           │  fills rest) │
└──────────────────────────────────────────────────────────┴─ 360 px ────┘
broadcast composer                                                       52
```

Removed from the top: the diagnostics strip (moves into the "All systems" pill popover, which turns amber or red and names the failing check), the role bar (becomes "View as" in the header for directors; operators locked to a role see their role name only), the duplicate event pill (the header event name is the switcher), the duplicate sidebar clock and offset (into the status popover). Header keeps the date and time zone in full; the event name truncates first.

### 2.1 Now and next band
- One lane per room that has a LIVE, OVERRUN, HOLD or CALLING session, or a next session. Rooms are ordered by the event's room order (fallback: alphabetical).
- Lane = room label (110 px) + "now" row (≥ 58 px) + "next" row (40 px).
  - Now row: status badge, `#n title`, speaker summary with arrival state, the countdown (28 px tabular: "19:57 left", "+10:02 over", "held 3:12"), the primary action, a 20 px gap with a divider, then End (outlined danger) always in the same slot.
  - Next row: "Next" label, `#n title · start (delay) · in 25 min`, its status, a red "Not arrived" chip when the speaker is not marked arrived within 10 minutes of the start, and its primary action.
- Lane background: 8% tint of the now status; OVERRUN 14% magenta and the next row shows the knock-on ("12:05 now 12:15, at risk") with "Push following +N".
- Idle room: "Main Stage idle · next … in 25 min [Set ready]".
- More than 3 active rooms: lanes needing attention (OVERRUN, HOLD, LIVE, CALLING) stay full; the rest collapse to 28 px chips that expand on click.
- Single-room events: one lane.
- The band reuses the same-room next-session logic from the safety fix (`getNextSession`).

### 2.2 Compact list
- Rows 56 px (2 lines) on a fixed grid: status badge (100) · # (28) · title and speaker line (flex) · room chip (110) · time (120: "13:35–14:20", "was 13:30" underneath when delayed, or live countdown) · delay (44) · primary action (150).
- Left edge 4 px in the status colour, always meaning status (delay never recolours it; delay shows in the delay column and the filter-row chip).
- Speaker line: speaker summary, then line icons for mics, rec, stream, languages, remote, a note icon when a note exists (first line of the note visible when the session is live or next).
- One primary action per row (the next legal transition: Set ready, Call speaker, On stage, End…, Resume). Everything else is in the inspector.
- Editing tools (bulk checkbox, move up/down, edit pencil) appear on row hover or focus, and in an "Edit run of show" mode for the director; not on every row at all times.
- ENDED sessions fold into one 34 px "N completed" row at the top; CANCELLED into one row at the bottom; both expand on click.
- The anchor that stops a delay cascade shows as a dashed divider row with a label.
- The list opens scrolled to the first non-finished row. Selecting a row (click, Enter, arrow keys as today) shows it in the inspector.

### 2.3 Inspector (right rail, 360 px; 320 at 1280)
- Defaults to the most urgent session (OVERRUN > LIVE > HOLD > CALLING > next READY), follows the user's selection afterwards, and returns to the most urgent when that changes status.
- Contents: status badge, `#n`, title (16/700), room, type, production flags; full speaker list with arrival toggle; time block (planned only if it differs from scheduled; started); countdown (32 px) and progress bar; notes (full text); controls:
  - Primary row: the forward action, a gap, End (outlined danger). HOLD sits left of End in LIVE and OVERRUN; positions never change.
  - Time row: "This session −1 / +1 min" and "Push following +5 / +10 / +15" visibly separated (the push changes every later session).
  - Monitor row: Stage monitor, Stage timer.
  - "More" menu: Restart, Mark arrived, Edit, Move up/down, Cancel session.
- Destructive confirms use one shared pattern (from the safety branch): first press arms (solid red, "Press again to end", 3 s, survives re-renders, announced via `aria-live`), second press acts. Optional later: press and hold.
- The event log takes the remaining height (min 240 px): filter chips (All, Status, Broadcast, Errors), newest first, each row with its own time, export CSV.

### 2.4 Header details
- Event switcher (keyboard accessible button, not a `div`), "Tue 6 Oct · Cairo UTC+3".
- Clock 26 px tabular, event-local time with the zone shown.
- "All systems" pill → popover with database, realtime, clock sync (offset, rtt, last sync), Edge Functions.
- Crew presence dots → popover with names and roles.
- "View as" (directors) → role switch.
- Help, account menu (Check-in, Team, Billing, Language, Shortcuts, Auto-start, Sign out). Check-in and Team are no longer top-level buttons.
- AVE Brain: a header badge with a count when it has insights; hidden when empty.
- AI tools (Test incident alert, Test cue alert, Generate report): move into the account menu under "Tools"; never next to show controls.

### 2.5 Timeline view (second view under the same band)
- Lanes 40 px; label "13:35 Title", full title in a tooltip; opens at NOW −1 h to +3 h with "Fit day".
- Planned time drawn as an outline, scheduled as the fill; LIVE and OVERRUN bars grow to NOW with the overrun part hatched.
- Same status tokens as the list; solid fills with dark text.
- NOW line in event-local time (safety fix).
- Clicking a bar selects it in the inspector. The band stays visible, so controls are never lost.

### 2.6 1280×720
Same structure; band lanes compress to one line (now and next side by side, 44 px); inspector 320 px with notes collapsed to one line; log ≥ 200 px.

### 2.7 Phone (≤ 767 px)
- Header 48 px: logo, clock, status dot, room picker (the operator's lane), menu.
- Banner one line, tap to expand.
- "Now" card for the chosen room: status, title (2 lines max), 30 px countdown, progress, speakers and arrival, note, two 48 px buttons (primary, End), time adjust.
- "Next" card with its primary action.
- "Later" list of 48 px rows; finished sessions folded.
- Bottom tabs: Now, Schedule (full list, filters, timeline), Log, Send (broadcast composer as a sheet).
- Directors get one stacked Now and Next block per room.

### 2.8 Role defaults
- Director: everything above.
- Stage: the band and list filtered to "Active" (from the safety fix), their room first if the event has rooms; inspector controls limited to their permissions.
- AV: production flags (mics, rec, stream, languages, remote) are prominent in the band and inspector; HOLD is the same amber everywhere.
- Interp, reg, signage: unchanged panels, restyled with the tokens.

### 2.9 Broadcast
- Received: the banner sits at the top (28 px), states priority by colour and icon, shows sender and time, and collapses to a header chip after it is read.
- Send: the composer stays at the bottom (52 px) on desktop with presets as a menu; Enter sends info and warn; critical needs a second press. Presets insert text without emoji.

## 3. Components (one spec each)

- **Button**: sizes sm 28 / md 32 / lg 40 (coarse pointer 40/44/48); variants primary (accent solid), forward (status solid), secondary (raised fill + control border), ghost, danger (red outline); states hover (fill step, no `filter: brightness`), active, focus-visible ring, disabled (opacity .4), armed (`confirm-pending`, solid red). Sentence case labels; uppercase only via CSS for badges and labels.
- **Badge**: 22 px, radius 6, 11/700, .06em uppercase via CSS; per-state recipe above; only CALLING and OVERRUN may animate.
- **Chip/tag**: 22 px, radius 4, 12 px, divider border; room and type chips distinguishable by icon.
- **Section label**: one class, 11/700, .06em uppercase, `--text-tertiary`, consistent inset; text passes through `t()`.
- **Input/select**: 32 px (36 broadcast), `--input-bg`, control border, radius 8, focus ring; no inline `outline:none`.
- **Card/row**: as 2.2; radius 8; section border; 4 px status edge.
- **Modal**: `role="dialog"`, `aria-modal`, labelled, focus trap, focus returns on close, one generic Escape handler (the setup wizard and welcome modals opt out with `data-esc="off"`, because closing them skips onboarding), overlay surface, radius 12, footer buttons md with primary on the right.
- **Toast**: radius 8, status colours from tokens, container `aria-live` (assertive for errors); errors stay until dismissed or 8 s.
- **Status pill**: one component for system and connection state; label names what failed.
- **Icons**: one inline SVG line set (16 px, `stroke: currentColor`) replacing every emoji used as an icon in the console (list in the visual audit: broadcast, team, notes, report, stream, rec, languages, mics, remote, anchor, timer, alert, monitor, presets, help menu, auth screens, signage overrides, command palette, empty states).

## 4. Copy rules
Sentence case for buttons, menus, titles, toasts and modals (i18n strings rewritten in every language in `cuedeck-i18n.js`; Arabic unaffected). Uppercase only via CSS for status badges and section labels. No em-dashes anywhere, including the automatic "starting now" announcement that reaches audience displays. Times as HH:MM; seconds only on running timers and the header clock. Empty values show "–".

## 5. Accessibility
Every interactive element reachable by keyboard (event switcher and account chip become buttons), a skip link to the band, logical tab order (band, filters, list, inspector, broadcast), labelled icon buttons, `aria-pressed` on toggles, live regions for toasts and the armed confirm, and the focus ring everywhere. Target sizes ≥ 24 px desktop, 44 to 48 px touch.

## 6. How it gets built (stages, each releasable)

0. **Screenshot baseline harness** (about half a day). The audit's capture spec becomes a `toHaveScreenshot` suite at 1440, 1280 and 390 for each role and state, with the clock frozen, animations disabled and live timers masked. Must be stable (3 runs, zero diff) before stage 1.
1. **Tokens** (about 1 day). Aliases become references, exact-match literals become tokens (zero pixel diff), then the deliberate palette change (new surfaces, borders, text, status set, one blue, one red). JS `STATUS_COLOR` reads CSS. A CI check fails when the count of hard-coded colours outside `:root` rises (ratchet down).
2. **Components** (2 to 3 days). Buttons, badges, chips, labels, inputs, modals, toasts, pills, icons; one commit per task, with the components listed in the commit body; keep class names tests rely on (`confirm-pending`, `.primary`, `.rbtn[data-role]`, `btn-*` until the tests are updated in the same commit).
3. **Chrome and list** (2 days). New header with the status popover, role bar and diagnostics strip removed, compact rows, folded finished sessions, HH:MM times, editing tools on hover, AI tools moved to the menu.
4. **Band and inspector** (2 to 3 days). Now and next band, inspector with fixed control slots, log with filters, timeline adjustments.
5. **Phone and copy** (1 to 2 days). Phone layout and tabs, sentence case i18n in every language, em-dash removal, accessibility items.

Each stage: Playwright screenshot diffs reviewed, the full console e2e suite green, a review, a live check on app.cuedeck.io, and a short note to Sherif with before and after screenshots. Stages 1 to 3 are visible improvements on their own; nothing ships half a layout.

**Timing against GTR (12 Oct), decided 2026-10-06: all five stages before GTR.** The safety fixes ship first. Each stage ships as soon as it is reviewed and live-checked. Code freeze: nothing new ships after the evening of 10 Oct; a stage not fully reviewed and live-checked by then waits until after GTR. 11 Oct is a rehearsal day on the finished console (every status, delay, overrun, broadcast, stage monitor, phone). Order of value if time runs short: stage 1 (lines and colour) and stage 3 (header and compact list) first, then 4, then 2 and 5.

## 7. Risks
- Tests select by class and exact text (listed in the design-system audit: `auth-flows`, `console-pairing`, `console-confirm`, `session-*`, `console-ui`); each stage updates the affected specs in the same commit.
- `.sc-meta > span:not(.spk):not([style])` styles chips because the flags span has an inline style; removing inline styles changes which spans become chips. Handled in stage 2.
- The Escape handler and boot checks read `style.display`; modals stay on inline display until those readers move in the same commit.
- Parallel sessions edit `cuedeck-console.html`; each stage branches from the latest main and merges promptly.

## 8. Decisions (Sherif, 2026-10-06)
1. Release: all five stages before GTR, with the 10 Oct evening code freeze above.
2. Destructive confirm: two presses (the fixed, re-render-safe version from the safety branch). Press and hold is not built.
3. AI test tools: moved into the account menu under "Tools", away from show controls.
