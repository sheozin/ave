// tests/e2e/console-tokens.spec.ts
// Spec success criteria for lines and colour, measured in the running page.
import { test, expect } from '@playwright/test';
import { openConsole, borderContrast, textContrast, evalPage, PANEL_ID } from './console-boot-mock';

test('tokens: section dividers are at least 1.78:1 and control boundaries at least 3:1', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  // Spec measures the section border at 1.79:1 on --bg and 1.85 to 1.87 on bars and cards.
  expect(await borderContrast(page, '#header', 'bottom')).toBeGreaterThanOrEqual(1.78);
  expect(await borderContrast(page, '#filter-bar', 'bottom')).toBeGreaterThanOrEqual(1.78);
  expect(await borderContrast(page, `#card-${PANEL_ID}`, 'top')).toBeGreaterThanOrEqual(1.78);
  for (const sel of ['#fb-search', '#fb-status', '#bc-input', '#bc-pri']) {
    expect(await borderContrast(page, sel, 'top'), sel).toBeGreaterThanOrEqual(3);
  }
  await ctx.close();
});

// Every selector must exist: a missing element (-1) fails instead of being
// skipped. Tasks that remove one of these elements replace its selector with
// its successor in the same task (3.1: '#bc-bar .lbl', 4.2: '#ctx-sub').
const META_TEXT = [`#card-${PANEL_ID} .sc-num`, '#ctx-sub', '#fb-count', '#bc-bar .lbl'];
test('tokens: meta and label text is at least 4.5:1', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  for (const sel of META_TEXT) {
    expect(await textContrast(page, sel), sel).toBeGreaterThanOrEqual(4.5);
  }
  await ctx.close();
});

test('tokens: every control reached by Tab shows the focus ring', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      return { key: `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).slice(0, 30)}`, ring: getComputedStyle(el).boxShadow.includes('rgb(147, 197, 253)') };
    });
    if (!r) continue;
    seen.add(r.key);
    if (!r.ring) missing.push(r.key);
  }
  expect(seen.size).toBeGreaterThan(10);   // the walk really visited controls
  expect([...new Set(missing)]).toEqual([]);
  await ctx.close();
});

test('tokens: the timeline draws LIVE with the --st-live colour from CSS', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `document.documentElement.style.setProperty('--st-live', '#123456'); setViewMode('timeline');`);
  const fills = await page.locator('#timeline-wrap rect.tl-bar').evaluateAll(els => els.map(e => e.getAttribute('fill')));
  expect(fills).toContain('#123456');
  await ctx.close();
});

test('tokens: HOLD and LIVE badges do not animate, CALLING may', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const anim = (sel: string) => page.locator(sel).first().evaluate(el => getComputedStyle(el).animationName);
  expect(await anim('.badge-HOLD')).toBe('none');
  expect(await anim('.badge-LIVE')).toBe('none');
  await ctx.close();
});

test('type: no visible console text is smaller than 11 px', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  const tooSmall = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('svg, script, style, #stage-monitor, #loading-overlay')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const px = parseFloat(cs.fontSize);
      if (px < 11) out.push(`${el.tagName.toLowerCase()}.${el.className} ${px}px "${n.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  expect(tooSmall).toEqual([]);
  await ctx.close();
});

test('type: every timeline bar label stays inside its own bar', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  await evalPage(page, `setViewMode('timeline');`);
  const bad = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('#timeline-wrap rect.tl-bar')].map(r => r.getBoundingClientRect());
    const labels = [...document.querySelectorAll('#timeline-wrap text.tl-bar-label')] as SVGTextElement[];
    const out: string[] = [];
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    for (const t of labels) {
      const r = t.getBoundingClientRect();
      // The bar a label belongs to is the one that starts 5 px before it, in its row
      const own = bars.findIndex(b => Math.abs(r.left - (b.left + 5)) < 1.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5);
      if (own < 0) { out.push(`no bar: ${t.textContent}`); continue; }
      if (r.right > bars[own].right + 0.5) out.push(`overflow: ${t.textContent}`);
      bars.forEach((b, i) => { if (i !== own && hit(r, b)) out.push(`overlaps another bar: ${t.textContent}`); });
    }
    if (labels.length < 4) out.push(`only ${labels.length} labels drawn`);
    return out;
  });
  expect(bad).toEqual([]);
  await ctx.close();
});

test('type: the broadcast priority select fits its longest option', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser);
  // The three options are literal markup, not i18n keys, so every language shares one width.
  const fits = await page.evaluate(() => {
    const sel = document.getElementById('bc-pri') as HTMLSelectElement;
    const cs = getComputedStyle(sel);
    const c = document.createElement('canvas').getContext('2d')!;
    c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const longest = Math.max(...[...sel.options].map(o => c.measureText(o.text).width));
    return { longest, inner: sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
  });
  expect(fits.inner).toBeGreaterThanOrEqual(fits.longest);
  await ctx.close();
});
