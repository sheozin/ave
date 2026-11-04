// checkin-certificate.js: a guest's certificate of attendance, /c/<token>
// (migration 156). Read live from checkin_certificate, so a check-in that
// was undone, an event back in test mode or certificates switched off
// shows no certificate. Text nodes only: every value came from a guest
// list or an organizer.
//
// It states what CueDeck recorded: checked in, when, which rooms the guest
// was scanned into, and time at the event only where exit scans recorded
// them leaving (migration 159): the server adds up entry-to-exit stays and
// leaves out a stay with no exit. Without exit scans there is no time line.

const SB = 'https://sawekpguemzvuvvulfbc.supabase.co';
const KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';

export const T = {
  en: { kind: 'Certificate of attendance', lead: 'This certifies that', attended: 'attended {event}', at: 'at {venue}', on: 'on {date}',
        checkedIn: 'Checked in at {time}.', rooms: 'Also attended: {rooms}.', by: 'Organized by', check: 'Check this certificate at',
        code: 'Code', save: 'Save as PDF', hint: 'Save or print this certificate. It fits one A4 page.',
        noneH: 'This certificate is not available', noneP: 'The link may be incomplete, or the organizer has not issued certificates for this event.',
        errH: 'Could not load the certificate', errP: 'Check your connection and reload the page.', powered: 'Check-in by CueDeck',
        time: 'Time at the event, from entry and exit scans: {list}.', range: '{from} to {to}', hm: '{h} h {m} min', m: '{m} min', total: 'Total {dur}.' },
  pl: { kind: 'Certyfikat uczestnictwa', lead: 'Niniejszym potwierdza się, że', attended: 'uczestniczył(a) w wydarzeniu {event}', at: 'w miejscu {venue}', on: 'w dniu {date}',
        checkedIn: 'Rejestracja o {time}.', rooms: 'Obecność także na: {rooms}.', by: 'Organizator', check: 'Sprawdź certyfikat pod adresem',
        code: 'Kod', save: 'Zapisz jako PDF', hint: 'Zapisz lub wydrukuj certyfikat. Mieści się na jednej stronie A4.',
        noneH: 'Ten certyfikat jest niedostępny', noneP: 'Link może być niepełny albo organizator nie wydaje certyfikatów dla tego wydarzenia.',
        errH: 'Nie udało się wczytać certyfikatu', errP: 'Sprawdź połączenie i odśwież stronę.', powered: 'Rejestracja: CueDeck',
        time: 'Czas na wydarzeniu według skanów wejścia i wyjścia: {list}.', range: 'od {from} do {to}', hm: '{h} godz. {m} min', m: '{m} min', total: 'Łącznie {dur}.' },
  de: { kind: 'Teilnahmebestätigung', lead: 'Hiermit wird bestätigt, dass', attended: 'an {event} teilgenommen hat', at: 'in {venue}', on: 'am {date}',
        checkedIn: 'Eingecheckt um {time}.', rooms: 'Außerdem anwesend in: {rooms}.', by: 'Veranstalter', check: 'Diese Bestätigung prüfen unter',
        code: 'Code', save: 'Als PDF speichern', hint: 'Speichern oder drucken Sie diese Bestätigung. Sie passt auf eine A4-Seite.',
        noneH: 'Diese Bestätigung ist nicht verfügbar', noneP: 'Der Link ist vielleicht unvollständig, oder der Veranstalter stellt für diese Veranstaltung keine Bestätigungen aus.',
        errH: 'Die Bestätigung konnte nicht geladen werden', errP: 'Prüfen Sie die Verbindung und laden Sie die Seite neu.', powered: 'Check-in mit CueDeck',
        time: 'Zeit auf der Veranstaltung laut Ein- und Ausgangsscans: {list}.', range: '{from} bis {to}', hm: '{h} Std. {m} Min.', m: '{m} Min.', total: 'Insgesamt {dur}.' },
  ar: { kind: 'شهادة حضور', lead: 'نشهد بأن', attended: 'حضر {event}', at: 'في {venue}', on: 'بتاريخ {date}',
        checkedIn: 'سجّل الحضور الساعة {time}.', rooms: 'حضر أيضًا: {rooms}.', by: 'المنظِّم', check: 'تحقق من هذه الشهادة على',
        code: 'الرمز', save: 'حفظ بصيغة PDF', hint: 'احفظ هذه الشهادة أو اطبعها. تتسع في صفحة A4 واحدة.',
        noneH: 'هذه الشهادة غير متاحة', noneP: 'قد يكون الرابط ناقصًا، أو أن المنظِّم لا يصدر شهادات لهذه الفعالية.',
        errH: 'تعذّر تحميل الشهادة', errP: 'تحقق من الاتصال وأعد تحميل الصفحة.', powered: 'تسجيل الحضور عبر CueDeck',
        time: 'الوقت في الفعالية حسب مسح الدخول والخروج: {list}.', range: 'من {from} إلى {to}', hm: '{h} س {m} د', m: '{m} د', total: 'المجموع {dur}.' },
};
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const locale = (l) => (l === 'en' ? 'en-GB' : l);

export function langOf(search) {
  const l = new URLSearchParams(search).get('l');
  return l && T[l] ? l : 'en';
}
export function tokenOf(path) {
  const m = /^\/c\/([0-9a-f]{32})\/?$/.exec(path);
  return m ? m[1] : null;
}
// The calendar date of the event, as the organizer typed it (no zone shift).
export function fmtDate(iso, l) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale(l), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export function fmtTime(iso, tz, l) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const o = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try { return d.toLocaleTimeString(locale(l), { ...o, timeZone: tz || 'UTC' }); }
  catch (_) { return d.toLocaleTimeString(locale(l), { ...o, timeZone: 'UTC' }) + ' UTC'; }
}
export function fmtMinutes(min, l) {
  const t = T[l] || T.en, n = Math.max(0, Math.floor(Number(min) || 0));
  return n >= 60 ? fill(t.hm, { h: Math.floor(n / 60), m: n % 60 }) : fill(t.m, { m: n });
}
// One part per day with a recorded stay; the date only when there are
// several days. Empty when no exit scan closed a stay.
export function timeText(c, l) {
  const t = T[l] || T.en, v = Array.isArray(c.visits) ? c.visits.filter(x => x && x.minutes > 0) : [];
  if (!v.length) return '';
  const sep = l === 'ar' ? '، ' : '; ';
  const parts = v.map(x => (v.length > 1 ? fmtDate(x.day, l) + ', ' : '')
    + fill(t.range, { from: fmtTime(x.from, c.timezone, l), to: fmtTime(x.to, c.timezone, l) }) + ' (' + fmtMinutes(x.minutes, l) + ')');
  const total = v.reduce((n, x) => n + x.minutes, 0);
  return fill(t.time, { list: parts.join(sep) }) + (v.length > 1 ? ' ' + fill(t.total, { dur: fmtMinutes(total, l) }) : '');
}

// What the certificate says, as lines of text: tested without a DOM.
export function certText(c, l) {
  const t = T[l] || T.en;
  const sep = l === 'ar' ? '، ' : ', ';
  const place = [fill(t.attended, { event: c.event }), c.venue ? fill(t.at, { venue: c.venue }) : '', c.date ? fill(t.on, { date: fmtDate(c.date, l) }) : '']
    .filter(Boolean).join(' ') + '.';
  return {
    kind: t.kind, lead: t.lead, name: c.guest, company: c.company || '',
    place,
    checkedIn: c.checked_in_at ? fill(t.checkedIn, { time: fmtTime(c.checked_in_at, c.timezone, l) }) : '',
    rooms: Array.isArray(c.rooms) && c.rooms.length ? fill(t.rooms, { rooms: c.rooms.map(r => r.name).join(sep) }) : '',
    time: timeText(c, l),
    host: c.host || '', by: t.by,
    check: t.check, code: t.code + ' ' + c.code,
    powered: c.white_label ? '' : t.powered,
  };
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function message(l, h, p) {
  const box = el('div', 'msg');
  box.append(el('h1', null, h), el('p', null, p));
  document.getElementById('app').replaceChildren(box);
}
function fit() {
  const cert = document.querySelector('.cert');
  if (!cert) return;
  // A transform shrinks what you see, not the layout box, so the wrapper
  // clips to the scaled size or the phone would scroll sideways.
  const w = cert.offsetWidth, room = document.documentElement.clientWidth - 32;
  const k = Math.min(1, room / w), wrap = cert.parentElement;
  wrap.classList.toggle('scaled', k < 1);
  cert.style.transform = k < 1 ? 'scale(' + k + ')' : '';
  wrap.style.height = k < 1 ? Math.ceil(cert.offsetHeight * k) + 'px' : '';
}

function render(c, l, token) {
  const x = certText(c, l), t = T[l] || T.en;
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
  document.title = x.kind + ': ' + c.guest;
  if (/^#[0-9A-Fa-f]{6}$/.test(c.brand_color || '')) document.documentElement.style.setProperty('--accent', c.brand_color);

  const bar = el('div', 'bar');
  const save = el('button', null, t.save); save.type = 'button'; save.addEventListener('click', () => window.print());
  bar.append(el('p', null, t.hint), save);

  const cert = el('article', 'cert'); cert.setAttribute('aria-label', x.kind);
  const inner = el('div', 'in');
  const top = el('div', 'top');
  top.append(el('div', 'kind', x.kind));
  if (c.logo_path && /^[\w\-./]+$/.test(c.logo_path)) {
    const img = el('img'); img.alt = c.host || ''; img.src = SB + '/storage/v1/object/public/checkin-public/' + c.logo_path;
    img.onerror = () => img.remove();
    top.append(img);
  }
  const mid = el('div', 'mid');
  mid.append(el('p', 'lead', x.lead), el('h1', 'name', x.name));
  if (x.company) mid.append(el('p', 'co', x.company));
  mid.append(el('div', 'rule'), el('p', 'what', x.place + (x.checkedIn ? ' ' + x.checkedIn : '')));
  if (x.rooms) mid.append(el('p', 'rooms', x.rooms));
  if (x.time) mid.append(el('p', 'rooms', x.time));
  const foot = el('div', 'foot');
  const left = el('div');
  if (x.host) left.append(el('div', null, x.by), el('div', 'host', x.host));
  if (x.powered) left.append(el('div', null, x.powered));
  const right = el('div', 'check');
  right.append(el('div', null, x.check), el('div', null, 'app.cuedeck.io/c/' + token), el('div', 'code', x.code));
  foot.append(left, right);
  inner.append(top, mid, foot);
  cert.append(el('div', 'frame'), inner);
  const wrap = el('div', 'wrap'); wrap.append(cert);
  document.getElementById('app').replaceChildren(bar, wrap);
  fit();
  addEventListener('resize', fit);
}

async function main() {
  const l = langOf(location.search), t = T[l];
  const token = tokenOf(location.pathname);
  if (!token) return message(l, t.noneH, t.noneP);
  let r;
  try {
    r = await fetch(SB + '/rest/v1/rpc/checkin_certificate', { method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY }, body: JSON.stringify({ p_token: token }) });
  } catch (_) { return message(l, t.errH, t.errP); }
  if (!r.ok) return message(l, t.errH, t.errP);
  const c = await r.json().catch(() => null);
  if (!c || !c.guest) return message(l, t.noneH, t.noneP);
  render(c, l, token);
}
if (typeof document !== 'undefined' && document.getElementById('app')) main();
