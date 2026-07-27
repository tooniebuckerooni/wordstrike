// WordJab service worker — bump CACHE version when shipping breaking changes
const CACHE = 'wordjab-v2';
const PRECACHE = [
  '/',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/site.webmanifest',
  '/og-image.png',
  '/fatcity-sponsor.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // fonts, Ably, analytics: straight through

  // Pages: network-first so game updates land immediately; cache when offline
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put('/', copy));
          return r;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets: cache-first, refresh in the background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request)
        .then(r => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return r;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
