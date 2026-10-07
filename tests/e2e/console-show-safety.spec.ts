// tests/e2e/console-show-safety.spec.ts
// Show-safety fixes found by the live-show operations audit (2026-10-06):
// the END/CANCEL confirm surviving the 1 s re-render, HOLD before END on
// OVERRUN, the stage monitor, event log times, the event time zone, delayed
// card colours, the HOLD badge, reduced motion and speaker arrival errors.
// No auth: state is injected into the page and every network call is answered
// here. The browser runs in UTC with a fixed clock.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.CONSOLE_BASE ?? 'http://127.0.0.1:7230';
const T0 = Date.parse('2026-10-06T11:40:00Z');
const iso = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

test.use({ timezoneId: 'UTC' });

type Sess = Record<string, unknown>;
function sess(id: string, sort: number, o: Sess): Sess {
  return {
    id, event_id: 'ev-1', sort_order: sort, title: id, status: 'PLANNED', version: 1, room: null,
    speaker: null, actual_start: null, actual_end: null, delay_minutes: 0, cumulative_delay: 0,
    planned_start: '11:00:00', planned_end: '11:30:00', scheduled_start: '11:00:00', scheduled_end: '11:30:00', ...o,
  };
}

async function setup(page: Page, sessions: Sess[], opts: { role?: string; event?: Sess } = {}) {
  await page.clock.install({ time: T0 });
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/functions/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  page.on('dialog', d => { throw new Error('native dialog opened: ' + d.message()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate(([sessions, role, event]) => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
    const St = (0, eval)('S');
    St.role = role; St.userRole = role;
    St.viewMode = 'list';
    St.event = event;
    St.sessions = sessions;
    (window as any).__calls = [];
    (window as any).transition = (id: string, to: string) => { (window as any).__calls.push([id, to]); };
    (window as any).renderSessions();
  }, [sessions, opts.role ?? 'director', opts.event ?? { id: 'ev-1', name: 'GTR North Africa 2026', timezone: 'UTC' }] as const);
}
const calls = (page: Page) => page.evaluate(() => (window as any).__calls);
const live = (o: Sess = {}) => sess('live1', 1, { status: 'LIVE', actual_start: iso(-5), title: 'Opening', ...o });
// Where a session's controls sit. Stage 4: the inspector shows the selected
// session with every control (5.2b: every section, no More menu). The assertions do not change.
async function controls(page: Page, id: string) {
  await page.evaluate((sid) => { const St = (0, eval)('S'); St.selectedId = sid; (window as any).renderSessions(); }, id);
  return page.locator('#ctx-wrap #ctx-actions');
}
// Labels as those controls render them (cc.act.* and the new confirm.* values).
const L = { end: 'End…', armedEnd: 'Press again to end', cancel: 'Cancel session', armedCancel: 'Press again to cancel', hold: 'Hold', endAll: 'End all' };

// ── 1. END / CANCEL confirm survives the 1 s re-render ────────────────────
test.describe('END and CANCEL confirm', () => {
  test('armed END on a live card keeps its confirm label through several ticks, then ends on the second click', async ({ page }) => {
    await setup(page, [live()]);
    const ctl = await controls(page, 'live1');
    await ctl.locator('button', { hasText: L.end }).click();
    await page.clock.runFor(1500);
    const armed = ctl.locator('button.confirm-pending');
    await expect(armed).toHaveText(L.armedEnd);
    await armed.click();
    expect(await calls(page)).toEqual([['live1', 'ENDED']]);
  });

  test('an END armed on LIVE is dropped when the session moves to HOLD; one press then does not end it', async ({ page }) => {
    await setup(page, [live({ version: 3 })]);
    const ctl = await controls(page, 'live1');
    await ctl.locator('button', { hasText: L.end }).click();
    await expect(ctl.locator('.confirm-pending')).toHaveCount(1);
    await page.evaluate(() => {
      const St = (0, eval)('S');
      const row = { ...St.sessions[0], status: 'HOLD', version: 4 };
      (window as any).onSessionChange({ eventType: 'UPDATE', new: row, old: {} });
    });
    // Checked at once: the 3 s arm timeout must not be what clears it. Nothing on the page stays armed.
    expect(await page.locator('.confirm-pending').count()).toBe(0);
    await ctl.locator('button', { hasText: L.end }).click();
    expect(await calls(page)).toEqual([]);
    await expect(ctl.locator('button.confirm-pending')).toHaveText(L.armedEnd);
  });

  test('an END armed just before the end time still confirms after LIVE flips to OVERRUN', async ({ page }) => {
    await setup(page, [live({ version: 3 })]);
    const ctl = await controls(page, 'live1');
    const endBtn = ctl.locator('button', { hasText: new RegExp(`${L.end}|${L.armedEnd}`) });
    await endBtn.click();
    await page.evaluate(() => {
      const St = (0, eval)('S');
      (window as any).onSessionChange({ eventType: 'UPDATE', new: { ...St.sessions[0], status: 'OVERRUN', version: 4 }, old: {} });
    });
    await expect(endBtn).toHaveText(L.armedEnd);
    await endBtn.click();
    expect(await calls(page)).toEqual([['live1', 'ENDED']]);
  });

  test('an END arm does not come back after LIVE to HOLD to LIVE; one press only arms', async ({ page }) => {
    await setup(page, [live({ version: 3 })]);
    const ctl = await controls(page, 'live1');
    await ctl.locator('button', { hasText: L.end }).click();
    await page.evaluate(() => {
      const St = (0, eval)('S');
      const w = window as any;
      w.onSessionChange({ eventType: 'UPDATE', new: { ...St.sessions[0], status: 'HOLD', version: 4 }, old: {} });
      w.onSessionChange({ eventType: 'UPDATE', new: { ...St.sessions[0], status: 'LIVE', version: 5 }, old: {} });
    });
    expect(await page.locator('.confirm-pending').count()).toBe(0);
    await expect(ctl.locator('button', { hasText: L.end })).toHaveCount(1);
    await ctl.locator('button', { hasText: L.end }).click();
    expect(await calls(page)).toEqual([]);
    await expect(ctl.locator('button.confirm-pending')).toHaveText(L.armedEnd);
  });

  test('an armed CANCEL holds for 3 s like END', async ({ page }) => {
    await setup(page, [sess('ready1', 1, { status: 'READY' })]);
    const ctl = await controls(page, 'ready1');
    await ctl.locator('button', { hasText: L.cancel }).click();
    await page.clock.runFor(2500);
    const armed = ctl.locator('button.confirm-pending');
    expect(await armed.count()).toBe(1);
    await armed.click();
    expect(await calls(page)).toEqual([['ready1', 'CANCELLED']]);
  });

  test('armed END returns to its normal label after the timeout', async ({ page }) => {
    await setup(page, [live()]);
    const ctl = await controls(page, 'live1');
    await ctl.locator('button', { hasText: L.end }).click();
    await page.clock.runFor(3500);
    await expect(page.locator('.confirm-pending')).toHaveCount(0);
    await expect(ctl.locator('button', { hasText: L.end })).toHaveCount(1);
    expect(await calls(page)).toEqual([]);
  });

  test('armed CANCEL on a ready card survives the re-render caused by a live session', async ({ page }) => {
    await setup(page, [live(), sess('ready1', 2, { status: 'READY' })]);
    const ctl = await controls(page, 'ready1');
    await ctl.locator('button', { hasText: L.cancel }).click();
    await page.clock.runFor(1500);
    const armed = ctl.locator('button.confirm-pending');
    await expect(armed).toHaveText(L.armedCancel);
    await armed.click();
    expect(await calls(page)).toEqual([['ready1', 'CANCELLED']]);
  });

  test('the band End stays armed through several ticks', async ({ page }) => {
    await setup(page, [live()]);
    await page.locator('#band .lane-now .btn.danger').click();
    await page.clock.runFor(1500);
    const armed = page.locator('#band .lane-now .btn.confirm-pending');
    await expect(armed).toHaveText(L.armedEnd);
    await armed.click();
    expect(await calls(page)).toEqual([['live1', 'ENDED']]);
  });

  test('the End in a live row stays armed through several ticks', async ({ page }) => {
    await setup(page, [live()]);
    await page.locator('#card-live1 .sc-act .btn.danger').click();
    await page.clock.runFor(1500);
    const armed = page.locator('#card-live1 .sc-act .btn.confirm-pending');
    await expect(armed).toHaveText(L.armedEnd);
    await armed.click();
    expect(await calls(page)).toEqual([['live1', 'ENDED']]);
  });

  test('the batch END ALL button shows a visible armed state', async ({ page }) => {
    await setup(page, [live(), sess('p2', 2, { status: 'PLANNED' })]);
    await page.locator('#card-live1').hover();          // editing tools show on hover (spec 2.2)
    await page.locator('#card-live1 .batch-chk').check();
    const btn = page.locator('#batch-bar [data-batch="ENDED"]');
    await btn.click();
    await expect(btn).toHaveClass(/confirm-pending/);
    await expect(btn).toHaveText(L.armedEnd);
    await page.clock.runFor(3500);
    await expect(btn).not.toHaveClass(/confirm-pending/);
    await expect(btn).toHaveText(L.endAll);
  });
});

// ── Batch selection and event switches ─────────────────────────────────
test.describe('batch actions', () => {
  test('a batch only counts sessions that exist in the current event', async ({ page }) => {
    await setup(page, [live(), sess('p2', 2, { status: 'PLANNED' })]);
    await page.locator('#card-live1').hover();
    await page.locator('#card-live1 .batch-chk').check();
    await page.evaluate(() => (window as any).toggleBatchSelect('ghost-from-another-event', true));
    const btn = page.locator('#batch-bar [data-batch="ENDED"]');
    await btn.click();
    await btn.click();
    await expect.poll(() => calls(page)).toEqual([['live1', 'ENDED']]);
    // One of one succeeded, read in the page's own words (5.2b: no English left in the toast).
    const want = await page.evaluate(() => (0, eval)(`tf('cc.batch.result', { status: t('status.ENDED'), done: 1, n: 1 })`));
    expect(want).toContain('1/1');
    await expect(page.locator('#toast-container')).toContainText(want);
  });

  test('the batch result toast is in the page language', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cuedeck_locale', 'pl'));
    await setup(page, [live(), sess('p2', 2, { status: 'PLANNED' })]);
    await page.locator('#card-live1').hover();
    await page.locator('#card-live1 .batch-chk').check();
    const btn = page.locator('#batch-bar [data-batch="ENDED"]');
    await btn.click();
    await btn.click();
    await expect.poll(() => calls(page)).toEqual([['live1', 'ENDED']]);
    await expect(page.locator('#toast-container')).toContainText('ZAKOŃCZONE: 1/1 sesji');
    await expect(page.locator('#toast-container')).not.toContainText('sessions');
  });

  test('switching event clears the batch selection and its armed button', async ({ page }) => {
    await setup(page, [live(), sess('p2', 2, { status: 'PLANNED' })]);
    await page.evaluate(() => { (0, eval)('S').events = [{ id: 'ev-1', name: 'One' }, { id: 'ev-2', name: 'Two', timezone: 'UTC' }]; });
    await page.locator('#card-live1').hover();
    await page.locator('#card-live1 .batch-chk').check();
    const btn = page.locator('#batch-bar [data-batch="ENDED"]');
    await btn.click();
    await expect(btn).toHaveClass(/confirm-pending/);
    await page.evaluate(() => (window as any).switchEvent('ev-2'));
    await expect(page.locator('#batch-bar')).toBeHidden();
    await expect(btn).not.toHaveClass(/confirm-pending/);
    await expect(btn).toHaveText(L.endAll);
    // Selecting in the new event and pressing once only arms again.
    await page.evaluate(() => {
      const St = (0, eval)('S');
      St.sessions = [{ ...St.sessions[0], id: 'n1', event_id: 'ev-2', status: 'LIVE' }];
      (window as any).renderSessions();
    });
    await page.locator('#card-n1').hover();
    await page.locator('#card-n1 .batch-chk').check();
    await btn.click();
    expect(await calls(page)).toEqual([]);
  });
});

// ── 2. HOLD before END in LIVE and OVERRUN ────────────────────────────────
for (const status of ['LIVE', 'OVERRUN']) {
  test(`${status}: HOLD comes before END in the band and in the inspector`, async ({ page }) => {
    await setup(page, [live({ status })]);
    const order = (sel: string) => page.locator(sel).evaluate(el => [...el.children].map(c =>
      c.classList.contains('act-gap') ? 'gap' : (c.textContent || '').trim()));
    expect(await order('#band .lane .lane-now .lane-ctrl')).toEqual([L.hold, 'gap', L.end]);
    expect(await order('#ctx-wrap .insp-primary')).toEqual([L.hold, 'gap', L.end]);
  });
}

// ── Inspector "most urgent session": urgency order, controls act on it ──
test.describe('sidebar active session', () => {
  test('the only active session is on HOLD: the panel shows it and Resume/End target it', async ({ page }) => {
    await setup(page, [
      sess('done', 1, { status: 'ENDED', title: 'Keynote', actual_start: iso(-60), actual_end: iso(-20) }),
      sess('held', 2, { status: 'HOLD', title: 'Workshop', actual_start: iso(-10) }),
      sess('later', 3, { status: 'PLANNED', title: 'Case study' }),
    ]);
    await expect(page.locator('#ctx-wrap .insp-title')).toHaveText('Workshop');
    await page.locator('#ctx-wrap .insp-primary button', { hasText: 'Resume' }).click();
    await page.locator('#ctx-wrap .insp-primary .btn.danger').click();
    await page.locator('#ctx-wrap .insp-primary .btn.confirm-pending').click();
    expect(await calls(page)).toEqual([['held', 'LIVE'], ['held', 'ENDED']]);
  });

  test('HOLD plus a READY session: the HOLD one is shown', async ({ page }) => {
    await setup(page, [
      sess('ready', 1, { status: 'READY', title: 'Pricing talk' }),
      sess('held', 2, { status: 'HOLD', title: 'Workshop', actual_start: iso(-10) }),
    ]);
    await expect(page.locator('#ctx-wrap .insp-title')).toHaveText('Workshop');
    await expect(page.locator('#ctx-wrap .insp-primary button').first()).toHaveText('Resume');
  });

  test('OVERRUN outranks LIVE, which outranks HOLD', async ({ page }) => {
    await setup(page, [
      sess('held', 1, { status: 'HOLD', title: 'Held' }),
      live({ title: 'Live' }),
      sess('over', 3, { status: 'OVERRUN', title: 'Over', actual_start: iso(-40) }),
    ]);
    await expect(page.locator('#ctx-wrap .insp-title')).toHaveText('Over');
  });
});

// ── 5. Stage monitor ─────────────────────────────────────────────────────
async function monitor(page: Page) {
  await page.evaluate(() => (window as any).openStageMonitor());
  return page.evaluate(() => ({
    status: document.getElementById('sm-status')!.textContent,
    title: document.getElementById('sm-title')!.textContent,
    timer: document.getElementById('sm-timer')!.textContent,
    label: document.getElementById('sm-timer-lbl')!.textContent,
    next: document.getElementById('sm-next-title')!.textContent,
    event: document.getElementById('sm-event-name')!.textContent,
    timerColor: getComputedStyle(document.getElementById('sm-timer')!).color,
  }));
}

test.describe('stage monitor', () => {
  test('a held session stays on the monitor as PLEASE HOLD, not the next session', async ({ page }) => {
    await setup(page, [
      sess('held', 1, { status: 'HOLD', title: 'Workshop', room: 'Hall B', actual_start: iso(-10) }),
      sess('after', 2, { status: 'PLANNED', title: 'Case study', room: 'Hall B' }),
      sess('other', 3, { status: 'READY', title: 'Pricing talk', room: 'Main Stage' }),
    ]);
    const m = await monitor(page);
    expect(m.title).toBe('Workshop');
    expect(m.status).toContain('PLEASE HOLD');
    expect(m.label).toBe('PAUSED');
    expect(m.next).toBe('Case study');
    // The timer is paused: it does not move while held.
    await page.clock.runFor(5000);
    expect((await monitor(page)).timer).toBe(m.timer);
  });

  test('next session is the next one in the same room', async ({ page }) => {
    await setup(page, [
      live({ room: 'Main Stage', title: 'Panel' }),
      sess('hallb', 2, { status: 'PLANNED', title: 'Hall B talk', room: 'Hall B' }),
      sess('main2', 3, { status: 'PLANNED', title: 'Main Stage talk', room: 'Main Stage' }),
    ]);
    expect((await monitor(page)).next).toBe('Main Stage talk');
  });

  test('overrun shows a plus sign, the OVERRUN label and the magenta colour', async ({ page }) => {
    await setup(page, [live({ status: 'OVERRUN', actual_start: iso(-40) })]); // 30 min slot, 40 min in
    const m = await monitor(page);
    // The page clock runs in real time after install, so allow a second or two of drift under load.
    expect(m.timer).toMatch(/^\+10:0[0-3]$/);
    expect(m.label).toBe('OVERRUN');
    expect(m.timerColor).toBe('rgb(232, 121, 249)'); // --st-overrun
  });

  test('with two rooms running the monitor shows the most urgent and stays on it', async ({ page }) => {
    await setup(page, [
      live({ room: 'Main Stage', title: 'Main' }),
      sess('hb', 2, { status: 'OVERRUN', title: 'Hall B', room: 'Hall B', actual_start: iso(-40) }),
    ]);
    expect((await monitor(page)).title).toBe('Hall B');
    // Both LIVE: the one already shown stays even when the order changes.
    await page.evaluate(() => {
      const St = (0, eval)('S');
      St.sessions.find((s: any) => s.id === 'hb').status = 'LIVE';
      St.sessions.reverse();
    });
    expect((await monitor(page)).title).toBe('Hall B');
  });

  test('the monitor stays on the room it shows when another room goes OVERRUN, and moves when that one ends', async ({ page }) => {
    await setup(page, [
      live({ room: 'Room A', title: 'Room A talk' }),
      sess('b', 2, { status: 'LIVE', title: 'Room B talk', room: 'Room B', actual_start: iso(-5) }),
    ]);
    expect((await monitor(page)).title).toBe('Room A talk');
    await page.evaluate(() => {
      const St = (0, eval)('S');
      const b = St.sessions.find((s: any) => s.id === 'b'); b.status = 'OVERRUN'; b.actual_start = new Date(Date.now() - 40 * 60_000).toISOString();
    });
    expect((await monitor(page)).title).toBe('Room A talk');
    await page.evaluate(() => { (0, eval)('S').sessions.find((s: any) => s.id === 'live1').status = 'ENDED'; });
    expect((await monitor(page)).title).toBe('Room B talk');
  });

  test('the footer shows the event name', async ({ page }) => {
    await setup(page, [live()]);
    expect((await monitor(page)).event).toBe('GTR NORTH AFRICA 2026');
  });
});

// ── 6. Event log rows keep their own time and show broadcast text ─────────
test('loaded log rows keep their own time; a broadcast row shows its message', async ({ page }) => {
  await setup(page, [live()]);
  await page.evaluate(() => {
    const w = window as any;
    w.pushLogFromRow({ action: 'SESSION_STATUS_CHANGE', from_status: 'CALLING', to_status: 'LIVE', session_id: 'live1', ts: '2026-10-06T09:05:07Z' });
    w.pushLogFromRow({ action: 'BROADCAST', payload: { message: 'Hall B on hold: projector signal lost' }, ts: '2026-10-06T09:06:00Z' });
  });
  const rows = await page.locator('#log-feed .lg').allTextContents();
  const whens = await page.locator('#log-feed .lg .lg-when').allTextContents();
  expect(whens.slice(0, 2)).toEqual(['09:06', '09:05']);   // each row its own time (HH:MM, spec 4)
  expect(rows[0]).toContain('Hall B on hold: projector signal lost');
  expect(rows[0]).not.toContain('{');
});

// ── 7. Time zone: browser in UTC, event in Cairo (UTC+3 on 6 Oct 2026) ────
test.describe('event time zone', () => {
  const cairo = { id: 'ev-1', name: 'GTR North Africa 2026', timezone: 'Africa/Cairo' };

  test('the timeline NOW line follows Cairo time', async ({ page }) => {
    await setup(page, [
      sess('a', 1, { status: 'PLANNED', scheduled_start: '14:00:00', scheduled_end: '14:30:00' }),
      sess('b', 2, { status: 'PLANNED', scheduled_start: '14:30:00', scheduled_end: '15:30:00' }),
    ], { event: cairo });
    await page.evaluate(() => (window as any).setViewMode('timeline'));
    const pos = await page.evaluate(() => {
      const line = document.querySelector('.tl-now-line');
      const tick = (txt: string) => [...document.querySelectorAll('.tl-time-label')].find(e => e.textContent === txt);
      return line ? { x: Number(line.getAttribute('x1')), t1430: Number(tick('14:30')!.getAttribute('x')), t1500: Number(tick('15:00')!.getAttribute('x')) } : null;
    });
    expect(pos).not.toBeNull();
    // 14:40 Cairo sits one third of the way from 14:30 to 15:00 (30-minute ticks since stage 4).
    expect(pos!.x).toBeCloseTo(pos!.t1430 + (pos!.t1500 - pos!.t1430) * (10 / 30), 0);
  });

  test('auto-start fires at the planned start in Cairo time', async ({ page }) => {
    await setup(page, [sess('r', 1, { status: 'READY', planned_start: '14:40:00', planned_end: '15:00:00', scheduled_start: '14:40:00', scheduled_end: '15:00:00' })],
      { event: cairo });
    await page.evaluate(() => { (0, eval)('S').autoStart = true; });
    await page.clock.runFor(2000);
    expect(await calls(page)).toEqual([['r', 'LIVE']]);
  });

  test('the clock handed to the cue engine reads Cairo wall time', async ({ page }) => {
    await setup(page, [], { event: cairo });
    const hm = await page.evaluate(() => {
      const d = new Date((window as any).eventWallClockNow());
      return d.getHours() * 60 + d.getMinutes();
    });
    expect(hm).toBe(14 * 60 + 40);
  });

  test('STARTED shows the actual start in Cairo time', async ({ page }) => {
    await setup(page, [live({ actual_start: '2026-10-06T11:31:00Z' })], { event: cairo });
    await expect(page.locator('#ctx-wrap .insp-times')).toContainText('14:31');
  });
});

// ── 8. A delayed card keeps its status colour on the left edge ────────────
test('a delayed READY row keeps the READY left edge and shows the delay in its own column', async ({ page }) => {
  await setup(page, [sess('d', 1, { status: 'READY', cumulative_delay: 5, scheduled_start: '11:05:00', scheduled_end: '11:35:00' })]);
  const css = await page.locator('#card-d').evaluate(e => {
    const cs = getComputedStyle(e);
    return { left: cs.borderLeftColor, leftW: cs.borderLeftWidth, top: cs.borderTopColor };
  });
  expect(css.left).toBe('rgb(52, 211, 153)');   // --st-ready
  expect(css.leftW).toBe('4px');
  expect(css.top).not.toBe('rgb(251, 146, 60)'); // the delay no longer paints an edge
  await expect(page.locator('#card-d .sc-delay')).toHaveText('+5');
  await expect(page.locator('#card-d .sc-time small')).toHaveText('was 11:00');
});

// ── 9. HOLD badge, reduced motion, speaker arrival errors ────────────────
test('the HOLD badge is solid, not blinking', async ({ page }) => {
  await setup(page, [sess('h', 1, { status: 'HOLD', actual_start: iso(-5) })]);
  const anim = await page.locator('#card-h .badge').evaluate(e => getComputedStyle(e).animationName);
  expect(anim).toBe('none');
});

// Badges and cards no longer pulse (stage 1), so this checks what still
// animates without the preference: an armed END, the reconnecting dot and
// overlay, and the onboarding pulse on the add-event button. The
// no-preference run is the control: it proves the states really animate.
async function motionState(page: Page) {
  await setup(page, [live()]);
  await (await controls(page, 'live1')).locator('button', { hasText: L.end }).click();
  return page.evaluate(() => {
    (0, eval)('onDisconnect(); buildEvSelect([]);');
    const name = (sel: string) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).animationName : 'missing'; };
    return {
      names: [name('#card-live1 .confirm-pending'), name('#conn-dot'), name('#rc-overlay'), name('.ev-add-btn.rbtn-pulse')],
      running: document.getAnimations().length,
    };
  });
}

test('without reduced motion the armed END, reconnecting state and onboarding pulse animate (control)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const m = await motionState(page);
  expect(m.names).toEqual(['pulse-confirm', 'blink', 'blink', 'pulse-ring']);
  expect(m.running).toBeGreaterThan(0);
});

test('reduced motion stops every animation an operator would otherwise see', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const m = await motionState(page);
  expect(m.names).toEqual(['none', 'none', 'none', 'none']);
  expect(m.running).toBe(0);
});

test('a failed arrival write reverts, says so and does not log it as confirmed', async ({ page }) => {
  await setup(page, [live({ speaker: 'Dina Farouk', speaker_arrived: false })]);
  await page.evaluate(() => {
    const sbc = (0, eval)('sb');
    sbc.from = () => ({ update: () => ({ eq: async () => ({ data: null, error: { message: 'permission denied' } }) }) });
  });
  await page.evaluate(() => (window as any).markArrived('live1', true));
  const st = await page.evaluate(() => {
    const St = (0, eval)('S');
    return { arrived: St.sessions[0].speaker_arrived, log: St.log.map((e: any) => `${e.action} ${e.detail}`) };
  });
  expect(st.arrived).toBe(false);
  expect(st.log.some((l: string) => l.includes('confirmed'))).toBe(false);
  await expect(page.locator('#toast-container')).toContainText('permission denied');
});

// ── Test Cue Alert uses the event clock ───────────────────────────────────
test('Test Cue Alert counts down about 8 minutes for a Cairo event in a UTC browser', async ({ page }) => {
  await setup(page, [], { event: { id: 'ev-1', name: 'GTR North Africa 2026', timezone: 'Africa/Cairo' } });
  await page.evaluate(() => (document.querySelector('[title^="Fire a demo pre-cue"]') as HTMLButtonElement).click());
  await page.clock.runFor(1500);
  await expect(page.locator('#ce-timer')).toHaveText(/^0(7:5\d|8:00)$/);
});

// ── CSV export uses the event zone ────────────────────────────────────────
test('the event log CSV time column is in the event zone', async ({ page }) => {
  await setup(page, [], { event: { id: 'ev-1', name: 'GTR North Africa 2026', timezone: 'Africa/Cairo' } });
  const csv = await page.evaluate(async () => {
    const w = window as any;
    (0, eval)('S').log = [];
    w.pushLog('BROADCAST', 'Hall B on hold', null, Date.parse('2026-10-06T09:06:00Z'));
    let blob: Blob | null = null;
    URL.createObjectURL = (b: Blob) => { blob = b; return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = () => {};
    w.exportLog();
    return blob ? await (blob as Blob).text() : '';
  });
  expect(csv.split('\n')[1]).toMatch(/^12:06:00,BROADCAST,/);
});

// ── Realtime arming does not switch the view ─────────────────────────────
test('a PLANNED to READY change from realtime does not change the view', async ({ page }) => {
  await setup(page, [live(), sess('p2', 2, { status: 'PLANNED', version: 1 })]);
  await page.evaluate(() => {
    const St = (0, eval)('S');
    St.tlBootDone = true; // the removed auto-switch was gated on this flag
    const row = { ...St.sessions[1], status: 'READY', version: 2 };
    (window as any).onSessionChange({ eventType: 'UPDATE', new: row, old: {} });
  });
  await page.clock.runFor(1500);
  expect(await page.evaluate(() => (0, eval)('S').viewMode)).toBe('list');
  await expect(page.locator('#card-p2 .badge')).toHaveText('READY');
});

// ── Event log escapes the action name ─────────────────────────────────────
test('a malicious action name in the event log is shown as text, not HTML', async ({ page }) => {
  await setup(page, []);
  await page.evaluate(() => (window as any).pushLog('<img src=x onerror="window.__xss=1">', 'detail', null));
  await expect(page.locator('#log-feed img')).toHaveCount(0);
  await expect(page.locator('#log-feed')).toContainText('<img src=x');
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
});

// ── Setup wizard reloads the sessions of the current event ────────────────
test('the setup wizard shows the session it just added', async ({ page }) => {
  await setup(page, []);
  const row = { id: 'w1', event_id: 'ev-1', sort_order: 1, title: 'Wizard keynote', status: 'PLANNED', version: 1, room: '',
    speaker: '', planned_start: '09:00:00', planned_end: '09:30:00', scheduled_start: '09:00:00', scheduled_end: '09:30:00' };
  await page.route('**/rest/v1/leod_sessions**', r => r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([row]) })
    : r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }));
  await page.evaluate(async () => {
    const w = window as any;
    w.showSetupWizard();
    (0, eval)('_wizStep = 1');
    w.renderWizStep();
    (document.getElementById('wiz-sess-title') as HTMLInputElement).value = 'Wizard keynote';
    await w.wizNext();
  });
  expect(await page.evaluate(() => (0, eval)('S').sessions.map((s: any) => s.id))).toEqual(['w1']);
});
