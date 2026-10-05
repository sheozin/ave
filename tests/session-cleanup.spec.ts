// tests/session-cleanup.spec.ts
// The nightly session archive (api/cron/session-cleanup.ts) must leave a
// run row in leod_checkin_job_runs on success AND on failure, so the brain's
// job watcher reports it failing or stale instead of seeing nothing. It
// failed silently every night because leod_sessions_archive lacked seq.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Call = { table: string; op: string; arg?: unknown; filters: unknown[] };
let calls: Call[];
// Per-operation answers: { data, error }.
let answers: Record<string, { data?: unknown; error?: { message: string } | null }>;

function builder(table: string, op: string, arg?: unknown) {
  const call: Call = { table, op, arg, filters: [] };
  calls.push(call);
  const b: any = {
    eq: (...f: unknown[]) => { call.filters.push(['eq', ...f]); return b; },
    lt: (...f: unknown[]) => { call.filters.push(['lt', ...f]); return b; },
    in: (...f: unknown[]) => { call.filters.push(['in', ...f]); return b; },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const a = answers[`${table}.${op}`] ?? { data: null, error: null };
      return Promise.resolve({ data: a.data ?? null, error: a.error ?? null }).then(res, rej);
    },
  };
  return b;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: (cols: string) => builder(table, 'select', cols),
      upsert: (rows: unknown) => builder(table, 'upsert', rows),
      insert: (row: unknown) => builder(table, 'insert', row),
      delete: () => builder(table, 'delete'),
    }),
  }),
}));

process.env.CRON_SECRET = 'cron-secret';
process.env.SUPABASE_URL = 'http://stub.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';

const { default: handler } = await import('../api/cron/session-cleanup');
const run = () => handler(new Request('http://x/api/cron/session-cleanup', {
  headers: { authorization: 'Bearer cron-secret' },
}));
const runRows = () => calls.filter(c => c.table === 'leod_checkin_job_runs' && c.op === 'insert').map(c => c.arg as any);

beforeEach(() => {
  calls = [];
  answers = {};
});

describe('session-cleanup cron', () => {
  it('refuses a request without the cron secret and records nothing', async () => {
    const res = await handler(new Request('http://x/', { headers: { authorization: 'Bearer nope' } }));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('archives, deletes, and records an ok run with the counts', async () => {
    answers['leod_sessions.select'] = { data: [{ id: 'a', seq: 4 }, { id: 'b', seq: 9 }] };
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: 2 });
    expect(calls.find(c => c.op === 'upsert')?.table).toBe('leod_sessions_archive');
    expect(calls.find(c => c.op === 'delete')?.filters).toEqual([['in', 'id', ['a', 'b']]]);
    const rows = runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_name: 'session-cleanup', status: 'ok' });
    expect(typeof rows[0].started_at).toBe('string');
    expect(typeof rows[0].finished_at).toBe('string');
    expect(JSON.parse(rows[0].detail)).toMatchObject({ eligible: 2, archived: 2 });
  });

  it('nothing to archive is still an ok run', async () => {
    answers['leod_sessions.select'] = { data: [] };
    const res = await run();
    expect(res.status).toBe(200);
    expect(runRows()).toHaveLength(1);
    expect(runRows()[0]).toMatchObject({ status: 'ok' });
    expect(JSON.parse(runRows()[0].detail)).toMatchObject({ eligible: 0, archived: 0 });
  });

  it('an archive failure is a failed run, and nothing is deleted', async () => {
    answers['leod_sessions.select'] = { data: [{ id: 'a', seq: 4 }] };
    answers['leod_sessions_archive.upsert'] = { error: { message: "Could not find the 'seq' column" } };
    const res = await run();
    expect(res.status).toBe(500);
    expect(calls.filter(c => c.op === 'delete')).toEqual([]);
    const rows = runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_name: 'session-cleanup', status: 'failed' });
    expect(JSON.parse(rows[0].detail)).toMatchObject({ eligible: 1, archived: 0 });
    expect(rows[0].detail).toContain("'seq' column");
  });

  it('a read failure is a failed run', async () => {
    answers['leod_sessions.select'] = { error: { message: 'timeout' } };
    const res = await run();
    expect(res.status).toBe(500);
    expect(runRows()[0]).toMatchObject({ status: 'failed' });
    expect(runRows()[0].detail).toContain('timeout');
  });

  it('a delete failure is a failed run', async () => {
    answers['leod_sessions.select'] = { data: [{ id: 'a' }] };
    answers['leod_sessions.delete'] = { error: { message: 'fk violation' } };
    const res = await run();
    expect(res.status).toBe(500);
    expect(runRows()[0]).toMatchObject({ status: 'failed' });
    expect(runRows()[0].detail).toContain('fk violation');
  });

  it('if the run row itself cannot be written, the cron answers 500', async () => {
    answers['leod_sessions.select'] = { data: [] };
    answers['leod_checkin_job_runs.insert'] = { error: { message: 'permission denied' } };
    const res = await run();
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('permission denied');
  });
});
