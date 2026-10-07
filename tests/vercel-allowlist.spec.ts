// tests/vercel-allowlist.spec.ts
// .vercelignore is an allow-list: a file not named there is not deployed
// and answers 404 in production while working everywhere else. On
// 2026-10-07 the badge designer shipped /checkin-badge.js and /vendor/
// without listing them, and the desk, which imports checkin-badge.js in its
// module block, could not start until the fix. This walks every shipped
// page and script, follows each local reference (script src, stylesheet,
// ES import), and fails for any that would not be deployed.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

const allow = readFileSync('.vercelignore', 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l.startsWith('!/')).map(l => l.slice(2));
const deployed = (p: string) => allow.some(a => p === a || p.startsWith(a + '/'));

function refs(file: string): string[] {
  const s = readFileSync(file, 'utf8');
  const out = new Set<string>();
  for (const re of [/<script[^>]*\bsrc="\/([^"/][^"]*)"/g, /<link[^>]*\bhref="\/([^"/][^"]*\.(?:css|js))"/g,
                    /\bimport\s[^'"]*?from\s*['"]\/([^'"]+)['"]/g, /\bimport\(\s*['"]\/([^'"]+)['"]\s*\)/g]) {
    for (const m of s.matchAll(re)) out.add(m[1].split(/[?#]/)[0]);
  }
  return [...out];
}

describe('every local file a shipped page loads is deployed', () => {
  const seen = new Set<string>();
  const queue = allow.filter(a => /\.(html|js)$/.test(a) && existsSync(a));
  const missing: string[] = [];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const r of refs(f)) {
      if (!deployed(r)) missing.push(`${f} loads /${r}`);
      else if (/\.(js|html)$/.test(r) && existsSync(r)) queue.push(r);
    }
  }
  it('walked the shipped pages', () => { expect(seen.size).toBeGreaterThan(10); });
  it('found nothing missing from .vercelignore', () => { expect(missing).toEqual([]); });
});
