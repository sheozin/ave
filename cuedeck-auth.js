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
(function () {
  var TURNSTILE_SITE_KEY = '0x4AAAAAAFNjmmDszwstOkPo';
  var PASSWORD_MIN = 10;
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

  window.cdAuth = { mount: mount, message: message, passwordScore: passwordScore, PASSWORD_MIN: PASSWORD_MIN };
})();
