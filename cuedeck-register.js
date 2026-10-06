// cuedeck-register.js: the public registration page (/r/<code>), kept out
// of the HTML so the page can run under a CSP with no inline script. Rules
// come from /checkin-register.js; the server is checkin-register.
import { validateRegistration, fieldMessage, formatEventDate, isRegistrationCode } from '/checkin-register.js';

const FN = 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-register';
const KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';
const $ = (id) => document.getElementById(id);

// /r/<code>, or ?code= when served from a dev server without the rewrite.
const code = (location.pathname.match(/^\/r\/([^/]+)\/?$/) || [])[1] || new URLSearchParams(location.search).get('code') || '';
let config = null;
let tsWidget = null;
let tsToken = '';
let tsWaiters = [];
let tsFailed = false;
// A token can still be on its way when the guest presses Register (the
// widget is invisible unless Cloudflare wants a click), so submit waits for
// it, as the sign-in pages do (cuedeck-auth.js).
function turnstileToken() {
  if (tsToken) return Promise.resolve(tsToken);
  if (tsFailed) return Promise.resolve('');
  return new Promise((resolve) => {
    tsWaiters.push(resolve);
    setTimeout(() => { const i = tsWaiters.indexOf(resolve); if (i >= 0) { tsWaiters.splice(i, 1); resolve(''); } }, 30000);
  });
}
function tsSettle(t) { const w = tsWaiters; tsWaiters = []; w.forEach(r => r(t)); }

async function call(body) {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY }, body: JSON.stringify({ ...body, code }) });
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: j || {} };
}

function show(id) {
  for (const s of ['loading', 'closed', 'open', 'confirm', 'done']) $(s).hidden = s !== id;
}

function closed(h, p) {
  $('closed-h').textContent = h;
  $('closed-p').textContent = p;
  show('closed');
}

function el(tag, attrs, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function renderQuestions(questions) {
  const box = $('questions');
  box.replaceChildren();
  for (const q of questions) {
    const lab = el('label', { class: 'f', 'data-f': 'q:' + q.id });
    const lt = el('span', { class: 'lt' }, q.label);
    if (!q.required) { lt.append(' '); lt.append(el('span', { class: 'opt' }, '(optional)')); }
    lab.append(lt);
    let input;
    if (q.type === 'choice') {
      input = el('select', { name: 'q:' + q.id });
      input.append(el('option', { value: '' }, 'Choose…'));
      for (const o of q.options) input.append(el('option', { value: o }, o));
    } else {
      input = el('input', { type: 'text', name: 'q:' + q.id, maxlength: '500', autocomplete: 'off' });
    }
    lab.append(input, el('span', { class: 'err' }));
    box.append(lab);
  }
}

function loadTurnstile(siteKey) {
  return new Promise((resolve) => {
    window.onTurnstileLoad = () => {
      tsWidget = window.turnstile.render('#ts', {
        sitekey: siteKey,
        action: 'register',
        appearance: 'interaction-only',
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
  if (first) first.querySelector('input,select')?.focus();
}

function formValues() {
  const f = $('form');
  const answers = {};
  for (const q of config.questions) answers[q.id] = f.elements['q:' + q.id]?.value ?? '';
  return {
    first_name: f.elements.first_name.value, last_name: f.elements.last_name.value,
    email: f.elements.email.value, company: f.elements.company.value,
    answers, consent: f.elements.consent.checked,
  };
}

function message(text) { $('msg').textContent = text; $('msg').hidden = false; }

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearErrors();
  const v = formValues();
  const { errors } = validateRegistration(v, config.questions);
  if (errors.length) { markErrors(errors); return; }
  const btn = $('submit');
  btn.disabled = true; btn.textContent = 'Registering…';
  try {
    const token = await turnstileToken();
    if (!token) { message('The security check did not finish. Reload the page and try again.'); return; }
    const r = await call({ action: 'register', ...v, website: $('form').elements.website.value, turnstile_token: token });
    const b = r.body;
    if (r.status === 200 && b.status === 'check_email') { show('done'); return; }
    if (r.status === 200 && b.status === 'ok') {
      if (b.test) {
        $('done-h').textContent = 'Test registration recorded';
        $('done-p').textContent = 'Test mode sends no email. The organizer finds this guest in Setup, under Attendees, and test guests are cleared when the event goes live.';
      }
      show('done');
      return;
    }
    if (b.status === 'full') return closed('Registration is full', 'This event has reached its capacity. Contact the organizer if you need a place.');
    if (b.status === 'closed') return closed('Registration has closed', 'Contact the organizer if you still need to attend.');
    if (b.status === 'test_cap') return message('This test page has used its 25 test registrations.');
    if (r.status === 404) return closed('This registration link is not active', 'Check the link with the event organizer.');
    if (r.status === 400 && Array.isArray(b.fields)) { markErrors(b.fields); return; }
    message(b.error || 'Registration failed. Please try again.');
  } catch {
    message('Could not reach the server. Check your connection and try again.');
  } finally {
    btn.disabled = false; btn.textContent = 'Register';
    tsToken = '';
    if (tsWidget != null && window.turnstile) window.turnstile.reset(tsWidget);
  }
});

// The emailed link: /r/<code>?t=<token>. Confirming takes a button press, so
// a mail scanner that opens the link does not register anyone.
// The token rides in the fragment (#t=), which browsers never send to a server.
const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';

$('cf-btn').addEventListener('click', async () => {
  const btn = $('cf-btn');
  btn.disabled = true; btn.textContent = 'Confirming…';
  $('cf-msg').hidden = true;
  try {
    const r = await call({ action: 'confirm', token });
    const b = r.body;
    // The token is spent (or dead) either way: keep it out of the address bar and history.
    history.replaceState(null, '', location.pathname + location.search);
    if (r.status === 200 && b.status === 'registered') {
      $('done-h').textContent = b.first_name ? 'You are registered, ' + b.first_name : 'You are registered';
      $('done-p').textContent = 'Your QR code is on its way by email. Show it at the entrance to check in. If it has not arrived in 10 minutes, check your spam folder.';
      show('done');
      return;
    }
    if (b.status === 'full') return closed('Registration is full', 'The event reached its capacity before you confirmed. Contact the organizer if you need a place.');
    if (b.status === 'closed') return closed('Registration has closed', 'Contact the organizer if you still need to attend.');
    if (r.status === 404) return closed('This registration link is not active', 'Check the link with the event organizer.');
    if (b.status === 'invalid') return closed('This link has expired or was already used', 'Links work once, for 48 hours. Register again from the page you started on.');
    $('cf-msg').textContent = b.error || 'Something went wrong. Please try again.'; $('cf-msg').hidden = false;
  } catch {
    $('cf-msg').textContent = 'Could not reach the server. Check your connection and try again.'; $('cf-msg').hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm my registration';
  }
});

(async () => {
  if (!isRegistrationCode(code)) return closed('This registration link is not active', 'Check the link with the event organizer.');
  let r;
  try { r = await call({ action: 'config' }); }
  catch { return closed('Could not load this page', 'Check your connection and reload.'); }
  if (r.status === 404) return closed('This registration link is not active', 'Check the link with the event organizer.');
  if (r.status !== 200) return closed('Registration is not available right now', 'Please try again in a few minutes.');
  config = r.body;
  const e = config.event || {};
  document.title = 'Register: ' + (e.name || 'event');
  if (token) {
    $('cf-name').textContent = e.name || 'Event';
    $('cf-meta').textContent = [formatEventDate(e.date), e.venue].filter(Boolean).join(' · ');
    const pv = await call({ action: 'preview', token }).catch(() => null);
    if (pv && pv.status === 200 && pv.body.status === 'ok') {
      const who = [pv.body.first_name, pv.body.last_name].filter(Boolean).join(' ') + (pv.body.company ? ', ' + pv.body.company : '');
      $('cf-who').textContent = who;
      $('cf-who-row').hidden = false;
    } else if (pv && pv.body && pv.body.status === 'invalid') {
      history.replaceState(null, '', location.pathname + location.search);
      return closed('This link has expired or was already used', 'Links work once, for 48 hours. Register again from the page you started on.');
    }
    return show('confirm');
  }
  if (config.state === 'closed') return closed('Registration has closed', 'Contact the organizer if you still need to attend.');
  if (config.state === 'full') return closed('Registration is full', 'This event has reached its capacity. Contact the organizer if you need a place.');
  $('ev-name').textContent = e.name || 'Event';
  $('ev-meta').textContent = [formatEventDate(e.date), e.venue].filter(Boolean).join(' · ');
  $('test-note').hidden = !config.test;
  renderQuestions(config.questions || []);
  show('open');
  await loadTurnstile(config.turnstile_site_key);
})();
