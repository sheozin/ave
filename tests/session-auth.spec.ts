// tests/session-auth.spec.ts
// Runs the session auth suite (tests/deno/session-auth.test.ts)
// under deno. Same rule as checkin-function-gates.spec.ts: a local machine
// without deno skips visibly, CI installs deno and must never skip.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const hasDeno = spawnSync('deno', ['--version']).status === 0;
describe.skipIf(!hasDeno && !process.env.CI)('session auth in the Edge Functions (deno)', () => {
  it('tests/deno/session-auth.test.ts passes', () => {
    expect(hasDeno, 'deno is not installed; CI must install it (denoland/setup-deno)').toBe(true);
    const r = spawnSync('deno', ['test', '--allow-env', '--allow-read', '--no-lock', 'tests/deno/session-auth.test.ts'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, (r.stdout ?? '') + (r.stderr ?? '')).toBe(0);
  }, 130_000);
});
