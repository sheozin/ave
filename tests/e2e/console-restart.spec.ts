// tests/e2e/console-restart.spec.ts
// The Restart button on a session card: shown only once a session has
// started, asks in the console's own modal, and on confirm calls
// restart-session with the session id and version. No auth: the director
// state is injected and every Edge Function call is intercepted.
import { test, expect, type Page } from '@playwright/test';

// CONSOLE_BASE points the spec at another server when 7230 serves a different checkout.
const BASE = process.env.CONSOLE_BASE ?? 'http://127.0.0.1:7230';
const STARTED = '11111111-1111-4111-8111-111111111111';
const PLANNED = '22222222-2222-4222-8222-222222222222';
const ENDED = '33333333-3333-4333-8333-333333333333';

// Direct table writes (the undo path). patchRows is what a PATCH returns:
// [] means the version guard matched nothing.
let rest: { method: string; url: string; body: any }[] = [];
let patchRows: unknown[] | null = null;

async function setup(page: Page, role = 'director') {
  const calls: { fn: string; body: any }[] = [];
  rest = [];
  patchRows = null;
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    rest.push({ method: req.method(), url: req.url(), body: req.postDataJSON?.() ?? null });
    const body = req.method() === 'PATCH' && patchRows ? patchRows : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/functions/v1/**', async route => {
    const fn = new URL(route.request().url()).pathname.split('/').pop()!;
    calls.push({ fn, body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'READY', version: 6 }) });
  });
  page.on('dialog', d => { throw new Error('native dialog opened: ' + d.message()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  });
  await page.evaluate(([role, a, b, c]) => {
    // S is a top-level const in the page script, reachable through indirect eval.
    (0, eval)(`
      S.userRole = ${JSON.stringify(role)};
      S.role     = ${JSON.stringify(role)};
      S.viewMode = 'list';
      S.event    = { id: 'ev-1', name: 'Test Event' };
      S.sessions = [
        { id: '${a}', event_id: 'ev-1', sort_order: 1, title: "Chair's opening remarks", status: 'READY', version: 5,
          actual_start: '2026-10-05T10:28:00Z', actual_end: null,
          scheduled_start: '10:30', scheduled_end: '10:45', planned_start: '10:30', planned_end: '10:45' },
        { id: '${b}', event_id: 'ev-1', sort_order: 2, title: 'Keynote', status: 'PLANNED', version: 1,
          actual_start: null, actual_end: null,
          scheduled_start: '11:00', scheduled_end: '11:30', planned_start: '11:00', planned_end: '11:30' },
        { id: '${c}', event_id: 'ev-1', sort_order: 3, title: 'Panel', status: 'ENDED', version: 9,
          actual_start: '2026-10-05T09:00:00Z', actual_end: '2026-10-05T09:40:00Z',
          scheduled_start: '09:00', scheduled_end: '09:40', planned_start: '09:00', planned_end: '09:40' },
      ];
      renderSessions();
    `);
  }, [role, STARTED, PLANNED, ENDED]);
  return calls;
}

// Restart sits in the inspector's More menu for the selected session (stage 4).
const restartBtn = (page: Page, _id: string) => page.locator('#ctx-wrap [data-restart]');
async function openControls(page: Page, id: string) {
  await page.evaluate((sid) => (0, eval)(`S.inspMoreOpen = true; S.selectedId = '${sid}'; renderSessions();`), id);
}

test('the Restart button shows on started sessions and not on a planned one', async ({ page }) => {
  await setup(page);
  const shown = page.locator('#ctx-wrap .insp-title');   // the inspector shows the intended session
  await openControls(page, STARTED);
  await expect(shown).toHaveText("Chair's opening remarks");
  await expect(restartBtn(page, STARTED)).toBeVisible();
  await openControls(page, ENDED);
  await expect(shown).toHaveText('Panel');
  await expect(restartBtn(page, ENDED)).toBeVisible();
  await openControls(page, PLANNED);
  await expect(shown).toHaveText('Keynote');
  await expect(restartBtn(page, PLANNED)).toHaveCount(0);
});

test('a role that cannot set READY gets no Restart button', async ({ page }) => {
  await setup(page, 'av');
  await openControls(page, STARTED);
  await expect(page.locator('[data-restart]')).toHaveCount(0);
});

test('confirm calls restart-session with the session id and version', async ({ page }) => {
  const calls = await setup(page);
  await openControls(page, STARTED);
  await restartBtn(page, STARTED).click();
  const modal = page.locator('#restart-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Restart this session?');
  await expect(modal).toContainText('It goes back to READY and its timer starts again from the full length when you go live.');
  const sent = page.waitForRequest(r => r.url().includes('/functions/v1/restart-session'));
  await page.locator('#restart-modal-yes').click();
  await sent;
  await expect(modal).toBeHidden();
  const restart = calls.filter(c => c.fn === 'restart-session');
  expect(restart).toHaveLength(1);
  expect(restart[0].body).toMatchObject({ session_id: STARTED, version: 5, operator_role: 'director' });
  expect(typeof restart[0].body.command_id).toBe('string');
  // The card reflects the restart: no actual_start, so no Restart button.
  await expect(restartBtn(page, STARTED)).toHaveCount(0);
});

test('cancel closes the modal and calls nothing', async ({ page }) => {
  const calls = await setup(page);
  await openControls(page, ENDED);
  await restartBtn(page, ENDED).click();
  await expect(page.locator('#restart-modal')).toBeVisible();
  await page.locator('#restart-modal-no').click();
  await expect(page.locator('#restart-modal')).toBeHidden();
  await page.waitForTimeout(300);
  expect(calls.filter(c => c.fn === 'restart-session')).toEqual([]);
});

test('Escape closes the modal and calls nothing', async ({ page }) => {
  const calls = await setup(page);
  await openControls(page, ENDED);
  await restartBtn(page, ENDED).click();
  await expect(page.locator('#restart-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#restart-modal')).toBeHidden();
  await page.waitForTimeout(300);
  expect(calls.filter(c => c.fn === 'restart-session')).toEqual([]);
});

const toasts = (page: Page) => page.locator('#toast-container');
const evalPage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);

test('I1: a restarted session is not auto-started again in its start minute', async ({ page }) => {
  const calls = await setup(page);
  // Keep clear of a minute boundary so the start minute holds for the whole test.
  const sec = await page.evaluate(() => new Date().getSeconds());
  if (sec >= 50) await page.waitForTimeout((61 - sec) * 1000);
  await evalPage(page, `
    const s = S.sessions.find(x => x.id === '${PLANNED}');
    const d = new Date(correctedNow());
    s.status = 'READY';
    s.planned_start = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    S.autoStart = true;
    renderSessions();
    checkAutoStart();
  `);
  await expect.poll(() => calls.filter(c => c.fn === 'go-live').length).toBe(1);
  await openControls(page, PLANNED);
  await expect(restartBtn(page, PLANNED)).toBeVisible();
  await restartBtn(page, PLANNED).click();
  await page.locator('#restart-modal-yes').click();
  await expect.poll(() => calls.filter(c => c.fn === 'restart-session').length).toBe(1);
  await evalPage(page, `checkAutoStart();`);
  await page.waitForTimeout(1500); // the 1s tick runs checkAutoStart too
  expect(calls.filter(c => c.fn === 'go-live')).toHaveLength(1);
});

test('I2: END, then RESTART, and the undo bar is gone', async ({ page }) => {
  const calls = await setup(page);
  await evalPage(page, `
    const s = S.sessions.find(x => x.id === '${STARTED}');
    s.status = 'LIVE'; renderSessions();
    transition('${STARTED}', 'ENDED');
  `);
  await expect(page.locator('#undo-bar')).toBeVisible();
  await openControls(page, STARTED);
  await restartBtn(page, STARTED).click();
  await page.locator('#restart-modal-yes').click();
  await expect.poll(() => calls.filter(c => c.fn === 'restart-session').length).toBe(1);
  await expect(page.locator('#undo-bar')).toBeHidden();
  // Even if the bar were clicked through, undo must not write.
  await evalPage(page, `executeUndo();`);
  await page.waitForTimeout(300);
  expect(rest.filter(r => r.method === 'PATCH')).toEqual([]);
});

test('I2: undo on a session that changed since says nothing to undo and writes nothing', async ({ page }) => {
  await setup(page);
  await evalPage(page, `
    const s = S.sessions.find(x => x.id === '${STARTED}');
    s.status = 'LIVE'; renderSessions();
    transition('${STARTED}', 'ENDED');
  `);
  await expect(page.locator('#undo-bar')).toBeVisible();
  // Realtime: someone else moved it on.
  await evalPage(page, `S.sessions.find(x => x.id === '${STARTED}').status = 'READY';`);
  await page.locator('#undo-btn').click();
  await expect(toasts(page)).toContainText('Nothing to undo');
  expect(rest.filter(r => r.method === 'PATCH')).toEqual([]);
});

test('I2: undo is version-guarded and a lost race reloads instead of claiming success', async ({ page }) => {
  await setup(page);
  await evalPage(page, `
    const s = S.sessions.find(x => x.id === '${STARTED}');
    s.status = 'LIVE'; renderSessions();
    transition('${STARTED}', 'ENDED');
  `);
  await expect(page.locator('#undo-bar')).toBeVisible();
  const ver = await evalPage(page, `S.sessions.find(x => x.id === '${STARTED}').version`);
  patchRows = []; // nothing matched the version
  await page.locator('#undo-btn').click();
  await expect(toasts(page)).toContainText('Updated by another operator');
  const patch = rest.filter(r => r.method === 'PATCH');
  expect(patch).toHaveLength(1);
  expect(patch[0].url).toContain('version=eq.' + ver);
  expect(patch[0].body).toMatchObject({ version: (ver as number) + 1 });
  await expect(toasts(page)).not.toContainText('Reverted');
});

test('I3: the session changes while the modal is open, so confirm restarts nothing', async ({ page }) => {
  const calls = await setup(page);
  await openControls(page, ENDED);
  await restartBtn(page, ENDED).click();
  await expect(page.locator('#restart-modal')).toBeVisible();
  await evalPage(page, `
    const s = S.sessions.find(x => x.id === '${ENDED}');
    s.status = 'READY'; s.version = 10; s.actual_end = null;
  `);
  await page.locator('#restart-modal-yes').click();
  await expect(page.locator('#restart-modal')).toBeHidden();
  await expect(toasts(page)).toContainText('changed while');
  await page.waitForTimeout(300);
  expect(calls.filter(c => c.fn === 'restart-session')).toEqual([]);
});

test('I3: confirm sends the version seen when the modal opened', async ({ page }) => {
  const calls = await setup(page);
  await openControls(page, ENDED);
  await restartBtn(page, ENDED).click();
  await evalPage(page, `S.sessions.find(x => x.id === '${ENDED}').version = 10;`);
  await page.locator('#restart-modal-yes').click();
  await expect.poll(() => calls.filter(c => c.fn === 'restart-session').length).toBe(1);
  expect(calls.find(c => c.fn === 'restart-session')!.body.version).toBe(9);
});

for (const [code, text] of [['NOT_RESTARTABLE', 'has not started'], ['Version conflict', 'Updated by another operator']] as const) {
  test(`M2: ${code} shows a sentence, not the code`, async ({ page }) => {
    await setup(page);
    // Registered after setup's catch-all, so it runs first.
    await page.route('**/functions/v1/restart-session', r => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: code }) }));
    await openControls(page, ENDED);
    await restartBtn(page, ENDED).click();
    await page.locator('#restart-modal-yes').click();
    await expect(toasts(page)).toContainText(text);
    await expect(toasts(page)).not.toContainText(code);
  });
}

test('I2: undo still works on an unchanged ENDED session', async ({ page }) => {
  await setup(page);
  await evalPage(page, `
    const s = S.sessions.find(x => x.id === '${STARTED}');
    s.status = 'LIVE'; renderSessions();
    transition('${STARTED}', 'ENDED');
  `);
  await expect(page.locator('#undo-bar')).toBeVisible();
  patchRows = [{ id: STARTED }];
  await page.locator('#undo-btn').click();
  await expect(toasts(page)).toContainText('Reverted to LIVE');
  const s = await evalPage(page, `JSON.stringify(S.sessions.find(x => x.id === '${STARTED}'))`);
  expect(JSON.parse(s as string)).toMatchObject({ status: 'LIVE', actual_end: null, version: 6 });
});

// 5.2b (5): the status in the undo toast is translated, as every other status word.
test('I2b: the undo toast names the status in the page language', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cuedeck_locale', 'pl'));
  await setup(page);
  await evalPage(page, `
    const s = S.sessions.find(x => x.id === '${STARTED}');
    s.status = 'LIVE'; renderSessions();
    transition('${STARTED}', 'ENDED');
  `);
  await expect(page.locator('#undo-bar')).toBeVisible();
  patchRows = [{ id: STARTED }];
  await page.locator('#undo-btn').click();
  const want = await evalPage(page, `t('toast.reverted') + ' ' + t('status.LIVE')`) as string;
  expect(want).toBe('Przywrócono do NA ŻYWO');
  await expect(toasts(page)).toContainText(want);
});
