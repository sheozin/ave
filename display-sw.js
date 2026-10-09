// CueDeck Display — Service Worker: keeps a screen running without internet.
//
// Registered with the display page's own path as its scope, so it never
// handles the console. It keeps:
//   - the page and what it loads from elsewhere (the Supabase library), so a
//     screen that restarts offline still starts;
//   - videos the page saved in full (cache MEDIA, written by the page), served
//     from here including the byte ranges a <video> asks for, so a video
//     screen keeps looping through an outage or a reboot.
// API calls and realtime are never cached: the page keeps its own copy of
// the last data it received.
const SHELL_CACHE = 'cuedeck-display-shell-v2';
const MEDIA_CACHE = 'cuedeck-display-media';
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const SHELL = ['/cuedeck-display.html', '/display', '/favicon.svg', '/display-manifest.json', SUPABASE_JS];

self.addEventListener('install', e => {
  // One failed item must not stop the rest from being saved.
  e.waitUntil(caches.open(SHELL_CACHE).then(c => Promise.all(SHELL.map(u =>
    fetch(u, { cache: 'reload' }).then(r => r.ok ? c.put(u, r) : null).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Only this worker's own old caches: the console's are not ours to delete.
  e.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(k => k.startsWith('cuedeck-display-') && k !== SHELL_CACHE && k !== MEDIA_CACHE)
    .map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// A saved video, answered from the cache. A Range request gets 206 and only
// the bytes it asked for, which is how every browser plays and loops video.
async function fromMedia(req) {
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(req.url);
  if (!hit) return null;
  const range = req.headers.get('range');
  const type = hit.headers.get('content-type') || 'video/mp4';
  if (!range) return hit;
  const blob = await hit.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : blob.size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, blob.size - Number(m[2])); end = blob.size - 1; }  // suffix range
  if (start >= blob.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  end = Math.min(end, blob.size - 1);
  return new Response(blob.slice(start, end + 1, type), { status: 206, headers: {
    'Content-Type': type, 'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${blob.size}`, 'Content-Length': String(end - start + 1) } });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Saved videos (public files in the leod-assets bucket); anything not saved goes to the network.
  if (url.pathname.includes('/storage/v1/object/public/')) {
    e.respondWith(fromMedia(req).then(r => r || fetch(req)).catch(() => fetch(req)));
    return;
  }
  // Supabase API and realtime: never cached.
  if (url.hostname.endsWith('supabase.co')) return;

  // The page: network first (so updates arrive), the saved copy when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL_CACHE).then(c => c.put(url.pathname, copy)); }
      return r;
    }).catch(async () => (await caches.match(url.pathname)) || (await caches.match('/display')) || caches.match('/cuedeck-display.html')));
    return;
  }
  // The Supabase library and the page's files: saved copy first, refreshed in the background.
  if (url.href === SUPABASE_JS || url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL_CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; });
      return hit || net;
    }));
  }
});
