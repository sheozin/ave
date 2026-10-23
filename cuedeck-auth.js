// cuedeck-auth.js: shared by every page that signs people in on this
// Supabase project (console, admin, check-in home, check-in desk).
//
// 1. Cloudflare Turnstile. Supabase Auth checks a CAPTCHA token on sign-in,
//    sign-up, password reset and resend once CAPTCHA is switched on for the
//    project. Each token is single use, so callers take one per request and
//    reset afterwards. Until TURNSTILE_SITE_KEY is set, token() resolves to
//    undefined and Supabase (CAPTCHA still off) ignores it: the pages ship
//    first, the server switch flips second, and logins never break between.
// 2. cdAuthMessage: Supabase error codes in plain words.
// 3. cdPasswordScore: the sign-up strength meter. Supabase enforces the real
//    rules (length, leaked-password check) server side.
// 4. Session expiry. The project signs people out after SESSION_IDLE_HOURS
//    without activity and SESSION_MAX_HOURS after they signed in (Supabase:
//    Authentication > Sessions; keep these two numbers equal to it). watch()
//    tells a sign-out the person chose (signOut()) from one that expired, so
//    the sign-in screen can say why (expiredNotice()), and warns a day ahead
//    of the hard limit so a desk is never signed out with guests at the door.
(function () {
  var TURNSTILE_SITE_KEY = '0x4AAAAAAFNjmmDszwstOkPo';
  var PASSWORD_MIN = 10;
  var SESSION_MAX_HOURS = 168, SESSION_IDLE_HOURS = 12, WARN_HOURS = 24;
  var OWN_KEY = 'cd_own_signout', EXPIRED_KEY = 'cd_signed_out_expired';
  var loading = null;

  function loadTurnstile() {
    if (!loading) loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = function () { resolve(window.turnstile); };
      s.onerror = function () { loading = null; reject(new Error('Could not load the security check. Check your connection and reload the page.')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // One widget per page. It stays invisible unless Cloudflare wants the
  // person to click, in which case it appears inside `el`.
  function mount(el) {
    if (!TURNSTILE_SITE_KEY) return { token: function () { return Promise.resolve(undefined); }, reset: function () {} };
    var id = null, current = null, waiting = [], failed = null;
    function settle(tok, err) { var w = waiting; waiting = []; w.forEach(function (p) { err ? p.reject(err) : p.resolve(tok); }); }
    loadTurnstile().then(function (t) {
      id = t.render(el, {
        sitekey: TURNSTILE_SITE_KEY,
        appearance: 'interaction-only',
        callback: function (tok) { current = tok; failed = null; settle(tok); },
        'expired-callback': function () { current = null; },
        'error-callback': function () {
          current = null;
          failed = new Error('The security check failed. Reload the page and try again.');
          settle(null, failed);
        },
      });
    }).catch(function (e) { failed = e; settle(null, e); console.error('cuedeck-auth:', e.message); });
    return {
      token: function () {
        if (current) return Promise.resolve(current);
        if (failed) return Promise.reject(failed);
        return new Promise(function (resolve, reject) {
          var p = { resolve: resolve, reject: reject };
          waiting.push(p);
          setTimeout(function () {
            var i = waiting.indexOf(p);
            if (i >= 0) { waiting.splice(i, 1); reject(new Error('The security check is taking too long. Reload the page and try again.')); }
          }, 30000);
        });
      },
      reset: function () { current = null; if (id !== null && window.turnstile) window.turnstile.reset(id); },
    };
  }

  var MESSAGES = {
    invalid_credentials: 'That email and password do not match. Check both, or reset your password.',
    email_not_confirmed: 'Confirm your email first. Use the link we sent you, or request a new one.',
    user_already_exists: 'This email already has an account. Sign in, or reset your password.',
    weak_password: 'Choose a stronger password: at least ' + PASSWORD_MIN + ' characters, and not one that has appeared in a data breach.',
    over_request_rate_limit: 'Too many attempts. Wait a few minutes and try again.',
    over_email_send_rate_limit: 'We have sent several emails to this address already. Wait a few minutes before asking for another.',
    captcha_failed: 'The security check failed. Reload the page and try again.',
    email_address_invalid: 'That email address cannot receive mail. Check it and try again.',
    signup_disabled: 'New accounts are paused right now. Contact support@cuedeck.io.',
  };
  function message(error) {
    if (!error) return '';
    if (error.code && MESSAGES[error.code]) return MESSAGES[error.code];
    if (error.status === 429) return MESSAGES.over_request_rate_limit;
    return error.message || 'Something went wrong. Try again.';
  }

  // 0-4, with a label. Length matters most; variety helps a little.
  function passwordScore(pw) {
    if (!pw) return { score: 0, label: '' };
    if (pw.length < PASSWORD_MIN) return { score: 1, label: 'Too short: ' + (PASSWORD_MIN - pw.length) + ' more character' + (PASSWORD_MIN - pw.length === 1 ? '' : 's') };
    var kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (r) { return r.test(pw); }).length;
    if (/^(.)\1+$/.test(pw)) return { score: 1, label: 'Too predictable' };
    var score = pw.length >= 16 || (pw.length >= 12 && kinds >= 3) ? 4 : kinds >= 3 ? 3 : 2;
    return { score: score, label: ['', '', 'Fair', 'Good', 'Strong'][score] };
  }

  function store(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function read(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  // The person's own sign-out is shared with their other tabs (localStorage),
  // which see the same SIGNED_OUT a moment later; it counts for a minute.
  function markOwn() { try { localStorage.setItem(OWN_KEY, String(Date.now())); } catch (e) { /* private mode */ } }
  function wasOwn() { try { return Date.now() - Number(localStorage.getItem(OWN_KEY) || 0) < 60e3; } catch (e) { return false; } }

  // A sign-out the person asked for: no "your sign-in expired" afterwards.
  function signOut(sb, opts) { markOwn(); return sb.auth.signOut(opts); }

  // The message for the sign-in screen after an expiry, once ('' otherwise).
  function expiredNotice() {
    if (!read(EXPIRED_KEY)) return '';
    store(EXPIRED_KEY, null);
    return 'For your security you were signed out: sign-ins end after ' + SESSION_IDLE_HOURS +
      ' hours without use, and ' + (SESSION_MAX_HOURS / 24) + ' days after you signed in. Sign in again to carry on.';
  }

  // When this login started, from the access token (Supabase puts the sign-in
  // time in amr). Null when the token says nothing usable.
  function signedInAt(session) {
    try {
      var claims = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var t = Math.min.apply(null, (claims.amr || []).map(function (a) { return a.timestamp; }).filter(Number.isFinite));
      return Number.isFinite(t) ? t * 1000 : null;
    } catch (e) { return null; }
  }

  function banner(text) {
    var el = document.getElementById('cd-session-warn');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'cd-session-warn';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:3000;max-width:min(560px,calc(100vw - 32px));' +
        'background:#1f2937;color:#fff;border:1px solid #f59e0b;border-radius:10px;padding:10px 14px;font:500 13px/1.45 system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center';
      var msg = document.createElement('span'); msg.id = 'cd-session-warn-text'; el.appendChild(msg);
      var x = document.createElement('button'); x.type = 'button'; x.textContent = 'OK';
      x.style.cssText = 'flex:none;background:#f59e0b;color:#111827;border:0;border-radius:6px;padding:4px 10px;font-weight:700;cursor:pointer';
      x.onclick = function () { el.dataset.dismissed = text; el.style.display = 'none'; };
      el.appendChild(x);
      document.body.appendChild(el);
    }
    if (el.dataset.dismissed === text) return;
    el.querySelector('#cd-session-warn-text').textContent = text;
    el.style.display = 'flex';
  }

  // The warning text for a sign-in that started at `at`, or '' (exported for tests).
  function warningFor(at, now) {
    if (!at) return '';
    var left = at + SESSION_MAX_HOURS * 3600e3 - now;
    if (left > WARN_HOURS * 3600e3 || left <= 0) return '';
    var end = new Date(at + SESSION_MAX_HOURS * 3600e3);
    var hm = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var day = end.toDateString() === new Date(now).toDateString() ? 'today' : 'tomorrow';
    return 'Your sign-in ends ' + day + ' at ' + hm + '. Sign out and back in before then, so it does not end in the middle of your event.';
  }

  // Call once per page. onExpired runs when the sign-in ends without the
  // person asking (the page shows its sign-in screen; expiredNotice() says why).
  function watch(sb, onExpired) {
    sb.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') {
        banner('');
        if (!wasOwn()) { store(EXPIRED_KEY, '1'); if (onExpired) onExpired(); }
      }
    });
    function check() {
      sb.auth.getSession().then(function (r) {
        var s = r && r.data && r.data.session;
        banner(s ? warningFor(signedInAt(s), Date.now()) : '');
      });
    }
    check();
    setInterval(check, 10 * 60e3);
  }

  window.cdAuth = { mount: mount, message: message, passwordScore: passwordScore, PASSWORD_MIN: PASSWORD_MIN,
                    signOut: signOut, watch: watch, expiredNotice: expiredNotice, warningFor: warningFor, signedInAt: signedInAt };
})();
