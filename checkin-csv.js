// checkin-csv.js: guest-list CSV parsing for the setup page.
// Validation of each row happens server-side in checkin-import-attendees
// (dry run first); this only turns a spreadsheet export into rows.

export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const out = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) out.push(row);
  return out;
}

const ALIASES = {
  first_name: ['first name', 'firstname', 'first', 'given name', 'forename', 'imie', 'imię', 'vorname', 'prenom', 'prénom'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name', 'nazwisko', 'nachname', 'nom'],
  email: ['email', 'e-mail', 'email address', 'mail', 'adres email'],
  company: ['company', 'organisation', 'organization', 'org', 'firma', 'employer', 'unternehmen', 'societe', 'société'],
  role_title: ['title', 'job title', 'role', 'position', 'stanowisko', 'job'],
  ticket_type: ['ticket', 'ticket type', 'type', 'category', 'pass', 'badge type'],
  external_ref: ['id', 'external id', 'ref', 'reference', 'registration id', 'order id'],
};

function norm(h) { return h.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' '); }

export function mapRows(table) {
  if (!table.length) return { rows: [], unmapped: [], missing: ['first_name', 'last_name'] };
  const header = table[0];
  const colFor = {};
  const unmapped = [];
  header.forEach((h, i) => {
    const n = norm(h);
    const key = Object.keys(ALIASES).find(k => k === n.replace(/ /g, '_') || ALIASES[k].some(a => norm(a) === n));
    if (key && colFor[key] === undefined) colFor[key] = i; else unmapped.push(h);
  });
  const missing = ['first_name', 'last_name'].filter(k => colFor[k] === undefined);
  const rows = [];
  for (const r of table.slice(1)) {
    if (!r.some(f => f.trim() !== '')) continue;
    const o = {};
    for (const [k, i] of Object.entries(colFor)) { const v = (r[i] ?? '').trim(); if (v) o[k] = v; }
    rows.push(o);
  }
  return { rows, unmapped, missing };
}

// Rows to CSV text for Excel. ';' by default because organizers in PL/DE
// open CSVs in Excel with that locale. A cell starting with = + - @ tab
// or CR would run as a formula, and guest names come from kiosks and
// imports, so such a cell gets a leading apostrophe.
export function toCsv(rows, sep = ';') {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return s.includes('"') || s.includes(sep) || /[\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map(r => r.map(cell).join(sep)).join('\r\n');
}
