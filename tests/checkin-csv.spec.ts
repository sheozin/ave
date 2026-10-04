import { describe, it, expect } from 'vitest';
import { parseCsv, mapRows, toCsv } from '../checkin-csv.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
  it('strips a UTF-8 BOM and skips blank lines', () => {
    expect(parseCsv('\uFEFFa,b\n\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('detects semicolon CSV from Excel in PL/DE locales', () => {
    expect(parseCsv('first name;last name\nAna;Nowak\n')).toEqual([['first name', 'last name'], ['Ana', 'Nowak']]);
  });
});

describe('mapRows', () => {
  it('maps common header spellings', () => {
    const r = mapRows([['First Name', 'Surname', 'E-mail', 'Organisation', 'Job title', 'Ticket', 'ID'],
                       ['Ana', 'Nowak', 'ana@x.pl', 'Acme', 'CTO', 'VIP', '17']]);
    expect(r.rows).toEqual([{ first_name: 'Ana', last_name: 'Nowak', email: 'ana@x.pl', company: 'Acme', role_title: 'CTO', ticket_type: 'VIP', external_ref: '17' }]);
    expect(r.missing).toEqual([]);
  });
  it('reports missing required columns', () => {
    expect(mapRows([['Email'], ['a@b.c']]).missing).toEqual(['first_name', 'last_name']);
  });
  it('lists columns it ignored', () => {
    expect(mapRows([['first name', 'last name', 'Diet'], ['A', 'B', 'vegan']]).unmapped).toEqual(['Diet']);
  });
  it('drops rows that are entirely empty', () => {
    expect(mapRows([['first name', 'last name'], ['', ''], ['A', 'B']]).rows).toHaveLength(1);
  });
});

describe('toCsv', () => {
  it('neutralises spreadsheet formulas', () => {
    for (const p of ['=', '+', '-', '@', '\t', '\r']) {
      const out = toCsv([[p + 'HYPERLINK("http://x")']]);
      expect(out.replace(/^"/, '').startsWith("'" + p)).toBe(true);
    }
  });
  it('quotes the separator, quotes and newlines', () => {
    expect(toCsv([['a;b', 'say "hi"', 'x\ny', 'plain']])).toBe('"a;b";"say ""hi""";"x\ny";plain');
  });
  it('writes null and undefined as empty cells and joins rows with CRLF', () => {
    expect(toCsv([['a', null, undefined], ['b', '', 'c']])).toBe('a;;\r\nb;;c');
  });
  it('round-trips a normal row through parseCsv', () => {
    const rows = [['First name', 'Last name', 'Email'], ['Ana', 'Nowak; Jr', 'ana@x.pl']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
