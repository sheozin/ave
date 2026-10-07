// tests/console-i18n-keys.spec.ts
// Every redesign string (cc.*) exists in en, ar, pl and de with the same
// {placeholders}, and no value contains an em-dash.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../cuedeck-i18n.js'), 'utf8');
function block(lang: string): Record<string, string> {
  const start = SRC.indexOf(`\n    ${lang}: {`);
  if (start < 0) throw new Error(`no ${lang} block`);
  const end = SRC.indexOf('\n    },', start);
  const out: Record<string, string> = {};
  for (const m of SRC.slice(start, end).matchAll(/'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'/g)) out[m[1]] = m[2];
  return out;
}
const LANGS = ['en', 'ar', 'pl', 'de'];
const B: Record<string, Record<string, string>> = Object.fromEntries(LANGS.map(l => [l, block(l)]));
const CC = Object.keys(B.en).filter(k => k.startsWith('cc.'));
const ph = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

describe('redesign strings', () => {
  it('there are cc.* keys', () => expect(CC.length).toBeGreaterThan(20));
  for (const lang of ['ar', 'pl', 'de']) {
    it(`every cc.* key exists in ${lang}`, () => expect(CC.filter(k => !(k in B[lang]))).toEqual([]));
  }
  it('placeholders match across languages', () => {
    expect(CC.flatMap(k => ['ar', 'pl', 'de'].filter(l => ph(B[l][k] ?? '') !== ph(B.en[k])).map(l => `${l}:${k}`))).toEqual([]);
  });
  it('no cc.* value contains an em-dash', () => {
    expect(LANGS.flatMap(l => CC.filter(k => (B[l][k] || '').includes('\u2014')).map(k => `${l}:${k}`))).toEqual([]);
  });
});
