// E2E specs must run on any machine: CI serves the app on 127.0.0.1:7230
// and has no one's home directory or Claude scratchpad. Two specs failed on
// every CI run for 15 days (2026-10-07 to 10-22) because one routed a page
// at a local preview port (7271) and another saved a screenshot into a
// session scratchpad. This fails on any such path or port.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, 'e2e');
const BAD = [
  { re: /\/private\/tmp\//, why: 'a temp path on one machine' },
  { re: /\/Users\/[^/'"`\s]+/, why: 'a home directory on one machine' },
  { re: /(?:127\.0\.0\.1|localhost):(?!7230\b)\d+/, why: 'a local port other than CI\'s 7230' },
];

describe('E2E specs are portable', () => {
  const files = readdirSync(DIR).filter(f => f.endsWith('.ts'));
  it('finds the specs (never passes by reading nothing)', () => {
    expect(files.length).toBeGreaterThan(10);
  });
  it('contain no machine-specific paths or ports', () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(DIR, f), 'utf8').split('\n').forEach((line, i) => {
        for (const b of BAD) if (b.re.test(line)) hits.push(`${f}:${i + 1} ${b.why}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
