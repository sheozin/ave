// tests/e2e/console-press-guard.spec.ts
// Stage 4 review: a slot whose action changes in place (Resume or On stage
// becoming Hold) must not take the press meant for the old action. A second
// click of a double-click is ignored, and a press within 600 ms of the slot's
// action changing does nothing (no transition, no arm). The two-press End still
// confirms, because arming changes the label, not the action.
import { test, expect, type Page } from '@playwright/test';
import { openConsole, evalPage, rtPush, ID, demoSessions, iso } from './console-boot-mock';

function efLog(page: Page) {
  const calls: string[] = [];
  page.on('request', r => { const m = r.url().match(/\/functions\/v1\/([\w-]+)/); if (m) calls.push(m[1]); });
  return calls;
}
const settle = (page: Page) => page.waitForTimeout(250);   // let any request leave the page (real time)

// Hall B: #2 finished, so the lane's "now" is #4 CALLING and its lead slot says On stage.
const callingHallB = () => demoSessions().map(x => x.id === ID(2) ? { ...x, status: 'ENDED', actual_end: iso(-1) } : x);
const s4 = () => callingHallB().find(x => x.id === ID(4))!;
// Boot re-reads the sessions once about 0.7 s in (clock resync); let that pass first,
// or it overwrites the realtime update with the mocked rows.
const goLiveElsewhere = async (page: Page) => { await page.clock.runFor(1500); return rtPush(page, 'leod_sessions', 'UPDATE', { ...s4(), status: 'LIVE', version: 5, actual_start: iso(0), state_changed_at: iso(0) }, { id: ID(4) }); };

const LANE_B = '#band .lane[data-room="Hall B"]';

test('(a) double-clicking Resume in the band sends one go-live and no hold-stage', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const calls = efLog(page);
  const lead = page.locator(`${LANE_B} .lane-lead .btn`);
  await expect(lead).toHaveText(/Resume/);
  await lead.dblclick();
  await settle(page);
  expect(calls.filter(c => c === 'go-live')).toHaveLength(1);
  expect(calls).not.toContain('hold-stage');
  await ctx.close();
});

test('(b) band lead: On stage turns into Hold by realtime; a click 200 ms later does nothing, one 700 ms later holds', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: callingHallB() });
  const calls = efLog(page);
  const lead = page.locator(`${LANE_B} .lane-lead .btn`);
  await expect(lead).toHaveText(/On stage/);
  await goLiveElsewhere(page);
  await expect(lead).toHaveText(/Hold/);
  await page.clock.runFor(200);
  await lead.click();
  await settle(page);
  expect(calls).toEqual([]);
  await page.clock.runFor(700);
  await lead.click();
  await settle(page);
  expect(calls).toEqual(['hold-stage']);
  await ctx.close();
});

test('(c) list row primary: On stage turns into End by realtime; a click 200 ms later does not arm, one 700 ms later does', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: callingHallB() });
  const calls = efLog(page);
  const act = page.locator(`#card-${ID(4)} .sc-act .btn`);
  await expect(act).toHaveText(/On stage/);
  await goLiveElsewhere(page);
  await expect(act).toHaveText(/End/);
  await page.clock.runFor(200);
  await act.click();
  await settle(page);
  await expect(act).not.toHaveClass(/confirm-pending/);
  expect(calls).toEqual([]);
  await page.clock.runFor(700);
  await act.click();
  await expect(act).toHaveClass(/confirm-pending/);
  await ctx.close();
});

test('(c) inspector primary: On stage turns into Hold by realtime; a click 200 ms later does nothing, one 700 ms later holds', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: callingHallB() });
  await evalPage(page, `selectSession('${ID(4)}')`);
  const calls = efLog(page);
  const first = page.locator('#ctx-wrap .insp-primary .btn').first();
  await expect(first).toHaveText(/On stage/);
  await goLiveElsewhere(page);
  await expect(first).toHaveText(/Hold/);
  await page.clock.runFor(200);
  await first.click();
  await settle(page);
  expect(calls).toEqual([]);
  await page.clock.runFor(700);
  await first.click();
  await settle(page);
  expect(calls).toEqual(['hold-stage']);
  await ctx.close();
});

for (const [where, sel] of [
  ['band', '#band .lane[data-room="Main Stage"] .lane-now .btn.danger'],
  ['list', `#card-${ID(3)} .sc-act .btn.danger`],
  ['inspector', '#ctx-wrap .insp-primary .btn.danger'],
] as const) {
  test(`(d) End still confirms with two presses within 3 s in the ${where}`, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser);
    const calls = efLog(page);
    const end = page.locator(sel);
    await end.click();
    await expect(end).toHaveClass(/confirm-pending/);
    await page.clock.runFor(1000);
    await end.click();
    await settle(page);
    expect(calls).toEqual(['end-session']);
    await ctx.close();
  });
}

test('timeline: an unchanged re-render does not measure the labels again', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline')`);
  const before = await page.locator('.tl-bar-label').allTextContents();
  const n = await page.evaluate(() => {
    const proto = SVGTextContentElement.prototype as any;
    const orig = proto.getComputedTextLength;
    let count = 0;
    proto.getComputedTextLength = function () { count++; return orig.call(this); };
    (window as any).renderSessions();
    (window as any).renderSessions();
    proto.getComputedTextLength = orig;
    return count;
  });
  expect(n).toBe(0);
  expect(await page.locator('.tl-bar-label').allTextContents()).toEqual(before);
  await ctx.close();
});
