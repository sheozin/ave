// tests/e2e/console-forbidden.spec.ts
// A 403 from a session Edge Function means the server refused this operator
// for this event: the console must say so and must NOT fall back to a direct
// table write. The delay fallback (EF down) must check each write's { error }
// instead of reporting success. No auth: state is injected, every Edge
// Function and REST call is intercepted.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.CONSOLE_BASE ?? 'http://127.0.0.1:7230';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let rest: { method: string; url: string; body: any }[] = [];
// What a PATCH to leod_sessions answers: status and rows.
let patchReply: { status: number; body: unknown } = { status: 200, body: [] };

async function setup(page: Page, efStatus: number, efBody: unknown) {
  const calls: { fn: string; body: any }[] = [];
  rest = [];
  patchReply = { status: 200, body: [] };
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    rest.push({ method: req.method(), url: req.url(), body: req.postDataJSON?.() ?? null });
    if (req.method() === 'PATCH') {
      await route.fulfill({ status: patchReply.status, contentType: 'application/json', body: JSON.stringify(patchReply.body) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/functions/v1/**', async route => {
    const fn = new URL(route.request().url()).pathname.split('/').pop()!;
    calls.push({ fn, body: route.request().postDataJSON() });
    await route.fulfill({ status: efStatus, contentType: 'application/json', body: JSON.stringify(efBody) });
  });
  page.on('dialog', d => { throw new Error('native dialog opened: ' + d.message()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  });
  await page.evaluate(([a, b]) => {
    (0, eval)(`
      S.userRole = 'director';
      S.role     = 'director';
      S.viewMode = 'list';
      S.event    = { id: 'ev-1', name: 'Test Event' };
      S.sessions = [
        { id: '${a}', event_id: 'ev-1', sort_order: 1, title: 'Opening', status: 'READY', version: 5,
          actual_start: null, actual_end: null, delay_minutes: 0, cumulative_delay: 0, is_anchor: false,
          scheduled_start: '10:30:00', scheduled_end: '10:45:00', planned_start: '10:30', planned_end: '10:45' },
        { id: '${b}', event_id: 'ev-1', sort_order: 2, title: 'Keynote', status: 'PLANNED', version: 1,
          actual_start: null, actual_end: null, delay_minutes: 0, cumulative_delay: 0, is_anchor: false,
          scheduled_start: '11:00:00', scheduled_end: '11:30:00', planned_start: '11:00', planned_end: '11:30' },
      ];
      renderSessions();
    `);
  }, [A, B]);
  return calls;
}

const toasts = (page: Page) => page.locator('#toast-container');
const evalPage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);
const patches = () => rest.filter(r => r.method === 'PATCH' || r.method === 'POST');

test('a 403 on a transition shows a toast, rolls back and writes nothing', async ({ page }) => {
  const calls = await setup(page, 403, { error: 'Forbidden' });
  await evalPage(page, `transition('${A}', 'LIVE')`);
  await expect(toasts(page)).toContainText('not allowed to change this session');
  expect(calls.filter(c => c.fn === 'go-live')).toHaveLength(1);
  await page.waitForTimeout(300);
  expect(patches()).toEqual([]);
  const s = await evalPage(page, `JSON.stringify(S.sessions.find(x => x.id === '${A}'))`);
  expect(JSON.parse(s as string)).toMatchObject({ status: 'READY', version: 5, actual_start: null });
});

test('another EF error still falls back to the direct write', async ({ page }) => {
  await setup(page, 500, { error: 'boom' });
  patchReply = { status: 200, body: [{ id: A }] };
  await evalPage(page, `transition('${A}', 'LIVE')`);
  await expect.poll(() => rest.filter(r => r.method === 'PATCH').length).toBe(1);
});

test('a 403 on a delay shows a toast and does not cascade on the client', async ({ page }) => {
  const calls = await setup(page, 403, { error: 'Forbidden' });
  await evalPage(page, `applyDelay('${A}', 5)`);
  await expect(toasts(page)).toContainText('not allowed to change this session');
  expect(calls.filter(c => c.fn === 'apply-delay')).toHaveLength(1);
  await page.waitForTimeout(300);
  expect(patches()).toEqual([]);
  const start = await evalPage(page, `S.sessions.find(x => x.id === '${A}').scheduled_start`);
  expect(start).toBe('10:30:00');
});

test('a delay through the Edge Function writes nothing from the client', async ({ page }) => {
  await setup(page, 200, { ok: true, affected: 2, minutes: 5 });
  await evalPage(page, `applyDelay('${A}', 5)`);
  await expect(toasts(page)).toContainText('2 sessions shifted +5m');
  await page.waitForTimeout(300);
  expect(patches()).toEqual([]);
});

test('delay fallback: a failed write is reported, not shown as success', async ({ page }) => {
  await setup(page, 500, { error: 'function down' });
  patchReply = { status: 403, body: { code: '42501', message: 'new row violates row-level security policy' } };
  await evalPage(page, `applyDelay('${A}', 5)`);
  await expect(toasts(page)).toContainText('The delay was not saved');
  await expect(toasts(page)).not.toContainText('Delay applied');
  expect(rest.filter(r => r.method === 'PATCH')).toHaveLength(2);
  // It reloads the schedule instead of keeping the unsaved local shift.
  await expect.poll(() => rest.filter(r => r.method === 'GET' && r.url.includes('leod_sessions')).length).toBeGreaterThan(0);
});

test('delay fallback: a write that matches no row is a failure too', async ({ page }) => {
  await setup(page, 500, { error: 'function down' });
  patchReply = { status: 200, body: [] };
  await evalPage(page, `applyDelay('${A}', 5)`);
  await expect(toasts(page)).toContainText('The delay was not saved');
});

test('delay fallback: all writes saved is a success', async ({ page }) => {
  await setup(page, 500, { error: 'function down' });
  patchReply = { status: 200, body: [{ id: A }] };
  await evalPage(page, `applyDelay('${A}', 5)`);
  await expect(toasts(page)).toContainText('Delay applied');
  expect(rest.filter(r => r.method === 'PATCH')).toHaveLength(2);
});

test('a version conflict really reloads the sessions', async ({ page }) => {
  await setup(page, 409, { error: 'Version conflict' });
  await evalPage(page, `transition('${A}', 'LIVE')`);
  await expect(toasts(page)).toContainText('Updated by another operator');
  await expect.poll(() => rest.filter(r => r.method === 'GET' && r.url.includes('leod_sessions')).length).toBeGreaterThan(0);
});

test('reset delays: a failed write is reported, not dropped', async ({ page }) => {
  await setup(page, 200, {});
  await evalPage(page, `
    S.sessions.forEach(s => { s.cumulative_delay = 10; s.scheduled_start = '10:40:00'; });
    renderSessions();
  `);
  patchReply = { status: 403, body: { code: '42501', message: 'new row violates row-level security policy' } };
  await evalPage(page, `
    const b = document.getElementById('ds-reset-btn') || Object.assign(document.body.appendChild(document.createElement('button')), { id: 'ds-reset-btn' });
    b.dataset.armed = 'yes';
    resetAllDelays();
  `);
  await expect(toasts(page)).toContainText('The delay reset was not saved');
  expect(rest.filter(r => r.method === 'PATCH')).toHaveLength(2);
});

test('another EF error still falls back to the direct write, and logs it', async ({ page }) => {
  await setup(page, 500, { error: 'boom' });
  patchReply = { status: 200, body: [{ id: A }] };
  await evalPage(page, `transition('${A}', 'LIVE')`);
  await expect.poll(() => rest.filter(r => r.method === 'POST' && r.url.includes('leod_event_log')).length).toBe(1);
});

test('transition fallback: a write that matches no row is a conflict, not a success', async ({ page }) => {
  await setup(page, 500, { error: 'boom' });
  patchReply = { status: 200, body: [] }; // the version guard matched nothing
  await evalPage(page, `S.sessions.find(x => x.id === '${A}').status = 'LIVE'; renderSessions(); transition('${A}', 'ENDED')`);
  await expect(toasts(page)).toContainText('Updated by another operator');
  await page.waitForTimeout(300);
  expect(rest.filter(r => r.method === 'POST' && r.url.includes('leod_event_log'))).toEqual([]);
  await expect(page.locator('#undo-bar')).toBeHidden();
  // It reloads the real state instead of keeping the optimistic ENDED.
  await expect.poll(() => rest.filter(r => r.method === 'GET' && r.url.includes('leod_sessions')).length).toBeGreaterThan(0);
});

test('transition fallback logs who wrote it', async ({ page }) => {
  await setup(page, 500, { error: 'boom' });
  await evalPage(page, `S.user = { id: 'user-1' }`);
  patchReply = { status: 200, body: [{ id: A }] };
  await evalPage(page, `transition('${A}', 'LIVE')`);
  await expect.poll(() => rest.filter(r => r.method === 'POST' && r.url.includes('leod_event_log')).length).toBe(1);
  expect(rest.find(r => r.method === 'POST' && r.url.includes('leod_event_log'))!.body).toMatchObject({ operator_id: 'user-1' });
});

test('overrun tick: a 403 is not retried every second', async ({ page }) => {
  const calls = await setup(page, 403, { error: 'Forbidden' });
  await evalPage(page, `
    S.user = { id: 'user-1' };
    const s = S.sessions.find(x => x.id === '${A}');
    s.status = 'LIVE'; s.actual_start = new Date(Date.now() - 3600_000).toISOString();
    s.scheduled_start = '10:30:00'; s.scheduled_end = '10:45:00';
    renderSessions();
  `);
  await page.waitForTimeout(3500); // three ticks
  expect(calls.filter(c => c.fn === 'set-overrun')).toHaveLength(1);
});

test('broadcast is keyed by the event, not one global row', async ({ page }) => {
  await setup(page, 200, {});
  await page.fill('#bc-input', 'Doors open in 5');
  await evalPage(page, `sendBroadcast()`);
  await expect.poll(() => rest.filter(r => r.method === 'POST' && r.url.includes('leod_broadcast')).length).toBe(1);
  expect(rest.find(r => r.method === 'POST' && r.url.includes('leod_broadcast'))!.body).toMatchObject({ id: 'ev-1', event_id: 'ev-1' });
});

test('clearing a broadcast targets this event and reports a failure', async ({ page }) => {
  await setup(page, 200, {});
  patchReply = { status: 403, body: { code: '42501', message: 'row-level security' } };
  await evalPage(page, `_clearBCArmed.armed = true; clearBroadcast()`);
  await expect(toasts(page)).toContainText('row-level security');
  const patch = rest.find(r => r.method === 'PATCH' && r.url.includes('leod_broadcast'))!;
  expect(patch.url).toContain('id=eq.ev-1');
});
