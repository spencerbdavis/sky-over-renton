/* Sky over Renton: the app shell and map tiles stay on the phone, live data never does. */
var SHELL = 'sky-shell-v15', TILES = 'sky-tiles-v1', TILE_MAX = 600;
var FILES = ['./', 'app.css?v=15', 'app.js?v=15', 'vendor/leaflet/leaflet.min.css?v=1.9.4', 'vendor/leaflet/leaflet.min.js?v=1.9.4',
  'airports.json?v=1', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-180.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== SHELL && k !== TILES; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function trim(c) { c.keys().then(function (ks) { if (ks.length > TILE_MAX) { for (var i = 0; i < ks.length - TILE_MAX; i++) { c.delete(ks[i]); } } }); }
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET') { return; }
  if (u.hostname === 'server.arcgisonline.com') {            /* tiles: cache first, refresh behind */
    e.respondWith(caches.open(TILES).then(function (c) {
      return c.match(e.request).then(function (hit) {
        var net = fetch(e.request).then(function (r) { if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); trim(c); } return r; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
    return;
  }
  if (u.origin !== location.origin || u.pathname.indexOf('/data/') >= 0 || u.pathname.indexOf('/api/') >= 0) { return; }   /* live: network */
  if (u.pathname.endsWith('/') || u.pathname.endsWith('/index.html')) {   /* page: network first so updates land, cache when offline */
    e.respondWith(fetch(e.request).then(function (r) { var cp = r.clone(); caches.open(SHELL).then(function (c) { c.put('./', cp); }); return r; })
      .catch(function () { return caches.match('./'); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); }));
});
