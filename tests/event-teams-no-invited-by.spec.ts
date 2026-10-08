// tests/event-teams-no-invited-by.spec.ts
// Event teams (spec 2026-10-08 §3, §7): access never comes from
// leod_users.invited_by. The database side is cuedeck_guard_results()
// (migration 132); this is the code side: no Edge Function, console page or
// agent reads it. The one line left is the membership row's own "added by"
// column, written by invite-operator. Comment lines are not code.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const SOURCES = [
  ...walk(join(ROOT, 'supabase/functions')).filter(f => f.endsWith('.ts')),
  ...readdirSync(ROOT).filter(f => /^cuedeck-.*\.(html|js)$/.test(f)).map(f => join(ROOT, f)),
];
const ALLOWED: Record<string, RegExp> = {
  'supabase/functions/invite-operator/index.ts': /invited_by: user\.id/,
};
const COMMENT = /^\s*(\/\/|\*|\/\*|<!--|--)/;

describe('no code path reads leod_users.invited_by', () => {
  it('scans the Edge Functions and every console page', () => {
    expect(SOURCES.filter(f => f.endsWith('.ts')).length).toBeGreaterThan(30);
    expect(SOURCES.some(f => f.endsWith('cuedeck-console.html'))).toBe(true);
  });
  it('only the membership write in invite-operator names invited_by', () => {
    const bad: string[] = [];
    for (const f of SOURCES) {
      const rel = relative(ROOT, f);
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!line.includes('invited_by') || COMMENT.test(line)) return;
        if (ALLOWED[rel]?.test(line)) return;
        bad.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
