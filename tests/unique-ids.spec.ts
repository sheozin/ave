// tests/unique-ids.spec.ts
// Every id in a shipped page is unique. A second element with the same id
// is silently ignored by getElementById, so a message meant for one panel
// lands in another (2026-10-07: the guest invitations' 'inv-ok' clashed
// with the Team tab's).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const pages = readFileSync('.vercelignore', 'utf8').split('\n').map(l => l.trim())
  .filter(l => /^!\/[^/]+\.html$/.test(l)).map(l => l.slice(2));

describe('ids are unique in each page', () => {
  it('found the pages', () => { expect(pages.length).toBeGreaterThan(5); });
  for (const p of pages) {
    it(p, () => {
      // Static markup only: ids built in scripts are not in the HTML text.
      const html = readFileSync(p, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
      const seen = new Map<string, number>();
      for (const m of html.matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
      expect([...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`)).toEqual([]);
    });
  }
});
