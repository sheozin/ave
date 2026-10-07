// tests/e2e/console-show-safety-boot.spec.ts
// Show-safety fixes that need a signed-in boot (2026-10-06 audit): what stage
// and AV operators see by default, the event log staying visible in the
// director sidebar, and boot running once per sign-in. Uses the mocked boot
// harness: no real backend is reached.
import { test, expect } from '@playwright/test';
import { openConsole, ID, EVENT_ID, EVENT, sess } from './console-boot-harness';

for (const role of ['stage', 'av']) {
  test(`${role} operator sees held, overrun and upcoming sessions by default, not ended or cancelled`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { role });
    try {
      await expect(page.locator('#fb-status')).toHaveValue('ACTIVE');
      const shown = await page.locator('#sessions-list .sc').evaluateAll(els => els.map(e => e.id));
      for (const k of [2, 3, 4, 5, 6]) expect(shown).toContain(`card-${ID(k)}`); // HOLD, OVERRUN, CALLING, READY, PLANNED
      for (const k of [1, 7]) expect(shown).not.toContain(`card-${ID(k)}`);      // ENDED, CANCELLED
    } finally { await ctx.close(); }
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
  test(`the director's event log is at least 200 px tall at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, { viewport });
    try {
      const h = await page.locator('#log-panel').evaluate(e => e.getBoundingClientRect().height);
      expect(h).toBeGreaterThanOrEqual(200);
      // Loaded rows keep their own time, shown in the event's zone (Cairo, UTC+3).
      const row = page.locator('#log-feed .lg.lg-broadcast').first();
      await expect(row.locator('.lg-when')).toHaveText('14:32');   // its own time, event zone (Cairo), HH:MM
      await expect(row).toContainText('Hall B on hold: projector signal lost');
    } finally { await ctx.close(); }
  });
}

test('two SIGNED_IN events after boot do not run boot again', async ({ browser }) => {
  const { ctx, page, errors } = await openConsole(browser);
  try {
    const boots = () => page.evaluate(() => (0, eval)('S').log.filter((e: any) => e.action === 'BOOT').length);
    expect(await boots()).toBe(1);
    await page.evaluate(async () => {
      const sbc = (0, eval)('sb');
      const { data } = await sbc.auth.getSession();
      await sbc.auth._notifyAllSubscribers('SIGNED_IN', data.session);
      await sbc.auth._notifyAllSubscribers('SIGNED_IN', data.session);
    });
    await page.waitForTimeout(2000);
    expect(await boots()).toBe(1);
    expect(errors.filter(e => /cannot add/.test(e))).toEqual([]);
  } finally { await ctx.close(); }
});

test('subscribing the signage channel twice replaces it instead of throwing', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  try {
    const res = await page.evaluate(async (ev) => {
      const w = window as any;
      const sbc = (0, eval)('sb');
      try {
        await w.subscribeDisplays(ev);
        await new Promise(r => setTimeout(r, 300));
        await w.subscribeDisplays(ev);
        await new Promise(r => setTimeout(r, 300));
      } catch (e: any) { return { threw: e.message, count: -1 }; }
      return { threw: '', count: sbc.getChannels().filter((c: any) => c.topic === 'realtime:leod-signage').length };
    }, EVENT_ID);
    expect(res).toEqual({ threw: '', count: 1 });
  } finally { await ctx.close(); }
});

test('two reconnects leave exactly one live channel per name and no "after subscribe()" error', async ({ browser }) => {
  const { ctx, page, errors } = await openConsole(browser);
  try {
    const res = await page.evaluate(async (ev) => {
      const w = window as any;
      const sbc = (0, eval)('sb');
      const St = (0, eval)('S');
      const thrown: string[] = [];
      const run = async (f: () => Promise<unknown>) => { try { await f(); } catch (e: any) { thrown.push(e.message); } };
      await run(() => w.doReconnect());
      await run(() => w.doReconnect());
      // A scheduled retry and a tab refocus can land together.
      await Promise.all([run(() => w.doReconnect()), run(() => w.subscribeDisplays(ev)), run(() => w.subscribeDisplays(ev))]);
      await new Promise(r => setTimeout(r, 800));
      const topics: Record<string, number> = {};
      for (const c of sbc.getChannels()) topics[c.topic] = (topics[c.topic] || 0) + 1;
      return { thrown, topics, ctrlState: St.ctrlChan?.state, ctrlInList: sbc.getChannels().includes(St.ctrlChan) };
    }, EVENT_ID);
    expect(res.thrown).toEqual([]);
    expect(res.topics).toEqual({ [`realtime:leod-ctrl-${EVENT_ID}`]: 1, 'realtime:leod-signage': 1 });
    expect(res.ctrlState).toBe('joined');
    expect(res.ctrlInList).toBe(true);
    expect(errors.filter(e => /after `?subscribe\(\)/.test(e))).toEqual([]);
  } finally { await ctx.close(); }
});

// Two more events for the switch tests (fictional).
const E3 = 'e3e3e3e3-0000-4000-8000-000000000003';
const E4 = 'e4e4e4e4-0000-4000-8000-000000000004';
const EV3 = { ...EVENT, id: E3, name: 'Second event' };
const EV4 = { ...EVENT, id: E4, name: 'Third event' };
const ctrlTopics = () => (0, eval)('sb').getChannels().map((c: any) => c.topic).filter((t: string) => t.startsWith('realtime:leod-ctrl-'));

test('back-to-back control subscriptions for two events leave only the last one', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { extraEvents: [EV3, EV4] });
  try {
    const res = await page.evaluate(async ([ev3, ev4, getTopics]) => {
      const w = window as any;
      const St = (0, eval)('S');
      St.event = ev3; const a = w.subscribeControl(ev3.id);
      St.event = ev4; const b = w.subscribeControl(ev4.id);
      await Promise.all([a, b]);
      await new Promise(r => setTimeout(r, 500));
      return { topics: (0, eval)(`(${getTopics})`)(), current: St.ctrlChan?.topic };
    }, [EV3, EV4, ctrlTopics.toString()] as const);
    expect(res.topics).toEqual([`realtime:leod-ctrl-${E4}`]);
    expect(res.current).toBe(`realtime:leod-ctrl-${E4}`);
  } finally { await ctx.close(); }
});

test('a reconnect landing during an event switch never shows the old event', async ({ browser }) => {
  const e4Sessions = [sess(9, { event_id: E4, title: 'Third event opening', room: 'Main Stage', status: 'READY',
    planned_start: '12:00:00', planned_end: '12:30:00', scheduled_start: '12:00:00', scheduled_end: '12:30:00' })];
  const { ctx, page } = await openConsole(browser, {
    extraEvents: [EV4], sessionsByEvent: { [E4]: e4Sessions }, sessionDelayMs: { [EVENT_ID]: 1500 },
  });
  try {
    // Start a reconnect for the current event and wait until its slow snapshot request is out.
    const oldSnapshot = page.waitForRequest(r => r.url().includes('/leod_sessions') && r.url().includes(EVENT_ID));
    await page.evaluate(() => { (window as any).__rc = (window as any).doReconnect(); });
    await oldSnapshot;
    // The operator switches event while that request is still in flight.
    await page.evaluate(async (e4) => { await (window as any).switchEvent(e4); await (window as any).__rc; }, E4);
    await page.waitForTimeout(800);
    const res = await page.evaluate((getTopics) => {
      const St = (0, eval)('S');
      return {
        event: St.event.id,
        sessionEvents: [...new Set(St.sessions.map((s: any) => s.event_id))],
        topics: (0, eval)(`(${getTopics})`)(),
        current: St.ctrlChan?.topic,
      };
    }, ctrlTopics.toString());
    expect(res.event).toBe(E4);
    expect(res.sessionEvents).toEqual([E4]);
    expect(res.topics).toEqual([`realtime:leod-ctrl-${E4}`]);
    expect(res.current).toBe(`realtime:leod-ctrl-${E4}`);
    await expect(page.locator('#sessions-list .sc')).toHaveCount(1);
    await expect(page.locator('#sessions-list')).toContainText('Third event opening');
  } finally { await ctx.close(); }
});

test('a reconnect whose snapshot was dropped as stale does not log "reconnected"', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {
    extraEvents: [EV4], sessionsByEvent: { [E4]: [] }, sessionDelayMs: { [EVENT_ID]: 1500 },
  });
  try {
    const oldSnapshot = page.waitForRequest(r => r.url().includes('/leod_sessions') && r.url().includes(EVENT_ID));
    await page.evaluate(() => { (window as any).__rc = (window as any).doReconnect(); });
    await oldSnapshot;
    await page.evaluate(async (e4) => { await (window as any).switchEvent(e4); await (window as any).__rc; }, E4);
    const resyncs = await page.evaluate(() => (0, eval)('S').log.filter((e: any) => e.action === 'RESYNC').length);
    expect(resyncs).toBe(0);
  } finally { await ctx.close(); }
});
