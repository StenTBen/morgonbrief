/**
 * Service worker. Two jobs: make Chrome offer to install the app, and make the
 * drive work with no signal.
 *
 * Caching strategy per kind of request, chosen so that "I shipped a new version
 * and the installed app still shows the old one" cannot happen:
 *
 *   navigation  - network first. The app document is the thing that changes
 *                 whenever the design does, so online always means current.
 *                 Falls back to cache when there is no signal.
 *   feed.json   - network first, cached fallback. A fresh morning always wins.
 *   mp3         - cache first and kept. Once played, it survives a tunnel.
 *   other shell - stale-while-revalidate: instant from cache, refreshed behind.
 *
 * Bump VERSION whenever the shell list changes; activate purges every older
 * cache, so an update is a reload rather than a reinstall.
 */

const VERSION = 'morgonbrief-v3';
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

// Lets the page tell a waiting worker to take over immediately.
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // The app document itself: never served stale while online.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // Audio: cache first and kept. Release assets are cross-origin, so the
  // response is opaque - fine for playback and for storage.
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

  // Everything else on our own origin: instant from cache, refreshed behind.
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
