// tests/e2e/console-list.spec.ts
// Spec 2.2: 58 px rows (the approved demo) on a fixed grid, left edge = status, finished
// sessions folded, HH:MM times, one primary action, tools on hover, selection.
import { test, expect } from '@playwright/test';
import { openConsole, evalPage, ID, PANEL_ID, longTitleSessions, demoSessions } from './console-boot-mock';

test('list: rows are 58 px on a seven-column grid and the left edge is the status colour', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const row = page.locator(`#card-${ID(6)}`);
  expect(Math.round((await row.boundingBox())!.height)).toBe(58);
  expect((await row.evaluate(el => getComputedStyle(el).gridTemplateColumns)).split(' ')).toHaveLength(7);
  expect(await row.evaluate(el => [getComputedStyle(el).borderLeftWidth, getComputedStyle(el).borderLeftColor])).toEqual(['4px', 'rgb(148, 163, 184)']);
  // a delayed READY row keeps the READY edge: delay never recolours it
  expect(await page.locator(`#card-${ID(5)}`).evaluate(el => getComputedStyle(el).borderLeftColor)).toBe('rgb(52, 211, 153)');
  expect(await page.locator(`#card-${ID(2)}`).evaluate(el => getComputedStyle(el).borderLeftStyle)).toBe('dashed');
  await ctx.close();
});

test('list: finished sessions fold into one row at each end and expand on click', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const first = page.locator('#sessions-list > *').first();
  await expect(first).toHaveClass(/sc-fold/);
  // As in the approved demo: "1 completed · Opening Keynote 09:31–10:16 (ran +1)"; the fixture ended at 10:17
  await expect(first).toContainText(/^1 completed · Opening Keynote: North Africa's Travel Retail Outlook 09:31–10:17 \(ran \+2\)$/);
  expect(Math.round((await first.boundingBox())!.height)).toBe(34);
  await expect(page.locator(`#card-${ID(1)}`)).toHaveCount(0);
  await expect(page.locator('#sessions-list .sc-fold').last()).toContainText('1 cancelled · Supplier Speed Meetings');
  await first.click();
  await expect(page.locator(`#card-${ID(1)}`)).toBeVisible();
  await expect(page.locator('#sessions-list .sc-fold').first()).toHaveAttribute('aria-expanded', 'true');
  await ctx.close();
});

test('list: times are HH:MM, a delayed row shows the original time, running rows count', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator(`#card-${ID(6)} .sc-time`)).toContainText('13:35–14:20');
  await expect(page.locator(`#card-${ID(6)} .sc-time small`)).toHaveText('was 13:30');
  await expect(page.locator(`#card-${ID(6)} .sc-delay`)).toHaveText('+5');
  await expect(page.locator(`#card-${PANEL_ID} .sc-time`)).toContainText('19:15 left');
  await expect(page.locator(`#card-${ID(2)} .sc-time`)).toContainText('held 9:45');
  expect(await page.locator('#sessions-list').innerText()).not.toMatch(/\b\d\d:\d\d:\d\d\b/);
  await expect(page.locator(`#card-${PANEL_ID} .sc-notefirst`)).toContainText('Moderator opens with audience poll.');
  await expect(page.locator('#sessions-list .sc-anchor')).toContainText('Delay stops here');
  await ctx.close();
});

test('list: one primary action per row that follows the action colour rule', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const expectAct = async (id: string, text: string, cls: RegExp) => {
    const btn = page.locator(`#card-${id} .sc-act button`);
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveText(text);
    await expect(btn).toHaveClass(cls);
  };
  await expectAct(ID(6), 'Set ready', /fwd-ready/);
  await expectAct(ID(5), 'Call speaker', /fwd-calling/);
  await expectAct(ID(4), 'On stage', /fwd-go/);
  await expectAct(PANEL_ID, 'End…', /danger/);
  await expectAct(ID(2), 'Resume', /fwd-go/);
  // Backward moves are secondary, never green: "Back to ready" from CALLING or HOLD.
  for (const id of [ID(4), ID(2)]) {
    const html = await evalPage(page, `transitionButtonHTML(S.sessions.find(x => x.id === '${id}'), 'READY', 'sm', 't')`) as string;
    expect(html).toContain('Back to ready');
    expect(html).not.toMatch(/\bfwd/);
  }
  await ctx.close();
});

test('list: wrap-up warnings at 5 and 1 minute, and tenths in the final minute', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  // The panel is scheduled for 30 minutes; place its start so that `ms` remain.
  const setRemain = (ms: number) => evalPage(page, `S.sessions.find(x => x.id === '${PANEL_ID}').actual_start = new Date(correctedNow() - (30 * 60_000 - ${ms})).toISOString(); renderSessions();`);
  const row = page.locator(`#card-${PANEL_ID}`);
  await setRemain(4 * 60_000);
  await expect(row.locator('.sc-time')).toHaveClass(/warn-amber/);
  await expect(row).toHaveClass(/warn-amber/);
  expect(await row.evaluate(el => getComputedStyle(el).borderLeftColor)).toBe('rgb(239, 68, 68)');   // the edge still means LIVE
  await setRemain(30_000);
  await expect(row.locator('.sc-time')).toHaveClass(/warn-red/);
  expect(await row.evaluate(el => getComputedStyle(el).animationName)).toBe('none');                  // no pulse
  await page.clock.runFor(400);                                                                      // two 200 ms updates
  await expect(row.locator('[data-cd-sid]')).toHaveText(/^0:(29|30)\.\d left$/);
  await ctx.close();
});

test('list: a held timer keeps counting when nothing is live', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  // The harness jumps the paused clock 45 s at boot, which the tick takes for a
  // laptop waking: it resyncs the clock and reloads the snapshot. Let both land first.
  for (let i = 0; i < 20 && await evalPage(page, 'S.clockOffset') === 0; i++) await page.clock.runFor(250);
  await page.clock.runFor(500);
  await page.waitForTimeout(300);
  await evalPage(page, `S.clockOffset = 0; S.sessions.find(x => x.id === '${PANEL_ID}').status = 'ENDED'; renderSessions();`);
  expect(await evalPage(page, `S.sessions.filter(s => ['LIVE', 'OVERRUN'].includes(s.status)).length`)).toBe(0);
  const held = async () => Number((await page.locator(`#card-${ID(2)} .sc-time .cd-txt`).innerText()).match(/^held 9:(\d\d)$/)![1]);
  const before = await held();
  await page.clock.runFor(2000);                                                                     // the 1 s tick alone, no explicit render
  expect(await held()).toBe(before + 2);
  await ctx.close();
});

test('list: av gets no End in the row; stage gets End', async ({ browser }) => {
  for (const [role, n] of [['av', 0], ['stage', 1]] as const) {
    const { ctx, page } = await openConsole(browser, { role });
    await expect(page.locator(`#card-${PANEL_ID} .sc-act button.danger`)).toHaveCount(n);
    await ctx.close();
  }
});

test('list: editing tools show on hover or in edit mode only', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const tools = page.locator(`#card-${ID(6)} .sc-tools`);
  await expect(tools).toBeHidden();
  await page.locator(`#card-${ID(6)}`).hover();
  await expect(tools).toBeVisible();
  await page.locator('#edit-mode-btn').click();
  await expect(page.locator('#edit-mode-btn')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(5, 5);
  await expect(page.locator(`#card-${ID(7)} .sc-tools`)).toBeVisible();
  await ctx.close();
});

test('list: click, Enter and arrow keys select a row', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await page.locator(`#card-${ID(4)} .sc-title`).click();
  await expect(page.locator(`#card-${ID(4)}`)).toHaveClass(/is-selected/);
  await page.locator(`#card-${ID(4)}`).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`#card-${ID(5)}`)).toHaveClass(/is-selected/);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(`card-${ID(5)}`);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  expect(await evalPage(page, 'S.selectedId')).toBe(ID(4));
  await expect(page.locator('#ctx-wrap .insp-title')).toHaveText('Case Study: Rebuilding the Hurghada Arrivals Store');
  await ctx.close();
});

test('list: the delay chip sits in the filter row', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await expect(page.locator('#filter-bar #delay-strip')).toBeVisible();
  await expect(page.locator('#delay-strip')).toContainText('Running +5 min · 2 affected · stops at #7');
  await expect(page.locator('#ds-reset-btn')).toBeVisible();
  await ctx.close();
});

test('list: a 140-character title and nine speakers stay inside the row', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { sessions: longTitleSessions() });
  const row = page.locator(`#card-${PANEL_ID}`);
  expect(Math.round((await row.boundingBox())!.height)).toBe(58);
  const rb = (await row.boundingBox())!;
  const ab = (await row.locator('.sc-act button').boundingBox())!;
  expect(ab.x + ab.width).toBeLessThanOrEqual(rb.x + rb.width);
  expect(await row.locator('.sc-title').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await ctx.close();
});

// Owner screenshot 9 Oct: "1 · rec · stream |". The note squeezed to a few pixels showed
// only the left edge of its icon. At every width, an item on the speaker line is either
// shown whole (the note: its icon and some text) or not shown at all.
test('list: the speaker line never shows a sliver of a flag or the note', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const bad: string[] = [];
  for (let w = 1000; w <= 1700; w += 6) {
    await page.setViewportSize({ width: w, height: 900 });
    bad.push(...await page.evaluate((w) => {
      const out: string[] = [];
      document.querySelectorAll('#sessions-list .sc-extra').forEach(box => {
        const b = box.getBoundingClientRect();
        for (const el of Array.from(box.children) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          const visW = Math.min(r.right, b.right) - Math.max(r.left, b.left);
          const visH = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
          if (visW <= 0 || visH <= 0) continue;                        // not shown at all
          const id = `${w}px ${box.closest('.sc')!.id} ${el.className} ${Math.round(visW)}x${Math.round(visH)}`;
          if (visH < r.height - 0.5) out.push(id + ' cut vertically');
          if (el.classList.contains('sc-notefirst')) { if (visW < 40) out.push(id + ' note squeezed'); }
          else if (visW < r.width - 0.5 || r.width < el.scrollWidth - 0.5) out.push(id + ' flag cut');
        }
      });
      return out;
    }, w));
  }
  expect(bad).toEqual([]);
  // With room, the flags and the note still show on the line.
  await page.setViewportSize({ width: 1920, height: 900 });
  const extra = page.locator(`#card-${PANEL_ID} .sc-extra`);
  const eb = (await extra.boundingBox())!;
  const nb = (await extra.locator('.sc-notefirst').boundingBox())!;
  expect(nb.y).toBeLessThan(eb.y + eb.height);
  expect(nb.width).toBeGreaterThan(100);
  await ctx.close();
});

test('list: type matches the approved demo (14 px semibold title, 12 px speaker line, 6 px between rows)', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const row = page.locator(`#card-${ID(6)}`);
  expect(await row.locator('.sc-title').evaluate(el => [getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight])).toEqual(['14px', '600']);
  expect(await row.locator('.sc-sub').evaluate(el => getComputedStyle(el).fontSize)).toBe('12px');
  await expect(row.locator('.sc-who')).toHaveText('Tarek Nassar · Gateline Digital');
  const a = (await page.locator(`#card-${ID(5)}`).boundingBox())!;
  const b = (await row.boundingBox())!;
  expect(Math.round(b.y - (a.y + a.height))).toBe(6);
  await ctx.close();
});

test('list: an armed Reset delays keeps its confirm label through the 1 s re-render', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const armedLabel = await evalPage(page, `t('confirm.confirmReset')`) as string;
  await page.locator('#ds-reset-btn').click();
  await expect(page.locator('#ds-reset-btn')).toHaveText(armedLabel);
  await page.clock.runFor(1500);                                                                     // a LIVE session re-renders every second
  await expect(page.locator('#ds-reset-btn')).toHaveText(armedLabel);
  await ctx.close();
});

// The harness jumps the paused clock 45 s at boot; the tick answers that with a
// clock resync and a snapshot reload. Let both land before a test runs the clock.
async function settleBootResync(page: import('@playwright/test').Page) {
  for (let i = 0; i < 20 && await evalPage(page, 'S.clockOffset') === 0; i++) await page.clock.runFor(250);
  await page.clock.runFor(500);
  await page.waitForTimeout(300);
  await evalPage(page, 'S.clockOffset = 0; renderSessions();');
}

test('list: keyboard focus stays on the inspector END through the 1 s re-render; Enter twice ends', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await settleBootResync(page);
  await evalPage(page, `window.__calls = []; window.transition = (id, to) => { window.__calls.push([id, to]); }; S.selectedId = '${PANEL_ID}'; renderSessions();`);
  const endSel = `#ctx-wrap .insp-primary button[onclick*="confirmEnd"]`;
  await page.locator(endSel).focus();
  await page.keyboard.press('Enter');                                                                // arms
  await expect(page.locator(endSel)).toHaveClass(/confirm-pending/);
  await page.clock.runFor(1500);                                                                     // at least one 1 s re-render
  expect(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), endSel)).toBe(true);
  await page.keyboard.press('Enter');                                                                // confirms
  expect(await evalPage(page, 'window.__calls')).toEqual([[PANEL_ID, 'ENDED']]);
  await ctx.close();
});

test('list: every interactive element the list and the inspector re-render carries a stable focus key', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `S.selectedId = '${PANEL_ID}'; S.foldOpen = { ENDED: true, CANCELLED: true }; renderSessions();`);
  const missing = await page.evaluate(() => [...document.querySelectorAll('#sessions-list button, #sessions-list input, #sessions-list [tabindex="0"], #ctx-wrap button, #ctx-wrap summary')]
    .filter(el => !el.hasAttribute('data-fk')).map(el => el.outerHTML.slice(0, 80)));
  expect(missing).toEqual([]);
  await ctx.close();
});

test('roles: a role-locked operator cannot switch role from the command palette; a director can', async ({ browser }) => {
  for (const [role, expected] of [['stage', 'stage'], ['director', 'director']] as const) {
    const { ctx, page } = await openConsole(browser, { role });
    await evalPage(page, `openCmdPalette(); renderPaletteResults('director');
      const i = (window._cmdResults || []).findIndex(r => r.label === 'Switch to DIRECTOR');
      if (i >= 0) executeCmdItem(i);
      setRole('director');`);
    expect(await evalPage(page, 'S.role')).toBe(expected);
    if (role === 'stage') expect(await evalPage(page, `(renderPaletteResults(''), (window._cmdResults || []).filter(r => r.cat === 'Roles').length)`)).toBe(0);
    await ctx.close();
  }
  // A director switches through the palette to another role.
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `openCmdPalette(); renderPaletteResults('stage'); executeCmdItem((window._cmdResults || []).findIndex(r => r.label === 'Switch to STAGE'));`);
  expect(await evalPage(page, 'S.role')).toBe('stage');
  await ctx.close();
});

// 5.2b (4), owner bug 7 Oct: "Peter Matza · Council Member, Association of Corporate Treasurers (ACT) ✓ arriv".
// The arrival state sits right after the name and never shrinks; the long remainder ellipsizes.
const LONG_CO = 'Council Member, Association of Corporate Treasurers (ACT) and Regional Policy Board';
function longCompanySessions() {
  return demoSessions().map(x =>
    x.id === ID(5) ? { ...x, speaker: 'Peter Matza', company: LONG_CO, speaker_arrived: true }
    : x.id === ID(4) ? { ...x, speaker: 'Peter Matza', company: LONG_CO, speaker_arrived: false }
    : x);
}
for (const locale of ['en', 'de'] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    test(`list: ${locale} ${viewport.width}: a long company never hides the arrival state`, async ({ browser }) => {
      expect(LONG_CO.length).toBeGreaterThanOrEqual(70);
      const { ctx, page } = await openConsole(browser, { locale, viewport, sessions: longCompanySessions() });
      for (const [id, marker, key] of [[ID(5), '.sc-arrived', 'cc.list.arrived'], [ID(4), '.sc-notarrived', 'cc.list.notArrived']] as const) {
        const row = page.locator(`#card-${id}`);
        const m = row.locator(`.sc-sub ${marker}`);
        await expect(m).toHaveText(await evalPage(page, `t('${key}')`) as string);
        const geo = await row.evaluate((el, sel) => {
          const r = (q: string) => el.querySelector(q)!.getBoundingClientRect();
          const mk = el.querySelector(`.sc-sub ${sel}`) as HTMLElement;
          const rest = el.querySelector('.sc-sub .sc-spk-rest') as HTMLElement;
          const name = el.querySelector('.sc-sub .sc-spk') as HTMLElement;
          return {
            markerWhole: mk.scrollWidth <= mk.clientWidth,
            markerRight: r(`.sc-sub ${sel}`).right, markerLeft: r(`.sc-sub ${sel}`).left,
            nameRight: name.getBoundingClientRect().right,
            subLeft: r('.sc-sub').left, subRight: r('.sc-sub').right,
            mainRight: r('.sc-main').right, chipLeft: r('.sc-room .chip').left,
            restEllipsis: getComputedStyle(rest).textOverflow === 'ellipsis' && rest.scrollWidth > rest.clientWidth,
            restTitle: rest.closest('[title]')?.getAttribute('title') || '',
            whoRight: r('.sc-sub .sc-who').right,
          };
        }, marker);
        expect(geo.markerWhole, `${id} marker clipped`).toBe(true);
        expect(geo.markerLeft).toBeGreaterThanOrEqual(geo.nameRight);   // right after the name
        expect(geo.markerRight).toBeLessThanOrEqual(geo.subRight);       // inside the title column, not cut by it
        expect(geo.subRight).toBeLessThanOrEqual(geo.mainRight);
        expect(geo.subRight).toBeLessThanOrEqual(geo.chipLeft);          // never runs into the room column
        expect(geo.whoRight).toBeLessThanOrEqual(geo.chipLeft);
        expect(geo.restEllipsis, `${id} remainder does not end in an ellipsis`).toBe(true);
        expect(geo.restTitle).toContain(LONG_CO);                        // the full text in its tooltip
      }
      await ctx.close();
    });
  }
}
