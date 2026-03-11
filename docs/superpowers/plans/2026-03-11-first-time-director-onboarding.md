# First-Time Director Onboarding UX — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 UX gaps so a brand-new director immediately understands what to do after their first login.

**Architecture:** All changes in a single HTML file (`cuedeck-console.html`). No build system — edits are live after browser hard-refresh (Cmd+Shift+R). Changes are pure CSS/HTML/JS modifications: new CSS keyframe, updated `buildEvSelect()`, reworked `showWelcomeModal()`, new empty-state HTML, and a wizard trigger moved before an early `return`.

**Tech Stack:** Vanilla HTML/CSS/JS, Supabase JS v2. Dev server: `python3 -m http.server 7230` at `http://127.0.0.1:7230/cuedeck-console.html`.

**Spec:** `docs/superpowers/specs/2026-03-11-first-time-director-onboarding-design.md`

---

## Chunk 1: CSS + buildEvSelect pulse

### Task 1: Add `@keyframes pulse-ring` + `.rbtn-pulse` CSS

**Files:**
- Modify: `cuedeck-console.html` — CSS section near line 758 (after existing badge-pulse keyframes)

- [ ] **Step 1: Find the insertion point**

  Search for `badge-pulse-overrun` (line ~764). Add new CSS directly after its closing `}`.

- [ ] **Step 2: Insert the CSS**

  ```css
  /* ── ONBOARDING: pulsing + button when no events ── */
  @keyframes pulse-ring {
    0%   { box-shadow: 0 0 0 0 rgba(59,130,246,.8); }
    70%  { box-shadow: 0 0 0 8px rgba(59,130,246,0); }
    100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
  }
  .rbtn-pulse {
    animation: pulse-ring 1.8s ease infinite !important;
    background: #3b82f6 !important;
    color: #fff !important;
  }
  ```

- [ ] **Step 3: Verify no CSS parse errors**

  Hard-refresh `http://127.0.0.1:7230/cuedeck-console.html`. DevTools → Console. Confirm 0 errors.

---

### Task 2: Pulse the ＋ button in `buildEvSelect` when no events

**Files:**
- Modify: `cuedeck-console.html` — `buildEvSelect()` at line ~4268

- [ ] **Step 1: Locate the ＋ button render line**

  Find inside `buildEvSelect`:
  ```js
  html += `<button class="rbtn" onclick="openEvModal('create')" title="New event">＋</button>`;
  wrap.innerHTML = html;
  ```

- [ ] **Step 2: Replace those two lines**

  ```js
  const plusClass = (S.role === 'director' && !events.length) ? 'rbtn rbtn-pulse' : 'rbtn';
  html += `<button class="${plusClass}" onclick="openEvModal('create')" title="New event">＋</button>`;
  wrap.innerHTML = html;
  ```

- [ ] **Step 3: Verify in browser**

  Log in as director with 0 events. The header ＋ button should pulse blue. After creating an event, next `buildEvSelect` call removes the pulse.

- [ ] **Step 4: Commit**

  ```bash
  cd "/Users/sheriff/Downloads/AVE Production Console"
  git add cuedeck-console.html
  git commit -m "feat: pulse + button when director has no events"
  ```

---

## Chunk 2: Welcome modal — director-aware

### Task 3: Store `userName` on `S` in `loadUserRole`

**Files:**
- Modify: `cuedeck-console.html` — `loadUserRole()` at line ~5436

- [ ] **Step 1: Find `S.userRole = data.role;` (line ~5436)**

- [ ] **Step 2: Add the line directly after it**

  ```js
  S.userName = data.name || '';
  ```

- [ ] **Step 3: Verify in DevTools**

  Hard-refresh → log in → run `S.userName` in console. Should return director's name string.

---

### Task 4: Rework `showWelcomeModal` and simplify HTML shell

**Files:**
- Modify: `cuedeck-console.html`
  - `showWelcomeModal()` + `dismissWelcome()` at line ~5142
  - `#welcome-modal` HTML at line ~1866

- [ ] **Step 1: Replace the welcome modal HTML shell**

  Find (lines ~1867-1877):
  ```html
  <div id="welcome-modal" class="ev-modal-backdrop" style="display:none" onclick="if(event.target===this)dismissWelcome()">
    <div class="ev-modal-card" style="max-width:420px;text-align:center">
      <div style="font-size:28px">🎉</div>
      <div class="ev-modal-title" style="font-size:16px">Welcome to CueDeck!</div>
      <div id="welcome-role-name" ...></div>
      <div id="welcome-role-desc" ...></div>
      <div class="ev-modal-actions" style="justify-content:center">
        <button class="primary" onclick="dismissWelcome()">Get Started</button>
      </div>
    </div>
  </div>
  ```

  Replace with an empty shell (JS fills it):
  ```html
  <div id="welcome-modal" class="ev-modal-backdrop" style="display:none" onclick="if(event.target===this)dismissWelcome(false)">
    <div class="ev-modal-card" style="max-width:420px">
    </div>
  </div>
  ```

- [ ] **Step 2: Replace `showWelcomeModal` and `dismissWelcome` functions**

  Find and replace the two functions (lines ~5142-5149). New implementation uses `card.innerHTML` to render either the generic or director-specific layout. Security note: all user-supplied strings go through the existing `esc()` helper (same pattern used throughout the file).

  **Generic branch** (all non-directors, or directors with existing events):
  - 🎉 emoji, "Welcome to CueDeck!", role in blue, role description, "Get Started" button
  - `dismissWelcome(false)` on click

  **Director branch** (role === 'director' AND `!S.events || S.events.length === 0`):
  - Logo icon div + "Welcome, [firstName]! 👋" + "You're set up as Director"
  - Body text: "Let's get your first event ready — it only takes 2 minutes."
  - 3 step pills: ① Create event → ② Add sessions → ③ Go live (inline flex layout)
  - Primary button: "Set Up My Event →" → calls `dismissWelcome(true)`
  - Secondary button: "I'll explore on my own" → calls `dismissWelcome(false)`

  New `dismissWelcome(launchWizard)`:
  - Hides the modal
  - If `launchWizard === true`, calls `showSetupWizard()`

  Full replacement code:

  ```js
  function showWelcomeModal(role) {
    const modal = document.getElementById('welcome-modal');
    const card  = modal.querySelector('.ev-modal-card');
    const firstName = (S.userName || '').split(' ')[0] || 'there';
    const isNewDirector = (role === 'director' && (!S.events || S.events.length === 0));

    if (isNewDirector) {
      // Director-aware welcome with wizard CTA
      // Note: firstName goes through esc() — same XSS guard used throughout app
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div style="width:38px;height:38px;background:linear-gradient(135deg,#1d4ed8,#3b82f6);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">🎬</div>
          <div>
            <div style="font-size:15px;font-weight:700;color:#f1f5f9">Welcome, ${esc(firstName)}! 👋</div>
            <div style="font-size:11px;color:var(--dim);margin-top:2px">You're set up as Director</div>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.65;margin-bottom:16px">
          Let's get your first event ready — it only takes 2 minutes.
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:18px">
          <div style="flex:1;background:var(--bg);border:1px solid #1e3a5f;border-radius:8px;padding:9px 6px;text-align:center">
            <span style="font-size:11px;color:var(--blue);font-weight:800;display:block;margin-bottom:3px">①</span>
            <span style="font-size:10px;color:var(--dim)">Create event</span>
          </div>
          <span style="color:#334155;font-size:12px">→</span>
          <div style="flex:1;background:var(--bg);border:1px solid #1e3a5f;border-radius:8px;padding:9px 6px;text-align:center">
            <span style="font-size:11px;color:var(--blue);font-weight:800;display:block;margin-bottom:3px">②</span>
            <span style="font-size:10px;color:var(--dim)">Add sessions</span>
          </div>
          <span style="color:#334155;font-size:12px">→</span>
          <div style="flex:1;background:var(--bg);border:1px solid #1e3a5f;border-radius:8px;padding:9px 6px;text-align:center">
            <span style="font-size:11px;color:var(--blue);font-weight:800;display:block;margin-bottom:3px">③</span>
            <span style="font-size:10px;color:var(--dim)">Go live</span>
          </div>
        </div>
        <div class="ev-modal-actions" style="flex-direction:column;gap:7px">
          <button class="primary" onclick="dismissWelcome(true)">Set Up My Event →</button>
          <button onclick="dismissWelcome(false)" style="background:transparent;border:1px solid #334155;color:var(--dim);font-size:11px">I'll explore on my own</button>
        </div>`;
    } else {
      // Generic welcome for all other roles
      card.innerHTML = `
        <div style="font-size:28px;text-align:center">🎉</div>
        <div class="ev-modal-title" style="font-size:16px">Welcome to CueDeck!</div>
        <div style="font-size:13px;color:var(--blue);font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin-top:2px;text-align:center">${role.toUpperCase()}</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin:4px 0;text-align:center">${ROLE_DESCRIPTIONS[role] || ''}</div>
        <div class="ev-modal-actions" style="justify-content:center;margin-top:12px">
          <button class="primary" onclick="dismissWelcome(false)">Get Started</button>
        </div>`;
    }
    modal.style.display = 'flex';
  }

  function dismissWelcome(launchWizard) {
    document.getElementById('welcome-modal').style.display = 'none';
    if (launchWizard) showSetupWizard();
  }
  ```

- [ ] **Step 3: Verify generic welcome**

  Run in DevTools: `S.events = []; S.userName = ''; showWelcomeModal('stage')`
  → 🎉 modal, role name in blue, "Get Started" button. Click it → closes. ✓

- [ ] **Step 4: Verify director welcome**

  Clear `cuedeck_last_role_{uid}` in localStorage → hard-refresh → log in as director with 0 events.
  → Director modal shows name, pills, "Set Up My Event →". Click it → wizard opens. ✓
  → Repeat, click "I'll explore on my own" → modal closes, wizard does NOT open. ✓

- [ ] **Step 5: Commit**

  ```bash
  git add cuedeck-console.html
  git commit -m "feat: director-aware welcome modal with setup wizard CTA"
  ```

---

## Chunk 3: Empty state + wizard bug fix

### Task 5: Redesign "No events yet" empty state + fix wizard trigger

**Files:**
- Modify: `cuedeck-console.html` — `boot()` no-events block at line ~5969 and onboarding section at line ~6063

- [ ] **Step 1: Locate the no-events block (line ~5969)**

  Find:
  ```js
  if (!events.length) {
    document.getElementById('sessions-list').innerHTML = `
      <div id="empty">
        <div class="ei">📅</div>
        <h2>No active events</h2>
        <p>Use the <strong>＋</strong> button above to create a new event.</p>
      </div>`;
    document.getElementById('event-name').textContent = 'No active events';
    buildEvSelect([]);
    overlay.style.display = 'none';
    return;
  }
  ```

- [ ] **Step 2: Replace with guided state + wizard trigger**

  The director CTA is a big blue "＋ Create Your First Event" button (calls `openEvModal('create')`) plus a 4-step numbered strip below it. Non-directors see the heading/text only (they can't create events).

  Wizard trigger logic inside the block: only fires when `!S._showWelcome` — if the welcome modal is about to show, it has its own "Set Up My Event →" CTA, so we don't double-trigger the wizard.

  ```js
  if (!events.length) {
    const labels = ['Create event','Add sessions','Invite team','Go live'];
    const stepsHtml = labels.map((label, i) =>
      `<div style="flex:1;text-align:center;position:relative">
        ${i < 3 ? '<span style="position:absolute;right:0;top:50%;transform:translateY(-50%);color:var(--dim);font-size:14px">›</span>' : ''}
        <div style="width:22px;height:22px;background:#1e3a5f;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--blue);margin:0 auto 5px">${i + 1}</div>
        <div style="font-size:10px;color:var(--dim)">${label}</div>
      </div>`).join('');
    const directorCTA = (S.role === 'director') ? `
      <button class="abtn btn-blue" style="padding:12px 24px;font-size:13px;font-weight:700;box-shadow:0 4px 16px rgba(59,130,246,.3)"
        onclick="openEvModal('create')">＋ Create Your First Event</button>
      <div style="display:flex;margin-top:20px;border-top:1px solid var(--border);padding-top:16px">${stepsHtml}</div>` : '';
    document.getElementById('sessions-list').innerHTML =
      `<div id="empty"><div class="ei">📅</div><h2>No events yet</h2>` +
      `<p>Start by creating your first event, then add your sessions and team.</p>` +
      `${directorCTA}</div>`;
    document.getElementById('event-name').textContent = 'No active events';
    buildEvSelect([]);
    overlay.style.display = 'none';
    // Wizard trigger — was unreachable before due to early return
    if (S.role === 'director' && !S._showWelcome) {
      const uid = S.user?.id || 'anon';
      if (!localStorage.getItem('cuedeck_wiz_' + uid + '_done')) {
        setTimeout(() => showSetupWizard(), 400);
      }
    }
    return;
  }
  ```

- [ ] **Step 3: Clean up dead wizard trigger in boot onboarding section**

  Find (line ~6063):
  ```js
  // Onboarding: checklist + tooltips + wizard
  initChecklist();
  // Show wizard for directors with no events; defer tooltips until wizard is done
  let _wizardShown = false;
  if (S.role === 'director' && (!S.events || S.events.length === 0)) {
    const uid = S.user?.id || 'anon';
    if (!localStorage.getItem('cuedeck_wiz_' + uid + '_done')) {
      _wizardShown = true;
      setTimeout(() => showSetupWizard(), 400);
    }
  }
  if (!_wizardShown) setTimeout(() => showRoleTips(), 800);
  ```

  Replace with:
  ```js
  // Onboarding: checklist + tooltips
  // (Wizard trigger for 0-event directors lives in the early-return block above)
  initChecklist();
  setTimeout(() => showRoleTips(), 800);
  ```

- [ ] **Step 4: Verify empty state renders correctly**

  Log in as director with 0 events (or temporarily swap the `if (!events.length)` condition to `if (true)` to force the state, then revert).

  Expected:
  - `sessions-list` shows 📅 "No events yet", subtext, big blue "＋ Create Your First Event", 4-step strip.
  - Click "＋ Create Your First Event" → new event modal opens.
  - Header shows "No active events" as event name.

- [ ] **Step 5: Verify wizard auto-fires (bug fix)**

  1. Director account, 0 events.
  2. Clear `cuedeck_wiz_{uid}_done` and `cuedeck_last_role_{uid}` in localStorage.
  3. Hard-refresh → log in.
  4. Expected order: overlay hides → ~400ms → wizard appears (no welcome modal since `_showWelcome` not set).

- [ ] **Step 6: Commit**

  ```bash
  git add cuedeck-console.html
  git commit -m "fix: wizard fires on first login, guided no-events empty state"
  ```

---

## Chunk 4: End-to-end verification

### Task 6: Full flow testing + cleanup

- [ ] **Step 1: Flow A — Welcome modal → wizard (brand new director)**

  Setup: director account, 0 events, `cuedeck_last_role_{uid}` cleared, `cuedeck_wiz_{uid}_done` cleared.

  1. Log in → director welcome modal (logo, name, 3 pills, "Set Up My Event →").
  2. Click "Set Up My Event →" → wizard opens step 1.
  3. Complete wizard → console shows sessions area, event in header, ＋ no longer pulses. ✓

- [ ] **Step 2: Flow B — Skip wizard → empty state re-entry**

  Setup: director, 0 events, `cuedeck_wiz_{uid}_done` cleared, `cuedeck_last_role_{uid}` set (no welcome modal).

  1. Log in → wizard auto-opens.
  2. Click "Skip" → guided empty state shown.
  3. ＋ button pulses in header.
  4. Click "＋ Create Your First Event" → new event modal opens. ✓

- [ ] **Step 3: Flow C — Returning director (has events)**

  1. Log in as director with 1+ events.
  2. No wizard, no welcome modal, no guided empty state. Sessions list loads. ＋ not pulsing. ✓

- [ ] **Step 4: Flow D — Non-director role**

  1. Log in as stage operator (first time). Generic 🎉 welcome modal. "Get Started" closes it. ✓

- [ ] **Step 5: Mobile 375px check**

  Resize browser to 375px width. Check: welcome modal card doesn't overflow. 3-step pills wrap gracefully. 4-step strip readable.

- [ ] **Step 6: Run unit tests**

  ```bash
  npm test
  ```
  Expected: **119/119 pass**

- [ ] **Step 7: Delete mockup file + final commit**

  ```bash
  rm "/Users/sheriff/Downloads/AVE Production Console/onboarding-mockup.html"
  git add cuedeck-console.html
  git commit -m "feat: complete first-time director onboarding UX"
  ```

---

## Summary

| # | Location | Change |
|---|----------|--------|
| 1 | CSS ~line 764 | `@keyframes pulse-ring` + `.rbtn-pulse` |
| 2 | `buildEvSelect()` ~line 4268 | Add `.rbtn-pulse` when `!events.length && director` |
| 3 | `loadUserRole()` ~line 5436 | `S.userName = data.name \|\| ''` |
| 4 | `showWelcomeModal()` ~line 5142 | Director-aware branch with 3-step pills + wizard CTA |
| 5 | `dismissWelcome()` ~line 5147 | Add `launchWizard` param |
| 6 | `#welcome-modal` HTML ~line 1867 | Empty shell (JS-rendered content) |
| 7 | `boot()` no-events ~line 5969 | Guided empty state + wizard trigger inside early-return |
| 8 | `boot()` onboarding ~line 6063 | Remove dead wizard condition |
