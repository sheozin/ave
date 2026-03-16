# UI Visibility Improvements — Design Spec

**Date:** 2026-03-16
**Status:** Approved

## Summary

Three UI visibility improvements to `cuedeck-console.html`:

1. Event selector redesign (combined pill)
2. Edit icon visibility increase
3. Timeline toggle repositioning + smart auto-open

## 1. Event Selector — Combined Pill

**Problem:** The event selector ("EVENT: ABC SUMMIT ＋") blends into the header. The ＋ button is especially hard to spot.

**Solution:** Merge the EVENT label and event name into a single pill/chip control with a dropdown chevron (▾). Separate ＋ button with blue accent styling.

**Details:**
- Single pill: gray "EVENT" label on left, white event name in middle, ▾ chevron on right
- Pill background: `#1e293b`, border: `rgba(148,163,184,0.2)`, border-radius: 8px
- Clicking the pill opens a dropdown list of all events (replaces individual `.rbtn` buttons)
- ＋ button: blue accent — `background: rgba(59,130,246,0.15)`, `border: 1px solid rgba(59,130,246,0.4)`, `color: #60A5FA`
- Pulse animation on ＋ still triggers when director has 0 events (`.rbtn-pulse`)
- Edit button (✎) appears inside the pill or adjacent when active event is selected

**CSS classes affected:** `#ev-select-wrap`, `.rbtn`, `.rbtn.active`, `.rbtn-pulse`
**JS function:** `buildEvSelect()`

## 2. Edit Icons — Muted Default, White on Hover

**Problem:** All edit icons (✎) are styled with `opacity: 0.45–0.5` and `color: var(--dim)`, making them nearly invisible on the dark background.

**Solution:** Raise base opacity to 0.7 and use a lighter gray (`#94a3b8`). Hover state remains full white.

**Changes:**
- `.ev-edit-btn`: opacity `0.5` → `0.7`, color `var(--dim)` → `#94a3b8`
- `.ev-edit-btn:hover`: opacity `1`, color `var(--text)` — unchanged
- `.sc-mgmt-btn`: opacity `0.45` → `0.7`, color `var(--dim)` → `#94a3b8`
- `.sc-mgmt-btn:hover`: opacity `1`, color `var(--text)` — unchanged
- Profile panel edit button (`#pp-edit-btn`): same treatment via inline style update

## 3. Timeline Toggle — Reorder + Smart Auto-Open

**Problem:** The List/Timeline toggle is pushed to the far right of the filter bar with `margin-left: auto`, making it easy to miss.

**Solution:** Two changes:

### A. Reorder filter bar
New order: Search → All statuses → All rooms → List | Timeline

Remove `margin-left: auto` from the view pill. The toggle sits right after the filter dropdowns in natural left-to-right flow.

### B. Smart auto-open
Auto-switch to Timeline view when any session enters READY or CALLING state.

- Trigger: inside `renderSessions()` or realtime handler, check if any session has status READY or CALLING
- Switch `S.viewMode` to `'timeline'` and re-render
- Show amber toast: "⚡ Auto-switched to Timeline — sessions starting soon"
- Toast auto-dismisses after 4 seconds
- Track `S.autoSwitchedTimeline = true` — once user manually switches back to List, don't auto-switch again for that event load
- Reset flag on `switchEvent()` or `loadSnapshot()`

**CSS classes affected:** `.fb-view-pill`, `#fb-count`
**JS functions:** `buildFilterBar()`, `renderSessions()`, `setViewMode()`, `switchEvent()`
