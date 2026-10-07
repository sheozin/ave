// cuedeck-register.js: the public registration page (/r/<code>), kept out
// of the HTML so the page runs under a CSP with no inline script. Rules and
// pure helpers come from /checkin-register.js; the server is
// checkin-register. Design approved 2026-10-06.
import {
  validateRegistration, validatePlusOnes, fieldMessage, formatEventDate, isRegistrationCode,
  palette, tzLabel, initials, buildIcs, googleCalUrl, outlookCalUrl, mapsUrl,
} from '/checkin-register.js';
import { pickLang, translate, RTL, UNTRANSLATED } from '/checkin-register-i18n.js';

// ── language (checkin-register-i18n.js) ──
// The guest's browser language until the event says otherwise (Event admin,
// Registration, "Page language").
let LANG = pickLang('auto', navigator.languages);
const tr = (s, vars) => translate(LANG, s, vars);
function setLang(setting) {
  LANG = pickLang(setting, navigator.languages);
  document.documentElement.lang = LANG;
  document.documentElement.dir = RTL.has(LANG) ? 'rtl' : 'ltr';
  translateStatic();
}
// The page's own markup: text and the attributes people hear or read.
// Each node remembers its English source, so a second pass is harmless.
function translateStatic() {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const src = n.__en ?? (n.__en = n.nodeValue);
    const key = src.replace(/\s+/g, ' ').trim();
    if (!key || UNTRANSLATED.has(key) || /^[\d\s·×–-]*$/.test(key)) continue;
    const out = tr(key);
    if (out !== key) n.nodeValue = src.replace(src.trim(), out);
    else if (n.nodeValue !== src) n.nodeValue = src;
  }
  for (const el of document.querySelectorAll('[placeholder],[aria-label],[alt],[title]')) {
    for (const a of ['placeholder', 'aria-label', 'alt', 'title']) {
      if (!el.hasAttribute(a)) continue;
      const k = '__en_' + a; if (!(k in el)) el[k] = el.getAttribute(a);
      el.setAttribute(a, tr(el[k]));
    }
  }
}
// Dates in the page's language; English keeps its own hand-built form.
function fmtDate(iso, short) {
  if (!iso) return '';
  if (LANG === 'en') { const f = formatEventDate(iso); return short ? f.replace(/^(\w{3})\w*/, '$1') : f; }
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(LANG, { weekday: short ? 'short' : 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
// The time zone in the page's language: the browser's own name for it
// ("Mitteleuropäische Zeit"), else "<city> time" translated.
const tzText = (tz) => {
  const en = tzLabel(tz);
  if (!en || LANG === 'en') return en;
  try {
    const n = new Intl.DateTimeFormat(LANG, { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName');
    if (n && n.value) return n.value;
  } catch { /* older browser */ }
  return tr('{city} time', { city: en.replace(/ time$/, '') });
};
const COMMA = () => LANG === 'ar' ? '، ' : ', ';

const FN = 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-register';
const KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';
const $ = (id) => document.getElementById(id);
const money = (cents, cur) => {
  try { return new Intl.NumberFormat(navigator.language || 'en-GB', { style: 'currency', currency: String(cur).toUpperCase() }).format(cents / 100); }
  catch { return (cents / 100).toFixed(2) + ' ' + String(cur).toUpperCase(); }
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// /r/<code> (the page) or /e/<code> (embedded on the organizer's site), or
// ?code= when served from a dev server without the rewrite.
const code = (location.pathname.match(/^\/[re]\/([^/]+)\/?$/) || [])[1] || new URLSearchParams(location.search).get('code') || '';
// Embedded: the form card only, its height reported to the host page
// (/embed.js). Links from emails (#t=, #i=) and payment never run framed:
// they open on CueDeck's own page, where nobody can overlay them.
const EMBED = /^\/e\//.test(location.pathname) || new URLSearchParams(location.search).get('embed') === '1';
if (EMBED) {
  document.documentElement.classList.add('embed');
  document.body.classList.add('embed');
  for (const a of document.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener'; }
  const post = () => { try { parent.postMessage({ type: 'cuedeck:height', height: Math.ceil(document.documentElement.scrollHeight) }, '*'); } catch { /* not framed */ } };
  new ResizeObserver(post).observe(document.documentElement);
  addEventListener('load', post);
}
// The emailed link carries its token in the fragment (#t=), which browsers never send to a server.
let token = EMBED ? '' : new URLSearchParams(location.hash.slice(1)).get('t') || '';
// (116) A personal invitation link: /r/<code>#i=<token>.
const inviteToken = EMBED ? '' : new URLSearchParams(location.hash.slice(1)).get('i') || '';
// Back from Stripe Checkout (paid tickets): the link's token was kept in
// this tab while the guest paid, so the page can finish the order.
const back = new URLSearchParams(location.search);
const PAY_KEY = 'cuedeck-pay:' + code;
const fromStripe = EMBED ? null : back.has('paid') ? 'paid' : back.has('unpaid') ? 'unpaid' : null;
if (!token && fromStripe) { try { token = sessionStorage.getItem(PAY_KEY) || ''; } catch { /* storage blocked */ } }
let config = null;

async function call(body) {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY }, body: JSON.stringify({ ...body, code, lang: LANG }) });
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: j || {} };
}

function el(tag, attrs, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

// ── states ──
// Before the event loads (or for a dead link) the page is one message.
// Once it loads, the event stays on screen and the card changes.
function solo(h, p) {
  $('closed-h').textContent = h; $('closed-p').textContent = p;
  $('loading').hidden = true; $('page').hidden = true; $('closed').hidden = false;
}
function card(id) {
  for (const s of ['open', 'invite', 'confirm', 'done', 'ticket', 'shut']) $(s).hidden = s !== id;
  if (!EMBED && window.matchMedia('(max-width: 900px)').matches && id !== 'open') $('card-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closed(h, p) {
  if (!config) return solo(h, p);
  $('shut-h').textContent = h; $('shut-p').textContent = p;
  // Kept in sync for anything reading the old element.
  $('closed-h').textContent = h; $('closed-p').textContent = p;
  card('shut');
}
const NOT_ACTIVE = () => [tr('This registration link is not active'), tr('Check the link with the event organizer.')];

// ── the event page ──
function calInfo() {
  const e = config.event, pg = config.page;
  if (!e.start_utc) return null;
  return {
    uid: code + '@app.cuedeck.io', title: e.name, startUtc: e.start_utc, endUtc: e.end_utc,
    location: [e.venue, pg.address].filter(Boolean).join(', '),
    description: 'Registration: https://app.cuedeck.io/r/' + code, details: 'https://app.cuedeck.io/r/' + code,
    url: 'https://app.cuedeck.io/r/' + code,
  };
}
function downloadIcs() {
  const c = calInfo(); if (!c) return;
  const blob = new Blob([buildIcs(c)], { type: 'text/calendar;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: (config.event.name || 'event').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.ics' });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderEvent() {
  const e = config.event || {}, pg = config.page || {};
  const pal = palette(pg.brand_color);
  const root = document.documentElement.style;
  root.setProperty('--accent', pal.accent); root.setProperty('--accent-soft', pal.soft);
  root.setProperty('--accent-ink', pal.ink); root.setProperty('--accent-deep', pal.deep);
  document.querySelector('meta[name=theme-color]').setAttribute('content', '#F6F5F2');
  document.title = tr('Register: {event}', { event: e.name || '' });

  const host = pg.host_name || '';
  $('host-name').textContent = host || e.name || 'Event';
  $('mark').replaceChildren();
  if (pg.logo_url) $('mark').append(el('img', { src: pg.logo_url, alt: host ? tr('{host} logo', { host }) : tr('Organizer logo') }));
  else $('mark').textContent = initials(host || e.name);

  // No cover: a short band in the brand colour, not a second copy of the title.
  $('cover').classList.toggle('none', !pg.cover_url);
  if (pg.cover_url) { $('cover-img').src = pg.cover_url; $('cover-img').alt = e.name || ''; $('cover-img').hidden = false; }
  else $('cover-img').hidden = true;
  $('cover-ph').hidden = true;
  $('ev-name').textContent = e.name || 'Event';
  $('test-chip').hidden = !config.test;

  const d = e.date ? new Date(e.date + 'T00:00:00Z') : null;
  $('cal-m').textContent = d ? (LANG === 'en' ? MONTHS[d.getUTCMonth()] : d.toLocaleDateString(LANG, { month: 'short', timeZone: 'UTC' }).replace('.', '').toUpperCase()) : '';
  $('cal-d').textContent = d ? String(d.getUTCDate()) : '';
  $('ev-meta').textContent = fmtDate(e.date) || tr('Date to be announced');
  $('ev-time').textContent = e.start ? (e.end ? tr('{start} to {end}', { start: e.start, end: e.end }) : e.start) + (tzText(e.timezone) ? COMMA() + tzText(e.timezone) : '') : '';
  const c = calInfo();
  $('cal-btn').hidden = !c;
  if (c) { $('cal-google').href = googleCalUrl(c); $('cal-outlook').href = outlookCalUrl(c); $('cal-outlook').target = '_blank'; $('cal-outlook').rel = 'noopener'; }

  $('fact-venue').hidden = !(e.venue || pg.address);
  $('venue').textContent = e.venue || pg.address || '';
  $('address').textContent = e.venue && pg.address ? pg.address : '';
  const m = mapsUrl(e.venue, pg.address);
  $('maps').hidden = !m; if (m) $('maps').href = m;

  $('about').hidden = !pg.description; $('about-p').textContent = pg.description || '';
  const rows = Array.isArray(pg.programme) ? pg.programme : [];
  $('prog').hidden = !rows.length;
  $('plist').replaceChildren(...rows.map(r => {
    const row = el('div', { class: 'prow' });
    const body = el('div', { style: 'min-width:0' });
    body.append(el('b', null, r.title || ''));
    const sub = [r.speaker, r.room].filter(Boolean).join(' · ');
    if (sub) body.append(el('small', null, sub));
    row.append(el('span', { class: 't' }, r.time || ''), body);
    return row;
  }));

  // (108) Full with a waitlist: the same form, joining the waitlist.
  const wl = config.state === 'waitlist';
  // (116) Invite-only with approval: the form asks for an invitation.
  const ask = config.mode === 'invite';
  document.querySelector('#open .card-h h2').textContent = ask ? tr('Request an invitation') : wl ? tr('Join the waitlist') : tr('Register');
  $('submit').textContent = submitLabel();
  $('flow-note').hidden = !(wl || config.approval);
  $('flow-note').textContent = ask
    ? tr('This event is by invitation. Send a request and the organizer will reply. Your ticket is emailed to you if they invite you.')
    : wl ? tr('This event is full. Join the waitlist and your ticket is emailed to you if a place opens up.')
    : tr('The organizer reviews each registration. Your ticket is emailed to you once it is approved.');
  $('left').hidden = config.places_left == null || wl;
  $('left').textContent = config.places_left == null ? '' : config.places_left === 1 ? tr('1 place left') : tr('{n} places left', { n: config.places_left });
  $('test-note').hidden = !config.test;
  // The consent names "the organizer", not the host shown on the page: the
  // host may be a client brand, while the organizer is the data controller.

  $('loading').hidden = true; $('closed').hidden = true; $('page').hidden = false;
}

$('cal-btn').addEventListener('click', () => {
  const open = $('cal-menu').hidden;
  $('cal-menu').hidden = !open; $('cal-btn').setAttribute('aria-expanded', String(open));
});
$('cal-ics').addEventListener('click', (ev) => { ev.preventDefault(); downloadIcs(); });
$('tk-cal').addEventListener('click', downloadIcs);
$('share').addEventListener('click', async () => {
  const url = 'https://app.cuedeck.io/r/' + code;
  try {
    if (navigator.share) { await navigator.share({ title: config?.event?.name || tr('Register'), url }); return; }
    await navigator.clipboard.writeText(url);
    $('share-t').textContent = tr('Link copied');
  } catch { $('share-t').textContent = tr('Share'); return; }
  setTimeout(() => { $('share-t').textContent = tr('Share'); }, 1800);
});

// ── questions ──
function renderQuestions(questions) {
  const box = $('questions');
  box.replaceChildren();
  for (const q of questions) {
    if (q.type === 'choice' && q.options.length <= 4) {
      // Up to four options read better as buttons than as a dropdown.
      const fs = el('fieldset', { 'data-f': 'q:' + q.id, style: 'border:0;margin:0;padding:0;display:grid;gap:8px' });
      const lg = el('legend', { dir: 'auto', style: 'font-size:14px;font-weight:600;padding:0;margin-bottom:8px' }, q.label);
      if (!q.required) { lg.append(' '); lg.append(el('span', { class: 'opt' }, tr('(optional)'))); }
      const grid = el('div', { class: 'choices' });
      const hidden = el('input', { type: 'hidden', name: 'q:' + q.id, value: '' });
      for (const o of q.options) {
        const b = el('button', { type: 'button', class: 'choice', 'aria-pressed': 'false' }, o);
        b.addEventListener('click', () => {
          const on = hidden.value !== o;
          hidden.value = on ? o : '';
          for (const x of grid.children) x.setAttribute('aria-pressed', String(on && x === b));
        });
        grid.append(b);
      }
      fs.append(lg, grid, hidden, el('span', { class: 'err' }));
      box.append(fs);
      continue;
    }
    const lab = el('label', { class: 'f', 'data-f': 'q:' + q.id });
    const lt = el('span', { class: 'lt', dir: 'auto' }, q.label);
    if (!q.required) { lt.append(' '); lt.append(el('span', { class: 'opt' }, tr('(optional)'))); }
    let input;
    if (q.type === 'choice') {
      input = el('select', { name: 'q:' + q.id });
      input.append(el('option', { value: '' }, tr('Choose…')));
      for (const o of q.options) input.append(el('option', { value: o }, o));
    } else {
      input = el('input', { type: 'text', name: 'q:' + q.id, maxlength: '500', autocomplete: 'off' });
    }
    lab.append(lt, input, el('span', { class: 'err' }));
    box.append(lab);
  }
}

// ── Turnstile ──
// A token can still be on its way when the guest presses Register (the
// widget is invisible unless Cloudflare wants a click), so submit waits for
// it, as the sign-in pages do (cuedeck-auth.js).
let tsWidget = null, tsToken = '', tsWaiters = [], tsFailed = false;
function tsSettle(t) { const w = tsWaiters; tsWaiters = []; w.forEach(r => r(t)); }
function turnstileToken() {
  if (tsToken) return Promise.resolve(tsToken);
  if (tsFailed) return Promise.resolve('');
  return new Promise((resolve) => {
    tsWaiters.push(resolve);
    setTimeout(() => { const i = tsWaiters.indexOf(resolve); if (i >= 0) { tsWaiters.splice(i, 1); resolve(''); } }, 30000);
  });
}
function loadTurnstile(siteKey) {
  return new Promise((resolve) => {
    window.onTurnstileLoad = () => {
      tsWidget = window.turnstile.render('#ts', {
        sitekey: siteKey, action: 'register', appearance: 'interaction-only',
        callback: (t) => { tsToken = t; tsFailed = false; tsSettle(t); },
        'expired-callback': () => { tsToken = ''; },
        'error-callback': () => { tsToken = ''; tsFailed = true; tsSettle(''); },
      });
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
    s.async = true;
    s.onerror = () => { tsFailed = true; tsSettle(''); resolve(); };
    document.head.append(s);
  });
}

const submitLabel = () => config.mode === 'invite' ? tr('Send my request') : config.state === 'waitlist' ? tr('Join the waitlist') : tr('Register');

// ── plus-ones (migration 114) ──
// Hidden for a paid ticket: each person buys their own.
function plusAllowed() {
  const max = config.plus_ones || 0;
  const tid = $('form').elements.ticket_type_id ? $('form').elements.ticket_type_id.value : '';
  const t = (config.tickets || []).find(x => x.id === tid);
  return t && t.price_cents > 0 && !config.test ? 0 : max;
}
function renderPlus() {
  const max = plusAllowed();
  $('plus').hidden = !max;
  if (!max) { $('plus-rows').replaceChildren(); return; }
  $('plus-max').textContent = tr('(up to {n})', { n: max });
  while ($('plus-rows').children.length > max) $('plus-rows').lastElementChild.remove();
  $('plus-add').hidden = $('plus-rows').children.length >= max;
}
function addPlusRow() {
  const i = $('plus-rows').children.length;
  const row = el('div', { class: 'plus-row', 'data-f': 'plus:' + i });
  const f = el('input', { type: 'text', maxlength: '80', autocomplete: 'off', placeholder: tr('First name'), 'aria-label': tr('Guest {n} first name', { n: i + 1 }) });
  const l = el('input', { type: 'text', maxlength: '80', autocomplete: 'off', placeholder: tr('Last name'), 'aria-label': tr('Guest {n} last name', { n: i + 1 }) });
  const x = el('button', { type: 'button', class: 'x', 'aria-label': tr('Remove guest {n}', { n: i + 1 }) }, '×');
  x.addEventListener('click', () => { row.remove(); [...$('plus-rows').children].forEach((r, k) => r.setAttribute('data-f', 'plus:' + k)); renderPlus(); });
  row.append(f, l, x);
  $('plus-rows').append(row);
  renderPlus();
  f.focus();
}
$('plus-add').addEventListener('click', addPlusRow);
function plusValues() {
  return [...$('plus-rows').children].map(r => { const [f, l] = r.querySelectorAll('input'); return { first_name: f.value, last_name: l.value }; });
}

// ── tickets (paid tickets, migration 109) ──
function renderTickets(list) {
  const box = $('tix-list');
  box.replaceChildren();
  $('tix').hidden = !list.length;
  if (!list.length) return;
  const hidden = el('input', { type: 'hidden', name: 'ticket_type_id', value: '' });
  box.append(hidden);
  const pick = (t, b) => {
    hidden.value = t.id;
    for (const x of box.querySelectorAll('.tix-o')) x.setAttribute('aria-checked', String(x === b));
    $('tix-pay').hidden = !(t.price && !config.test);
    renderPlus();
    $('tix').classList.remove('bad'); $('tix').querySelector('.err').textContent = '';
  };
  const buyable = list.filter(t => !t.sold_out && t.on_sale);
  for (const t of list) {
    const off = t.sold_out || !t.on_sale;
    const b = el('button', { type: 'button', class: 'tix-o', role: 'radio', 'aria-checked': 'false' });
    if (off) b.disabled = true;
    const nm = el('span', { class: 'nm' });
    nm.append(el('b', { dir: 'auto' }, t.name));
    const sub = t.sold_out ? tr('Sold out') : !t.on_sale ? tr('Not on sale yet') : [t.description, t.left ? tr('{n} left', { n: t.left }) : ''].filter(Boolean).join(' · ');
    if (sub) nm.append(el('small', null, sub));
    b.append(el('span', { class: 'dot', 'aria-hidden': 'true' }), nm, el('span', { class: 'pr' }, t.price || tr('Free')));
    b.addEventListener('click', () => pick(t, b));
    box.append(b);
  }
  // One choice on sale: picked for the guest.
  if (buyable.length === 1) pick(buyable[0], box.querySelectorAll('.tix-o')[list.indexOf(buyable[0])]);
}
function ticketMissing() {
  const tx = config.tickets || [];
  if (!tx.length || $('form').elements.ticket_type_id.value) return false;
  $('tix').classList.add('bad'); $('tix').querySelector('.err').textContent = tr('Choose a ticket.');
  $('tix').querySelector('.tix-o:not([disabled])')?.focus();
  return true;
}

// ── form ──
function clearErrors() {
  for (const l of document.querySelectorAll('[data-f]')) {
    l.classList.remove('bad');
    const e = l.querySelector('.err'); if (e) e.textContent = '';
  }
  $('msg').hidden = true;
}
function markErrors(codes) {
  let first = null;
  for (const c of codes) {
    const m = fieldMessage(c);
    const l = document.querySelector(`[data-f="${CSS.escape(m.field || '')}"]`);
    if (!l) continue;
    l.classList.add('bad');
    const e = l.querySelector('.err'); if (e) e.textContent = tr(m.text);
    first = first || l;
  }
  if (first) (first.querySelector('input:not([type=hidden]),select,button') || first).focus();
}
function formValues() {
  const f = $('form');
  const answers = {};
  for (const q of config.questions) answers[q.id] = f.elements['q:' + q.id]?.value ?? '';
  return {
    first_name: f.elements.first_name.value, last_name: f.elements.last_name.value,
    email: f.elements.email.value, company: f.elements.company.value,
    answers, consent: f.elements.consent.checked,
    ticket_type_id: f.elements.ticket_type_id ? f.elements.ticket_type_id.value : '',
    plus_ones: plusAllowed() ? plusValues() : [],
  };
}
function message(text) { $('msg').textContent = text; $('msg').hidden = false; }

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearErrors();
  const v = formValues();
  const { errors } = validateRegistration(v, config.questions);
  const noTicket = ticketMissing();
  const plusErr = validatePlusOnes(v.plus_ones, plusAllowed()).errors;
  if (errors.length || plusErr.length) markErrors([...errors, ...plusErr]);
  if (plusErr.length) $('plus').querySelector('.err').textContent = plusErr.includes('plus_too_many') ? tr('That is more guests than this event allows.') : tr('Please enter each guest\'s first and last name in letters.');
  if (noTicket || errors.length || plusErr.length) return;
  const btn = $('submit');
  btn.disabled = true; btn.textContent = tr('Registering…');
  try {
    const t = await turnstileToken();
    if (!t) { message(tr('The security check did not finish. Reload the page and try again.')); return; }
    const r = await call({ action: 'register', ...v, website: $('form').elements.website.value, turnstile_token: t });
    const b = r.body;
    if (r.status === 200 && b.status === 'check_email') { card('done'); return; }
    if (r.status === 200 && b.status === 'ok') {
      if (b.test && b.held) {
        $('done-h').textContent = b.held === 'waitlist' ? tr('Added to the waitlist (test)') : tr('Awaiting approval (test)');
        $('done-p').textContent = tr('Test mode sends no email. The organizer finds this guest in the Event admin, under Registration.');
      } else if (b.test) {
        $('done-h').textContent = tr('Test registration recorded');
        $('done-p').textContent = tr('Test mode sends no email. The organizer finds this guest in Setup, under Attendees, and test guests are cleared when the event goes live.');
      }
      card('done');
      return;
    }
    if (b.status === 'full') return closed(tr('Registration is full'), tr('This event has reached its capacity. Contact the organizer if you need a place.'));
    if (b.status === 'closed') return closed(tr('Registration has closed'), tr('Contact the organizer if you still need to attend.'));
    if (b.status === 'test_cap') return message(tr('This test page has used its 25 test registrations.'));
    if (b.status === 'sold_out') return message(tr('That ticket has just sold out. Please choose another.'));
    if (b.status === 'invite_only') return closed(tr('This event is by invitation'), tr('If you were invited, use the link in your invitation email.'));
    if (b.status === 'bad_ticket') return message(tr('That ticket is no longer available. Reload the page and choose another.'));
    if (r.status === 404) return closed(...NOT_ACTIVE());
    if (r.status === 400 && Array.isArray(b.fields)) {
      markErrors(b.fields);
      if (b.fields.some(f => String(f).startsWith('plus'))) $('plus').querySelector('.err').textContent = tr('Please check the names of your guests.');
      return;
    }
    message(b.error || tr('Registration failed. Please try again.'));
  } catch {
    message(tr('Could not reach the server. Check your connection and try again.'));
  } finally {
    btn.disabled = false; btn.textContent = submitLabel();
    tsToken = '';
    if (tsWidget != null && window.turnstile) window.turnstile.reset(tsWidget);
  }
});

// ── the emailed link ──
// Confirming takes a button press, so a mail scanner that opens the link
// registers nobody.
const dropToken = () => {
  const q = new URLSearchParams(location.search); q.delete('paid'); q.delete('unpaid');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
  try { sessionStorage.removeItem(PAY_KEY); } catch { /* storage blocked */ }
};
const NOT_YET = () => tr('Your link keeps working: open it again later to finish.');

function showTicket(first, t, plusTickets) {
  const e = config.event || {}, pg = config.page || {};
  $('tk-h').textContent = first ? tr('You are registered, {name}', { name: first }) : tr('You are registered');
  $('tk-host').textContent = pg.host_name || '';
  $('tk-event').textContent = e.name || '';
  $('tk-guest').textContent = [t.first_name, t.last_name].filter(Boolean).join(' ');
  $('tk-type').textContent = t.ticket_type || '';
  $('tk-date').textContent = fmtDate(e.date, true) + (e.start ? ', ' + e.start : '');
  $('tk-venue').textContent = e.venue || '';
  $('tk-qr').src = t.qr_svg; $('tk-code').textContent = t.code || '';
  $('tk-cal').hidden = !calInfo();
  // (114) The plus-ones' tickets, under the guest's own.
  $('tk-plus').replaceChildren(...(plusTickets || []).map(p => {
    const box = el('div', { class: 'ticket' });
    const tt = el('div', { class: 'tt' }); tt.append(el('span', null, tr('Guest of {name}', { name: t.first_name || '' })), el('b', null, [p.first_name, p.last_name].filter(Boolean).join(' ')));
    const qr = el('div', { class: 'qr' }); const img = el('img', { alt: tr('QR code for {name}', { name: p.first_name }) }); img.src = p.qr_svg;
    qr.append(img, el('span', { class: 'code' }, p.code || ''));
    box.append(tt, el('div', { class: 'perf' }), qr);
    return box;
  }));
  card('ticket');
}

let cfLabel = tr('Confirm my registration');
$('cf-btn').addEventListener('click', async () => {
  const btn = $('cf-btn');
  btn.disabled = true; btn.textContent = tr('Confirming…');
  $('cf-msg').hidden = true;
  try {
    const r = await call({ action: 'confirm', token });
    const b = r.body;
    if (r.status === 200 && b.status === 'payment' && /^https:\/\/checkout\.stripe\.com\//.test(b.checkout_url || '')) {
      // Off to Stripe. The token stays in this tab so the return can finish.
      try { sessionStorage.setItem(PAY_KEY, token); } catch { /* the emailed link still works */ }
      btn.textContent = tr('Opening secure checkout…');
      location.href = b.checkout_url;
      return new Promise(() => {});   // keep the button busy while the page leaves
    }
    if (r.status === 200 && b.status === 'payments_unavailable') {
      $('cf-msg').textContent = tr('The organizer cannot take payments right now.') + ' ' + NOT_YET(); $('cf-msg').hidden = false;
      return;
    }
    dropToken();
    if (b.status === 'sold_out') return closed(tr('This ticket has sold out'), tr('It sold out before you confirmed. Register again from this page to choose another ticket.'));
    if (b.status === 'bad_ticket') return closed(tr('This ticket is no longer available'), tr('Register again from this page to choose another ticket.'));
    if (b.status === 'refunded') return closed(tr('This ticket was refunded'), tr('Contact the organizer if you think this is a mistake.'));
    if (b.status === 'hold_limit') return closed(tr('This payment link has expired'), tr('Register again from this page to get a new one.'));
    if (r.status === 200 && b.status === 'processing') {
      $('done-h').textContent = tr('Your payment is being processed');
      $('done-p').textContent = tr('Your QR ticket arrives by email as soon as the payment clears. Nothing more to do.');
      card('done');
      return;
    }
    if (r.status === 200 && (b.status === 'waitlisted' || b.status === 'awaiting_approval')) {
      const nm = b.first_name || '';
      $('done-h').textContent = b.status === 'waitlisted'
        ? (nm ? tr('You are on the waitlist, {name}', { name: nm }) : tr('You are on the waitlist'))
        : (nm ? tr('Thanks, {name}', { name: nm }) : tr('Thanks'));
      $('done-p').textContent = b.status === 'waitlisted'
        ? (b.position ? tr('You are number {n} on the waitlist.', { n: b.position }) + ' ' : '') + tr('If a place opens up, your ticket arrives by email.')
        : tr('The organizer reviews each registration. Your ticket arrives by email once yours is approved.');
      card('done');
      return;
    }
    if (r.status === 200 && b.status === 'registered') {
      if (b.ticket && b.ticket.qr_svg) return showTicket(b.first_name, b.ticket, b.plus_tickets);
      $('done-h').textContent = b.first_name ? tr('You are registered, {name}', { name: b.first_name }) : tr('You are registered');
      $('done-p').textContent = tr('Your QR code is on its way by email. Show it at the entrance to check in. If it has not arrived in 10 minutes, check your spam folder.');
      card('done');
      return;
    }
    if (b.status === 'full') return closed(tr('Registration is full'), tr('The event reached its capacity before you confirmed. Contact the organizer if you need a place.'));
    if (b.status === 'closed') return closed(tr('Registration has closed'), tr('Contact the organizer if you still need to attend.'));
    if (r.status === 404) return closed(...NOT_ACTIVE());
    if (b.status === 'invalid') return closed(tr('This link has expired or was already used'), tr('Links work once, for 48 hours. Register again from the page you started on.'));
    $('cf-msg').textContent = b.error || tr('Something went wrong. Please try again.'); $('cf-msg').hidden = false;
  } catch {
    $('cf-msg').textContent = tr('Could not reach the server. Check your connection and try again.'); $('cf-msg').hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = cfLabel;
  }
});

$('cf-no').addEventListener('click', async () => {
  $('cf-no').disabled = true;
  try {
    const r = await call({ action: 'decline', token });
    dropToken();
    if (r.status === 200 && r.body.status === 'declined') return closed(tr('Request deleted'), tr('Nothing was registered. You can register again from this page with the right details.'));
    if (r.body.status === 'invalid') return closed(tr('This link has expired or was already used'), tr('Links work for 48 hours.'));
    $('cf-msg').textContent = r.body.error || tr('Something went wrong. Please try again.'); $('cf-msg').hidden = false;
  } catch {
    $('cf-msg').textContent = tr('Could not reach the server. Check your connection and try again.'); $('cf-msg').hidden = false;
  } finally { $('cf-no').disabled = false; }
});

// ── a personal invitation (migration 116) ──
let IV = null;
function ivRow(first = '', last = '') {
  const i = $('iv-rows').children.length;
  const row = el('div', { class: 'plus-row', 'data-f': 'plus:' + i });
  const f = el('input', { type: 'text', maxlength: '80', autocomplete: 'off', placeholder: tr('First name'), 'aria-label': tr('Guest {n} first name', { n: i + 1 }) }); f.value = first;
  const l = el('input', { type: 'text', maxlength: '80', autocomplete: 'off', placeholder: tr('Last name'), 'aria-label': tr('Guest {n} last name', { n: i + 1 }) }); l.value = last;
  const x = el('button', { type: 'button', class: 'x', 'aria-label': tr('Remove guest {n}', { n: i + 1 }) }, '×');
  x.addEventListener('click', () => { row.remove(); [...$('iv-rows').children].forEach((r, k) => r.setAttribute('data-f', 'plus:' + k)); ivPlusState(); });
  row.append(f, l, x);
  $('iv-rows').append(row);
  ivPlusState();
}
function ivPlusState() { $('iv-add').hidden = $('iv-rows').children.length >= (IV?.plus_max || 0); }
$('iv-add').addEventListener('click', () => ivRow());
async function openInvite() {
  const r = await call({ action: 'invite', token: inviteToken }).catch(() => null);
  if (!r || r.status !== 200) return closed(tr('Something went wrong'), tr('Please open the link from your invitation again.'));
  if (r.body.status !== 'ok') return closed(tr('This invitation link is no longer valid'), tr('Ask the organizer to send it again.'));
  IV = r.body;
  $('iv-h').textContent = tr('You are invited, {name}', { name: IV.first_name });
  $('iv-p').textContent = IV.rsvp === 'going' ? tr('You said you are coming. You can change your answer or your guests below.')
    : IV.rsvp === 'not_going' ? tr('You said you cannot come. Changed your mind? Let us know below.')
    : [fmtDate(config.event?.date), config.event?.venue].filter(Boolean).join(' · ') || tr('Will you come?');
  $('iv-plus').hidden = !IV.plus_max;
  $('iv-plus-max').textContent = tr('(up to {n})', { n: IV.plus_max });
  $('iv-rows').replaceChildren();
  for (const p of IV.plus_ones || []) ivRow(p.first_name, p.last_name);
  ivPlusState();
  card('invite');
}
async function answerInvite(going) {
  $('iv-msg').hidden = true;
  const plus = going ? [...$('iv-rows').children].map(r => { const [f, l] = r.querySelectorAll('input'); return { first_name: f.value, last_name: l.value }; }) : [];
  const v = validatePlusOnes(plus, IV.plus_max || 0);
  if (v.errors.length) { markErrors(v.errors); $('iv-plus').querySelector('.err').textContent = tr('Please enter each guest\'s first and last name in letters.'); return; }
  const btn = going ? $('iv-yes') : $('iv-no'); btn.disabled = true;
  try {
    const r = await call({ action: 'rsvp', token: inviteToken, going, plus_ones: v.names });
    const b = r.body;
    if (r.status === 200 && b.status === 'going') {
      if (b.ticket && b.ticket.qr_svg) return showTicket(b.first_name, b.ticket, b.plus_tickets);
      $('done-h').textContent = tr('See you there, {name}', { name: b.first_name || '' });
      $('done-p').textContent = tr('Your QR ticket is on its way by email.');
      return card('done');
    }
    if (r.status === 200 && b.status === 'not_going') {
      $('done-h').textContent = tr('Thanks for letting us know');
      $('done-p').textContent = tr('We will miss you. If your plans change, open your invitation link again.');
      return card('done');
    }
    if (b.status === 'no_room_for_plus_ones') { $('iv-msg').textContent = tr('You are on the list, but there is no room for that many guests. Try fewer, or ask the organizer.'); $('iv-msg').hidden = false; return; }
    if (b.status === 'closed') return closed(tr('Replies have closed'), tr('Contact the organizer if you still need to change your answer.'));
    if (b.status === 'invalid') return closed(tr('This invitation link is no longer valid'), tr('Ask the organizer to send it again.'));
    $('iv-msg').textContent = b.error || tr('Something went wrong. Please try again.'); $('iv-msg').hidden = false;
  } catch {
    $('iv-msg').textContent = tr('Could not reach the server. Check your connection and try again.'); $('iv-msg').hidden = false;
  } finally { btn.disabled = false; }
}
$('iv-yes').addEventListener('click', () => answerInvite(true));
$('iv-no').addEventListener('click', () => answerInvite(false));

// ── start ──
(async () => {
  setLang('auto');
  if (!isRegistrationCode(code)) return solo(...NOT_ACTIVE());
  let r;
  try { r = await call({ action: 'config' }); }
  catch { return solo(tr('Could not load this page'), tr('Check your connection and reload.')); }
  if (r.status === 404) return solo(...NOT_ACTIVE());
  if (r.status !== 200) return solo(tr('Registration is not available right now'), tr('Please try again in a few minutes.'));
  config = r.body;
  setLang(config.language || 'auto');
  config.questions = config.questions || [];
  config.page = config.page || {};
  renderEvent();

  if (inviteToken) return openInvite();
  if (token) {
    $('cf-name').textContent = config.event?.name || 'Event';
    $('cf-meta').textContent = [fmtDate(config.event?.date), config.event?.venue].filter(Boolean).join(' · ');
    const pv = await call({ action: 'preview', token }).catch(() => null);
    if (pv && pv.status === 200 && (pv.body.status === 'ok' || pv.body.status === 'order')) {
      const p = pv.body;
      $('cf-who').textContent = [p.first_name, p.last_name].filter(Boolean).join(' ') + (p.company ? ', ' + p.company : '');
      $('cf-who-row').hidden = false;
      const tk = p.ticket, price = tk && tk.price_cents > 0 && !config.test ? money(tk.price_cents, tk.currency) : '';
      if (tk) { $('cf-tix').textContent = tk.name + (price ? ', ' + price : ''); $('cf-tix').hidden = false; }
      if (p.status === 'order') {
        // The request is already an order: this link is the way back to it.
        $('cf-no').hidden = true; $('cf-who-s').hidden = true;
        if (p.order_status === 'refunded') { dropToken(); return closed(tr('This ticket was refunded'), tr('Contact the organizer if you think this is a mistake.')); }
        if (p.order_status === 'paid') {
          cfLabel = tr('Show my ticket'); $('cf-h').textContent = tr('Your ticket is ready');
        } else {
          cfLabel = tr('Continue to payment');
          $('cf-h').textContent = fromStripe === 'unpaid' ? tr('Payment not completed') : tr('Complete your payment');
          $('cf-meta').textContent = tr('Nothing was charged. Your place is held for a short while.');
        }
      } else if (price) {
        cfLabel = tr('Confirm and pay {price}', { price });
      }
      $('cf-btn').textContent = cfLabel;
      // Back from Stripe after paying: finish without another press.
      if (fromStripe === 'paid' && p.status === 'order') { card('confirm'); $('cf-btn').click(); return; }
    } else if (pv && pv.body && pv.body.status === 'invalid') {
      dropToken();
      return closed(tr('This link has expired or was already used'), tr('Links work once, for 48 hours. Register again from the page you started on.'));
    }
    return card('confirm');
  }
  if (fromStripe === 'paid') {
    // Paid in another tab or browser: the order settles on its own.
    $('done-h').textContent = tr('Finishing your registration');
    $('done-p').textContent = tr('If your payment went through, your QR ticket arrives by email within a few minutes. The link in your confirmation email also shows it.');
    return card('done');
  }
  // (116) Invite-only: without approval the page explains instead of offering a form.
  if (config.mode === 'invite' && !config.approval) return closed(tr('This event is by invitation'), tr('If you were invited, use the link in your invitation email.'));
  if (config.state === 'closed') return closed(tr('Registration has closed'), tr('Contact the organizer if you still need to attend.'));
  // 'waitlist' falls through to the form: the guest joins the waitlist.
  if (config.state === 'full') return closed(tr('Registration is full'), tr('This event has reached its capacity. Contact the organizer if you need a place.'));
  renderQuestions(config.questions);
  renderTickets(config.tickets || []);
  renderPlus();
  $('embed-ev').textContent = [config.event?.name, fmtDate(config.event?.date), config.event?.venue].filter(Boolean).join(' · ');
  card('open');
  await loadTurnstile(config.turnstile_site_key);
})();
