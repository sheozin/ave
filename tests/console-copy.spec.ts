// tests/console-copy.spec.ts
// Spec section 4: sentence case for buttons, menus, titles, toasts and modals;
// uppercase only through CSS; no em-dashes anywhere (console file and i18n).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const I18N = readFileSync(resolve(__dirname, '../cuedeck-i18n.js'), 'utf8');
const HTML = readFileSync(resolve(__dirname, '../cuedeck-console.html'), 'utf8');
function block(lang: string): Record<string, string> {
  const start = I18N.indexOf(`\n    ${lang}: {`);
  const end = I18N.indexOf('\n    },', start);
  const out: Record<string, string> = {};
  for (const m of I18N.slice(start, end).matchAll(/'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'/g)) out[m[1]] = m[2];
  return out;
}
const stripComments = (src: string) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|[\s;{}(,])\/\/.*$/, '$1')).join('\n');
const ACRONYM = /^(AV|CSV|PDF|QR|ID|AI|EN|AR|PL|DE|OK|UTC|VAT|URL|AVE|TV|PIN|SMS)$/;
const STATUS = /^(PLANNED|READY|CALLING|LIVE|OVERRUN|HOLD|ENDED|CANCELLED)$/;
const PROPER = ['Edge Functions', 'AVE Brain'];

describe('copy rules', () => {
  it('no translation in any language contains an em-dash', () => {
    const bad = ['en', 'ar', 'pl', 'de'].flatMap(l => Object.entries(block(l)).filter(([, v]) => v.includes('—')).map(([k]) => `${l}:${k}`));
    expect(bad).toEqual([]);
  });

  it('the console has no em-dash in markup or script strings', () => {
    const src = stripComments(HTML);
    const bad = src.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes('—') || l.includes('\\u2014') || l.includes('&mdash;'));
    expect(bad.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`)).toEqual([]);
  });

  it('English buttons, menus, titles and toasts are sentence case', () => {
    const bad = Object.entries(block('en')).filter(([k, v]) => {
      if (k.startsWith('status.')) return false;   // badge text, uppercased by CSS
      const words = v.replace(/\{\w+\}/g, '').split(/[\s/·:,.()…+–\-!?]+/).filter(Boolean);
      const shouting = words.filter(w => /^[A-Z]{2,}$/.test(w) && !ACRONYM.test(w) && !STATUS.test(w));
      const allCaps = words.length > 0 && words.every(w => /^[A-Z0-9→&']+$/.test(w)) && !words.every(w => ACRONYM.test(w));
      const titleCase = /^[A-Z][a-z]+( [A-Z][a-z]+)+$/.test(v) && !PROPER.includes(v);
      return shouting.length > 0 || allCaps || titleCase;
    }).map(([k, v]) => `${k}=${v}`);
    expect(bad).toEqual([]);
  });
});
