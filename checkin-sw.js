// CueDeck check-in desk: Service Worker, so a desk opens with no internet.
//
// Registered by the desk with its own path as scope, so it handles nothing
// else on the site. It keeps the page, the files it loads, the Supabase
// library, and the event's logo and badge images. Every request goes to the
// network first, so a desk always runs the version just deployed and HTML
// and modules never mix versions; the saved copy answers only when the
// network does not (no internet, or a venue router with no uplink).
// API calls and realtime are never cached: the page keeps its own copies
// (guest list in IndexedDB, events, settings and print stations in
// localStorage).
const CACHE = 'cuedeck-checkin-shell-v1';
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const PUBLIC_IMAGES = '/storage/v1/object/public/checkin-public/';
const SHELL = ['/checkin/desk', '/cuedeck-checkin.html', '/cuedeck-auth.js', '/favicon.svg',
  '/vendor/qrcode-generator-1.4.4.js', '/vendor/fonts/montserrat-latin-ext.woff2',
  '/checkin-window.js', '/checkin-clock.js', '/checkin-badge.js', '/checkin-roles.js', '/checkin-dashboard.js',
  SUPABASE_JS];
// A dead venue network can hang a request instead of failing it.
const NET_WAIT_MS = 5000;

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

// Network first; a good answer refreshes the saved copy under `key`.
async function networkFirst(req, key, fallbacks = []) {
  const cache = await caches.open(CACHE);
  try {
    const r = await fetch(req, { signal: AbortSignal.timeout(NET_WAIT_MS) });
    if (r.ok) cache.put(key, r.clone());
    return r;
  } catch (err) {
    for (const k of [key, ...fallbacks]) {
      const hit = await cache.match(k, { ignoreSearch: true });
      if (hit) return hit;
    }
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The page, whatever its query string (?event=…, ?mode=kiosk).
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, url.pathname, ['/checkin/desk', '/cuedeck-checkin.html']));
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
