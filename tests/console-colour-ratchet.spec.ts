// tests/console-colour-ratchet.spec.ts
// Ratchet on hard-coded colours in cuedeck-console.html. Every colour belongs
// in :root (spec section 1). The count outside :root may only go down: when a
// change removes literals, lower BUDGET to the printed count in that commit.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BUDGET = 366;
const FILE = resolve(__dirname, '../cuedeck-console.html');
// Hex colours (3, 4, 6, 8 digits) not part of an entity (&#9662;) or an id
// selector with a hyphen (#bc-bar), plus rgb(a)/hsl(a) functions.
const COLOUR = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

export function colourLiteralsOutsideRoot(src: string): string[] {
  const start = src.indexOf(':root {');
  if (start < 0) throw new Error(':root block not found');
  const end = src.indexOf('}', start);
  const rest = src.slice(0, start) + src.slice(end + 1);
  return rest.match(COLOUR) ?? [];
}

describe('console colour ratchet', () => {
  it('counts literals in CSS, inline styles and script strings, but not entities, ids or :root', () => {
    const sample = '<style>:root { --a: #fff; }\n.x{color:#E5E7EB;border:1px solid rgba(1,2,3,.5)}</style>'
      + '<div style="color:#abc"></div><span>&#9662;</span>'
      + "<script>const c = '#0a0e14'; document.querySelector('#bc-bar');</script>";
    expect(colourLiteralsOutsideRoot(sample)).toEqual(['#E5E7EB', 'rgba(1,2,3,.5)', '#abc', '#0a0e14']);
  });

  it('hard-coded colours outside :root do not rise above the budget', () => {
    const found = colourLiteralsOutsideRoot(readFileSync(FILE, 'utf8'));
    console.log(`colour literals outside :root: ${found.length} (budget ${BUDGET})`);
    expect(found.length).toBeLessThanOrEqual(BUDGET);
  });

  it('the budget is kept tight: lower BUDGET when literals are removed', () => {
    const found = colourLiteralsOutsideRoot(readFileSync(FILE, 'utf8'));
    expect(BUDGET - found.length).toBeLessThan(10);
  });
});
