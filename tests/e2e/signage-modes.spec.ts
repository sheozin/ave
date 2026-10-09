// tests/e2e/signage-modes.spec.ts
// PR-014: E2E tests for CueDeck display page content modes.
// Tests each of the 8 render modes by injecting mock state and calling
// the page's render() function directly — no live DB required.
//
// Prerequisite: preview server running on port 7230
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';

const BASE     = process.env.CONSOLE_BASE || 'http://127.0.0.1:7230';
const DISP_URL = `${BASE}/cuedeck-display.html`;

// No live DB. The page starts pairing on load (display_pair_start, then
// display_pair_poll every 2 s); until 2026-10-05 every run of this file
// inserted pairing rows into production. Both RPCs are answered here, and any
// other Supabase request is refused and fails the test.
let unmocked: string[] = [];
test.beforeEach(async ({ page }) => {
  unmocked = [];
  page.on('websocket', ws => { if (/supabase\.co/.test(ws.url())) unmocked.push('ws ' + ws.url()); });
  await page.route(u => /(^|\.)supabase\.co$/.test(u.hostname), async route => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const url = req.url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (url.includes('/rest/v1/rpc/display_pair_start')) return json(true);
    if (url.includes('/rest/v1/rpc/display_pair_poll'))  return json(null);
    unmocked.push(req.method() + ' ' + url);
    return route.fulfill({ status: 403, contentType: 'application/json', headers: cors, body: '{"message":"not mocked"}' });
  });
});
test.afterEach(() => {
  expect(unmocked, 'unmocked Supabase requests').toEqual([]);
});

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

// ── 11. CALLING is not READY (owner screenshots 9 Oct) ───────────────────────
// A session being called showed "READY" in wayfinding, the day grid and the
// programme list. Every mode that badges a status now says CALLING, in the
// console's CALLING yellow (--st-calling #FACC15).
const CALLING_RGB = 'rgb(250, 204, 21)';
async function addCalling(page: import('@playwright/test').Page, opts: { noLive?: boolean } = {}) {
  await page.evaluate(({ noLive }) => {
    const w = window as unknown as { S: { sessions: Record<string, unknown>[] }; render: () => void };
    if (noLive) w.S.sessions = w.S.sessions.filter(s => s.status !== 'LIVE');
    w.S.sessions.push({
      id: 's5', title: 'Breakout: Captions', speaker: 'Eve Park', company: '',
      room: 'Room C', status: 'CALLING', sort_order: 5,
      planned_start: '2026-03-10T10:30:00', planned_end: '2026-03-10T11:15:00',
      scheduled_start: '10:30:00', scheduled_end: '11:15:00', actual_start: null,
    });
    w.render();
  }, opts);
}

for (const [mode, rowSel, badgeSel] of [
  ['wayfinding', 'tr:has-text("Breakout: Captions")', '.wf-status'],
  ['agenda', '.ag-card:has-text("Breakout: Captions")', '.ag-badge'],
  ['timeline', '.tl-row:has-text("Breakout: Captions")', '.tl-badge'],
  ['programme', '.pg-cell:has-text("Breakout: Captions")', '.pg-cell-badge'],
] as const) {
  test(`${mode} mode — a CALLING session reads CALLING in yellow, not READY`, async ({ page }) => {
    await bootModeWithTimedSessions(page, mode);
    await addCalling(page);
    const badge = page.locator(`#content-area ${rowSel} ${badgeSel}`);
    await expect(badge).toHaveText(/CALLING/);
    await expect(badge).not.toHaveText(/READY/);
    expect(await badge.evaluate(el => getComputedStyle(el).color)).toBe(CALLING_RGB);
    // READY stays READY, in green
    const ready = page.locator(`#content-area ${rowSel.replace('Breakout: Captions', 'Panel: Future of AI')} ${badgeSel}`);
    await expect(ready).toHaveText(/READY/);
    expect(await ready.evaluate(el => getComputedStyle(el).color)).toBe('rgb(52, 211, 153)');
  });
}

test('header status — nothing live and a session calling reads CALLING', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'timeline');
  await page.evaluate(() => {
    const w = window as unknown as { S: { sessions: Record<string, unknown>[] }; render: () => void };
    w.S.sessions = w.S.sessions.filter(s => s.status !== 'LIVE' && s.status !== 'READY');
  });
  await addCalling(page);
  await page.evaluate(() => (window as unknown as { tick: () => void }).tick());   // tick() paints the header
  const lbl = page.locator('#d-status-lbl');
  await expect(lbl).toHaveText(/CALLING/);
  expect(await lbl.evaluate(el => getComputedStyle(el).color)).toBe(CALLING_RGB);
});

// ── 12. A delay shows the current times, not the original ones ───────────────
// A director's delay moves scheduled_start/end; planned_* keep the original.
// The day grid, programme list and agenda placed and labelled sessions by
// planned_*, so lobby screens showed times that were no longer true.
// Times arrive as the DB's TIME(0) strings ('HH:MM:SS').
async function delayWorkshop(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as { S: { sessions: Record<string, unknown>[] }; render: () => void };
    for (const s of w.S.sessions) {
      s.planned_start = String(s.scheduled_start);
      s.planned_end = String(s.scheduled_end);
    }
    const ws = w.S.sessions.find(s => s.id === 's3')!;   // Workshop: Cloud Ops, planned 11:00-12:00
    ws.scheduled_start = '11:05:00';
    ws.scheduled_end = '12:05:00';
    w.render();
  });
}
const WORKSHOP = 'Workshop: Cloud Ops';

test('delay — programme list shows the current time, the original only as "was"', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'timeline');
  await delayWorkshop(page);
  const row = page.locator(`#content-area .tl-row:has-text("${WORKSHOP}")`);
  await expect(row.locator('.tl-time-now')).toHaveText('11:05');
  await expect(row.locator('.tl-was')).toHaveText('was 11:00');
  // an on-time session has no "was"
  await expect(page.locator('#content-area .tl-row:has-text("Panel: Future of AI") .tl-was')).toHaveCount(0);
});

test('delay — agenda card shows the current time', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'agenda');
  await delayWorkshop(page);
  const card = page.locator(`#content-area .ag-card:has-text("${WORKSHOP}")`);
  await expect(card.locator('.ag-time')).toContainText('11:05');
  await expect(card.locator('.ag-was')).toHaveText('was 11:00');
});

test('agenda — times from the DB (HH:MM:SS) are shown, not blank', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'agenda');
  await delayWorkshop(page);
  const card = page.locator('#content-area .ag-card:has-text("Panel: Future of AI")');
  await expect(card.locator('.ag-time')).toHaveText('10:00');
});

test('delay — wayfinding shows the current time', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'wayfinding');
  await delayWorkshop(page);
  await expect(page.locator(`#content-area tr:has-text("${WORKSHOP}") .wf-time`)).toHaveText('11:05');
});

test('delay — day grid places the session by its current time and labels it', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'programme');
  await delayWorkshop(page);
  // 11:05-12:05 runs into the 12:00 slot; by the original 11:00-12:00 the grid ended at 11:30
  await expect(page.locator('#content-area .pg-time-lbl', { hasText: '12:00' })).toHaveCount(1);
  const cell = page.locator(`#content-area .pg-cell:has-text("${WORKSHOP}")`);
  await expect(cell.locator('.pg-cell-time')).toHaveText('11:05–12:05');
  // on-time sessions carry no extra time line
  await expect(page.locator('#content-area .pg-cell:has-text("Panel: Future of AI") .pg-cell-time')).toHaveCount(0);
});

test('delay — a session pushed past the next slot moves down the day grid', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'programme');
  await page.evaluate(() => {
    const w = window as unknown as { S: { sessions: Record<string, unknown>[] }; render: () => void };
    const ws = w.S.sessions.find(s => s.id === 's3')!;
    ws.planned_start = '11:00:00'; ws.planned_end = '12:00:00';
    ws.scheduled_start = '11:30:00'; ws.scheduled_end = '12:30:00';
    w.render();
  });
  // the first cell of the workshop sits in the row labelled 11:30
  const idx = await page.evaluate((title) => {
    const kids = [...document.querySelectorAll('#pg-grid-inner > *')];
    const cell = kids.findIndex(el => el.textContent!.includes(title));
    for (let i = cell; i >= 0; i--) if (kids[i].classList.contains('pg-time-lbl')) return kids[i].textContent;
    return null;
  }, WORKSHOP);
  expect(idx).toBe('11:30');
});
