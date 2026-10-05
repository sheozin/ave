// tests/e2e/session-people.spec.ts
// Console side of session people (082): the session editor's people list,
// the speaker/company summary written beside it, CSV import with a moderator
// column, and event copy. No live DB: every REST call is answered by
// page.route, writes are captured and answered locally, anything else is 403.
//
// Prerequisite: preview server running on port 7230
// Run: npm run test:e2e

import { test, expect, type Page, type Route } from '@playwright/test';

const BASE = 'http://127.0.0.1:7230';

interface Write { method: string; url: string; body: unknown }

async function mockRest(page: Page, selectRows: unknown[] = []) {
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
      if (req.method() === 'GET') return json(route, 200, selectRows);
      writes.push({ method: req.method(), url, body: JSON.parse(req.postData() || 'null') });
      return json(route, req.method() === 'POST' ? 201 : 204);
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

  test('SP01 a session without people shows the single speaker fields and the people link', async ({ page }) => {
    await mockRest(page);
    await openEditor(page);
    await expect(page.locator('#smv-spk')).toBeVisible();
    await expect(page.locator('#smv-people-use')).toHaveText('Use a people list');
    await expect(rows(page)).toHaveCount(0);
  });

  test('SP02 three people with roles save in order with the speaker summary', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page);
    await page.locator('#smv-people-use').click();
    // the current speaker/company become the first row
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).nth(0).locator('.smv-p-name')).toHaveValue('Jane Smith');
    await expect(rows(page).nth(0).locator('.smv-p-co')).toHaveValue('Contoso');
    await expect(page.locator('#smv-spk')).toBeHidden();
    await expect(page.locator('#smv-people-note')).toHaveText('Using the people list');

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
    await page.locator('#smv-people-use').click();
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

  test('SP04 a session without people saves exactly as before (no people key)', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page);
    await page.locator('#smv-spk').fill('Solo Speaker');
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.speaker).toBe('Solo Speaker');
    expect(body.company).toBe('Contoso');
    expect('people' in body).toBe(false);
  });

  test('SP05 an existing people list loads into rows, and removing every row clears it', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page, { ...PANEL, speaker: 'Jane Smith (moderator), Ahmed Ali', company: null, people: [
      { name: 'Jane Smith', company: 'Contoso', role: 'moderator' },
      { name: 'Ahmed Ali', company: null, role: 'speaker' },
    ] });
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(0).locator('.smv-p-role')).toHaveValue('moderator');
    await expect(rows(page).nth(1).locator('.smv-p-co')).toHaveValue('');
    await expect(page.locator('#smv-spk')).toBeHidden();
    await rows(page).nth(0).locator('.smv-p-del').click();
    await rows(page).nth(0).locator('.smv-p-del').click();
    await expect(page.locator('#smv-spk')).toBeVisible();
    await page.locator('#smv-spk').fill('Ahmed Ali');
    await page.locator('#smv-co').fill('');
    await page.locator('#sess-modal button.primary').click();
    await expect(page.locator('#sess-modal')).toBeHidden();
    const body = writes.find(w => w.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.people).toEqual([]);
    expect(body.speaker).toBe('Ahmed Ali');
    expect(body.company).toBeNull();
  });

  test('SP06 a person with a company but no name is refused', async ({ page }) => {
    const writes = await mockRest(page);
    await openEditor(page);
    await page.locator('#smv-people-use').click();
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

  test('SP08 add mode starts with no people', async ({ page }) => {
    await mockRest(page);
    await openEditor(page, { ...PANEL, people: [{ name: 'Jane Smith', company: null, role: 'moderator' }] });
    await expect(rows(page)).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { closeSessModal: () => void }).closeSessModal());
    await page.evaluate(() => (window as unknown as { openSessModal: (m: string) => void }).openSessModal('add'));
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('#smv-spk')).toBeVisible();
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

  test('SP12 copying an event carries people across', async ({ page }) => {
    const people = [{ name: 'Jane Smith', company: 'Contoso', role: 'moderator' }];
    const writes = await boot(page, [{ ...PANEL, people }, { ...PANEL, id: 'sess-2', sort_order: 2, people: [] }]);
    await page.evaluate(async () => {
      await (window as unknown as { seedSessions: (a: string, b: string) => Promise<number> })
        .seedSessions('from-event', 'to-event');
    });
    const rowsIn = writes.find(w => w.method === 'POST')!.body as Record<string, unknown>[];
    expect(rowsIn[0].people).toEqual(people);
    expect(rowsIn[1].people).toEqual([]);
    expect(rowsIn[0].event_id).toBe('to-event');
  });

});
