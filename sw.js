const VERSION = 'hidrantes-povoa-v1.0.0';
const APP_CACHE = `${VERSION}-app`;
const VENDOR_CACHE = `${VERSION}-vendor`;
const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './assets/hydrant_drop.png',
  './assets/hydrant_drop_192.png',
  './assets/hydrant_drop_512.png',
  './data/hydrants-seed.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(APP_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => ![APP_CACHE, VENDOR_CACHE].includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(APP_CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (_) {
        return (await caches.match(req)) || (await caches.match('./index.html'));
      }
    })());
    return;
  }

  // Leaflet pode ficar disponível offline depois de ter sido carregado online.
  if (url.hostname === 'unpkg.com') {
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const cached = await cache.match(req);
      if (cached) {
        event.waitUntil(fetch(req).then(r => { if (r.ok || r.type === 'opaque') cache.put(req, r.clone()); }).catch(() => {}));
        return cached;
      }
      const fresh = await fetch(req);
      if (fresh.ok || fresh.type === 'opaque') cache.put(req, fresh.clone());
      return fresh;
    })());
  }

  // Não fazemos pré-download nem cache massivo dos tiles públicos do OSM nesta v1.
});
