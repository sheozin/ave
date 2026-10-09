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

test('PR-014 agenda mode — shows the board with its column headers', async ({ page }) => {
  await bootMode(page, 'agenda');
  await expect(page.locator('#content-area .ab-th')).toBeVisible();
});

test('PR-014 agenda mode — shows session titles on the board', async ({ page }) => {
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

test('delay — agenda board shows the current time, the original struck through', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'agenda');
  await delayWorkshop(page);
  const row = page.locator(`#content-area .ab-row:has-text("${WORKSHOP}")`);
  await expect(row.locator('.ab-now')).toHaveText('11:05');
  await expect(row.locator('s.ab-was')).toHaveText('11:00');
});

test('agenda — times from the DB (HH:MM:SS) are shown, not blank', async ({ page }) => {
  await bootModeWithTimedSessions(page, 'agenda');
  await delayWorkshop(page);
  const row = page.locator('#content-area .ab-row:has-text("Panel: Future of AI")');
  await expect(row.locator('.ab-now')).toHaveText('10:00');
  await expect(row.locator('.ab-was')).toHaveCount(0);
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

// ── 13. AGENDA mode is a departures board (approved Option B, 9 Oct) ────────
// One list for the venue in time order by the CURRENT schedule: Time |
// Session (title + speakers) | Room | Status. Only the last finished session
// stays; finished and cancelled rows fade; delays show the old time struck.
type Sess = Record<string, unknown>;
function boardSessions(): Sess[] {
  const at = (hm: string) => `2026-11-12T${hm}:00`;
  const mk = (id: string, title: string, room: string, status: string, sort: number,
    planned: [string, string], sched: [string, string] = planned, extra: Sess = {}): Sess => ({
    id, title, speaker: `Speaker ${id}`, company: '', room, status, sort_order: sort,
    planned_start: at(planned[0]), planned_end: at(planned[1]),
    scheduled_start: `${sched[0]}:00`, scheduled_end: `${sched[1]}:00`, actual_start: null, ...extra,
  });
  // sort_order is deliberately not time order: the board orders by current start
  return [
    mk('doors', 'Doors open', 'Main Stage', 'ENDED', 9, ['08:30', '09:00']),
    mk('key', 'Opening keynote', 'Main Stage', 'ENDED', 8, ['09:00', '09:45']),
    mk('live', 'The future of hybrid events', 'Main Stage', 'LIVE', 7, ['10:00', '10:45'], ['10:00', '10:45'],
      { actual_start: new Date(Date.now() - 31 * 60_000).toISOString() }),
    mk('call', 'Breakout: captions', 'Hall B', 'CALLING', 6, ['10:30', '11:15'], ['10:35', '11:20']),
    mk('panel', 'Panel: crews that scale', 'Main Stage', 'READY', 1, ['11:00', '11:45'], ['11:05', '11:50']),
    mk('case', 'Case study: festival', 'Hall B', 'PLANNED', 2, ['11:30', '12:15'], ['11:35', '12:20']),
    mk('early', 'Early demo', 'Hall B', 'PLANNED', 3, ['12:00', '12:30'], ['11:50', '12:20']),
    mk('lunch', 'Networking lunch', 'Main Stage', 'PLANNED', 4, ['12:15', '13:15']),
    mk('hold', 'Sponsor demos', 'Hall B', 'HOLD', 5, ['13:15', '14:00']),
    mk('cxl', 'Workshop: rigging', 'Hall B', 'CANCELLED', 10, ['14:00', '15:00']),
  ];
}
const BOARD_ORDER = ['Opening keynote', 'The future of hybrid events', 'Breakout: captions', 'Panel: crews that scale',
  'Case study: festival', 'Early demo', 'Networking lunch', 'Sponsor demos', 'Workshop: rigging'];

async function bootBoard(page: import('@playwright/test').Page, ov: Record<string, unknown> = {}, sessions?: Sess[]) {
  await page.goto(DISP_URL);
  await page.evaluate(({ ov, sessions }) => {
    const w = window as unknown as Record<string, unknown>;
    w.S = { sessions, sponsors: [], event: { name: 'Northwind Summit 2026' }, broadcast: null, clockOffset: 0, stageMessages: [] };
    w.D = { id: 'disp-ab', name: 'Lobby', content_mode: 'agenda', orientation: 'landscape', filter_room: null,
      override_content: null, sequence: null, paginate_seconds: 10, ...ov };
    document.getElementById('setup')!.style.display = 'none';
    document.getElementById('display')!.style.display = 'flex';
    (w.render as () => void)();
  }, { ov, sessions: sessions ?? boardSessions() });
}
const row = (page: import('@playwright/test').Page, title: string) =>
  page.locator('#content-area .ab-row').filter({ has: page.locator('.ab-ti', { hasText: title }) });

test.describe('agenda board', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('column headers Time, Session, Room, Status under a "Today\'s agenda" title', async ({ page }) => {
    await bootBoard(page);
    await expect(page.locator('#content-area .ab-title')).toHaveText("Today's agenda");
    await expect(page.locator('#content-area .ab-th > *')).toHaveText(['Time', 'Session', 'Room', 'Status']);
    await expect(page.locator('#d-clock')).toHaveCount(1);   // the display's own top bar stays
  });

  test('rows run in current-time order; only the most recent finished session stays', async ({ page }) => {
    await bootBoard(page);
    await expect(page.locator('#content-area .ab-row .ab-ti')).toHaveText(BOARD_ORDER);
    await expect(page.locator('#content-area')).not.toContainText('Doors open');
  });

  test('each status reads in words, in its colour', async ({ page }) => {
    await bootBoard(page);
    const st = (t: string) => row(page, t).locator('.ab-st');
    await expect(st('Opening keynote')).toHaveText('Finished');
    await expect(st('The future of hybrid events')).toHaveText('Live · 14 min left');
    await expect(st('Breakout: captions')).toHaveText('Starting soon');
    await expect(st('Panel: crews that scale')).toHaveText('Delayed 5 min');
    await expect(st('Case study: festival')).toHaveText('Delayed 5 min');
    await expect(st('Early demo')).toHaveText('Earlier 10 min');
    await expect(st('Networking lunch')).toHaveText('On time');
    await expect(st('Sponsor demos')).toHaveText('On hold');
    await expect(st('Workshop: rigging')).toHaveText('Cancelled');
    const colour = (t: string) => st(t).evaluate(el => getComputedStyle(el).color);
    expect(await colour('The future of hybrid events')).toBe('rgb(239, 68, 68)');
    expect(await colour('Breakout: captions')).toBe(CALLING_RGB);
    expect(await colour('Panel: crews that scale')).toBe('rgb(251, 146, 60)');
    expect(await colour('Networking lunch')).not.toBe('rgb(251, 146, 60)');
    // finished and cancelled rows fade; a cancelled title is struck through
    expect(Number(await row(page, 'Opening keynote').evaluate(el => getComputedStyle(el).opacity))).toBeLessThan(0.6);
    expect(Number(await row(page, 'Workshop: rigging').evaluate(el => getComputedStyle(el).opacity))).toBeLessThan(0.6);
    expect(await row(page, 'Workshop: rigging').locator('.ab-ti').evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('line-through');
    expect(Number(await row(page, 'Networking lunch').evaluate(el => getComputedStyle(el).opacity))).toBe(1);
  });

  test('an overrunning session reads "Running over"', async ({ page }) => {
    const ss = boardSessions();
    ss.find(s => s.id === 'live')!.status = 'OVERRUN';
    await bootBoard(page, {}, ss);
    await expect(row(page, 'The future of hybrid events').locator('.ab-st')).toHaveText('Running over');
  });

  test('a moved session shows the new time with the old one struck through; speakers under the title', async ({ page }) => {
    await bootBoard(page);
    const r = row(page, 'Panel: crews that scale');
    await expect(r.locator('.ab-now')).toHaveText('11:05');
    await expect(r.locator('s.ab-was')).toHaveText('11:00');
    await expect(r.locator('.ab-sp')).toHaveText('Speaker panel');
    await expect(r.locator('.ab-rm')).toHaveText('Main Stage');
    await expect(row(page, 'Networking lunch').locator('.ab-was')).toHaveCount(0);
  });

  test('a display with a room shows only that room and drops the Room column', async ({ page }) => {
    await bootBoard(page, { filter_room: 'Hall B' });
    await expect(page.locator('#content-area .ab-row .ab-ti')).toHaveText(
      ['Breakout: captions', 'Case study: festival', 'Early demo', 'Sponsor demos', 'Workshop: rigging']);
    await expect(page.locator('#content-area .ab-title')).toContainText('Hall B');
    await expect(page.locator('#content-area .ab-th > *:visible')).toHaveText(['Time', 'Session', 'Status']);
  });

  test('with nothing still to come the board shows the whole day', async ({ page }) => {
    const ss = boardSessions().map(s => ({ ...s, status: 'ENDED' }));
    await bootBoard(page, {}, ss);
    await expect(page.locator('#content-area .ab-row')).toHaveCount(10);
  });

  test('a live minute count updates in place, without rebuilding the board', async ({ page }) => {
    await bootBoard(page);
    await page.evaluate(() => { (document.querySelector('.ab-wrap') as HTMLElement & { _mark?: number })._mark = 1; });
    await page.evaluate(() => {
      const w = window as unknown as { S: { sessions: Record<string, unknown>[] }; tick: () => void };
      w.S.sessions.find(s => s.id === 'live')!.actual_start = new Date(Date.now() - 40 * 60_000).toISOString();
      w.tick();
    });
    await expect(row(page, 'The future of hybrid events').locator('.ab-st')).toHaveText('Live · 5 min left');
    // an unchanged poll re-render keeps the same board (no fade, no flicker)
    await page.evaluate(() => (window as unknown as { render: () => void }).render());
    expect(await page.evaluate(() => (document.querySelector('.ab-wrap') as HTMLElement & { _mark?: number })._mark)).toBe(1);
  });
});

test.describe('agenda board at 1280x720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('rows that do not fit page through, with "Page 1 of N", keeping the page across re-renders', async ({ page }) => {
    const ss = boardSessions();
    for (let i = 0; i < 6; i++) ss.push({ ...ss[7], id: `x${i}`, title: `Extra session ${i}`,
      planned_start: `2026-11-12T${15 + i}:00:00`, scheduled_start: `${15 + i}:00:00`, scheduled_end: `${15 + i}:45:00` });
    await bootBoard(page, { paginate_seconds: 1 }, ss);
    const pg = page.locator('#content-area .ab-page');
    await expect(pg).toHaveText(/^Page 1 of [2-9]$/);
    // every visible row sits inside the board body
    const fits = await page.evaluate(() => {
      const body = document.querySelector('.ab-body')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('.ab-row')].filter(r => r.offsetParent)
        .every(r => r.getBoundingClientRect().bottom <= body.bottom + 0.5);
    });
    expect(fits).toBe(true);
    await expect(pg).toHaveText(/^Page 2 of /, { timeout: 4000 });
    // a poll that changes nothing must not jump back to page 1
    await page.evaluate(() => (window as unknown as { render: () => void }).render());
    await expect(pg).toHaveText(/^Page 2 of /);
    // a status change re-renders but stays on the same page
    await page.evaluate(() => {
      const w = window as unknown as { S: { sessions: Record<string, unknown>[] }; render: () => void };
      w.S.sessions.find(s => s.id === 'hold')!.status = 'READY';
      w.render();
    });
    await expect(pg).toHaveText(/^Page 2 of /);
  });

  test('when everything fits there is no page count', async ({ page }) => {
    await bootBoard(page, { filter_room: 'Main Stage' });
    await expect(page.locator('#content-area .ab-row')).toHaveCount(4);
    await expect(page.locator('#content-area .ab-page')).toHaveText('');
  });
});

for (const vp of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
  test.describe(`agenda board fits at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });
    test('nothing overflows sideways', async ({ page }) => {
      const ss = boardSessions();
      ss[4].title = 'Panel: building crews that scale across three continents and nine time zones';
      ss[4].people = ['Priya Raman', 'Marcus Feld', 'Ines Carvalho', 'Jun Watanabe', 'Lucia Ferreira'].map(name => ({ name, role: 'panelist' }));
      ss[3].room = 'Conference Room Alpha West';
      await bootBoard(page, {}, ss);
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        if (document.documentElement.scrollWidth > innerWidth) out.push('page scrolls sideways');
        for (const r of document.querySelectorAll<HTMLElement>('.ab-row, .ab-th')) {
          if (!r.offsetParent) continue;
          const box = r.getBoundingClientRect();
          for (const el of r.querySelectorAll<HTMLElement>('*')) {
            if (!el.offsetParent) continue;
            const b = el.getBoundingClientRect();
            if (b.right > box.right + 0.5 || el.scrollWidth > el.clientWidth + 1) out.push(`${el.className}: ${el.textContent}`);
          }
        }
        return out;
      });
      expect(bad).toEqual([]);
      if (vp.height > vp.width) {
        // portrait: the Room column folds under the session
        await expect(page.locator('#content-area .ab-th .ab-c-room')).toBeHidden();
        await expect(page.locator('#content-area .ab-row:visible').first().locator('.ab-rm-in')).toBeVisible();
      } else {
        await expect(page.locator('#content-area .ab-row:visible').first().locator('.ab-rm')).toBeVisible();
      }
    });
  });
}
