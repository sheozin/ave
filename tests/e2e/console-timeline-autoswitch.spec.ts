// tests/e2e/console-timeline-autoswitch.spec.ts
// The console never changes the operator's view on its own. Arming a session
// used to flip the director to the timeline, which has no controls (removed
// 2026-10-06, show-safety audit); a restart must not switch it either
// (reported 2026-10-05). The user chooses the view.
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
    // The removed auto-switch only fired once this boot flag was set; set it
    // so the spec catches the switch if it ever comes back.
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

test('arming a planned session (PLANNED -> READY) keeps the list view', async ({ page }) => {
  await setup(page);
  await setStatus(page, 'b', 'READY');
  expect(await viewMode(page)).toBe('list');
  await expect(page.locator('#sessions-list .sc')).toHaveCount(2);
});

test('arming to CALLING keeps the list view and shows no auto-switch notice', async ({ page }) => {
  await setup(page);
  await setStatus(page, 'b', 'CALLING');
  expect(await viewMode(page)).toBe('list');
  await expect(page.locator('#tl-auto-toast')).toHaveCount(0);
});

test('a director on the timeline stays there when a session is armed or restarted', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => (window as any).setViewMode('timeline'));
  await setStatus(page, 'b', 'READY');
  await setStatus(page, 'a', 'READY');
  expect(await viewMode(page)).toBe('timeline');
});
