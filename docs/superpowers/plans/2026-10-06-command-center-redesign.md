# Command Center Redesign Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the CueDeck console (`cuedeck-console.html`) as direction B, "Now and next": a token-driven dark theme with visible lines, a compact header, a now-and-next band per room, a compact session list, an inspector rail with fixed control slots and an always-visible event log, and a phone layout with tabs. All five stages ship before GTR on 12 Oct 2026, with nothing shipping after the evening of 10 Oct.

**Architecture:** Everything stays in the single file `cuedeck-console.html` (one `<style>` block, one main `<script>`), plus strings in `cuedeck-i18n.js`. Stage 1 turns `:root` into the single source of truth for colour, type, space and radius, and a vitest ratchet stops new hard-coded colours. Stage 2 adds shared primitives (`.btn`, `.badge`, `.chip`, `.lbl`, `.pill`, an inline SVG sprite with `icon()`). Stages 3 and 4 replace the chrome, list and sidebar with new render functions that read the existing state object `S`, the existing transition functions and the show-safety helpers, and re-render on the existing 1 s tick with focus kept. A Playwright `toHaveScreenshot` suite with a frozen clock and fully mocked Supabase guards every stage; each stage merges to `main`, is pushed to both remotes and is checked live on app.cuedeck.io.

**Tech Stack:** Vanilla HTML, CSS and JS (no framework, no build step), Supabase JS v2 from the CDN, Playwright 1.58 (`@playwright/test`, system Chrome via `channel: 'chrome'`), vitest 2.1 (node environment), Vercel auto-deploy from the `cuedeck` remote.

**Spec:** docs/superpowers/specs/2026-10-06-command-center-redesign-design.md

## Global Constraints

- Surfaces: `--bg #0A0E14`, `--panel #10161F`, `--card #161E2B`, `--raised #1D2737`, `--overlay #243044`, `--input-bg #0D121A`.
- Borders: `--border-divider rgba(203,213,225,.14)`, `--border-section rgba(203,213,225,.24)`, `--border-control rgba(203,213,225,.44)`.
- Text: `--text-primary #E6E9EF`, `--text-secondary #B4BCC8`, `--text-tertiary #98A2B3`, `--text-disabled #768091`; `--text-dim` is retired (kept only as an alias).
- Status solids: PLANNED `#94A3B8`, READY `#34D399`, CALLING `#FACC15`, LIVE `#EF4444`, OVERRUN `#E879F9`, HOLD `#FB923C`, ENDED `#64748B`, CANCELLED `#4B5563`; text on a solid fill `#0A0E14`; each status has `--st-<s>`, `-bg` (16 %), `-fg`, `-line`, and a `-wash` for lanes (8 %, OVERRUN 14 %).
- Accent and focus: `--accent #2563EB` (white text), `--accent-fg #60A5FA`, focus ring `0 0 0 2px var(--bg), 0 0 0 4px #93C5FD` on every `:focus-visible`.
- Action colours (controller ruling, 6 Oct, overrides the earlier spec wording): never red for a non-destructive action. Set ready, On stage, Go live and Resume are solid green (`--st-ready`, dark text); Call speaker is solid yellow (`--st-calling`); Hold is solid amber; End and Cancel are red outline (danger); solid red only for the armed confirm; everything else is secondary.
- Type scale: 11, 12, 13, 14, 16, 20, 28, 40 px; weights 400/500/600/700; letter-spacing .06em uppercase labels, .04em uppercase badges, -.01em large numbers; Inter with `tabular-nums` for times; nothing under 11 px. Named exceptions from the spec layout sections: header clock 26 px, desktop inspector countdown 32 px.
- Space 4/8/12/16/24/32; row heights 32/40/48/56/64; radius 4 chips, 6 badges, 8 buttons/inputs/cards, 12 modals and phone cards, 999 pills; buttons 28/32/40 desktop, 40/44/48 on `pointer: coarse`.
- Motion: only CALLING (badge ring), OVERRUN (lane edge) and connection lost animate; everything is off under `prefers-reduced-motion: reduce`.
- Copy: sentence case for buttons, menus, titles, toasts and modals; uppercase only through CSS for badges and section labels; no em-dashes anywhere (code strings, i18n values, this repo's new docs); times as HH:MM, seconds only on running timers and the header clock; an empty value shows `–` (en dash). Every new string goes through `t()` or `tf()` and exists in en, ar, pl and de under the `cc.` namespace.
- Single file, no framework, no build step, no new dependency.
- Serve the checkout under test on a private port with `python3 -m http.server 7291 --bind 127.0.0.1 --directory <checkout>` and pass `CONSOLE_BASE=http://127.0.0.1:7291`; never use 7230 (other checkouts).
- Work in the worktree `/Users/sheriff/AVE-Production-Console-redesign`, one branch per stage (`redesign/stage-0` … `redesign/stage-5`), branched from the latest `main`; `node_modules` is a symlink that is never staged.
- Git: `git status --short` first; `git add` explicit file paths only; `git commit` with a pathspec; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `git add -A`, `git add .` or `git commit -a`.
- Never name a local variable `t` in console code (it shadows the i18n `t()`); use `tf()` for strings with `{placeholders}`.
- Keep class names and ids that tests rely on (`confirm-pending`, `.primary` in modal footers, `.rbtn[data-role]`, `#card-<id>`, `[data-restart]`, `#ctx-wrap`, `#ctx-actions`, `#delay-strip`, `#dl-db`/`#dl-rt`/`#dl-ck`, `#bc-input`, `#bc-char`, `#sidebar`, `.btn-*`) until the same commit updates the tests that use them.
- Modals keep inline `style.display` (the Escape handler and boot checks read it) until the commit that moves those readers.
- Freeze: no release task starts after 18:00 on 10 Oct (Sherif's local time); a stage not reviewed and live-checked by 21:00 on 10 Oct waits until after GTR (13 Oct or later); 11 Oct is the rehearsal day and nothing is pushed.

### Assumed interfaces from `fix/show-safety` (on that branch now; Task 0.1 checks each after it is merged into `main`)

| Behaviour | Name the plan uses |
|---|---|
| Armed END/CANCEL survives re-renders | `_endPending`, `_cancelPending` (Maps keyed by session id), read by `buildButtons`; `confirmEnd(id, btn)`, `confirmCancel(id, btn)` |
| Fixed HOLD-then-END order | `ALLOWED.OVERRUN` is `['HOLD','ENDED']` |
| No timeline auto-switch | no `S._tlPrevStatus` / `tl-auto-toast` logic in `renderSessions` |
| "Active" status filter | `F.status === 'ACTIVE'` matches every status except ENDED and CANCELLED; default for stage and av |
| Same-room next session | `getNextSession(sessions, current)` returns the next not-finished session in `current.room` |
| Event-local time | `eventNowMinutes()` (minutes since local midnight in `S.event.timezone`) and `eventLocalHM()` |
| Log min-height | `#log-panel` has a real minimum height |
| Boot once | `S.booted` guard in `boot()` |

## Review Focus

Five failure modes the spec implies that no task's happy-path tests would catch. Each has a named test in its owning task.

1. **Four or more rooms at 1440×900.** Attention lanes must stay full, the rest collapse to 28 px chips, and the list must still show rows. Test: `band: 4 rooms keep attention lanes full and collapse the idle one` in `tests/e2e/console-band.spec.ts` (Task 4.1).
2. **A session with no room, and an event with no rooms at all.** The band must show one "No room" lane with the right now and next, not drop the sessions. Test: `band: sessions without a room get one No room lane` in `tests/e2e/console-band.spec.ts` (Task 4.1).
3. **Arabic (RTL) UI.** The band, list grid, inspector and header must mirror without overlap, and End must stay in its slot. Test: `layout: Arabic mirrors the band and keeps End last in reading order` in `tests/e2e/console-a11y.spec.ts` (Task 5.2).
4. **Very long titles and speaker lists.** Title and speaker cells must truncate inside the 56 px row and the 58 px lane; controls must never be pushed out. Test: `list: a 140-character title and nine speakers stay inside the row` in `tests/e2e/console-list.spec.ts` (Task 3.2) and `band: a long title never pushes End out of the lane` in `tests/e2e/console-band.spec.ts` (Task 4.1).
5. **An operator locked to one role, reduced motion, and 1280×720.** A stage operator sees no "View as" switch and only the controls their role allows; with reduced motion nothing animates; at 1280×720 the band plus 6 rows and a 200 px log fit. Tests: `header: a stage operator sees their role, not the View as menu` in `tests/e2e/console-header.spec.ts` (Task 3.1); `inspector: av sees Hold but never End` in `tests/e2e/console-inspector.spec.ts` (Task 4.2); `a11y: reduced motion stops every animation` in `tests/e2e/console-a11y.spec.ts` (Task 5.2); `layout: 1280x720 fits the band, six rows and a 200 px log` in `tests/e2e/console-inspector.spec.ts` (Task 4.2).

## Execution order and the freeze

Tasks are grouped by stage below. They are executed in the spec's order of value, so that whatever is live at the freeze is the most valuable part:

`0.1 → 0.2 → 1.1 → 1.2 → 1.3 → 1.4 → 2.1 → 3.1 → 3.2 → 3.3 → 4.1 → 4.2 → 4.3 → 4.4 → 2.2 → 2.3 → 2.4 → 5.1 → 5.2 → 5.3`

- Task 2.1 (the primitives: button, badge, chip, label, pill, icon sprite) is a prerequisite of stages 3 and 4 and ships inside the stage 3 release (Task 3.3). Tasks 2.2 and 2.3 ship in the stage 2 release (Task 2.4) after stage 4.
- If time runs short, drop from the end of this order: stage 5 first, then 2.2 and 2.3. Stages 1, 3 and 4 never depend on 2.2, 2.3 or stage 5.
- Every release task states the freeze rule and checks the clock first.

## File map

| File | Created or changed by |
|---|---|
| `playwright.console.config.ts` | created 0.1 |
| `playwright.config.ts` | 0.1 (`testIgnore` for the screenshot suite) |
| `tests/e2e/console-boot-mock.ts` | created 0.1; extended 1.2, 4.1 |
| `tests/e2e/console-visual.spec.ts` (+ `tests/e2e/__screenshots__/console-visual.spec.ts/*.png`) | created 0.1; cases added 4.1, 4.3, 5.1; baselines updated in every stage |
| `tests/console-colour-ratchet.spec.ts` | created 1.1; budget lowered 1.2, 2.1, 2.2, 2.3, 3.1, 3.2 |
| `tests/console-status-palette.spec.ts` | created 1.2 |
| `tests/display-status-tokens.spec.ts` | created 1.2 |
| `tests/e2e/console-tokens.spec.ts` | created 1.2, extended 1.3 |
| `tests/e2e/console-components.spec.ts` | created 2.1, extended 2.2 |
| `tests/console-no-emoji-icons.spec.ts` | created 2.3 |
| `tests/console-i18n-keys.spec.ts` | created 3.1 |
| `tests/e2e/console-header.spec.ts` | created 3.1 |
| `tests/e2e/console-list.spec.ts` | created 3.2 |
| `tests/e2e/console-band.spec.ts` | created 4.1 |
| `tests/e2e/console-inspector.spec.ts` | created 4.2 |
| `tests/e2e/console-timeline.spec.ts` | created 4.3 |
| `tests/e2e/console-phone.spec.ts` | created 5.1 |
| `tests/console-copy.spec.ts`, `tests/e2e/console-a11y.spec.ts` | created 5.2 |
| `tests/e2e/console-ui.spec.ts`, `tests/e2e/auth-flows.spec.ts`, `tests/e2e/session-management.spec.ts`, `tests/e2e/console-restart.spec.ts`, `tests/e2e/console-confirm.spec.ts` | updated in the task that changes the classes or text they select on (3.1, 3.2, 4.2, 5.2) |
| `cuedeck-console.html` | every build task |
| `cuedeck-i18n.js` | 3.1, 3.2, 4.1, 4.2, 4.3, 5.1, 5.2 |
| `cuedeck-display.html` | 1.2 (status colours only) |

## Task list

| Stage | Task | One line |
|---|---|---|
| 0 | 0.1 | Committed screenshot harness: boot mock, frozen clock, 12 scenarios at 1440/1280/390, 3-run stability |
| 0 | 0.2 | Release stage 0 (tests only) |
| 1 | 1.1 | Colour ratchet test, aliases as `var()` references, exact-match literals to tokens (zero pixel diff) |
| 1 | 1.2 | New palette, status set, control borders, focus ring, motion rule, timeline colours from CSS, display page status colours |
| 1 | 1.3 | Type floor (11 px) and the eight-size scale |
| 1 | 1.4 | Release stage 1 |
| 2 | 2.1 | Primitives: button, badge, chip, section label, status pill, SVG icon sprite and `icon()` |
| 2 | 2.2 | Inputs and selects, modals as dialogs with focus trap and one Escape handler, toasts |
| 2 | 2.3 | Every remaining emoji icon replaced by the sprite, with a guard test |
| 2 | 2.4 | Release stage 2 (2.2 and 2.3; 2.1 already shipped with stage 3) |
| 3 | 3.1 | Header: event switcher, clock, system pill and popover, crew, View as, account menu with Tools, banner chip and composer; diagnostics strip and role bar removed |
| 3 | 3.2 | Compact list: 56 px rows, status edge, folded finished sessions, HH:MM, one primary action, hover tools, selection drawer, delay chip in the filter row |
| 3 | 3.3 | Release stage 3 (with 2.1) |
| 4 | 4.1 | Now and next band, one lane per room, fixed End slot, knock-on and push, collapsed chips |
| 4 | 4.2 | Inspector rail with fixed control slots and More menu, armed confirm announced, event log with filters |
| 4 | 4.3 | Timeline: 40 px lanes, NOW −1 h to +3 h with Fit day, planned outline, overrun hatch, click selects |
| 4 | 4.4 | Release stage 4 |
| 5 | 5.1 | Phone: 48 px header with room picker, Now and Next cards, Later rows, bottom tabs, composer sheet |
| 5 | 5.2 | Copy (sentence case in every language, no em-dashes) and accessibility (skip link, labels, aria-pressed, RTL, reduced motion) |
| 5 | 5.3 | Release stage 5 |

20 tasks: 14 build tasks and 6 short release tasks (one per stage, as required).

---

# Stage 0: Screenshot baseline harness

### Task 0.1: Committed screenshot harness

**Files:**
- Create: `playwright.console.config.ts`
- Modify: `playwright.config.ts` (add `testIgnore` for the screenshot suite; CI runs this config on Linux, where Mac/Chrome baselines cannot match)
- Create: `tests/e2e/console-boot-mock.ts`
- Create: `tests/e2e/console-visual.spec.ts`
- Create: `tests/e2e/__screenshots__/console-visual.spec.ts/*.png` (generated, 12 files)
- Read only: `cuedeck-console.html` (no product change in this task)

**Interfaces:**
- Consumes: page globals `S`, `renderSessions()`, `refreshClockUI()`, `setViewMode()`, `setRole()`, `confirmEnd()`; element ids `#loading-overlay`, `#conn-lbl`, `#toast-container`.
- Produces (exports of `tests/e2e/console-boot-mock.ts`, used by every later spec): `BASE`, `SB`, `USER_ID`, `EVENT_ID`, `T0`, `FROZEN_AT`, `iso(mins)`, `ID(k)`, `PANEL_ID`, `demoSessions()`, `overrunSessions()`, `noLiveSessions()`, `fourRoomSessions()`, `roomlessSessions()`, `longTitleSessions()`, `type Scenario`, `openConsole(browser, scenario)`, `freeze(page)`, `evalPage(page, code)`, `MASK_SELECTORS`, `snap(page, name)`. Mask hook for later stages: any element with a `data-timer` attribute is masked.
- Produces: config `playwright.console.config.ts` that runs every console spec (new and existing) with system Chrome and Supabase blocked at DNS level.

- [ ] **Step 1: Pre-flight on `main`, after `fix/show-safety` is merged into `main`.** The safety work lives on `fix/show-safety` (commits `2d17d51`, `b03c3c1` and a review-fix round, in `/Users/sheriff/AVE-Production-Console-safety`); these names exist there, not on `main` yet. Run this check only after that branch is merged into `main`, and stop and ask Sherif if any line prints `MISSING`.

```bash
cd /Users/sheriff/AVE-Production-Console
git fetch cuedeck origin
git log --oneline -1 main
for pat in "S.booted" "function eventNowMinutes" "function eventLocalHM" "'ACTIVE'" "_endPending.has" "_cancelPending.has" "OVERRUN:   \['HOLD','ENDED'\]"; do
  if grep -q "$pat" cuedeck-console.html; then echo "ok      $pat"; else echo "MISSING $pat"; fi
done
grep -n "_tlPrevStatus\|tl-auto-toast" cuedeck-console.html || echo "ok      auto-switch removed"
```

Expected: seven `ok` lines and `ok      auto-switch removed`.

- [ ] **Step 2: Create the worktree and branch.**

```bash
cd /Users/sheriff/AVE-Production-Console
git worktree add -b redesign/stage-0 /Users/sheriff/AVE-Production-Console-redesign main
ln -s /Users/sheriff/AVE-Production-Console/node_modules /Users/sheriff/AVE-Production-Console-redesign/node_modules
cd /Users/sheriff/AVE-Production-Console-redesign
(python3 -m http.server 7291 --bind 127.0.0.1 --directory /Users/sheriff/AVE-Production-Console-redesign >/dev/null 2>&1 &)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7291/cuedeck-console.html
```

Expected: `200`.

- [ ] **Step 3: Write the config.** Create `playwright.console.config.ts`:

```ts
// Console specs for the command center redesign (2026-10-06) plus the
// existing console suites. System Chrome, Supabase blocked at DNS level so
// nothing reaches the real project; every spec mocks what it needs.
// Run: python3 -m http.server 7291 --bind 127.0.0.1 --directory <checkout> &
//      CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /(console-[\w-]+|session-[\w-]+|auth-flows|ai-agents)\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  expect: { toHaveScreenshot: { maxDiffPixels: 0 } },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    headless: true,
    channel: 'chrome',
    launchOptions: { args: ['--host-resolver-rules=MAP *.supabase.co 127.0.0.1:9'] },
  },
});
```

Then in `playwright.config.ts` add, directly under `testDir: './tests/e2e',`:

```ts
  // Screenshot baselines are recorded on macOS with system Chrome
  // (playwright.console.config.ts); CI's Linux Chromium cannot match them.
  testIgnore: /console-visual\.spec\.ts$/,
```

- [ ] **Step 4: Baseline the existing console suite on unchanged `main`.** A pre-existing failure is not an acceptable baseline: if anything fails here, stop and report it (it belongs to the safety branch, not to this plan).

```bash
cd /Users/sheriff/AVE-Production-Console-redesign
npx vitest run 2>&1 | tail -5
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts 2>&1 | tail -8
```

Expected: vitest all passed; Playwright `N passed`, some `skipped` (live-credential tests), `0 failed`. Record both counts in the commit message.

- [ ] **Step 5: Write the boot mock.** Create `tests/e2e/console-boot-mock.ts`. The event is in Africa/Cairo (UTC+3 on 6 Oct 2026), so the frozen clock is 08:40 UTC, which is 11:40 event-local, matching the session times.

```ts
// tests/e2e/console-boot-mock.ts
// Signed-in boot of cuedeck-console.html for the redesign specs: a stored
// supabase-js session, every REST/RPC/Edge Function call answered by
// context.route, a fake realtime WebSocket that reports SUBSCRIBED, the
// supabase-js CDN served from node_modules, Stripe and Google Fonts blocked,
// and the page clock frozen at 11:40:45 event-local (Africa/Cairo).
// Fictional data (GTR North Africa demo), never real customers.
import { expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export const BASE = process.env.CONSOLE_BASE ?? 'http://127.0.0.1:7230';
export const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
export const USER_ID = '5d0c1e2a-7a41-4c1b-9d8e-0a1b2c3d4e5f';
export const EVENT_ID = 'e7a1c9b0-2f34-4d6e-8a1b-3c5d7e9f1a2b';
// 08:40 UTC = 11:40 in Cairo (UTC+3). Sessions are in event-local time.
export const T0 = Date.parse('2026-10-06T08:40:00Z');
// Before the 60 s clock resync timer fires, after any realistic boot.
export const FROZEN_AT = T0 + 45_000;
export const iso = (minsFromT0: number) => new Date(T0 + minsFromT0 * 60_000).toISOString();
export const ID = (k: number) => `${String(k).padStart(8, '0')}-aaaa-4bbb-8ccc-${String(k).padStart(12, '0')}`;
export const PANEL_ID = ID(3);

const PEOPLE = [
  { name: 'Dina Farouk', company: 'Nilegate Retail Advisory', role: 'moderator' },
  { name: 'Karim Benali', company: 'Marrakai Airport Stores', role: 'panelist' },
  { name: 'Leila Mansour', company: 'Qantara Duty Free', role: 'panelist' },
  { name: 'Omar Haddad', company: 'Sahel Travel Retail', role: 'panelist' },
];
const base = {
  event_id: EVENT_ID, version: 3, delay_minutes: 0, cumulative_delay: 0, is_anchor: false,
  actual_start: null as string | null, actual_end: null as string | null, notes: null as string | null,
  state_changed_at: null as string | null,
  remote: false, streaming: false, recording: false, interpretation: false, languages: [] as string[], mics: 0,
  speaker_arrived: false, people: [] as unknown[], company: null as string | null, speaker: null as string | null,
};
type Sess = typeof base & Record<string, unknown>;
const sess = (k: number, o: Record<string, unknown>): Sess => ({ ...base, id: ID(k), sort_order: k, ...o });

export function demoSessions(): Sess[] {
  return [
    sess(1, { title: "Opening Keynote: North Africa's Travel Retail Outlook", type: 'Keynote', room: 'Main Stage',
      speaker: 'Youssef Amari', company: 'Meridian Gateway Holdings', status: 'ENDED', version: 7,
      planned_start: '09:30:00', planned_end: '10:15:00', scheduled_start: '09:30:00', scheduled_end: '10:15:00',
      actual_start: iso(-129), actual_end: iso(-83), state_changed_at: iso(-83), mics: 1, recording: true, streaming: true }),
    sess(2, { title: 'Workshop: Fragrance & Beauty Category Planning', type: 'Workshop', room: 'Hall B',
      speaker: 'Salma Khoury', company: 'Rivaline Beauty Group', status: 'HOLD', version: 5,
      planned_start: '11:00:00', planned_end: '11:45:00', scheduled_start: '11:00:00', scheduled_end: '11:45:00',
      actual_start: iso(-38), state_changed_at: iso(-9), mics: 2,
      notes: 'Projector input dropped at 11:31. AV on it, hold until signal is back.' }),
    sess(3, { title: 'Panel: Airport Retail in Cairo, Casablanca and Tunis', type: 'Panel', room: 'Main Stage',
      speaker: 'Dina Farouk (moderator), Karim Benali, Leila Mansour, Omar Haddad', people: PEOPLE,
      status: 'LIVE', version: 9, speaker_arrived: true,
      planned_start: '11:30:00', planned_end: '12:00:00', scheduled_start: '11:30:00', scheduled_end: '12:00:00',
      actual_start: iso(-10), state_changed_at: iso(-10), mics: 5, recording: true, streaming: true,
      interpretation: true, languages: ['EN', 'AR', 'FR'],
      notes: 'Moderator opens with audience poll. Two handheld mics for Q&A from 11:50.' }),
    sess(4, { title: 'Case Study: Rebuilding the Hurghada Arrivals Store', type: 'Talk', room: 'Hall B',
      speaker: 'Hany Wassef', company: 'Redsea Retail Partners', status: 'CALLING', version: 4,
      planned_start: '12:00:00', planned_end: '12:30:00', scheduled_start: '12:00:00', scheduled_end: '12:30:00',
      state_changed_at: iso(-11), mics: 1 }),
    sess(5, { title: 'Duty Free Pricing After the Currency Float', type: 'Talk', room: 'Main Stage',
      speaker: 'Rania Saleh', company: 'Orbis Pricing Lab', status: 'READY', version: 4,
      delay_minutes: 5, cumulative_delay: 5,
      planned_start: '12:00:00', planned_end: '12:30:00', scheduled_start: '12:05:00', scheduled_end: '12:35:00',
      state_changed_at: iso(-20), mics: 1, recording: true }),
    sess(6, { title: 'Digital Pre-Order and Click & Collect at the Gate', type: 'Talk', room: 'Main Stage',
      speaker: 'Tarek Nassar', company: 'Gateline Digital', status: 'PLANNED', version: 2, cumulative_delay: 5,
      planned_start: '13:30:00', planned_end: '14:15:00', scheduled_start: '13:35:00', scheduled_end: '14:20:00', mics: 1 }),
    sess(7, { title: 'Roundtable: Sustainable Packaging in Travel Retail', type: 'Workshop', room: 'Hall B',
      speaker: 'Mariam Gaber', company: 'Papyra Packaging', status: 'PLANNED', version: 1, is_anchor: true,
      planned_start: '14:00:00', planned_end: '14:45:00', scheduled_start: '14:00:00', scheduled_end: '14:45:00', mics: 4 }),
    sess(8, { title: 'Supplier Speed Meetings', type: 'Networking', room: 'Hall B',
      status: 'CANCELLED', version: 3, state_changed_at: iso(-55),
      planned_start: '15:00:00', planned_end: '15:30:00', scheduled_start: '15:00:00', scheduled_end: '15:30:00' }),
  ];
}
// Panel started 40 min ago with 30 min planned: +10:45 over at the frozen time.
export function overrunSessions(): Sess[] {
  return demoSessions().map(x => x.id === PANEL_ID
    ? { ...x, status: 'OVERRUN', planned_start: '11:00:00', planned_end: '11:30:00',
        scheduled_start: '11:00:00', scheduled_end: '11:30:00', actual_start: iso(-40) }
    : x);
}
export function noLiveSessions(): Sess[] {
  return demoSessions().map(x => (x.status === 'LIVE' || x.status === 'HOLD')
    ? { ...x, status: 'ENDED', actual_end: iso(-1), state_changed_at: iso(-1) } : x);
}
// Four rooms: Main Stage LIVE, Hall B HOLD, Hall C LIVE, Terrace idle with a next session.
export function fourRoomSessions(): Sess[] {
  return [
    ...demoSessions(),
    sess(9, { title: 'Masterclass: Luxury Watches at the Gate', type: 'Workshop', room: 'Hall C',
      speaker: 'Nadia Selmi', status: 'LIVE', version: 3, speaker_arrived: true,
      planned_start: '11:15:00', planned_end: '12:15:00', scheduled_start: '11:15:00', scheduled_end: '12:15:00',
      actual_start: iso(-25), state_changed_at: iso(-25), mics: 2 }),
    sess(10, { title: 'Sunset Networking Reception', type: 'Networking', room: 'Terrace',
      status: 'PLANNED', version: 1,
      planned_start: '17:00:00', planned_end: '18:30:00', scheduled_start: '17:00:00', scheduled_end: '18:30:00' }),
  ];
}
export function roomlessSessions(): Sess[] {
  return demoSessions().map(x => ({ ...x, room: null }));
}
export function longTitleSessions(): Sess[] {
  const nine = Array.from({ length: 9 }, (_, i) => ({ name: `Panelist Number ${i + 1} With A Long Name`, company: 'Example Co', role: i ? 'panelist' : 'moderator' }));
  return demoSessions().map(x => x.id === PANEL_ID
    ? { ...x, title: 'Panel: ' + 'Airport retail across North Africa and the Gulf, from Casablanca to Muscat, '.repeat(2).slice(0, 132), people: nine,
        speaker: nine.map(p => p.name).join(', ') }
    : x);
}

const EVENT = {
  id: EVENT_ID, name: 'GTR North Africa 2026', date: '2026-10-06', venue: 'Cairo', timezone: 'Africa/Cairo',
  active: true, created_via: 'console', event_start: '09:00:00', event_end: '17:00:00', created_at: '2026-09-01T08:00:00Z',
};
const BROADCAST = { id: EVENT_ID, event_id: EVENT_ID, message: 'Hall B on hold: projector signal lost. Main Stage running on time.', priority: 'warn', sent_at: iso(-8) };
const LOG = [
  { action: 'BROADCAST', payload: { message: 'Hall B on hold: projector signal lost' }, ts: iso(-8) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(2), from_status: 'LIVE', to_status: 'HOLD', ts: iso(-9) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(3), from_status: 'CALLING', to_status: 'LIVE', ts: iso(-10) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(4), from_status: 'READY', to_status: 'CALLING', ts: iso(-11) },
  { action: 'DELAY_APPLIED', session_id: ID(5), payload: { minutes: 5 }, ts: iso(-14) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(5), from_status: 'PLANNED', to_status: 'READY', ts: iso(-20) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(2), from_status: 'CALLING', to_status: 'LIVE', ts: iso(-38) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(8), from_status: 'PLANNED', to_status: 'CANCELLED', ts: iso(-55) },
  { action: 'SESSION_STATUS_CHANGE', session_id: ID(1), from_status: 'LIVE', to_status: 'ENDED', ts: iso(-83) },
].map((r, i) => ({ id: 1000 - i, event_id: EVENT_ID, from_status: null, to_status: null, session_id: null, payload: null, ...r }));
const DISPLAYS = [
  { id: 'd1000000-0000-4000-8000-000000000001', event_id: EVENT_ID, name: 'Main Foyer Schedule', zone_type: 'lobby', orientation: 'landscape',
    content_mode: 'schedule', filter_room: null, last_seen_at: iso(0), override_content: null, sequence: null },
  { id: 'd1000000-0000-4000-8000-000000000002', event_id: EVENT_ID, name: 'Hall B Door', zone_type: 'prefunction', orientation: 'portrait',
    content_mode: 'schedule', filter_room: 'Hall B', last_seen_at: iso(0), override_content: null, sequence: null },
];
const SPONSORS = [{ id: 's1', event_id: EVENT_ID, name: 'Qantara Duty Free', logo_url: null, sort_order: 1 }];
const NAMES: Record<string, string> = { director: 'Nour Selim', stage: 'Ahmed Fawzy', av: 'Mona Adel', interp: 'Sami Rashed', reg: 'Hoda Zaki', signage: 'Bassem Lotfy' };
const OPERATORS = Object.entries(NAMES).map(([role, name], i) => ({
  id: i ? `op-${i}` : USER_ID, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, role,
  organization: 'Nilegate Events', active: true, last_sign_in_at: iso(-i),
}));

export interface Scenario {
  role?: string;
  sessions?: unknown[];
  broadcast?: unknown | null;
  viewport?: { width: number; height: number };
  timezoneId?: string;
  locale?: 'en' | 'ar' | 'pl' | 'de';
  reducedMotion?: 'reduce' | 'no-preference';
  touch?: boolean;
}

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SUPABASE_UMD = path.resolve(__dirname, '../../node_modules/@supabase/supabase-js/dist/umd/supabase.js');

export async function openConsole(browser: Browser, sc: Scenario = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const role = sc.role ?? 'director';
  const sessions = sc.sessions ?? demoSessions();
  const broadcast = sc.broadcast === undefined ? BROADCAST : sc.broadcast;
  const ctx = await browser.newContext({
    viewport: sc.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: Number(process.env.CONSOLE_DSF ?? 1),
    timezoneId: sc.timezoneId ?? 'UTC', locale: 'en-GB',
    reducedMotion: sc.reducedMotion ?? 'no-preference',
    hasTouch: !!sc.touch, isMobile: !!sc.touch,
  });
  await ctx.clock.install({ time: T0 });

  const exp = 1924992000;
  const email = `${NAMES[role].split(' ')[0].toLowerCase()}@example.com`;
  const token = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: USER_ID, role: 'authenticated', exp, email }) + '.c2ln';
  const session = { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'demo-refresh',
    user: { id: USER_ID, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-06-01T00:00:00Z' } };
  await ctx.addInitScript(([k, v, uid, r, loc]) => {
    try {
      localStorage.setItem(k, v);
      localStorage.setItem('cuedeck_last_role_' + uid, r);
      localStorage.setItem('cuedeck_ck_' + uid + '_dismissed', '1');
      localStorage.setItem('cuedeck_wiz_' + uid + '_done', '1');
      for (const x of ['director', 'stage', 'av', 'interp', 'reg', 'signage']) localStorage.setItem('cuedeck_tips_' + uid + '_' + x, '1');
      if (loc && loc !== 'en') localStorage.setItem('cuedeck_locale', loc);
    } catch { /* storage blocked */ }
    const Native = window.WebSocket;
    class FakeWS extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      url: string; readyState = 0; protocol = ''; extensions = ''; bufferedAmount = 0; binaryType = 'arraybuffer';
      onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
      constructor(url: string) {
        super(); this.url = url;
        setTimeout(() => { this.readyState = 1; const e = new Event('open'); this.onopen?.(e); this.dispatchEvent(e); }, 30);
      }
      _emit(data: string) { const e = new MessageEvent('message', { data }); this.onmessage?.(e); this.dispatchEvent(e); }
      send(raw: string) {
        if (typeof raw !== 'string') return;
        const arr = raw.startsWith('[');
        const m = arr ? (() => { const [join_ref, ref, topic, event, payload] = JSON.parse(raw); return { join_ref, ref, topic, event, payload }; })() : JSON.parse(raw);
        const out = (topic: string, event: string, payload: unknown, ref: string | null, join_ref: string | null) =>
          setTimeout(() => this._emit(arr ? JSON.stringify([join_ref, ref, topic, event, payload]) : JSON.stringify({ topic, event, payload, ref, join_ref })), 10);
        if (m.event === 'phx_join') {
          const pc = (m.payload?.config?.postgres_changes || []).map((b: any, i: number) => ({ ...b, id: 1000 + i }));
          out(m.topic, 'phx_reply', { status: 'ok', response: { postgres_changes: pc } }, m.ref, m.join_ref ?? m.ref);
          const meta = (rl: string, key: string, name: string) => ({ [key]: { metas: [{ phx_ref: key, role: rl, userId: key, name }] } });
          out(m.topic, 'presence_state', { ...meta('director', 'p1', 'Nour Selim'), ...meta('stage', 'p2', 'Ahmed Fawzy'), ...meta('av', 'p3', 'Mona Adel'), ...meta('signage', 'p4', 'Bassem Lotfy') }, null, m.join_ref ?? m.ref);
        } else {
          out(m.topic, 'phx_reply', { status: 'ok', response: {} }, m.ref, m.join_ref ?? null);
        }
      }
      close() { this.readyState = 3; const e = new CloseEvent('close', { code: 1000 }); this.onclose?.(e); this.dispatchEvent(e); }
    }
    (window as any).WebSocket = function (url: string, p?: any) {
      return String(url).includes('supabase.co') ? new FakeWS(url) : new Native(url, p);
    } as any;
    Object.assign((window as any).WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  }, ['sb-sawekpguemzvuvvulfbc-auth-token', JSON.stringify(session), USER_ID, role, sc.locale ?? 'en']);

  // External CDNs: deterministic and offline.
  await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SUPABASE_UMD, 'utf8') }));
  await ctx.route(/^https:\/\/(js\.stripe\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, r => r.abort());
  await ctx.route('https://ave-brain.vercel.app/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"insights":[]}' }));

  const json = (r: Route, body: unknown, status = 200) =>
    r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  const unmocked: string[] = [];
  await ctx.route(new RegExp('^' + SB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const one = /vnd\.pgrst\.object/.test(req.headers()['accept'] || '');
    if (p.startsWith('/functions/v1/')) return json(r, { ok: true, status: 'OK', version: 10 });
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.split('/').pop();
      if (fn === 'get_server_clock') return json(r, [{ server_time: new Date(T0).toISOString(), tick: 48213 }]);
      if (fn === 'get_subscription_for_user') return json(r, [{ plan: 'pro', status: 'active', trial_ends_at: null, current_period_end: '2026-11-01T00:00:00Z' }]);
      if (fn === 'get_operators_with_last_seen') return json(r, OPERATORS);
      return json(r, null);
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.split('/').pop()!;
      if (req.method() === 'HEAD') {
        const cnt = table === 'leod_users' ? (url.search.includes('role=eq.pending') ? 0 : 6) : 0;
        return r.fulfill({ status: 200, headers: { 'content-range': `*/${cnt}`, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' } });
      }
      if (req.method() !== 'GET') return json(r, [], 201);
      const rows: Record<string, unknown[]> = {
        leod_users: [{ id: USER_ID, name: NAMES[role], email, role, organization: 'Nilegate Events', phone: null, active: true, company_name: 'Nilegate Events', vat_id: null, billing_address: null }],
        leod_config: [], leod_events: [EVENT], leod_sessions: sessions, leod_broadcast: broadcast ? [broadcast] : [],
        leod_event_log: LOG, leod_signage_displays: DISPLAYS, leod_signage_sponsors: SPONSORS,
      };
      if (!(table in rows)) unmocked.push(table);
      const data = rows[table] ?? [];
      if (one) return data.length ? json(r, data[0]) : json(r, { code: 'PGRST116', message: 'no rows' }, 406);
      return json(r, data);
    }
    unmocked.push(p);
    return json(r, { message: 'unmocked' }, 404);
  });

  const page = await ctx.newPage();
  page.on('dialog', d => { throw new Error('native dialog opened: ' + d.message()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.style.display === 'none', null, { timeout: 30_000 });
  await page.waitForFunction(() => (document.getElementById('conn-lbl')?.textContent || '').length > 0);
  await page.waitForTimeout(1500);
  if (unmocked.length) console.log('[unmocked]', [...new Set(unmocked)].join(', '));
  await freeze(page);
  return { ctx, page };
}

// Stop the clock at FROZEN_AT, zero the clock offset and draw once more, so
// every countdown, progress bar and NOW line is identical on every run.
export async function freeze(page: Page) {
  const now = await page.evaluate(() => Date.now());
  if (now >= FROZEN_AT) throw new Error(`boot took too long: page clock ${new Date(now).toISOString()} is past FROZEN_AT`);
  await page.clock.pauseAt(FROZEN_AT);
  await page.evaluate(() => {
    const St = (0, eval)('S');
    St.clockOffset = 0; St.clockRtt = 12; St.clockSynced = Date.now();
    (0, eval)('refreshClockUI(); renderSessions();');
    document.getElementById('toast-container')?.replaceChildren();
  });
}

export const evalPage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);

// Live timers are masked even though the clock is frozen (spec stage 0).
export const MASK_SELECTORS = ['#hdr-clock', '#hdr-offset', '#sb-time', '.ck-val', '.lt-remain', '.lt-elapsed', '.le-ts', '[data-timer]'];

// toHaveScreenshot against the committed baseline, or, with CONSOLE_NOTES_DIR
// set, a plain PNG for the before/after note to Sherif (use CONSOLE_DSF=2).
export async function snap(page: Page, name: string) {
  const notes = process.env.CONSOLE_NOTES_DIR;
  if (notes) {
    fs.mkdirSync(notes, { recursive: true });
    await page.screenshot({ path: path.join(notes, `${name}.png`), animations: 'disabled', caret: 'hide' });
    return;
  }
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0,
    mask: MASK_SELECTORS.map(s => page.locator(s)),
  });
}
```

- [ ] **Step 6: Write the visual suite.** Create `tests/e2e/console-visual.spec.ts`:

```ts
// tests/e2e/console-visual.spec.ts
// Screenshot baselines for the console, per role, state and width. The
// baselines change only on purpose: run with --update-snapshots in the task
// that changes the look, review every PNG, commit them with that task.
import { test } from '@playwright/test';
import { openConsole, snap, evalPage, overrunSessions, noLiveSessions, PANEL_ID, type Scenario } from './console-boot-mock';

interface Case { name: string; sc?: Scenario; prep?: string }
const CASES: Case[] = [
  { name: 'director-1440' },
  { name: 'director-1280', sc: { viewport: { width: 1280, height: 720 } } },
  { name: 'director-390', sc: { viewport: { width: 390, height: 844 }, touch: true } },
  { name: 'stage-1440', sc: { role: 'stage' } },
  { name: 'av-1440', sc: { role: 'av' } },
  { name: 'overrun-1440', sc: { sessions: overrunSessions() } },
  { name: 'no-live-1440', sc: { sessions: noLiveSessions(), broadcast: null } },
  { name: 'empty-1440', sc: { sessions: [], broadcast: null } },
  { name: 'timeline-1440', prep: `setViewMode('timeline')` },
  { name: 'armed-end-1440', prep: `document.querySelector('[onclick*="confirmEnd(\\'${PANEL_ID}\\'"]').click()` },
  { name: 'signage-1440', prep: `setRole('signage')` },
  { name: 'browser-cairo-1440', sc: { timezoneId: 'Africa/Cairo' } },
];

for (const c of CASES) {
  test(c.name, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, c.sc);
    try {
      if (c.prep) await evalPage(page, c.prep);
      await snap(page, c.name);
    } finally {
      await ctx.close();
    }
  });
}
```

- [ ] **Step 7: Run to see it fail (no baselines yet).**

```bash
cd /Users/sheriff/AVE-Production-Console-redesign
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-visual.spec.ts
```

Expected: 12 failures, each `A snapshot doesn't exist at .../__screenshots__/console-visual.spec.ts/<name>.png, writing actual`. No `[unmocked]` lines; if one appears, add that table to the `rows` map in the mock and rerun.

- [ ] **Step 8: Write the baselines and review them.**

```bash
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-visual.spec.ts --update-snapshots
ls tests/e2e/__screenshots__/console-visual.spec.ts/
```

Expected: 12 PNGs. Open each one (Read tool). Check: signed in, demo event name in the header, sessions rendered, broadcast banner where expected, pink mask boxes over the clock and timers, nothing half-loaded.

- [ ] **Step 9: Stability check, 3 runs, zero diff.**

```bash
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-visual.spec.ts --repeat-each=3
```

Expected: `36 passed`. Any failure means something is not frozen: open the `-diff.png` in `test-results/`, find the moving element, mask it by adding its selector to `MASK_SELECTORS` (only if it is a live timer) or freeze its source, regenerate, and rerun until 36 pass. Stage 1 does not start until this passes.

- [ ] **Step 10: Commit.**

```bash
git status --short
git add playwright.console.config.ts playwright.config.ts tests/e2e/console-boot-mock.ts tests/e2e/console-visual.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "test(console): screenshot baseline harness for the command center redesign

Frozen clock, mocked Supabase, fake realtime, 12 scenarios at 1440, 1280
and 390. Stable over 3 runs with zero diff.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- playwright.console.config.ts playwright.config.ts tests/e2e/console-boot-mock.ts tests/e2e/console-visual.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 0.2: Release stage 0

**Files:** none changed (git refs only).

**Interfaces:** Consumes branch `redesign/stage-0`. Produces `main` with the harness, pushed to `cuedeck` and `origin`.

- [ ] **Step 1: Freeze check.** `date`. If it is after 18:00 on 10 Oct (Sherif's local time), stop: nothing starts after the freeze.
- [ ] **Step 2: Integrate the remotes.**

```bash
cd /Users/sheriff/AVE-Production-Console
git status --short -- cuedeck-console.html cuedeck-i18n.js cuedeck-display.html tests playwright.console.config.ts
git fetch cuedeck origin
git log --oneline main..cuedeck/main
```

Expected: the status line prints nothing (if it prints files, another session is editing them in the main checkout: stop and ask Sherif). If `main..cuedeck/main` lists commits, run `git merge --ff-only cuedeck/main`; if that refuses (diverged), stop and ask Sherif.
- [ ] **Step 3: Review, rebase and merge.** Run the house `diff-review` skill on `main..redesign/stage-0` (repo `/Users/sheriff/AVE-Production-Console-redesign`) and fix findings first. Then:

```bash
cd /Users/sheriff/AVE-Production-Console-redesign && git rebase main
cd /Users/sheriff/AVE-Production-Console && git merge --ff-only redesign/stage-0
```

- [ ] **Step 4: Full test run on the merged tip** (served from the worktree, which now equals `main`).

```bash
cd /Users/sheriff/AVE-Production-Console-redesign
npx vitest run 2>&1 | tail -4
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts 2>&1 | tail -6
```

Expected: vitest all pass; Playwright same pass count as Task 0.1 Step 4 plus 12, `0 failed`.
- [ ] **Step 5: Check what will be pushed.**

```bash
cd /Users/sheriff/AVE-Production-Console
git log --oneline cuedeck/main..main
git log --oneline origin/main..main
```

Expected: only commits from this plan: the spec commits (`docs(console): command center redesign spec…`, `docs(console): redesign spec decisions…`), the plan commit if it is not yet pushed, the `fix/show-safety` merge if not yet pushed, and `test(console): screenshot baseline harness…`. Anything else: stop and ask Sherif.
- [ ] **Step 6: Push both remotes.** `git push cuedeck main && git push origin main`. Then `git log --oneline cuedeck/main..main` and `git log --oneline origin/main..main` both print nothing.
- [ ] **Step 7: CI ran and passed for this SHA** (a missing run is not a pass): `SHA=$(git rev-parse main)`, then `gh run list -R sheozin/cuedeck-console --commit "$SHA" --json conclusion,name` and the same for `-R sheozin/ave`. First see which repos run the workflow (`gh workflow list -R <repo>` shows `CI` as `active`); on each of those, wait until the run for this SHA exists and shows `conclusion: success`. Record which repos have no active CI in the note, rather than treating a missing run as a pass. A failure is a stop: fix forward on a new commit or revert, never leave `main` red.
- [ ] **Step 8: Verify the deploy.** In Vercel project `cuedeck-console` (`prj_yxtJHa9k9jO7ZEPjaYRr3BaBxuLz`, team `team_PwIbNALSFmtcg9ELOX9o34M0`), the deployment for the pushed SHA is `READY`. `curl -s https://app.cuedeck.io/ | grep -o "<title>[^<]*</title>"` returns the console title. No visible change is expected in this stage.
- [ ] **Step 9: Note to Sherif.** Two lines: "Stage 0 is in: the console now has a screenshot test suite (12 scenarios, stable over 3 runs). No visible change." No screenshots for this stage.

---

# Stage 1: Tokens

Branch: `git -C /Users/sheriff/AVE-Production-Console-redesign switch -c redesign/stage-1 main` (after Task 0.2).

### Task 1.1: Colour ratchet, aliases as references, exact-match literals to tokens

**Files:**
- Create: `tests/console-colour-ratchet.spec.ts`
- Modify: `cuedeck-console.html` `:root { … }` block (lines 21-80 on `4a76ff0`), and the rest of the `<style>` block (lines 81-1709) through a one-off script.

**Interfaces:**
- Consumes: existing tokens `--text-primary`, `--text-secondary`, `--text-muted`, `--input-bg`, `--card`, `--card-hi`, `--blue`, `--green`, `--amber`, `--red`, `--magenta`, `--purple`, `--*-lt`, `--border`, `--border-section`, `--border-subtle`, `--border-strong`.
- Produces: `colourLiteralsOutsideRoot(src)` (exported from the ratchet spec) and the committed `BUDGET` constant that every later task lowers.

- [ ] **Step 1: Write the ratchet test.** Create `tests/console-colour-ratchet.spec.ts`:

```ts
// tests/console-colour-ratchet.spec.ts
// Ratchet on hard-coded colours in cuedeck-console.html. Every colour belongs
// in :root (spec section 1). The count outside :root may only go down: when a
// change removes literals, lower BUDGET to the printed count in that commit.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BUDGET = 506;
const FILE = resolve(__dirname, '../cuedeck-console.html');
// Hex colours (3, 4, 6, 8 digits) not part of an entity (&#9662;) or an id
// selector with a hyphen (#bc-bar), plus rgb(a)/hsl(a) functions.
const COLOUR = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

export function colourLiteralsOutsideRoot(src: string): string[] {
  const start = src.indexOf(':root {');
  if (start < 0) throw new Error(':root block not found');
  const end = src.indexOf('}', start);
  const rest = src.slice(0, start) + src.slice(end + 1);
  return rest.match(COLOUR) ?? [];
}

describe('console colour ratchet', () => {
  it('counts literals in CSS, inline styles and script strings, but not entities, ids or :root', () => {
    const sample = '<style>:root { --a: #fff; }\n.x{color:#E5E7EB;border:1px solid rgba(1,2,3,.5)}</style>'
      + '<div style="color:#abc"></div><span>&#9662;</span>'
      + "<script>const c = '#0a0e14'; document.querySelector('#bc-bar');</script>";
    expect(colourLiteralsOutsideRoot(sample)).toEqual(['#E5E7EB', 'rgba(1,2,3,.5)', '#abc', '#0a0e14']);
  });

  it('hard-coded colours outside :root do not rise above the budget', () => {
    const found = colourLiteralsOutsideRoot(readFileSync(FILE, 'utf8'));
    console.log(`colour literals outside :root: ${found.length} (budget ${BUDGET})`);
    expect(found.length).toBeLessThanOrEqual(BUDGET);
  });

  it('the budget is kept tight: lower BUDGET when literals are removed', () => {
    const found = colourLiteralsOutsideRoot(readFileSync(FILE, 'utf8'));
    expect(BUDGET - found.length).toBeLessThan(10);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run tests/console-colour-ratchet.spec.ts`. On `4a76ff0` the count is 506. If the post-safety `main` prints a different count, set `BUDGET` to that printed number (the safety branch may add a few literals) and note the delta in the commit message. Expected after that: 3 passed.

- [ ] **Step 3: Make the aliases references (zero pixel diff).** In the `:root` block replace the block that starts `/* ── BACKWARD-COMPAT ALIASES` with:

```css
      /* ── BACKWARD-COMPAT ALIASES (references, never copies) ── */
      --text:     var(--text-primary);
      --dim:      var(--text-muted);
      --surface2: var(--card-hi);
      --fg:       var(--text-primary);
      --border2:  var(--border-section);
```

and make the duplicated status and utility values references:

```css
      --c-planned:  var(--blue);
      --c-ready:    var(--green);
      --c-calling:  var(--amber);
      --c-live:     var(--red);
      --c-overrun:  var(--magenta);
      --c-hold:     var(--amber);
      --c-break:    var(--purple);
      --c-ready-fg:     var(--green-lt);
      --c-calling-fg:   var(--amber-lt);
      --c-overrun-fg:   var(--magenta-lt);
      --c-hold-fg:      var(--amber-lt);
      --c-ended-fg:     var(--text-muted);
      --c-cancelled-fg: var(--text-dim);
```

(the `--c-*-bg` values and `--c-ended`, `--c-cancelled` stay as they are).

- [ ] **Step 4: Replace exact-match literals with their tokens (zero pixel diff).** Save this one-off script outside the repo and run it once:

```js
// $SCRATCH/cd-literals-to-tokens.mjs  (not committed)
import fs from 'node:fs';
const FILE = process.argv[2];
const src = fs.readFileSync(FILE, 'utf8');
const rootStart = src.indexOf(':root {');
const rootEnd = src.indexOf('}', rootStart) + 1;
const styleEnd = src.indexOf('</style>');
const head = src.slice(0, rootEnd);
let css = src.slice(rootEnd, styleEnd);
const tail = src.slice(styleEnd);
const MAP = [
  ['#e5e7eb', '--text-primary'], ['#9ca3af', '--text-secondary'], ['#6b7280', '--text-muted'],
  ['#0f1520', '--input-bg'], ['#141d2b', '--card'], ['#1a2640', '--card-hi'],
  ['#3b82f6', '--blue'], ['#22c55e', '--green'], ['#f97316', '--amber'], ['#ff3b30', '--red'],
  ['#ff00a8', '--magenta'], ['#8b5cf6', '--purple'],
  ['#86efac', '--green-lt'], ['#fdba74', '--amber-lt'], ['#f87171', '--red-lt'], ['#60a5fa', '--blue-lt'],
  ['#c4b5fd', '--purple-lt'], ['#ff80d4', '--magenta-lt'],
  ['rgba(148,163,184,.10)', '--border'], ['rgba(148,163,184,.08)', '--border-section'],
  ['rgba(148,163,184,.06)', '--border-subtle'], ['rgba(148,163,184,.20)', '--border-strong'],
];
function canon(lit) {
  if (lit.startsWith('#')) { let h = lit.slice(1).toLowerCase(); if (h.length === 3) h = [...h].map(c => c + c).join(''); return '#' + h; }
  const [r, g, b, a = '1'] = lit.replace(/rgba?\(|\)|\s/g, '').split(',');
  return `rgba(${+r},${+g},${+b},${+a})`;
}
const TABLE = new Map(MAP.map(([lit, tok]) => [canon(lit), tok]));
const RE = /(?<![&\w])#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;
let n = 0;
css = css.replace(RE, m => { const tok = TABLE.get(canon(m)); if (!tok) return m; n++; return `var(${tok})`; });
fs.writeFileSync(FILE, head + css + tail);
console.log(`replaced ${n} literals`);
```

```bash
node "$SCRATCH/cd-literals-to-tokens.mjs" /Users/sheriff/AVE-Production-Console-redesign/cuedeck-console.html
```

Expected: `replaced 75 literals` on `4a76ff0` (a few more or fewer after the safety merge is fine).

- [ ] **Step 5: Screenshot diff must be zero.**

```bash
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-visual.spec.ts
```

Expected: `12 passed`. A diff here means a mapping changed a value: find it in the diff PNG and revert that one replacement.

- [ ] **Step 6: Lower the budget.** `npx vitest run tests/console-colour-ratchet.spec.ts` prints the new count (about 431). Set `BUDGET` to exactly that number. Expected: 3 passed.

- [ ] **Step 7: Commit.**

```bash
git add tests/console-colour-ratchet.spec.ts cuedeck-console.html
git commit -m "refactor(console): colour ratchet; aliases and exact-match literals become tokens

Zero pixel diff (12 baselines unchanged). Literals outside :root: <before> to <after>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- tests/console-colour-ratchet.spec.ts cuedeck-console.html
```

### Task 1.2: New palette, status set, control borders, focus ring, motion, timeline colours from CSS

**Files:**
- Modify: `cuedeck-console.html`: the `:root` block (replaced whole); `.sc.status-*` rules (selector `/* Per-status card styles */`, lines 559-598); `.badge-*` rules (612-625); `.prog-fill.ov`, `.lt-remain.ov` (659, 671); `#header` (465-474); `#bc-banner.*` (458-460); `.le.le-*` (775-785); `.sm-status-live`, `.sm-live-dot` (1355-1363); `@keyframes badge-pulse-live`, `badge-pulse-overrun`, `badge-blink` users; `renderTimeline()` `STATUS_COLOR` map (3683-3687, 3722); a new block appended at the end of `<style>`.
- Modify: `cuedeck-display.html` `:root` (line 16) and status rules (lines 88-89, 108-111, 155, 197, 226, 254, 308-310) and the overrun and hold colours in the two timer functions (lines 839-910 and 1393-1400).
- Modify: `tests/e2e/console-boot-mock.ts` (add contrast helpers).
- Create: `tests/console-status-palette.spec.ts`, `tests/display-status-tokens.spec.ts`, `tests/e2e/console-tokens.spec.ts`.
- Update: all 12 PNG baselines.

**Interfaces:**
- Produces tokens (used by every later task): `--bg --panel --card --raised --overlay --input-bg`, `--border-divider --border-section --border-control`, `--text-primary --text-secondary --text-tertiary --text-disabled`, `--st-{planned,ready,calling,live,overrun,hold,ended,cancelled}` with `-bg -fg -line` and `--st-{ready,calling,live,hold,overrun}-wash`, `--on-solid`, `--accent --accent-hover --accent-fg --on-accent --focus --focus-ring --danger-line --danger-fg --hover-veil`, `--font-sans --font-mono`, `--fs-11 … --fs-40`, `--fs-clock`, `--fs-insp-countdown`, `--ls-label --ls-badge --ls-big`, `--sp-1 … --sp-6`, `--row-32 … --row-64`, `--r-chip --r-badge --r-ctl --r-modal --r-pill`, `--btn-sm --btn-md --btn-lg`.
- Produces JS: `statusColor(status)` (reads `--st-<status>` from CSS); used by `renderTimeline()` (4.3) and the phone cards (5.1).
- Produces test helpers in the boot mock: `borderContrast(page, selector, side)`, `textContrast(page, selector)`.

- [ ] **Step 1: Write the failing tests.** Create `tests/console-status-palette.spec.ts`:

```ts
// tests/console-status-palette.spec.ts
// Spec section 1: one colour per status, distinguishable under normal,
// protan and deutan vision (worst pair dE >= 20 over the six active states),
// text on solid fills >= 4.5:1, and JS reads status colours from CSS.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../cuedeck-console.html'), 'utf8');
const ROOT = SRC.slice(SRC.indexOf(':root {'), SRC.indexOf('}', SRC.indexOf(':root {')));
const tok = (name: string) => {
  const m = ROOT.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`${name} missing`);
  return m[1];
};
const hex = (x: string) => [0, 2, 4].map(i => parseInt(x.slice(1 + i, 3 + i), 16));
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (rgb: number[]) => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Machado et al. severity 1.0, the matrices the audit used (viz/cvd.py).
const PROT = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]];
const DEUT = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]];
const delin = (v: number) => { v = Math.min(Math.max(v, 0), 1); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };
const sim = (rgb: number[], M: number[][]) => { const l = rgb.map(lin); return M.map(r => Math.round(delin(r[0] * l[0] + r[1] * l[1] + r[2] * l[2]))); };
const lab = (rgb: number[]) => {
  const [r, g, b] = rgb.map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const dE = (a: number[], b: number[]) => { const A = lab(a), B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };

const ACTIVE = ['planned', 'ready', 'calling', 'live', 'overrun', 'hold'];

describe('status palette', () => {
  it('has the spec solids', () => {
    expect([...ACTIVE, 'ended', 'cancelled'].map(s => tok(`--st-${s}`).toUpperCase())).toEqual(
      ['#94A3B8', '#34D399', '#FACC15', '#EF4444', '#E879F9', '#FB923C', '#64748B', '#4B5563']);
    expect(tok('--on-solid').toUpperCase()).toBe('#0A0E14');
  });

  it('worst pair over the six active states is at least dE 20 under normal, protan and deutan vision', () => {
    let worst = Infinity;
    for (const M of [null, PROT, DEUT]) {
      for (let i = 0; i < ACTIVE.length; i++) for (let j = i + 1; j < ACTIVE.length; j++) {
        let a = hex(tok(`--st-${ACTIVE[i]}`)), b = hex(tok(`--st-${ACTIVE[j]}`));
        if (M) { a = sim(a, M); b = sim(b, M); }
        worst = Math.min(worst, dE(a, b));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(20);
  });

  it('dark text on every active solid is at least 5:1', () => {
    for (const s of ACTIVE) expect(ratio(hex(tok('--on-solid')), hex(tok(`--st-${s}`)))).toBeGreaterThanOrEqual(5);
  });

  it('JS reads status colours from CSS, not from its own map', () => {
    expect(SRC).not.toMatch(/STATUS_COLOR\s*=\s*\{/);
    expect(SRC).toMatch(/function statusColor\(status\)/);
  });
});
```

Create `tests/display-status-tokens.spec.ts`:

```ts
// tests/display-status-tokens.spec.ts
// Spec non-goals: the signage display keeps its layout but adopts the shared
// status colours (LIVE red, READY green, HOLD amber, OVERRUN magenta).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../cuedeck-display.html'), 'utf8');

describe('display page status colours', () => {
  it('declares the shared status tokens', () => {
    for (const [k, v] of [['--st-live', '#EF4444'], ['--st-ready', '#34D399'], ['--st-calling', '#FACC15'], ['--st-hold', '#FB923C'], ['--st-overrun', '#E879F9']]) {
      expect(SRC).toContain(`${k}: ${v}`);
    }
  });
  it('status labels use the tokens', () => {
    expect(SRC).toContain('.d-header-status.live{color:var(--st-live)}');
    expect(SRC).toContain('.d-header-status.ready{color:var(--st-ready)}');
    expect(SRC).toContain('.sc-tag.live{color:var(--st-live)}');
    expect(SRC).toContain('.st-status.hold{color:var(--st-hold)}');
    expect(SRC).toContain('.st-status.overrun{color:var(--st-overrun)}');
  });
});
```

Add to the end of `tests/e2e/console-boot-mock.ts`:

```ts
// WCAG contrast of a border or text colour against the element's own
// composited background (ancestors' background colours stacked).
const CONTRAST_JS = `(() => {
  const parse = c => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (f, b) => [0, 1, 2].map(i => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
  const bgOf = el => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e); let acc = [10, 14, 20, 1];
    for (const e of chain.reverse()) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) acc = over(c, acc); } return acc; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  return { border: (sel, side) => { const el = document.querySelector(sel); if (!el) return -1; const bg = bgOf(el);
             const c = parse(getComputedStyle(el)['border' + side[0].toUpperCase() + side.slice(1) + 'Color']); return ratio(over(c, bg), bg); },
           text: sel => { const el = document.querySelector(sel); if (!el) return -1; const bg = bgOf(el); return ratio(over(parse(getComputedStyle(el).color), bg), bg); } };
})()`;
export const borderContrast = (page: Page, sel: string, side: 'top' | 'right' | 'bottom' | 'left') =>
  page.evaluate(([js, s, d]) => (0, eval)(js).border(s, d), [CONTRAST_JS, sel, side] as const);
export const textContrast = (page: Page, sel: string) =>
  page.evaluate(([js, s]) => (0, eval)(js).text(s), [CONTRAST_JS, sel] as const);
```

Create `tests/e2e/console-tokens.spec.ts`:

```ts
// tests/e2e/console-tokens.spec.ts
// Spec success criteria for lines and colour, measured in the running page.
import { test, expect } from '@playwright/test';
import { openConsole, borderContrast, textContrast, evalPage, PANEL_ID } from './console-boot-mock';

test('tokens: section dividers are at least 1.78:1 and control boundaries at least 3:1', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  // Spec measures the section border at 1.79:1 on --bg and 1.85 to 1.87 on bars and cards.
  expect(await borderContrast(page, '#header', 'bottom')).toBeGreaterThanOrEqual(1.78);
  expect(await borderContrast(page, '#filter-bar', 'bottom')).toBeGreaterThanOrEqual(1.78);
  expect(await borderContrast(page, `#card-${PANEL_ID}`, 'top')).toBeGreaterThanOrEqual(1.78);
  for (const sel of ['#fb-search', '#fb-status', '#bc-input', '#bc-pri']) {
    expect(await borderContrast(page, sel, 'top'), sel).toBeGreaterThanOrEqual(3);
  }
  await ctx.close();
});

test('tokens: meta and label text is at least 4.5:1', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  for (const sel of [`#card-${PANEL_ID} .sc-num`, '#ctx-sub', '#fb-count', '#bc-bar label']) {
    const r = await textContrast(page, sel);
    if (r < 0) continue; // element not rendered in this state
    expect(r, sel).toBeGreaterThanOrEqual(4.5);
  }
  await ctx.close();
});

test('tokens: every focusable control shows the focus ring', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator('#fb-search').focus();
  const shadow = await page.locator('#fb-search').evaluate(el => getComputedStyle(el).boxShadow);
  expect(shadow).toContain('rgb(147, 197, 253)');
  await ctx.close();
});

test('tokens: the timeline draws LIVE with the --st-live colour from CSS', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `document.documentElement.style.setProperty('--st-live', '#123456'); setViewMode('timeline');`);
  const fills = await page.locator('#timeline-wrap rect.tl-bar').evaluateAll(els => els.map(e => e.getAttribute('fill')));
  expect(fills).toContain('#123456');
  await ctx.close();
});

test('tokens: HOLD and LIVE badges do not animate, CALLING may', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const anim = (sel: string) => page.locator(sel).first().evaluate(el => getComputedStyle(el).animationName);
  expect(await anim('.badge-HOLD')).toBe('none');
  expect(await anim('.badge-LIVE')).toBe('none');
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure.**

```bash
npx vitest run tests/console-status-palette.spec.ts tests/display-status-tokens.spec.ts
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-tokens.spec.ts
```

Expected: palette spec fails on `--st-planned missing`; display spec fails on `--st-live`; e2e fails on the contrast values (about 1.1 to 1.4), the focus ring, the timeline fill (`#ef4444`) and the LIVE badge animation (`badge-pulse-live`).

- [ ] **Step 3: Replace the whole `:root` block** with:

```css
    :root {
      color-scheme: dark;
      /* ── Surfaces (adjacent steps 1.07 to 1.13:1; borders carry the boundaries) ── */
      --bg:       #0A0E14;
      --panel:    #10161F;   /* bars, sidebar */
      --card:     #161E2B;
      --raised:   #1D2737;   /* chips, hover, selected */
      --overlay:  #243044;   /* modals, menus */
      --input-bg: #0D121A;

      /* ── Borders (slate-300 alpha) ── */
      --border-divider: rgba(203,213,225,.14);  /* inside cards: 1.34 to 1.41:1 */
      --border-section: rgba(203,213,225,.24);  /* bars, columns, card outline: 1.79 to 1.87:1 */
      --border-control: rgba(203,213,225,.44);  /* inputs, selects, secondary buttons: 3.0 to 3.33:1 */

      /* ── Text ── */
      --text-primary:   #E6E9EF;
      --text-secondary: #B4BCC8;
      --text-tertiary:  #98A2B3;  /* labels, meta, placeholder: 5.16 to 7.51:1 */
      --text-disabled:  #768091;

      /* ── Status: solid, 16% tint, text on the tint, outline, lane wash ── */
      --st-planned:   #94A3B8; --st-planned-bg:   rgba(148,163,184,.16); --st-planned-fg:   #CBD5E1; --st-planned-line:   rgba(148,163,184,.55);
      --st-ready:     #34D399; --st-ready-bg:     rgba(52,211,153,.16);  --st-ready-fg:     #6EE7B7; --st-ready-line:     rgba(52,211,153,.55);  --st-ready-wash:   rgba(52,211,153,.08);
      --st-calling:   #FACC15; --st-calling-bg:   rgba(250,204,21,.16);  --st-calling-fg:   #FDE047; --st-calling-line:   rgba(250,204,21,.55);  --st-calling-wash: rgba(250,204,21,.08);
      --st-live:      #EF4444; --st-live-bg:      rgba(239,68,68,.16);   --st-live-fg:      #FCA5A5; --st-live-line:      rgba(239,68,68,.55);   --st-live-wash:    rgba(239,68,68,.08);
      --st-overrun:   #E879F9; --st-overrun-bg:   rgba(232,121,249,.16); --st-overrun-fg:   #F5D0FE; --st-overrun-line:   rgba(232,121,249,.6);  --st-overrun-wash: rgba(232,121,249,.14);
      --st-hold:      #FB923C; --st-hold-bg:      rgba(251,146,60,.16);  --st-hold-fg:      #FED7AA; --st-hold-line:      rgba(251,146,60,.55);  --st-hold-wash:    rgba(251,146,60,.08);
      --st-ended:     #64748B; --st-ended-bg:     rgba(100,116,139,.16); --st-ended-fg:     #A3ACB9; --st-ended-line:     rgba(100,116,139,.55);
      --st-cancelled: #4B5563; --st-cancelled-bg: transparent;           --st-cancelled-fg: #8B94A3; --st-cancelled-line: var(--border-divider);
      --on-solid: #0A0E14;   /* text on a solid status fill: 5.14 to 12.63:1 */

      /* ── Accent, focus, danger ── */
      --accent:       #2563EB;   /* the one primary blue; white text 5.17:1 */
      --accent-hover: #1D4ED8;
      --accent-fg:    #60A5FA;   /* blue text and links */
      --on-accent:    #FFFFFF;
      --focus:        #93C5FD;
      --focus-ring:   0 0 0 2px var(--bg), 0 0 0 4px var(--focus);
      --danger-line:  rgba(239,68,68,.75);
      --danger-fg:    #FCA5A5;
      --hover-veil:   rgba(255,255,255,.12);

      /* ── Type ── */
      --font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --font-mono: 'SF Mono', 'Fira Code', Menlo, monospace;
      --fs-11: 11px; --fs-12: 12px; --fs-13: 13px; --fs-14: 14px; --fs-16: 16px; --fs-20: 20px; --fs-28: 28px; --fs-40: 40px;
      --fs-clock: 26px;            /* header clock (spec 2.4) */
      --fs-insp-countdown: 32px;   /* desktop inspector countdown (spec 2.3) */
      --ls-label: .06em; --ls-badge: .04em; --ls-big: -.01em;

      /* ── Space, rows, radius, controls ── */
      --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
      --row-32: 32px; --row-40: 40px; --row-48: 48px; --row-56: 56px; --row-64: 64px;
      --r-chip: 4px; --r-badge: 6px; --r-ctl: 8px; --r-modal: 12px; --r-pill: 999px;
      --btn-sm: 28px; --btn-md: 32px; --btn-lg: 40px;

      /* ── Legacy names: references only, do not add new uses ── */
      --surface:  var(--panel);
      --card-hi:  var(--raised);
      --surface2: var(--raised);
      --hover:    var(--raised);
      --text:     var(--text-primary);
      --fg:       var(--text-primary);
      --text-muted: var(--text-tertiary);
      --dim:      var(--text-tertiary);
      --text-dim: var(--text-disabled);   /* retired */
      --border:        var(--border-section);
      --border-strong: var(--border-section);
      --border-subtle: var(--border-divider);
      --border2:       var(--border-divider);
      --green: var(--st-ready);     --green-lt:   var(--st-ready-fg);
      --amber: var(--st-hold);      --amber-lt:   #FDBA74;
      --red:   var(--st-live);      --red-lt:     var(--danger-fg);
      --blue:  var(--accent);       --blue-lt:    var(--accent-fg);
      --magenta: var(--st-overrun); --magenta-lt: var(--st-overrun-fg);
      --purple: #8B5CF6;            --purple-lt:  #C4B5FD;
      --c-planned: var(--st-planned);   --c-planned-fg: var(--st-planned-fg);   --c-planned-bg: var(--st-planned-bg);
      --c-ready:   var(--st-ready);     --c-ready-fg:   var(--st-ready-fg);     --c-ready-bg:   var(--st-ready-bg);
      --c-calling: var(--st-calling);   --c-calling-fg: var(--st-calling-fg);   --c-calling-bg: var(--st-calling-bg);
      --c-live:    var(--st-live);      --c-live-fg:    var(--st-live-fg);      --c-live-bg:    var(--st-live-bg);
      --c-overrun: var(--st-overrun);   --c-overrun-fg: var(--st-overrun-fg);   --c-overrun-bg: var(--st-overrun-bg);
      --c-hold:    var(--st-hold);      --c-hold-fg:    var(--st-hold-fg);      --c-hold-bg:    var(--st-hold-bg);
      --c-ended:   var(--st-ended);     --c-ended-fg:   var(--st-ended-fg);     --c-ended-bg:   var(--st-ended-bg);
      --c-cancelled: var(--st-cancelled); --c-cancelled-fg: var(--st-cancelled-fg); --c-cancelled-bg: var(--st-cancelled-bg);
      --c-break:   var(--purple);
    }
```

- [ ] **Step 4: Status edges and badges.** Replace the rules under `/* Per-status card styles */` (`.sc.status-PLANNED` to `.sc.status-CANCELLED`) with:

```css
    /* Per-status card styles: the left edge always means status (spec 2.2) */
    .sc.status-PLANNED   { border-left-color: var(--st-planned); }
    .sc.status-READY     { border-left-color: var(--st-ready); }
    .sc.status-CALLING   { border-left-color: var(--st-calling); }
    .sc.status-LIVE      { border-color: var(--st-live-line); border-left: 4px solid var(--st-live); background: linear-gradient(135deg, var(--st-live-wash) 0%, var(--card) 60%); }
    .sc.status-OVERRUN   { border-color: var(--st-overrun-line); border-left: 4px solid var(--st-overrun); background: linear-gradient(135deg, var(--st-overrun-wash) 0%, var(--card) 60%); }
    .sc.status-HOLD      { border-left-color: var(--st-hold); border-left-style: dashed; }
    .sc.status-ENDED     { border-left-color: var(--st-ended); opacity: .6; }
    .sc.status-CANCELLED { border-left-color: var(--st-cancelled); background: transparent; opacity: .5; }
```

Replace the eight `.badge-<STATUS>` lines under `/* ── BADGES ── */` with:

```css
    .badge-PLANNED   { background: var(--st-planned-bg);   color: var(--st-planned-fg); }
    .badge-READY     { background: var(--st-ready-bg);     color: var(--st-ready-fg); }
    .badge-CALLING   { background: var(--st-calling-bg);   color: var(--st-calling-fg); }
    .badge-LIVE      { background: var(--st-live);         color: var(--on-solid); }
    .badge-OVERRUN   { background: var(--st-overrun);      color: var(--on-solid); }
    .badge-HOLD      { background: var(--st-hold);         color: var(--on-solid); }
    .badge-ENDED     { background: var(--st-ended-bg);     color: var(--st-ended-fg); }
    .badge-CANCELLED { background: var(--st-cancelled-bg); color: var(--st-cancelled-fg); }
```

Set `.prog-fill.ov { background: var(--st-overrun); }` and `.lt-remain.ov { color: var(--st-overrun-fg); }`. In `#header`, change `background: rgba(11,15,20,0.95);` to `background: var(--panel);` and `border-bottom: 1px solid rgba(148,163,184,0.10);` to `border-bottom: 1px solid var(--border-section);`. Replace the three `#bc-banner.<priority>` lines with:

```css
    #bc-banner.info     { background: var(--raised);        color: var(--accent-fg);   border-bottom: 1px solid var(--accent); }
    #bc-banner.warn     { background: var(--st-hold-bg);    color: var(--st-hold-fg);  border-bottom: 1px solid var(--st-hold-line); }
    #bc-banner.critical { background: var(--st-live-bg);    color: var(--st-live-fg);  border-bottom: 1px solid var(--st-live); }
```

Replace the ten `.le.le-*` colour lines with:

```css
    .le.le-state     { border-left-color: var(--st-ready); }
    .le.le-system    { border-left-color: var(--accent); }
    .le.le-error     { border-left-color: var(--st-live); }
    .le.le-broadcast { border-left-color: var(--st-hold); }
    .le.le-delay     { border-left-color: var(--st-overrun); }
    .le.le-state     .le-act { color: var(--st-ready-fg); }
    .le.le-system    .le-act { color: var(--accent-fg); }
    .le.le-error     .le-act { color: var(--st-live-fg); }
    .le.le-broadcast .le-act { color: var(--st-hold-fg); }
    .le.le-delay     .le-act { color: var(--st-overrun-fg); }
```

In the stage monitor rules: `.sm-status-live { … color: var(--st-live); … }` and `.sm-live-dot { … background: var(--st-live); box-shadow: none; animation: none; }`.

- [ ] **Step 5: One blue, one red.** Run once (not committed):

```js
// $SCRATCH/cd-one-blue-one-red.mjs
import fs from 'node:fs';
const FILE = process.argv[2];
const src = fs.readFileSync(FILE, 'utf8');
const rootEnd = src.indexOf('}', src.indexOf(':root {')) + 1;
const styleEnd = src.indexOf('</style>');
let css = src.slice(rootEnd, styleEnd);
let n = 0;
const rep = (re, fn) => { css = css.replace(re, (...m) => { n++; return fn(...m); }); };
rep(/rgba\(\s*59\s*,\s*130\s*,\s*246\s*,\s*([\d.]+)\s*\)/g, (_, a) => `rgba(37,99,235,${a})`);
rep(/rgba\(\s*255\s*,\s*59\s*,\s*48\s*,\s*([\d.]+)\s*\)/g, (_, a) => `rgba(239,68,68,${a})`);
rep(/#(1d4ed8|2563eb)(?![\w-])/gi, () => 'var(--accent)');
rep(/#(ef4444|dc2626)(?![\w-])/gi, () => 'var(--st-live)');
rep(/#1e3a5f(?![\w-])/gi, () => 'var(--raised)');            // active pill fills
rep(/#(1e293b|131c2c)(?![\w-])/gi, () => 'var(--overlay)');  // menus and the profile panel
fs.writeFileSync(FILE, src.slice(0, rootEnd) + css + src.slice(styleEnd));
console.log(`replaced ${n}`);
```

```bash
node "$SCRATCH/cd-one-blue-one-red.mjs" /Users/sheriff/AVE-Production-Console-redesign/cuedeck-console.html
```

Expected: `replaced` followed by a number above 0. (`$SCRATCH` is the session scratchpad directory; nothing from it is committed.)

- [ ] **Step 6: Lines, control boundaries, focus ring, motion.** Remove the `animation:` declarations from `.sc.status-LIVE`/`.sc.status-OVERRUN` (done by Step 4's replacement), and from `.badge-READY`, `.badge-LIVE`, `.badge-HOLD` (done by Step 4). Append at the very end of the `<style>` block (just above `</style>`):

```css
    /* ═══ Command center tokens: lines, controls, focus, motion (stage 1) ═══ */
    #sidebar, #filter-bar, #bc-bar { background: var(--panel); }
    #sidebar   { border-left-color: var(--border-section); }
    #filter-bar, .sb-section { border-bottom-color: var(--border-section); }
    #bc-bar    { border-top: 1px solid var(--border-section); backdrop-filter: none; }
    .sc        { border-color: var(--border-section); box-shadow: none; }
    /* Control boundaries at least 3:1, also on inline-styled inputs */
    input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), select, textarea {
      border-color: var(--border-control) !important;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--accent) !important; }
    .btn-grey, #help-btn, .log-export-btn, .bc-preset-btn, .fb-view-pill, #fb-clear, .smv-btn, .inv-btn,
    .sp-card-mgmt button, .sp-disp-actions button, .sp-override-btn,
    .ev-modal-actions button:not(.primary):not(.danger) { border-color: var(--border-control); }
    ::placeholder { color: var(--text-tertiary); opacity: 1; }
    /* One focus ring on every interactive element */
    :focus-visible { outline: none !important; box-shadow: var(--focus-ring) !important; }
    /* Only exceptions animate; nothing animates under reduced motion */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
```

- [ ] **Step 7: Timeline colours from CSS.** Add above `function renderTimeline()`:

```js
// Status colours live in :root (--st-<status>); JS never keeps its own copy.
function statusColor(status) {
  const css = getComputedStyle(document.documentElement);
  return css.getPropertyValue('--st-' + String(status || 'planned').toLowerCase()).trim()
      || css.getPropertyValue('--st-planned').trim();
}
```

In `renderTimeline()`, delete the `const STATUS_COLOR = { … };` block (with its comment line) and change `const col = STATUS_COLOR[sess.status] || '#6b7280';` to `const col = statusColor(sess.status);`.

- [ ] **Step 8: Display page.** In `cuedeck-display.html` change line 16 `:root { --brand: #3b82f6; }` to:

```css
:root { --brand: #3b82f6; --st-live: #EF4444; --st-ready: #34D399; --st-calling: #FACC15; --st-hold: #FB923C; --st-overrun: #E879F9; }
```

and make these exact replacements (status meaning only; the remaining-time colours green/amber/red of the presenter timer stay):

| Old | New |
|---|---|
| `.d-header-status.live{color:#ef4444}` | `.d-header-status.live{color:var(--st-live)}` |
| `.d-header-status.ready{color:#fbbf24}` | `.d-header-status.ready{color:var(--st-ready)}` |
| `.sc-tag.live .sc-tag-dot{background:#ef4444;box-shadow:0 0 12px #ef4444;animation:blink .9s infinite}` | `.sc-tag.live .sc-tag-dot{background:var(--st-live);box-shadow:0 0 12px var(--st-live);animation:blink .9s infinite}` |
| `.sc-tag.live{color:#ef4444}` | `.sc-tag.live{color:var(--st-live)}` |
| `.sc-tag.ready .sc-tag-dot{background:#fbbf24}` | `.sc-tag.ready .sc-tag-dot{background:var(--st-ready)}` |
| `.sc-tag.ready{color:#fbbf24}` | `.sc-tag.ready{color:var(--st-ready)}` |
| `.wf-status.READY{background:rgba(251,191,36,.1);color:#fbbf24}` | `.wf-status.READY{background:rgba(52,211,153,.16);color:var(--st-ready)}` |
| `.ag-card.live .ag-badge{color:#22c55e}` | `.ag-card.live .ag-badge{color:var(--st-live)}` |
| `.tl-badge.live{background:rgba(34,197,94,.15);color:#22c55e}` | `.tl-badge.live{background:rgba(239,68,68,.16);color:var(--st-live)}` |
| `.pg-cell-badge.live{color:#22c55e}` | `.pg-cell-badge.live{color:var(--st-live)}` |
| `.st-status.live{color:#22c55e}` | `.st-status.live{color:var(--st-live)}` |
| `.st-status.hold{color:#f97316}` | `.st-status.hold{color:var(--st-hold)}` |
| `.st-status.overrun{color:#ef4444}` | `.st-status.overrun{color:var(--st-overrun)}` |

In the two stage-timer colour functions (around lines 906 and 1393), change the overrun branch `ov2 ? '#ef4444'` / `ov ? '#ef4444'` to `'#E879F9'` and the hold branch `isHold2 ? '#f97316'` / `isHold ? '#f97316'` to `'#FB923C'`.

- [ ] **Step 9: Run the tests.**

```bash
npx vitest run
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-tokens.spec.ts
```

Expected: vitest all pass except the ratchet's "kept tight" test, which now reports the new count; set `BUDGET` to the printed count. The tokens e2e: 5 passed.

- [ ] **Step 10: Update and review the baselines.** This is the deliberate palette change.

```bash
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-visual.spec.ts --update-snapshots
git diff --stat tests/e2e/__screenshots__
```

Open all 12 PNGs. Check: card outlines and bar lines visible; inputs have visible edges; status colours match the table; HOLD amber, CALLING yellow (no longer the same); LIVE red badge with dark text; no pulsing frames. Then run the full console suite (`npx playwright test -c playwright.console.config.ts`) and expect `0 failed`.

- [ ] **Step 11: Commit in three commits** (display page separately so it can be reverted alone):

```bash
git add tests/console-status-palette.spec.ts tests/e2e/console-tokens.spec.ts tests/e2e/console-boot-mock.ts tests/console-colour-ratchet.spec.ts cuedeck-console.html
git commit -m "feat(console): new palette, status set, control borders, focus ring, motion rule

Section lines 1.79 to 1.87:1, control edges 3.3:1, meta text 6.5:1, worst
status pair dE 21.3 (normal, protan, deutan). Timeline colours from CSS.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- tests/console-status-palette.spec.ts tests/e2e/console-tokens.spec.ts tests/e2e/console-boot-mock.ts tests/console-colour-ratchet.spec.ts cuedeck-console.html
git add tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "test(console): baselines for the stage 1 palette

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- tests/e2e/__screenshots__/console-visual.spec.ts
git add tests/display-status-tokens.spec.ts cuedeck-display.html
git commit -m "feat(display): status colours follow the console status tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- tests/display-status-tokens.spec.ts cuedeck-display.html
```

### Task 1.3: Type floor and scale

**Files:**
- Modify: `cuedeck-console.html` `<style>` block (all `font-size` declarations) and inline `font-size` values in HTML and script templates; `#hdr-clock` rule (line 478).
- Modify: `tests/e2e/console-tokens.spec.ts`.
- Update: all 12 PNG baselines.

**Interfaces:**
- Consumes: `--fs-*`, `--fs-clock`, `--font-sans` from Task 1.2.
- Produces: no text under 11 px anywhere in the console chrome (later tasks write only scale sizes).

- [ ] **Step 1: Failing test.** Append to `tests/e2e/console-tokens.spec.ts`:

```ts
test('type: no visible console text is smaller than 11 px', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const tooSmall = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('svg, script, style, #stage-monitor, #loading-overlay')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const px = parseFloat(cs.fontSize);
      if (px < 11) out.push(`${el.tagName.toLowerCase()}.${el.className} ${px}px "${n.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  expect(tooSmall).toEqual([]);
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure.** `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-tokens.spec.ts -g "type:"`. Expected: a list of 9 px and 10 px elements (`.tl`, `.sb-title`, `.ctx-sub`, `.pr-role`, `.le`, `#fb-count`, …).

- [ ] **Step 3: Apply the scale.** Run once (not committed):

```js
// $SCRATCH/cd-type-scale.mjs
import fs from 'node:fs';
const FILE = process.argv[2];
const src = fs.readFileSync(FILE, 'utf8');
const rootEnd = src.indexOf('}', src.indexOf(':root {')) + 1;
const styleEnd = src.indexOf('</style>');
const SCALE = { 8: 11, 9: 11, 10: 11, 11: 11, 12: 12, 13: 13, 14: 14, 15: 14, 16: 16, 17: 16, 18: 16, 20: 20, 22: 20, 24: 20, 28: 28 };
let css = src.slice(rootEnd, styleEnd).split('\n').map(line => {
  const monitor = /(^|[\s,])[#.]sm-|#stage-monitor/.test(line);
  return line
    .replace(/font-size:\s*(\d+)px/g, (m, px) => {
      const v = +px;
      if (monitor) return v < 11 ? 'font-size: var(--fs-11)' : m;   // stage monitor keeps its layout, floor only
      return SCALE[v] ? `font-size: var(--fs-${SCALE[v]})` : m;
    })
    .replace(/font:\s*(\d{3}\s+)?(\d+)px/g, (m, w, px) => (+px < 11 ? `font: ${w || ''}11px` : m));
}).join('\n');
// Inline styles and script templates: floor only.
const after = src.slice(styleEnd).replace(/font-size:\s*(8|9|10)px/g, 'font-size:11px');
fs.writeFileSync(FILE, src.slice(0, rootEnd) + css + after);
console.log('done');
```

```bash
node "$SCRATCH/cd-type-scale.mjs" /Users/sheriff/AVE-Production-Console-redesign/cuedeck-console.html
```

Then set `#hdr-clock { font-size: var(--fs-clock); font-weight: 700; letter-spacing: var(--ls-big); color: var(--text-primary); min-width: 100px; text-align: right; font-variant-numeric: tabular-nums; }` and add to the stage 1 block at the end of `<style>`:

```css
    body { font-family: var(--font-sans); }
    .tv, .lt-remain, .lt-elapsed, .le-ts, .ck-val, #hdr-clock { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Run the tests.** `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-tokens.spec.ts`. Expected: 6 passed. If an element still reports under 11 px, it comes from an inline style the floor regex missed (for example `font-size: .7em`); change that value to `font-size:11px` by hand.

- [ ] **Step 5: Baselines.** `--update-snapshots` on `console-visual.spec.ts`, review the 12 PNGs (no clipped labels, header still one row at 1280), then the full console suite: `0 failed`.

- [ ] **Step 6: Commit.**

```bash
git add cuedeck-console.html tests/e2e/console-tokens.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): type floor of 11 px and the eight-size scale

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html tests/e2e/console-tokens.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 1.4: Release stage 1

**Files:** none changed. **Interfaces:** Consumes `redesign/stage-1`. Produces `main` with stage 1, live on app.cuedeck.io.

- [ ] **Step 1: Freeze check.** `date`. No release task starts after 18:00 on 10 Oct; a stage not live-checked by 21:00 on 10 Oct waits until after GTR; nothing is pushed on 11 Oct.
- [ ] **Step 2: Before captures** (for the note), from the previous release SHA:

```bash
PREV=$(git -C /Users/sheriff/AVE-Production-Console rev-parse cuedeck/main)
git -C /Users/sheriff/AVE-Production-Console worktree add --detach /Users/sheriff/AVE-Production-Console-before "$PREV"
ln -s /Users/sheriff/AVE-Production-Console/node_modules /Users/sheriff/AVE-Production-Console-before/node_modules
(python3 -m http.server 7292 --bind 127.0.0.1 --directory /Users/sheriff/AVE-Production-Console-before >/dev/null 2>&1 &)
cd /Users/sheriff/AVE-Production-Console-redesign
CONSOLE_BASE=http://127.0.0.1:7292 CONSOLE_DSF=2 CONSOLE_NOTES_DIR="$SCRATCH/notes/stage-1/before" npx playwright test -c playwright.console.config.ts tests/e2e/console-visual.spec.ts
```

- [ ] **Step 3: Review the stage before it merges** (spec section 6: every stage gets a review). Run the house `diff-review` skill with `{range: "main..redesign/stage-1", repo: "/Users/sheriff/AVE-Production-Console-redesign"}`, or superpowers:requesting-code-review on the same range. Fix every finding on the stage branch (new commits, tests first) before going on; a finding that is out of scope for this plan goes in the note to Sherif.
- [ ] **Step 4: Integrate and merge.** Same as Task 0.2 Steps 2 and 3 with `redesign/stage-1`.
- [ ] **Step 5: Full tests on the merged tip.** `npx vitest run` all pass; `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts` with `0 failed`.
- [ ] **Step 6: What will be pushed.** `git log --oneline cuedeck/main..main` and `origin/main..main` list only the Task 1.1 to 1.3 commits. Anything else: stop and ask.
- [ ] **Step 7: Push.** `git push cuedeck main && git push origin main`; both range checks then print nothing. `SHA=$(git -C /Users/sheriff/AVE-Production-Console rev-parse main)`.
- [ ] **Step 8: CI and live.** CI for the pushed SHA exists and passed on every repo where the `CI` workflow is active (as in Task 0.2 Step 7; a missing run is not a pass). Deployment for the SHA is `READY` in Vercel project `cuedeck-console`. Then:

```bash
curl -s https://app.cuedeck.io/ | grep -o "border-control: rgba(203,213,225,.44)" | head -1
```

Expected: the string. Open https://app.cuedeck.io in Chrome (`open -a "Google Chrome" https://app.cuedeck.io`), hard reload, and check by eye on Sherif's signed-in session without pressing any show control: lines between bars and cards visible, inputs with clear edges, HOLD amber and CALLING yellow, the signage display (`/display`) still loads.
- [ ] **Step 9: After captures and note.** `CONSOLE_DSF=2 CONSOLE_NOTES_DIR="$SCRATCH/notes/stage-1/after"` on the worktree. Send Sherif: "Stage 1 (lines and colour) is live on app.cuedeck.io." plus the before/after pairs for `director-1440`, `overrun-1440` and `director-1280`, shown as images. Remove the before worktree: `git -C /Users/sheriff/AVE-Production-Console worktree remove /Users/sheriff/AVE-Production-Console-before`.

---

# Stage 2: Components

Task 2.1 runs right after stage 1 (branch `redesign/stage-3`, because it ships with stage 3). Tasks 2.2 and 2.3 run after stage 4 on branch `redesign/stage-2`, and they assume stages 3 and 4 are merged.

### Task 2.1: Primitives: button, badge, chip, section label, status pill, icon sprite

**Files:**
- Modify: `cuedeck-console.html`:
  - `<style>`: the `/* Action buttons */` block (`.sc-actions` to `.delay-grp .dl`, lines 676-701), the `/* ── BADGES ── */` block (612-625), and a new block `/* ═══ Command center components (stage 2) ═══ */` appended after the stage 1 block;
  - HTML: the SVG sprite inserted right after `<body>` (line 1712), batch bar buttons (1734-1737), undo button (1722);
  - JS: a new section `// ═══ COMMAND CENTER: shared view helpers ═══` inserted immediately above the `// RENDERING` comment block that precedes `function renderSessions()`; `getBtnCfg()` (2670-2680); `buildButtons()` (3958-4016); `cbtn` inside `buildCtxPanel()` (4060); `cardHTML()` badge span (3870).
- Modify: `tests/console-colour-ratchet.spec.ts` (budget), `tests/e2e/auth-flows.spec.ts` (lines 398, 413, 429).
- Create: `tests/e2e/console-components.spec.ts`.

**Interfaces:**
- Produces CSS classes: `.btn` with sizes `.sm .md .lg`, variants `.primary`, `.fwd .fwd-ready .fwd-calling .fwd-go`, `.hold`, `.ghost`, `.danger`, `.icon-only`, state `.confirm-pending`; `.act-gap` (20 px gap with a divider); `.badge` + `.badge-<STATUS>`; `.chip`, `.chip-room`, `.chip-type`; `.lbl`; `.pill`, `.pill .dot`, `.pill.is-ok .is-warn .is-err`; `.ico`.
- Produces JS (used by 3.x, 4.x, 5.x): `tf(key, vars)`, `icon(name, cls)`, `statusBadge(status)`, `chipHTML(kind, text)`, `hm(v)`, `tsHM(ts)`, `sessionSpan(s)`, `FINISHED`.
- Produces sprite symbols `#i-<name>` for: mic, rec, stream, globe, remote, note, anchor, clock, timer, alert, monitor, broadcast, team, user, report, pause, play, check, x, chev-right, chev-down, chev-left, arrow-up, arrow-down, search, edit, plus, upload, download, room, tag, help, keyboard, book, message, mail, info, sparkle, card, logout, menu, more, list, calendar, coffee, bell, star, grid, wifi, link, trash, eye, door, refresh, checkin.
- Legacy aliases kept: `.abtn`, `.btn-blue`, `.btn-green`, `.btn-red`, `.btn-amber`, `.btn-grey`, `.btn-purple` (restyled to the new look) so untouched markup keeps working.

- [ ] **Step 1: Failing component test.** Create `tests/e2e/console-components.spec.ts`:

```ts
// tests/e2e/console-components.spec.ts
// Component spec (section 3): sizes, variants, badge recipe, chip, label,
// pill, and that every icon reference resolves to a sprite symbol.
import { test, expect, type Page } from '@playwright/test';
import { openConsole, evalPage, PANEL_ID } from './console-boot-mock';

async function mount(page: Page, html: string) {
  await page.evaluate((h) => { const d = document.createElement('div'); d.id = 'cmp-probe'; d.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;display:flex;gap:8px;padding:8px;background:var(--bg)'; d.innerHTML = h; document.body.append(d); }, html);
}
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate(el => {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  return { h: Math.round(r.height), radius: cs.borderTopLeftRadius, size: cs.fontSize, weight: cs.fontWeight, tt: cs.textTransform, filter: cs.filter, anim: cs.animationName, bg: cs.backgroundColor, border: cs.borderTopColor };
});

test('components: button sizes and variants', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await mount(page, `<button class="btn sm" id="b-sm">Sm</button><button class="btn md" id="b-md">Md</button><button class="btn lg" id="b-lg">Lg</button>
    <button class="btn md danger" id="b-dg">End…</button><button class="btn md hold" id="b-hd">Hold</button><button class="btn md fwd fwd-ready" id="b-fw">Set ready</button>
    <button class="btn md fwd fwd-go" id="b-go">On stage</button><button class="btn md fwd fwd-calling" id="b-cl">Call speaker</button><button class="btn md danger confirm-pending" id="b-ar">Press again to end</button>`);
  expect((await box(page, '#b-sm')).h).toBe(28);
  expect((await box(page, '#b-md')).h).toBe(32);
  expect((await box(page, '#b-lg')).h).toBe(40);
  expect((await box(page, '#b-md')).radius).toBe('8px');
  const dg = await box(page, '#b-dg');
  expect(dg.bg).toBe('rgba(0, 0, 0, 0)');          // danger is outlined
  expect(dg.border).toBe('rgba(239, 68, 68, 0.75)');
  expect((await box(page, '#b-hd')).bg).toBe('rgb(251, 146, 60)');
  expect((await box(page, '#b-fw')).bg).toBe('rgb(52, 211, 153)');
  expect((await box(page, '#b-go')).bg).toBe('rgb(52, 211, 153)');   // On stage is green, never red
  expect((await box(page, '#b-cl')).bg).toBe('rgb(250, 204, 21)');
  expect((await box(page, '#b-ar')).bg).toBe('rgb(239, 68, 68)');    // solid red only when armed
  await page.hover('#b-md');
  expect((await box(page, '#b-md')).filter).toBe('none');  // no brightness filter on hover
  await ctx.close();
});

test('components: buttons grow on a coarse pointer', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { touch: true, viewport: { width: 1280, height: 800 } });
  await mount(page, `<button class="btn sm" id="b-sm">Sm</button><button class="btn md" id="b-md">Md</button><button class="btn lg" id="b-lg">Lg</button>`);
  expect((await box(page, '#b-sm')).h).toBe(40);
  expect((await box(page, '#b-md')).h).toBe(44);
  expect((await box(page, '#b-lg')).h).toBe(48);
  await ctx.close();
});

test('components: badge recipe per status', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await mount(page, await page.evaluate(() => ['PLANNED', 'READY', 'CALLING', 'LIVE', 'OVERRUN', 'HOLD', 'ENDED', 'CANCELLED'].map(s => (0, eval)(`statusBadge('${s}')`)).join('')));
  const live = await box(page, '#cmp-probe .badge-LIVE');
  expect(live.h).toBe(22);
  expect(live.radius).toBe('6px');
  expect(live.size).toBe('11px');
  expect(live.weight).toBe('700');
  expect(live.tt).toBe('uppercase');
  expect(await page.locator('#cmp-probe .badge-LIVE').evaluate(el => getComputedStyle(el, '::before').content)).toBe('""');
  expect(await page.locator('#cmp-probe .badge-HOLD use').getAttribute('href')).toBe('#i-pause');
  expect((await box(page, '#cmp-probe .badge-HOLD')).anim).toBe('none');
  expect((await box(page, '#cmp-probe .badge-CALLING')).anim).toBe('badge-ring');
  expect(await page.locator('#cmp-probe .badge-CANCELLED').evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('line-through');
  await ctx.close();
});

test('components: chip, section label and pill', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await mount(page, await page.evaluate(() => (0, eval)(`chipHTML('room','Main Stage') + chipHTML('type','Panel')`)) + '<span class="lbl" id="l1">Event log</span><span class="pill is-ok" id="p1"><span class="dot"></span>All systems</span>');
  const chip = await box(page, '#cmp-probe .chip-room');
  expect(chip.h).toBe(22);
  expect(chip.radius).toBe('4px');
  expect(await page.locator('#cmp-probe .chip-room use').getAttribute('href')).toBe('#i-room');
  expect(await page.locator('#cmp-probe .chip-type use').getAttribute('href')).toBe('#i-tag');
  const lbl = await box(page, '#l1');
  expect([lbl.size, lbl.weight, lbl.tt]).toEqual(['11px', '700', 'uppercase']);
  expect((await box(page, '#p1')).radius).toBe('999px');
  await ctx.close();
});

test('components: every icon reference resolves to a sprite symbol', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const missing = await page.evaluate(() => [...document.querySelectorAll('use')]
    .map(u => u.getAttribute('href') || '')
    .filter(h => h.startsWith('#i-') && !document.querySelector(h)));
  expect(missing).toEqual([]);
  await ctx.close();
});

test('components: HOLD sits left of END, END is outlined and separated', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const html = await evalPage(page, `buildButtons(S.sessions.find(x => x.id === '${PANEL_ID}'))`);
  const order = await page.evaluate((h) => { const d = document.createElement('div'); d.innerHTML = h as string;
    return [...d.querySelectorAll('button, .act-gap')].map(b => b.classList.contains('act-gap') ? 'gap' : (b.classList.contains('hold') ? 'hold' : b.classList.contains('danger') ? 'end' : 'other')); }, html);
  expect(order.slice(0, 3)).toEqual(['hold', 'gap', 'end']);
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure.** `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-components.spec.ts`. Expected: 6 failed (`.btn` has no height rules; `statusBadge is not defined`; `chipHTML is not defined`; `act-gap` absent).

- [ ] **Step 3: Sprite.** Insert immediately after `<body>`:

```html
<!-- ICON SPRITE (16 px line set, stroke currentColor) -->
<svg id="cd-icons" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/></symbol>
  <symbol id="i-rec" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></symbol>
  <symbol id="i-stream" viewBox="0 0 24 24"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4M2 20h.01"/></symbol>
  <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></symbol>
  <symbol id="i-remote" viewBox="0 0 24 24"><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/></symbol>
  <symbol id="i-note" viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></symbol>
  <symbol id="i-anchor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="3"/><path d="M12 22V8M5 12H2a10 10 0 0 0 20 0h-3"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></symbol>
  <symbol id="i-timer" viewBox="0 0 24 24"><circle cx="12" cy="14" r="8"/><path d="M12 10v4l2 2M9 2h6M12 2v4"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/></symbol>
  <symbol id="i-monitor" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></symbol>
  <symbol id="i-broadcast" viewBox="0 0 24 24"><path d="m3 11 18-5v12L3 14v-3zM11.6 16.8a3 3 0 1 1-5.8-1.6"/></symbol>
  <symbol id="i-team" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M22 21v-2a4 4 0 0 0-3-3.9"/></symbol>
  <symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></symbol>
  <symbol id="i-report" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/></symbol>
  <symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></symbol>
  <symbol id="i-play" viewBox="0 0 24 24"><path d="m6 4 14 8-14 8z"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
  <symbol id="i-chev-right" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></symbol>
  <symbol id="i-chev-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="i-chev-left" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></symbol>
  <symbol id="i-arrow-up" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></symbol>
  <symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-upload" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></symbol>
  <symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></symbol>
  <symbol id="i-room" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></symbol>
  <symbol id="i-tag" viewBox="0 0 24 24"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/></symbol>
  <symbol id="i-help" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></symbol>
  <symbol id="i-keyboard" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></symbol>
  <symbol id="i-book" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></symbol>
  <symbol id="i-message" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></symbol>
  <symbol id="i-mail" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></symbol>
  <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></symbol>
  <symbol id="i-sparkle" viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></symbol>
  <symbol id="i-card" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></symbol>
  <symbol id="i-logout" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></symbol>
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></symbol>
  <symbol id="i-more" viewBox="0 0 24 24"><path d="M12 12h.01M19 12h.01M5 12h.01"/></symbol>
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></symbol>
  <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></symbol>
  <symbol id="i-coffee" viewBox="0 0 24 24"><path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 2v2M10 2v2M14 2v2"/></symbol>
  <symbol id="i-bell" viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/></symbol>
  <symbol id="i-star" viewBox="0 0 24 24"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></symbol>
  <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></symbol>
  <symbol id="i-wifi" viewBox="0 0 24 24"><path d="M12 20h.01M2 8.8a15 15 0 0 1 20 0M5 12.9a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0"/></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></symbol>
  <symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></symbol>
  <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></symbol>
  <symbol id="i-door" viewBox="0 0 24 24"><path d="M3 21h18M6 21V3h12v18M14 12h.01"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></symbol>
  <symbol id="i-checkin" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></symbol>
</svg>
```

- [ ] **Step 4: Shared helpers.** Insert immediately above the `// RENDERING` comment block that precedes `function renderSessions()`:

```js
// ═══════════════════════════════════════════════════
// COMMAND CENTER: shared view helpers (redesign, stage 2)
// ═══════════════════════════════════════════════════
const FINISHED = ['ENDED', 'CANCELLED'];

// t() with {placeholders}: tf('cc.list.completed', { n: 3 })
function tf(key, vars = {}) {
  return t(key).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}
function icon(name, cls = '') {
  return `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}
function statusBadge(status) {
  return `<span class="badge badge-${status}">${status === 'HOLD' ? icon('pause') : ''}${esc(t('status.' + status))}</span>`;
}
function chipHTML(kind, text) {
  return `<span class="chip chip-${kind}">${icon(kind === 'room' ? 'room' : 'tag')}<span class="chip-txt">${esc(text)}</span></span>`;
}
// Times are HH:MM everywhere except running timers and the header clock.
function hm(v) { return v ? String(v).slice(0, 5) : '–'; }
function sessionSpan(s) { return `${hm(s.scheduled_start)}–${hm(s.scheduled_end)}`; }
// A timestamp shown as HH:MM in the event's own time zone.
function tsHM(ts) {
  if (!ts) return '–';
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: S.event?.timezone || undefined }).format(new Date(ts));
  } catch { return new Date(ts).toTimeString().slice(0, 5); }
}
```

- [ ] **Step 5: Component CSS.** Replace the `/* Action buttons */` block (from `.sc-actions {` through `.delay-grp .dl { … }`) with:

```css
    /* Action buttons (legacy markup; new markup uses .btn) */
    .sc-actions { padding: 8px 16px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .delay-grp  { margin-left: auto; display: flex; gap: 4px; align-items: center; }
    .delay-grp .dl { font-size: var(--fs-11); font-weight: 700; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-tertiary); }
```

Replace the `.badge { … }` rule and the eight `.badge-*` lines with:

```css
    .badge {
      display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px;
      border-radius: var(--r-badge); border: 1px solid transparent;
      font: 700 var(--fs-11)/1 var(--font-sans); letter-spacing: var(--ls-badge); text-transform: uppercase;
      white-space: nowrap; flex-shrink: 0; animation: none;
    }
    .badge .ico { width: 12px; height: 12px; stroke-width: 2.5; }
    .badge-PLANNED   { background: var(--st-planned-bg);   color: var(--st-planned-fg); }
    .badge-READY     { background: var(--st-ready-bg);     color: var(--st-ready-fg); }
    .badge-CALLING   { background: var(--st-calling-bg);   color: var(--st-calling-fg); animation: badge-ring 1.6s ease-out infinite; }
    .badge-LIVE      { background: var(--st-live);         color: var(--on-solid); }
    .badge-LIVE::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .badge-OVERRUN   { background: var(--st-overrun);      color: var(--on-solid); }
    .badge-HOLD      { background: var(--st-hold);         color: var(--on-solid); }
    .badge-ENDED     { background: var(--st-ended-bg);     color: var(--st-ended-fg); }
    .badge-CANCELLED { background: transparent; color: var(--st-cancelled-fg); border-color: var(--st-cancelled-line); text-decoration: line-through; }
    @keyframes badge-ring { 0% { box-shadow: 0 0 0 0 var(--st-calling-line); } 100% { box-shadow: 0 0 0 6px transparent; } }
```

Append after the stage 1 block at the end of `<style>`:

```css
    /* ═══ Command center components (stage 2) ═══ */
    .ico { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; vertical-align: -3px; }
    .btn, .abtn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: var(--btn-md); padding: 0 12px; border-radius: var(--r-ctl);
      font: 600 var(--fs-13)/1 var(--font-sans); letter-spacing: 0; text-transform: none; white-space: nowrap;
      background: var(--raised); border: 1px solid var(--border-control); color: var(--text-primary);
      cursor: pointer; transition: background-color .12s, border-color .12s; filter: none;
    }
    .btn.sm, .abtn.abtn-sm { height: var(--btn-sm); padding: 0 10px; font-size: var(--fs-12); }
    .btn.md { height: var(--btn-md); }
    .btn.lg { height: var(--btn-lg); padding: 0 16px; font-size: var(--fs-14); }
    .btn.icon-only { width: var(--btn-md); padding: 0; }
    .btn.sm.icon-only { width: var(--btn-sm); }
    .btn:hover, .abtn:hover { background: var(--overlay); filter: none; }
    .btn:active, .abtn:active { transform: translateY(1px); }
    .btn:disabled, .abtn:disabled { opacity: .4; cursor: not-allowed; }
    .btn.primary, .btn.btn-blue, .abtn.btn-blue { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .btn.primary:hover, .btn.btn-blue:hover, .abtn.btn-blue:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .btn.fwd, .btn.hold { color: var(--on-solid); }
    .btn.fwd-ready, .btn.btn-green, .abtn.btn-green { background: var(--st-ready); border-color: var(--st-ready); color: var(--on-solid); }
    .btn.fwd-calling { background: var(--st-calling); border-color: var(--st-calling); }
    .btn.fwd-go      { background: var(--st-ready);   border-color: var(--st-ready); }   /* On stage, Go live, Resume: green, never red */
    .btn.hold        { background: var(--st-hold);    border-color: var(--st-hold); }
    .btn.fwd:hover, .btn.hold:hover, .btn.btn-green:hover, .abtn.btn-green:hover { box-shadow: inset 0 0 0 999px var(--hover-veil); }
    .btn.fwd-ready:hover { background: var(--st-ready); } .btn.fwd-calling:hover { background: var(--st-calling); }
    .btn.fwd-go:hover { background: var(--st-ready); }   .btn.hold:hover { background: var(--st-hold); }
    .btn.ghost { background: transparent; border-color: transparent; color: var(--text-secondary); }
    .btn.ghost:hover { background: var(--raised); color: var(--text-primary); }
    .btn.danger, .btn.btn-red, .abtn.btn-red { background: transparent; border-color: var(--danger-line); color: var(--danger-fg); }
    .btn.danger:hover, .btn.btn-red:hover, .abtn.btn-red:hover { background: var(--st-live-bg); }
    .btn.btn-amber, .abtn.btn-amber { background: var(--st-hold-bg); border-color: var(--st-hold-line); color: var(--st-hold-fg); }
    .btn.btn-grey, .abtn.btn-grey { background: var(--raised); border-color: var(--border-control); color: var(--text-primary); }
    .btn.btn-purple, .abtn.btn-purple { background: var(--raised); border-color: var(--border-control); color: var(--purple-lt); }
    .btn.confirm-pending, .abtn.confirm-pending, .ctx-btn.confirm-pending {
      background: var(--st-live); border-color: var(--st-live); color: var(--on-solid); animation: none;
    }
    .act-gap { display: inline-block; width: 20px; height: 24px; border-left: 1px solid var(--border-divider); margin-left: 12px; flex: none; }
    @media (pointer: coarse) {
      .btn.sm, .abtn.abtn-sm { height: 40px; } .btn, .btn.md, .abtn { height: 44px; } .btn.lg { height: 48px; }
      .btn.icon-only { width: 44px; } .btn.sm.icon-only { width: 40px; }
    }
    .chip {
      display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; max-width: 100%;
      border-radius: var(--r-chip); border: 1px solid var(--border-divider); background: transparent;
      color: var(--text-secondary); font-size: var(--fs-12); white-space: nowrap;
    }
    .chip .ico { width: 12px; height: 12px; }
    .chip-txt { overflow: hidden; text-overflow: ellipsis; }
    .lbl, .sb-title, .ctx-section-lbl, .sp-section-title, #sess-modal .smv-sec-title, .tl {
      font: 700 var(--fs-11)/1.3 var(--font-sans); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-tertiary);
    }
    .pill {
      display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
      border-radius: var(--r-pill); border: 1px solid var(--border-control); background: var(--card);
      color: var(--text-secondary); font: 500 var(--fs-12)/1 var(--font-sans); white-space: nowrap; cursor: pointer;
    }
    .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--st-planned); flex: none; }
    .pill.is-ok   .dot { background: var(--st-ready); }
    .pill.is-warn { border-color: var(--st-hold-line); color: var(--st-hold-fg); }   .pill.is-warn .dot { background: var(--st-hold); }
    .pill.is-err  { border-color: var(--st-live-line); color: var(--st-live-fg); }   .pill.is-err  .dot { background: var(--st-live); animation: conn-lost 1s ease-in-out infinite; }
    @keyframes conn-lost { 50% { opacity: .35; } }
```

- [ ] **Step 6: Buttons follow the action colour rule.** Replace `getBtnCfg()`:

```js
function getBtnCfg() {
  return {
    LIVE:      { label: t('btn.goLive'),      cls: 'fwd fwd-go' },
    READY:     { label: t('btn.setReady'),    cls: 'fwd fwd-ready' },
    CALLING:   { label: t('btn.callSpeaker'), cls: 'fwd fwd-calling' },
    HOLD:      { label: t('btn.hold'),        cls: 'hold' },
    ENDED:     { label: t('btn.endSession'),  cls: 'danger' },
    PLANNED:   { label: t('btn.deArm'),       cls: '' },
    CANCELLED: { label: t('btn.cancel'),      cls: 'danger' },
  };
}
```

In `buildButtons(s)`: in every button template change `class="abtn ${cfg.cls}"` to `class="btn md ${cfg.cls}"` and the fallback `{ label: to, cls: 'btn-blue' }` to `{ label: to, cls: '' }`; prefix the END button with the gap, so its template reads `` `<span class="act-gap" aria-hidden="true"></span><button class="btn md ${cfg.cls}…` `` (keep whatever armed-state attributes the safety branch added); change the arrive, restart, delay and nudge buttons from `abtn btn-*` to `btn sm` (keep `data-restart` and every `onclick`). In `buildCtxPanel()`, change `cbtn` to:

```js
  const cbtn = (label, cls, action, ico = '') =>
    `<button class="btn md ctx-btn ${cls}" onclick="${action}">${ico ? icon(ico) : ''}${label}</button>`;
```

and its icon arguments `'⊡'`, `'⏱'`, `'⏸'`, `'📢'`, `'☕'` to `'monitor'`, `'timer'`, `'pause'`, `'broadcast'`, `'coffee'` (the label strings with emoji inside them are Task 2.3's). In `cardHTML()`, change `<span class="badge badge-${s.status}">${t('status.' + s.status)}</span>` to `${statusBadge(s.status)}`. In the batch bar markup: `SET READY` button `class="btn sm fwd fwd-ready"`, `END ALL` and `CANCEL ALL` `class="btn sm danger"`, `Clear` `class="btn sm ghost"`. Undo button: `class="btn sm"` and remove its inline `style`.

- [ ] **Step 7: Tests that select on the old classes (same commit).** In `tests/e2e/auth-flows.spec.ts`:
  - line 398: `await page.locator('.abtn.btn-green:has-text("GO LIVE")').first().click();` becomes `await page.locator('button.fwd-go:has-text("Go live")').first().click();`
  - line 413: `const holdBtn = page.locator('.abtn.btn-red:has-text("HOLD")');` becomes `const holdBtn = page.locator('button.hold:has-text("Hold")');`
  - line 429: `const delay5 = page.locator('.abtn.btn-amber:has-text("5")');` becomes `const delay5 = page.locator('button[onclick*="applyDelay"]:has-text("5")');`

- [ ] **Step 8: Run.**

```bash
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-components.spec.ts tests/e2e/console-confirm.spec.ts tests/e2e/console-restart.spec.ts
npx vitest run tests/console-colour-ratchet.spec.ts
```

Expected: components 6 passed, confirm 2 passed, restart all passed. Set `BUDGET` to the printed count.

- [ ] **Step 9: Baselines.** `--update-snapshots` on `console-visual.spec.ts`; review: buttons 32 px with 8 px radius, End outlined, Hold solid amber with a gap before End, badges 22 px. Full console suite: `0 failed`.

- [ ] **Step 10: Commit, one commit per component** (spec stage 2): stage the hunks with `git add -p cuedeck-console.html` per component and commit each with an explicit pathspec:

```bash
git add -p cuedeck-console.html   # sprite + helpers only
git commit -m "feat(console): icon sprite and shared view helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html
git add -p cuedeck-console.html   # .btn, getBtnCfg, buildButtons, cbtn, batch and undo
git add tests/e2e/auth-flows.spec.ts
git commit -m "feat(console): button component; actions follow the action colour rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html tests/e2e/auth-flows.spec.ts
git add cuedeck-console.html tests/e2e/console-components.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): badge, chip, section label and status pill components

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html tests/e2e/console-components.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 2.2: Inputs and selects, modals, toasts

Runs after Task 4.4 on branch `redesign/stage-2`.

**Files:**
- Modify: `cuedeck-console.html`: `<style>` rules `#login-form input`, `#register-form input`, `#reset-form input` (lines ~131-178), `#fb-search`, `#fb-status,#fb-room` (filter bar rules), `#bc-input`, `#bc-pri`, `.ev-modal-backdrop`, `.ev-modal-card`, `.ev-modal-card input,.ev-modal-card select`, `.ev-modal-actions button*`, `.wiz-body input`, `#toast-container`, `.toast*`; the stage 1 control-boundary block (remove its `!important` lines); every `.ev-modal-card` element (17 modals, listed in Step 4); the Escape branch of the `keydown` handler (line ~3394); `pushToast()` (line ~5280).
- Modify: `tests/e2e/console-components.spec.ts`, `tests/console-colour-ratchet.spec.ts`.

**Interfaces:**
- Consumes: `.btn`, `icon()`, tokens.
- Produces: `.field` input recipe; modal manager `initModalManager()` with `trapFocus` behaviour (focus moves into an opened `.ev-modal-backdrop`, Tab cycles inside, focus returns on close); generic Escape (`openModal.click()`); toast container `aria-live="polite"`, error toasts `role="alert"` and 8 s.

- [ ] **Step 1: Failing tests.** Append to `tests/e2e/console-components.spec.ts`:

```ts
test('components: inputs are 32 px, control border, radius 8, broadcast input 36 px', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  for (const sel of ['#fb-search', '#fb-status', '#fb-room']) {
    const b = await box(page, sel);
    expect(b.h, sel).toBe(32);
    expect(b.radius, sel).toBe('8px');
    expect(b.border, sel).toBe('rgba(203, 213, 225, 0.44)');
  }
  expect((await box(page, '#bc-input')).h).toBe(36);
  const inline = await page.evaluate(() => [...document.querySelectorAll('input, select, textarea')].filter(e => /outline\s*:\s*none/i.test(e.getAttribute('style') || '')).map(e => e.id || e.className));
  expect(inline).toEqual([]);
  await ctx.close();
});

test('components: a modal is a labelled dialog, traps focus, closes on Escape and returns focus', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator('#help-btn').focus();
  await evalPage(page, `openShortcutsModal()`);
  const card = page.locator('#shortcuts-modal .ev-modal-card');
  await expect(card).toHaveAttribute('role', 'dialog');
  await expect(card).toHaveAttribute('aria-modal', 'true');
  expect(await card.getAttribute('aria-labelledby')).toBeTruthy();
  expect(await page.evaluate(() => !!document.activeElement?.closest('#shortcuts-modal'))).toBe(true);
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#shortcuts-modal'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#shortcuts-modal')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('help-btn');
  await ctx.close();
});

test('components: toasts live in a polite region; errors are alerts and stay 8 s', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#toast-container')).toHaveAttribute('aria-live', 'polite');
  await evalPage(page, `pushToast('Could not save', 'error')`);
  const toast = page.locator('#toast-container .toast-error');
  await expect(toast).toHaveAttribute('role', 'alert');
  expect(await toast.evaluate(el => getComputedStyle(el).borderTopLeftRadius)).toBe('8px');
  await page.clock.runFor(7_000);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(toast).toHaveCount(0);
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure** (heights 26-30, no `role`, focus not moved, error toast gone after 3 s).

- [ ] **Step 3: Inputs.** Replace the `#fb-search`, `#fb-status,#fb-room` and their `:focus` rules with:

```css
    #fb-search, #fb-status, #fb-room {
      height: 32px; background: var(--input-bg); border: 1px solid var(--border-control); border-radius: var(--r-ctl);
      padding: 0 10px; color: var(--text-primary); font: 400 var(--fs-13) var(--font-sans);
    }
    #fb-search { flex: 0 1 260px; min-width: 0; }
    #fb-status, #fb-room { cursor: pointer; }
    #fb-search:focus, #fb-status:focus, #fb-room:focus { border-color: var(--accent); }
```

Set `#bc-input` to `height: 36px; background: var(--input-bg); border: 1px solid var(--border-control); border-radius: var(--r-ctl); padding: 0 12px; color: var(--text-primary); font-size: var(--fs-13);` and `#bc-pri` to `height: 36px; border-radius: var(--r-ctl); border: 1px solid var(--border-control); background: var(--input-bg); color: var(--text-primary);`. Set `.ev-modal-card input,.ev-modal-card select` and `.wiz-body input, .wiz-body select` and `#login-form input, #register-form input, #reset-form input` to `height: 32px; background: var(--input-bg); border: 1px solid var(--border-control); border-radius: var(--r-ctl); padding: 0 10px; color: var(--text-primary); font-size: var(--fs-13);` (textareas keep their height). Delete the two `!important` lines of the stage 1 control-boundary block (the rules above now carry the border). Remove `outline:none` from every inline style in the HTML and in script templates (everything after `</style>`; the ring rule from Task 1.2 handles focus):

```bash
node -e '
const fs=require("fs");const f="cuedeck-console.html";let s=fs.readFileSync(f,"utf8");
const end=s.indexOf("</style>");const head=s.slice(0,end), body=s.slice(end);
const before=(body.match(/outline:\s*none/g)||[]).length;
const out=body.replace(/;\s*outline:\s*none(?=\s*[;"\x27])/g,"").replace(/outline:\s*none;\s*/g,"");
fs.writeFileSync(f,head+out);
console.log("inline outline:none before",before,"after",(out.match(/outline:\s*none/g)||[]).length);'
```

Expected: `after 0` (an attribute that held only `outline:none` is edited by hand).

- [ ] **Step 4: Modals.** For each of these 17 cards add `role="dialog" aria-modal="true" aria-labelledby="<title id>"` to the `.ev-modal-card` element, giving the title element an id where it has none: `#disp-modal`, `#spon-modal`, `#users-modal`, `#welcome-modal`, `#wizard-modal`, `#billing-modal`, `#invoice-modal`, `#qr-modal` (title `#qr-display-name`), `#restart-modal` (title `#restart-modal-title`), `#sess-modal` (title `#sess-modal-title`), `#ev-modal`, `#shortcuts-modal`, `#about-modal`, `#changelog-modal`, `#quickref-modal`, `#feedback-modal`, and `#cmd-palette .cmd-box` (`aria-label="Command palette"`). New title ids follow `<modal-id>-title`, for example `<div class="ev-modal-title" id="disp-modal-title">`. Restyle:

```css
    .ev-modal-backdrop { background: rgba(5,8,12,.72); }
    .ev-modal-card { background: var(--overlay); border: 1px solid var(--border-section); border-radius: var(--r-modal); box-shadow: 0 24px 64px rgba(0,0,0,.55); }
    .ev-modal-title { font-size: var(--fs-16); font-weight: 700; color: var(--text-primary); }
    .ev-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .ev-modal-actions button { height: var(--btn-md); padding: 0 12px; border-radius: var(--r-ctl); border: 1px solid var(--border-control); background: var(--raised); color: var(--text-primary); font: 600 var(--fs-13) var(--font-sans); filter: none; }
    .ev-modal-actions button:hover { background: var(--card); filter: none; }
    .ev-modal-actions button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); order: 99; }
    .ev-modal-actions button.danger  { background: transparent; border-color: var(--danger-line); color: var(--danger-fg); }
```

Add above the `keydown` listener:

```js
// One modal manager for every .ev-modal-backdrop: modals keep their inline
// style.display (the Escape handler and boot checks read it); this watches
// that attribute, moves focus in, keeps Tab inside, and returns focus.
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function initModalManager() {
  const returnTo = new Map();
  const isOpen = m => m.style.display === 'flex';
  const obs = new MutationObserver(muts => {
    for (const mu of muts) {
      const m = mu.target;
      if (isOpen(m) && !returnTo.has(m)) {
        returnTo.set(m, document.activeElement);
        // Synchronous: the observer runs after the display change, and a frame
        // callback would never fire under a paused clock (tests) or a hidden tab.
        (m.querySelector('[autofocus]') || m.querySelector(FOCUSABLE))?.focus();
      } else if (!isOpen(m) && returnTo.has(m)) {
        const back = returnTo.get(m); returnTo.delete(m);
        if (back && back.isConnected) back.focus();
      }
    }
  });
  document.querySelectorAll('.ev-modal-backdrop').forEach(m => {
    obs.observe(m, { attributes: true, attributeFilter: ['style'] });
    m.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const f = [...m.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  });
}
initModalManager();
```

In the Escape branch of the `keydown` handler, replace the `// Close any open modal` block (the `openModal` lookup and its twelve `if (openModal.id === …)` lines) with:

```js
    // Close any open modal: each backdrop closes itself on a click on the backdrop.
    const openModal = [...document.querySelectorAll('.ev-modal-backdrop')].find(m => m.style.display === 'flex');
    if (openModal) { openModal.click(); return; }
```

- [ ] **Step 5: Toasts.** Change `<div id="toast-container"></div>` to `<div id="toast-container" role="status" aria-live="polite"></div>`. Replace the `.toast*` colour and radius rules with:

```css
    .toast { background: var(--overlay); border: 1px solid var(--border-section); border-left-width: 4px; border-radius: var(--r-ctl); font-size: var(--fs-13); color: var(--text-primary); align-items: center; }
    .toast .ico { width: 16px; height: 16px; }
    .toast.toast-error   { border-left-color: var(--st-live); }    .toast.toast-error .ico   { color: var(--st-live-fg); }
    .toast.toast-warn    { border-left-color: var(--st-hold); }    .toast.toast-warn .ico    { color: var(--st-hold-fg); }
    .toast.toast-success { border-left-color: var(--st-ready); }   .toast.toast-success .ico { color: var(--st-ready-fg); }
    .toast.toast-info    { border-left-color: var(--accent); }     .toast.toast-info .ico    { color: var(--accent-fg); }
```

In `pushToast(msg, type)`: after `el.className = …` add `if (type === 'error') el.setAttribute('role', 'alert');`; change the `el.innerHTML` line to

```js
  const ico = { success: 'check', error: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  el.innerHTML = `${icon(ico)}<span class="toast-msg">${esc(msg)}</span><button class="toast-close" aria-label="${esc(t('cc.bc.dismiss'))}">${icon('x')}</button>`;
```

and the timeout line to `const delay = type === 'error' ? 8000 : type === 'warn' ? 3000 : 2000;`.

- [ ] **Step 6: Run** the three new tests plus `console-restart`, `console-forbidden`, `console-pairing`, `session-management`, `session-people`: all pass. Lower `BUDGET`. Update and review baselines (modals are not in the baseline set; check the `empty-1440` and `director-1440` diffs only show input edges). Full console suite `0 failed`.

- [ ] **Step 7: Commit, one per component** (`git add -p` per component as in Task 2.1 Step 10): `feat(console): input and select component`, `feat(console): modals are labelled dialogs with focus trap and one Escape handler`, `feat(console): toasts with status icons, polite region, errors stay 8 s`; the last commit also carries `tests/e2e/console-components.spec.ts`, `tests/console-colour-ratchet.spec.ts` and the screenshot directory.

### Task 2.3: Every remaining emoji icon replaced by the sprite

Runs after Task 2.2 on `redesign/stage-2`. Stages 3 and 4 already wrote the header, list, band, inspector and log without emoji; this task covers everything else.

**Files:**
- Create: `tests/console-no-emoji-icons.spec.ts`
- Modify: `cuedeck-console.html` (sites listed in Step 3), `tests/console-colour-ratchet.spec.ts`.

**Interfaces:** Consumes `icon()` and the sprite. Produces a guard that fails on any emoji or icon glyph in console markup or script strings.

- [ ] **Step 1: Failing guard.** Create `tests/console-no-emoji-icons.spec.ts`:

```ts
// tests/console-no-emoji-icons.spec.ts
// Spec section 3 (Icons): no emoji used as icons in the console. Scans
// cuedeck-console.html with comments removed. Arrows used as words in log
// text (A -> B) and the key symbol for Cmd are not icons and are allowed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RAW = readFileSync(resolve(__dirname, '../cuedeck-console.html'), 'utf8');
const SRC = RAW
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|[\s;{}(,])\/\/.*$/, '$1')).join('\n');
const GLYPHS = /\p{Extended_Pictographic}|[✓✕✎▲▼▶◀▸▾▴◉◈●○▯▭☰⟳★⬆⬇⏻⊡＋️]|&#x1F[0-9A-Fa-f]{3};|&#x2[3-7][0-9A-Fa-f]{2};|&#x2B0[67];|&#9[0-9]{3};/gu;

describe('no emoji icons in the console', () => {
  it('finds none', () => {
    const hits: string[] = [];
    SRC.split('\n').forEach((line, i) => { for (const m of line.matchAll(GLYPHS)) hits.push(`${i + 1}: ${m[0]}  ${line.trim().slice(0, 80)}`); });
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run.** `npx vitest run tests/console-no-emoji-icons.spec.ts`. Expected: a list of remaining sites (auth screens, signage panel, legacy role panels, stage monitor, toasts, command palette, mobile menu, profile edit, users modal, invoices, feedback stars, empty states).

- [ ] **Step 3: Replace them.** Run this one-off codemod (not committed). Each entry must match at least once; the script fails loudly if one is missing so nothing is silently skipped:

```js
// $SCRATCH/cd-icons.mjs
import fs from 'node:fs';
const FILE = process.argv[2];
let s = fs.readFileSync(FILE, 'utf8');
const I = (n) => `<svg class="ico" aria-hidden="true" focusable="false"><use href="#i-${n}"/></svg>`;
const J = (n) => '${icon(\'' + n + '\')}';          // inside a JS template literal
const REPL = [
  // auth screens
  ['<a href="#" class="lf-toggle-link" onclick="showLoginForm();return false">← Back to sign in</a>', `<a href="#" class="lf-toggle-link" onclick="showLoginForm();return false">${I('chev-left')} Back to sign in</a>`],
  ['<a href="#" class="lf-toggle-link" onclick="stopConfirmPolling();showLoginForm();return false">← Back to sign in</a>', `<a href="#" class="lf-toggle-link" onclick="stopConfirmPolling();showLoginForm();return false">${I('chev-left')} Back to sign in</a>`],
  ['<div id="rf-success" style="display:none">✅ Check your email', `<div id="rf-success" style="display:none">${I('check')} Check your email`],
  ['<div class="ce-icon">📬</div>', `<div class="ce-icon">${I('mail')}</div>`],
  ['<div class="ps-icon">⏳</div>', `<div class="ps-icon">${I('clock')}</div>`],
  ['<div class="te-icon">⏰</div>', `<div class="te-icon">${I('clock')}</div>`],
  // mobile menu and sidebar toggle
  ['<button id="hamburger-btn" onclick="toggleHamburger()" title="Menu">&#9776;</button>', `<button id="hamburger-btn" onclick="toggleHamburger()" title="Menu" aria-label="Menu">${I('menu')}</button>`],
  ['⌨️ Shortcuts</button>', `${I('keyboard')} Shortcuts</button>`],
  ['📋 Quick Ref</button>', `${I('list')} Quick Ref</button>`],
  ['🆕 What\'s New</button>', `${I('sparkle')} What's New</button>`],
  ['ℹ️ About</button>', `${I('info')} About</button>`],
  ['💬 Feedback</button>', `${I('message')} Feedback</button>`],
  ['<button id="sidebar-toggle" onclick="toggleSidebar()">&#9664;</button>', `<button id="sidebar-toggle" onclick="toggleSidebar()" aria-label="Inspector">${I('chev-left')}</button>`],
  ["if (toggle) toggle.textContent = isOpen ? '\\u25B6' : '\\u25C0';", "if (toggle) toggle.innerHTML = icon(isOpen ? 'chev-right' : 'chev-left');"],
  ["if (btn) btn.textContent = bar.classList.contains('filters-open') ? '\\u25B4 Filters' : '\\u25BE Filters';", "if (btn) btn.innerHTML = icon(bar.classList.contains('filters-open') ? 'chev-down' : 'chev-right') + ' Filters';"],
  // stage monitor close button (layout unchanged)
  ['EXIT MONITOR ✕</button>', `Exit monitor ${I('x')}</button>`],
  // users modal, welcome, invoices, events empty state, schema error
  ['placeholder="🔍  Search operators..."', 'placeholder="Search operators"'],
  [String.raw`\')">&#x1F5D1;</`, String.raw`\')" aria-label="Remove">` + I('trash') + '</'],
  ['<div style="font-size:28px;text-align:center">🎉</div>', `<div style="text-align:center">${I('sparkle')}</div>`],
  ['<div style="font-size:32px;margin-bottom:12px">&#x1F4CB;</div>', `<div style="margin-bottom:12px">${I('report')}</div>`],
  ['Welcome, ${esc(firstName)}! 👋', 'Welcome, ${esc(firstName)}'],
  ["'<span>&#x1F4E5;</span> PDF'", "icon('download') + ' PDF'"],
  ["'<span>&#x1F441;</span>'", "icon('eye')"],
  ["'<span>&#x2709;</span>'", "icon('mail')"],
  ['<div class="ei">⚠️</div>', `<div class="ei">${I('alert')}</div>`],
  ['<div id="empty"><div class="ei">📅</div>', `<div id="empty"><div class="ei">${I('calendar')}</div>`],
  ['<div class="ei">📅</div>', `<div class="ei">${I('calendar')}</div>`],
  // profile edit toggle
  ["'✎ Edit'", "'Edit'"],
  ["'✕ Cancel'", "'Cancel'"],
  ['&#x270E; Edit</button>', `${I('edit')} Edit</button>`],
  // signage panel
  ["const orientIcon = d.orientation === 'portrait' ? '▯' : '▭';", "const orientIcon = icon('monitor');"],
  ['<span>🚪 ${esc(d.filter_room)}</span>', `<span>${J('door')} \${esc(d.filter_room)}</span>`],
  ["${online ? '● online' : '○ offline'}", "${online ? 'online' : 'offline'}"],
  ['<div class="sp-override-tag">⚡ override:', `<div class="sp-override-tag">${J('bell')} override:`],
  ['onclick="markDisplayLaunched()">▶ Launch</a>', `onclick="markDisplayLaunched()">${J('play')} Launch</a>`],
  ['title="Copy the display link and flash the screen">📋 Copy link</butto', `title="Copy the display link and flash the screen">${J('link')} Copy link</butto`],
  ["onclick=\"openDisplayModal('edit','${esc(d.id)}')\">✎ Edit</button>", `onclick="openDisplayModal('edit','\${esc(d.id)}')">${J('edit')} Edit</button>`],
  ['<div class="sp-sponsor-placeholder video">▶ video</div>', `<div class="sp-sponsor-placeholder video">${J('play')} video</div>`],
  ["onclick=\"openSponsorModal('edit','${esc(s.id)}')\">✎</button>", `onclick="openSponsorModal('edit','\${esc(s.id)}')" aria-label="Edit">${J('edit')}</button>`],
  ["{ key: 'break',     label: '☕ Break Screen' }", "{ key: 'break',     label: 'Break Screen', ico: 'coffee' }"],
  ["{ key: 'recall',    label: '⚡ 5-Min Recall' }", "{ key: 'recall',    label: '5-Min Recall', ico: 'bell' }"],
  ["{ key: 'sponsors',  label: '🏢 Sponsors' }", "{ key: 'sponsors',  label: 'Sponsors', ico: 'star' }"],
  ["{ key: 'agenda',    label: '📊 Agenda Grid' }", "{ key: 'agenda',    label: 'Agenda Grid', ico: 'grid' }"],
  ["{ key: 'timeline',  label: '📜 Programme List' }", "{ key: 'timeline',  label: 'Programme List', ico: 'list' }"],
  ["{ key: 'programme', label: '🗓 Day Grid' }", "{ key: 'programme', label: 'Day Grid', ico: 'calendar' }"],
  ["{ key: 'wifi',      label: '📶 WiFi Info' }", "{ key: 'wifi',      label: 'WiFi Info', ico: 'wifi' }"],
  ["{ key: 'schedule',  label: '📋 Schedule' }", "{ key: 'schedule',  label: 'Schedule', ico: 'list' }"],
  ['onclick="clearGlobalOverride()">✕ Clear All</button>', `onclick="clearGlobalOverride()">${J('x')} Clear All</button>`],
  // legacy role panels (interp, reg, signage) in buildRoleCtxPanel
  ["html += cbtn('☕ Break Screen',  'btn-purple', \"sendGlobalOverride('break')\");", "html += cbtn('Break Screen', 'btn-purple', \"sendGlobalOverride('break')\", 'coffee');"],
  ["html += cbtn('⚡ 5-Min Recall', 'btn-amber',  \"sendGlobalOverride('recall')\");", "html += cbtn('5-Min Recall', 'btn-amber', \"sendGlobalOverride('recall')\", 'bell');"],
  ["html += cbtn('🏢 Sponsor Reel', 'btn-blue',   \"sendGlobalOverride('sponsors')\");", "html += cbtn('Sponsor Reel', 'btn-blue', \"sendGlobalOverride('sponsors')\", 'star');"],
  ["html += cbtn('📋 Back to Schedule','btn-grey', \"sendGlobalOverride('schedule')\");", "html += cbtn('Back to Schedule', 'btn-grey', \"sendGlobalOverride('schedule')\", 'list');"],
  ["html += cbtn('✕ Clear Override','btn-grey','clearGlobalOverride()');", "html += cbtn('Clear Override', 'btn-grey', 'clearGlobalOverride()', 'x');"],
  ["html += cbtn('⊡ STAGE MONITOR', 'btn-blue', 'openStageMonitor()');", "html += cbtn('Stage monitor', 'btn-blue', 'openStageMonitor()', 'monitor');"],
  ["`sendBroadcastQuick('📢 ${esc(tgt.title).substring(0,40)} — starting now. Please take your seats.','info')`, 'broadcast');", "`sendBroadcastQuick('${esc(tgt.title).substring(0,40)} is starting now. Please take your seats.','info')`, 'broadcast');"],
  ["html += cbtn('BREAK ALERT', 'btn-amber', \"sendBroadcastQuick('☕ Coffee break starting now','info')\", 'coffee');", "html += cbtn('Break alert', 'btn-amber', \"sendBroadcastQuick('Coffee break starting now','info')\", 'coffee');"],
  ["${isActive ? '◉ SESSION LIVE' : '◈ STANDBY'}", "${isActive ? 'Session live' : 'Standby'}"],
  // reconnect overlay
  ['<div id="rc-overlay">⟳ RECONNECTING — DATA MAY BE STALE</div>', `<div id="rc-overlay">${I('refresh')} Reconnecting: data may be stale</div>`],
  // feedback stars
  ['onclick="setFbRating(1)">★</span>', `onclick="setFbRating(1)">${I('star')}</span>`],
  ['onclick="setFbRating(2)">★</span>', `onclick="setFbRating(2)">${I('star')}</span>`],
  ['onclick="setFbRating(3)">★</span>', `onclick="setFbRating(3)">${I('star')}</span>`],
  ['onclick="setFbRating(4)">★</span>', `onclick="setFbRating(4)">${I('star')}</span>`],
  ['onclick="setFbRating(5)">★</span>', `onclick="setFbRating(5)">${I('star')}</span>`],
  // command palette static items
  ["icon: '▶️', label: 'Refresh sessions'", "icon: 'refresh', label: 'Refresh sessions'"],
  ["icon: '📢', label: 'Focus broadcast'", "icon: 'broadcast', label: 'Focus broadcast'"],
  ["icon: '🔍', label: 'Focus search'", "icon: 'search', label: 'Focus search'"],
  ["icon: '📋', label: 'Quick Reference'", "icon: 'list', label: 'Quick Reference'"],
  ["icon: '⌨️', label: 'Keyboard Shortcuts'", "icon: 'keyboard', label: 'Keyboard Shortcuts'"],
  ["icon: '🆕', label: 'What\\'s New'", "icon: 'sparkle', label: 'What\\'s New'"],
  ["icon: 'ℹ️', label: 'About CueDeck'", "icon: 'info', label: 'About CueDeck'"],
  ["icon: '💰', label: 'Open Billing'", "icon: 'card', label: 'Open Billing'"],
  ["icon: '👥', label: 'Manage Operators'", "icon: 'team', label: 'Manage Operators'"],
  ["icon: '💬', label: 'Send Feedback'", "icon: 'message', label: 'Send Feedback'"],
  ["icon: '📅', label: s.title", "icon: 'calendar', label: s.title"],
  ["icon: '🎭', label: `Switch to ${role.toUpperCase()}`", "icon: 'user', label: `Switch to ${role}`"],
  // quick reference table
  ["? '<td class=\"qr-check\">✓</td>'", "? '<td class=\"qr-check\">' + icon('check') + '</td>'"],   // both occurrences (lines ~8560 and ~8564)
];
const missing = [];
for (const [from, to] of REPL) {
  if (!s.includes(from)) { missing.push(from); continue; }
  s = s.split(from).join(to);
}
// Status prefixes on toasts and log strings ('✓ ', '⚠ ', '✕ ', '⏱ ') go; pushToast draws the icon.
s = s.replace(/(['`])(?:✓|⚠|✕|⏱)️?\s+/g, '$1');
fs.writeFileSync(FILE, s);
if (missing.length) { console.error('NOT FOUND:\n' + missing.join('\n')); process.exit(1); }
console.log('ok');
```

```bash
node "$SCRATCH/cd-icons.mjs" /Users/sheriff/AVE-Production-Console-redesign/cuedeck-console.html
```

Expected: `ok`. For any `NOT FOUND` line, the safety branch or stages 3 and 4 already changed that string: open the function named in the line, apply the same replacement by hand, and list it in the commit message. Then make the renderers use the new fields: in `renderSignagePanel()` change `` ${overrideModes.map(m => `<button class="sp-override-btn" onclick="sendGlobalOverride('${m.key}')">${m.label}</button>`).join('')} `` to `` ${overrideModes.map(m => `<button class="sp-override-btn" onclick="sendGlobalOverride('${m.key}')">${icon(m.ico)} ${m.label}</button>`).join('')} ``, and in `renderPaletteResults()` change `<span class="cmd-item-icon">${r.icon}</span>` to `<span class="cmd-item-icon">${icon(r.icon)}</span>`. Add CSS: `.fb-star .ico { width: 22px; height: 22px; } .fb-star.active .ico, .fb-star:hover .ico { fill: currentColor; } .ce-icon .ico, .ps-icon .ico, .te-icon .ico, #empty .ei .ico { width: 32px; height: 32px; }`.

- [ ] **Step 4: Run.** `npx vitest run` (guard passes; ratchet: set `BUDGET`); `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts` with `0 failed` (the pairing, signage and display-modal tests still find their buttons by text). Update and review the `signage-1440` and `empty-1440` baselines.

- [ ] **Step 5: Commit.**

```bash
git add tests/console-no-emoji-icons.spec.ts tests/console-colour-ratchet.spec.ts cuedeck-console.html tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): line icons replace every remaining emoji icon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- tests/console-no-emoji-icons.spec.ts tests/console-colour-ratchet.spec.ts cuedeck-console.html tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 2.4: Release stage 2

Same steps as Task 1.4 with branch `redesign/stage-2` and notes directory `$SCRATCH/notes/stage-2`. Freeze check first: no release task starts after 18:00 on 10 Oct; anything not live-checked by 21:00 on 10 Oct waits until after GTR; nothing is pushed on 11 Oct. The pushed range must contain only the Task 2.2 and 2.3 commits. Live check: `curl -s https://app.cuedeck.io/ | grep -o 'aria-modal="true"' | head -1` prints the string; in Chrome, open Help, then Keyboard shortcuts, press Tab repeatedly (focus stays in the dialog), press Escape (focus returns to Help); trigger no show control. Note to Sherif: "Stage 2 (components) is live: inputs, dialogs, toasts and icons." with before/after pairs for `signage-1440` and `director-1440`.

---

# Stage 3: Chrome and compact list

Branch: `redesign/stage-3` from `main` after Task 1.4; Task 2.1 is its first commits.

### Task 3.1: Header and chrome

**Files:**
- Modify `cuedeck-console.html`:
  - HTML: `<!-- BROADCAST BANNER -->` (`#bc-banner`, line 1872); `<!-- HEADER -->` the whole `#header` div (1875-2014); delete `<!-- DIAGNOSTICS -->` `#diag-bar` (2016-2022) and `<!-- ROLE BAR -->` `#role-bar` (2025-2034); in `#sidebar` delete the `#ai-agents-wrap` section (2072-2101), the `#ave-brain-wrap` section (2103-2108) and the `SERVER CLOCK` section (2110-2121); `#bc-bar` (2424-2437).
  - CSS: delete the rules for removed elements (`#diag-bar`, `.di`, `#role-bar`, `#role-bar label`, `.rbtn`, `.rbtn:hover`, `.rbtn.active`, `#ev-select-wrap`, `.ev-pill`, `.ev-pill:hover`, `.ev-pill-label`, `.ev-pill-name`, `.ev-pill-chev`, `.ev-pill-dd*`, `.ev-add-btn*`, `#users-btn`, `#users-btn:hover`, `#logout-btn*`, `#billing-btn*`, `#checkin-btn*`, `#auto-start-btn*`, `#conn-pill`, `#conn-dot*`, `#event-name`, `#sb-time`, `.ck-details`, `#presence-bar`, `.pr-role`, `.pr-dot*`, `.uc-sep`, `.uc-caret`, `#bc-bar label`, `.bc-presets`, the RTL lines for `#role-bar`, `#diag-bar`, `#presence-bar`, and in the two responsive blocks the lines for `#role-bar`, `.rbtn`, `.di`, `#diag-bar`, `#ev-select-wrap`); append the block `/* ═══ Command center header and chrome (stage 3) ═══ */`.
  - JS: `setConn` (4955), `refreshClockUI` (4962), `refreshDiag` (4984), `refreshPresence` (5008), presence sync and `track` in `subscribeControl` (2803-2823), `setRole` (5429), `buildEvSelect`/`toggleEvDropdown`/`closeEvDropdown` (5450-5482), `toggleAutoStart` (5102), `showBCBanner`/`hideBCBanner`/`dismissBanner` (5372-5384), `BC_PRESETS`/`buildBCPresets` (5386-5402), `sendBroadcast` and `clearBroadcast` (3298-3340), `renderUserChip` (6853), `toggleProfilePanel`/`closeProfilePanel` (6895-6919), `loadSubscription` billing line (7132), `loadUserRole` role lock (7631-7637), `loadBrainInsights` (8306), `ROLE_TIPS` (7751), the Escape branch of the keydown handler.
- Modify `cuedeck-i18n.js`: add the `cc.` keys in Step 6 to each of the four blocks; in `translateStaticDOM()` change the map entries and the help-dropdown loop (Step 7).
- Create `tests/e2e/console-header.spec.ts`, `tests/console-i18n-keys.spec.ts`.
- Modify `tests/e2e/console-ui.spec.ts` (tests 06-09, 21, 25), `tests/e2e/auth-flows.spec.ts` (tests 07-21 role clicks), `tests/e2e/session-management.spec.ts` (line 221), `tests/console-colour-ratchet.spec.ts`.

**Interfaces:**
- Consumes: `icon()`, `tf()`, `tsHM()`, `.pill`, `.btn`, `.lbl`, tokens, `getUtcOffset(tz)`, `correctedHMS()`.
- Produces ids: `#ev-switch`, `#event-name`, `#event-sub`, `#ev-pill-dd`, `#hdr-clock`, `#conn-pill`/`#conn-dot`/`#conn-lbl`, `#sys-pop` (contains `#dd-db #dl-db #dd-rt #dl-rt #dd-ck #dl-ck #dd-ef #dl-ef #ck-off #ck-rtt #ck-sync #ck-tick #hdr-offset #di-cnt`), `#crew-pill`/`#presence-bar`/`#crew-count`/`#crew-pop`/`#crew-list`, `#brain-wrap`/`#brain-badge`/`#brain-count`/`#brain-pop`/`#ave-brain-wrap`/`#ave-brain-cards`, `#viewas-btn`/`#viewas-lbl`/`#viewas-menu` (holds `.rbtn[data-role]`)/`#role-lock`, `#user-chip`, `#profile-panel` with `#checkin-btn #users-btn #pp-billing-btn #pp-invoices-btn #lang-switcher #auto-start-btn #ai-agents-wrap #ai-report-btn`, `#bc-chip`, `#bc-send`, `#bc-clear`, `#bc-presets-menu`.
- Produces JS: `applyI18nAttrs(root)`, `togglePopover(id, btn)`, `closePopovers()`, `refreshSysPill()`, `eventClockHMS()`, `eventSubline(ev)`, `setBannerRead(read)`, `reopenBanner()`, `S.presenceList`, `S.bcKey`, `S.bcReadKey`, `S.brainCount`.
- Produces test helper `viewAs(page, role)` in `console-ui.spec.ts` and `auth-flows.spec.ts`.

- [ ] **Step 1: Failing tests.** Create `tests/e2e/console-header.spec.ts`:

```ts
// tests/e2e/console-header.spec.ts
// Spec 2 and 2.4: one 52 px header, top chrome at most 100 px, keyboard
// event switcher, system pill naming what failed, crew, View as for
// directors only, account menu with Tools, banner that collapses to a chip.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage } from './console-boot-mock';

test('header: one 52 px bar, no diagnostics strip or role bar, top chrome at most 100 px', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#diag-bar')).toHaveCount(0);
  await expect(page.locator('#role-bar')).toHaveCount(0);
  expect(Math.round((await page.locator('#header').boundingBox())!.height)).toBe(52);
  const banner = (await page.locator('#bc-banner').boundingBox())?.height ?? 0;
  const fb = (await page.locator('#filter-bar').boundingBox())!;
  // Top chrome in stage 3 = header + filter row, banner excluded (spec: at most 100 px).
  expect(fb.y + fb.height - banner).toBeLessThanOrEqual(100);
  expect(await page.locator('#header').evaluate(el => /\p{Extended_Pictographic}/u.test(el.textContent || ''))).toBe(false);
  await ctx.close();
});

test('header: the event switcher is a keyboard button with date and time zone', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#ev-switch')).toHaveJSProperty('tagName', 'BUTTON');
  await expect(page.locator('#event-name')).toHaveText('GTR North Africa 2026');
  await expect(page.locator('#event-sub')).toHaveText('Tue 6 Oct · Cairo UTC+3');
  await page.locator('#ev-switch').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ev-pill-dd')).toHaveClass(/open/);
  await expect(page.locator('#ev-switch')).toHaveAttribute('aria-expanded', 'true');
  await ctx.close();
});

test('header: the system pill says All systems, names a failing check, and its popover holds the diagnostics', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#conn-lbl')).toHaveText('All systems');
  await expect(page.locator('#conn-pill')).toHaveClass(/is-ok/);
  await page.locator('#conn-pill').click();
  await expect(page.locator('#sys-pop')).toBeVisible();
  await expect(page.locator('#dl-db')).toBeVisible();
  await expect(page.locator('#ck-off')).toBeVisible();
  await evalPage(page, `S.rtStatus = 'error'; refreshDiag();`);
  await expect(page.locator('#conn-lbl')).toHaveText('Realtime not working');
  await expect(page.locator('#conn-pill')).toHaveClass(/is-err/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sys-pop')).toBeHidden();
  await ctx.close();
});

test('header: crew pill counts roles online and lists names', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#crew-count')).toHaveText('Crew 3/5');
  await page.locator('#crew-pill').click();
  await expect(page.locator('#crew-list')).toContainText('Ahmed Fawzy');
  await ctx.close();
});

test('header: a director switches role from View as', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#viewas-btn')).toBeVisible();
  await page.locator('#viewas-btn').click();
  await page.locator('.rbtn[data-role="signage"]').click();
  expect(await evalPage(page, 'S.role')).toBe('signage');
  await expect(page.locator('#viewas-lbl')).toHaveText(/signage/i);
  await ctx.close();
});

test('header: a stage operator sees their role, not the View as menu', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage' });
  await expect(page.locator('#viewas-btn')).toBeHidden();
  await expect(page.locator('#role-lock')).toBeVisible();
  await expect(page.locator('#role-lock')).toHaveText(/stage/i);
  await ctx.close();
});

test('header: AI tools live in the account menu under Tools, never next to show controls', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#sidebar .sb-action-btn')).toHaveCount(0);
  const outside = await page.locator('[onclick*="CueDeckIncidentAdvisor.trigger"]').evaluateAll(els => els.filter(e => !e.closest('#profile-panel')).length);
  expect(outside).toBe(0);
  await page.locator('#user-chip').click();
  await expect(page.locator('#ai-agents-wrap')).toBeVisible();
  await expect(page.locator('#ai-agents-wrap button')).toHaveCount(3);
  for (const id of ['#checkin-btn', '#users-btn', '#lang-switcher', '#auto-start-btn']) await expect(page.locator(id)).toBeVisible();
  await ctx.close();
});

test('header: the broadcast banner is 28 px and collapses to a header chip once read', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  expect(Math.round((await page.locator('#bc-banner').boundingBox())!.height)).toBe(28);
  await expect(page.locator('#bc-banner')).toContainText('11:32');
  await page.locator('#bc-banner .bc-dismiss').click();
  await expect(page.locator('#bc-banner')).toBeHidden();
  await expect(page.locator('#bc-chip')).toBeVisible();
  await page.locator('#bc-chip').click();
  await expect(page.locator('#bc-banner')).toBeVisible();
  await ctx.close();
});

test('header: a critical broadcast needs a second press; info sends on the first', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const writes: string[] = [];
  page.on('request', r => { if (r.url().includes('/rest/v1/leod_broadcast') && r.method() !== 'GET') writes.push(r.method()); });
  await page.locator('#bc-input').fill('Evacuate Hall B');
  await page.locator('#bc-pri').selectOption('critical');
  await page.locator('#bc-send').click();
  await expect(page.locator('#bc-send')).toHaveClass(/confirm-pending/);
  expect(writes).toEqual([]);
  await page.locator('#bc-send').click();
  await expect.poll(() => writes.length).toBe(1);
  await page.locator('#bc-input').fill('Doors open');
  await page.locator('#bc-pri').selectOption('info');
  await page.locator('#bc-input').press('Enter');
  await expect.poll(() => writes.length).toBe(2);
  await ctx.close();
});
```

Create `tests/console-i18n-keys.spec.ts`:

```ts
// tests/console-i18n-keys.spec.ts
// Every redesign string (cc.*) exists in en, ar, pl and de with the same
// {placeholders}, and no value contains an em-dash.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../cuedeck-i18n.js'), 'utf8');
function block(lang: string): Record<string, string> {
  const start = SRC.indexOf(`\n    ${lang}: {`);
  if (start < 0) throw new Error(`no ${lang} block`);
  const end = SRC.indexOf('\n    },', start);
  const out: Record<string, string> = {};
  for (const m of SRC.slice(start, end).matchAll(/'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'/g)) out[m[1]] = m[2];
  return out;
}
const LANGS = ['en', 'ar', 'pl', 'de'];
const B: Record<string, Record<string, string>> = Object.fromEntries(LANGS.map(l => [l, block(l)]));
const CC = Object.keys(B.en).filter(k => k.startsWith('cc.'));
const ph = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

describe('redesign strings', () => {
  it('there are cc.* keys', () => expect(CC.length).toBeGreaterThan(20));
  for (const lang of ['ar', 'pl', 'de']) {
    it(`every cc.* key exists in ${lang}`, () => expect(CC.filter(k => !(k in B[lang]))).toEqual([]));
  }
  it('placeholders match across languages', () => {
    expect(CC.flatMap(k => ['ar', 'pl', 'de'].filter(l => ph(B[l][k] ?? '') !== ph(B.en[k])).map(l => `${l}:${k}`))).toEqual([]);
  });
  it('no cc.* value contains an em-dash', () => {
    expect(LANGS.flatMap(l => CC.filter(k => (B[l][k] || '').includes('\u2014')).map(k => `${l}:${k}`))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure.** `npx vitest run tests/console-i18n-keys.spec.ts` (fails: `there are cc.* keys`) and `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-header.spec.ts` (fails: `#diag-bar` count 1, `#ev-switch` missing, …).

- [ ] **Step 3: Markup.** Replace `<div id="bc-banner"></div>` with `<div id="bc-banner" role="status" aria-live="polite"></div>`. Replace the whole `#header` div with the following (the logo `<svg>` is copied unchanged from the old header; `I(name)` below stands for the literal `<svg class="ico" aria-hidden="true" focusable="false"><use href="#i-NAME"/></svg>`, written out in the file):

```html
<!-- HEADER (52 px) -->
<div id="header" role="banner">
  <div class="logo"><!-- unchanged CueDeck logo svg --></div>
  <div id="ev-select-wrap" class="hdr-pop-wrap">
    <button type="button" id="ev-switch" class="ev-switch" aria-haspopup="menu" aria-expanded="false" aria-controls="ev-pill-dd" onclick="toggleEvDropdown()">
      <span class="ev-switch-name"><span id="event-name">–</span>I(chev-down)</span>
      <span id="event-sub" class="ev-switch-sub"></span>
    </button>
    <div id="ev-pill-dd" class="ev-pill-dd" role="menu"></div>
  </div>
  <span class="hdr-spacer"></span>
  <div id="hdr-clock">--:--:--</div>
  <span class="hdr-spacer"></span>
  <button type="button" id="bc-chip" class="pill bc-chip" hidden onclick="reopenBanner()">I(broadcast)<span data-i18n="cc.bc.show">Show broadcast</span></button>
  <div class="hdr-pop-wrap">
    <button type="button" id="conn-pill" class="pill" aria-haspopup="dialog" aria-expanded="false" aria-controls="sys-pop" onclick="togglePopover('sys-pop', this)">
      <span id="conn-dot" class="dot"></span><span id="conn-lbl">offline</span>
    </button>
    <div id="sys-pop" class="hdr-pop" role="dialog" aria-labelledby="sys-pop-title" hidden>
      <div class="lbl" id="sys-pop-title" data-i18n="cc.sys.title">System status</div>
      <div class="di"><span class="dd checking" id="dd-db"></span><span id="dl-db">database</span></div>
      <div class="di"><span class="dd checking" id="dd-rt"></span><span id="dl-rt">realtime</span></div>
      <div class="di"><span class="dd checking" id="dd-ck"></span><span id="dl-ck">clock</span></div>
      <div class="di"><span class="dd" id="dd-ef"></span><span id="dl-ef">edge functions</span></div>
      <div class="lbl" data-i18n="cc.sys.clock">Clock</div>
      <dl class="sys-clock">
        <dt data-i18n="cc.sys.offset">Offset</dt><dd class="ck-val" id="ck-off">–</dd>
        <dt data-i18n="cc.sys.rtt">Round trip</dt><dd class="ck-val" id="ck-rtt">–</dd>
        <dt data-i18n="cc.sys.synced">Last sync</dt><dd class="ck-val" id="ck-sync">–</dd>
        <dt>Tick</dt><dd class="ck-val" id="ck-tick">–</dd>
      </dl>
      <div class="sys-foot"><span id="hdr-offset">offset: –</span> · <span data-i18n="cc.sys.sessions">Sessions</span> <span id="di-cnt">–</span></div>
    </div>
  </div>
  <div class="hdr-pop-wrap">
    <button type="button" id="crew-pill" class="pill" aria-haspopup="dialog" aria-expanded="false" aria-controls="crew-pop" onclick="togglePopover('crew-pop', this)">
      <span id="presence-bar" class="crew-dots"></span><span id="crew-count">Crew 0/5</span>
    </button>
    <div id="crew-pop" class="hdr-pop" role="dialog" aria-labelledby="crew-pop-title" hidden>
      <div class="lbl" id="crew-pop-title" data-i18n="cc.hdr.crewTitle">Crew online</div>
      <ul id="crew-list" class="crew-list"></ul>
    </div>
  </div>
  <div class="hdr-pop-wrap" id="brain-wrap" hidden>
    <button type="button" id="brain-badge" class="pill" aria-haspopup="dialog" aria-expanded="false" aria-controls="brain-pop" onclick="togglePopover('brain-pop', this)">
      I(sparkle)<span data-i18n="cc.hdr.brain">AVE Brain</span><span id="brain-count" class="pill-count"></span>
    </button>
    <div id="brain-pop" class="hdr-pop hdr-pop-wide" role="dialog" aria-labelledby="brain-pop-title" hidden>
      <div id="ave-brain-wrap">
        <div class="lbl" id="brain-pop-title" data-i18n="cc.hdr.brain">AVE Brain</div>
        <div id="ave-brain-cards"><p class="brain-empty">Loading…</p></div>
        <a href="https://ave-brain.vercel.app/insights" target="_blank" rel="noopener" class="brain-link">View all</a>
      </div>
    </div>
  </div>
  <div id="plan-badge"></div>
  <div class="hdr-pop-wrap" id="viewas-wrap">
    <button type="button" id="viewas-btn" class="pill" aria-haspopup="menu" aria-expanded="false" aria-controls="viewas-menu" onclick="togglePopover('viewas-menu', this)">
      <span id="viewas-lbl">View as director</span>I(chev-down)
    </button>
    <div id="viewas-menu" class="hdr-menu" role="menu" hidden>
      <button type="button" class="rbtn active" role="menuitemradio" aria-checked="true"  data-role="director" onclick="setRole('director');closePopovers()">director</button>
      <button type="button" class="rbtn"        role="menuitemradio" aria-checked="false" data-role="stage"    onclick="setRole('stage');closePopovers()">stage</button>
      <button type="button" class="rbtn"        role="menuitemradio" aria-checked="false" data-role="av"       onclick="setRole('av');closePopovers()">av</button>
      <button type="button" class="rbtn"        role="menuitemradio" aria-checked="false" data-role="interp"   onclick="setRole('interp');closePopovers()">interp</button>
      <button type="button" class="rbtn"        role="menuitemradio" aria-checked="false" data-role="reg"      onclick="setRole('reg');closePopovers()">reg</button>
      <button type="button" class="rbtn"        role="menuitemradio" aria-checked="false" data-role="signage"  onclick="setRole('signage');closePopovers()">signage</button>
    </div>
    <span id="role-lock" class="pill role-lock" hidden></span>
  </div>
  <button type="button" id="help-btn" class="btn sm ghost" onclick="toggleHelpMenu()" aria-haspopup="menu" title="Help · Press ? anytime">I(help)<span>Help</span><span id="cl-badge" class="changelog-badge" style="display:none"></span></button>
  <div id="help-dropdown" class="help-dropdown" role="menu">
    <button role="menuitem" onclick="openShortcutsModal();closeHelpMenu()">I(keyboard)<span class="hd-label">Keyboard Shortcuts</span></button>
    <button role="menuitem" onclick="openQuickRefModal();closeHelpMenu()">I(list)<span class="hd-label">Quick Reference</span></button>
    <button role="menuitem" onclick="openChangelogModal();closeHelpMenu()">I(sparkle)<span class="hd-label">What's New</span></button>
    <div class="hd-sep"></div>
    <button role="menuitem" onclick="window.open('https://www.cuedeck.io/docs','_blank');closeHelpMenu()">I(book)<span class="hd-label">Documentation</span></button>
    <button role="menuitem" onclick="openFeedbackModal();closeHelpMenu()">I(message)<span class="hd-label">Send Feedback</span></button>
    <button role="menuitem" onclick="location.href='mailto:support@cuedeck.io';closeHelpMenu()">I(mail)<span class="hd-label">Contact Support</span></button>
    <div class="hd-sep"></div>
    <button role="menuitem" onclick="openAboutModal();closeHelpMenu()">I(info)<span class="hd-label">About CueDeck</span></button>
  </div>
  <button type="button" id="user-chip" class="user-chip" aria-haspopup="menu" aria-expanded="false" aria-label="Account" onclick="toggleProfilePanel(event)">
    <span id="user-chip-avatar" class="uc-avatar"></span><span id="user-chip-name" class="uc-name"></span><span id="user-chip-role" class="uc-role" hidden></span>I(chev-down)
  </button>
  <!-- #profile-panel: copied unchanged from the old header except its .pp-actions block, replaced below -->
  <!-- #hamburger-btn and #mobile-menu: copied unchanged from the old header -->
</div>
```

In `#profile-panel`, replace the `<div class="pp-actions"> … </div>` block with:

```html
      <div class="pp-actions" role="menu">
        <a id="checkin-btn" class="pp-action" role="menuitem" href="/checkin" target="_blank" rel="noopener">I(checkin)<span class="pp-label" data-i18n="cc.menu.checkin">Check-in</span></a>
        <button id="users-btn" class="pp-action" role="menuitem" style="display:none" onclick="closeProfilePanel();openUsersModal()">I(team)<span class="pp-label" data-i18n="cc.menu.team">Team</span><span id="users-badge"></span></button>
        <button id="pp-billing-btn" class="pp-action" role="menuitem" style="display:none" onclick="openBillingModal();closeProfilePanel()">I(card)<span class="pp-label" data-i18n="cc.menu.billing">Billing</span></button>
        <button id="pp-invoices-btn" class="pp-action" role="menuitem" style="display:none" onclick="openInvoiceModal();closeProfilePanel()">I(report)<span class="pp-label" data-i18n="cc.menu.invoices">Invoices</span></button>
        <div id="pp-upgrade-wrap" style="display:none">
          <button class="pp-action pp-upgrade" role="menuitem" onclick="openBillingModal();closeProfilePanel()">I(arrow-up)<span class="pp-label" data-i18n="cc.menu.upgrade">Upgrade plan</span></button>
        </div>
        <label class="pp-action pp-lang">I(globe)<span class="pp-label" data-i18n="cc.menu.language">Language</span>
          <select id="lang-switcher" aria-label="Language" onchange="CueDeckI18n.setLocale(this.value);location.reload()">
            <option value="en">EN</option><option value="ar">AR</option><option value="pl">PL</option><option value="de">DE</option>
          </select>
        </label>
        <button class="pp-action" role="menuitem" onclick="closeProfilePanel();openShortcutsModal()">I(keyboard)<span class="pp-label" data-i18n="cc.menu.shortcuts">Shortcuts</span></button>
        <button id="auto-start-btn" class="pp-action" role="menuitemcheckbox" aria-checked="false" onclick="toggleAutoStart()">I(timer)<span class="pp-label" data-i18n="cc.menu.autoStart">Auto-start</span></button>
        <div id="ai-agents-wrap" class="pp-group" style="display:none">
          <div class="lbl pp-group-lbl" data-i18n="cc.menu.tools">Tools</div>
          <button class="pp-action" role="menuitem" onclick="closeProfilePanel();ensureAgentsInited();CueDeckIncidentAdvisor.trigger({system:'AV System',location:'Main Stage',severity:'Warning',description:'Manual test: check signal path and connections',timestamp:new Date().toLocaleTimeString()})">I(alert)<span class="pp-label" data-i18n="cc.menu.testIncident">Test incident alert</span></button>
          <button class="pp-action" role="menuitem" onclick="closeProfilePanel();ensureAgentsInited();(()=>{const s=S.sessions.find(x=>!['ENDED','CANCELLED'].includes(x.status))||{title:'Demo Session',scheduled_start:new Date(Date.now()+8*60000).toISOString(),room:'Main Stage'};CueDeckCueEngine.triggerCue(CueDeckCueEngine.adaptSessions([s])[0]||{title:s.title||'Demo',startTime:new Date(Date.now()+8*60000).toTimeString().slice(0,5),location:s.room||'Main Stage',systems:[],interpreters:[]},new Date(Date.now()+8*60000));})()">I(timer)<span class="pp-label" data-i18n="cc.menu.testCue">Test cue alert</span></button>
          <button class="pp-action" role="menuitem" id="ai-report-btn" onclick="closeProfilePanel();ensureAgentsInited();CueDeckReportAgent.triggerFromCueDeck()">I(report)<span class="pp-label" data-i18n="cc.menu.report">Generate report</span></button>
        </div>
        <div class="pp-divider"></div>
        <button class="pp-action pp-danger" role="menuitem" onclick="doLogout()">I(logout)<span class="pp-label" data-i18n="cc.menu.signOut">Sign out</span></button>
      </div>
```

Delete `#diag-bar`, `#role-bar`, and in `#sidebar` the `#ai-agents-wrap`, `#ave-brain-wrap` and `SERVER CLOCK` sections. Replace `#bc-bar` with:

```html
<div id="bc-bar">
  <span class="lbl" data-i18n="cc.bc.label">Broadcast</span>
  <div class="bc-presets" id="bc-presets"></div>
  <input id="bc-input" type="text" placeholder="Message to all operators" maxlength="200" aria-label="Broadcast message"
         oninput="onBCInput()" onkeydown="if(event.key==='Enter')sendBroadcast()">
  <span id="bc-char" class="bc-char"></span>
  <select id="bc-pri" aria-label="Priority">
    <option value="info">info</option>
    <option value="warn">warn</option>
    <option value="critical">critical</option>
  </select>
  <button type="button" id="bc-send" class="btn md primary" onclick="sendBroadcast()" data-i18n="cc.bc.send">Send</button>
  <button type="button" id="bc-clear" class="btn md" onclick="clearBroadcast()" data-i18n="cc.bc.clear">Clear</button>
</div>
```

- [ ] **Step 4: CSS.** Delete the rules listed under Files. Append:

```css
    /* ═══ Command center header and chrome (stage 3) ═══ */
    #bc-banner { display: none; align-items: center; gap: 10px; height: 28px; padding: 0 16px; font-size: var(--fs-13); font-weight: 600; text-align: start; flex-shrink: 0; animation: none; }
    #bc-banner .bc-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #bc-banner .bc-when { color: var(--text-tertiary); font-weight: 500; font-size: var(--fs-12); font-variant-numeric: tabular-nums; }
    #bc-banner .bc-dismiss { position: static; height: 24px; opacity: 1; }
    .bc-chip.info { color: var(--accent-fg); }
    .bc-chip.warn { color: var(--st-hold-fg); border-color: var(--st-hold-line); }
    .bc-chip.critical { color: var(--st-live-fg); border-color: var(--st-live-line); }
    #header { height: 52px; padding: 0 16px; gap: 12px; background: var(--panel); border-bottom: 1px solid var(--border-section); backdrop-filter: none; }
    .hdr-spacer { flex: 1 1 0; min-width: 8px; }
    .hdr-pop-wrap { position: relative; display: flex; align-items: center; }
    #ev-select-wrap { min-width: 0; flex: 0 1 auto; margin: 0; }
    .ev-switch { display: grid; gap: 2px; min-width: 0; max-width: 340px; padding: 4px 8px; border-radius: var(--r-ctl); background: transparent; border: 1px solid transparent; color: var(--text-primary); text-align: start; cursor: pointer; font-family: var(--font-sans); }
    .ev-switch:hover { background: var(--raised); }
    .ev-switch-name { display: flex; align-items: center; gap: 4px; font-size: var(--fs-14); font-weight: 700; min-width: 0; }
    #event-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ev-switch-sub { font-size: var(--fs-12); color: var(--text-tertiary); white-space: nowrap; }
    .hdr-menu, .ev-pill-dd, .hdr-pop { position: absolute; top: calc(100% + 6px); z-index: 300; min-width: 220px; padding: 6px; background: var(--overlay); border: 1px solid var(--border-section); border-radius: var(--r-ctl); box-shadow: 0 16px 40px rgba(0,0,0,.5); }
    .ev-pill-dd { inset-inline-start: 0; display: none; }
    .ev-pill-dd.open { display: block; }
    .hdr-pop, .hdr-menu { inset-inline-end: 0; }
    .hdr-menu[hidden], .hdr-pop[hidden], #brain-wrap[hidden], #bc-chip[hidden], #role-lock[hidden], #viewas-btn[hidden] { display: none; }
    .hdr-menu button, .ev-pill-dd button { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); font: 500 var(--fs-13) var(--font-sans); text-align: start; text-transform: none; letter-spacing: 0; cursor: pointer; }
    .hdr-menu button:hover, .ev-pill-dd button:hover, .hdr-menu button.active, .ev-pill-dd button.active { background: var(--raised); color: var(--text-primary); }
    .ev-pill-dd .hd-sep { height: 1px; background: var(--border-divider); margin: 4px 6px; }
    .hdr-pop { display: grid; gap: 8px; padding: 12px; min-width: 260px; }
    .hdr-pop-wide { min-width: 320px; }
    .hdr-pop .di { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13); color: var(--text-secondary); }
    .dd { width: 8px; height: 8px; border-radius: 50%; background: var(--st-planned); }
    .dd.ok { background: var(--st-ready); box-shadow: none; }
    .dd.error { background: var(--st-live); }
    .dd.checking { background: var(--st-hold); animation: none; }
    .sys-clock { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: var(--fs-12); color: var(--text-tertiary); }
    .sys-clock dd { margin: 0; color: var(--text-primary); font-family: var(--font-mono); }
    .sys-foot { font-size: var(--fs-12); color: var(--text-tertiary); }
    #hdr-clock { min-width: 120px; text-align: center; }
    #conn-dot.reconnecting, #conn-dot.offline { background: var(--st-live); }
    .crew-dots { display: inline-flex; gap: 3px; }
    .crew-dots i { width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--text-disabled); }
    .crew-dots i.on { background: var(--st-ready); border-color: var(--st-ready); }
    .crew-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .crew-list li { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13); color: var(--text-primary); }
    .crew-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--st-ready); }
    .crew-role { margin-inline-start: auto; color: var(--text-tertiary); font-size: var(--fs-12); }
    .crew-none { color: var(--text-tertiary); }
    .pill-count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--r-pill); background: var(--accent); color: var(--on-accent); font-size: var(--fs-11); font-weight: 700; display: inline-grid; place-items: center; }
    .role-lock { cursor: default; }
    .rbtn { text-transform: none; }
    #help-btn { height: var(--btn-sm); position: relative; }
    .help-dropdown { top: 50px; background: var(--overlay); border: 1px solid var(--border-section); border-radius: var(--r-ctl); }
    .help-dropdown button { display: flex; align-items: center; gap: 8px; }
    .user-chip { align-items: center; gap: 8px; height: 32px; padding: 0 8px 0 4px; border-radius: var(--r-pill); background: transparent; border: 1px solid transparent; color: var(--text-secondary); font-family: var(--font-sans); cursor: pointer; }
    .user-chip:hover { background: var(--raised); filter: none; }
    .uc-avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--raised); border: 1px solid var(--border-control); color: var(--text-primary); display: grid; place-items: center; font: 700 var(--fs-11) var(--font-sans); }
    .uc-name { font-size: var(--fs-13); font-weight: 600; color: var(--text-primary); }
    .profile-panel { background: var(--overlay); border: 1px solid var(--border-section); border-radius: var(--r-modal); }
    .pp-action { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 32px; text-decoration: none; }
    .pp-label { flex: 1; text-align: start; }
    #auto-start-btn[aria-checked="true"] { color: var(--st-ready-fg); }
    .pp-group { display: grid; gap: 2px; padding-top: 6px; border-top: 1px solid var(--border-divider); margin-top: 6px; }
    .pp-group-lbl { padding: 4px 10px; }
    #bc-bar { height: 52px; padding: 0 16px; gap: 8px; }
    .bc-presets-menu { position: relative; }
    .bc-presets-menu > summary { list-style: none; }
    .bc-presets-menu > summary::-webkit-details-marker { display: none; }
    .bc-presets-list { bottom: calc(100% + 6px); top: auto; inset-inline-start: 0; inset-inline-end: auto; }
    .bc-presets-menu:not([open]) .bc-presets-list { display: none; }
```

- [ ] **Step 5: JS.** Add a section directly under the shared helpers from Task 2.1:

```js
// ═══════════════════════════════════════════════════
// COMMAND CENTER: header (stage 3)
// ═══════════════════════════════════════════════════
// Static labels carry data-i18n; this fills them in the current language.
function applyI18nAttrs(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
}
applyI18nAttrs();

function togglePopover(id, btn) {
  const pop = document.getElementById(id);
  if (!pop) return;
  const opening = pop.hidden;
  closePopovers();
  if (opening) { pop.hidden = false; if (btn) btn.setAttribute('aria-expanded', 'true'); }
}
function closePopovers() {
  document.querySelectorAll('#header .hdr-pop, #header .hdr-menu').forEach(p => { p.hidden = true; });
  document.querySelectorAll('#header [aria-haspopup][aria-controls]').forEach(b => { if (b.id !== 'ev-switch') b.setAttribute('aria-expanded', 'false'); });
}
document.addEventListener('click', e => { if (!e.target.closest('.hdr-pop-wrap')) closePopovers(); });

// Header clock: event-local time with seconds (spec 2.4).
function eventClockHMS() {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: S.event?.timezone || undefined })
      .format(new Date(correctedNow()));
  } catch { return correctedHMS(); }
}
// "Tue 6 Oct · Cairo UTC+3"
function eventSubline(ev) {
  const locale = { ar: 'ar', pl: 'pl-PL', de: 'de-DE' }[CueDeckI18n.getLocale()] || 'en-GB';
  let day = ev.date || '';
  try { day = new Date(ev.date + 'T12:00:00Z').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch { /* keep ISO date */ }
  const tz = ev.timezone || '';
  const city = tz ? tz.split('/').pop().replace(/_/g, ' ') : '';
  return [day, tz ? `${city} ${getUtcOffset(tz)}` : ''].filter(Boolean).join(' · ');
}

// The "All systems" pill turns amber or red and names the failing check.
const SYS_CHECKS = [['db', 'dbStatus'], ['rt', 'rtStatus'], ['ck', 'ckStatus'], ['ef', 'efStatus']];
function refreshSysPill() {
  const pill = document.getElementById('conn-pill');
  const lbl = document.getElementById('conn-lbl');
  if (!pill || !lbl) return;
  const failing = SYS_CHECKS.filter(([, k]) => S[k] === 'error' || S[k] === 'not-deployed').map(([n]) => n);
  let state = 'ok';
  let text = t('cc.hdr.allSystems');
  if (S.connStatus === 'reconnecting' || S.connStatus === 'offline' || failing.includes('rt')) {
    state = 'err'; text = tf('cc.hdr.problem', { name: t('cc.sys.rt') });
  } else if (failing.length) {
    state = failing.includes('db') ? 'err' : 'warn'; text = tf('cc.hdr.problem', { name: t('cc.sys.' + failing[0]) });
  } else if (SYS_CHECKS.some(([, k]) => S[k] === 'checking')) {
    state = 'warn'; text = t('cc.hdr.connecting');
  }
  pill.className = `pill is-${state}`;
  lbl.textContent = text;
}

function setBannerRead(read) {
  const el = document.getElementById('bc-banner');
  const chip = document.getElementById('bc-chip');
  if (el) el.style.display = read ? 'none' : 'flex';
  if (chip) chip.hidden = !read;
}
function reopenBanner() { S.bcReadKey = null; setBannerRead(false); }
```

Then these replacements:

`setConn`:

```js
function setConn(st) {
  S.connStatus = st;
  const dot = document.getElementById('conn-dot');
  if (dot) dot.className = 'dot ' + st;
  refreshSysPill();
}
```

`refreshClockUI`: change `document.getElementById('hdr-clock').textContent = ts;` to `document.getElementById('hdr-clock').textContent = eventClockHMS();` and delete the `sb-time` line.

`refreshDiag`:

```js
function refreshDiag() {
  for (const [k, field] of SYS_CHECKS) {
    const st = S[field];
    const dot = document.getElementById('dd-' + k);
    const lbl = document.getElementById('dl-' + k);
    if (!dot || !lbl) continue;
    dot.className = `dd ${st === 'ok' ? 'ok' : (st === 'error' || st === 'not-deployed') ? 'error' : st === 'checking' ? 'checking' : ''}`;
    const word = { ok: 'cc.sys.ok', error: 'cc.sys.down', 'not-deployed': 'cc.sys.notDeployed', checking: 'cc.sys.checking' }[st];
    lbl.textContent = word ? `${t('cc.sys.' + k)}: ${t(word)}` : t('cc.sys.' + k);
  }
  const dbLbl = document.getElementById('dl-db');
  if (dbLbl) dbLbl.title = S.lastSyncAt ? `Last sync: ${new Date(S.lastSyncAt).toLocaleTimeString()}` : 'Not yet synced';
  refreshSysPill();
}
```

`refreshPresence` (keep `const PRESENCE_ROLES` above it):

```js
function refreshPresence() {
  const bar = document.getElementById('presence-bar');
  if (!bar) return;
  const online = PRESENCE_ROLES.filter(r => (S.presence[r] || 0) > 0);
  bar.innerHTML = PRESENCE_ROLES.map(r => `<i class="${(S.presence[r] || 0) > 0 ? 'on' : ''}"></i>`).join('');
  const cnt = document.getElementById('crew-count');
  if (cnt) cnt.textContent = tf('cc.hdr.crew', { on: online.length, all: PRESENCE_ROLES.length });
  const list = document.getElementById('crew-list');
  if (list) {
    const people = (S.presenceList || []).filter(p => p.role);
    list.innerHTML = people.length
      ? people.map(p => `<li><span class="crew-dot"></span><span>${esc(p.name || '–')}</span><span class="crew-role">${esc(t('role.' + p.role))}</span></li>`).join('')
      : `<li class="crew-none">${esc(t('cc.hdr.crewNone'))}</li>`;
  }
}
```

In `subscribeControl`, in the presence `sync` handler insert before `S.presence = counts;`:

```js
      S.presenceList = Object.values(state).flat().map(e => ({ role: e.role, name: e.name || '' }));
```

and change `S.ctrlChan.track({ role: S.role, userId: S.user.id })` to `S.ctrlChan.track({ role: S.role, userId: S.user.id, name: S.userName || S.user.email })`.

`setRole`: replace the line `document.querySelectorAll('.rbtn[data-role]').forEach(b => b.classList.toggle('active', b.dataset.role === role));` with:

```js
  document.querySelectorAll('.rbtn[data-role]').forEach(b => {
    const on = b.dataset.role === role;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  const va = document.getElementById('viewas-lbl');
  if (va) va.textContent = tf('cc.hdr.viewAs', { role: t('role.' + role) });
  const bw = document.getElementById('brain-wrap');
  if (bw) bw.hidden = role !== 'director' || !(S.brainCount > 0);
```

Event switcher:

```js
function buildEvSelect(events) {
  const cur = S.event;
  const nameEl = document.getElementById('event-name');
  if (cur && nameEl) nameEl.textContent = cur.name;
  const subEl = document.getElementById('event-sub');
  if (subEl) subEl.textContent = cur ? eventSubline(cur) : '';
  const dd = document.getElementById('ev-pill-dd');
  if (!dd) return;
  const isDirector = S.userRole === 'director' || S.role === 'director';
  dd.innerHTML = events.map(e =>
    `<button type="button" role="menuitemradio" aria-checked="${e.id === cur?.id}" class="${e.id === cur?.id ? 'active' : ''}" onclick="event.stopPropagation();switchEvent('${e.id}');closeEvDropdown()">${esc(e.name)}</button>`
  ).join('') + (isDirector
    ? `<div class="hd-sep"></div>`
      + (cur ? `<button type="button" role="menuitem" onclick="event.stopPropagation();closeEvDropdown();openEvModal('edit','${cur.id}')">${icon('edit')}${esc(t('cc.hdr.editEvent'))}</button>` : '')
      + `<button type="button" role="menuitem" class="${events.length ? '' : 'rbtn-pulse'}" onclick="event.stopPropagation();closeEvDropdown();openEvModal('create')">${icon('plus')}${esc(t('cc.hdr.newEvent'))}</button>`
    : '');
}

function toggleEvDropdown() {
  closeHelpMenu();
  closePopovers();
  const dd = document.getElementById('ev-pill-dd');
  if (!dd) return;
  const open = dd.classList.toggle('open');
  document.getElementById('ev-switch')?.setAttribute('aria-expanded', String(open));
}
function closeEvDropdown() {
  document.getElementById('ev-pill-dd')?.classList.remove('open');
  document.getElementById('ev-switch')?.setAttribute('aria-expanded', 'false');
}
```

`toggleAutoStart`: after `if (btn) btn.classList.toggle('enabled', S.autoStart);` add `if (btn) btn.setAttribute('aria-checked', String(S.autoStart));`.

Banner:

```js
function showBCBanner(b) {
  const el = document.getElementById('bc-banner');
  if (!b?.message) { hideBCBanner(); return; }
  S.bcKey = `${b.sent_at || ''}|${b.message}`;
  el.className = b.priority;
  el.innerHTML = `${icon(b.priority === 'info' ? 'info' : 'alert')}<span class="bc-msg">${esc(b.message)}</span>`
    + `<span class="bc-when">${esc(tsHM(b.sent_at))}</span>`
    + `<button type="button" class="btn sm ghost bc-dismiss" onclick="dismissBanner()">${esc(t('cc.bc.dismiss'))}</button>`;
  const chip = document.getElementById('bc-chip');
  if (chip) chip.className = `pill bc-chip ${b.priority}`;
  setBannerRead(S.bcReadKey === S.bcKey);
}
function hideBCBanner() {
  document.getElementById('bc-banner').style.display = 'none';
  const chip = document.getElementById('bc-chip');
  if (chip) chip.hidden = true;
}
function dismissBanner() { S.bcReadKey = S.bcKey; setBannerRead(true); }
```

Presets (no emoji, a menu):

```js
const BC_PRESETS = [
  { label: 'Break',  text: 'Coffee break starting now' },
  { label: 'Seats',  text: 'Please take your seats, the next session is starting soon' },
  { label: 'Delay',  text: 'Running a few minutes behind schedule' },
  { label: 'Phones', text: 'Please silence your phones' },
  { label: 'Hold',   text: 'Hold, please stand by' },
];

function buildBCPresets() {
  const wrap = document.getElementById('bc-presets');
  if (!wrap) return;
  const isDirector = S.role === 'director' || S.userRole === 'director';
  if (!isDirector) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<details class="bc-presets-menu" id="bc-presets-menu">
    <summary class="btn sm">${esc(t('cc.bc.presets'))}${icon('chev-down')}</summary>
    <div class="hdr-menu bc-presets-list" role="menu">${BC_PRESETS.map((p, i) =>
      `<button type="button" role="menuitem" class="bc-preset-btn" onclick="fillPreset(BC_PRESETS[${i}].text);document.getElementById('bc-presets-menu').open=false">${esc(p.label)}</button>`).join('')}</div>
  </details>`;
}
```

`sendBroadcast`: insert after `if (!msg || !S.event) return;`:

```js
  // Critical needs a second press within 3 s (spec 2.9); info and warn send at once.
  const sendBtn = document.getElementById('bc-send');
  if (pri === 'critical' && !_sendCritical.armed) {
    _sendCritical.armed = true;
    if (sendBtn) { sendBtn.classList.add('confirm-pending'); sendBtn.textContent = t('cc.bc.pressAgain'); }
    _sendCritical.timer = setTimeout(() => {
      _sendCritical.armed = false;
      if (sendBtn) { sendBtn.classList.remove('confirm-pending'); sendBtn.textContent = t('cc.bc.send'); }
    }, 3000);
    return;
  }
  clearTimeout(_sendCritical.timer);
  _sendCritical.armed = false;
  if (sendBtn) { sendBtn.classList.remove('confirm-pending'); sendBtn.textContent = t('cc.bc.send'); }
```

and declare `const _sendCritical = { armed: false, timer: null };` directly above `async function sendBroadcast()`. In `clearBroadcast`, change `btn.textContent = 'CONFIRM CLEAR'` to `btn.textContent = t('confirm.confirmClear')` and both `btn.textContent = 'CLEAR'` to `btn.textContent = t('cc.bc.clear')`.

`renderUserChip` (neutral avatar, no per-role colours):

```js
function renderUserChip() {
  const chip = document.getElementById('user-chip');
  if (!chip || !S.userRole) return;
  const name  = S.userName || S.user?.email || '';
  const words = name.trim().split(/\s+/);
  const initials = words.length >= 2 ? (words[0][0] + words[words.length - 1][0]).toUpperCase() : (name.substring(0, 2) || '??').toUpperCase();
  document.getElementById('user-chip-avatar').textContent = initials;
  document.getElementById('user-chip-name').textContent = words[0] || name;
  document.getElementById('user-chip-role').textContent = S.userRole;
  chip.style.display = 'inline-flex';
  const mob = document.getElementById('mobile-signed-in');
  if (mob) mob.textContent = 'Signed in as ' + name + ' (' + S.userRole + ')';
}
```

`toggleProfilePanel`: after `panel.style.display = '';` add `document.getElementById('user-chip')?.setAttribute('aria-expanded', 'true');`. `closeProfilePanel`: add `document.getElementById('user-chip')?.setAttribute('aria-expanded', 'false');`.

`loadSubscription`: delete the block `// Show billing button for directors` with its `if (S.userRole === 'director') { document.getElementById('billing-btn').style.display = ''; }` (Billing now lives in the account menu and `renderProfilePanel` shows it).

`loadUserRole`: replace the `// Lock role switcher for non-directors` block with:

```js
  // Operators locked to one role see their role name, not the View as menu
  if (data.role !== 'director') {
    const va = document.getElementById('viewas-btn');
    if (va) va.hidden = true;
    const lock = document.getElementById('role-lock');
    if (lock) { lock.textContent = t('role.' + data.role); lock.hidden = false; }
  }
```

`loadBrainInsights`: after `const insights = Array.isArray(json.insights) ? json.insights : [];` add:

```js
      S.brainCount = insights.length;
      const badge = document.getElementById('brain-wrap');
      if (badge) badge.hidden = insights.length === 0 || S.role !== 'director';
      const count = document.getElementById('brain-count');
      if (count) count.textContent = insights.length ? String(insights.length) : '';
```

and at the start of its `catch (_) {` block add `S.brainCount = 0; const bw = document.getElementById('brain-wrap'); if (bw) bw.hidden = true;`.

`ROLE_TIPS.director`: change `target: '#users-btn'` to `target: '#user-chip'`.

Escape branch of the `keydown` handler: after `closeProfilePanel();` add `closePopovers(); closeEvDropdown();`.

- [ ] **Step 6: Strings.** Add these lines to each language block of `cuedeck-i18n.js`, immediately before the block's closing `    },` (en block ends before `\n\n    ar: {`, ar before `\n\n    pl: {`, pl before `\n\n    de: {`, de before `\n  };`):

| Key | en | ar | pl | de |
|---|---|---|---|---|
| `cc.hdr.allSystems` | All systems | كل الأنظمة تعمل | Wszystkie systemy działają | Alle Systeme laufen |
| `cc.hdr.problem` | {name} not working | {name} لا يعمل | {name} nie działa | {name} gestört |
| `cc.hdr.connecting` | Connecting | جارٍ الاتصال | Łączenie | Verbinde |
| `cc.hdr.crew` | Crew {on}/{all} | الطاقم {on}/{all} | Ekipa {on}/{all} | Crew {on}/{all} |
| `cc.hdr.crewTitle` | Crew online | الطاقم المتصل | Ekipa online | Crew online |
| `cc.hdr.crewNone` | No one else is online | لا أحد متصل | Nikt inny nie jest online | Sonst ist niemand online |
| `cc.hdr.viewAs` | View as {role} | العرض كـ {role} | Widok: {role} | Ansicht: {role} |
| `cc.hdr.newEvent` | New event | حدث جديد | Nowe wydarzenie | Neue Veranstaltung |
| `cc.hdr.editEvent` | Edit event | تعديل الحدث | Edytuj wydarzenie | Veranstaltung bearbeiten |
| `cc.hdr.brain` | AVE Brain | AVE Brain | AVE Brain | AVE Brain |
| `cc.sys.title` | System status | حالة النظام | Stan systemu | Systemstatus |
| `cc.sys.db` | Database | قاعدة البيانات | Baza danych | Datenbank |
| `cc.sys.rt` | Realtime | الاتصال الفوري | Czas rzeczywisty | Echtzeit |
| `cc.sys.ck` | Clock sync | مزامنة الساعة | Synchronizacja zegara | Uhrzeit-Sync |
| `cc.sys.ef` | Edge Functions | وظائف الخادم | Funkcje serwera | Serverfunktionen |
| `cc.sys.ok` | OK | يعمل | OK | OK |
| `cc.sys.down` | not working | لا يعمل | nie działa | gestört |
| `cc.sys.checking` | checking | جارٍ الفحص | sprawdzanie | wird geprüft |
| `cc.sys.notDeployed` | not deployed | غير منشورة | nie wdrożone | nicht bereitgestellt |
| `cc.sys.clock` | Clock | الساعة | Zegar | Uhr |
| `cc.sys.offset` | Offset | الفرق | Przesunięcie | Abweichung |
| `cc.sys.rtt` | Round trip | زمن الاستجابة | Opóźnienie | Laufzeit |
| `cc.sys.synced` | Last sync | آخر مزامنة | Ostatnia synchronizacja | Letzter Abgleich |
| `cc.sys.sessions` | Sessions | الجلسات | Sesje | Sitzungen |
| `cc.menu.checkin` | Check-in | تسجيل الحضور | Rejestracja | Check-in |
| `cc.menu.team` | Team | الفريق | Zespół | Team |
| `cc.menu.billing` | Billing | الفوترة | Płatności | Abrechnung |
| `cc.menu.invoices` | Invoices | الفواتير | Faktury | Rechnungen |
| `cc.menu.upgrade` | Upgrade plan | ترقية الخطة | Zmień plan | Tarif upgraden |
| `cc.menu.language` | Language | اللغة | Język | Sprache |
| `cc.menu.shortcuts` | Shortcuts | الاختصارات | Skróty | Tastenkürzel |
| `cc.menu.autoStart` | Auto-start | البدء التلقائي | Autostart | Autostart |
| `cc.menu.tools` | Tools | أدوات | Narzędzia | Werkzeuge |
| `cc.menu.testIncident` | Test incident alert | اختبار تنبيه حادث | Testowy alert incydentu | Störungsalarm testen |
| `cc.menu.testCue` | Test cue alert | اختبار تنبيه الإشارة | Testowy alert sygnału | Cue-Alarm testen |
| `cc.menu.report` | Generate report | إنشاء تقرير | Utwórz raport | Bericht erstellen |
| `cc.menu.signOut` | Sign out | تسجيل الخروج | Wyloguj | Abmelden |
| `cc.bc.label` | Broadcast | رسالة عامة | Komunikat | Durchsage |
| `cc.bc.send` | Send | إرسال | Wyślij | Senden |
| `cc.bc.clear` | Clear | مسح | Wyczyść | Löschen |
| `cc.bc.presets` | Presets | رسائل جاهزة | Szablony | Vorlagen |
| `cc.bc.pressAgain` | Press again to send | اضغط مرة أخرى للإرسال | Naciśnij ponownie, aby wysłać | Zum Senden erneut drücken |
| `cc.bc.show` | Show broadcast | عرض الرسالة | Pokaż komunikat | Durchsage anzeigen |
| `cc.bc.dismiss` | Dismiss | إخفاء | Ukryj | Ausblenden |

Each row becomes one line per block in the file's style, for example in `en`: `      'cc.hdr.allSystems': 'All systems',`.

- [ ] **Step 7: `translateStaticDOM()`** in `cuedeck-i18n.js`: in `map`, delete `'#role-bar > label': 'role.label',` and `'#bc-bar > label': 'bc.label',`, change `'#users-btn': 'hdr.operators',` to `'#users-btn .pp-label': 'cc.menu.team',` and `'#help-btn': 'hdr.help',` to `'#help-btn > span:not(.changelog-badge)': 'hdr.help',`. Replace the help-dropdown loop with:

```js
    document.querySelectorAll('#help-dropdown .hd-label').forEach(label => {
      const key = helpItems[label.textContent.trim()];
      if (key) label.textContent = t(key);
    });
```

Delete the `// Broadcast bottom bar buttons` loop (the buttons carry `data-i18n` now), the `"BROADCAST" label` loop, the `// Diagnostic bar pills` loop, the `// Diagnostic "sessions: N" and "live" label` block and the `// EVENT label` loop.

- [ ] **Step 8: Tests that select on the removed role bar (same commit).** Add after `bypassOverlay` in `tests/e2e/console-ui.spec.ts` and after the equivalent helper in `tests/e2e/auth-flows.spec.ts`:

```ts
/** The role switch lives in the header "View as" menu (redesign stage 3). */
async function viewAs(page: Page, role: string) {
  await page.locator('#viewas-btn').click();
  await page.locator(`.rbtn[data-role="${role}"]`).click();
}
```

(`auth-flows.spec.ts` imports `type Page` from `@playwright/test` if it does not already). Then run:

```bash
node -e '
const fs=require("fs");
for (const f of ["tests/e2e/console-ui.spec.ts","tests/e2e/auth-flows.spec.ts"]) {
  let s=fs.readFileSync(f,"utf8"); const n0=s.length;
  s=s.replace(/await page\.locator\(\x27\.rbtn\[data-role="(\w+)"\]\x27\)\.click\(\);/g,"await viewAs(page, \x27$1\x27);");
  s=s.replace(/await page\.locator\(`\.rbtn\[data-role="\$\{role\}"\]`\)\.click\(\);/g,"await viewAs(page, role);");
  fs.writeFileSync(f,s); console.log(f, n0===s.length?"unchanged":"updated");
}'
```

In `console-ui.spec.ts` test 06 replace the body after `bypassOverlay(page);` with:

```ts
    await viewAs(page, 'signage');
    await expect(page.locator('.rbtn[data-role="signage"]')).toHaveClass(/active/);
```

In `session-management.spec.ts` line 221 change `await expect(page.locator('.rbtn[data-role="director"]')).toBeVisible({ timeout: 5000 });` to `await expect(page.locator('#viewas-btn')).toBeVisible({ timeout: 5000 });`.

- [ ] **Step 9: Run.**

```bash
npx vitest run
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-header.spec.ts tests/e2e/console-ui.spec.ts tests/e2e/auth-flows.spec.ts tests/e2e/session-management.spec.ts tests/e2e/ai-agents.spec.ts
```

Expected: vitest passes after you set the ratchet `BUDGET` to the printed count (it drops: the role colour map and header literals are gone); header 9 passed; the others pass.

- [ ] **Step 10: Baselines.** `--update-snapshots` on the visual suite; review: one 52 px header with event name and "Tue 6 Oct · Cairo UTC+3", masked clock, "All systems", "Crew 3/5", "View as director", Help and avatar; no diagnostics strip or role bar; sidebar without AI buttons and server clock; composer 52 px with Presets, Send and Clear. The `stage-1440` and `av-1440` baselines show the role name pill instead of View as. Full console suite `0 failed`.

- [ ] **Step 11: Commit.**

```bash
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-header.spec.ts tests/console-i18n-keys.spec.ts tests/e2e/console-ui.spec.ts tests/e2e/auth-flows.spec.ts tests/e2e/session-management.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): new header; diagnostics and role bar fold into it; AI tools move to the account menu

Event switcher button, event-local clock, All systems pill with a status
popover, crew presence, View as for directors, account menu with Tools,
broadcast banner that collapses to a chip, composer with a presets menu and
a two-press critical send.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-header.spec.ts tests/console-i18n-keys.spec.ts tests/e2e/console-ui.spec.ts tests/e2e/auth-flows.spec.ts tests/e2e/session-management.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 3.2: Compact list

**Files:**
- Modify `cuedeck-console.html`:
  - CSS: delete the old card rules: `/* ── SESSION CARDS ── */` `.sc`, `.sc:focus`, `.sc:focus-visible`, the per-status `.sc.status-*` rules, `.sc-top`, `.sc-num`, `.sc-title`, `.sc.status-CANCELLED .sc-title`, `.sc-meta`, `.sc-meta .spk`, `.sc-meta > span:not(.spk):not([style])`, `.sc-times`, `.tc`, `.tv`, `.tv.late`, `.delay-tag`, `.prog-wrap`, `.prog-fill`, `.prog-fill.ov`, `.live-timer`, `.lt-elapsed`, `.lt-remain`, `.lt-remain.ov`, `.arrived-tag`, `.sc.warn-amber`, `.sc.warn-red`, `.lt-remain.warn-*`, `.sc-notes-toggle*`, `.sc-notes-body*`, `.sc-mgmt`, `.sc-mgmt-btn*`, the `#delay-strip` rules, `.sc.delayed`, `.sc.delay-origin`, `.delay-break*`, `.next-up-label`, `#filter-bar`, the RTL `.sc*`/`.delay-tag` lines, the mobile `.sc-times`/`.sc-top`/`.sc-meta`/`.sc-actions` lines and the coarse-pointer `.sc-mgmt-btn`/`.sc-actions` lines; append `/* ═══ Command center compact list (stage 3) ═══ */`.
  - HTML: `<div id="filter-bar">` (2037) and the `#sessions-col` children (2045-2053).
  - JS: `S` (2592, new fields), `renderSessions()` from `const list = document.getElementById('sessions-list');` to its end (3509-3581), `cardHTML()` (3816-3898, deleted and replaced by `rowHTML()`), `handleCardKey()` (3948-3956), `updateDelayStrip()` (3755-3777), `buildFilterBar()` (5487-5513), `toggleNotes()` (5242-5246, deleted), `renderTimeline()` (delete the line `document.getElementById('delay-strip').style.display = 'none';`), the signage branch of `renderSessions()` (same line).
- Modify `cuedeck-i18n.js`: keys in Step 6; in `translateStaticDOM()` delete the `// Filter bar Clear All button` and `// View toggle pills` blocks.
- Create `tests/e2e/console-list.spec.ts`. Modify `tests/e2e/console-restart.spec.ts`, `tests/e2e/auth-flows.spec.ts` (test 24), `tests/console-colour-ratchet.spec.ts`.

**Interfaces:**
- Consumes: `statusBadge`, `chipHTML`, `icon`, `tf`, `hm`, `sessionSpan`, `FINISHED`, `getNextSession`, `_endPending`, `_cancelPending`, `confirmEnd`, `confirmCancel`, `transition`, `buildButtons`, `applyFilters`, `F`.
- Produces JS (used by 4.1, 4.2, 5.1): `canDo(s, to)`, `ACTION_ORDER`, `primaryTransition(s)`, `actionLabel(from, to)`, `transitionButtonHTML(s, to, size, fk)`, `primaryButtonHTML(s, size, fk)`, `endButtonHTML(s, size, fk)`, `cancelButtonHTML(s, size, fk)`, `liveTiming(s, nowMs)`, `countdownLabel(s, nowMs)` returning `{ text, cls, big, unit }`, `people(s)`, `speakerLine(s)`, `speakerShort(s)`, `flagsHTML(s)`, `subLine(s, showNote)`, `rowHTML(s, nowMs, ctx)`, `foldRowHTML(kind, list, open)`, `toggleFold(kind)`, `selectSession(id)`, `toggleEditMode()`, `focusKey()`, `restoreFocus(fk)`; state `S.selectedId`, `S.foldOpen`, `S.editMode`, `S.listOpened`.
- Produces CSS: `.sc` row grid, `.sc-badge .sc-num .sc-main .sc-title-line .sc-title .sc-sub .sc-spk .sc-flag .sc-arrived .sc-notefirst .sc-room .sc-time .sc-delay .sc-act .sc-tools .sc-drawer .sc-notes-full .sc-fold .sc-anchor .sc-addrow`, `.is-selected`, `body.edit-mode`, `#fb-controls`, `.delay-chip`.

- [ ] **Step 1: Failing tests.** Create `tests/e2e/console-list.spec.ts`:

```ts
// tests/e2e/console-list.spec.ts
// Spec 2.2: 56 px rows on a fixed grid, left edge = status, finished
// sessions folded, HH:MM times, one primary action, tools on hover, selection.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, ID, PANEL_ID, longTitleSessions } from './console-boot-mock';

test('list: rows are 56 px on a seven-column grid and the left edge is the status colour', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const row = page.locator(`#card-${ID(6)}`);
  expect(Math.round((await row.boundingBox())!.height)).toBe(56);
  expect((await row.evaluate(el => getComputedStyle(el).gridTemplateColumns)).split(' ')).toHaveLength(7);
  expect(await row.evaluate(el => [getComputedStyle(el).borderLeftWidth, getComputedStyle(el).borderLeftColor])).toEqual(['4px', 'rgb(148, 163, 184)']);
  // a delayed READY row keeps the READY edge: delay never recolours it
  expect(await page.locator(`#card-${ID(5)}`).evaluate(el => getComputedStyle(el).borderLeftColor)).toBe('rgb(52, 211, 153)');
  expect(await page.locator(`#card-${ID(2)}`).evaluate(el => getComputedStyle(el).borderLeftStyle)).toBe('dashed');
  await ctx.close();
});

test('list: finished sessions fold into one row at each end and expand on click', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const first = page.locator('#sessions-list > *').first();
  await expect(first).toHaveClass(/sc-fold/);
  await expect(first).toContainText('1 completed');
  expect(Math.round((await first.boundingBox())!.height)).toBe(34);
  await expect(page.locator(`#card-${ID(1)}`)).toHaveCount(0);
  await expect(page.locator('#sessions-list .sc-fold').last()).toContainText('1 cancelled');
  await first.click();
  await expect(page.locator(`#card-${ID(1)}`)).toBeVisible();
  await expect(page.locator('#sessions-list .sc-fold').first()).toHaveAttribute('aria-expanded', 'true');
  await ctx.close();
});

test('list: times are HH:MM, a delayed row shows the original time, running rows count', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator(`#card-${ID(6)} .sc-time`)).toContainText('13:35–14:20');
  await expect(page.locator(`#card-${ID(6)} .sc-time small`)).toHaveText('was 13:30');
  await expect(page.locator(`#card-${ID(6)} .sc-delay`)).toHaveText('+5');
  await expect(page.locator(`#card-${PANEL_ID} .sc-time`)).toContainText('19:15 left');
  await expect(page.locator(`#card-${ID(2)} .sc-time`)).toContainText('held 9:45');
  expect(await page.locator('#sessions-list').innerText()).not.toMatch(/\b\d\d:\d\d:\d\d\b/);
  await expect(page.locator(`#card-${PANEL_ID} .sc-notefirst`)).toContainText('Moderator opens with audience poll.');
  await expect(page.locator('#sessions-list .sc-anchor')).toContainText('Delay stops here');
  await ctx.close();
});

test('list: one primary action per row that follows the action colour rule', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const expectAct = async (id: string, text: string, cls: RegExp) => {
    const btn = page.locator(`#card-${id} .sc-act button`);
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveText(text);
    await expect(btn).toHaveClass(cls);
  };
  await expectAct(ID(6), 'Set ready', /fwd-ready/);
  await expectAct(ID(5), 'Call speaker', /fwd-calling/);
  await expectAct(ID(4), 'On stage', /fwd-go/);
  await expectAct(PANEL_ID, 'End…', /danger/);
  await expectAct(ID(2), 'Resume', /fwd-go/);
  await ctx.close();
});

test('list: av gets no End in the row; stage gets End', async ({ browser }) => {
  for (const [role, n] of [['av', 0], ['stage', 1]] as const) {
    const { ctx, page } = await openConsole(browser, { role });
    await expect(page.locator(`#card-${PANEL_ID} .sc-act button.danger`)).toHaveCount(n);
    await ctx.close();
  }
});

test('list: editing tools show on hover or in edit mode only', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const tools = page.locator(`#card-${ID(6)} .sc-tools`);
  await expect(tools).toBeHidden();
  await page.locator(`#card-${ID(6)}`).hover();
  await expect(tools).toBeVisible();
  await page.locator('#edit-mode-btn').click();
  await expect(page.locator('#edit-mode-btn')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(5, 5);
  await expect(page.locator(`#card-${ID(7)} .sc-tools`)).toBeVisible();
  await ctx.close();
});

test('list: click, Enter and arrow keys select a row', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator(`#card-${ID(4)} .sc-title`).click();
  await expect(page.locator(`#card-${ID(4)}`)).toHaveClass(/is-selected/);
  await page.locator(`#card-${ID(4)}`).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`#card-${ID(5)}`)).toHaveClass(/is-selected/);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(`card-${ID(5)}`);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  expect(await evalPage(page, 'S.selectedId')).toBe(ID(4));
  await ctx.close();
});

test('list: the delay chip sits in the filter row', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#filter-bar #delay-strip')).toBeVisible();
  await expect(page.locator('#delay-strip')).toContainText('Running +5 min · 2 affected · stops at #7');
  await expect(page.locator('#ds-reset-btn')).toBeVisible();
  await ctx.close();
});

test('list: a 140-character title and nine speakers stay inside the row', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: longTitleSessions() });
  const row = page.locator(`#card-${PANEL_ID}`);
  expect(Math.round((await row.boundingBox())!.height)).toBe(56);
  const rb = (await row.boundingBox())!;
  const ab = (await row.locator('.sc-act button').boundingBox())!;
  expect(ab.x + ab.width).toBeLessThanOrEqual(rb.x + rb.width);
  expect(await row.locator('.sc-title').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure.** `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-list.spec.ts`. Expected: 9 failed (cards are 150 px tall, no `.sc-fold`, no `.sc-act`).

- [ ] **Step 3: Markup.** Replace `<div id="filter-bar"><!-- populated by buildFilterBar() --></div>` with:

```html
<div id="filter-bar"><div id="fb-controls"></div><span class="fb-spacer"></span><div id="delay-strip" hidden></div></div>
```

In `#sessions-col` delete `<div id="delay-strip" style="display:none"></div>` and change the loading placeholder `<div class="ei">📋</div>` to `<div class="ei"><svg class="ico" aria-hidden="true" focusable="false"><use href="#i-list"/></svg></div>`.

- [ ] **Step 4: JS.** In `const S = {` add after `viewMode:` line:

```js
  selectedId:      null,   // session shown in the row drawer (stage 3) / inspector (stage 4)
  foldOpen:        { ENDED: false, CANCELLED: false },
  editMode:        false,  // "Edit run of show": editing tools on every row
  listOpened:      false,  // first render scrolls to the first unfinished row
```

Add a section under the header section from Task 3.1:

```js
// ═══════════════════════════════════════════════════
// COMMAND CENTER: compact list (stage 3)
// ═══════════════════════════════════════════════════
// Keep keyboard focus across the 1 s re-render: interactive elements carry data-fk.
function focusKey() { return document.activeElement?.closest?.('[data-fk]')?.dataset.fk || null; }
function restoreFocus(fk) {
  if (!fk) return;
  const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
  if (el && el !== document.activeElement) el.focus({ preventScroll: true });
}

function canDo(s, to) {
  return (ALLOWED[s.status] || []).includes(to) && (ROLE_WRITE[S.role] || []).includes(to);
}
// The next legal transition, in order of preference (spec 2.2).
const ACTION_ORDER = { PLANNED: ['READY'], READY: ['CALLING', 'LIVE'], CALLING: ['LIVE'], LIVE: ['ENDED'], OVERRUN: ['ENDED'], HOLD: ['LIVE'], CANCELLED: ['PLANNED'], ENDED: [] };
function primaryTransition(s) { return (ACTION_ORDER[s.status] || []).find(to => canDo(s, to)) || null; }
const ACTION_KEYS = {
  'PLANNED>READY': 'cc.act.setReady', 'READY>CALLING': 'cc.act.call', 'READY>LIVE': 'cc.act.goLive',
  'CALLING>LIVE': 'cc.act.onStage', 'HOLD>LIVE': 'cc.act.resume', 'CANCELLED>PLANNED': 'cc.act.reinstate',
  'LIVE>HOLD': 'cc.act.hold', 'OVERRUN>HOLD': 'cc.act.hold', 'CALLING>HOLD': 'cc.act.hold',
  'CALLING>READY': 'cc.act.backToReady', 'HOLD>READY': 'cc.act.backToReady', 'HOLD>CALLING': 'cc.act.call',
  'READY>PLANNED': 'cc.act.backToPlanned',
};
function actionLabel(from, to) { const k = ACTION_KEYS[from + '>' + to]; return k ? t(k) : t('status.' + to); }
// Action colours (controller ruling): Set ready and anything that puts a session on
// stage are green, Call speaker is yellow; red is only for End/Cancel and the armed state.
const FWD_CLASS = { READY: 'fwd fwd-ready', CALLING: 'fwd fwd-calling', LIVE: 'fwd fwd-go' };
function transitionButtonHTML(s, to, size, fk) {
  if (to === 'ENDED') return endButtonHTML(s, size, fk);
  if (to === 'CANCELLED') return cancelButtonHTML(s, size, fk);
  const forward = ['READY', 'CALLING', 'LIVE'].includes(to) && !(s.status === 'HOLD' && to !== 'LIVE');
  const cls = to === 'HOLD' ? 'hold' : forward ? FWD_CLASS[to] : '';
  return `<button type="button" class="btn ${size} ${cls}" data-fk="${fk}-${to}-${s.id}" onclick="event.stopPropagation();transition('${s.id}','${to}')">${to === 'HOLD' ? icon('pause') : ''}${esc(actionLabel(s.status, to))}</button>`;
}
function primaryButtonHTML(s, size, fk) {
  const to = primaryTransition(s);
  return to ? transitionButtonHTML(s, to, size, fk) : '';
}
// Two-press End and Cancel: the armed state comes from the safety branch's maps.
function endButtonHTML(s, size, fk) {
  if (!canDo(s, 'ENDED')) return '';
  const armed = _endPending.has(s.id);
  return `<button type="button" class="btn ${size} danger${armed ? ' confirm-pending' : ''}" data-fk="${fk}-end-${s.id}" onclick="event.stopPropagation();confirmEnd('${s.id}',this)">${esc(armed ? t('confirm.confirmEnd') : t('cc.act.end'))}</button>`;
}
function cancelButtonHTML(s, size, fk) {
  if (!canDo(s, 'CANCELLED')) return '';
  const armed = _cancelPending.has(s.id);
  return `<button type="button" class="btn ${size} danger${armed ? ' confirm-pending' : ''}" data-fk="${fk}-cancel-${s.id}" onclick="event.stopPropagation();confirmCancel('${s.id}',this)">${esc(armed ? t('confirm.confirmCancel') : t('cc.act.cancel'))}</button>`;
}

function liveTiming(s, nowMs) {
  if (!s.actual_start) return null;
  const elapsed = nowMs - new Date(s.actual_start).getTime();
  const durMs = (toMins(s.scheduled_end) - toMins(s.scheduled_start)) * 60_000;
  const remain = durMs - elapsed;
  return { elapsed, durMs, remain, overrun: remain < 0, pct: Math.max(0, Math.min(100, (elapsed / Math.max(1, durMs)) * 100)) };
}
// "19:57 left", "+10:02 over", "held 3:12"; null when the session is not running.
function countdownLabel(s, nowMs) {
  if (s.status === 'LIVE' || s.status === 'OVERRUN') {
    const tm = liveTiming(s, nowMs);
    if (!tm) return null;
    if (tm.overrun || s.status === 'OVERRUN') {
      const over = fmtDur(Math.min(tm.remain, 0));
      return { text: tf('cc.time.over', { time: over }), cls: 'is-over', big: '+' + over, unit: t('cc.time.overUnit') };
    }
    return { text: tf('cc.time.left', { time: fmtDur(tm.remain) }), cls: 'is-live', big: fmtDur(tm.remain), unit: t('cc.time.leftUnit') };
  }
  if (s.status === 'HOLD') {
    if (!s.state_changed_at) return { text: t('cc.time.onHold'), cls: 'is-held', big: '–', unit: t('cc.time.onHold') };
    const held = fmtDur(Math.max(0, nowMs - new Date(s.state_changed_at).getTime()));
    return { text: tf('cc.time.held', { time: held }), cls: 'is-held', big: held, unit: t('cc.time.onHold') };
  }
  return null;
}

function people(s) { return Array.isArray(s.people) ? s.people.filter(p => p && p.name) : []; }
function speakerLine(s) { const p = people(s); return p.length ? peopleSummary(p) : (s.speaker || ''); }
// "Dina Farouk (moderator) +3"
function speakerShort(s) {
  const p = people(s);
  if (p.length > 1) {
    const lead = p.find(x => x.role === 'moderator') || p[0];
    return `${lead.name}${lead.role === 'moderator' ? ` (${t('cc.list.moderator')})` : ''} +${p.length - 1}`;
  }
  return p.length ? p[0].name : (s.speaker || '');
}
function flagsHTML(s) {
  const f = [];
  if (s.mics > 0)       f.push(`<span class="sc-flag" title="${esc(t('cc.flag.mics'))}">${icon('mic')}${s.mics}</span>`);
  if (s.recording)      f.push(`<span class="sc-flag">${icon('rec')}${esc(t('cc.flag.rec'))}</span>`);
  if (s.streaming)      f.push(`<span class="sc-flag">${icon('stream')}${esc(t('cc.flag.stream'))}</span>`);
  if (s.interpretation) f.push(`<span class="sc-flag">${icon('globe')}${esc((s.languages || []).join('/'))}</span>`);
  if (s.remote)         f.push(`<span class="sc-flag">${icon('remote')}${esc(t('cc.flag.remote'))}</span>`);
  return f.join('');
}
function subLine(s, showNote) {
  const spk = speakerLine(s);
  const arrived = s.speaker_arrived && spk ? `<span class="sc-flag sc-arrived">${icon('check')}${esc(t('cc.list.arrived'))}</span>` : '';
  const note = s.notes && s.notes.trim()
    ? (showNote
        ? `<span class="sc-flag sc-notefirst">${icon('note')}${esc(s.notes.trim().split('\n')[0])}</span>`
        : `<span class="sc-flag" title="${esc(t('cc.list.note'))}">${icon('note')}</span>`)
    : '';
  return `${spk ? `<span class="sc-spk">${esc(spk)}</span>` : ''}${arrived}${flagsHTML(s)}${note}`;
}

function rowHTML(s, nowMs, ctx) {
  const isDirector = S.role === 'director' || S.userRole === 'director';
  const sel = S.selectedId === s.id;
  const cd = countdownLabel(s, nowMs);
  const delayed = (s.cumulative_delay || 0) > 0;
  const timeCell = cd
    ? `<span class="sc-time ${cd.cls}" data-timer>${esc(cd.text)}<small>${sessionSpan(s)}</small></span>`
    : `<span class="sc-time">${sessionSpan(s)}${delayed ? `<small>${esc(tf('cc.list.was', { time: hm(s.planned_start) }))}</small>` : ''}</span>`;
  const tools = isDirector ? `<span class="sc-tools" onclick="event.stopPropagation()">
      <input type="checkbox" class="batch-chk" data-sid="${s.id}" aria-label="${esc(tf('cc.list.selectFor', { title: s.title }))}" onclick="toggleBatchSelect('${s.id}',this.checked)" ${_batchSelected.has(s.id) ? 'checked' : ''}>
      <button type="button" class="btn ghost sm icon-only" data-fk="up-${s.id}" title="${esc(t('cc.list.moveUp'))}" aria-label="${esc(t('cc.list.moveUp'))}" onclick="reorderSession('${s.id}','up')">${icon('arrow-up')}</button>
      <button type="button" class="btn ghost sm icon-only" data-fk="down-${s.id}" title="${esc(t('cc.list.moveDown'))}" aria-label="${esc(t('cc.list.moveDown'))}" onclick="reorderSession('${s.id}','down')">${icon('arrow-down')}</button>
      <button type="button" class="btn ghost sm icon-only" data-fk="edit-${s.id}" title="${esc(t('cc.list.edit'))}" aria-label="${esc(t('cc.list.edit'))}" onclick="openSessModal('edit','${s.id}')">${icon('edit')}</button>
    </span>` : '';
  const showNote = ctx.liveIds.has(s.id) || ctx.nextIds.has(s.id);
  const drawer = sel
    ? `<div class="sc-drawer" onclick="event.stopPropagation()">${buildButtons(s)}${s.notes && s.notes.trim() ? `<div class="sc-notes-full">${esc(s.notes)}</div>` : ''}</div>`
    : '';
  return `<div class="sc status-${s.status}${sel ? ' is-selected' : ''}" id="card-${s.id}" tabindex="0" data-fk="row-${s.id}"
      aria-label="${esc(s.title)}, ${esc(t('status.' + s.status))}"${sel ? ' aria-current="true"' : ''}
      onclick="selectSession('${s.id}')" onkeydown="handleCardKey(event,'${s.id}')">
    <span class="sc-badge">${statusBadge(s.status)}</span>
    <span class="sc-num">${s.sort_order}</span>
    <span class="sc-main">
      <span class="sc-title-line"><span class="sc-title" title="${esc(s.title)}">${esc(s.title)}</span>${tools}</span>
      <span class="sc-sub">${subLine(s, showNote)}</span>
    </span>
    <span class="sc-room">${s.room ? chipHTML('room', s.room) : ''}</span>
    ${timeCell}
    <span class="sc-delay">${delayed ? '+' + s.cumulative_delay : ''}</span>
    <span class="sc-act">${primaryButtonHTML(s, 'md', 'rowact')}</span>
    ${drawer}
  </div>`;
}

function foldRowHTML(kind, list, open) {
  const label = tf(kind === 'ENDED' ? 'cc.list.completed' : 'cc.list.cancelled', { n: list.length });
  return `<button type="button" class="sc-fold" data-fk="fold-${kind}" aria-expanded="${!!open}" onclick="toggleFold('${kind}')">${icon('chev-right')}<span>${esc(label)}</span></button>`;
}
function toggleFold(kind) { S.foldOpen[kind] = !S.foldOpen[kind]; renderSessions(); }

function selectSession(id) {
  S.selectedId = S.selectedId === id ? null : id;   // stage 3: second click closes the drawer
  renderSessions();
}
function toggleEditMode() {
  S.editMode = !S.editMode;
  document.body.classList.toggle('edit-mode', S.editMode);
  buildFilterBar();
  renderSessions();
}
```

Replace `renderSessions()` from `const list    = document.getElementById('sessions-list');` to the end of the function with:

```js
  const list    = document.getElementById('sessions-list');
  const visible = applyFilters();
  const total   = S.sessions.length;
  const fk      = focusKey();
  const isDirector = S.role === 'director' || S.userRole === 'director';

  const diCnt = document.getElementById('di-cnt');
  if (diCnt) diCnt.textContent = visible.length;
  const cntEl    = document.getElementById('fb-count');
  const clearBtn = document.getElementById('fb-clear');
  if (cntEl) {
    const active = isFilterActive() && visible.length < total;
    cntEl.textContent = active ? `${visible.length} of ${total}` : '';
    cntEl.className   = active ? 'filtered' : '';
  }
  if (clearBtn) clearBtn.classList.toggle('visible', isFilterActive());

  if (!total) {
    list.innerHTML = `<div id="empty">
      <div class="ei">${icon('calendar')}</div>
      <h2>No sessions yet</h2>
      <p>Add your first session to get started with this event.</p>
      ${isDirector ? `<div class="sc-addrow">
        <button type="button" class="btn md primary" onclick="openSessModal('add')">${icon('plus')}${esc(t('cc.list.addSession'))}</button>
        <button type="button" class="btn md import-btn" onclick="triggerCSVImport()" title="Import sessions from CSV">${icon('upload')}${esc(t('cc.list.importCsv'))}</button>
      </div>` : ''}
    </div>`;
    updateDelayStrip(); buildCtxPanel();
    return;
  }
  if (!visible.length) {
    list.innerHTML = `<div id="empty">
      <div class="ei">${icon('search')}</div>
      <h2>No sessions match the filters</h2>
      <p>Try adjusting or clearing the filters.</p>
      <button type="button" class="btn sm" onclick="clearFilters()">${esc(t('filter.clearAll'))}</button>
    </div>`;
    updateDelayStrip(); buildCtxPanel();
    return;
  }

  const nowMs = correctedNow();
  const current = S.sessions.filter(s => ['LIVE', 'OVERRUN', 'HOLD'].includes(s.status));
  const ctx = {
    liveIds: new Set(current.map(s => s.id)),
    nextIds: new Set(current.map(s => getNextSession(S.sessions, s)?.id).filter(Boolean)),
  };
  const ended     = visible.filter(s => s.status === 'ENDED');
  const cancelled = visible.filter(s => s.status === 'CANCELLED');
  const open      = visible.filter(s => !FINISHED.includes(s.status));
  const out = [];
  if (ended.length) {
    const unfold = F.status === 'ENDED' || S.foldOpen.ENDED;
    out.push(foldRowHTML('ENDED', ended, unfold));
    if (unfold) ended.forEach(s => out.push(rowHTML(s, nowMs, ctx)));
  }
  let wasDelayed = false;
  for (const s of open) {
    const isDelayed = (s.cumulative_delay || 0) > 0;
    if (wasDelayed && s.is_anchor && !isDelayed) out.push(`<div class="sc-anchor">${icon('anchor')}<span>${esc(t('cc.list.delayStops'))}</span></div>`);
    out.push(rowHTML(s, nowMs, ctx));
    wasDelayed = isDelayed;
  }
  if (cancelled.length) {
    const unfold = F.status === 'CANCELLED' || S.foldOpen.CANCELLED;
    out.push(foldRowHTML('CANCELLED', cancelled, unfold));
    if (unfold) cancelled.forEach(s => out.push(rowHTML(s, nowMs, ctx)));
  }
  if (isDirector) out.push(`<div class="sc-addrow">
      <button type="button" class="btn md" onclick="openSessModal('add')">${icon('plus')}${esc(t('cc.list.addSession'))}</button>
      <button type="button" class="btn md import-btn" onclick="triggerCSVImport()" title="Import sessions from CSV">${icon('upload')}${esc(t('cc.list.importCsv'))}</button>
    </div>`);
  list.innerHTML = out.join('');
  restoreFocus(fk);
  if (!S.listOpened && open.length) {
    S.listOpened = true;
    document.getElementById('card-' + open[0].id)?.scrollIntoView({ block: 'nearest' });
  }
  updateDelayStrip();
  buildCtxPanel();
}
```

Delete `cardHTML()` and `toggleNotes()`. Replace `handleCardKey()`:

```js
// Rows: click, Enter or Space select; ArrowUp/ArrowDown move the selection (spec 2.2).
function handleCardKey(event, sessionId) {
  if (event.target !== event.currentTarget) return;   // keys inside a row's buttons
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); S.selectedId = sessionId; renderSessions(); document.getElementById('card-' + sessionId)?.focus(); return; }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const rows = [...document.querySelectorAll('#sessions-list .sc[tabindex="0"]')];
  const idx  = rows.findIndex(r => r.id === `card-${sessionId}`);
  const next = event.key === 'ArrowDown' ? rows[idx + 1] : rows[idx - 1];
  if (!next) return;
  S.selectedId = next.id.slice(5);
  renderSessions();
  document.getElementById(next.id)?.focus();
}
```

Replace `updateDelayStrip()`:

```js
// Delay summary as a chip in the filter row (spec 2.2): "Running +5 min · 2 affected · stops at #7".
function updateDelayStrip() {
  const strip = document.getElementById('delay-strip');
  if (!strip) return;
  const delayed = S.sessions.filter(s => (s.cumulative_delay || 0) > 0);
  if (!delayed.length) { strip.hidden = true; strip.innerHTML = ''; return; }
  const maxDelay = Math.max(...delayed.map(s => s.cumulative_delay));
  const last = delayed.reduce((a, b) => (a.sort_order > b.sort_order ? a : b));
  const anchor = S.sessions.filter(s => s.is_anchor && s.sort_order > last.sort_order).sort((a, b) => a.sort_order - b.sort_order)[0];
  const text = tf('cc.delay.chip', { n: maxDelay, k: delayed.length }) + (anchor ? ' · ' + tf('cc.delay.stopsAt', { n: anchor.sort_order }) : '');
  const isDirector = S.role === 'director' || S.userRole === 'director';
  strip.hidden = false;
  strip.innerHTML = `<span class="delay-chip">${icon('clock')}${esc(text)}</span>`
    + (isDirector ? `<button type="button" class="btn sm ghost" id="ds-reset-btn" onclick="resetAllDelays()">${esc(t('cc.delay.reset'))}</button>` : '');
}
```

`buildFilterBar()`: keep its option-building lines (including the safety branch's "Active" status option) and make these changes: add `const ctl = document.getElementById('fb-controls'); if (!ctl) return;` after the `bar` check and write `ctl.innerHTML = …` instead of `bar.innerHTML = …`; add `const isDirector = S.role === 'director' || S.userRole === 'director';`; give the search input `aria-label="' + t('filter.searchPlaceholder') + '"`; replace the `filter-toggle-btn`, `fb-clear`, view pill and `tl-auto-toast` pieces of the string with:

```js
    '<button type="button" id="filter-toggle-btn" class="btn sm" onclick="toggleFilters()">' + icon('chev-right') + ' Filters</button>' +
```

(at the old `filter-toggle-btn` position), and after the room `</select>`:

```js
    '<button type="button" id="fb-clear" class="btn sm ghost ' + (isFilterActive() ? 'visible' : '') + '" onclick="clearFilters()">' + icon('x') + esc(t('filter.clearAll')) + '</button>' +
    '<span id="fb-count"></span>' +
    '<div class="fb-view-pill" role="group" aria-label="View">' +
    '<button type="button" class="fvp-btn' + (S.viewMode === 'list' ? ' active' : '') + '" data-view="list" aria-pressed="' + (S.viewMode === 'list') + '" onclick="setViewMode(\'list\')">' + icon('list') + esc(t('filter.list')) + '</button>' +
    '<button type="button" class="fvp-btn' + (S.viewMode === 'timeline' ? ' active' : '') + '" data-view="timeline" aria-pressed="' + (S.viewMode === 'timeline') + '" onclick="setViewMode(\'timeline\')">' + icon('clock') + esc(t('filter.timeline')) + '</button>' +
    '</div>' +
    (isDirector ? '<button type="button" id="edit-mode-btn" class="btn sm ghost" aria-pressed="' + !!S.editMode + '" onclick="toggleEditMode()">' + icon('edit') + esc(t('cc.list.editMode')) + '</button>' : '');
```

In `renderTimeline()` and in the signage branch of `renderSessions()` delete `document.getElementById('delay-strip').style.display = 'none';`.

- [ ] **Step 5: CSS.** Delete the rules listed under Files and append:

```css
    /* ═══ Command center compact list (stage 3) ═══ */
    #filter-bar { height: 48px; padding: 0 16px; gap: 8px; display: flex; align-items: center; background: var(--bg); border-bottom: 1px solid var(--border-section); flex-shrink: 0; }
    #fb-controls { display: contents; }
    .fb-spacer { flex: 1; }
    #delay-strip { display: flex; align-items: center; gap: 8px; }
    #delay-strip[hidden] { display: none; }
    .delay-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: var(--r-pill); background: var(--st-hold-bg); border: 1px solid var(--st-hold-line); color: var(--st-hold-fg); font-size: var(--fs-12); font-weight: 600; white-space: nowrap; }
    .fb-view-pill { display: inline-flex; border: 1px solid var(--border-control); border-radius: var(--r-ctl); overflow: hidden; }
    .fvp-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 0; background: transparent; color: var(--text-secondary); font: 600 var(--fs-12) var(--font-sans); cursor: pointer; }
    .fvp-btn.active { background: var(--raised); color: var(--text-primary); }
    #fb-clear { display: none; } #fb-clear.visible { display: inline-flex; }
    #fb-count { font-size: var(--fs-12); color: var(--text-tertiary); } #fb-count.filtered { color: var(--accent-fg); }
    #sessions-col { padding: 8px 16px 16px; }
    #sessions-list { display: grid; gap: 4px; align-content: start; }
    .sc {
      display: grid; grid-template-columns: 100px 28px minmax(0, 1fr) 110px 120px 44px 150px; align-items: center; column-gap: 12px;
      min-height: var(--row-56); padding: 6px 12px; margin: 0;
      background: var(--card); border: 1px solid var(--border-section); border-inline-start: 4px solid var(--st-planned);
      border-radius: var(--r-ctl); box-shadow: none; opacity: 1; animation: none; overflow: visible; cursor: pointer; color: var(--text-primary);
    }
    .sc:hover { background: var(--raised); }
    .sc:focus-visible { outline: none; }
    .sc.is-selected { background: var(--raised); box-shadow: inset 0 0 0 1px var(--accent); }
    .sc.status-PLANNED   { border-inline-start: 4px double var(--st-planned); }
    .sc.status-READY     { border-inline-start-color: var(--st-ready); }
    .sc.status-CALLING   { border-inline-start-color: var(--st-calling); }
    .sc.status-LIVE      { border-color: var(--st-live-line); border-inline-start: 4px solid var(--st-live); background: linear-gradient(90deg, var(--st-live-wash), var(--card) 40%); }
    .sc.status-OVERRUN   { border-color: var(--st-overrun-line); border-inline-start: 4px solid var(--st-overrun); background: linear-gradient(90deg, var(--st-overrun-wash), var(--card) 40%); }
    .sc.status-HOLD      { border-inline-start: 4px dashed var(--st-hold); }
    .sc.status-ENDED     { border-inline-start-color: var(--st-ended); color: var(--text-secondary); }
    .sc.status-CANCELLED { border-inline-start-color: var(--st-cancelled); color: var(--text-tertiary); background: transparent; }
    .sc.status-CANCELLED .sc-title { text-decoration: line-through; }
    .sc-badge { display: flex; }
    .sc-num { color: var(--text-tertiary); font-size: var(--fs-12); font-variant-numeric: tabular-nums; }
    .sc-main { min-width: 0; display: grid; gap: 2px; }
    .sc-title-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .sc-title { font-size: var(--fs-14); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .sc-sub { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs-12); color: var(--text-tertiary); white-space: nowrap; overflow: hidden; }
    .sc-sub > * { flex: none; }
    .sc-spk, .sc-notefirst { flex: 0 1 auto !important; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .sc-flag { display: inline-flex; align-items: center; gap: 3px; }
    .sc-flag .ico { width: 14px; height: 14px; }
    .sc-arrived { color: var(--st-ready-fg); }
    .sc-notefirst { color: var(--text-secondary); }
    .sc-room { min-width: 0; }
    .sc-time { display: grid; font-variant-numeric: tabular-nums; color: var(--text-secondary); font-size: var(--fs-13); }
    .sc-time small { font-size: var(--fs-11); color: var(--text-tertiary); font-weight: 400; }
    .sc-time.is-live { color: var(--st-live-fg); font-weight: 700; }
    .sc-time.is-over { color: var(--st-overrun-fg); font-weight: 700; }
    .sc-time.is-held { color: var(--st-hold-fg); font-weight: 700; }
    .sc-delay { font-size: var(--fs-12); color: var(--st-hold-fg); font-variant-numeric: tabular-nums; }
    .sc-act { justify-self: end; display: flex; gap: 6px; }
    .sc-tools { display: none; gap: 2px; align-items: center; flex: none; }
    .sc:hover .sc-tools, .sc:focus-within .sc-tools, body.edit-mode .sc-tools { display: inline-flex; }
    .sc-drawer { grid-column: 1 / -1; border-top: 1px solid var(--border-divider); margin-top: 6px; padding-top: 8px; display: grid; gap: 8px; cursor: default; }
    .sc-drawer .sc-actions { padding: 0; }
    .sc-notes-full { white-space: pre-wrap; color: var(--text-secondary); font-size: var(--fs-12); }
    .sc-fold { display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; padding: 0 12px; border: 1px dashed var(--border-section); border-radius: var(--r-ctl); background: transparent; color: var(--text-tertiary); font: 500 var(--fs-12) var(--font-sans); text-align: start; cursor: pointer; }
    .sc-fold[aria-expanded="true"] .ico { transform: rotate(90deg); }
    .sc-anchor { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 4px; color: var(--text-tertiary); font-size: var(--fs-12); }
    .sc-anchor::after { content: ""; flex: 1; border-top: 1px dashed var(--border-section); }
    .sc-addrow { display: flex; gap: 8px; justify-content: center; padding: 12px 0; }
    #empty .ei .ico { width: 32px; height: 32px; color: var(--text-tertiary); }
```

- [ ] **Step 6: Strings** (add to all four blocks as in Task 3.1 Step 6):

| Key | en | ar | pl | de |
|---|---|---|---|---|
| `cc.list.completed` | {n} completed | {n} مكتملة | Zakończone: {n} | {n} abgeschlossen |
| `cc.list.cancelled` | {n} cancelled | {n} ملغاة | Anulowane: {n} | {n} abgesagt |
| `cc.list.delayStops` | Delay stops here: below runs on the original schedule | يتوقف التأخير هنا: ما يلي يسير وفق الجدول الأصلي | Tu kończy się opóźnienie: dalej obowiązuje pierwotny plan | Hier endet die Verschiebung: darunter gilt der ursprüngliche Plan |
| `cc.list.was` | was {time} | كان {time} | było {time} | war {time} |
| `cc.list.arrived` | arrived | وصل | na miejscu | da |
| `cc.list.note` | Note | ملاحظة | Notatka | Notiz |
| `cc.list.moderator` | moderator | مدير الجلسة | moderator | Moderation |
| `cc.list.moveUp` | Move up | تحريك لأعلى | Przesuń w górę | Nach oben |
| `cc.list.moveDown` | Move down | تحريك لأسفل | Przesuń w dół | Nach unten |
| `cc.list.edit` | Edit session | تعديل الجلسة | Edytuj sesję | Sitzung bearbeiten |
| `cc.list.selectFor` | Select {title} | تحديد {title} | Zaznacz {title} | {title} auswählen |
| `cc.list.addSession` | Add session | إضافة جلسة | Dodaj sesję | Sitzung hinzufügen |
| `cc.list.importCsv` | Import CSV | استيراد CSV | Importuj CSV | CSV importieren |
| `cc.list.editMode` | Edit run of show | تعديل البرنامج | Edytuj scenariusz | Ablauf bearbeiten |
| `cc.time.left` | {time} left | متبقٍ {time} | zostało {time} | noch {time} |
| `cc.time.over` | +{time} over | +{time} تجاوز | +{time} ponad czas | +{time} drüber |
| `cc.time.held` | held {time} | متوقف {time} | wstrzymane {time} | pausiert {time} |
| `cc.time.onHold` | on hold | متوقف | wstrzymane | pausiert |
| `cc.time.leftUnit` | left | متبقٍ | zostało | übrig |
| `cc.time.overUnit` | over | تجاوز | ponad czas | drüber |
| `cc.flag.mics` | Microphones | الميكروفونات | Mikrofony | Mikrofone |
| `cc.flag.rec` | rec | تسجيل | nagr. | Aufn. |
| `cc.flag.stream` | stream | بث | stream | Stream |
| `cc.flag.remote` | remote | عن بعد | zdalnie | remote |
| `cc.act.setReady` | Set ready | تجهيز | Przygotuj | Bereit setzen |
| `cc.act.call` | Call speaker | استدعاء المتحدث | Wezwij mówcę | Sprecher rufen |
| `cc.act.goLive` | Go live | بث مباشر | Rozpocznij | Live gehen |
| `cc.act.onStage` | On stage | على المسرح | Na scenie | Auf der Bühne |
| `cc.act.end` | End… | إنهاء… | Zakończ… | Beenden… |
| `cc.act.resume` | Resume | استئناف | Wznów | Fortsetzen |
| `cc.act.hold` | Hold | توقف | Wstrzymaj | Pause |
| `cc.act.reinstate` | Reinstate | استعادة | Przywróć | Wiederherstellen |
| `cc.act.backToReady` | Back to ready | العودة إلى جاهز | Wróć do gotowych | Zurück zu bereit |
| `cc.act.backToPlanned` | Back to planned | العودة إلى مخطط | Wróć do planu | Zurück zu geplant |
| `cc.act.cancel` | Cancel session | إلغاء الجلسة | Anuluj sesję | Sitzung absagen |
| `cc.delay.chip` | Running +{n} min · {k} affected | تأخير +{n} د · {k} متأثرة | Opóźnienie +{n} min · sesje: {k} | +{n} Min · {k} betroffen |
| `cc.delay.stopsAt` | stops at #{n} | يتوقف عند #{n} | do #{n} | endet bei #{n} |
| `cc.delay.reset` | Reset delays | إعادة ضبط التأخير | Wyzeruj opóźnienia | Verschiebungen zurücksetzen |

In `translateStaticDOM()` delete the `// Filter bar Clear All button` block and the `// View toggle pills` loop (both are rendered through `t()` now).

- [ ] **Step 7: Tests that select on the old card markup (same commit).** In `tests/e2e/console-restart.spec.ts` add below `const restartBtn = …`:

```ts
// Restart sits with the selected session's controls (stage 3: the row drawer).
async function openControls(page: Page, id: string) {
  await page.evaluate((sid) => (0, eval)(`S.foldOpen = { ENDED: true, CANCELLED: true }; S.selectedId = '${sid}'; renderSessions();`), id);
}
```

then run:

```bash
node -e '
const fs=require("fs");const f="tests/e2e/console-restart.spec.ts";let s=fs.readFileSync(f,"utf8");
s=s.replace(/^(\s*)await restartBtn\(page, (\w+)\)\.click\(\);/gm,"$1await openControls(page, $2);\n$1await restartBtn(page, $2).click();");
fs.writeFileSync(f,s);'
```

and rewrite the first two tests:

```ts
test('the Restart button shows on started sessions and not on a planned one', async ({ page }) => {
  await setup(page);
  await openControls(page, STARTED);
  await expect(restartBtn(page, STARTED)).toBeVisible();
  await openControls(page, ENDED);
  await expect(restartBtn(page, ENDED)).toBeVisible();
  await openControls(page, PLANNED);
  await expect(restartBtn(page, PLANNED)).toHaveCount(0);
});

test('a role that cannot set READY gets no Restart button', async ({ page }) => {
  await setup(page, 'av');
  await openControls(page, STARTED);
  await expect(page.locator('[data-restart]')).toHaveCount(0);
});
```

In `tests/e2e/auth-flows.spec.ts` test 24 replace `await page.locator('button.fwd-go:has-text("Go live")').first().click();` with:

```ts
    await sessionCard.click();
    await page.locator(`#card-${process.env.TEST_SESSION_ID} .sc-drawer button.fwd-go`).first().click();
```

- [ ] **Step 8: Run.**

```bash
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-list.spec.ts tests/e2e/console-restart.spec.ts tests/e2e/console-confirm.spec.ts tests/e2e/console-forbidden.spec.ts tests/e2e/session-management.spec.ts tests/e2e/console-timeline-autoswitch.spec.ts
npx vitest run
```

Expected: list 9 passed; the rest pass; vitest passes after `BUDGET` is set to the printed (lower) count.

- [ ] **Step 9: Baselines and layout check.** `--update-snapshots`; review: 56 px rows with badge, number, title, speaker line with line icons, room chip, HH:MM, delay, one action; "1 completed" at the top and "1 cancelled" at the bottom; the anchor divider before #7; the delay chip at the right of the filter row; the armed-end baseline shows "Press again to end" (or the safety branch's armed label) in the LIVE row. Full console suite `0 failed`.

- [ ] **Step 10: Commit.**

```bash
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-list.spec.ts tests/e2e/console-restart.spec.ts tests/e2e/auth-flows.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): compact session list with folded finished sessions and one action per row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-list.spec.ts tests/e2e/console-restart.spec.ts tests/e2e/auth-flows.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 3.3: Release stage 3 (with Task 2.1)

Same steps as Task 1.4 with branch `redesign/stage-3` and notes directory `$SCRATCH/notes/stage-3`. Freeze check first: no release task starts after 18:00 on 10 Oct; a stage not live-checked by 21:00 on 10 Oct waits until after GTR; nothing is pushed on 11 Oct. The pushed range must contain only the Task 2.1, 3.1 and 3.2 commits. Live check: `curl -s https://app.cuedeck.io/ | grep -o 'id="viewas-btn"' | head -1` prints the string; in Chrome on Sherif's signed-in session (press no show control): the header is one row, View as is present for a director, the account menu holds Tools, rows are 56 px with one action, finished sessions are folded. Note to Sherif: "Stage 3 (header and compact list) is live." with before/after pairs for `director-1440`, `director-1280` and `stage-1440`.

---

# Stage 4: Band, inspector and timeline

Branch: `redesign/stage-4` from `main` after Task 3.3.

### Task 4.1: Now and next band

**Files:**
- Modify `cuedeck-console.html`:
  - HTML: move `<div id="filter-bar">…</div>` (now above `#main`) into a new `#main-col` wrapper inside `#main`, above `#sessions-col`, and add the band (Step 3).
  - CSS: `#main` (line 538), `#sessions-col` (539), `#sidebar` width (540-544); the responsive `max-width: 1279px` block (`#main` line added); append `/* ═══ Command center layout and band (stage 4) ═══ */`.
  - JS: new section `// COMMAND CENTER: now and next band (stage 4)`; the top of `renderSessions()`; `onFilterChange()` (5516).
- Modify `cuedeck-i18n.js` (Step 6 keys).
- Modify `tests/e2e/console-boot-mock.ts` (no change needed to data; `fourRoomSessions`, `roomlessSessions`, `longTitleSessions` already exist), `tests/e2e/console-header.spec.ts` (first test, Step 7), `tests/e2e/console-visual.spec.ts` (two cases), `tests/console-colour-ratchet.spec.ts`.
- Create `tests/e2e/console-band.spec.ts`.

**Interfaces:**
- Consumes: `countdownLabel`, `liveTiming`, `speakerShort`, `people`, `flagsHTML`, `statusBadge`, `primaryButtonHTML`, `transitionButtonHTML`, `endButtonHTML`, `canDo`, `icon`, `tf`, `hm`, `addMinutes`, `toMins`, `getNextSession`, `eventNowMinutes`, `applyDelay`, `ROLE_DELAY`, `focusKey`, `restoreFocus`, `FINISHED`.
- Produces JS (used by 4.2, 4.3, 5.1): `BAND_ROLES`, `NOW_RANK`, `ROOM_NONE`, `roomOf(s)`, `myRoom()`, `setMyRoom(room)`, `roomsInOrder()`, `laneFor(room)` returning `{ room, now, next }`, `bandLanes()`, `untilText(s)`, `minsUntil(s)`, `renderBand()`, `laneHTML(lane, nowMs, many)`, `nextRowHTML(lane, over, tm)`, `laneChipHTML(lane)`, `toggleLane(room)`; state `S.laneOpen`.
- Produces DOM: `#main-col`, `#band.band` with `.lane.is-live|is-over|is-hold|is-calling|is-idle`, `.lane-room`, `.lane-now`, `.lane-next`, `.lane-what`, `.lane-title`, `.lane-who`, `.lane-count`, `.lane-big`, `.lane-unit`, `.lane-ctrl`, `.lane-lead`, `.end-slot`, `.lane-risk`, `.warnchip`, `.lane-chips`, `.lane-chip`.

- [ ] **Step 1: Failing tests.** Create `tests/e2e/console-band.spec.ts`:

```ts
// tests/e2e/console-band.spec.ts
// Spec 2.1: one lane per room with a LIVE, OVERRUN, HOLD or CALLING session
// or a next session; End always in the same slot; knock-on when a session
// runs over; more than three rooms collapse the idle ones to chips.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, ID, PANEL_ID, overrunSessions, noLiveSessions, fourRoomSessions, roomlessSessions, longTitleSessions } from './console-boot-mock';

test('band: one lane per active room with now and next', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const lanes = page.locator('#band .lane');
  await expect(lanes).toHaveCount(2);
  await expect(lanes.nth(0).locator('.lane-room')).toHaveText('Hall B');   // alphabetical: no room order on the event
  const ms = page.locator('#band .lane[data-room="Main Stage"]');
  await expect(ms).toHaveClass(/is-live/);
  await expect(ms.locator('.lane-title')).toHaveText('#3 Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await expect(ms.locator('.lane-who')).toContainText('Dina Farouk (moderator) +3');
  await expect(ms.locator('.lane-big')).toHaveText('19:15');
  await expect(ms.locator('.lane-next')).toContainText('#5 Duty Free Pricing After the Currency Float');
  await expect(ms.locator('.lane-next')).toContainText('12:05 (+5) · in 25 min');
  await expect(ms.locator('.lane-next .lane-ctrl button')).toHaveText('Call speaker');
  const hb = page.locator('#band .lane[data-room="Hall B"]');
  await expect(hb).toHaveClass(/is-hold/);
  await expect(hb.locator('.lane-big')).toHaveText('9:45');
  await expect(hb.locator('.lane-now .lane-lead button')).toHaveText('Resume');
  await expect(hb.locator('.lane-next .lane-ctrl button')).toHaveText('On stage');
  await ctx.close();
});

test('band: Hold sits left of End and End is in the same place in every lane', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const ms = page.locator('#band .lane[data-room="Main Stage"] .lane-now .lane-ctrl');
  const kids = await ms.evaluate(el => [...el.children].map(c =>
    c.classList.contains('act-gap') ? 'gap' : c.classList.contains('lane-lead') ? 'lead' : c.classList.contains('danger') ? 'end' : c.className));
  expect(kids).toEqual(['lead', 'gap', 'end']);
  await expect(ms.locator('.lane-lead .hold')).toHaveText('Hold');
  const endX = async (room: string) => (await page.locator(`#band .lane[data-room="${room}"] .lane-now .btn.danger`).boundingBox())!.x;
  expect(Math.abs((await endX('Main Stage')) - (await endX('Hall B')))).toBeLessThan(1);
  const leadX = async (room: string) => (await page.locator(`#band .lane[data-room="${room}"] .lane-now .lane-lead`).boundingBox())!.x;
  expect(Math.abs((await leadX('Main Stage')) - (await leadX('Hall B')))).toBeLessThan(1);
  await ctx.close();
});

test('band: OVERRUN lane turns magenta, counts up, and the next row shows the knock-on and Push following', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: overrunSessions() });
  const ms = page.locator('#band .lane[data-room="Main Stage"]');
  await expect(ms).toHaveClass(/is-over/);
  await expect(ms.locator('.lane-big')).toHaveText('+10:45');
  await expect(ms.locator('.lane-unit')).toHaveText('over');
  await expect(ms.locator('.lane-risk')).toHaveText('12:05 now 12:15, at risk');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/apply-delay'));
  await ms.locator('.lane-next button', { hasText: 'Push following +10' }).click();
  expect(JSON.parse((await sent).postData() || '{}')).toMatchObject({ session_id: ID(5), minutes: 10 });
  await ctx.close();
});

test('band: an idle room says idle and offers the next session action', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: noLiveSessions(), broadcast: null });
  const ms = page.locator('#band .lane[data-room="Main Stage"]');
  await expect(ms).toHaveClass(/is-idle/);
  await expect(ms).toContainText('Main Stage idle · Next #5 Duty Free Pricing After the Currency Float · in 25 min');
  await expect(ms.locator('.lane-ctrl button')).toHaveText('Call speaker');
  await expect(page.locator('#band .lane[data-room="Hall B"]')).toHaveClass(/is-calling/);
  await ctx.close();
});

test('band: 4 rooms keep attention lanes full and collapse the idle one', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: fourRoomSessions() });
  await expect(page.locator('#band .lane')).toHaveCount(3);
  const chip = page.locator('#band .lane-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('Terrace');
  expect(Math.round((await chip.boundingBox())!.height)).toBe(28);
  const firstRow = await page.locator('#sessions-list .sc').first().boundingBox();
  expect(firstRow!.y + firstRow!.height).toBeLessThanOrEqual(900);
  await chip.click();
  await expect(page.locator('#band .lane')).toHaveCount(4);
  await ctx.close();
});

test('band: sessions without a room get one No room lane', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: roomlessSessions() });
  await expect(page.locator('#band .lane')).toHaveCount(1);
  await expect(page.locator('#band .lane-room')).toHaveText('No room');
  await expect(page.locator('#band .lane-title')).toHaveText(/^#3 /);
  await expect(page.locator('#band .lane-next')).toContainText('#4 ');
  await ctx.close();
});

test('band: a long title never pushes End out of the lane', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: longTitleSessions() });
  const lane = page.locator(`#band .lane[data-room="Main Stage"]`);
  const lb = (await lane.boundingBox())!;
  const eb = (await lane.locator('.lane-now .btn.danger').boundingBox())!;
  expect(eb.x + eb.width).toBeLessThanOrEqual(lb.x + lb.width);
  expect(await lane.locator('.lane-title').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await ctx.close();
});

test('band: Not arrived shows when the next speaker is due within 10 minutes', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `const s = S.sessions.find(x => x.id === '${ID(5)}'); s.scheduled_start = '11:48:00'; s.speaker_arrived = false; renderSessions();`);
  await expect(page.locator('#band .lane[data-room="Main Stage"] .warnchip')).toHaveText('Not arrived');
  await ctx.close();
});

test('band: stays visible in the timeline view and for stage operators puts their room first', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage' });
  await evalPage(page, `setMyRoom('Main Stage')`);
  await expect(page.locator('#band .lane').first()).toHaveAttribute('data-room', 'Main Stage');
  await evalPage(page, `setViewMode('timeline')`);
  await expect(page.locator('#band')).toBeVisible();
  await ctx.close();
});

test('layout: at 1440x900 both lanes and at least 8 list rows are on screen', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const colBottom = await page.locator('#sessions-col').evaluate(el => el.getBoundingClientRect().bottom);
  const rows = await page.locator('#sessions-list .sc, #sessions-list .sc-fold').evaluateAll((els, bottom) => els.filter(e => e.getBoundingClientRect().bottom <= (bottom as number)).length, colBottom);
  expect(rows).toBeGreaterThanOrEqual(8);
  for (const room of ['Main Stage', 'Hall B']) {
    const b = (await page.locator(`#band .lane[data-room="${room}"] .lane-next`).boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(900);
  }
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure.** `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-band.spec.ts`. Expected: 10 failed (`#band` missing).

- [ ] **Step 3: Markup.** Delete the `<div id="filter-bar">…</div>` line above `<!-- SIDEBAR TOGGLE + BACKDROP -->`. Change the start of `<div id="main">` to:

```html
<div id="main">
  <div id="main-col">
    <section id="band" class="band" aria-label="Now and next" hidden></section>
    <div id="filter-bar"><div id="fb-controls"></div><span class="fb-spacer"></span><div id="delay-strip" hidden></div></div>
    <div id="sessions-col">
      <div id="sessions-list">
        <div id="empty">
          <div class="ei"><svg class="ico" aria-hidden="true" focusable="false"><use href="#i-list"/></svg></div>
          <h2>Loading sessions…</h2>
        </div>
      </div>
    </div>
  </div>
```

(the old `#sessions-col` block is replaced by the one inside `#main-col`; `#sidebar` follows unchanged).

- [ ] **Step 4: JS.** Add `laneOpen: {},` to `S`. Add the section under the compact-list section:

```js
// ═══════════════════════════════════════════════════
// COMMAND CENTER: now and next band (stage 4)
// ═══════════════════════════════════════════════════
const BAND_ROLES = ['director', 'stage', 'av'];
const NOW_RANK = { OVERRUN: 0, LIVE: 1, HOLD: 2, CALLING: 3 };
const ROOM_NONE = '';
function roomOf(s) { return s.room || ROOM_NONE; }
// The operator's own room (stage, av, phone): a per-viewer convenience.
function myRoom() {
  try { return localStorage.getItem('cuedeck_room_' + (S.event?.id || '')) || null; } catch { return null; }
}
function setMyRoom(room) {
  try {
    const k = 'cuedeck_room_' + (S.event?.id || '');
    if (room) localStorage.setItem(k, room); else localStorage.removeItem(k);
  } catch { /* storage blocked: order stays alphabetical */ }
  renderSessions();
}
// Event room order when the event has one, else alphabetical; the operator's room first.
function roomsInOrder() {
  const rooms = [...new Set(S.sessions.map(roomOf))];
  const pref = Array.isArray(S.event?.rooms) ? S.event.rooms : null;
  rooms.sort((a, b) => {
    if (pref) { const ia = pref.indexOf(a), ib = pref.indexOf(b); if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); }
    if (a === ROOM_NONE) return 1;
    if (b === ROOM_NONE) return -1;
    return a.localeCompare(b);
  });
  const mine = myRoom();
  if (mine && rooms.includes(mine)) { rooms.splice(rooms.indexOf(mine), 1); rooms.unshift(mine); }
  return rooms;
}
function laneFor(room) {
  const inRoom = S.sessions.filter(s => roomOf(s) === room).sort((a, b) => a.sort_order - b.sort_order);
  const now = inRoom.filter(s => s.status in NOW_RANK)
    .sort((a, b) => NOW_RANK[a.status] - NOW_RANK[b.status] || a.sort_order - b.sort_order)[0] || null;
  const next = now ? getNextSession(S.sessions, now) : (inRoom.find(s => !FINISHED.includes(s.status)) || null);
  return { room, now, next };
}
function bandLanes() { return roomsInOrder().map(laneFor).filter(l => l.now || l.next); }
function minsUntil(s) { return Math.ceil(toMins(s.scheduled_start) - eventNowMinutes()); }
function untilText(s) { const m = minsUntil(s); return m <= 0 ? t('cc.band.now') : tf('cc.band.inMin', { n: m }); }

function renderBand() {
  const band = document.getElementById('band');
  if (!band) return;
  const lanes = BAND_ROLES.includes(S.role) ? bandLanes() : [];
  if (!lanes.length) { band.hidden = true; band.innerHTML = ''; return; }
  const nowMs = correctedNow();
  const many = lanes.length > 3;
  const full = [], chips = [];
  // More than three rooms: lanes that need attention stay full, idle ones collapse.
  for (const l of lanes) (many && !l.now && !S.laneOpen[l.room] ? chips : full).push(l);
  band.hidden = false;
  band.setAttribute('aria-label', t('cc.band.label'));
  band.innerHTML = full.map(l => laneHTML(l, nowMs, many)).join('')
    + (chips.length ? `<div class="lane-chips">${chips.map(laneChipHTML).join('')}</div>` : '');
}

function laneHTML(l, nowMs, many) {
  const roomName = l.room === ROOM_NONE ? t('cc.band.noRoom') : l.room;
  const collapse = many && !l.now ? `<button type="button" class="btn ghost sm icon-only" aria-label="${esc(t('cc.band.collapse'))}" onclick="toggleLane(${esc(JSON.stringify(l.room))})">${icon('chev-down')}</button>` : '';
  const room = `<div class="lane-room"><span>${esc(roomName)}</span>${collapse}</div>`;
  const s = l.now;
  if (!s) {
    const n = l.next;
    return `<div class="lane is-idle" data-room="${esc(l.room)}">${room}
      <div class="lane-body"><div class="lane-now lane-idle">
        <span class="lane-idle-text">${esc(tf('cc.band.idle', { room: roomName }))} · ${esc(t('cc.band.next'))} #${n.sort_order} ${esc(n.title)} · ${esc(untilText(n))}</span>
        <span class="lane-ctrl">${primaryButtonHTML(n, 'md', 'band-idle')}</span>
      </div></div></div>`;
  }
  const tm = (s.status === 'LIVE' || s.status === 'OVERRUN') ? liveTiming(s, nowMs) : null;
  const over = s.status === 'OVERRUN' || !!(tm && tm.overrun);
  const cls = over ? 'is-over' : s.status === 'LIVE' ? 'is-live' : s.status === 'HOLD' ? 'is-hold' : 'is-calling';
  const cd = countdownLabel(s, nowMs) || { big: hm(s.scheduled_start), unit: untilText(s) };
  const spk = speakerShort(s);
  const who = S.role === 'av'
    ? `<span class="lane-flags">${flagsHTML(s)}</span>`
    : `<span class="lane-spk">${esc(spk)}</span>${s.speaker_arrived && spk ? `<span class="sc-flag sc-arrived">${icon('check')}${esc(t('cc.list.arrived'))}</span>` : ''}`;
  // Fixed slots: [lead: Hold for LIVE/OVERRUN, else the forward action] | gap | [End or an empty slot]
  const lead = (s.status === 'LIVE' || s.status === 'OVERRUN')
    ? (canDo(s, 'HOLD') ? transitionButtonHTML(s, 'HOLD', 'md', 'band') : '')
    : primaryButtonHTML(s, 'md', 'band');
  const end = endButtonHTML(s, 'md', 'band') || '<span class="end-slot" aria-hidden="true"></span>';
  return `<div class="lane ${cls}" data-room="${esc(l.room)}">${room}
    <div class="lane-body">
      <div class="lane-now">
        ${statusBadge(s.status)}
        <span class="lane-what"><span class="lane-title" title="${esc(s.title)}">#${s.sort_order} ${esc(s.title)}</span><span class="lane-who">${who}</span></span>
        <span class="lane-count" data-timer><span class="lane-big">${esc(cd.big)}</span><span class="lane-unit">${esc(cd.unit)}</span></span>
        <span class="lane-ctrl"><span class="lane-lead">${lead}</span><span class="act-gap" aria-hidden="true"></span>${end}</span>
      </div>
      ${l.next ? nextRowHTML(l, over, tm) : ''}
    </div>
  </div>`;
}

function nextRowHTML(l, over, tm) {
  const n = l.next;
  const delay = (n.cumulative_delay || 0) > 0 ? ` (+${n.cumulative_delay})` : '';
  let when = esc(`${hm(n.scheduled_start)}${delay} · ${untilText(n)}`);
  let push = '';
  if (over && tm) {
    // Knock-on: the current session's overrun, in 5-minute steps (spec 2.1).
    const overMin = Math.max(1, Math.ceil(-tm.remain / 60_000));
    const shift = Math.max(5, Math.round(overMin / 5) * 5);
    when = `<b class="lane-risk">${esc(tf('cc.band.atRisk', { was: hm(n.scheduled_start), now: addMinutes(hm(n.scheduled_start), shift) }))}</b>`;
    if (ROLE_DELAY[S.role]) push = `<button type="button" class="btn sm" data-fk="band-push-${n.id}" onclick="applyDelay('${n.id}', ${shift})">${esc(tf('cc.band.push', { n: shift }))}</button>`;
  }
  const hasSpeaker = !!(n.speaker || people(n).length);
  const notArrived = hasSpeaker && !n.speaker_arrived && minsUntil(n) <= 10;
  return `<div class="lane-next">
    <span class="lbl">${esc(t('cc.band.next'))}</span>
    <span class="lane-next-what"><span class="lane-next-title">#${n.sort_order} ${esc(n.title)}</span> · ${when}</span>
    <span class="lane-next-state">${statusBadge(n.status)}${notArrived ? `<span class="warnchip">${icon('user')}${esc(t('cc.band.notArrived'))}</span>` : ''}</span>
    <span class="lane-ctrl">${push}${primaryButtonHTML(n, 'sm', 'band-next')}</span>
  </div>`;
}

function laneChipHTML(l) {
  const roomName = l.room === ROOM_NONE ? t('cc.band.noRoom') : l.room;
  const n = l.next;
  return `<button type="button" class="lane-chip" data-fk="lanechip-${esc(l.room)}" aria-label="${esc(tf('cc.band.expand', { room: roomName }))}" onclick="toggleLane(${esc(JSON.stringify(l.room))})">
    <b>${esc(roomName)}</b><span>${esc(t('cc.band.next'))} #${n.sort_order} ${esc(n.title)} · ${hm(n.scheduled_start)}</span></button>`;
}
function toggleLane(room) { S.laneOpen[room] = !S.laneOpen[room]; renderSessions(); }
```

At the very top of `renderSessions()` (before the signage branch) insert:

```js
  // The band shows in list and timeline views alike (spec 2.5).
  const fkTop = focusKey();
  renderBand();
  restoreFocus(fkTop);
```

In `onFilterChange()`, after `F.room = …;` add `if ((S.role === 'stage' || S.role === 'av') && F.room) { setMyRoom(F.room); return; }` (setMyRoom renders).

- [ ] **Step 5: CSS.** Change `#main { … }` to `#main { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 360px; min-height: 0; overflow: hidden; background: var(--bg); }`, `#sessions-col` to `#sessions-col { overflow-y: auto; min-height: 0; padding: 8px 16px 16px; background: var(--bg); }`, and in `#sidebar { … }` replace `width: 280px;` with `width: auto; min-width: 0;`. In the `max-width: 1279px` block add `#main { grid-template-columns: minmax(0, 1fr); }`. Append:

```css
    /* ═══ Command center layout and band (stage 4) ═══ */
    #main-col { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-width: 0; min-height: 0; }
    @media (max-width: 1439px) { #main { grid-template-columns: minmax(0, 1fr) 320px; } }
    .band { display: grid; background: var(--panel); border-bottom: 1px solid var(--border-section); }
    .band[hidden] { display: none; }
    .lane { display: grid; grid-template-columns: 110px minmax(0, 1fr); border-bottom: 1px solid var(--border-divider); }
    .lane:last-child { border-bottom: 0; }
    .lane-room { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-inline-end: 1px solid var(--border-divider); font: 700 var(--fs-13) var(--font-sans); color: var(--text-primary); min-width: 0; }
    .lane-room span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lane-body { display: grid; min-width: 0; }
    .lane-now, .lane-next { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto auto; align-items: center; column-gap: 14px; padding: 7px 14px; min-width: 0; }
    .lane-now { min-height: 58px; }
    .lane-next { min-height: 40px; padding-block: 4px; border-top: 1px dashed var(--border-divider); color: var(--text-secondary); font-size: var(--fs-13); }
    .lane-what { display: grid; gap: 2px; min-width: 0; }
    .lane-title { font-size: var(--fs-16); font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lane-who { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs-12); color: var(--text-tertiary); white-space: nowrap; overflow: hidden; }
    .lane-spk { overflow: hidden; text-overflow: ellipsis; }
    .lane-flags { display: inline-flex; gap: 10px; color: var(--text-primary); font-weight: 600; }
    .lane-count { display: grid; justify-items: end; gap: 2px; }
    .lane-big { font: 700 var(--fs-28)/1 var(--font-sans); font-variant-numeric: tabular-nums; letter-spacing: var(--ls-big); color: var(--text-primary); }
    .lane-unit { font: 700 var(--fs-11)/1.2 var(--font-sans); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-tertiary); }
    .lane-ctrl { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
    .lane-lead { display: inline-flex; width: 112px; justify-content: flex-end; }
    .lane-lead .btn { width: 100%; }
    .lane-now .lane-ctrl .btn.danger, .lane-now .lane-ctrl .end-slot { width: 148px; overflow: hidden; text-overflow: ellipsis; }
    .end-slot { display: inline-block; width: 148px; height: 1px; }
    .lane-next-what { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lane-next-title { color: var(--text-primary); font-weight: 600; }
    .lane-next-state { display: inline-flex; align-items: center; }
    .lane-risk { color: var(--st-live-fg); }
    .warnchip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; margin-inline-start: 6px; border-radius: var(--r-badge); background: var(--st-live-bg); color: var(--danger-fg); font: 700 var(--fs-11) var(--font-sans); letter-spacing: var(--ls-badge); text-transform: uppercase; }
    .lane-idle { grid-template-columns: minmax(0, 1fr) auto; }
    .lane-idle-text { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lane.is-live    .lane-now { background: var(--st-live-wash); }
    .lane.is-over    .lane-now { background: var(--st-overrun-wash); box-shadow: inset 4px 0 0 var(--st-overrun); animation: lane-over 1.6s ease-in-out infinite; }
    .lane.is-hold    .lane-now { background: var(--st-hold-wash); }
    .lane.is-calling .lane-now { background: var(--st-calling-wash); }
    .lane.is-over .lane-big { color: var(--st-overrun-fg); }
    .lane.is-hold .lane-big { color: var(--st-hold-fg); }
    @keyframes lane-over { 50% { box-shadow: inset 4px 0 0 transparent; } }
    .lane-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 14px; border-top: 1px solid var(--border-divider); }
    .lane-chip { display: inline-flex; align-items: center; gap: 8px; height: 28px; max-width: 360px; padding: 0 10px; border-radius: var(--r-pill); border: 1px solid var(--border-section); background: var(--card); color: var(--text-secondary); font: 500 var(--fs-12) var(--font-sans); cursor: pointer; }
    .lane-chip b { color: var(--text-primary); }
    .lane-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* 1280×720: now and next side by side on one 44 px line (spec 2.6) */
    @media (max-width: 1439px) {
      .lane-body { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); }
      .lane-now { min-height: 44px; padding: 4px 10px; grid-template-columns: auto minmax(0, 1fr) auto auto; column-gap: 10px; }
      .lane-next { min-height: 44px; border-top: 0; border-inline-start: 1px dashed var(--border-divider); padding: 4px 10px; grid-template-columns: auto minmax(0, 1fr) auto; }
      .lane-next-state, .lane-who, .lane-unit { display: none; }
      .lane-big { font-size: var(--fs-20); }
      .lane-lead { width: 96px; }
      .lane-now .lane-ctrl .btn.danger, .lane-now .lane-ctrl .end-slot { width: 112px; }
    }
```

- [ ] **Step 6: Strings** (all four blocks):

| Key | en | ar | pl | de |
|---|---|---|---|---|
| `cc.band.label` | Now and next | الآن والتالي | Teraz i dalej | Jetzt und danach |
| `cc.band.next` | Next | التالي | Następna | Danach |
| `cc.band.idle` | {room} idle | {room} متوقفة | {room}: przerwa | {room} frei |
| `cc.band.inMin` | in {n} min | بعد {n} د | za {n} min | in {n} Min |
| `cc.band.now` | now | الآن | teraz | jetzt |
| `cc.band.atRisk` | {was} now {now}, at risk | {was} أصبح {now}، معرض للخطر | {was} teraz {now}, zagrożone | {was} jetzt {now}, gefährdet |
| `cc.band.push` | Push following +{n} | تأجيل التالي +{n} | Przesuń kolejne +{n} | Folgende +{n} |
| `cc.band.notArrived` | Not arrived | لم يصل | Nie dotarł | Nicht da |
| `cc.band.noRoom` | No room | بلا قاعة | Bez sali | Ohne Raum |
| `cc.band.expand` | Show {room} | عرض {room} | Pokaż {room} | {room} zeigen |
| `cc.band.collapse` | Collapse | طي | Zwiń | Einklappen |

- [ ] **Step 7: Owning updates.** In `tests/e2e/console-header.spec.ts` first test, replace the two lines that compute `fb` and its `expect` (the filter row now sits under the band) with:

```ts
  const bandTop = (await page.locator('#band').boundingBox())!.y;
  expect(bandTop - banner).toBeLessThanOrEqual(100);   // top chrome = everything above the band
```

In `tests/e2e/console-visual.spec.ts` add to `CASES`:

```ts
  { name: 'band-overrun-1280', sc: { sessions: overrunSessions(), viewport: { width: 1280, height: 720 } } },
  { name: 'band-four-rooms-1440', sc: { sessions: fourRoomSessions() } },
```

and import `fourRoomSessions`.

- [ ] **Step 8: Run.** `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-band.spec.ts tests/e2e/console-header.spec.ts tests/e2e/console-list.spec.ts` (band 10 passed, header 9, list 9) and `npx vitest run` (set `BUDGET`).

- [ ] **Step 9: Baselines.** `--update-snapshots`; review the 14 PNGs: two lanes under the header (Hall B HOLD amber, Main Stage LIVE red wash), countdown masked, Hold, a divider and End in the same place in both lanes; the 1280 lanes on one line each; four rooms with Terrace as a chip. Full console suite `0 failed`.

- [ ] **Step 10: Commit.**

```bash
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-band.spec.ts tests/e2e/console-header.spec.ts tests/e2e/console-visual.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): now and next band, one lane per room with fixed End slot and overrun knock-on

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-band.spec.ts tests/e2e/console-header.spec.ts tests/e2e/console-visual.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 4.2: Inspector and event log

**Files:**
- Modify `cuedeck-console.html`:
  - HTML: `#sidebar` content (2055-2131 after stage 3): keep `#checklist-wrap`; replace `#ctx-wrap` + `#ctx-actions` with `<section id="ctx-wrap" class="insp" aria-labelledby="insp-title"></section>`; replace `#log-panel` (Step 3); add `<div id="sr-announcer" class="sr-only" role="status" aria-live="assertive"></div>` right after `<div id="toast-container" …></div>`.
  - CSS: delete `#ctx-wrap`, `.ctx-title*`, `.ctx-sub*`, `#ctx-actions`, `.ctx-btn*` (keep `.ctx-section-lbl`, `.ctx-booth*`, `.ctx-lang-chip`), `#log-panel*`, `#log-feed`, `.le*`, `.log-export-btn*`; append `/* ═══ Command center inspector and log (stage 4) ═══ */`.
  - JS: `S` (new fields); `buildCtxPanel()` renamed `buildRoleCtxPanel()` with its director/stage and av branches deleted; new `buildCtxPanel()`; `rowHTML()` (selection and drawer); `selectSession()`; `renderSessions()` top; `confirmEnd()`/`confirmCancel()` arming branches; `buildButtons()` deleted; `renderLog()` replaced.
- Modify `cuedeck-i18n.js`: Step 6 keys; `confirm.confirmEnd`, `confirm.confirmCancel` values.
- Create `tests/e2e/console-inspector.spec.ts`. Modify `tests/e2e/console-restart.spec.ts`, `tests/e2e/auth-flows.spec.ts` (test 24), `tests/e2e/console-components.spec.ts` (last test), `tests/e2e/console-list.spec.ts` (selection test), `tests/console-colour-ratchet.spec.ts`.

**Interfaces:**
- Consumes: everything from 3.2 and 4.1, plus `canRestartSession`, `openRestartModal`, `markArrived`, `nudgeSession`, `applyDelay`, `reorderSession`, `openSessModal`, `openStageMonitor`, `openStageTimerDisplay`, `exportLog`, `S.log`.
- Produces JS: `INSPECTOR_ROLES`, `URGENCY`, `mostUrgentSession()`, `inspectorSession()`, `renderInspector()`, `inspectorHTML(s, nowMs)`, `monitorRowHTML()`, `buildRoleCtxPanel()`, `announce(msg)`, `logKind(action)`, `LOG_FILTER`, `setLogFilter(f)`, `logDetail(e)`, `renderLog()`; state `S.inspectedId`, `S.urgentKey`, `S.inspMoreOpen`, `S.logFilter`.
- Produces DOM: `#ctx-wrap.insp` with `#insp-title`, `.insp-head`, `.insp-title`, `.insp-chips`, `.insp-flags`, `.insp-speakers`, `.insp-times`, `.insp-count`, `.insp-big`, `.prog`, `.insp-notes`, `#ctx-actions.insp-controls` holding `.insp-primary`, `.insp-time`, `.insp-monitor`, `#insp-more`; `#log-panel` with `.log-chip[data-f]` and `#log-feed .lg`.

- [ ] **Step 1: Failing tests.** Create `tests/e2e/console-inspector.spec.ts`:

```ts
// tests/e2e/console-inspector.spec.ts
// Spec 2.3: inspector defaults to the most urgent session and follows the
// selection; fixed control slots; two-press End that survives re-renders and
// is announced; time row; More menu; log with filters always visible.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, ID, PANEL_ID } from './console-boot-mock';

const insp = (page: import('@playwright/test').Page) => page.locator('#ctx-wrap');

test('inspector: defaults to the most urgent session (LIVE before HOLD)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(insp(page).locator('.insp-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await expect(insp(page).locator('.insp-big')).toHaveText('19:15');
  await expect(insp(page)).toContainText('Dina Farouk (moderator), Karim Benali, Leila Mansour, Omar Haddad');
  await ctx.close();
});

test('inspector: follows the selection and returns to the most urgent when that changes status', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator(`#card-${ID(6)} .sc-title`).click();
  await expect(insp(page).locator('.insp-title')).toHaveText('Digital Pre-Order and Click & Collect at the Gate');
  await evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').status = 'OVERRUN'; renderSessions();`);
  await expect(insp(page).locator('.insp-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await ctx.close();
});

test('inspector: Hold left of End, and both keep their place from LIVE to OVERRUN', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const pos = async () => ({
    hold: (await insp(page).locator('.insp-primary .hold').boundingBox())!.x,
    end: (await insp(page).locator('.insp-primary .btn.danger').boundingBox())!.x,
  });
  const live = await pos();
  expect(live.hold).toBeLessThan(live.end);
  await evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').status = 'OVERRUN'; renderSessions();`);
  const overrun = await pos();
  expect(Math.abs(overrun.hold - live.hold)).toBeLessThan(1);
  expect(Math.abs(overrun.end - live.end)).toBeLessThan(1);
  await ctx.close();
});

test('inspector: armed End survives re-renders, is announced, and the second press ends', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const end = insp(page).locator('.insp-primary .btn.danger');
  await end.click();
  await expect(end).toHaveClass(/confirm-pending/);
  await expect(end).toHaveText('Press again to end');
  await expect(page.locator('#sr-announcer')).toHaveText('Press again to end');
  await page.clock.runFor(1500);                       // one and a half ticks of re-rendering
  await expect(insp(page).locator('.insp-primary .btn.danger')).toHaveClass(/confirm-pending/);
  await expect(page.locator(`#band .lane[data-room="Main Stage"] .btn.danger`)).toHaveText('Press again to end');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/end-session'));
  await insp(page).locator('.insp-primary .btn.danger').click();
  await sent;
  await ctx.close();
});

test('inspector: the time row separates this session from every later session', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const row = insp(page).locator('.insp-time');
  await expect(row).toContainText('This session');
  await expect(row).toContainText('Push following');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/apply-delay'));
  await row.locator('button', { hasText: '+10' }).click();
  expect(JSON.parse((await sent).postData() || '{}')).toMatchObject({ session_id: PANEL_ID, minutes: 10 });
  await ctx.close();
});

test('inspector: More holds restart, arrival, edit, move and a two-press cancel', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await insp(page).locator('#insp-more summary').click();
  for (const sel of ['[data-restart]', '[data-fk="more-arrive"]', '[data-fk="more-edit"]', '[data-fk="more-up"]', '[data-fk="more-down"]']) {
    await expect(insp(page).locator(sel)).toBeVisible();
  }
  await page.locator(`#card-${ID(6)} .sc-title`).click();
  const cancel = insp(page).locator('#insp-more .btn.danger');
  await cancel.click();
  await expect(insp(page).locator('#insp-more .btn.danger')).toHaveClass(/confirm-pending/);
  await ctx.close();
});

test('inspector: av sees Hold but never End', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'av' });
  await expect(insp(page).locator('.insp-primary .hold')).toBeVisible();
  await expect(insp(page).locator('.insp-primary .btn.danger')).toHaveCount(0);
  await expect(insp(page).locator('.insp-primary .end-slot')).toHaveCount(1);
  await expect(insp(page).locator('.insp-flags')).toHaveClass(/is-prominent/);
  await ctx.close();
});

test('log: filters, own times, newest first, at least 240 px at 1440x900', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  expect((await page.locator('#log-panel').boundingBox())!.height).toBeGreaterThanOrEqual(240);
  const first = page.locator('#log-feed .lg').first();
  await expect(first.locator('.lg-when')).not.toHaveText('');
  await page.locator('.log-chip[data-f="broadcast"]').click();
  await expect(page.locator('.log-chip[data-f="broadcast"]')).toHaveAttribute('aria-pressed', 'true');
  const kinds = await page.locator('#log-feed .lg').evaluateAll(els => [...new Set(els.map(e => e.className))]);
  expect(kinds).toEqual(['lg lg-broadcast']);
  await expect(page.locator('#log-feed')).toContainText('11:32');
  await ctx.close();
});

test('layout: 1280x720 fits the band, six rows and a 200 px log', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { viewport: { width: 1280, height: 720 } });
  expect((await page.locator('#sidebar').boundingBox())!.width).toBe(320);
  expect((await page.locator('#log-panel').boundingBox())!.height).toBeGreaterThanOrEqual(200);
  const colBottom = await page.locator('#sessions-col').evaluate(el => el.getBoundingClientRect().bottom);
  const rows = await page.locator('#sessions-list .sc').evaluateAll((els, b) => els.filter(e => e.getBoundingClientRect().bottom <= (b as number)).length, colBottom);
  expect(rows).toBeGreaterThanOrEqual(6);
  for (const lane of await page.locator('#band .lane').all()) {
    const b = (await lane.boundingBox())!;
    expect(Math.round(b.height)).toBeLessThanOrEqual(45);
  }
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure.** Expected: 9 failed (no `.insp-title`, log has no chips).

- [ ] **Step 3: Markup.** In `#sidebar`, delete the `<!-- Context Panel -->` `#ctx-wrap` div and the `<div id="ctx-actions"></div>` line and put in their place (after `#checklist-wrap` stays first, so move `#checklist-wrap` above it if needed):

```html
    <section id="ctx-wrap" class="insp" aria-labelledby="insp-title"></section>
```

Replace `#log-panel` with (`I(name)` written out as the literal SVG `<svg class="ico" aria-hidden="true" focusable="false"><use href="#i-NAME"/></svg>`):

```html
    <div id="log-panel" aria-labelledby="log-title">
      <div class="log-head">
        <span class="lbl" id="log-title" data-i18n="cc.log.title">Event log</span>
        <button type="button" class="btn sm ghost" onclick="exportLog()">I(download)<span data-i18n="cc.log.export">Export CSV</span></button>
      </div>
      <div class="log-filters" role="group" aria-labelledby="log-title">
        <button type="button" class="log-chip" data-f="all" aria-pressed="true" onclick="setLogFilter('all')" data-i18n="cc.log.all">All</button>
        <button type="button" class="log-chip" data-f="status" aria-pressed="false" onclick="setLogFilter('status')" data-i18n="cc.log.status">Status</button>
        <button type="button" class="log-chip" data-f="broadcast" aria-pressed="false" onclick="setLogFilter('broadcast')" data-i18n="cc.log.broadcast">Broadcast</button>
        <button type="button" class="log-chip" data-f="errors" aria-pressed="false" onclick="setLogFilter('errors')" data-i18n="cc.log.errors">Errors</button>
      </div>
      <div id="log-feed" role="log"></div>
    </div>
```

Add `<div id="sr-announcer" class="sr-only" role="status" aria-live="assertive"></div>` after the toast container.

- [ ] **Step 4: JS.** Add to `S`: `inspectedId: null, urgentKey: '', inspMoreOpen: false, logFilter: 'all',`. Rename the existing `function buildCtxPanel()` to `function buildRoleCtxPanel()` and delete its `if (role === 'director' || role === 'stage') { … } else if (role === 'av') { … } else ` prefix so the chain starts at `if (role === 'signage') {`. Delete `buildButtons()`. Add the section:

```js
// ═══════════════════════════════════════════════════
// COMMAND CENTER: inspector and log (stage 4)
// ═══════════════════════════════════════════════════
const INSPECTOR_ROLES = ['director', 'stage', 'av'];
const URGENCY = { OVERRUN: 0, LIVE: 1, HOLD: 2, CALLING: 3 };
// Live region for the armed confirm (spec 2.3). Synchronous on purpose; a
// trailing no-break space makes a repeated message count as a change.
function announce(msg) {
  const el = document.getElementById('sr-announcer');
  if (!el) return;
  el.textContent = el.textContent === msg ? msg + '\u00A0' : msg;
}
// OVERRUN > LIVE > HOLD > CALLING > the next READY (spec 2.3)
function mostUrgentSession() {
  const ranked = S.sessions.filter(s => s.status in URGENCY)
    .sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || a.sort_order - b.sort_order);
  if (ranked.length) return ranked[0];
  return S.sessions.filter(s => s.status === 'READY')
    .sort((a, b) => toMins(a.scheduled_start) - toMins(b.scheduled_start) || a.sort_order - b.sort_order)[0] || null;
}
// Follows the user's selection; when the most urgent session changes (another
// session or a new status) it returns there, unless the selected session has an
// armed End or Cancel, so a second press never lands on a different session.
function inspectorSession() {
  const urgent = mostUrgentSession();
  const key = urgent ? `${urgent.id}:${urgent.status}` : '';
  if (key !== S.urgentKey) {
    S.urgentKey = key;
    const armed = S.selectedId && (_endPending.has(S.selectedId) || _cancelPending.has(S.selectedId));
    if (!armed) S.selectedId = null;
  }
  return (S.selectedId && S.sessions.find(s => s.id === S.selectedId)) || urgent;
}

function monitorRowHTML() {
  const timer = S.role !== 'av'
    ? `<button type="button" class="btn sm" data-fk="insp-timer" onclick="openStageTimerDisplay()">${icon('timer')}${esc(t('cc.insp.stageTimer'))}</button>` : '';
  return `<div class="insp-row insp-monitor"><button type="button" class="btn sm" data-fk="insp-monitor" onclick="openStageMonitor()">${icon('monitor')}${esc(t('cc.insp.stageMonitor'))}</button>${timer}</div>`;
}

function inspectorHTML(s, nowMs) {
  const live = s.status === 'LIVE' || s.status === 'OVERRUN';
  const tm = live ? liveTiming(s, nowMs) : null;
  const over = s.status === 'OVERRUN' || !!(tm && tm.overrun);
  const cd = countdownLabel(s, nowMs);
  const ppl = people(s);
  const speakers = ppl.length ? ppl : (s.speaker ? [{ name: s.speaker, role: '' }] : []);
  const canArrive = (S.role === 'director' || S.role === 'stage') && speakers.length > 0 && !FINISHED.includes(s.status);
  const speakerRow = speakers.length ? `<div class="insp-speakers"><span>${esc(speakers.map(p => p.name + (p.role === 'moderator' ? ` (${t('cc.list.moderator')})` : '')).join(', '))}</span>
      ${canArrive
        ? `<button type="button" class="btn sm${s.speaker_arrived ? '' : ' primary'}" data-fk="insp-arrive" aria-pressed="${!!s.speaker_arrived}" onclick="markArrived('${s.id}', ${!s.speaker_arrived})">${s.speaker_arrived ? icon('check') + esc(t('cc.list.arrived')) : esc(t('cc.insp.markArrived'))}</button>`
        : (s.speaker_arrived ? `<span class="sc-flag sc-arrived">${icon('check')}${esc(t('cc.list.arrived'))}</span>` : '')}</div>` : '';
  const plannedDiffers = s.planned_start !== s.scheduled_start || s.planned_end !== s.scheduled_end;
  const times = `<div class="insp-row insp-times"><span>${esc(t('cc.insp.scheduled'))} ${sessionSpan(s)}</span>`
    + (plannedDiffers ? `<span>${esc(t('cc.insp.planned'))} ${hm(s.planned_start)}–${hm(s.planned_end)}</span>` : '')
    + (s.actual_start ? `<span>${esc(t('cc.insp.started'))} ${tsHM(s.actual_start)}</span>` : '') + `</div>`;
  const countdown = cd ? `<div class="insp-count${over ? ' is-over' : s.status === 'HOLD' ? ' is-held' : ''}" data-timer>
      <span class="insp-big">${esc(cd.big)}</span>
      <span class="insp-unit">${esc(tm && !over ? tf('cc.insp.elapsed', { time: fmtDur(tm.elapsed) }) : cd.unit)}</span></div>
      ${tm ? `<div class="prog${over ? ' is-over' : ''}"><i style="width:${over ? 100 : tm.pct.toFixed(1)}%"></i></div>` : ''}` : '';
  const notes = s.notes && s.notes.trim() ? `<div class="insp-notes">${icon('note')}<span>${esc(s.notes)}</span></div>` : '';
  // Primary row with fixed slots: [forward] [Hold] | gap | [End or empty slot]
  const fwd = live ? '' : primaryButtonHTML(s, 'lg', 'insp');
  const hold = s.status !== 'HOLD' && canDo(s, 'HOLD') ? transitionButtonHTML(s, 'HOLD', 'lg', 'insp') : '';
  const end = endButtonHTML(s, 'lg', 'insp') || '<span class="end-slot" aria-hidden="true"></span>';
  const primaryRow = `<div class="insp-row insp-primary">${fwd}${hold}<span class="act-gap" aria-hidden="true"></span>${end}</div>`;
  // Time row: this session only, visibly apart from pushing every later session
  const canNudge = live && (S.role === 'director' || S.role === 'stage');
  const canPush = !!ROLE_DELAY[S.role] && ['LIVE', 'OVERRUN', 'HOLD', 'READY', 'CALLING'].includes(s.status);
  const timeRow = (canNudge || canPush) ? `<div class="insp-row insp-time">`
    + (canNudge ? `<span class="lbl">${esc(t('cc.insp.thisSession'))}</span>
        <button type="button" class="btn sm" data-fk="insp-nudge-m" onclick="nudgeSession('${s.id}',-1)">${esc(t('cc.insp.minus1'))}</button>
        <button type="button" class="btn sm" data-fk="insp-nudge-p" onclick="nudgeSession('${s.id}',1)">${esc(t('cc.insp.plus1'))}</button>` : '')
    + (canNudge && canPush ? '<span class="act-gap" aria-hidden="true"></span>' : '')
    + (canPush ? `<span class="lbl">${esc(t('cc.insp.pushFollowing'))}</span>`
        + [5, 10, 15].map(n => `<button type="button" class="btn sm" data-fk="insp-push-${n}" onclick="applyDelay('${s.id}',${n})">+${n}</button>`).join('') : '')
    + `</div>` : '';
  // More: every other legal action
  const isDirector = S.role === 'director' || S.userRole === 'director';
  const others = (ALLOWED[s.status] || []).filter(to => !['ENDED', 'CANCELLED', 'HOLD'].includes(to) && to !== primaryTransition(s) && canDo(s, to));
  const moreItems = [
    ...others.map(to => transitionButtonHTML(s, to, 'sm', 'more')),
    canRestartSession(s) ? `<button type="button" class="btn sm" data-restart="${esc(s.id)}" data-fk="more-restart" onclick="openRestartModal('${esc(s.id)}')">${icon('refresh')}${esc(t('cc.insp.restart'))}</button>` : '',
    canArrive ? `<button type="button" class="btn sm" data-fk="more-arrive" onclick="markArrived('${s.id}', ${!s.speaker_arrived})">${icon('check')}${esc(s.speaker_arrived ? t('cc.insp.clearArrived') : t('cc.insp.markArrived'))}</button>` : '',
    isDirector ? `<button type="button" class="btn sm" data-fk="more-edit" onclick="openSessModal('edit','${s.id}')">${icon('edit')}${esc(t('cc.list.edit'))}</button>` : '',
    isDirector ? `<button type="button" class="btn sm" data-fk="more-up" onclick="reorderSession('${s.id}','up')">${icon('arrow-up')}${esc(t('cc.list.moveUp'))}</button>` : '',
    isDirector ? `<button type="button" class="btn sm" data-fk="more-down" onclick="reorderSession('${s.id}','down')">${icon('arrow-down')}${esc(t('cc.list.moveDown'))}</button>` : '',
    cancelButtonHTML(s, 'sm', 'more'),
  ].filter(Boolean).join('');
  const more = moreItems ? `<details class="insp-more" id="insp-more"${S.inspMoreOpen ? ' open' : ''} ontoggle="S.inspMoreOpen = this.open">
      <summary class="btn sm ghost" data-fk="insp-more">${esc(t('cc.insp.more'))}${icon('chev-down')}</summary>
      <div class="insp-more-list">${moreItems}</div></details>` : '';
  const typeLabel = s.type ? (t('type.' + s.type) !== 'type.' + s.type ? t('type.' + s.type) : s.type) : '';
  return `<div class="insp-head"><span class="lbl" id="insp-title">${esc(t('cc.insp.label'))} · #${s.sort_order}</span>${statusBadge(s.status)}</div>
    <div class="insp-title">${esc(s.title)}</div>
    <div class="insp-row insp-chips">${s.room ? chipHTML('room', s.room) : ''}${typeLabel ? chipHTML('type', typeLabel) : ''}<span class="insp-flags${S.role === 'av' ? ' is-prominent' : ''}">${flagsHTML(s)}</span></div>
    ${speakerRow}${times}${countdown}${notes}
    <div id="ctx-actions" class="insp-controls">${primaryRow}${timeRow}${monitorRowHTML()}${more}</div>`;
}

function renderInspector() {
  const wrap = document.getElementById('ctx-wrap');
  if (!wrap) return;
  const fk = focusKey();
  if (!INSPECTOR_ROLES.includes(S.role)) {
    // interp, reg, signage keep their own panels (spec 2.8), restyled by tokens
    wrap.innerHTML = `<span class="lbl" id="insp-title">${esc(t('role.' + S.role))}</span>
      <div id="ctx-title" class="ctx-title ctx-empty"></div><div id="ctx-sub" class="ctx-sub"></div><div id="ctx-actions" class="insp-controls"></div>`;
    buildRoleCtxPanel();
  } else {
    const s = inspectorSession();
    wrap.innerHTML = s ? inspectorHTML(s, correctedNow())
      : `<div class="insp-head"><span class="lbl" id="insp-title">${esc(t('cc.insp.label'))}</span></div>
         <p class="insp-empty">${esc(t('cc.insp.empty'))}</p><div id="ctx-actions" class="insp-controls">${monitorRowHTML()}</div>`;
  }
  restoreFocus(fk);
}
// Every existing caller (nudge, timeline, role switch) keeps calling this name.
function buildCtxPanel() { renderInspector(); }

// ── Event log: filter chips, each row with its own time (spec 2.3) ──
function logKind(action) {
  const a = String(action || '').toUpperCase();
  if (['ESCALATION', 'ERROR', 'FAIL'].some(k => a.includes(k))) return 'error';
  if (a.includes('BROADCAST')) return 'broadcast';
  if (a.includes('DELAY') || a.includes('NUDGE')) return 'delay';
  if (['SESSION_STATUS_CHANGE', 'GO_LIVE', 'END_SESSION', 'SET_READY', 'HOLD_STAGE', 'CALL_SPEAKER', 'CANCEL_SESSION', 'REINSTATE', 'STATUS', 'UNDO', 'RESTART', 'AUTO-START', 'ARRIVED', 'EF'].some(k => a.includes(k))) return 'state';
  if (['BOOT', 'SYSTEM', 'CLOCK', 'DB', 'SIGNAGE'].some(k => a.includes(k))) return 'system';
  return 'other';
}
const LOG_FILTER = { all: () => true, status: k => k === 'state' || k === 'delay', broadcast: k => k === 'broadcast', errors: k => k === 'error' };
function setLogFilter(f) {
  S.logFilter = f;
  document.querySelectorAll('#log-panel .log-chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
  renderLog();
}
function logDetail(e) {
  const sess = e.sessionId ? S.sessions.find(x => x.id === e.sessionId) : null;
  const who = sess ? `#${sess.sort_order} ${trunc(sess.title, 32)} ` : '';
  return who + String(e.detail || '').replace(/\s*→\s*/g, ` ${t('cc.log.to')} `);
}
function renderLog() {
  const feed = document.getElementById('log-feed');
  if (!feed) return;
  const keep = LOG_FILTER[S.logFilter] || LOG_FILTER.all;
  const rows = S.log.filter(e => keep(logKind(e.action)));
  if (!rows.length) { feed.innerHTML = `<div class="lg-empty">${esc(t('cc.log.empty'))}</div>`; return; }
  feed.innerHTML = rows.slice(0, 60).map(e => {
    const k = logKind(e.action);
    return `<div class="lg lg-${k}"><span class="lg-when">${esc(tsHM(e.ts))}</span><span class="lg-kind">${esc(t('cc.log.k.' + k))}</span><span class="lg-what">${esc(logDetail(e))}</span></div>`;
  }).join('');
}
```

Delete the old `function renderLog() { … }` (its `leClass` helper with it). At the top of `renderSessions()`, right after the band lines from Task 4.1, add:

```js
  S.inspectedId = INSPECTOR_ROLES.includes(S.role) ? (inspectorSession()?.id || null) : null;
```

In `rowHTML()`: change `const sel = S.selectedId === s.id;` to `const sel = S.inspectedId === s.id;`, delete the `drawer` constant and the `${drawer}` line. Replace `selectSession()` with:

```js
function selectSession(id) {
  S.selectedId = id;
  renderSessions();
}
```

In the arming branch of `confirmEnd()` (the branch that adds the session to `_endPending`), add as its last two lines `announce(t('confirm.confirmEnd'));` and `renderSessions();`; in the arming branch of `confirmCancel()` add `announce(t('confirm.confirmCancel'));` and `renderSessions();`.

- [ ] **Step 5: CSS.** Delete the rules listed under Files; append:

```css
    /* ═══ Command center inspector and log (stage 4) ═══ */
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    #sidebar { display: flex; flex-direction: column; overflow-y: auto; background: var(--panel); border-inline-start: 1px solid var(--border-section); }
    .insp { display: grid; gap: 10px; align-content: start; padding: 14px 16px; border-bottom: 1px solid var(--border-section); overflow-y: auto; max-height: calc(100% - 240px); flex: 0 1 auto; }
    .insp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .insp-title { font-size: var(--fs-16); font-weight: 700; line-height: 1.3; color: var(--text-primary); }
    .insp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--fs-12); color: var(--text-secondary); }
    .insp-flags { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--text-tertiary); }
    .insp-flags.is-prominent { color: var(--text-primary); font-size: var(--fs-13); font-weight: 600; }
    .insp-speakers { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: var(--fs-13); color: var(--text-primary); }
    .insp-times { gap: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .insp-count { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .insp-big { font: 700 var(--fs-insp-countdown)/1 var(--font-sans); font-variant-numeric: tabular-nums; letter-spacing: var(--ls-big); color: var(--text-primary); }
    .insp-count.is-over .insp-big { color: var(--st-overrun-fg); }
    .insp-count.is-held .insp-big { color: var(--st-hold-fg); }
    .insp-unit { font-size: var(--fs-12); color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .prog { height: 4px; border-radius: 2px; background: var(--raised); overflow: hidden; }
    .prog i { display: block; height: 100%; background: var(--st-live); }
    .prog.is-over i { background: var(--st-overrun); }
    .insp-notes { display: flex; gap: 6px; align-items: flex-start; font-size: var(--fs-12); color: var(--text-secondary); white-space: pre-wrap; }
    .insp-controls { display: grid; gap: 10px; }
    .insp-primary { flex-wrap: nowrap; }
    .insp-primary .btn.danger, .insp-primary .end-slot { margin-inline-start: auto; width: 148px; overflow: hidden; text-overflow: ellipsis; }
    .insp-more > summary { list-style: none; width: max-content; }
    .insp-more > summary::-webkit-details-marker { display: none; }
    .insp-more-list { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 8px; }
    .insp-empty { margin: 0; color: var(--text-tertiary); font-size: var(--fs-13); }
    .ctx-title { font-size: var(--fs-14); font-weight: 600; } .ctx-title.ctx-empty { color: var(--text-tertiary); font-weight: 400; }
    .ctx-sub { font-size: var(--fs-12); color: var(--text-tertiary); }
    .ctx-btn { width: 100%; justify-content: flex-start; }
    #log-panel { flex: 1 0 240px; min-height: 240px; display: flex; flex-direction: column; overflow: hidden; }
    .log-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px 6px; }
    .log-filters { display: flex; gap: 6px; padding: 0 16px 8px; }
    .log-chip { height: 24px; padding: 0 10px; border-radius: var(--r-pill); border: 1px solid var(--border-divider); background: transparent; color: var(--text-secondary); font: 600 var(--fs-12) var(--font-sans); cursor: pointer; }
    .log-chip[aria-pressed="true"] { background: var(--raised); border-color: var(--border-control); color: var(--text-primary); }
    #log-feed { flex: 1; overflow-y: auto; padding: 0 16px 12px; }
    .lg { display: grid; grid-template-columns: 44px 76px minmax(0, 1fr); gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--border-divider); font-size: var(--fs-12); color: var(--text-secondary); }
    .lg-when { color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .lg-kind { font-weight: 700; font-size: var(--fs-11); letter-spacing: var(--ls-badge); text-transform: uppercase; color: var(--text-tertiary); }
    .lg-error .lg-kind { color: var(--st-live-fg); } .lg-broadcast .lg-kind { color: var(--st-hold-fg); }
    .lg-state .lg-kind { color: var(--st-ready-fg); } .lg-delay .lg-kind { color: var(--st-overrun-fg); }
    .lg-what { overflow-wrap: anywhere; }
    .lg-empty { color: var(--text-tertiary); font-size: var(--fs-12); padding: 4px 0; }
    @media (max-width: 1439px) {
      .insp { max-height: calc(100% - 200px); gap: 8px; padding: 12px; }
      .insp-notes span { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
      #log-panel { flex-basis: 200px; min-height: 200px; }
    }
```

- [ ] **Step 6: Strings** (all four blocks), and change the existing values: `confirm.confirmEnd` en `Press again to end`, ar `اضغط مرة أخرى للإنهاء`, pl `Naciśnij ponownie, aby zakończyć`, de `Zum Beenden erneut drücken`; `confirm.confirmCancel` en `Press again to cancel`, ar `اضغط مرة أخرى للإلغاء`, pl `Naciśnij ponownie, aby anulować`, de `Zum Abbrechen erneut drücken`.

| Key | en | ar | pl | de |
|---|---|---|---|---|
| `cc.insp.label` | Selected | المحدد | Wybrana | Ausgewählt |
| `cc.insp.empty` | No session selected | لم يتم تحديد جلسة | Nie wybrano sesji | Keine Sitzung ausgewählt |
| `cc.insp.planned` | Planned | مخطط | Plan | Geplant |
| `cc.insp.scheduled` | Scheduled | مجدول | Harmonogram | Terminiert |
| `cc.insp.started` | Started | بدأ | Start | Gestartet |
| `cc.insp.elapsed` | {time} elapsed | مضى {time} | minęło {time} | {time} vergangen |
| `cc.insp.thisSession` | This session | هذه الجلسة | Ta sesja | Diese Sitzung |
| `cc.insp.pushFollowing` | Push following | تأجيل التالي | Przesuń kolejne | Folgende verschieben |
| `cc.insp.minus1` | −1 min | −1 د | −1 min | −1 Min |
| `cc.insp.plus1` | +1 min | +1 د | +1 min | +1 Min |
| `cc.insp.stageMonitor` | Stage monitor | شاشة المسرح | Monitor sceny | Bühnenmonitor |
| `cc.insp.stageTimer` | Stage timer | مؤقت المسرح | Timer sceny | Bühnentimer |
| `cc.insp.more` | More | المزيد | Więcej | Mehr |
| `cc.insp.markArrived` | Mark arrived | تأكيد الوصول | Oznacz obecność | Als da markieren |
| `cc.insp.clearArrived` | Mark not arrived | إلغاء الوصول | Cofnij obecność | Als nicht da markieren |
| `cc.insp.restart` | Restart | إعادة البدء | Od nowa | Neustart |
| `cc.log.title` | Event log | سجل الحدث | Dziennik | Ereignisprotokoll |
| `cc.log.all` | All | الكل | Wszystko | Alle |
| `cc.log.status` | Status | الحالة | Status | Status |
| `cc.log.broadcast` | Broadcast | رسائل | Komunikaty | Durchsagen |
| `cc.log.errors` | Errors | أخطاء | Błędy | Fehler |
| `cc.log.export` | Export CSV | تصدير CSV | Eksport CSV | CSV exportieren |
| `cc.log.empty` | No events yet | لا أحداث بعد | Brak zdarzeń | Noch keine Ereignisse |
| `cc.log.to` | to | إلى | na | zu |
| `cc.log.k.state` | Status | الحالة | Status | Status |
| `cc.log.k.broadcast` | Broadcast | رسالة | Komunikat | Durchsage |
| `cc.log.k.error` | Error | خطأ | Błąd | Fehler |
| `cc.log.k.system` | System | النظام | System | System |
| `cc.log.k.delay` | Delay | تأخير | Opóźnienie | Verschiebung |
| `cc.log.k.other` | Event | حدث | Zdarzenie | Ereignis |

- [ ] **Step 7: Tests that select on what moved (same commit).**
  - `tests/e2e/console-restart.spec.ts`: change `restartBtn` and `openControls` to:

```ts
// Restart sits in the inspector's More menu for the selected session (stage 4).
const restartBtn = (page: Page, _id: string) => page.locator('#ctx-wrap [data-restart]');
async function openControls(page: Page, id: string) {
  await page.evaluate((sid) => (0, eval)(`S.inspMoreOpen = true; S.selectedId = '${sid}'; renderSessions();`), id);
}
```

  - `tests/e2e/auth-flows.spec.ts` test 24: replace the two lines from Task 3.2 with:

```ts
    await sessionCard.click();
    await page.locator('#ctx-wrap #insp-more summary').click();
    await page.locator(`#ctx-wrap button[onclick*="'LIVE')"]`).first().click();
```

  - `tests/e2e/console-components.spec.ts`, last test: replace its body after `openConsole` with:

```ts
  const order = await page.locator('#ctx-wrap .insp-primary').evaluate(el => [...el.children].map(c =>
    c.classList.contains('act-gap') ? 'gap' : c.classList.contains('hold') ? 'hold' : c.classList.contains('danger') ? 'end' : 'other'));
  expect(order).toEqual(['hold', 'gap', 'end']);
```

  - `tests/e2e/console-list.spec.ts` "click, Enter and arrow keys select a row": the selection now also shows in the inspector; add at its end `await expect(page.locator('#ctx-wrap .insp-title')).toHaveText('Case Study: Rebuilding the Hurghada Arrivals Store');`.

- [ ] **Step 8: Run.** `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-inspector.spec.ts tests/e2e/console-restart.spec.ts tests/e2e/console-confirm.spec.ts tests/e2e/console-components.spec.ts tests/e2e/console-list.spec.ts tests/e2e/auth-flows.spec.ts tests/e2e/session-management.spec.ts` (all pass; inspector 9) and `npx vitest run` (set `BUDGET`).

- [ ] **Step 9: Baselines.** `--update-snapshots`; review: the rail shows the inspector (badge, title, chips, speakers, times, masked countdown, progress, note, Hold | End, time row, monitor row, More) and the log with chips below it, visible at 1440 and 1280; the armed baseline shows "Press again to end" in the band, the row and the inspector at once. Full console suite `0 failed`.

- [ ] **Step 10: Commit.**

```bash
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-inspector.spec.ts tests/e2e/console-restart.spec.ts tests/e2e/auth-flows.spec.ts tests/e2e/console-components.spec.ts tests/e2e/console-list.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): inspector with fixed control slots and an event log with filters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-inspector.spec.ts tests/e2e/console-restart.spec.ts tests/e2e/auth-flows.spec.ts tests/e2e/console-components.spec.ts tests/e2e/console-list.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 4.3: Timeline view

**Files:**
- Modify `cuedeck-console.html`: `renderTimeline()` (replaced whole, including `statusColor` from Task 1.2 staying above it); `S` (`tlFit: false,`); the `/* ── Timeline view (PR-020) */` CSS block (`#timeline-wrap` to `.tl-bar-label`) replaced.
- Modify `cuedeck-i18n.js` (Step 4 keys). Create `tests/e2e/console-timeline.spec.ts`. Modify `tests/e2e/console-visual.spec.ts` (one case).

**Interfaces:**
- Consumes: `statusColor`, `roomsInOrder`, `roomOf`, `ROOM_NONE`, `eventNowMinutes`, `selectSession`, `S.inspectedId`, `hm`, `addMinutes`, `toMins`, `sessionSpan`, `applyFilters`.
- Produces: `renderTimeline()`, `toggleTlFit()`, DOM `.tl-item[data-sid][data-st]`, `.tl-bar`, `.tl-planned`, `.tl-over`, `.tl-now-line`, `#tl-hatch`.

- [ ] **Step 1: Failing tests.** Create `tests/e2e/console-timeline.spec.ts`:

```ts
// tests/e2e/console-timeline.spec.ts
// Spec 2.5: 40 px lanes, "HH:MM Title" labels, NOW -1 h to +3 h with Fit day,
// planned outline, overrun hatched, NOW in event-local time, click selects.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, ID, PANEL_ID, overrunSessions } from './console-boot-mock';

test('timeline: 40 px lanes and labels that read HH:MM Title', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  const svgH = await page.locator('#timeline-wrap svg.tl-svg').getAttribute('height');
  expect(Number(svgH)).toBe(24 + 2 * 40 + 20);
  await expect(page.locator(`.tl-item[data-sid="${PANEL_ID}"] .tl-bar-label`)).toHaveText(/^11:30 Panel: Airport Retail/);
  await expect(page.locator(`.tl-item[data-sid="${PANEL_ID}"] title`)).toContainText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  await ctx.close();
});

test('timeline: opens at NOW -1 h to +3 h; Fit day shows the whole day', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  await expect(page.locator(`.tl-item[data-sid="${ID(1)}"]`)).toHaveCount(0);   // 09:30 keynote is outside 10:40 to 14:40
  const labels = await page.locator('.tl-time-label').allTextContents();
  expect(labels[0]).toBe('11:00');
  expect(labels[labels.length - 1]).toBe('14:30');
  await page.locator('#timeline-wrap button[aria-pressed]').click();
  await expect(page.locator(`.tl-item[data-sid="${ID(1)}"]`)).toHaveCount(1);
  await ctx.close();
});

test('timeline: planned time is an outline when it differs; overrun is hatched', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: overrunSessions() });
  await evalPage(page, `setViewMode('timeline')`);
  await expect(page.locator(`.tl-item[data-sid="${ID(5)}"] .tl-planned`)).toHaveCount(1);
  await expect(page.locator(`.tl-item[data-sid="${ID(6)}"] .tl-planned`)).toHaveCount(1);
  await expect(page.locator(`.tl-item[data-sid="${PANEL_ID}"] .tl-over`)).toHaveCount(1);
  expect(await page.locator(`.tl-item[data-sid="${PANEL_ID}"] .tl-over`).getAttribute('fill')).toBe('url(#tl-hatch)');
  await ctx.close();
});

test('timeline: the NOW line is in event-local time (browser UTC, event Cairo)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  const xs = await page.evaluate(() => {
    const ticks = [...document.querySelectorAll('.tl-time-label')].map(t => [t.textContent, Number(t.getAttribute('x'))]);
    const now = Number(document.querySelector('.tl-now-line')!.getAttribute('x1'));
    return { t1130: ticks.find(t => t[0] === '11:30')![1] as number, t1200: ticks.find(t => t[0] === '12:00')![1] as number, now };
  });
  expect(xs.now).toBeGreaterThan(xs.t1130);
  expect(xs.now).toBeLessThan(xs.t1200);
  await ctx.close();
});

test('timeline: clicking a bar selects it in the inspector and the band stays', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  await page.locator(`.tl-item[data-sid="${ID(5)}"] .tl-bar`).click();
  await expect(page.locator('#ctx-wrap .insp-title')).toHaveText('Duty Free Pricing After the Currency Float');
  await expect(page.locator('#band')).toBeVisible();
  await expect(page.locator(`.tl-item[data-sid="${ID(5)}"] .tl-bar`)).toHaveClass(/is-selected/);
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure** (lanes 44 px, labels truncated to 18 characters, no `.tl-item`).

- [ ] **Step 3: Implement.** Add `tlFit: false,` to `S`. Replace `renderTimeline()` with:

```js
// Spec 2.5: rooms as 40 px lanes; NOW -1 h to +3 h (or the whole day with
// Fit day); planned time as an outline, scheduled as the fill with dark text;
// LIVE and OVERRUN grow to NOW with the overrun part hatched; NOW in event time.
function renderTimeline() {
  const list = document.getElementById('sessions-list');
  const visible = applyFilters().filter(s => s.scheduled_start && s.scheduled_end);
  const nowMin = eventNowMinutes();
  const head = `<div class="tl-bar-head"><span class="lbl">${esc(t('filter.timeline'))}</span>
    <button type="button" class="btn sm ghost" aria-pressed="${!!S.tlFit}" onclick="toggleTlFit()">${esc(t('cc.tl.fitDay'))}</button></div>`;
  if (!visible.length) {
    list.innerHTML = `<div id="timeline-wrap">${head}<p class="tl-empty">No sessions to display in timeline.</p></div>`;
    buildCtxPanel();
    return;
  }
  const starts = visible.map(s => toMins(s.scheduled_start));
  const ends = visible.map(s => toMins(s.scheduled_end));
  const minMins = S.tlFit ? Math.max(0, Math.min(...starts) - 15) : Math.max(0, Math.floor(nowMin) - 60);
  const maxMins = S.tlFit ? Math.min(1440, Math.max(...ends) + 15) : Math.min(1440, Math.floor(nowMin) + 180);
  const spanMins = Math.max(30, maxMins - minMins);
  const ROW_H = 40, BAR_H = 28, LABEL_W = 110, PAD_TOP = 24;
  const SVG_W = Math.max(600, (document.getElementById('sessions-col')?.clientWidth || 900) - 32);
  const CHART_W = SVG_W - LABEL_W;
  const x = m => LABEL_W + ((m - minMins) / spanMins) * CHART_W;
  const rooms = roomsInOrder().filter(r => visible.some(s => roomOf(s) === r));
  const SVG_H = PAD_TOP + rooms.length * ROW_H + 20;
  const step = spanMins <= 120 ? 15 : spanMins <= 360 ? 30 : 60;
  let ticks = '';
  for (let m = Math.ceil(minMins / step) * step; m <= maxMins; m += step) {
    ticks += `<line class="tl-tick" x1="${x(m)}" y1="${PAD_TOP - 4}" x2="${x(m)}" y2="${SVG_H - 10}"/>`
           + `<text class="tl-time-label" x="${x(m)}" y="${PAD_TOP - 8}" text-anchor="middle">${addMinutes('00:00', m)}</text>`;
  }
  let rows = '';
  rooms.forEach((room, i) => {
    const y = PAD_TOP + i * ROW_H;
    const by = y + (ROW_H - BAR_H) / 2;
    if (i % 2 === 0) rows += `<rect class="tl-stripe" x="${LABEL_W}" y="${y}" width="${CHART_W}" height="${ROW_H}"/>`;
    rows += `<text class="tl-room-label" x="${LABEL_W - 8}" y="${y + ROW_H / 2 + 4}" text-anchor="end">${esc(room === ROOM_NONE ? t('cc.band.noRoom') : room)}</text>`;
    for (const s of visible.filter(v => roomOf(v) === room)) {
      const ss = toMins(s.scheduled_start), se = toMins(s.scheduled_end);
      const ps = toMins(s.planned_start), pe = toMins(s.planned_end);
      const running = (s.status === 'LIVE' || s.status === 'OVERRUN') && !!s.actual_start;
      const endMin = running && nowMin > se ? nowMin : se;
      if (endMin < minMins || ss > maxMins) continue;
      const bx = x(Math.max(ss, minMins));
      const bw = Math.max(4, x(Math.min(endMin, maxMins)) - bx);
      const label = `${hm(s.scheduled_start)} ${s.title}`;
      let g = `<g class="tl-item" data-sid="${s.id}" data-st="${s.status}" tabindex="0" role="button" aria-label="${esc(label)}"
          onclick="selectSession('${s.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectSession('${s.id}')}">
        <title>${esc(s.title)} · ${sessionSpan(s)} · ${esc(t('status.' + s.status))}</title>`;
      if (ps !== ss || pe !== se) g += `<rect class="tl-planned" x="${x(ps)}" y="${by - 3}" width="${Math.max(4, x(pe) - x(ps))}" height="${BAR_H + 6}" rx="6"/>`;
      g += `<rect class="tl-bar${S.inspectedId === s.id ? ' is-selected' : ''}" x="${bx}" y="${by}" width="${bw}" height="${BAR_H}" rx="6" fill="${statusColor(s.status)}"/>`;
      if (running && nowMin > se) {
        const ox = x(Math.max(se, minMins));
        g += `<rect class="tl-over" x="${ox}" y="${by}" width="${Math.max(2, x(Math.min(endMin, maxMins)) - ox)}" height="${BAR_H}" fill="url(#tl-hatch)"/>`;
      }
      if (bw > 40) g += `<svg x="${bx}" y="${by}" width="${bw}" height="${BAR_H}" overflow="hidden"><text class="tl-bar-label" x="6" y="${BAR_H / 2 + 4}">${esc(label)}</text></svg>`;
      rows += g + '</g>';
    }
  });
  const nowLine = nowMin >= minMins && nowMin <= maxMins
    ? `<line class="tl-now-line" x1="${x(nowMin)}" y1="${PAD_TOP - 4}" x2="${x(nowMin)}" y2="${SVG_H - 10}"/>`
      + `<text class="tl-now-label" x="${x(nowMin)}" y="${SVG_H - 1}" text-anchor="middle">${esc(t('cc.tl.now'))}</text>`
    : '';
  list.innerHTML = `<div id="timeline-wrap">${head}
    <svg class="tl-svg" width="${SVG_W}" height="${SVG_H}" role="img" aria-label="${esc(t('filter.timeline'))}">
      <defs><pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="tl-hatch-bg" width="6" height="6"/><line class="tl-hatch-line" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>
      ${ticks}${rows}${nowLine}
    </svg></div>`;
  buildCtxPanel();
}
function toggleTlFit() { S.tlFit = !S.tlFit; renderTimeline(); }
```

Replace the timeline CSS block with:

```css
    #timeline-wrap { padding: 8px 0; overflow-x: auto; }
    .tl-bar-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; }
    .tl-svg { display: block; overflow: visible; }
    .tl-tick { stroke: var(--border-divider); stroke-width: 1; }
    .tl-stripe { fill: var(--card); opacity: .5; }
    .tl-room-label { font: 600 var(--fs-12) var(--font-sans); fill: var(--text-secondary); }
    .tl-time-label { font: 500 var(--fs-11) var(--font-sans); fill: var(--text-tertiary); }
    .tl-planned { fill: none; stroke: var(--border-control); stroke-width: 1; stroke-dasharray: 3 3; }
    .tl-item { cursor: pointer; }
    .tl-item:focus { outline: none; }
    .tl-bar.is-selected, .tl-item:focus-visible .tl-bar { stroke: var(--focus); stroke-width: 2; }
    .tl-bar-label { font: 600 var(--fs-11) var(--font-sans); fill: var(--on-solid); pointer-events: none; }
    .tl-item[data-st="ENDED"] .tl-bar-label, .tl-item[data-st="CANCELLED"] .tl-bar-label { fill: var(--text-primary); }
    .tl-hatch-bg { fill: var(--st-overrun); }
    .tl-hatch-line { stroke: var(--on-solid); stroke-width: 2; opacity: .45; }
    .tl-now-line { stroke: var(--focus); stroke-width: 2; }
    .tl-now-label { font: 700 var(--fs-11) var(--font-sans); fill: var(--focus); }
    .tl-empty { color: var(--text-tertiary); padding: 24px; text-align: center; }
```

- [ ] **Step 4: Strings:** `cc.tl.fitDay` (Fit day | عرض اليوم كاملاً | Cały dzień | Ganzer Tag), `cc.tl.now` (Now | الآن | Teraz | Jetzt). Add `{ name: 'timeline-overrun-1440', sc: { sessions: overrunSessions() }, prep: `setViewMode('timeline')` },` to the visual `CASES`.

- [ ] **Step 5: Run.** Timeline spec 5 passed; tokens spec still passes (`rect.tl-bar` fill from CSS); vitest passes.
- [ ] **Step 6: Baselines.** `--update-snapshots`; review `timeline-1440`, `timeline-overrun-1440`, `browser-cairo-1440`: dark labels on solid bars, NOW line between 11:30 and 12:00, hatched overrun, the band above. Full console suite `0 failed`.
- [ ] **Step 7: Commit.**

```bash
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-timeline.spec.ts tests/e2e/console-visual.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): timeline with 40 px lanes, NOW window, planned outline and hatched overrun

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-timeline.spec.ts tests/e2e/console-visual.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 4.4: Release stage 4

Same steps as Task 1.4 with branch `redesign/stage-4` and notes directory `$SCRATCH/notes/stage-4`. Freeze check first: no release task starts after 18:00 on 10 Oct; a stage not live-checked by 21:00 on 10 Oct waits until after GTR; nothing is pushed on 11 Oct. The pushed range must contain only the Task 4.1 to 4.3 commits. Live check: `curl -s https://app.cuedeck.io/ | grep -o 'id="band"' | head -1` prints the string; in Chrome on Sherif's session (press no show control): the band shows one lane per active room, the inspector sits right with Hold and End apart, the log is visible without scrolling at his laptop size, the timeline keeps the band. Note to Sherif: "Stage 4 (now and next band, inspector, timeline) is live." with before/after pairs for `director-1440`, `overrun-1440`, `director-1280` and `timeline-1440`.

---

# Stage 5: Phone, copy and accessibility

Branch: `redesign/stage-5` from `main` after Task 2.4.

### Task 5.1: Phone layout

**Files:**
- Modify `cuedeck-console.html`:
  - HTML: add `<select id="room-pick" class="ph-only" aria-label="Room" onchange="setMyRoom(this.value)"></select>` in `#header` right after `#hdr-clock`; add `<main id="phone-now" class="ph-only" aria-label="Now"></main>` directly above `<div id="main">`; add `#phone-tabs` directly after `#bc-bar` (Step 3).
  - CSS: in the `max-width: 767px` block delete the lines for `#sidebar` (drawer), `#sidebar-toggle`, `#filter-bar`, `#fb-*`, `.fb-view-pill`, `#bc-bar`, `#bc-input`, `.bc-char`, `#bc-pri`, `#sessions-col`; append `/* ═══ Command center phone (stage 5) ═══ */`.
  - JS: new section `// COMMAND CENTER: phone (stage 5)`; `renderSessions()` top (one line); `showBCBanner()` (tap to expand); a `matchMedia` listener.
- Modify `cuedeck-i18n.js` (Step 5 keys). Create `tests/e2e/console-phone.spec.ts`. Modify `tests/e2e/console-visual.spec.ts` (one case).

**Interfaces:**
- Consumes: `bandLanes`, `myRoom`, `setMyRoom`, `roomsInOrder`, `roomOf`, `ROOM_NONE`, `untilText`, `countdownLabel`, `liveTiming`, `speakerShort`, `statusBadge`, `primaryButtonHTML`, `transitionButtonHTML`, `endButtonHTML`, `canDo`, `nudgeSession`, `applyDelay`, `ROLE_DELAY`, `tf`, `hm`, `icon`, `FINISHED`.
- Produces: `isPhone()`, `setPhoneTab(tab)`, `phoneLaneHTML(lane, nowMs)`, `renderPhoneNow()`, `renderRoomPick()`; DOM `#phone-now`, `#phone-tabs [data-tab]`, `#room-pick`, `.ph-card`, `.ph-now-card`, `.ph-next-card`, `.ph-big`, `.ph-actions`, `.ph-row`; `body[data-ph-tab]`.

- [ ] **Step 1: Failing tests.** Create `tests/e2e/console-phone.spec.ts`:

```ts
// tests/e2e/console-phone.spec.ts
// Spec 2.7: 48 px header with clock, status dot, room picker and menu; Now
// card with a 40 px countdown and two 48 px buttons; Next card; Later rows;
// bottom tabs Now, Schedule, Log, Send; directors get a block per room.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage } from './console-boot-mock';

const PHONE = { viewport: { width: 390, height: 844 }, touch: true } as const;

test('phone: 48 px header with clock, status dot, room picker and menu', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage' });
  expect(Math.round((await page.locator('#header').boundingBox())!.height)).toBe(48);
  for (const id of ['#hdr-clock', '#conn-dot', '#room-pick', '#hamburger-btn']) await expect(page.locator(id)).toBeVisible();
  for (const id of ['#ev-switch', '#crew-pill', '#viewas-wrap', '#help-btn', '#user-chip']) await expect(page.locator(id)).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await ctx.close();
});

test('phone: the Now card for the chosen room has a 40 px countdown and two 48 px buttons', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { ...PHONE, role: 'stage' });
  await page.locator('#room-pick').selectOption('Main Stage');
  await expect(page.locator('#phone-now .ph-lane')).toHaveCount(1);
  const card = page.locator('#phone-now .ph-now-card');
  await expect(card.locator('.ph-title')).toHaveText('Panel: Airport Retail in Cairo, Casablanca and Tunis');
  expect(await card.locator('.ph-big').evaluate(el => getComputedStyle(el).fontSize)).toBe('40px');
  const btns = card.locator('.ph-actions .btn');
  await expect(btns).toHaveCount(2);
  for (const b of await btns.all()) expect(Math.round((await b.boundingBox())!.height)).toBe(48);
  await expect(page.locator('#phone-now .ph-next-card')).toContainText('Duty Free Pricing After the Currency Float');
  await expect(page.locator('#phone-now .ph-row').first()).toBeVisible();
  await ctx.close();
});

test('phone: directors get one Now and Next block per room', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  await expect(page.locator('#phone-now .ph-lane')).toHaveCount(2);
  await ctx.close();
});

test('phone: bottom tabs switch between Now, Schedule, Log and Send', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  const tab = (name: string) => page.locator(`#phone-tabs [data-tab="${name}"]`);
  await expect(tab('now')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#phone-now')).toBeVisible();
  await tab('schedule').click();
  await expect(page.locator('#sessions-list')).toBeVisible();
  await expect(page.locator('#phone-now')).toBeHidden();
  await tab('log').click();
  await expect(page.locator('#log-feed')).toBeVisible();
  await tab('send').click();
  await expect(page.locator('#bc-input')).toBeVisible();
  expect(Math.round((await tab('send').boundingBox())!.height)).toBeGreaterThanOrEqual(48);
  await ctx.close();
});

test('phone: the broadcast banner is one line and expands on tap', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, PHONE);
  const banner = page.locator('#bc-banner');
  expect(Math.round((await banner.boundingBox())!.height)).toBeLessThanOrEqual(30);
  await banner.locator('.bc-msg').click();
  await expect(banner).toHaveClass(/expanded/);
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure** (`#room-pick` missing, header 52 px, no `#phone-now`).

- [ ] **Step 3: Markup.** After `#bc-bar` add (`I(name)` written out as the literal SVG):

```html
<nav id="phone-tabs" class="ph-only" aria-label="Sections">
  <button type="button" data-tab="now" aria-current="page" onclick="setPhoneTab('now')">I(play)<span data-i18n="cc.ph.now">Now</span></button>
  <button type="button" data-tab="schedule" onclick="setPhoneTab('schedule')">I(list)<span data-i18n="cc.ph.schedule">Schedule</span></button>
  <button type="button" data-tab="log" onclick="setPhoneTab('log')">I(report)<span data-i18n="cc.ph.log">Log</span></button>
  <button type="button" data-tab="send" onclick="setPhoneTab('send')">I(broadcast)<span data-i18n="cc.ph.send">Send</span></button>
</nav>
```

- [ ] **Step 4: JS.** Add `phoneTab: 'now',` to `S` and the section:

```js
// ═══════════════════════════════════════════════════
// COMMAND CENTER: phone (stage 5)
// ═══════════════════════════════════════════════════
const PHONE_MQ = window.matchMedia('(max-width: 767px)');
function isPhone() { return PHONE_MQ.matches; }
document.body.dataset.phTab = 'now';
PHONE_MQ.addEventListener('change', () => renderSessions());

function setPhoneTab(tab) {
  S.phoneTab = tab;
  document.body.dataset.phTab = tab;
  document.querySelectorAll('#phone-tabs [data-tab]').forEach(b => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (tab === 'send') document.getElementById('bc-input')?.focus();
}

function renderRoomPick() {
  const sel = document.getElementById('room-pick');
  if (!sel) return;
  const isDirector = S.role === 'director' || S.userRole === 'director';
  const mine = myRoom() || '';
  const rooms = roomsInOrder();
  sel.innerHTML = (isDirector ? `<option value="">${esc(t('misc.allRooms'))}</option>` : '')
    + rooms.map(r => `<option value="${esc(r)}"${r === mine ? ' selected' : ''}>${esc(r === ROOM_NONE ? t('cc.band.noRoom') : r)}</option>`).join('');
}

function phoneLaneHTML(l, nowMs) {
  const roomName = l.room === ROOM_NONE ? t('cc.band.noRoom') : l.room;
  const s = l.now;
  let nowCard = '';
  if (s) {
    const live = s.status === 'LIVE' || s.status === 'OVERRUN';
    const tm = live ? liveTiming(s, nowMs) : null;
    const over = s.status === 'OVERRUN' || !!(tm && tm.overrun);
    const cd = countdownLabel(s, nowMs) || { big: hm(s.scheduled_start), unit: untilText(s) };
    const lead = live ? (canDo(s, 'HOLD') ? transitionButtonHTML(s, 'HOLD', 'lg', 'ph') : '') : primaryButtonHTML(s, 'lg', 'ph');
    const end = endButtonHTML(s, 'lg', 'ph');
    const pair = [lead, end].filter(Boolean).join('');
    const adjust = live && ROLE_DELAY[S.role]
      ? `<div class="ph-time">
          <button type="button" class="btn md" onclick="nudgeSession('${s.id}',-1)">${esc(t('cc.insp.minus1'))}</button>
          <button type="button" class="btn md" onclick="nudgeSession('${s.id}',1)">${esc(t('cc.insp.plus1'))}</button>
          <button type="button" class="btn md" onclick="applyDelay('${s.id}',5)">+5</button></div>` : '';
    nowCard = `<article class="ph-card ph-now-card ${over ? 'is-over' : 'is-' + s.status.toLowerCase()}">
      <div class="ph-card-head"><span class="lbl">${esc(tf('cc.ph.nowIn', { room: roomName }))}</span>${statusBadge(s.status)}</div>
      <div class="ph-title">${esc(s.title)}</div>
      <div class="ph-count" data-timer><span class="ph-big">${esc(cd.big)}</span><span class="ph-unit">${esc(cd.unit)}</span></div>
      ${tm ? `<div class="prog${over ? ' is-over' : ''}"><i style="width:${over ? 100 : tm.pct.toFixed(1)}%"></i></div>` : ''}
      <div class="ph-meta">${esc(speakerShort(s))}${s.speaker_arrived ? ` · ${esc(t('cc.list.arrived'))}` : ''}</div>
      ${s.notes && s.notes.trim() ? `<div class="ph-meta">${icon('note')}<span>${esc(s.notes.trim().split('\n')[0])}</span></div>` : ''}
      ${pair ? `<div class="ph-actions">${pair}</div>` : ''}
      ${adjust}
    </article>`;
  }
  const n = l.next;
  const nextCard = n ? `<article class="ph-card ph-next-card status-${n.status}">
      <div class="ph-card-head"><span class="lbl">${esc(t('cc.band.next'))} · ${hm(n.scheduled_start)}${(n.cumulative_delay || 0) > 0 ? ` (+${n.cumulative_delay})` : ''} · ${esc(untilText(n))}</span>${statusBadge(n.status)}</div>
      <div class="ph-next-title">${esc(n.title)}</div>
      ${primaryButtonHTML(n, 'lg', 'phn')}
    </article>` : '';
  return `<section class="ph-lane" data-room="${esc(l.room)}">${nowCard}${nextCard}</section>`;
}

function renderPhoneNow() {
  const el = document.getElementById('phone-now');
  if (!el) return;
  if (!isPhone()) { el.innerHTML = ''; return; }
  renderRoomPick();
  const nowMs = correctedNow();
  const isDirector = S.role === 'director' || S.userRole === 'director';
  const lanes = bandLanes();
  const mine = myRoom();
  // Operators: their room (or the first lane). Directors: every room, unless they picked one.
  const shown = (isDirector && !mine) ? lanes : lanes.filter(l => l.room === (mine ?? lanes[0]?.room)).slice(0, 1);
  const inCards = new Set(shown.flatMap(l => [l.now?.id, l.next?.id]).filter(Boolean));
  const rooms = new Set(shown.map(l => l.room));
  const later = S.sessions.filter(s => !FINISHED.includes(s.status) && !inCards.has(s.id) && rooms.has(roomOf(s)));
  const done = S.sessions.filter(s => s.status === 'ENDED').length;
  const cancelled = S.sessions.filter(s => s.status === 'CANCELLED').length;
  const fold = [done ? tf('cc.list.completed', { n: done }) : '', cancelled ? tf('cc.list.cancelled', { n: cancelled }) : ''].filter(Boolean).join(' · ');
  el.innerHTML = shown.map(l => phoneLaneHTML(l, nowMs)).join('')
    + (later.length ? `<div class="lbl ph-later-lbl">${esc(t('cc.ph.later'))}</div>`
        + later.map(s => `<div class="ph-row status-${s.status}"><span class="ph-row-time">${hm(s.scheduled_start)}</span><span class="ph-row-title">${esc(s.title)}</span>${statusBadge(s.status)}</div>`).join('') : '')
    + (fold ? `<div class="sc-fold ph-fold">${icon('chev-right')}<span>${esc(fold)}</span></div>` : '');
}
```

At the top of `renderSessions()`, right after `renderBand();`, add `renderPhoneNow();`. In `showBCBanner()`, after the `el.innerHTML = …` statement add:

```js
  // Phone: one line, tap to expand (spec 2.7)
  el.onclick = (e) => { if (isPhone() && !e.target.closest('button')) el.classList.toggle('expanded'); };
```

- [ ] **Step 5: Strings:** `cc.ph.now` (Now | الآن | Teraz | Jetzt), `cc.ph.schedule` (Schedule | الجدول | Plan | Ablauf), `cc.ph.log` (Log | السجل | Dziennik | Protokoll), `cc.ph.send` (Send | إرسال | Wyślij | Senden), `cc.ph.later` (Later | لاحقاً | Później | Später), `cc.ph.nowIn` (Now · {room} | الآن · {room} | Teraz · {room} | Jetzt · {room}).

- [ ] **Step 6: CSS.** Delete the lines listed under Files from the `max-width: 767px` block and append:

```css
    /* ═══ Command center phone (stage 5) ═══ */
    .ph-only { display: none; }
    @media screen and (max-width: 767px) {
      #header { height: 48px; gap: 8px; padding: 0 10px; }
      #ev-select-wrap, #crew-pill, #viewas-wrap, #help-btn, #user-chip, #plan-badge, #brain-wrap, #bc-chip, .hdr-spacer { display: none !important; }
      #conn-lbl { display: none; }
      #conn-pill { padding: 0 9px; }
      .logo svg { height: 22px; }
      #hdr-clock { font-size: var(--fs-20); min-width: 0; text-align: start; }
      #room-pick { display: block; height: 36px; max-width: 150px; margin-inline-start: auto; }
      #hamburger-btn { display: flex; align-items: center; justify-content: center; min-width: 40px; min-height: 40px; }
      #bc-banner { height: auto; min-height: 28px; padding: 4px 12px; }
      #bc-banner .bc-msg { white-space: nowrap; }
      #bc-banner.expanded .bc-msg { white-space: normal; }
      #sidebar-toggle, #sidebar-backdrop { display: none !important; }
      #phone-now { display: none; flex: 1; overflow-y: auto; align-content: start; gap: 10px; padding: 12px 12px 72px; }
      body[data-ph-tab="now"] #phone-now { display: grid; }
      #main, #bc-bar { display: none; }
      body[data-ph-tab="schedule"] #main, body[data-ph-tab="log"] #main { display: grid; grid-template-columns: minmax(0, 1fr); padding-bottom: 56px; }
      body[data-ph-tab="schedule"] #band, body[data-ph-tab="schedule"] #sidebar { display: none; }
      body[data-ph-tab="log"] #main-col, body[data-ph-tab="log"] #ctx-wrap, body[data-ph-tab="log"] #checklist-wrap { display: none; }
      body[data-ph-tab="log"] #sidebar { position: static; transform: none; width: auto; max-width: none; box-shadow: none; display: flex; }
      body[data-ph-tab="send"] #phone-now { display: grid; }
      body[data-ph-tab="send"] #bc-bar { display: flex; flex-wrap: wrap; height: auto; gap: 8px; padding: 12px; position: fixed; inset-inline: 0; bottom: 56px; z-index: 150; background: var(--overlay); border-radius: var(--r-modal) var(--r-modal) 0 0; }
      body[data-ph-tab="send"] #bc-input { flex: 1 1 100%; height: 44px; }
      #filter-bar { height: auto; flex-wrap: wrap; padding: 8px 12px; }
      #fb-search { flex: 1 1 100%; }
      #phone-tabs { display: grid; grid-template-columns: repeat(4, 1fr); position: fixed; inset-inline: 0; bottom: 0; height: 56px; z-index: 160; background: var(--panel); border-top: 1px solid var(--border-section); }
      #phone-tabs button { display: grid; place-items: center; gap: 2px; min-height: 48px; border: 0; background: transparent; color: var(--text-tertiary); font: 600 var(--fs-12) var(--font-sans); }
      #phone-tabs button[aria-current="page"] { color: var(--text-primary); }
      .ph-card { display: grid; gap: 8px; padding: 12px; border-radius: var(--r-modal); background: var(--card); border: 1px solid var(--border-section); }
      .ph-now-card.is-live    { background: var(--st-live-wash);    border-color: var(--st-live-line); }
      .ph-now-card.is-over    { background: var(--st-overrun-wash); border-color: var(--st-overrun-line); }
      .ph-now-card.is-hold    { background: var(--st-hold-wash);    border-color: var(--st-hold-line); }
      .ph-now-card.is-calling { background: var(--st-calling-wash); border-color: var(--st-calling-line); }
      .ph-next-card { border-inline-start: 4px solid var(--st-planned); }
      .ph-next-card.status-READY { border-inline-start-color: var(--st-ready); }
      .ph-next-card.status-CALLING { border-inline-start-color: var(--st-calling); }
      .ph-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .ph-title { font-size: var(--fs-16); font-weight: 700; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .ph-next-title { font-size: var(--fs-14); font-weight: 600; }
      .ph-count { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .ph-big { font: 700 var(--fs-40)/1 var(--font-sans); font-variant-numeric: tabular-nums; letter-spacing: var(--ls-big); }
      .ph-now-card.is-over .ph-big { color: var(--st-overrun-fg); }
      .ph-now-card.is-hold .ph-big { color: var(--st-hold-fg); }
      .ph-unit, .ph-meta { display: flex; gap: 6px; align-items: center; font-size: var(--fs-12); color: var(--text-tertiary); }
      .ph-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .ph-actions .btn, .ph-next-card .btn { width: 100%; height: 48px; }
      .ph-time { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .ph-row { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 48px; padding: 0 12px; border-radius: var(--r-ctl); background: var(--card); border: 1px solid var(--border-section); border-inline-start: 4px solid var(--st-planned); }
      .ph-row.status-READY { border-inline-start-color: var(--st-ready); }
      .ph-row-time { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
      .ph-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sc { grid-template-columns: 96px minmax(0, 1fr) auto; }
      .sc-num, .sc-room, .sc-delay, .sc-time { display: none; }
    }
```

- [ ] **Step 7: Run.** Phone spec 5 passed. Add `{ name: 'stage-390', sc: { role: 'stage', viewport: { width: 390, height: 844 }, touch: true } },` to the visual `CASES`; `--update-snapshots`; review `director-390` (two room blocks, tabs) and `stage-390` (one room, Hold and End 48 px). Full console suite `0 failed`.

- [ ] **Step 8: Commit.**

```bash
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-phone.spec.ts tests/e2e/console-visual.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): phone layout with Now and Next cards, room picker and bottom tabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-phone.spec.ts tests/e2e/console-visual.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
```

### Task 5.2: Copy and accessibility

**Files:**
- Modify `cuedeck-i18n.js`: the en, pl and de values in Step 3; the three Arabic values with em-dashes; `sign.pushAll`; `translateStaticDOM()` help loop deleted.
- Modify `cuedeck-console.html`: the strings in Step 4; the skip link and band focus target (Step 5); `.rbtn` and help-dropdown labels get `data-i18n`; `.toast-close` size.
- Create `tests/console-copy.spec.ts`, `tests/e2e/console-a11y.spec.ts`. Modify `tests/e2e/session-management.spec.ts` (lines 131, 233).

**Interfaces:**
- Consumes: all earlier stages.
- Produces: sentence-case strings in en, pl, de; no em-dash anywhere in the console file or i18n; `.skip-link`; `#band` focusable (`tabindex="-1"`).

- [ ] **Step 1: Failing tests.** Create `tests/console-copy.spec.ts`:

```ts
// tests/console-copy.spec.ts
// Spec section 4: sentence case for buttons, menus, titles, toasts and modals;
// uppercase only through CSS; no em-dashes anywhere (console file and i18n).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const I18N = readFileSync(resolve(__dirname, '../cuedeck-i18n.js'), 'utf8');
const HTML = readFileSync(resolve(__dirname, '../cuedeck-console.html'), 'utf8');
function block(lang: string): Record<string, string> {
  const start = I18N.indexOf(`\n    ${lang}: {`);
  const end = I18N.indexOf('\n    },', start);
  const out: Record<string, string> = {};
  for (const m of I18N.slice(start, end).matchAll(/'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'/g)) out[m[1]] = m[2];
  return out;
}
const stripComments = (src: string) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|[\s;{}(,])\/\/.*$/, '$1')).join('\n');
const ACRONYM = /^(AV|CSV|PDF|QR|ID|AI|EN|AR|PL|DE|OK|UTC|VAT|URL|AVE|TV|PIN|SMS)$/;
const STATUS = /^(PLANNED|READY|CALLING|LIVE|OVERRUN|HOLD|ENDED|CANCELLED)$/;
const PROPER = ['Edge Functions', 'AVE Brain'];

describe('copy rules', () => {
  it('no translation in any language contains an em-dash', () => {
    const bad = ['en', 'ar', 'pl', 'de'].flatMap(l => Object.entries(block(l)).filter(([, v]) => v.includes('—')).map(([k]) => `${l}:${k}`));
    expect(bad).toEqual([]);
  });

  it('the console has no em-dash in markup or script strings', () => {
    const src = stripComments(HTML);
    const bad = src.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes('—') || l.includes('\\u2014') || l.includes('&mdash;'));
    expect(bad.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`)).toEqual([]);
  });

  it('English buttons, menus, titles and toasts are sentence case', () => {
    const bad = Object.entries(block('en')).filter(([k, v]) => {
      if (k.startsWith('status.')) return false;   // badge text, uppercased by CSS
      const words = v.replace(/\{\w+\}/g, '').split(/[\s/·:,.()…+–\-!?]+/).filter(Boolean);
      const shouting = words.filter(w => /^[A-Z]{2,}$/.test(w) && !ACRONYM.test(w) && !STATUS.test(w));
      const allCaps = words.length > 0 && words.every(w => /^[A-Z0-9→&']+$/.test(w)) && !words.every(w => ACRONYM.test(w));
      const titleCase = /^[A-Z][a-z]+( [A-Z][a-z]+)+$/.test(v) && !PROPER.includes(v);
      return shouting.length > 0 || allCaps || titleCase;
    }).map(([k, v]) => `${k}=${v}`);
    expect(bad).toEqual([]);
  });
});
```

Create `tests/e2e/console-a11y.spec.ts`:

```ts
// tests/e2e/console-a11y.spec.ts
// Spec section 5 plus the review-focus cases: skip link, tab order, names on
// icon buttons, toggle state, target sizes, reduced motion, Arabic layout,
// and that no visible control text is written in capitals.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, overrunSessions, ID } from './console-boot-mock';

test('a11y: the skip link is the first stop and leads to the band', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('.skip-link')).toBeVisible();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('band');
  await ctx.close();
});

test('a11y: tab order runs header, band, filters, list, inspector, broadcast', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const seen: string[] = [];
  for (let i = 0; i < 160 && seen[seen.length - 1] !== 'broadcast'; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return '';
      return el.closest('#header') ? 'header' : el.closest('#band') ? 'band' : el.closest('#filter-bar') ? 'filters'
        : el.closest('#sessions-list') ? 'list' : el.closest('#sidebar') ? 'inspector' : el.closest('#bc-bar') ? 'broadcast' : '';
    });
    if (r && seen[seen.length - 1] !== r) seen.push(r);
  }
  expect(seen).toEqual(['header', 'band', 'filters', 'list', 'inspector', 'broadcast']);
  await ctx.close();
});

test('a11y: every visible icon-only control has a name, and toggles expose their state', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, 'toggleEditMode()');
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"], a[href], select, input')]
    .filter(el => (el as HTMLElement).offsetParent !== null)
    .filter(el => !(el.textContent || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.getAttribute('aria-labelledby') && !(el as HTMLInputElement).placeholder)
    .map(el => el.outerHTML.slice(0, 90)));
  expect(unnamed).toEqual([]);
  for (const sel of ['.fvp-btn', '.log-chip', '#edit-mode-btn']) {
    for (const el of await page.locator(sel).all()) expect(await el.getAttribute('aria-pressed')).toMatch(/^(true|false)$/);
  }
  expect(await page.locator('#auto-start-btn').getAttribute('aria-checked')).toMatch(/^(true|false)$/);
  await ctx.close();
});

test('a11y: interactive targets are at least 24 px on desktop', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const small = await page.evaluate(() => [...document.querySelectorAll('button, select, input:not([type="hidden"]), [role="button"]')]
    .filter(el => (el as HTMLElement).offsetParent !== null)
    .map(el => [el, el.getBoundingClientRect()] as const)
    .filter(([, r]) => r.width > 0 && Math.min(r.width, r.height) < 24)
    .map(([el, r]) => `${el.outerHTML.slice(0, 70)} ${Math.round(r.width)}x${Math.round(r.height)}`));
  expect(small).toEqual([]);
  await ctx.close();
});

test('a11y: reduced motion stops every animation', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: overrunSessions(), reducedMotion: 'reduce' });
  await evalPage(page, `S.rtStatus = 'error'; refreshDiag(); renderSessions();`);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await ctx.close();
});

test('layout: Arabic mirrors the band and keeps End last in reading order', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { locale: 'ar' });
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  const lane = page.locator('#band .lane[data-room="Main Stage"] .lane-now');
  const hold = (await lane.locator('.lane-lead').boundingBox())!;
  const end = (await lane.locator('.btn.danger').boundingBox())!;
  expect(end.x).toBeLessThan(hold.x);                       // inline-end is the left edge in RTL
  const title = (await lane.locator('.lane-title').boundingBox())!;
  const ctrl = (await lane.locator('.lane-ctrl').boundingBox())!;
  expect(ctrl.x + ctrl.width).toBeLessThanOrEqual(title.x + 1); // no overlap
  const sw = (await page.locator('#ev-switch').boundingBox())!;
  const clock = (await page.locator('#hdr-clock').boundingBox())!;
  expect(sw.x + sw.width <= clock.x || clock.x + clock.width <= sw.x).toBe(true);
  await ctx.close();
});

test('copy: no visible button, menu item, title or label is written in capitals', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const ACR = /^(AV|CSV|PDF|QR|ID|AI|EN|AR|PL|DE|OK|UTC|VAT|URL|AVE|TV|PIN|SMS|PLANNED|READY|CALLING|LIVE|OVERRUN|HOLD|ENDED|CANCELLED)$/;
  const collect = () => page.evaluate((acr) => {
    const re = new RegExp(acr);
    return [...document.querySelectorAll('button, [role="menuitem"], .ev-modal-title, .lf-title, h2, .lbl, label, .sp-section-title')]
      .filter(el => (el as HTMLElement).offsetParent !== null && !el.closest('.badge'))
      .map(el => (el.textContent || '').trim())
      .filter(txt => txt.split(/[\s/·:,.()…+–\-!?]+/).some(w => /^[A-Z]{2,}$/.test(w) && !re.test(w)));
  }, ACR.source);
  const found = new Set<string>(await collect());
  await page.locator('#user-chip').click();
  (await collect()).forEach(x => found.add(x));
  await evalPage(page, `closeProfilePanel(); toggleHelpMenu();`);
  (await collect()).forEach(x => found.add(x));
  await evalPage(page, `closeHelpMenu(); setRole('signage');`);
  (await collect()).forEach(x => found.add(x));
  await evalPage(page, `setRole('director'); openSessModal('add');`);
  (await collect()).forEach(x => found.add(x));
  expect([...found]).toEqual([]);
  await ctx.close();
});
```

- [ ] **Step 2: Run, expect failure.** `npx vitest run tests/console-copy.spec.ts` (lists the caps keys, the em-dash sites) and `CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts tests/e2e/console-a11y.spec.ts` (skip link missing; copy test lists `SET READY`, `END ALL`, `PUSH ALL`, …).

- [ ] **Step 3: Strings in `cuedeck-i18n.js`.** Set these values (en; pl and de only where the key exists in that block; `status.*` and Arabic values other than the three em-dash ones are unchanged):

| Key | en | pl | de |
|---|---|---|---|
| `btn.goLive` | Go live | Rozpocznij | Live gehen |
| `btn.setReady` | Set ready | Przygotuj | Bereit setzen |
| `btn.callSpeaker` | Call speaker | Wezwij mówcę | Sprecher rufen |
| `btn.hold` | Hold | Wstrzymaj | Pause |
| `btn.endSession` | End session | Zakończ sesję | Sitzung beenden |
| `btn.deArm` | Back to planned | | |
| `btn.cancel` | Cancel | Anuluj | Abbrechen |
| `btn.confirmCancel` | Press again to cancel | | |
| `btn.confirmEnd` | Press again to end | Naciśnij ponownie, aby zakończyć | Zum Beenden erneut drücken |
| `btn.resume` | Resume | | |
| `btn.reinstate` | Reinstate | | |
| `btn.pullBack` | Back to ready | | |
| `btn.confirmOnStage` | On stage | | |
| `btn.undo` | Undo | Cofnij | Rückgängig |
| `btn.clear` | Clear | | |
| `btn.confirmClear` | Press again to clear | | |
| `btn.addDisplay` | Add display | | |
| `btn.addSponsor` | Add sponsor | | |
| `sess.new` | New session | | |
| `sess.edit` | Edit session | | |
| `sess.start` | Planned start | | |
| `sess.end` | Planned end | | |
| `time.planned` | Planned | Planowany | Geplant |
| `time.scheduled` | Scheduled | Zaplanowany | Terminiert |
| `time.started` | Started | | |
| `time.overrun` | Overrun | | |
| `dash.standby` | Standby | | |
| `bc.label` | Broadcast | | |
| `sign.registeredDisplays` | Registered displays | Zarejestrowane ekrany | Registrierte Displays |
| `sign.globalOverride` | Global display override | Globalne nadpisanie | Globale Überschreibung |
| `sign.sponsorLibrary` | Sponsor library | Biblioteka sponsorów | Sponsoren-Bibliothek |
| `sign.pushAll` | Push to all | | |
| `role.director` | Director | Reżyser | Regie |
| `role.stage` | Stage | Scena | Bühne |
| `role.interp` | Interp | Tłumacz | Dolm. |
| `role.reg` | Reg | Rejestr. | Empfang |
| `role.signage` | Signage | Ekrany | Anzeigen |
| `role.label` | Role | Rola | Rolle |
| `filter.clearAll` | Clear all | | |
| `disp.addDisplay` | Add display | | |
| `disp.editDisplay` | Edit display | | |
| `disp.addSponsor` | Add sponsor | | |
| `disp.editSponsor` | Edit sponsor | | |
| `stage.youAreLive` | You are live | | |
| `stage.remaining` | Remaining | | |
| `stage.nextSession` | Next session | | |
| `stage.standby` | Standby | | |
| `delay.running` | Running | | |
| `delay.nextAnchor` | Next anchor | | |
| `batch.setReady` | Set ready | | |
| `batch.endAll` | End all | | |
| `batch.cancelAll` | Cancel all | | |
| `undo.undo` | Undo | | |
| `undo.ended` | Ended | | |
| `undo.cancelled` | Cancelled | | |
| `event.new` | New event | | |
| `event.edit` | Edit event | | |
| `event.name` | Event name | | |
| `event.startTime` | Start time | | |
| `event.endTime` | End time | | |
| `users.invite` | Invite operator | | |
| `feedback.title` | Send feedback | | |
| `feedback.bug` | Bug report | | |
| `feedback.feature` | Feature request | | |
| `feedback.send` | Send feedback | | |
| `help.shortcuts` | Keyboard shortcuts | | |
| `help.quickRef` | Quick reference | | |
| `help.whatsNew` | What\'s new | | |
| `help.feedback` | Send feedback | | |
| `help.contact` | Contact support | | |
| `profile.signOut` | Sign out | | |
| `auth.login` | Sign in | | |
| `auth.name` | Full name | | |
| `confirm.confirmClear` | Press again to clear | Naciśnij ponownie, aby wyczyścić | Zum Löschen erneut drücken |
| `btn.restart` | Restart | Od nowa | Neustart |
| `bc.send` | Send | Wyślij | Senden |
| `bc.clear` | Clear | Wyczyść | Löschen |
| `bc.broadcast` | Broadcast | Komunikat | Durchsage |
| `hdr.event` | Event | Wydarzenie | Event |
| `toast.updatedByOther` | Updated by another operator, refreshing | | |
| `toast.delayRetry` | Another delay is being applied: wait and retry | | |
| `misc.online` | Back online: syncing… | | |

Arabic: `toast.updatedByOther` `تم التحديث بواسطة مشغل آخر، جاري التحديث`; `toast.delayRetry` `يتم تطبيق تأخير آخر، حاول مجدداً`; `misc.online` `عاد الاتصال، جاري المزامنة...`. In `translateStaticDOM()` delete the help-dropdown block (`const helpItems = …` and its loop): the labels carry `data-i18n` after Step 4.

- [ ] **Step 4: Strings in `cuedeck-console.html`.** Run once (not committed); each entry must match, otherwise the script stops and names it:

```js
// $SCRATCH/cd-copy.mjs
import fs from 'node:fs';
const FILE = process.argv[2];
let s = fs.readFileSync(FILE, 'utf8');
const REPL = [
  ['<title>CueDeck — Production Console</title>', '<title>CueDeck: Production Console</title>'],
  ['<div class="lf-title">OPERATOR SIGN IN</div>', '<div class="lf-title">Operator sign in</div>'],
  ['<div class="lf-title">RESET PASSWORD</div>', '<div class="lf-title">Reset password</div>'],
  ['<div class="lf-title">CREATE ACCOUNT</div>', '<div class="lf-title">Create account</div>'],
  ['<button type="submit">Send Reset Link</button>', '<button type="submit">Send reset link</button>'],
  ['placeholder="Full Name"', 'placeholder="Full name"'],
  ['placeholder="Work Email"', 'placeholder="Work email"'],
  ['Full control — all transitions', 'Full control: all transitions'],
  ['onclick="batchTransition(\'READY\')">SET READY</button>', 'onclick="batchTransition(\'READY\')" data-i18n="batch.setReady">Set ready</button>'],
  ['onclick="batchTransition(\'ENDED\')">END ALL</button>', 'onclick="batchTransition(\'ENDED\')" data-i18n="batch.endAll">End all</button>'],
  ['onclick="batchTransition(\'CANCELLED\')">CANCEL ALL</button>', 'onclick="batchTransition(\'CANCELLED\')" data-i18n="batch.cancelAll">Cancel all</button>'],
  ['onclick="executeUndo()">UNDO</button>', 'onclick="executeUndo()" data-i18n="undo.undo">Undo</button>'],
  ['<label>PUSH ALL →</label>', "<label>${esc(t('sign.pushAll'))}</label>"],
  ['<span class="sp-section-title">DISPLAY URL FORMAT</span>', '<span class="sp-section-title">Display URL format</span>'],
  ["sectionLbl('DISPLAYS')", "sectionLbl('Displays')"],
  ["sectionLbl('GLOBAL OVERRIDE')", "sectionLbl('Global override')"],
  ["sectionLbl('MONITOR')", "sectionLbl('Monitor')"],
  ["sectionLbl('LOBBY')", "sectionLbl('Lobby')"],
  ["cbtn('ANNOUNCE SESSION'", "cbtn('Announce session'"],
  ["sectionLbl('BOOTH STATUS')", "sectionLbl('Booth status')"],
  ["sectionLbl('CHANNELS')", "sectionLbl('Channels')"],
  ["badge.textContent += ' · PAYMENT DUE';", "badge.textContent += ' · Payment due';"],
  [">SUSPENDED</span>", ">Suspended</span>"],
  ["esc(u.name || '\\u2014')", "esc(u.name || '\\u2013')"],
  ['(optional — leave blank to show all)', '(optional: leave blank to show all)'],
  ['`RLS blocked write — deploy /${efName} or add service key`', '`RLS blocked write: deploy /${efName} or add service key`'],
  ['Delay applied — ${affected} session', 'Delay applied: ${affected} session'],
  ['Delay applied — ${affected.length} session', 'Delay applied: ${affected.length} session'],
  ['Another delay is being applied — wait and retry', 'Another delay is being applied: wait and retry'],
  ['No slides yet — click Add Slide', 'No slides yet. Click Add slide'],
  ['will appear on screen — type it above and click Pair', 'will appear on screen: type it above and click Pair'],
  ['No Stage Timer display configured — add one in the Signage panel.', 'No stage timer display is set up. Add one in the Signage panel.'],
  [": '—';", ": '–';"],
  ["'CueDeck — State Change'", "'CueDeck: state change'"],
  ["'CueDeck — Alert'", "'CueDeck: alert'"],
  ['`CueDeck — ${name}`', '`CueDeck: ${name}`'],
  ["'CueDeck — Message'", "'CueDeck: message'"],
  ['\'<option value="">— none —</option>\'', '\'<option value="">None</option>\''],
  ["director: 'Full control — all transitions", "director: 'Full control: all transitions"],
  ["Let's get your first event ready — it only takes 2 minutes.", "Let's get your first event ready. It only takes 2 minutes."],
  ['operators instantly — pick a priority and hit Send.', 'operators instantly: pick a priority and press Send.'],
  ['details and actions here — including the Stage Monitor', 'details and actions here, including the stage monitor'],
  ['if AV needs attention — everyone sees it instantly.', 'if AV needs attention: everyone sees it instantly.'],
  ['and current status — keep track of upcoming', 'and current status: keep track of upcoming'],
  ['Track session status here — see which sessions', 'Track session status here: see which sessions'],
  ['Launch the display URL on any screen — TV, tablet, or monitor.', 'Launch the display URL on any screen: TV, tablet or monitor.'],
  ["'Schema not found — see console'", "'Schema not found: see the browser console'"],
  ['@ ${inc.location} — escalated', '@ ${inc.location}: escalated'],
  ["'Failed to send feedback — try again'", "'Could not send feedback. Try again.'"],
  ["'Back online — syncing...'", "'Back online: syncing…'"],
];
const missing = [];
for (const [from, to] of REPL) { if (!s.includes(from)) { missing.push(from); continue; } s = s.split(from).join(to); }
// Stage monitor (layout unchanged, spec non-goal): only its em-dashes go.
s = s.replace(/'— STANDBY'/g, "'Standby'").replace(/>— STANDBY</g, '>Standby<')
     .replace(/(STANDING BY|Standing by)\s*—\s*/g, '$1: ')
     .replace(/id="sm-next-title" class="sm-next-title">—</, 'id="sm-next-title" class="sm-next-title">–<')
     .replace(/class="sm-footer-evt">—</, 'class="sm-footer-evt">–<')
     .replace(/\|\| '—'\)/g, "|| '–')");
fs.writeFileSync(FILE, s);
if (missing.length) { console.error('NOT FOUND:\n' + missing.join('\n')); process.exit(1); }
console.log('ok');
```

```bash
node "$SCRATCH/cd-copy.mjs" /Users/sheriff/AVE-Production-Console-redesign/cuedeck-console.html
npx vitest run tests/console-copy.spec.ts
```

Expected: `ok`, then the copy spec passes. For any `NOT FOUND` line (an earlier stage or the safety branch already changed that string) search the file for the remaining `—` near it, apply the same rule (colon, comma or full stop; `–` for an empty value), and list it in the commit message. Also: give each `#help-dropdown .hd-label` span a `data-i18n` attribute (`help.shortcuts`, `help.quickRef`, `help.whatsNew`, `help.docs`, `help.feedback`, `help.contact`, `help.about`) and each `#viewas-menu .rbtn` a `data-i18n="role.<role>"`; in `.lf-title` CSS replace `letter-spacing: .08em;` with `letter-spacing: 0;`; add `#plan-badge { text-transform: uppercase; letter-spacing: var(--ls-badge); }`; append `text-transform:uppercase;` to the inline style of the Suspended span; set `.toast-close { min-width: 24px; min-height: 24px; }`.

- [ ] **Step 5: Skip link and band focus.** Insert as the first child of `<body>`:

```html
<a href="#band" class="skip-link" data-i18n="cc.a11y.skip"
   onclick="event.preventDefault();(document.querySelector('#band:not([hidden])')||document.getElementById('sessions-list')).focus()">Skip to now and next</a>
```

Give `<section id="band" …>` and `<div id="sessions-list">` the attribute `tabindex="-1"`. CSS:

```css
    .skip-link { position: absolute; inset-inline-start: 8px; top: -48px; z-index: 2000; padding: 8px 12px; border-radius: var(--r-ctl); background: var(--accent); color: var(--on-accent); font: 600 var(--fs-13) var(--font-sans); text-decoration: none; }
    .skip-link:focus { top: 8px; }
    #band:focus, #sessions-list:focus { outline: none; box-shadow: var(--focus-ring); }
```

String `cc.a11y.skip`: Skip to now and next | انتقل إلى الآن والتالي | Przejdź do sekcji Teraz i dalej | Zu Jetzt und danach springen.

- [ ] **Step 6: Tests that select on exact text (same commit).** In `tests/e2e/session-management.spec.ts` lines 131 and 233 change `toHaveText('New Session')` to `toHaveText('New session')`. The other text selectors named in the design-system audit keep passing without change and are rerun here: `console-ui` (`button:has-text("SEND")`, `text=GLOBAL DISPLAY OVERRIDE`, `text=REGISTERED DISPLAYS` are case-insensitive), `console-pairing` (`Reset key`, `Click again to reset key`), `console-confirm`, `console-restart` (`Restart this session?`, the READY sentence), `console-forbidden` (`Delay applied`, `2 sessions shifted +5m`, `Updated by another operator`), `auth-flows`.

- [ ] **Step 7: Run.**

```bash
npx vitest run
CONSOLE_BASE=http://127.0.0.1:7291 npx playwright test -c playwright.console.config.ts
```

Expected: vitest all pass (copy 3, i18n keys 5, ratchet with the new `BUDGET`); Playwright `0 failed` including a11y 7. If the target-size test lists a control, raise that control to 24 px with a rule next to its component CSS; if the tab-order test lists a region out of order, the DOM order is wrong, not the test.

- [ ] **Step 8: Baselines.** `--update-snapshots`; review every PNG for sentence-case labels and no em-dashes.

- [ ] **Step 9: Commit (two commits).**

```bash
git add cuedeck-i18n.js cuedeck-console.html tests/console-copy.spec.ts tests/e2e/session-management.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git commit -m "feat(console): sentence case in every language and no em-dashes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-i18n.js cuedeck-console.html tests/console-copy.spec.ts tests/e2e/session-management.spec.ts tests/console-colour-ratchet.spec.ts tests/e2e/__screenshots__/console-visual.spec.ts
git add cuedeck-console.html cuedeck-i18n.js tests/e2e/console-a11y.spec.ts
git commit -m "feat(console): skip link, labelled icon buttons, toggle state, 24 px targets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- cuedeck-console.html cuedeck-i18n.js tests/e2e/console-a11y.spec.ts
```

(Stage the copy hunks with `git add -p cuedeck-console.html cuedeck-i18n.js` for the first commit.)

### Task 5.3: Release stage 5

Same steps as Task 1.4 with branch `redesign/stage-5` and notes directory `$SCRATCH/notes/stage-5`. Freeze check first: no release task starts after 18:00 on 10 Oct; a stage not live-checked by 21:00 on 10 Oct waits until after GTR; nothing is pushed on 11 Oct (the rehearsal day runs on whatever is live). The pushed range must contain only the Task 5.1 and 5.2 commits. Live check: `curl -s https://app.cuedeck.io/ | grep -o 'id="phone-tabs"' | head -1` prints the string; on a real phone (Sherif's, or Chrome device mode at 390×844 if he is not available) the Now card shows his room with 48 px Hold and End, the tabs switch, the banner taps open; on desktop, Tab from the top reaches the skip link first. Note to Sherif: "Stage 5 (phone, copy, accessibility) is live." with before/after pairs for `director-390`, `stage-390` and `director-1440`, and a reminder that 11 Oct is the rehearsal on the finished console (every status, delay, overrun, broadcast, stage monitor, phone).

---

# Self-review

## Spec coverage

| Spec section | Requirement | Task(s) |
|---|---|---|
| Goal, success criteria | Dividers ≥ 1.8:1 (measured 1.79 to 1.87), controls ≥ 3:1 | 1.2 (`console-tokens.spec.ts`) |
| | Text ≥ 4.5:1, disabled ≥ 3.7:1 | 1.2 (tokens), 1.3 |
| | 1440×900: live and next of every room (up to 3) without scrolling, ≥ 8 list rows | 4.1 (`layout: at 1440x900 …`) |
| | 1280×720: band plus ≥ 6 rows | 4.2 (`layout: 1280x720 …`) |
| | Top chrome ≤ 100 px | 3.1, updated in 4.1 |
| | Event log always visible, ≥ 200 px | 4.2 (`log: …`, `layout: 1280x720 …`) |
| | One colour and one shape per status, worst pair ΔE ≥ 20 | 1.2 (`console-status-palette.spec.ts`), 2.1 (badge shapes), 3.2 (edges) |
| | HOLD and END never move; destructive separated | 2.1, 4.1, 4.2 |
| | No emoji as icons | 2.1 (sprite), 3.1, 3.2, 4.x (written emoji-free), 2.3 (guard) |
| Non-goals | No behaviour change, no light theme, monitor and display keep layouts, no framework | Global Constraints; 1.2 (display status colours only) |
| 1 Tokens | Surfaces, borders, text, status set, accent, focus ring, action colour rule | 1.1, 1.2, 2.1 |
| | Type 8 sizes, weights, letter-spacing, tabular nums | 1.2 (tokens), 1.3 |
| | Space, rows, radius, button sizes | 1.2 (tokens), 2.1 |
| | Motion only for exceptions, off under reduced motion | 1.2, 2.1 (`badge-ring`, `conn-lost`), 4.1 (`lane-over`), 5.2 (test) |
| | JS reads status colours from CSS | 1.2 (`statusColor`), 4.3 |
| 2 Layout 1440 | Banner, header, band, filter row, compact list, inspector, composer | 3.1, 3.2, 4.1, 4.2 |
| | Diagnostics into the status pill, role bar to View as, duplicate event pill and clocks removed | 3.1 |
| 2.1 Band | Lanes per room, now and next rows, countdown text, fixed End slot, Not arrived chip, washes, knock-on and Push following, idle lane, > 3 rooms collapse, single-room events, same-room next | 4.1 |
| 2.2 Compact list | 56 px grid, status edge, speaker line with icons and note, one primary action, tools on hover and Edit run of show, folded ENDED and CANCELLED, anchor divider, opens at first unfinished row, click/Enter/arrows | 3.2 (selection moves to the inspector in 4.2) |
| 2.3 Inspector | Most urgent default, follows selection, fixed slots, time row, monitor row, More menu, two-press confirm announced, log with filters, own times, export | 4.2 |
| 2.4 Header | Event switcher button with date and zone, event-local clock, All systems popover, crew popover, View as, Help, account menu with Check-in/Team/Billing/Language/Shortcuts/Auto-start/Sign out, AVE Brain badge, AI tools under Tools | 3.1 |
| 2.5 Timeline | 40 px lanes, HH:MM labels with tooltip, NOW −1 h to +3 h and Fit day, planned outline, overrun hatched, dark text on solid fills, event-local NOW, click selects, band stays | 4.3 |
| 2.6 1280×720 | One-line lanes, 320 px inspector, notes collapsed, log ≥ 200 | 4.1 (CSS), 4.2 (CSS and test) |
| 2.7 Phone | 48 px header with room picker, one-line banner that expands, Now card (2 lines, countdown, progress, speakers, note, two 48 px buttons, time adjust), Next card, Later rows, folded finished, tabs Now/Schedule/Log/Send, directors per room | 5.1 |
| 2.8 Roles | Director all; stage Active filter and own room first; AV flags prominent; interp/reg/signage panels kept | 4.1 (room first), 4.2 (permissions, AV flags, role panels), safety branch (Active) |
| 2.9 Broadcast | 28 px banner with priority colour and icon, time, collapses to a chip; composer 52 px, presets menu without emoji, Enter sends info and warn, critical two presses | 3.1 |
| 3 Components | Button, badge, chip, section label, input/select, card/row, modal, toast, status pill, icons | 2.1, 2.2, 2.3, 3.2 (row) |
| 4 Copy | Sentence case in every language, uppercase via CSS only, no em-dashes (including "starting now"), HH:MM, `–` for empty | 3.x and 4.x (new strings), 2.3 ("starting now"), 5.2 |
| 5 Accessibility | Keyboard reach, skip link, tab order, labelled icon buttons, aria-pressed, live regions, focus ring, target sizes | 1.2 (ring), 2.2 (dialogs, toasts), 3.1 (buttons), 4.2 (armed confirm), 5.2 |
| 6 Stages | Harness first and stable; ratchet; one commit per component; screenshot review, full e2e, review, live check, note per stage; order of value; freeze | 0.1, 0.2, 1.1, 2.1/2.2 commits, every release task, Execution order section |
| 7 Risks | Tests that select by class/text updated in the same commit; `.sc-meta` chip rule removed with the cards; modals keep inline display; parallel sessions | 2.1, 3.1, 3.2, 4.2, 5.2 (named tests); 3.2 deletes `.sc-meta > span:not(.spk):not([style])`; 2.2 keeps `style.display`; worktree and explicit paths |
| 8 Decisions | All five stages before GTR with the 10 Oct freeze; two-press confirm (no hold); AI tools in the account menu under Tools | Release tasks; 4.2; 3.1 |

Gaps found while writing and fixed in the plan:
- CI runs `npm run test:e2e` on Linux, which would have run the Mac/Chrome screenshot suite and failed: Task 0.1 adds `testIgnore` to `playwright.config.ts`, and every release task now checks that CI ran and passed for the pushed SHA (a missing run is not a pass).
- The armed-confirm announcement used `requestAnimationFrame`, which never fires under the frozen test clock: `announce()` is synchronous.
- Stage 3 alone would have removed Restart, Arrived, delay and nudge controls until stage 4 shipped: the selected row gets a drawer with the existing controls, removed in 4.2 when the inspector takes over.
- The demo data assumed the browser clock was event-local time; with the safety branch's event-local helpers the frozen clock is now 08:40 UTC, which is 11:40 in Cairo.
- An End label that grows when armed would have shifted Hold: End and its empty slot have a fixed width in the band and the inspector.
- Legacy `cbtn(…, '📢')` icon arguments would have produced broken sprite references after 2.1: 2.1 maps them to `broadcast` and `coffee`.
- The restart, components, header and list specs each select on markup that later stages move; each is updated in the task that moves it (3.2, 4.1, 4.2).
- Each release task now includes the stage review the spec requires (house `diff-review` skill).

## Placeholder scan

Searched the plan for "TBD", "TODO", "similar to task", "as needed", "handle edge cases" and "fill in": none. Every code step contains the code. The one-off codemods (Tasks 1.1, 1.2, 1.3, 2.3, 5.2) list every replacement and exit non-zero naming any string that is no longer present, so nothing is skipped silently; the instruction for that case is concrete (apply the same replacement at the named function and list it in the commit). The shorthand `I(name)` in markup steps is defined where it is used as the literal `<svg class="ico" aria-hidden="true" focusable="false"><use href="#i-name"/></svg>`.

## Name consistency

Checked across tasks: `tf`, `icon`, `statusBadge`, `chipHTML`, `hm`, `tsHM`, `sessionSpan`, `FINISHED` (2.1); `applyI18nAttrs`, `togglePopover`, `closePopovers`, `refreshSysPill`, `eventClockHMS`, `eventSubline`, `setBannerRead`, `reopenBanner` (3.1); `focusKey`, `restoreFocus`, `canDo`, `ACTION_ORDER`, `primaryTransition`, `actionLabel`, `transitionButtonHTML`, `primaryButtonHTML`, `endButtonHTML`, `cancelButtonHTML`, `liveTiming`, `countdownLabel`, `people`, `speakerLine`, `speakerShort`, `flagsHTML`, `subLine`, `rowHTML`, `foldRowHTML`, `toggleFold`, `selectSession`, `toggleEditMode` (3.2); `BAND_ROLES`, `NOW_RANK`, `ROOM_NONE`, `roomOf`, `myRoom`, `setMyRoom`, `roomsInOrder`, `laneFor`, `bandLanes`, `minsUntil`, `untilText`, `renderBand`, `laneHTML`, `nextRowHTML`, `laneChipHTML`, `toggleLane` (4.1); `INSPECTOR_ROLES`, `URGENCY`, `announce`, `mostUrgentSession`, `inspectorSession`, `monitorRowHTML`, `inspectorHTML`, `renderInspector`, `buildCtxPanel` (now a wrapper), `buildRoleCtxPanel`, `logKind`, `LOG_FILTER`, `setLogFilter`, `logDetail`, `renderLog` (4.2); `statusColor` (1.2), `toggleTlFit` (4.3); `isPhone`, `setPhoneTab`, `renderRoomPick`, `phoneLaneHTML`, `renderPhoneNow` (5.1); `initModalManager` (2.2). State fields: `S.selectedId`, `S.foldOpen`, `S.editMode`, `S.listOpened` (3.2), `S.laneOpen` (4.1), `S.inspectedId`, `S.urgentKey`, `S.inspMoreOpen`, `S.logFilter` (4.2), `S.tlFit` (4.3), `S.phoneTab` (5.1), `S.presenceList`, `S.bcKey`, `S.bcReadKey`, `S.brainCount` (3.1). Every test name quoted in Review Focus exists verbatim in its task. No local variable is named `t` in any new code.

## Spec ambiguities resolved

1. **Build order versus the order of value.** The spec numbers stages 0 to 5 but ranks value 1 and 3, then 4, then 2 and 5. Stage 3 needs buttons, badges, chips, labels, pills and icons, so Task 2.1 (those primitives) runs before stage 3 and ships in the stage 3 release; the rest of stage 2 (inputs, dialogs, toasts, the emoji sweep) runs after stage 4. Stage 5 depends on the band, so it is last.
2. **Type sizes outside the eight-size scale.** Spec 2.4 says a 26 px clock and 2.3 a 32 px inspector countdown; the scale says 40 px for "inspector countdown on phone" while 2.7 says 30 px. Resolved: the layout sections win for the clock (26) and the desktop inspector (32), both as named tokens; the phone countdown uses the scale's 40 because the scale names it explicitly.
3. **Badge letter-spacing.** Section 1 says .04em for uppercase badges, section 3 says .06em. Resolved: .04em (`--ls-badge`); labels use .06em.
4. **Divider threshold.** The criterion says ≥ 1.8:1 but the spec's own measurement of the section border on `--bg` is 1.79:1. Resolved: tests assert ≥ 1.78.
5. **Eight rows with three lanes.** Three full lanes (3 × 99 px) plus eight 60 px rows plus chrome exceeds 900 px. Resolved: the eight-row test uses the two-room demo; with three or more attention lanes the band stays full and the list scrolls.
6. **Forward button colour.** Settled by the controller ruling of 6 Oct (it overrides the spec's "colour of the state it leads to"): red is never used for a non-destructive action. On stage, Go live, Resume and Set ready are solid green, Call speaker solid yellow, Hold solid amber, End and Cancel red outline, and solid red only for the armed confirm. The spec's section 1 was edited to match.
7. **Broadcast sender.** `leod_broadcast` has no sender column and the spec forbids behaviour or schema changes. Resolved: the banner shows priority, icon and time; sender is listed for Sherif as a follow-up.
8. **Room order and "their room".** Events have no room-order field and operators have no assigned room. Resolved: alphabetical (an `S.event.rooms` array is honoured if one is added later); a stage or AV operator's room is the room they pick in the room filter (desktop) or the room picker (phone), stored per viewer.
9. **"Returns to the most urgent when that changes status."** Resolved: the selection resets whenever the most urgent session or its status changes, except while the selected session has an armed End or Cancel, so the second press never lands on another session.
10. **Push following amount.** Resolved: the overrun in minutes rounded to the nearest 5, minimum 5 (the demo's +10:02 gives +10), calling the existing `applyDelay` on the next session.
11. **"Push following" in the inspector.** Resolved: it keeps today's +MIN behaviour (`applyDelay` on the selected session, which cascades); only the label and the separation change, because session behaviour is a non-goal.
12. **Copy scope.** "No em-dashes anywhere" is applied to the console file, the i18n file and the "starting now" announcement. The three AI agent modules (62 em-dashes, their own modals) and the stage monitor's uppercase display labels are outside the redesigned chrome and were left alone to keep the GTR-week change surface small; both are listed for Sherif as follow-ups.
13. **Status strings.** `status.*` values keep their source text because badges are uppercased by CSS and status names appear as names inside sentences (for example the restart dialog); the copy test allows status words.
14. **Freeze hours.** "Evening of 10 Oct" is made concrete as: no release task starts after 18:00 and nothing not live-checked by 21:00 ships, in Sherif's local time.
15. **Display page.** "Adopt the shared status tokens" is applied to status labels only; the presenter timer's remaining-time colours are not statuses and stay.
