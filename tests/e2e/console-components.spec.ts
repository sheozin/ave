// tests/e2e/console-components.spec.ts
// Component spec (section 3): sizes, variants, badge recipe, chip, label,
// pill, and that every icon reference resolves to a sprite symbol.
import { test, expect, type Page } from '@playwright/test';
import { openConsole, evalPage, PANEL_ID } from './console-boot-mock';

async function mount(page: Page, html: string) {
  await page.evaluate((h) => { const d = document.createElement('div'); d.id = 'cmp-probe'; d.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;display:flex;gap:8px;padding:8px;background:var(--bg)'; d.innerHTML = h; document.body.append(d); }, html);
}
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate(el => {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  return { h: Math.round(r.height), radius: cs.borderTopLeftRadius, size: cs.fontSize, weight: cs.fontWeight, tt: cs.textTransform, filter: cs.filter, anim: cs.animationName, bg: cs.backgroundColor, border: cs.borderTopColor };
});

test('components: button sizes and variants', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await mount(page, `<button class="btn sm" id="b-sm">Sm</button><button class="btn md" id="b-md">Md</button><button class="btn lg" id="b-lg">Lg</button>
    <button class="btn md danger" id="b-dg">End…</button><button class="btn md hold" id="b-hd">Hold</button><button class="btn md fwd fwd-ready" id="b-fw">Set ready</button>
    <button class="btn md fwd fwd-go" id="b-go">On stage</button><button class="btn md fwd fwd-calling" id="b-cl">Call speaker</button><button class="btn md danger confirm-pending" id="b-ar">Press again to end</button>`);
  expect((await box(page, '#b-sm')).h).toBe(28);
  expect((await box(page, '#b-md')).h).toBe(32);
  expect((await box(page, '#b-lg')).h).toBe(40);
  expect((await box(page, '#b-md')).radius).toBe('8px');
  const dg = await box(page, '#b-dg');
  expect(dg.bg).toBe('rgba(0, 0, 0, 0)');          // danger is outlined
  expect(dg.border).toBe('rgba(239, 68, 68, 0.75)');
  expect((await box(page, '#b-hd')).bg).toBe('rgb(251, 146, 60)');
  expect((await box(page, '#b-fw')).bg).toBe('rgb(52, 211, 153)');
  expect((await box(page, '#b-go')).bg).toBe('rgb(52, 211, 153)');   // On stage is green, never red
  expect((await box(page, '#b-cl')).bg).toBe('rgb(250, 204, 21)');
  expect((await box(page, '#b-ar')).bg).toBe('rgb(239, 68, 68)');    // solid red only when armed
  await page.hover('#b-md');
  expect((await box(page, '#b-md')).filter).toBe('none');  // no brightness filter on hover
  await ctx.close();
});

test('components: buttons grow on a coarse pointer', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { touch: true, viewport: { width: 1280, height: 800 } });
  await mount(page, `<button class="btn sm" id="b-sm">Sm</button><button class="btn md" id="b-md">Md</button><button class="btn lg" id="b-lg">Lg</button>`);
  expect((await box(page, '#b-sm')).h).toBe(40);
  expect((await box(page, '#b-md')).h).toBe(44);
  expect((await box(page, '#b-lg')).h).toBe(48);
  await ctx.close();
});

test('components: badge recipe per status', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await mount(page, await page.evaluate(() => ['PLANNED', 'READY', 'CALLING', 'LIVE', 'OVERRUN', 'HOLD', 'ENDED', 'CANCELLED'].map(s => (0, eval)(`statusBadge('${s}')`)).join('')));
  const live = await box(page, '#cmp-probe .badge-LIVE');
  expect(live.h).toBe(22);
  expect(live.radius).toBe('6px');
  expect(live.size).toBe('11px');
  expect(live.weight).toBe('700');
  expect(live.tt).toBe('uppercase');
  expect(await page.locator('#cmp-probe .badge-LIVE').evaluate(el => getComputedStyle(el, '::before').content)).toBe('""');
  expect(await page.locator('#cmp-probe .badge-HOLD use').getAttribute('href')).toBe('#i-pause');
  expect((await box(page, '#cmp-probe .badge-HOLD')).anim).toBe('none');
  expect((await box(page, '#cmp-probe .badge-CALLING')).anim).toBe('badge-ring');
  expect(await page.locator('#cmp-probe .badge-CANCELLED').evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('line-through');
  await ctx.close();
});

test('components: chip, section label and pill', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await mount(page, await page.evaluate(() => (0, eval)(`chipHTML('room','Main Stage') + chipHTML('type','Panel')`)) + '<span class="lbl" id="l1">Event log</span><span class="pill is-ok" id="p1"><span class="dot"></span>All systems</span>');
  const chip = await box(page, '#cmp-probe .chip-room');
  expect(chip.h).toBe(22);
  expect(chip.radius).toBe('4px');
  expect(await page.locator('#cmp-probe .chip-room use').getAttribute('href')).toBe('#i-room');
  expect(await page.locator('#cmp-probe .chip-type use').getAttribute('href')).toBe('#i-tag');
  const lbl = await box(page, '#l1');
  expect([lbl.size, lbl.weight, lbl.tt]).toEqual(['11px', '700', 'uppercase']);
  expect((await box(page, '#p1')).radius).toBe('999px');
  await ctx.close();
});

test('components: every icon reference resolves to a sprite symbol', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const refs = await page.evaluate(() => [...document.querySelectorAll('use')]
    .map(u => u.getAttribute('href') || '').filter(h => h.startsWith('#i-')));
  expect(refs.length).toBeGreaterThan(0);   // an empty page would pass vacuously
  const missing = await page.evaluate((r) => r.filter(h => !document.querySelector(h)), refs);
  expect(missing).toEqual([]);
  await ctx.close();
});

test('components: HOLD sits left of END, END is outlined and separated', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const html = await evalPage(page, `buildButtons(S.sessions.find(x => x.id === '${PANEL_ID}'))`);
  const order = await page.evaluate((h) => { const d = document.createElement('div'); d.innerHTML = h as string;
    return [...d.querySelectorAll('button, .act-gap')].map(b => b.classList.contains('act-gap') ? 'gap' : (b.classList.contains('hold') ? 'hold' : b.classList.contains('danger') ? 'end' : 'other')); }, html);
  expect(order.slice(0, 3)).toEqual(['hold', 'gap', 'end']);
  await ctx.close();
});
