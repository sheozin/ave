// tests/e2e/agents-data.spec.ts
// The AI agents' database writes use real columns and say who wrote them,
// and the report's no-AI fallback states only what the data shows.
// No auth: state is injected, every REST and Edge Function call intercepted.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.CONSOLE_BASE ?? 'http://127.0.0.1:7230';
const EV = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';

let rest: { method: string; url: string; body: any }[] = [];
let getRows: any[] = [];
let postStatus = 201;

async function setup(page: Page) {
  rest = [];
  getRows = [];
  postStatus = 201;
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    rest.push({ method: req.method(), url: decodeURIComponent(req.url()), body: req.postDataJSON?.() ?? null });
    if (req.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(getRows) });
      return;
    }
    await route.fulfill({ status: postStatus, contentType: 'application/json',
      body: postStatus >= 400 ? JSON.stringify({ code: '42501', message: 'row-level security' }) : '[]' });
  });
  // ai-proxy fails, so the agents use their fallbacks
  await page.route('**/functions/v1/**', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }));
  page.on('dialog', d => { throw new Error('native dialog opened: ' + d.message()); });
  await page.goto(`${BASE}/cuedeck-console.html`);
  await page.evaluate(() => { const el = document.getElementById('loading-overlay'); if (el) el.style.display = 'none'; });
  await page.evaluate(([ev, user]) => {
    (0, eval)(`
      S.user = { id: '${user}' };
      S.role = 'director'; S.userRole = 'director';
      S.event = { id: '${ev}', name: 'Probe Summit', date: '2026-10-12' };
      S.sessions = [
        { id: 's1', title: 'Opening', status: 'ENDED', cumulative_delay: 0, scheduled_start: '09:00:00' },
        { id: 's2', title: 'Keynote', status: 'ENDED', cumulative_delay: 10, scheduled_start: '09:30:00' },
        { id: 's3', title: 'Panel', status: 'CANCELLED', cumulative_delay: 0, scheduled_start: '10:30:00' },
      ];
      ensureAgentsInited();
    `);
  }, [EV, USER]);
}
const evalPage = (page: Page, code: string) => page.evaluate((c) => (0, eval)(c), code);

test('incident advisor logs to real leod_event_log columns, as the signed-in user', async ({ page }) => {
  await setup(page);
  await evalPage(page, `CueDeckIncidentAdvisor.trigger({ system: 'Audio', location: 'Main Stage', description: 'Hum on lectern mic', severity: 'Warning' })`);
  await evalPage(page, `CueDeckIncidentAdvisor.resolve()`);
  await expect.poll(() => rest.filter(r => r.method === 'POST' && r.url.includes('leod_event_log')).length).toBe(1);
  const row = rest.find(r => r.method === 'POST' && r.url.includes('leod_event_log'))!.body;
  expect(row).toMatchObject({ event_id: EV, operator_id: USER, action: 'INCIDENT_RESOLVED' });
  expect(row.payload).toMatchObject({ system: 'incident-advisor' });
  expect(row.payload.details).toMatchObject({ system: 'Audio', resolved: true });
  for (const col of Object.keys(row)) {
    expect(['event_id', 'session_id', 'operator_id', 'operator_role', 'action', 'from_status', 'to_status', 'payload', 'server_time_ms']).toContain(col);
  }
});

test('report agent reads incidents by payload, not a missing column, and archives with event and user', async ({ page }) => {
  await setup(page);
  getRows = [{ action: 'INCIDENT_ESCALATED', operator_role: 'stage', ts: '2026-10-12T10:00:00Z',
               payload: { system: 'incident-advisor', details: { system: 'Video', location: 'Room B', escalated: true, escalatedAt: 'x' } } }];
  await evalPage(page, `CueDeckReportAgent.triggerFromCueDeck()`);
  await expect.poll(() => rest.filter(r => r.method === 'POST' && r.url.includes('leod_reports')).length, { timeout: 15000 }).toBe(1);
  const read = rest.find(r => r.method === 'GET' && r.url.includes('leod_event_log'))!;
  expect(read.url).toContain('payload->>system=eq.incident-advisor');
  expect(read.url).not.toMatch(/[?&]system=/);
  expect(read.url).toContain('order=ts');
  const ins = rest.find(r => r.method === 'POST' && r.url.includes('leod_reports'))!.body;
  expect(ins).toMatchObject({ event_id: EV, generated_by: USER });
  // the incident from the DB reached the report
  expect(ins.report_data.incidentAnalysis).toContain('1');
});

test('the no-AI fallback report states only what the data shows', async ({ page }) => {
  await setup(page);
  await evalPage(page, `CueDeckReportAgent.triggerFromCueDeck()`);
  await expect.poll(() => rest.filter(r => r.method === 'POST' && r.url.includes('leod_reports')).length, { timeout: 15000 }).toBe(1);
  const r = rest.find(x => x.method === 'POST' && x.url.includes('leod_reports'))!.body.report_data;
  const all = JSON.stringify(r);
  for (const claim of ['executed successfully', 'within expected parameters', 'high availability', 'stable delivery',
                       'professional execution', 'All critical issues were addressed', 'within scheduled timeframes']) {
    expect(all).not.toContain(claim);
  }
  expect(r.sessionAdherence).toContain('3');          // sessions in the programme
  expect(r.sessionAdherence).toContain('10');         // the largest delay
  expect(r.streamingPerformance.toLowerCase()).toContain('not recorded');
  expect(r.overallRating).not.toBe('Good');
});

test('a refused report archive is reported, not swallowed', async ({ page }) => {
  await setup(page);
  postStatus = 403;
  const warned: string[] = [];
  page.on('console', m => { if (m.type() === 'warning') warned.push(m.text()); });
  await evalPage(page, `CueDeckReportAgent.triggerFromCueDeck()`);
  await expect.poll(() => warned.some(w => w.includes('Report archive failed')), { timeout: 15000 }).toBe(true);
  await expect(page.locator('#ra-footer-meta')).toContainText('not archived');
});
