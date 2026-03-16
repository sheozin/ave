# UI Visibility Improvements — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve visibility of event selector, edit icons, and timeline toggle in cuedeck-console.html.

**Architecture:** All changes are in a single file (`cuedeck-console.html`) — CSS updates + JS function rewrites. No database or backend changes.

**Tech Stack:** Vanilla HTML/CSS/JS, single-file architecture.

**Spec:** `docs/superpowers/specs/2026-03-16-ui-visibility-improvements-design.md`

**Note on innerHTML usage:** This codebase uses innerHTML throughout for dynamic rendering (buildEvSelect, buildFilterBar, renderSessions, etc). All user-sourced values are passed through the existing `esc()` helper which escapes HTML entities, preventing XSS. This is the established pattern in the codebase.

---

## Chunk 1: Edit Icons + Event Selector + Timeline

### Task 1: Edit Icon Visibility

**Files:**
- Modify: `cuedeck-console.html:1041-1042` (`.ev-edit-btn` CSS)
- Modify: `cuedeck-console.html:1137-1139` (`.sc-mgmt-btn` CSS)
- Modify: `cuedeck-console.html:1722` (`#pp-edit-btn` inline style)

- [ ] **Step 1: Update `.ev-edit-btn` CSS (line 1041)**

Change `color:var(--dim)` to `color:#94a3b8` and `opacity:.5` to `opacity:.7`

- [ ] **Step 2: Update `.sc-mgmt-btn` CSS (lines 1137-1138)**

Change `color:var(--dim)` to `color:#94a3b8` and `opacity:.45` to `opacity:.7`

- [ ] **Step 3: Update `#pp-edit-btn` inline style (line 1722)**

Change `color:var(--dim)` to `color:#94a3b8`, add `opacity:.7;transition:opacity .12s`, add hover handlers:
`onmouseover="this.style.opacity='1';this.style.color='var(--text)'"`
`onmouseout="this.style.opacity='.7';this.style.color='#94a3b8'"`

- [ ] **Step 4: Verify in browser**

Open https://app.cuedeck.io, reload, confirm all edit icons are visible (light gray) and hover to white.

- [ ] **Step 5: Commit**

`fix: increase edit icon visibility — opacity 0.45→0.7, color #94a3b8`

---

### Task 2: Event Selector Combined Pill

**Files:**
- Modify: `cuedeck-console.html:477-486` (CSS for `.rbtn`, `#ev-select-wrap`)
- Modify: `cuedeck-console.html:4632-4645` (`buildEvSelect()` function)
- Add: new `.ev-pill` CSS classes after line 486
- Add: `toggleEvDropdown()`, `closeEvDropdown()` JS functions after `buildEvSelect()`

- [ ] **Step 1: Add new CSS for `.ev-pill`, `.ev-pill-label`, `.ev-pill-name`, `.ev-pill-chev`, `.ev-pill-dd`, `.ev-add-btn`**

Insert after line 486. The pill uses `background:#1e293b`, `border-radius:8px`, `border:1px solid rgba(148,163,184,0.2)`. The dropdown (`.ev-pill-dd`) is `position:absolute;top:100%;z-index:200`, hidden by default, shown with `.open` class. The add button (`.ev-add-btn`) uses blue accent: `background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.4);color:#60A5FA`.

- [ ] **Step 2: Rewrite `buildEvSelect()` (lines 4632-4645)**

Replace the function. New structure:
- Outer wrapper with `position:relative`
- `.ev-pill` div with: `.ev-pill-label` "EVENT" + `.ev-pill-name` (active event name or "None") + `.ev-pill-chev` "▾"
- `onclick="toggleEvDropdown()"` on the pill
- `.ev-edit-btn` adjacent to pill (for active event)
- `.ev-pill-dd` dropdown with buttons for each event (click calls `switchEvent()` then `closeEvDropdown()`)
- `.ev-add-btn` button with "＋"
- Keep `.rbtn-pulse` on the add button when director has 0 events

- [ ] **Step 3: Add `toggleEvDropdown()` and `closeEvDropdown()` functions**

Insert after `buildEvSelect()`. Also add a `document.addEventListener('click', ...)` to close dropdown on outside click (check `!e.target.closest('#ev-select-wrap')`).

- [ ] **Step 4: Verify in browser**

Reload https://app.cuedeck.io, check:
- Pill shows [EVENT | ABC SUMMIT | ▾]
- Click opens dropdown, click outside closes
- ＋ button has blue accent
- Edit ✎ visible next to pill

- [ ] **Step 5: Commit**

`feat: redesign event selector as combined pill with dropdown`

---

### Task 3: Timeline Toggle Reposition + Smart Auto-Open

**Files:**
- Modify: `cuedeck-console.html:402-403` (`.fb-view-pill` CSS — remove `margin-left:auto`)
- Modify: `cuedeck-console.html:4656-4671` (`buildFilterBar()` — reorder + add toast element)
- Modify: `cuedeck-console.html:3035-3040` (`setViewMode()` — track manual override)
- Modify: `cuedeck-console.html:2947` (`renderSessions()` — add auto-switch logic before timeline check)
- Modify: `cuedeck-console.html:4691` (`switchEvent()` — reset override flag)
- Add: toast CSS after line 414
- Add: `S.tlManualOverride = false` near `S.viewMode` initialization

- [ ] **Step 1: Remove `margin-left:auto` from `.fb-view-pill` CSS (line 403)**

Change `display:flex; gap:2px; margin-left:auto; flex-shrink:0;` to `display:flex; gap:2px; flex-shrink:0;`

- [ ] **Step 2: Add toast CSS after line 414**

Add `.tl-auto-toast` class: `padding:4px 12px;font-size:10px;color:#f59e0b;font-style:italic;display:none;align-items:center;gap:6px;` with `.show` variant: `display:flex;`

- [ ] **Step 3: Update `buildFilterBar()` (lines 4656-4671)**

Keep the same order of elements (search, filter-toggle, status, room, clear, count, view-pill) but add a toast div after the view-pill: `<div id="tl-auto-toast" class="tl-auto-toast">⚡ Auto-switched to Timeline — sessions starting soon</div>`

The removal of `margin-left:auto` from CSS (step 1) handles the repositioning — the pill naturally flows after the filters.

- [ ] **Step 4: Update `setViewMode()` (lines 3035-3040)**

Add `if (mode === 'list') S.tlManualOverride = true;` inside the function so manually switching to list prevents re-auto-switching.

- [ ] **Step 5: Add auto-switch logic in `renderSessions()` (before line 2947)**

Before the existing timeline view check, add logic:
- If `S.viewMode === 'list'` AND `!S.tlManualOverride`
- Check `S.sessions.some(s => s.status === 'READY' || s.status === 'CALLING')`
- If true: set `S.viewMode = 'timeline'`, call `buildFilterBar()`, show toast with 4s auto-dismiss, call `renderTimeline()`, return

- [ ] **Step 6: Reset flag in `switchEvent()` (after line 4691)**

Add `S.tlManualOverride = false;` after the filter reset line.

- [ ] **Step 7: Initialize `S.tlManualOverride = false`**

Find where `S.viewMode` is first set and add `S.tlManualOverride = false` nearby.

- [ ] **Step 8: Verify in browser**

Reload https://app.cuedeck.io:
- Toggle appears right after "All rooms" dropdown (no gap)
- Auto-switch to Timeline if READY/CALLING sessions exist
- Toast shows and fades after 4s
- Manual switch to List prevents re-auto-switching
- Event switch resets the flag

- [ ] **Step 9: Commit**

`feat: reposition timeline toggle + add smart auto-open on READY/CALLING`

---

### Task 4: Final Verification + Push

- [ ] **Step 1: Full browser test**

Reload https://app.cuedeck.io with Cmd+Shift+R:
- No JS console errors
- All 3 features work together
- Test mobile layout (resize to 375px)
- Screenshot proof

- [ ] **Step 2: Push to both remotes**

```
git push cuedeck main
git push origin main
```
