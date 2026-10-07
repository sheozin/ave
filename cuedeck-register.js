// cuedeck-register.js: the public registration page (/r/<code>), kept out
// of the HTML so the page runs under a CSP with no inline script. Rules and
// pure helpers come from /checkin-register.js; the server is
// checkin-register. Design approved 2026-10-06.
import {
  validateRegistration, fieldMessage, formatEventDate, isRegistrationCode,
  palette, tzLabel, initials, buildIcs, googleCalUrl, outlookCalUrl, mapsUrl,
} from '/checkin-register.js';

const FN = 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-register';
const KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';
const $ = (id) => document.getElementById(id);
const money = (cents, cur) => {
  try { return new Intl.NumberFormat(navigator.language || 'en-GB', { style: 'currency', currency: String(cur).toUpperCase() }).format(cents / 100); }
  catch { return (cents / 100).toFixed(2) + ' ' + String(cur).toUpperCase(); }
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// /r/<code>, or ?code= when served from a dev server without the rewrite.
const code = (location.pathname.match(/^\/r\/([^/]+)\/?$/) || [])[1] || new URLSearchParams(location.search).get('code') || '';
// The emailed link carries its token in the fragment (#t=), which browsers never send to a server.
let token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
// Back from Stripe Checkout (paid tickets): the link's token was kept in
// this tab while the guest paid, so the page can finish the order.
const back = new URLSearchParams(location.search);
const PAY_KEY = 'cuedeck-pay:' + code;
const fromStripe = back.has('paid') ? 'paid' : back.has('unpaid') ? 'unpaid' : null;
if (!token && fromStripe) { try { token = sessionStorage.getItem(PAY_KEY) || ''; } catch { /* storage blocked */ } }
let config = null;

async function call(body) {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY }, body: JSON.stringify({ ...body, code }) });
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
  for (const s of ['open', 'confirm', 'done', 'ticket', 'shut']) $(s).hidden = s !== id;
  if (window.matchMedia('(max-width: 900px)').matches && id !== 'open') $('card-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closed(h, p) {
  if (!config) return solo(h, p);
  $('shut-h').textContent = h; $('shut-p').textContent = p;
  // Kept in sync for anything reading the old element.
  $('closed-h').textContent = h; $('closed-p').textContent = p;
  card('shut');
}
const NOT_ACTIVE = ['This registration link is not active', 'Check the link with the event organizer.'];

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
  document.title = 'Register: ' + (e.name || 'event');

  const host = pg.host_name || '';
  $('host-name').textContent = host || e.name || 'Event';
  $('mark').replaceChildren();
  if (pg.logo_url) $('mark').append(el('img', { src: pg.logo_url, alt: host ? host + ' logo' : 'Organizer logo' }));
  else $('mark').textContent = initials(host || e.name);

  // No cover: a short band in the brand colour, not a second copy of the title.
  $('cover').classList.toggle('none', !pg.cover_url);
  if (pg.cover_url) { $('cover-img').src = pg.cover_url; $('cover-img').alt = e.name || ''; $('cover-img').hidden = false; }
  else $('cover-img').hidden = true;
  $('cover-ph').hidden = true;
  $('ev-name').textContent = e.name || 'Event';
  $('test-chip').hidden = !config.test;

  const d = e.date ? new Date(e.date + 'T00:00:00Z') : null;
  $('cal-m').textContent = d ? MONTHS[d.getUTCMonth()] : '';
  $('cal-d').textContent = d ? String(d.getUTCDate()) : '';
  $('ev-meta').textContent = formatEventDate(e.date) || 'Date to be announced';
  $('ev-time').textContent = e.start ? e.start + (e.end ? ' to ' + e.end : '') + (tzLabel(e.timezone) ? ', ' + tzLabel(e.timezone) : '') : '';
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
  document.querySelector('#open .card-h h2').textContent = wl ? 'Join the waitlist' : 'Register';
  $('submit').textContent = wl ? 'Join the waitlist' : 'Register';
  $('flow-note').hidden = !(wl || config.approval);
  $('flow-note').textContent = wl
    ? 'This event is full. Join the waitlist and your ticket is emailed to you if a place opens up.'
    : 'The organizer reviews each registration. Your ticket is emailed to you once it is approved.';
  $('left').hidden = config.places_left == null || wl;
  $('left').textContent = config.places_left == null ? '' : config.places_left + (config.places_left === 1 ? ' place left' : ' places left');
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
    if (navigator.share) { await navigator.share({ title: config?.event?.name || 'Register', url }); return; }
    await navigator.clipboard.writeText(url);
    $('share-t').textContent = 'Link copied';
  } catch { $('share-t').textContent = 'Share'; return; }
  setTimeout(() => { $('share-t').textContent = 'Share'; }, 1800);
});

// ── questions ──
function renderQuestions(questions) {
  const box = $('questions');
  box.replaceChildren();
  for (const q of questions) {
    if (q.type === 'choice' && q.options.length <= 4) {
      // Up to four options read better as buttons than as a dropdown.
      const fs = el('fieldset', { 'data-f': 'q:' + q.id, style: 'border:0;margin:0;padding:0;display:grid;gap:8px' });
      const lg = el('legend', { style: 'font-size:14px;font-weight:600;padding:0;margin-bottom:8px' }, q.label);
      if (!q.required) { lg.append(' '); lg.append(el('span', { class: 'opt' }, '(optional)')); }
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
    const lt = el('span', { class: 'lt' }, q.label);
    if (!q.required) { lt.append(' '); lt.append(el('span', { class: 'opt' }, '(optional)')); }
    let input;
    if (q.type === 'choice') {
      input = el('select', { name: 'q:' + q.id });
      input.append(el('option', { value: '' }, 'Choose…'));
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
    $('tix').classList.remove('bad'); $('tix').querySelector('.err').textContent = '';
  };
  const buyable = list.filter(t => !t.sold_out && t.on_sale);
  for (const t of list) {
    const off = t.sold_out || !t.on_sale;
    const b = el('button', { type: 'button', class: 'tix-o', role: 'radio', 'aria-checked': 'false' });
    if (off) b.disabled = true;
    const nm = el('span', { class: 'nm' });
    nm.append(el('b', null, t.name));
    const sub = t.sold_out ? 'Sold out' : !t.on_sale ? 'Not on sale yet' : [t.description, t.left ? t.left + ' left' : ''].filter(Boolean).join(' · ');
    if (sub) nm.append(el('small', null, sub));
    b.append(el('span', { class: 'dot', 'aria-hidden': 'true' }), nm, el('span', { class: 'pr' }, t.price || 'Free'));
    b.addEventListener('click', () => pick(t, b));
    box.append(b);
  }
  // One choice on sale: picked for the guest.
  if (buyable.length === 1) pick(buyable[0], box.querySelectorAll('.tix-o')[list.indexOf(buyable[0])]);
}
function ticketMissing() {
  const tx = config.tickets || [];
  if (!tx.length || $('form').elements.ticket_type_id.value) return false;
  $('tix').classList.add('bad'); $('tix').querySelector('.err').textContent = 'Choose a ticket.';
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
    const e = l.querySelector('.err'); if (e) e.textContent = m.text;
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
  };
}
function message(text) { $('msg').textContent = text; $('msg').hidden = false; }

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearErrors();
  const v = formValues();
  const { errors } = validateRegistration(v, config.questions);
  const noTicket = ticketMissing();
  if (errors.length) markErrors(errors);
  if (noTicket || errors.length) return;
  const btn = $('submit');
  btn.disabled = true; btn.textContent = 'Registering…';
  try {
    const t = await turnstileToken();
    if (!t) { message('The security check did not finish. Reload the page and try again.'); return; }
    const r = await call({ action: 'register', ...v, website: $('form').elements.website.value, turnstile_token: t });
    const b = r.body;
    if (r.status === 200 && b.status === 'check_email') { card('done'); return; }
    if (r.status === 200 && b.status === 'ok') {
      if (b.test && b.held) {
        $('done-h').textContent = b.held === 'waitlist' ? 'Added to the waitlist (test)' : 'Awaiting approval (test)';
        $('done-p').textContent = 'Test mode sends no email. The organizer finds this guest in the Event admin, under Registration.';
      } else if (b.test) {
        $('done-h').textContent = 'Test registration recorded';
        $('done-p').textContent = 'Test mode sends no email. The organizer finds this guest in Setup, under Attendees, and test guests are cleared when the event goes live.';
      }
      card('done');
      return;
    }
    if (b.status === 'full') return closed('Registration is full', 'This event has reached its capacity. Contact the organizer if you need a place.');
    if (b.status === 'closed') return closed('Registration has closed', 'Contact the organizer if you still need to attend.');
    if (b.status === 'test_cap') return message('This test page has used its 25 test registrations.');
    if (b.status === 'sold_out') return message('That ticket has just sold out. Please choose another.');
    if (b.status === 'bad_ticket') return message('That ticket is no longer available. Reload the page and choose another.');
    if (r.status === 404) return closed(...NOT_ACTIVE);
    if (r.status === 400 && Array.isArray(b.fields)) { markErrors(b.fields); return; }
    message(b.error || 'Registration failed. Please try again.');
  } catch {
    message('Could not reach the server. Check your connection and try again.');
  } finally {
    btn.disabled = false; btn.textContent = config.state === 'waitlist' ? 'Join the waitlist' : 'Register';
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
const NOT_YET = 'Your link keeps working: open it again later to finish.';

function showTicket(first, t) {
  const e = config.event || {}, pg = config.page || {};
  $('tk-h').textContent = first ? 'You are registered, ' + first : 'You are registered';
  $('tk-host').textContent = pg.host_name || '';
  $('tk-event').textContent = e.name || '';
  $('tk-guest').textContent = [t.first_name, t.last_name].filter(Boolean).join(' ');
  $('tk-type').textContent = t.ticket_type || '';
  $('tk-date').textContent = (formatEventDate(e.date) || '').replace(/^(\w{3})\w*/, '$1') + (e.start ? ', ' + e.start : '');
  $('tk-venue').textContent = e.venue || '';
  $('tk-qr').src = t.qr_svg; $('tk-code').textContent = t.code || '';
  $('tk-cal').hidden = !calInfo();
  card('ticket');
}

let cfLabel = 'Confirm my registration';
$('cf-btn').addEventListener('click', async () => {
  const btn = $('cf-btn');
  btn.disabled = true; btn.textContent = 'Confirming…';
  $('cf-msg').hidden = true;
  try {
    const r = await call({ action: 'confirm', token });
    const b = r.body;
    if (r.status === 200 && b.status === 'payment' && /^https:\/\/checkout\.stripe\.com\//.test(b.checkout_url || '')) {
      // Off to Stripe. The token stays in this tab so the return can finish.
      try { sessionStorage.setItem(PAY_KEY, token); } catch { /* the emailed link still works */ }
      btn.textContent = 'Opening secure checkout…';
      location.href = b.checkout_url;
      return new Promise(() => {});   // keep the button busy while the page leaves
    }
    if (r.status === 200 && b.status === 'payments_unavailable') {
      $('cf-msg').textContent = 'The organizer cannot take payments right now. ' + NOT_YET; $('cf-msg').hidden = false;
      return;
    }
    dropToken();
    if (b.status === 'sold_out') return closed('This ticket has sold out', 'It sold out before you confirmed. Register again from this page to choose another ticket.');
    if (b.status === 'bad_ticket') return closed('This ticket is no longer available', 'Register again from this page to choose another ticket.');
    if (b.status === 'refunded') return closed('This ticket was refunded', 'Contact the organizer if you think this is a mistake.');
    if (b.status === 'hold_limit') return closed('This payment link has expired', 'Register again from this page to get a new one.');
    if (r.status === 200 && b.status === 'processing') {
      $('done-h').textContent = 'Your payment is being processed';
      $('done-p').textContent = 'Your QR ticket arrives by email as soon as the payment clears. Nothing more to do.';
      card('done');
      return;
    }
    if (r.status === 200 && (b.status === 'waitlisted' || b.status === 'awaiting_approval')) {
      const who = b.first_name ? ', ' + b.first_name : '';
      $('done-h').textContent = b.status === 'waitlisted' ? 'You are on the waitlist' + who : 'Thanks' + who;
      $('done-p').textContent = b.status === 'waitlisted'
        ? (b.position ? 'You are number ' + b.position + ' on the waitlist. ' : '') + 'If a place opens up, your ticket arrives by email.'
        : 'The organizer reviews each registration. Your ticket arrives by email once yours is approved.';
      card('done');
      return;
    }
    if (r.status === 200 && b.status === 'registered') {
      if (b.ticket && b.ticket.qr_svg) return showTicket(b.first_name, b.ticket);
      $('done-h').textContent = b.first_name ? 'You are registered, ' + b.first_name : 'You are registered';
      $('done-p').textContent = 'Your QR code is on its way by email. Show it at the entrance to check in. If it has not arrived in 10 minutes, check your spam folder.';
      card('done');
      return;
    }
    if (b.status === 'full') return closed('Registration is full', 'The event reached its capacity before you confirmed. Contact the organizer if you need a place.');
    if (b.status === 'closed') return closed('Registration has closed', 'Contact the organizer if you still need to attend.');
    if (r.status === 404) return closed(...NOT_ACTIVE);
    if (b.status === 'invalid') return closed('This link has expired or was already used', 'Links work once, for 48 hours. Register again from the page you started on.');
    $('cf-msg').textContent = b.error || 'Something went wrong. Please try again.'; $('cf-msg').hidden = false;
  } catch {
    $('cf-msg').textContent = 'Could not reach the server. Check your connection and try again.'; $('cf-msg').hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = cfLabel;
  }
});

$('cf-no').addEventListener('click', async () => {
  $('cf-no').disabled = true;
  try {
    const r = await call({ action: 'decline', token });
    dropToken();
    if (r.status === 200 && r.body.status === 'declined') return closed('Request deleted', 'Nothing was registered. You can register again from this page with the right details.');
    if (r.body.status === 'invalid') return closed('This link has expired or was already used', 'Links work for 48 hours.');
    $('cf-msg').textContent = r.body.error || 'Something went wrong. Please try again.'; $('cf-msg').hidden = false;
  } catch {
    $('cf-msg').textContent = 'Could not reach the server. Check your connection and try again.'; $('cf-msg').hidden = false;
  } finally { $('cf-no').disabled = false; }
});

// ── start ──
(async () => {
  if (!isRegistrationCode(code)) return solo(...NOT_ACTIVE);
  let r;
  try { r = await call({ action: 'config' }); }
  catch { return solo('Could not load this page', 'Check your connection and reload.'); }
  if (r.status === 404) return solo(...NOT_ACTIVE);
  if (r.status !== 200) return solo('Registration is not available right now', 'Please try again in a few minutes.');
  config = r.body;
  config.questions = config.questions || [];
  config.page = config.page || {};
  renderEvent();

  if (token) {
    $('cf-name').textContent = config.event?.name || 'Event';
    $('cf-meta').textContent = [formatEventDate(config.event?.date), config.event?.venue].filter(Boolean).join(' · ');
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
        if (p.order_status === 'refunded') { dropToken(); return closed('This ticket was refunded', 'Contact the organizer if you think this is a mistake.'); }
        if (p.order_status === 'paid') {
          cfLabel = 'Show my ticket'; $('cf-h').textContent = 'Your ticket is ready';
        } else {
          cfLabel = 'Continue to payment';
          $('cf-h').textContent = fromStripe === 'unpaid' ? 'Payment not completed' : 'Complete your payment';
          $('cf-meta').textContent = 'Nothing was charged. Your place is held for a short while.';
        }
      } else if (price) {
        cfLabel = 'Confirm and pay ' + price;
      }
      $('cf-btn').textContent = cfLabel;
      // Back from Stripe after paying: finish without another press.
      if (fromStripe === 'paid' && p.status === 'order') { card('confirm'); $('cf-btn').click(); return; }
    } else if (pv && pv.body && pv.body.status === 'invalid') {
      dropToken();
      return closed('This link has expired or was already used', 'Links work once, for 48 hours. Register again from the page you started on.');
    }
    return card('confirm');
  }
  if (fromStripe === 'paid') {
    // Paid in another tab or browser: the order settles on its own.
    $('done-h').textContent = 'Finishing your registration';
    $('done-p').textContent = 'If your payment went through, your QR ticket arrives by email within a few minutes. The link in your confirmation email also shows it.';
    return card('done');
  }
  if (config.state === 'closed') return closed('Registration has closed', 'Contact the organizer if you still need to attend.');
  // 'waitlist' falls through to the form: the guest joins the waitlist.
  if (config.state === 'full') return closed('Registration is full', 'This event has reached its capacity. Contact the organizer if you need a place.');
  renderQuestions(config.questions);
  renderTickets(config.tickets || []);
  card('open');
  await loadTurnstile(config.turnstile_site_key);
})();
