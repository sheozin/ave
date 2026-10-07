// tests/cron-functions-reachable.spec.ts
// pg_cron calls Edge Functions with an x-cron-secret header and no
// Authorization header. A function deployed with JWT verification rejects
// that at the gateway (401 Missing authorization header) before its own
// code runs, while cron.job_run_details still says "succeeded". On
// 2026-10-07 the automatic waitlist (checkin-held) sat behind exactly that.
// Every function a migration schedules must be deployed --no-verify-jwt.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';

const deploy = readFileSync('scripts/deploy-functions.sh', 'utf8');
const noJwt = new Set((deploy.match(/case "\$func" in ([^)]+)\) extra=\(--no-verify-jwt\)/)?.[1] ?? '').split('|'));
const scheduled = new Set<string>();
for (const f of readdirSync('supabase/migrations')) {
  const sql = readFileSync('supabase/migrations/' + f, 'utf8');
  for (const block of sql.split(/cron\.schedule\(/).slice(1)) {
    const m = block.match(/functions\/v1\/([a-z0-9-]+)/);
    if (m) scheduled.add(m[1]);
  }
}

describe('cron-called functions skip gateway JWT verification', () => {
  it('found the scheduled functions', () => { expect(scheduled.size).toBeGreaterThan(3); });
  it('every one is deployed --no-verify-jwt', () => {
    expect([...scheduled].filter(fn => !noJwt.has(fn))).toEqual([]);
  });
});
