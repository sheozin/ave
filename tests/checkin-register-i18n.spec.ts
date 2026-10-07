// tests/checkin-register-i18n.spec.ts
// Every piece of CueDeck wording on the registration page exists in every
// language, with the same {placeholders}. A new string added to the page
// without its translations fails here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { DICT, UNTRANSLATED, PAGE_LANGS, pickLang, translate } from '../checkin-register-i18n.js';

const js = readFileSync('cuedeck-register.js', 'utf8');
const html = readFileSync('cuedeck-register.html', 'utf8');
const shared = readFileSync('checkin-register.js', 'utf8');

const keys = new Set<string>();
for (const m of js.matchAll(/\btr\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
const body = html.slice(html.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
for (const m of body.matchAll(/>([^<>]+)</g)) { const t = m[1].replace(/\s+/g, ' ').trim(); if (/[A-Za-z]{2,}/.test(t)) keys.add(t); }
for (const m of body.matchAll(/(?:placeholder|aria-label|alt|title)="([^"]+)"/g)) if (/[A-Za-z]{2,}/.test(m[1])) keys.add(m[1]);
// Form error messages come from the shared rules (fieldMessage).
const fm = shared.slice(shared.indexOf('export function fieldMessage'), shared.indexOf('export function formatEventDate'));
for (const m of fm.matchAll(/'([A-Z][^']*\.)'/g)) keys.add(m[1]);
for (const u of UNTRANSLATED) keys.delete(u);

const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

describe('registration page translations', () => {
  it('found the page wording', () => { expect(keys.size).toBeGreaterThan(150); });
  for (const lang of PAGE_LANGS.filter(l => l !== 'en')) {
    it(`${lang}: every string translated`, () => {
      expect([...keys].filter(k => !(k in DICT[lang]))).toEqual([]);
    });
    it(`${lang}: placeholders kept`, () => {
      expect([...keys].filter(k => k in DICT[lang] && ph(k) !== ph(DICT[lang][k]))).toEqual([]);
    });
    it(`${lang}: no em dashes`, () => {
      expect(Object.values(DICT[lang]).filter(v => v.includes('—'))).toEqual([]);
    });
  }
});

describe('language choice', () => {
  it('a fixed setting wins; auto follows the browser; else English', () => {
    expect(pickLang('pl', ['de-DE'])).toBe('pl');
    expect(pickLang('auto', ['fr-FR', 'de-AT'])).toBe('de');
    expect(pickLang('auto', ['ar-EG'])).toBe('ar');
    expect(pickLang('auto', ['fr-FR'])).toBe('en');
  });
  it('fills placeholders and falls back to English', () => {
    expect(translate('de', 'You are registered, {name}', { name: 'Maya' })).toBe('Maya, Sie sind angemeldet');
    expect(translate('pl', 'Not a key {x}', { x: 1 })).toBe('Not a key 1');
  });
});
