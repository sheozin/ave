// CueDeck Display — Service Worker (minimal, cache app shell only)
const CACHE = 'cuedeck-display-v1';
const SHELL = ['/cuedeck-display.html', '/favicon.svg', '/display-manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache Supabase API calls or realtime
  if (url.hostname.includes('supabase')) return;

  // Network-first for navigation, cache-fallback for offline
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/cuedeck-display.html'))
    );
    return;
  }

  // Cache-first for static assets in shell
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
