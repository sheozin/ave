// CueDeck Console — Service Worker for offline support
const CACHE_NAME = 'cuedeck-console-v1';
const SHELL_URLS = [
  '/',
  '/cuedeck-console.html',
  '/cuedeck-agent-1-incident-advisor.js',
  '/cuedeck-agent-2-cue-engine.js',
  '/cuedeck-agent-3-report-generator.js',
  '/favicon.svg',
  '/console-manifest.json',
];

// Install: cache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API/Supabase, cache-first for app shell
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache Supabase or Stripe requests
  if (url.hostname.includes('supabase') || url.hostname.includes('stripe')) return;

  // App shell: cache-first
  if (SHELL_URLS.includes(url.pathname) || url.pathname === '/') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Google Fonts: cache-first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }
});
