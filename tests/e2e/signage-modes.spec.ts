// tests/e2e/signage-modes.spec.ts
// PR-014: E2E tests for CueDeck display page content modes.
// Tests each of the 8 render modes by injecting mock state and calling
// the page's render() function directly — no live DB required.
//
// Prerequisite: preview server running on port 7230
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';

const BASE     = 'http://127.0.0.1:7230';
const DISP_URL = `${BASE}/cuedeck-display.html`;

// ── Helper: boot the display page into a specific mode ──────────────────────
// Injects mock S + D state, shows the display frame, and calls render().
// Content is written into #content-area by the page's own render() function.
async function bootMode(
  page: import('@playwright/test').Page,
  mode: string,
  overrides: Record<string, unknown> = {},
) {
  await page.goto(DISP_URL);

  await page.evaluate(
    ({ m, ov }) => {
      // Build a minimal S state with one LIVE + one READY session
      (window as unknown as Record<string, unknown>).S = {
        sessions: [
          {
            id: 'sess-a',
            title: 'Keynote Address',
            speaker: 'Jane Smith',
            company: 'Acme Corp',
            room: 'Ballroom A',
            status: 'LIVE',
            sort_order: 1,
            scheduled_start: '09:00:00',
            scheduled_end: '09:30:00',
            actual_start: new Date(Date.now() - 5 * 60_000).toISOString(),
          },
          {
            id: 'sess-b',
            title: 'Panel Discussion',
            speaker: 'Bob Jones',
            company: '',
            room: 'Room 101',
            status: 'READY',
            sort_order: 2,
            scheduled_start: '09:45:00',
            scheduled_end: '10:30:00',
            actual_start: null,
          },
        ],
        sponsors: [
          { id: 'sp-1', name: 'Sponsor Alpha', logo_url: '', sort_order: 0, active: true },
          { id: 'sp-2', name: 'Sponsor Beta',  logo_url: '', sort_order: 1, active: true },
        ],
        event: { name: 'Test Conference 2026' },
        broadcast: null,
        clockOffset: 0,
      };

      // Build display config with the requested mode and any overrides
      (window as unknown as Record<string, unknown>).D = {
        id: 'disp-test',
        name: 'Test Display',
        content_mode: m,
        orientation: 'landscape',
        filter_room: null,
        override_content: null,
        sequence: null,
        ...ov,
      };

      // Show the display frame (#display), hide setup form
      const setup = document.getElementById('setup');
      const disp  = document.getElementById('display');
      if (setup) setup.style.display = 'none';
      if (disp)  { disp.style.display = 'flex'; (document.body as HTMLBodyElement).className = 'is-live'; }

      // Call the page's own render() — it resolves the active mode and writes
      // to #content-area using the correct function signature for each mode.
      const renderFn = (window as unknown as Record<string, unknown>).render;
      if (typeof renderFn === 'function') {
        (renderFn as () => void)();
      }
    },
    { m: mode, ov: overrides },
  );
}

// ── 1. SCHEDULE mode ─────────────────────────────────────────────────────────

test('PR-014 schedule mode — shows live session title', async ({ page }) => {
  await bootMode(page, 'schedule');
  await expect(page.locator('#content-area')).toContainText('Keynote Address');
});

test('PR-014 schedule mode — shows LIVE status tag', async ({ page }) => {
  await bootMode(page, 'schedule');
  await expect(page.locator('#content-area .sc-tag.live')).toBeVisible();
});

test('PR-014 schedule mode — shows next session title', async ({ page }) => {
  await bootMode(page, 'schedule');
  await expect(page.locator('#content-area')).toContainText('Panel Discussion');
});

// ── 2. WAYFINDING mode ───────────────────────────────────────────────────────

test('PR-014 wayfinding mode — shows room directory header', async ({ page }) => {
  await bootMode(page, 'wayfinding');
  await expect(page.locator('#content-area')).toContainText('ROOM DIRECTORY');
});

test('PR-014 wayfinding mode — shows room names in table', async ({ page }) => {
  await bootMode(page, 'wayfinding');
  await expect(page.locator('#content-area')).toContainText('Ballroom A');
  await expect(page.locator('#content-area')).toContainText('Room 101');
});

// ── 3. SPONSORS mode ─────────────────────────────────────────────────────────

test('PR-014 sponsors mode — shows sponsor names', async ({ page }) => {
  await bootMode(page, 'sponsors');
  // renderSponsors writes into #content-area via render() above
  const text = await page.locator('#content-area').textContent();
  expect(text).toMatch(/Sponsor Alpha|Sponsor Beta|THANK YOU/i);
});

// ── 4. BREAK mode ────────────────────────────────────────────────────────────

test('PR-014 break mode — shows break icon and title', async ({ page }) => {
  await bootMode(page, 'break');
  await expect(page.locator('#content-area .break-icon')).toBeVisible();
  await expect(page.locator('#content-area .break-title')).toContainText('COFFEE BREAK');
});

test('PR-014 break mode — custom override message', async ({ page }) => {
  await bootMode(page, 'break', { override_content: { message: 'LUNCH BREAK' } });
  await expect(page.locator('#content-area .break-title')).toContainText('LUNCH BREAK');
});

// ── 5. WIFI mode ─────────────────────────────────────────────────────────────

test('PR-014 wifi mode — shows network label and SSID', async ({ page }) => {
  await bootMode(page, 'wifi', { override_content: { message: 'ConferenceNet|secret123' } });
  await expect(page.locator('#content-area')).toContainText('NETWORK');
  await expect(page.locator('#content-area')).toContainText('ConferenceNet');
});

test('PR-014 wifi mode — shows password when provided', async ({ page }) => {
  await bootMode(page, 'wifi', { override_content: { message: 'ConferenceNet|secret123' } });
  await expect(page.locator('#content-area')).toContainText('PASSWORD');
  await expect(page.locator('#content-area')).toContainText('secret123');
});

// ── 6. RECALL mode ───────────────────────────────────────────────────────────

test('PR-014 recall mode — shows RESUMING SHORTLY tag', async ({ page }) => {
  await bootMode(page, 'recall');
  await expect(page.locator('#content-area .sc-tag.ready')).toBeVisible();
  await expect(page.locator('#content-area')).toContainText('RESUMING SHORTLY');
});

test('PR-014 recall mode — shows recall timer element', async ({ page }) => {
  await bootMode(page, 'recall');
  await expect(page.locator('#d-recall-timer')).toBeVisible();
});

// ── 7. CUSTOM mode ───────────────────────────────────────────────────────────

test('PR-014 custom mode — shows custom message', async ({ page }) => {
  await bootMode(page, 'custom', { override_content: { message: 'WELCOME TO THE CONFERENCE' } });
  await expect(page.locator('#content-area .custom-message')).toContainText('WELCOME TO THE CONFERENCE');
});

test('PR-014 custom mode — falls back to display name when no message', async ({ page }) => {
  await bootMode(page, 'custom');
  // D.name = 'Test Display', override_content = null → shows 'Test Display'
  await expect(page.locator('#content-area .custom-message')).toContainText('Test Display');
});

// ── 8. AGENDA mode ───────────────────────────────────────────────────────────

test('PR-014 agenda mode — shows room column header', async ({ page }) => {
  await bootMode(page, 'agenda');
  await expect(page.locator('#content-area .ag-room-header').first()).toBeVisible();
});

test('PR-014 agenda mode — shows session titles in grid', async ({ page }) => {
  await bootMode(page, 'agenda');
  await expect(page.locator('#content-area')).toContainText('Keynote Address');
});

// ── Helper: boot with 4 timed sessions across 3 rooms ──────────────────────
// Used by timeline and programme mode tests to cover LIVE, READY, PLANNED, ENDED
async function bootModeWithTimedSessions(
  page: import('@playwright/test').Page,
  mode: string,
  overrides: Record<string, unknown> = {},
) {
  await page.goto(DISP_URL);
  await page.evaluate(
    ({ m, ov }) => {
      (window as unknown as Record<string, unknown>).S = {
        sessions: [
          {
            id: 's1', title: 'Opening Keynote', speaker: 'Alice Chen', company: 'TechCo',
            room: 'Main Hall', status: 'LIVE', sort_order: 1,
            planned_start: '2026-03-10T09:00:00', planned_end: '2026-03-10T09:45:00',
            scheduled_start: '09:00:00', scheduled_end: '09:45:00',
            actual_start: new Date(Date.now() - 10 * 60_000).toISOString(),
          },
          {
            id: 's2', title: 'Panel: Future of AI', speaker: 'Bob Kim', company: '',
            room: 'Room A', status: 'READY', sort_order: 2,
            planned_start: '2026-03-10T10:00:00', planned_end: '2026-03-10T10:45:00',
            scheduled_start: '10:00:00', scheduled_end: '10:45:00',
            actual_start: null,
          },
          {
            id: 's3', title: 'Workshop: Cloud Ops', speaker: 'Carol Diaz', company: 'CloudInc',
            room: 'Room B', status: 'PLANNED', sort_order: 3,
            planned_start: '2026-03-10T11:00:00', planned_end: '2026-03-10T12:00:00',
            scheduled_start: '11:00:00', scheduled_end: '12:00:00',
            actual_start: null,
          },
          {
            id: 's4', title: 'Welcome Address', speaker: 'Dave Ortiz', company: '',
            room: 'Main Hall', status: 'ENDED', sort_order: 0,
            planned_start: '2026-03-10T08:30:00', planned_end: '2026-03-10T08:55:00',
            scheduled_start: '08:30:00', scheduled_end: '08:55:00',
            actual_start: '2026-03-10T08:30:00',
          },
        ],
        sponsors: [],
        event: { name: 'Tech Summit 2026' },
        broadcast: null,
        clockOffset: 0,
      };
      (window as unknown as Record<string, unknown>).D = {
        id: 'disp-tl', name: 'Lobby Screen',
        content_mode: m, orientation: 'landscape',
        filter_room: null, override_content: null, sequence: null,
        scroll_style: 'scroll', paginate_seconds: 10,
        ...ov,
      };
      const setup = document.getElementById('setup');
      const disp = document.getElementById('display');
      if (setup) setup.style.display = 'none';
      if (disp) { disp.style.display = 'flex'; }
      const renderFn = (window as unknown as Record<string, unknown>).render;
      if (typeof renderFn === 'function') (renderFn as () => void)();
    },
    { m: mode, ov: overrides },
  );
}

// ── 9. TIMELINE mode ──────────────────────────────────────────────────────────

test('timeline mode — renders all session titles', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'timeline');
  await expect(page.locator('#content-area')).toContainText('Opening Keynote');
  await expect(page.locator('#content-area')).toContainText('Panel: Future of AI');
  await expect(page.locator('#content-area')).toContainText('Workshop: Cloud Ops');
  await expect(page.locator('#content-area')).toContainText('Welcome Address');
});

test('timeline mode — shows time values', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'timeline');
  await expect(page.locator('#content-area')).toContainText('09:00');
  await expect(page.locator('#content-area')).toContainText('10:00');
});

test('timeline mode — LIVE session has live class', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'timeline');
  await expect(page.locator('.tl-row.live')).toBeVisible();
});

test('timeline mode — ENDED session is dimmed', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'timeline');
  await expect(page.locator('.tl-row.ended')).toBeVisible();
});

test('timeline mode — filter_room limits sessions', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'timeline', { filter_room: 'Room A' });
  await expect(page.locator('#content-area')).toContainText('Panel: Future of AI');
  await expect(page.locator('#content-area')).not.toContainText('Opening Keynote');
});

test('timeline mode — shows PROGRAMME LIST header', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'timeline');
  await expect(page.locator('#content-area')).toContainText('PROGRAMME LIST');
});

// ── 10. PROGRAMME mode ────────────────────────────────────────────────────────

test('programme mode — shows room headers', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'programme');
  await expect(page.locator('.pg-room-hdr').first()).toBeVisible();
});

test('programme mode — shows session titles in grid', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'programme');
  await expect(page.locator('#content-area')).toContainText('Opening Keynote');
  await expect(page.locator('#content-area')).toContainText('Panel: Future of AI');
});

test('programme mode — LIVE cell has live class', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'programme');
  await expect(page.locator('.pg-cell.live').first()).toBeVisible();
});

test('programme mode — shows time labels', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'programme');
  await expect(page.locator('.pg-time-lbl').first()).toBeVisible();
});

test('programme mode — shows DAY GRID header', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'programme');
  await expect(page.locator('#content-area')).toContainText('DAY GRID');
});
