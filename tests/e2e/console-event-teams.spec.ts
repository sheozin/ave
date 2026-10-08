// tests/e2e/console-event-teams.spec.ts
// Event teams in the console (spec docs/superpowers/specs/2026-10-08-event-teams-design.md
// §5, §6, §9): the role, the plan and the team follow the current event.
// Mocked Supabase (console-boot-mock.ts); the page clock is paused after
// boot, so anything that waits on the network steps the clock (switchTo).
import { test, expect, type Page } from '@playwright/test';
import { openConsole, evalPage, afterBootReread, EVENT_ID, USER_ID, OTHER_OWNER, type MyEvent } from './console-boot-mock';

const EV_B = 'b0b0b0b0-0000-4000-8000-0000000000b2';
const EV_C = 'c0c0c0c0-0000-4000-8000-0000000000c3';
const toasts = (page: Page) => page.locator('#toast-container');

// switchEvent awaits realtime replies that ride on timers; step the paused
// clock until it has finished.
async function switchTo(page: Page, id: string) {
  await evalPage(page, `window.__swDone = false; switchEvent('${id}').then(() => { window.__swDone = true; }, e => { window.__swDone = 'error: ' + (e && e.message); }); 0`);
  for (let i = 0; i < 200; i++) {
    const done = await evalPage(page, 'window.__swDone');
    if (done === true) return;
    if (typeof done === 'string') throw new Error(done);
    await page.clock.runFor(50);
  }
  throw new Error('switchEvent did not finish');
}
const lastTrackRole = (page: Page, eventId: string) => evalPage(page,
  `((window.__rtSent || []).filter(m => m.topic === 'realtime:leod-ctrl-${eventId}' && m.event === 'presence' && m.payload && m.payload.event === 'track').map(m => m.payload.payload.role).pop()) || null`);

const twoEvents = (): MyEvent[] => [
  { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage',    isOwner: false, ownerId: OTHER_OWNER, organiser: 'Nilegate Events' },
  { id: EV_B,     name: 'Spring summit',         role: 'director', isOwner: false, ownerId: OTHER_OWNER, organiser: 'Nilegate Events' },
];

test('teams: the role follows the event, both ways', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: twoEvents() });
  try {
    await afterBootReread(page);
    await expect(page.locator('#role-lock')).toBeVisible();
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    await expect(page.locator('#viewas-btn')).toBeHidden();
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.userRole')).toBe('director');
    expect(await evalPage(page, 'S.role')).toBe('director');
    await expect(page.locator('#role-lock')).toBeHidden();
    await expect(page.locator('#viewas-btn')).toBeVisible();
    await switchTo(page, EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('stage');
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    await expect(page.locator('#viewas-btn')).toBeHidden();
    expect(await evalPage(page, 'F.status')).toBe('ACTIVE');   // the stage default filter came back
    // the director role from the other event does not leak: View as is refused
    await evalPage(page, `setRole('director'); 0`);
    expect(await evalPage(page, 'S.role')).toBe('stage');
  } finally { await ctx.close(); }
});

test('teams: presence tracks the role on the current event', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: twoEvents() });
  try {
    await afterBootReread(page);
    await switchTo(page, EV_B);
    await expect.poll(async () => { await page.clock.runFor(50); return lastTrackRole(page, EV_B); }).toBe('director');
    await switchTo(page, EVENT_ID);
    await expect.poll(async () => { await page.clock.runFor(50); return lastTrackRole(page, EVENT_ID); }).toBe('stage');
  } finally { await ctx.close(); }
});

test('teams: an event you were removed from is dropped on switch', async ({ browser }) => {
  const mine = twoEvents();
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: mine });
  try {
    await afterBootReread(page);
    mine.splice(1, 1);   // the organiser removes this person from Spring summit
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('stage');
    await expect(toasts(page)).toContainText('You are no longer on the team of this event.');
    expect(await evalPage(page, 'S.events.map(e => e.id)')).toEqual([EVENT_ID]);
    await expect(page.locator('#ev-pill-dd')).not.toContainText('Spring summit');
  } finally { await ctx.close(); }
});

test('teams: a check-in staff login that is on a console team opens the console', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {
    role: 'stage', accountRole: 'checkin_staff',
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER }],
  });
  try {
    await expect(page.locator('body')).not.toContainText('This login is for CueDeck Check-in');
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    expect(await evalPage(page, 'S.accountRole')).toBe('checkin_staff');
  } finally { await ctx.close(); }
});
