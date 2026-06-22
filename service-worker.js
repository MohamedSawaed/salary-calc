/* ShiftPay service worker — network-first (always fresh when online, cache fallback offline). */
var CACHE = 'shiftpay-v24';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './calc.js',
  './i18n.js',
  './cloud.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // addAll fails the whole install if any asset 404s; add individually instead.
      return Promise.all(ASSETS.map(function (url) {
        return c.add(url).catch(function () { /* ignore missing */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  // Only handle our own origin; let Firebase / other hosts go straight to the network.
  if (e.request.url.indexOf(self.location.origin) !== 0) return;
  // Network-first: always try the latest, refresh the cache, fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.status === 200) {
        var clone = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (cached) {
        if (cached) return cached;
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
