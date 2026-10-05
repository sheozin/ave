// tests/e2e/session-people.spec.ts
// Console side of session people (082): the session editor's people list,
// the speaker/company summary written beside it, CSV import with a moderator
// column, and event copy. No live DB: every REST call is answered by
// page.route, writes are captured and answered locally, anything else is 403.
//
// Prerequisite: preview server running on port 7230
// Run: npm run test:e2e

import { test, expect, type Page, type Route } from '@playwright/test';

const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:7230';

interface Write { method: string; url: string; body: unknown }

async function mockRest(page: Page, selectRows: unknown[] = [],
                        opts: { failSessionInsert?: string; failSessionSelect?: string; eventRow?: Record<string, unknown> } = {}) {
  const writes: Write[] = [];
  const json = (route: Route, status: number, body?: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body),
                    headers: { 'access-control-allow-origin': '*' } });
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 200, headers: {
        'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    }
    const url = req.url();
    if (url.includes('/leod_sessions')) {
      if (req.method() === 'GET') {
        if (opts.failSessionSelect) return json(route, 400, { message: opts.failSessionSelect });
        return json(route, 200, selectRows);
      }
      writes.push({ method: req.method(), url, body: JSON.parse(req.postData() || 'null') });
      if (req.method() === 'POST' && opts.failSessionInsert) return json(route, 400, { message: opts.failSessionInsert });
      return json(route, req.method() === 'POST' ? 201 : 204);
    }
    if (url.includes('/leod_events') && req.method() === 'POST' && opts.eventRow) {
      writes.push({ method: 'POST', url, body: JSON.parse(req.postData() || 'null') });
      return json(route, 201, opts.eventRow);
    }
    return json(route, 403, { message: 'not mocked' });
  });
  return writes;
}

const PANEL = {
  id: 'sess-1', event_id: 'test-event-id', sort_order: 1, title: 'Panel: future of MICE', type: 'Panel',
  room: 'Hall A', speaker: 'Jane Smith', company: 'Contoso', planned_start: '10:00:00', planned_end: '11:00:00',
  scheduled_start: '10:00:00', scheduled_end: '11:00:00', status: 'PLANNED', people: [],
};

async function openEditor(page: Page, session: Record<string, unknown> = PANEL) {
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.pointerEvents = 'none';
  });
  await page.evaluate((s) => {
    // S is a top-level const in the page script: reach it through indirect eval
    // eslint-disable-next-line no-eval
    (0, eval)(`S.role = 'director'; S.userRole = 'director';
      S.event = { id: 'test-event-id', name: 'Test Event' };
      S.sessions = [${JSON.stringify(s)}];`);
    (window as unknown as { openSessModal: (m: string, id: string) => void }).openSessModal('edit', s.id as string);
  }, session);
  await expect(page.locator('#sess-modal')).toBeVisible();
}

const rows = (page: Page) => page.locator('#smv-people .smv-person');

async function fillRow(page: Page, i: number, name: string, company: string, role: string) {
  const r = rows(page).nth(i);
  await r.locator('.smv-p-name').fill(name);
  await r.locator('.smv-p-co').fill(company);
  await r.locator('.smv-p-role').selectOption(role);
}

test.describe('Session people: editor', () => {

  test('SP01 a legacy session loads its speaker and company as the first row', async ({ page }) => {
    await mockRest(page);
    await openEditor(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).nth(0).locator('.smv-p-name')).toHaveValue('Jane Smith');
    await expect(rows(page).nth(0).locator('.smv-p-co')).toHaveValue('Contoso');
    await expect(rows(page).nth(0).locator('.smv-p-role')).toHaveValue('speaker');
    await expect(page.locator('#smv-p-add')).toHaveText('Add speaker');
    await expect(page.locator('#smv-spk, #smv-co, #smv-people-use')).toHaveCount(0);
  });

  test('SP02 three people with roles save in order with the speaker summary', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page);
    await rows(page).nth(0).locator('.smv-p-role').selectOption('moderator');
    // add Sara first, then Ahmed, then move Ahmed up: order must follow the list
    await page.locator('#smv-p-add').click();
    await fillRow(page, 1, 'Sara Lee', 'Northwind', 'panelist');
    await page.locator('#smv-p-add').click();
    await fillRow(page, 2, 'Ahmed Ali', 'Fabrikam', 'speaker');
    await rows(page).nth(2).locator('.smv-p-up').click();
    // a blank row added and removed again leaves no trace
    await page.locator('#smv-p-add').click();
    await expect(rows(page)).toHaveCount(4);
    await rows(page).nth(3).locator('.smv-p-del').click();
    await expect(rows(page)).toHaveCount(3);
    // the first row cannot move up, the last cannot move down
    await expect(rows(page).nth(0).locator('.smv-p-up')).toBeDisabled();
    await expect(rows(page).nth(2).locator('.smv-p-down')).toBeDisabled();

    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();

    const patch = writes.find(w => w.method === 'PATCH');
    expect(patch).toBeTruthy();
    const body = patch!.body as Record<string, unknown>;
    expect(body.people).toEqual([
      { name: 'Jane Smith', company: 'Contoso',   role: 'moderator' },
      { name: 'Ahmed Ali',  company: 'Fabrikam',  role: 'speaker' },
      { name: 'Sara Lee',   company: 'Northwind', role: 'panelist' },
    ]);
    expect(body.speaker).toBe('Jane Smith (moderator), Ahmed Ali, Sara Lee');
    expect(body.company).toBeNull();
    expect(patch!.url).toContain('id=eq.sess-1');
  });

  test('SP03 moderators come first in the summary and a shared company is kept', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page, { ...PANEL, speaker: null, company: null });
    await expect(rows(page)).toHaveCount(1);
    await fillRow(page, 0, 'Ahmed Ali', 'Contoso', 'speaker');
    await page.locator('#smv-p-add').click();
    await fillRow(page, 1, 'Jane Smith', 'Contoso', 'moderator');
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.speaker).toBe('Jane Smith (moderator), Ahmed Ali');
    expect(body.company).toBe('Contoso');
    expect((body.people as { name: string }[]).map(p => p.name)).toEqual(['Ahmed Ali', 'Jane Smith']);
  });

  test('SP04 one speaker row saves as speaker and company, exactly as before (no people key)', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page);
    await rows(page).nth(0).locator('.smv-p-name').fill('Solo Speaker');
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.speaker).toBe('Solo Speaker');
    expect(body.company).toBe('Contoso');
    expect('people' in body).toBe(false);
  });

  test('SP04b one moderator row is saved as a people list', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page);
    await rows(page).nth(0).locator('.smv-p-role').selectOption('moderator');
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.people).toEqual([{ name: 'Jane Smith', company: 'Contoso', role: 'moderator' }]);
    expect(body.speaker).toBe('Jane Smith (moderator)');
  });

  test('SP04c a company-only legacy session keeps saving its company', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page, { ...PANEL, speaker: null, company: 'Contoso' });
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.speaker).toBeNull();
    expect(body.company).toBe('Contoso');
    expect('people' in body).toBe(false);
  });

  test('SP05 an existing people list loads into rows; removing every row clears it', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page, { ...PANEL, speaker: 'Jane Smith (moderator), Ahmed Ali', company: null, people: [
      { name: 'Jane Smith', company: 'Contoso', role: 'moderator' },
      { name: 'Ahmed Ali', company: null, role: 'speaker' },
    ] });
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(0).locator('.smv-p-role')).toHaveValue('moderator');
    await expect(rows(page).nth(1).locator('.smv-p-co')).toHaveValue('');
    await rows(page).nth(0).locator('.smv-p-del').click();
    await rows(page).nth(0).locator('.smv-p-del').click();
    // one empty row is always there; the old summary is not left behind
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).nth(0).locator('.smv-p-name')).toHaveValue('');
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.people).toEqual([]);
    expect(body.speaker).toBeNull();
    expect(body.company).toBeNull();
  });

  test('SP05b a list cut down to one speaker saves as speaker and clears the list', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page, { ...PANEL, speaker: 'Jane Smith (moderator), Ahmed Ali', company: null, people: [
      { name: 'Jane Smith', company: 'Contoso', role: 'moderator' },
      { name: 'Ahmed Ali', company: 'Fabrikam', role: 'speaker' },
    ] });
    await rows(page).nth(0).locator('.smv-p-del').click();
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.people).toEqual([]);
    expect(body.speaker).toBe('Ahmed Ali');
    expect(body.company).toBe('Fabrikam');
  });

  test('SP06 a person with a company but no name is refused', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page);
    await page.locator('#smv-p-add').click();
    await fillRow(page, 1, '', 'Fabrikam', 'speaker');
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#smv-error')).toHaveText('Each person needs a name.');
    await expect(page.locator('#sess-modal')).toBeVisible();
    expect(writes).toHaveLength(0);
  });

  test('SP07 names with markup stay text in the editor', async ({ page }) => {
    await mockRest(page);
    const evil = '<img src=x onerror="window.__xss=1">Eve';
    await openEditor(page, { ...PANEL, people: [{ name: evil, company: '<b>Co</b>', role: 'speaker' }] });
    await expect(rows(page).nth(0).locator('.smv-p-name')).toHaveValue(evil);
    await expect(rows(page).nth(0).locator('.smv-p-co')).toHaveValue('<b>Co</b>');
    await expect(page.locator('#smv-people img, #smv-people b')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test('SP08 add mode starts with one empty speaker row', async ({ page }) => {
    await mockRest(page);
    await openEditor(page, { ...PANEL, people: [{ name: 'Jane Smith', company: null, role: 'moderator' }] });
    await expect(rows(page)).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { closeSessModal: () => void }).closeSessModal());
    await page.evaluate(() => (window as unknown as { openSessModal: (m: string) => void }).openSessModal('add'));
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).nth(0).locator('.smv-p-name')).toHaveValue('');
    await expect(rows(page).nth(0).locator('.smv-p-role')).toHaveValue('speaker');
  });

  test('SP09 production toggles save their on state', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page);
    await page.locator('#smv-rec').check();
    await page.locator('#smv-interp').check();
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ recording: true, interpretation: true, streaming: false, is_anchor: false, remote: false });
  });

});

test.describe('Session people: CSV import and event copy', () => {

  async function boot(page: Page, selectRows: unknown[] = []) {
    const writes = await mockRest(page, selectRows);
    await page.goto(`${BASE}/cuedeck-console.html`);
    // eslint-disable-next-line no-eval
    await page.evaluate(() => (0, eval)(`S.event = { id: 'test-event-id', name: 'Test Event' }; S.sessions = [];`));
    return writes;
  }

  async function importCsv(page: Page, csv: string) {
    await page.evaluate(async (text) => {
      await (window as unknown as { handleCSVImport: (f: File) => Promise<void> })
        .handleCSVImport(new File([text], 'agenda.csv', { type: 'text/csv' }));
    }, csv);
  }

  test('SP10 CSV without a moderator column imports exactly as before', async ({ page }) => {
    const writes = await boot(page);
    await importCsv(page, 'title,start,end,speaker\nKeynote,09:00,09:45,Jane Smith\n');
    const rowsIn = writes.find(w => w.method === 'POST')!.body as Record<string, unknown>[];
    expect(rowsIn).toHaveLength(1);
    expect(rowsIn[0].speaker).toBe('Jane Smith');
    expect('people' in rowsIn[0]).toBe(false);
  });

  test('SP11 CSV moderator column builds people; speakers split on ; and " / "', async ({ page }) => {
    const writes = await boot(page);
    await importCsv(page, [
      'title,start,end,moderator,speaker',
      'Panel A,10:00,11:00,Jane Smith,Ahmed Ali; Sara Lee / Omar Said',
      'Keynote,09:00,09:45,,Solo Speaker',
    ].join('\n'));
    const rowsIn = writes.find(w => w.method === 'POST')!.body as Record<string, unknown>[];
    expect(rowsIn[0].people).toEqual([
      { name: 'Jane Smith', company: null, role: 'moderator' },
      { name: 'Ahmed Ali',  company: null, role: 'speaker' },
      { name: 'Sara Lee',   company: null, role: 'speaker' },
      { name: 'Omar Said',  company: null, role: 'speaker' },
    ]);
    expect(rowsIn[0].speaker).toBe('Jane Smith (moderator), Ahmed Ali, Sara Lee, Omar Said');
    // a row without a moderator keeps its single speaker and an empty list
    expect(rowsIn[1].people).toEqual([]);
    expect(rowsIn[1].speaker).toBe('Solo Speaker');
  });

  test('SP12 copying an event carries people and the session details across', async ({ page }) => {
    const people = [{ name: 'Jane Smith', company: 'Contoso', role: 'moderator' }];
    const extra = { notes: 'Lapel mics', mic_type: 'lapel', slides: true, video_file: true, checks: [{ k: 'mic' }] };
    const writes = await boot(page, [{ ...PANEL, ...extra, people }, { ...PANEL, id: 'sess-2', sort_order: 2, people: [] }]);
    await page.evaluate(async () => {
      await (window as unknown as { seedSessions: (a: string, b: string) => Promise<number> })
        .seedSessions('from-event', 'to-event');
    });
    const rowsIn = writes.find(w => w.method === 'POST')!.body as Record<string, unknown>[];
    expect(rowsIn[0].people).toEqual(people);
    expect(rowsIn[1].people).toEqual([]);
    expect(rowsIn[0].event_id).toBe('to-event');
    expect(rowsIn[0]).toMatchObject(extra);
    // a source without those columns sends none of them
    expect('mic_type' in rowsIn[1]).toBe(false);
  });

  test('SP13 copying sessions that fails to insert says so and keeps the new event', async ({ page }) => {
    const writes = await mockRest(page, [{ ...PANEL }], {
      failSessionInsert: 'insert exploded',
      eventRow: { id: 'new-ev', name: 'GTR 2027', date: '2027-10-12', timezone: 'Africa/Cairo', active: true },
    });
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.evaluate(() => {
      const el = document.getElementById('loading-overlay');
      if (el) el.style.display = 'none';
      // eslint-disable-next-line no-eval
      (0, eval)(`S.user = { id: 'u1' }; S.subscription = null; S.planLimits = null;
        S.events = [{ id: 'from-event', name: 'GTR 2026', active: true }];
        S.event = S.events[0]; S.sessions = [];`);
      (window as unknown as { openEvModal: (m: string) => void }).openEvModal('create');
    });
    await page.locator('#evm-name').fill('GTR 2027');
    await page.locator('#evm-seed').selectOption('from-event');
    await page.locator('#ev-modal button.primary').click();
    await expect(page.locator('.toast-msg').filter({ hasText: 'Event created, but copying sessions failed: insert exploded' }))
      .toBeVisible();
    expect(writes.some(w => w.url.includes('/leod_sessions') && w.method === 'POST')).toBe(true);
    // the event is kept and opened
    expect(await page.evaluate(() => (0, eval)('S.events.map(e => e.id)'))).toContain('new-ev');
  });

  test('SP14 a failed read of the source sessions throws from seedSessions', async ({ page }) => {
    await boot(page);
    await page.unrouteAll();
    await mockRest(page, [], { failSessionSelect: 'select exploded' });
    const msg = await page.evaluate(async () => {
      try {
        await (window as unknown as { seedSessions: (a: string, b: string) => Promise<number> }).seedSessions('a', 'b');
        return 'no error';
      } catch (e) { return (e as Error).message; }
    });
    expect(msg).toBe('select exploded');
  });

});

test.describe('Session people: new session form', () => {

  test('SP20 add mode starts at the previous session end, ends 30 minutes later', async ({ page }) => {
    await mockRest(page);
    await openEditor(page, PANEL);
    await page.evaluate(() => {
      // eslint-disable-next-line no-eval
      (0, eval)(`S.sessions = [
        { id: 'a', sort_order: 1, title: 'A', planned_start: '09:00:00', planned_end: '09:45:00' },
        { id: 'b', sort_order: 2, title: 'B', planned_start: '13:00:00', planned_end: '14:15:00' },
        { id: 'c', sort_order: 3, title: 'C', planned_start: '10:00:00', planned_end: '10:30:00' },
        { id: 'd', sort_order: 4, title: 'No times', planned_start: null, planned_end: null },
      ];`);
      (window as unknown as { openSessModal: (m: string) => void }).openSessModal('add');
    });
    await expect(page.locator('#smv-start')).toHaveValue('14:15');
    await expect(page.locator('#smv-end')).toHaveValue('14:45');
  });

  test('SP21 the default end is capped at 23:59', async ({ page }) => {
    await mockRest(page);
    await openEditor(page, { ...PANEL, planned_start: '23:00:00', planned_end: '23:45:00' });
    await page.evaluate(() => (window as unknown as { openSessModal: (m: string) => void }).openSessModal('add'));
    await expect(page.locator('#smv-start')).toHaveValue('23:45');
    await expect(page.locator('#smv-end')).toHaveValue('23:59');
  });

  test('SP24 duration read-out follows the times and turns red when end is not after start', async ({ page }) => {
    await mockRest(page);
    await openEditor(page);   // 10:00 to 11:00
    await expect(page.locator('#smv-duration')).toHaveText('Duration: 1 h');
    await page.locator('#smv-end').fill('10:15');
    await expect(page.locator('#smv-duration')).toHaveText('Duration: 15 min');
    await expect(page.locator('#smv-duration')).not.toHaveClass(/bad/);
    await page.locator('#smv-end').fill('09:45');
    await expect(page.locator('#smv-duration')).toHaveClass(/bad/);
  });

  test('SP22 the first session starts with empty times', async ({ page }) => {
    await mockRest(page);
    await openEditor(page);
    await page.evaluate(() => {
      // eslint-disable-next-line no-eval
      (0, eval)('S.sessions = []');
      (window as unknown as { openSessModal: (m: string) => void }).openSessModal('add');
    });
    await expect(page.locator('#smv-start')).toHaveValue('');
    await expect(page.locator('#smv-end')).toHaveValue('');
  });

  for (const [label, end] of [['equal', '10:00'], ['earlier', '09:30']] as const) {
    test(`SP23 an ${label} end is refused in add and edit mode`, async ({ page }) => {
      const writes = await mockRest(page);
      await openEditor(page);
      await page.locator('#smv-start').fill('10:00');
      await page.locator('#smv-end').fill(end);
      await page.locator('#sess-modal button.primary').click();
      await expect(page.locator('#smv-error')).toHaveText('The session must end after it starts.');
      await page.evaluate(() => (window as unknown as { openSessModal: (m: string) => void }).openSessModal('add'));
      await page.locator('#smv-title').fill('New one');
      await page.locator('#smv-start').fill('10:00');
      await page.locator('#smv-end').fill(end);
      await page.locator('#sess-modal button.primary').click();
      await expect(page.locator('#smv-error')).toHaveText('The session must end after it starts.');
      expect(writes).toHaveLength(0);
    });
  }

});

test.describe('Setup wizard', () => {

  test('SP30 the first-session insert writes type, not session_type', async ({ page }) => {
    const writes = await mockRest(page);
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.evaluate(() => {
      const el = document.getElementById('loading-overlay');
      if (el) el.style.display = 'none';
      // the wizard used to read a #ev-select that no longer exists, so
      // event_id was undefined; it now uses the selected event
      // eslint-disable-next-line no-eval
      (0, eval)(`S.event = { id: 'test-event-id', name: 'Test' };
        showSetupWizard(); _wizStep = 1; renderWizStep();`);
    });
    await page.locator('#wiz-sess-title').fill('Opening keynote');
    await page.evaluate(() => { (0, eval)('wizNext()').catch(() => {}); });
    await expect.poll(() => writes.filter(w => w.method === 'POST').length).toBe(1);
    const body = writes.find(w => w.method === 'POST')!.body as Record<string, unknown>;
    expect(body.type).toBe('Keynote');
    expect('session_type' in body).toBe(false);
    expect(body.event_id).toBe('test-event-id');
    expect(body.title).toBe('Opening keynote');
  });

});
