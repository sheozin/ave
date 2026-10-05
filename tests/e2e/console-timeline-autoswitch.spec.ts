// tests/e2e/console-timeline-autoswitch.spec.ts
// The session list auto-opens the timeline when a session is armed
// (PLANNED -> READY/CALLING). A restart (LIVE/HOLD/ENDED -> READY) must not
// switch the operator's view (reported 2026-10-05), nor may an unrelated
// re-render while some session already sits in READY.
import { test, expect } from '@playwright/test';

const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:7230';

async function setup(page) {
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate(() => {
    const w = window as any;
    // eslint-disable-next-line no-undef
    const St = (0, eval)('S');
    St.role = 'director';
    St.event = { id: 'e1', name: 'Probe' };
    St.sessions = [
      { id: 'a', event_id: 'e1', sort_order: 1, title: 'Opening', status: 'LIVE', version: 3, planned_start: '09:00:00', planned_end: '09:15:00', scheduled_start: '09:00:00', scheduled_end: '09:15:00', actual_start: new Date().toISOString() },
      { id: 'b', event_id: 'e1', sort_order: 2, title: 'Panel', status: 'PLANNED', version: 1, planned_start: '09:15:00', planned_end: '10:00:00', scheduled_start: '09:15:00', scheduled_end: '10:00:00' },
    ];
    St.viewMode = 'list';
    St.tlManualOverride = false;
    St.tlBootDone = true;
    w.renderSessions();
  });
}
const viewMode = (page) => page.evaluate(() => (0, eval)('S').viewMode);
const setStatus = (page, id, status) => page.evaluate(([i, st]) => {
  const St = (0, eval)('S'); St.sessions.find(s => s.id === i).status = st; (window as any).renderSessions();
}, [id, status]);

test('a restart (LIVE -> READY) keeps the list view', async ({ page }) => {
  await setup(page);
  await setStatus(page, 'a', 'READY');
  expect(await viewMode(page)).toBe('list');
});

test('a re-render while a session is already READY keeps the list view', async ({ page }) => {
  await setup(page);
  await setStatus(page, 'a', 'READY');
  await page.evaluate(() => (window as any).renderSessions());
  expect(await viewMode(page)).toBe('list');
});

test('arming a planned session (PLANNED -> READY) still opens the timeline', async ({ page }) => {
  await setup(page);
  await setStatus(page, 'b', 'READY');
  expect(await viewMode(page)).toBe('timeline');
});
