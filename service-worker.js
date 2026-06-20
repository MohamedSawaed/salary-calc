/* ShiftPay service worker — offline-first app shell. */
var CACHE = 'shiftpay-v19';
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
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) return cached;
      return fetch(e.request).then(function (res) {
        // cache same-origin successful responses for next time
        if (res && res.status === 200 && e.request.url.indexOf(self.location.origin) === 0) {
          var clone = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function () {
        // offline fallback to app shell for navigations
        if (e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
