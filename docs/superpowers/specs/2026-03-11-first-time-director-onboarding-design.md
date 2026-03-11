# First-Time Director Onboarding UX — Design Spec

**Date:** 2026-03-11
**Approach:** A — Targeted fixes
**File modified:** `cuedeck-console.html` only

---

## Problem

New directors land on a confusing empty state with no guidance:

1. **Wizard bug:** `boot()` has an early `return` at line ~5979 when `events.length === 0`. The wizard trigger at line ~6067 is never reached — the setup wizard never fires for brand-new directors.
2. **Welcome modal is generic:** Shows role name + role description + "Get Started." No next action, no path forward.
3. **"No active events" empty state is weak:** Says _"Use the ＋ button above"_ — that button is tiny, unlabelled, and buried in the header.
4. **No visual cue on the ＋ button** when there are no events.

---

## Design

### Fix 1 — Wizard fires on first login (bug fix)

Move the wizard trigger **inside** the early-return block in `boot()`, before the `return`:

```js
if (!events.length) {
  // render "No events yet" empty state
  buildEvSelect([]);
  overlay.style.display = 'none';

  // NEW: trigger wizard for first-time directors
  if (S.role === 'director') {
    const uid = S.user?.id || 'anon';
    if (!localStorage.getItem('cuedeck_wiz_' + uid + '_done')) {
      setTimeout(() => showSetupWizard(), 400);
    }
  }
  return;
}
```

The `cuedeck_wiz_{uid}_done` localStorage flag is **not** reset when the wizard is skipped — this is intentional. Skipping means "don't show again automatically." The empty state (Fix 3) provides a manual re-entry path.

---

### Fix 2 — Welcome modal is director-aware

When `showWelcomeModal(role)` is called AND role is `director` AND `S.events.length === 0`, render an actionable welcome instead of the generic one.

**New director welcome content:**
- Logo icon + **"Welcome, [first name]! 👋"** headline
- Subtitle: "You're set up as Director"
- Body: _"Let's get your first event ready — it only takes 2 minutes."_
- 3-step pills: **① Create event → ② Add sessions → ③ Go live**
- Primary CTA: **"Set Up My Event →"** — calls `dismissWelcome()` then `showSetupWizard()`
- Secondary: **"I'll explore on my own"** — calls `dismissWelcome()` only

For all other roles (or directors with existing events), the welcome modal stays exactly as it is.

**First name extraction:** `S.user?.user_metadata?.full_name?.split(' ')[0] || 'there'`

---

### Fix 3 — Improved "No events yet" empty state

Replace the existing "No active events" empty state in `boot()` (rendered when `events.length === 0`) with a guided version:

```
📅
No events yet
Start by creating your first event, then add your sessions and team.

[ ＋ Create Your First Event ]   ← calls openEvModal('create')

①  →  ②  →  ③  →  ④
Create event   Add sessions   Invite team   Go live
```

The big CTA calls `openEvModal('create')` (same as the header ＋ button).
The 4-step strip is decorative — provides orientation, not clickable.

This state is shown to **all roles** when no events exist (consistent with current behavior), but the CTA is only rendered for directors (same guard: `S.role === 'director'`).

---

### Fix 4 — Pulsing ＋ button when no events

After `buildEvSelect(events)` is called, if `events.length === 0`, add a CSS class `.pulse` to the ＋ button in the event selector:

```js
function buildEvSelect(events) {
  // ... existing render logic ...
  const plusBtn = wrap.querySelector('button[onclick*="openEvModal(\'create\')"]');
  if (plusBtn && !events.length) plusBtn.classList.add('pulse');
}
```

New CSS keyframe animation:
```css
@keyframes pulse-ring {
  0%   { box-shadow: 0 0 0 0 rgba(59,130,246,.8); }
  70%  { box-shadow: 0 0 0 8px rgba(59,130,246,0); }
  100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
}
.pulse {
  animation: pulse-ring 1.8s ease infinite;
  background: #3b82f6 !important;
  color: white !important;
}
```

Pulse stops automatically once the director creates an event (next `buildEvSelect` call with a non-empty array removes the class).

---

## Flow Summary

```
New director logs in (0 events, first time)
  │
  ├─ boot() loads events → empty array
  │   ├─ Render "No events yet" empty state (Fix 3)
  │   ├─ buildEvSelect([]) → ＋ button pulses (Fix 4)
  │   ├─ setTimeout → showSetupWizard() fires (Fix 1)
  │   └─ return early (no event to load)
  │
  └─ If S._showWelcome is set (first login after email confirm):
      └─ showWelcomeModal('director') → director-aware modal (Fix 2)
          ├─ "Set Up My Event →" → wizard
          └─ "I'll explore on my own" → closes, wizard not shown
```

**Note:** Both `S._showWelcome` and the wizard can coexist. The welcome modal fires first (it's triggered before `initChecklist`). The wizard fires 400ms after overlay hides, by which point the welcome modal may still be open. To avoid layering, the wizard `setTimeout` in boot should only fire if `!S._showWelcome` — or the "Set Up My Event" button in the welcome modal launches the wizard, so the auto-trigger in boot is redundant when the welcome modal is present.

**Revised boot logic:**
```js
if (!events.length) {
  buildEvSelect([]);
  overlay.style.display = 'none';
  if (S.role === 'director') {
    const uid = S.user?.id || 'anon';
    const wizDone = localStorage.getItem('cuedeck_wiz_' + uid + '_done');
    // Only auto-launch wizard if welcome modal won't fire
    // (welcome modal's CTA will launch it if _showWelcome is set)
    if (!wizDone && !S._showWelcome) {
      setTimeout(() => showSetupWizard(), 400);
    }
  }
  return;
}
```

---

## Files Modified

- `cuedeck-console.html` — only file

## CSS Additions (~5 rules)
- `@keyframes pulse-ring`
- `.pulse` (applied to ＋ button when no events)

## JS Changes
- `boot()` — wizard trigger moved inside early-return block
- `showWelcomeModal(role)` — director-aware branch
- `buildEvSelect(events)` — add `.pulse` class when empty
- Empty state HTML in `boot()` — redesigned

## Verification
1. New director, first login → welcome modal shows with name + 3-step pills + "Set Up My Event" CTA
2. Click "Set Up My Event" → wizard opens
3. Click "I'll explore on my own" → modal closes, wizard does NOT auto-open (since `_showWelcome` was set)
4. Director skips wizard → lands on "No events yet" empty state with big CTA + 4-step strip
5. ＋ button in header pulses when no events, stops after event created
6. Director with existing events: welcome modal unchanged (generic)
7. Non-director roles: welcome modal unchanged
8. No JS errors at any state
