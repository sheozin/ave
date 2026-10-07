// tests/email-i18n.spec.ts
// Every string a guest email template passes to et() exists in every
// language, with the same {placeholders} and no em dashes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { DICT, et, isLang } from '../supabase/functions/_shared/email-i18n.ts';

const files = ['supabase/functions/_shared/qr-email.ts', 'supabase/functions/_shared/registration-confirm-email.ts',
  'supabase/functions/_shared/reminder-email.ts', 'supabase/functions/checkin-invite-guests/index.ts'];
const keys = new Set<string>();
for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bet\(lang, '((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
// The footer label is passed to frame() rather than et() directly.
keys.add('Check-in powered by');
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

describe('guest email translations', () => {
  it('found the email wording', () => { expect(keys.size).toBeGreaterThan(30); });
  for (const lang of ['pl', 'de', 'ar'] as const) {
    it(`${lang}: every string translated, placeholders kept`, () => {
      expect([...keys].filter(k => !(k in DICT[lang]))).toEqual([]);
      expect([...keys].filter(k => ph(k) !== ph(DICT[lang][k]))).toEqual([]);
      expect(Object.values(DICT[lang]).filter(v => v.includes('—'))).toEqual([]);
    });
  }
  it('fills placeholders, falls back to English, checks languages', () => {
    expect(et('de', 'Ticket for {name}: {event}', { name: 'Ola', event: 'Summit' })).toBe('Ticket für Ola: Summit');
    expect(et('pl', 'unknown {x}', { x: 1 })).toBe('unknown 1');
    expect(isLang('ar')).toBe(true); expect(isLang('fr')).toBe(false);
  });
});
