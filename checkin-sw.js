// CueDeck check-in desk: Service Worker, so a desk opens with no internet.
//
// Registered by the desk with its own path as scope, so it handles nothing
// else on the site. It keeps the page, the files it loads, the Supabase
// library, and the event's logo and badge images. Every request goes to the
// network first, so a desk runs the version just deployed; the saved copy
// answers when the network fails or is slower than NET_WAIT_MS (no
// internet, or a venue router with no uplink). On very slow venue wifi that
// can mean one load on the previous version; the late answer refreshes the
// copy, so the next load is current.
// API calls and realtime are never cached: the page keeps its own copies
// (guest list in IndexedDB, events, settings and print stations in
// localStorage).
const CACHE = 'cuedeck-checkin-shell-v1';   // same name: the saved files stay valid
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const PUBLIC_IMAGES = '/storage/v1/object/public/checkin-public/';
const SHELL = ['/checkin/desk', '/cuedeck-checkin.html', '/cuedeck-auth.js', '/favicon.svg',
  '/vendor/qrcode-generator-1.4.4.js', '/vendor/fonts/montserrat-latin-ext.woff2',
  '/checkin-window.js', '/checkin-clock.js', '/checkin-badge.js', '/checkin-badge-pdf.js', '/checkin-roles.js', '/checkin-dashboard.js', '/checkin-csv.js',
  '/checkin-ui.css', '/checkin-theme.js', '/fonts/geist-var.woff2',
  SUPABASE_JS];
// A venue router with no uplink often lets a request hang instead of
// failing it. With a saved copy in hand, wait this long and use it; the
// answer, if it ever comes, still refreshes the copy for next time.
// Without a saved copy, wait for the network as long as it takes.
const NET_WAIT_MS = 1500;

self.addEventListener('install', e => {
  // One failed item must not stop the rest from being saved.
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u =>
    fetch(u, { cache: 'reload' }).then(r => r.ok ? c.put(u, r) : null).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Only this worker's own old caches: the display's are not ours to delete.
  e.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(k => k.startsWith('cuedeck-checkin-') && k !== CACHE)
    .map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Set when the page itself had to come from the saved copy: the network is
// down, so for the next half minute the page's files come straight from the
// saved copy (still refreshed in the background) instead of each waiting
// out NET_WAIT_MS in turn.
let savedSince = 0;
const SAVED_FOR_MS = 30000;
// The page is told it came from the saved copy, so its first calls to
// CueDeck do not wait out their full limits either.
async function markedSaved(res) {
  const html = await res.text();
  return new Response(html.replace('<head>', '<head><script>window.CK_FROM_SAVED = true;</script>'),
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Network first; a good answer refreshes the saved copy under `key`.
async function networkFirst(req, key, fallbacks = [], page = false) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then(r => { if (r.ok) cache.put(key, r.clone()); return r; });
  net.catch(() => {});   // answered from the saved copy: a failure here is expected
  const saved = async () => {
    for (const k of [key, ...fallbacks]) {
      const hit = await cache.match(k, { ignoreSearch: true });
      if (hit) return hit;
    }
    return null;
  };
  if (!page && Date.now() - savedSince < SAVED_FOR_MS) {
    const hit = await saved();
    if (hit) return hit;
  }
  let timer;
  const slow = new Promise(ok => { timer = setTimeout(() => ok('slow'), NET_WAIT_MS); });
  const first = await Promise.race([net.then(r => r, () => 'failed'), slow]);
  clearTimeout(timer);
  if (first !== 'slow' && first !== 'failed') { if (page) savedSince = 0; return first; }
  const hit = await saved();
  if (hit && page) { savedSince = Date.now(); return markedSaved(hit); }
  if (hit) return hit;
  return net;   // nothing saved: the network's answer, or its error
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The page, whatever its query string (?event=…, ?mode=kiosk).
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, url.pathname, ['/checkin/desk', '/cuedeck-checkin.html'], true));
    return;
  }
  if (url.origin === self.location.origin || url.href === SUPABASE_JS) {
    e.respondWith(networkFirst(req, url.origin === self.location.origin ? url.pathname : SUPABASE_JS));
    return;
  }
  // The event's logo and badge template (public files). Supabase API,
  // auth and realtime fall through untouched.
  if (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith(PUBLIC_IMAGES)) {
    e.respondWith(networkFirst(req, url.href));
  }
});
