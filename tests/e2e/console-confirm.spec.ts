// tests/e2e/console-confirm.spec.ts
// End session and Cancel session use a two-step button. Their first click
// called t('confirm…') while a block-scoped `const t = setTimeout(…)` sat
// below it in the same block, so the click threw "Cannot access 't' before
// initialization" and nothing happened (found 2026-10-05: End session did
// nothing on a live event). No auth needed: these are page functions.
import { test, expect } from '@playwright/test';

const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:7230';

for (const [fn, name] of [['confirmEnd', 'End'], ['confirmCancel', 'Cancel']] as const) {
  test(`${name}: the first click arms the button without an error, the second click transitions`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE}/cuedeck-console.html`);
    const result = await page.evaluate(async (fnName) => {
      const w = window as any;
      const calls: string[][] = [];
      w.transition = (id: string, to: string) => { calls.push([id, to]); };
      const btn = document.createElement('button');
      btn.textContent = 'X';
      document.body.appendChild(btn);
      let threw = '';
      try { w[fnName]('s1', btn); } catch (e: any) { threw = e.message; }
      const armedText = btn.textContent;
      const armed = btn.classList.contains('confirm-pending');
      try { w[fnName]('s1', btn); } catch (e: any) { threw = threw || e.message; }
      return { threw, armedText, armed, calls };
    }, fn);
    expect(result.threw).toBe('');
    expect(result.armed).toBe(true);
    expect(result.armedText).not.toBe('X');
    expect(result.calls).toEqual([['s1', fn === 'confirmEnd' ? 'ENDED' : 'CANCELLED']]);
    expect(errors).toEqual([]);
  });
}
