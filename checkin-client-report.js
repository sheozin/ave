// checkin-client-report.js: the client's check-in report as a page,
// /cr/<token> (migration 158), linked from the morning-after email so it
// can be saved as a PDF. Read live from checkin_client_report_view, which
// returns numbers only: no guest, desk or company names. Text nodes only.
// Tested in tests/checkin-client-report-page.spec.ts.

const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
const KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';

export function tokenOf(path) {
  const m = /^\/cr\/([0-9a-f]{32})\/?$/.exec(path);
  return m ? m[1] : null;
}
function fmtDate(ymd) {
  const d = new Date(String(ymd) + 'T12:00:00Z');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function fmtTime(iso, tz) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const o = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try { return d.toLocaleTimeString('en-GB', { ...o, timeZone: tz || 'UTC' }); }
  catch (_) { return d.toLocaleTimeString('en-GB', { ...o, timeZone: 'UTC' }) + ' UTC'; }
}
const n = (v) => Math.max(0, Number(v) || 0);

// What the page says, without a DOM.
export function reportView(r) {
  const ev = r.event || {}, tz = ev.timezone;
  const reg = n(r.registered), inn = n(r.checked_in);
  const turnout = reg > 0 ? Math.round((100 * inn) / reg) : null;
  const peakAt = r.peak && r.peak.t != null ? fmtTime(new Date(Number(r.peak.t) * 1000).toISOString(), tz) : '';
  const first = fmtTime(r.first_arrival_at, tz), last = fmtTime(r.last_arrival_at, tz);
  return {
    title: ev.name || 'Check-in report',
    sub: [ev.date ? fmtDate(ev.date) : '', ev.venue || ''].filter(Boolean).join(', '),
    tiles: [
      { big: String(inn), label: 'of ' + reg + ' checked in' + (turnout === null ? '' : ' (' + turnout + '%)') },
      { big: String(Math.max(0, reg - inn)), label: 'did not arrive' },
      { big: String(n(r.walk_ins)), label: n(r.walk_ins) === 1 ? 'walk-in' : 'walk-ins' },
      { big: String(r.peak ? n(r.peak.n) : 0), label: 'arrived in the busiest 15 minutes' + (peakAt ? ', from ' + peakAt : '') },
    ],
    span: first && last ? 'First arrival ' + first + ', last arrival ' + last + '.' : '',
    tickets: (Array.isArray(r.by_ticket) ? r.by_ticket : []).slice(0, 40).map(t => ({
      name: String(t.ticket_type || ''), inn: n(t.checked_in), reg: n(t.registered),
      pct: n(t.registered) > 0 ? Math.round((100 * n(t.checked_in)) / n(t.registered)) + '%' : '',
    })),
    host: r.host ? 'Shared by ' + r.host : '',
    powered: r.white_label ? '' : 'Check-in by CueDeck',
  };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function message(h, p) {
  const box = el('div', 'msg');
  box.append(el('h1', null, h), el('p', null, p));
  document.getElementById('app').replaceChildren(box);
}
function render(r) {
  const v = reportView(r);
  document.title = 'Check-in report: ' + v.title;
  if (/^#[0-9A-Fa-f]{6}$/.test(r.brand_color || '')) document.documentElement.style.setProperty('--accent', r.brand_color);
  const bar = el('div', 'bar');
  const save = el('button', null, 'Save as PDF'); save.type = 'button'; save.addEventListener('click', () => window.print());
  bar.append(el('p', null, 'Save or print this report. It fits one A4 page.'), save);

  const page = el('article', 'sheet');
  const top = el('div', 'top');
  top.append(el('div', 'kind', 'Check-in report'));
  if (r.logo_path && /^[\w\-./]+$/.test(r.logo_path)) {
    const img = el('img'); img.alt = r.host || ''; img.src = SB + '/storage/v1/object/public/checkin-public/' + r.logo_path;
    img.onerror = () => img.remove();
    top.append(img);
  }
  const head = el('header');
  head.append(el('h1', null, v.title));
  if (v.sub) head.append(el('p', 'sub', v.sub));
  const tiles = el('div', 'tiles');
  for (const t of v.tiles) { const d = el('div', 'tile'); d.append(el('b', null, t.big), el('span', null, t.label)); tiles.append(d); }
  page.append(top, head, tiles);
  if (v.span) page.append(el('p', 'span', v.span));
  if (v.tickets.length) {
    const tbl = el('table');
    const hr = el('tr'); for (const h of ['Ticket type', 'Checked in', 'Registered', 'Turnout']) hr.append(el('th', null, h));
    const thead = el('thead'); thead.append(hr);
    const body = el('tbody');
    for (const t of v.tickets) { const tr = el('tr'); tr.append(el('td', null, t.name), el('td', 'num', String(t.inn)), el('td', 'num', String(t.reg)), el('td', 'num', t.pct)); body.append(tr); }
    tbl.append(thead, body);
    page.append(el('h2', null, 'By ticket type'), tbl);
  }
  const foot = el('footer');
  foot.append(el('span', null, v.host), el('span', null, v.powered));
  page.append(foot);
  document.getElementById('app').replaceChildren(bar, page);
}

async function main() {
  const token = tokenOf(location.pathname);
  const none = () => message('This report is not available', 'The link may be incomplete or older than 90 days. Ask the organizer for a new copy.');
  if (!token) return none();
  let res;
  try {
    res = await fetch(SB + '/rest/v1/rpc/checkin_client_report_view', { method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY }, body: JSON.stringify({ p_token: token }) });
  } catch (_) { return message('Could not load the report', 'Check your connection and reload the page.'); }
  if (!res.ok) return message('Could not load the report', 'Check your connection and reload the page.');
  const r = await res.json().catch(() => null);
  if (!r || !r.event) return none();
  render(r);
}
if (typeof document !== 'undefined' && document.getElementById('app')) main();
