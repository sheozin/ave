// tests/operators.spec.ts
// Runs the operator suite (tests/deno/operators.test.ts)
// under deno. Same rule as checkin-function-gates.spec.ts: a local machine
// without deno skips visibly, CI installs deno and must never skip.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const hasDeno = spawnSync('deno', ['--version']).status === 0;
describe.skipIf(!hasDeno && !process.env.CI)('operator invite and management (deno)', () => {
  it('tests/deno/operators.test.ts passes', () => {
    expect(hasDeno, 'deno is not installed; CI must install it (denoland/setup-deno)').toBe(true);
    const r = spawnSync('deno', ['test', '--allow-env', '--allow-read', '--no-lock', 'tests/deno/operators.test.ts'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, (r.stdout ?? '') + (r.stderr ?? '')).toBe(0);
  }, 130_000);
});
