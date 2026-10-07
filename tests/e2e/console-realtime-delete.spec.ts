// tests/e2e/console-realtime-delete.spec.ts
// Supabase Realtime never applies a filter to DELETE ("Delete events are not
// filterable"), and with replica identity default old = { id } only. A session
// deleted on one console must still leave every other console; a DELETE for a
// row of another event (unknown id) must change nothing. Plus the More menu
// closes whenever the inspector picks a session by itself.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, rtPush, ID, PANEL_ID, demoSessions } from './console-boot-mock';

const TITLE5 = 'Duty Free Pricing After the Currency Float';
const PANEL = 'Panel: Airport Retail in Cairo, Casablanca and Tunis';

test('realtime: an unfiltered DELETE with old = { id } removes the selected session everywhere; the inspector falls back', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `selectSession('${ID(5)}')`);
  await expect(page.locator('#ctx-wrap .insp-title')).toHaveText(TITLE5);
  await page.locator('#insp-more > summary').click();
  await expect.poll(() => evalPage(page, 'S.inspMoreOpen')).toBe(true);
  await expect(page.locator('#band')).toContainText(TITLE5);

  expect(await rtPush(page, 'leod_sessions', 'DELETE', null, { id: ID(5) })).toBeGreaterThan(0);
  await page.clock.runFor(300);

  await expect(page.locator(`#card-${ID(5)}`)).toHaveCount(0);
  await expect(page.locator('#band')).not.toContainText(TITLE5);
  await expect(page.locator('#ctx-wrap .insp-title')).toHaveText(PANEL);   // nothing selected any more: most urgent
  expect(await evalPage(page, 'S.selectedId')).toBeNull();
  expect(await evalPage(page, 'S.inspMoreOpen')).toBe(false);
  expect(await evalPage(page, 'S.sessions.length')).toBe(demoSessions().length - 1);
  await ctx.close();
});

test('realtime: a DELETE for an id this event does not have changes nothing', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `selectSession('${ID(5)}')`);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await rtPush(page, 'leod_sessions', 'DELETE', null, { id: 'ffffffff-aaaa-4bbb-8ccc-ffffffffffff' });
  await page.clock.runFor(300);
  expect(await evalPage(page, 'S.sessions.length')).toBe(demoSessions().length);
  await expect(page.locator('#ctx-wrap .insp-title')).toHaveText(TITLE5);
  expect(await evalPage(page, 'S.selectedId')).toBe(ID(5));
  expect(errors).toEqual([]);
  await ctx.close();
});

test('realtime: a DELETE delivered twice (unfiltered and filtered) is processed once and never throws', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await rtPush(page, 'leod_sessions', 'DELETE', null, { id: ID(7) });
  await evalPage(page, `onSessionChange({ eventType: 'DELETE', new: {}, old: { id: '${ID(7)}' } })`);   // a server that does pass it through the filtered binding
  await page.clock.runFor(300);
  expect(await evalPage(page, 'S.sessions.length')).toBe(demoSessions().length - 1);
  await expect(page.locator(`#card-${ID(7)}`)).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('inspector: More closes when the inspector auto-picks a different session, and stays open while it does not', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#ctx-wrap .insp-title')).toHaveText(PANEL);   // nothing selected: auto-picked
  await page.locator('#insp-more > summary').click();
  await expect.poll(() => evalPage(page, 'S.inspMoreOpen')).toBe(true);
  await page.clock.runFor(2500);                                            // two ticks, same auto-pick
  expect(await evalPage(page, 'S.inspMoreOpen')).toBe(true);
  // The panel ends on another console; the inspector auto-picks the next most urgent session.
  const panel = demoSessions().find(s => s.id === PANEL_ID)!;
  await rtPush(page, 'leod_sessions', 'UPDATE', { ...panel, status: 'ENDED', version: 10, actual_end: new Date().toISOString() }, { id: PANEL_ID });
  await page.clock.runFor(300);
  await expect(page.locator('#ctx-wrap .insp-title')).not.toHaveText(PANEL);
  expect(await evalPage(page, 'S.inspMoreOpen')).toBe(false);
  await ctx.close();
});

test('timeline: the empty state is translated', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: [], broadcast: null, locale: 'pl' });
  await evalPage(page, `setViewMode('timeline')`);
  await expect(page.locator('#timeline-wrap .tl-empty')).toHaveText('Brak sesji do wyświetlenia na osi czasu.');
  await ctx.close();
});
