/**
 * Service worker. Two jobs: make Chrome offer to install the app, and make the
 * 40-minute drive work with no signal.
 *
 * feed.json  - network first, fall back to cache. A fresh morning always wins,
 *              but yesterday's copy is better than an error screen.
 * mp3        - cache first, and kept. Once an episode has been played or
 *              downloaded it stays available in a tunnel or a dead spot.
 * app shell  - cache first, refreshed in the background.
 */

const VERSION = 'morgonbrief-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Audio: cache first and keep. Release assets are cross-origin, so the
  // response is opaque - that is fine for playback and for storage.
  if (url.pathname.endsWith('.mp3')) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        cache.put(request, res.clone()).catch(() => {});
        return res;
      })
    );
    return;
  }

  // The brief itself: fresh if possible, cached if not.
  if (url.pathname.endsWith('feed.json')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Everything else on our own origin: cache first, refresh behind the scenes.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const network = fetch(request)
          .then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
            return res;
          })
          .catch(() => hit);
        return hit || network;
      })
    );
  }
});
