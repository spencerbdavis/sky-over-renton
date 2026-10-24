/* Sky over Renton: the app shell and map tiles stay on the phone, live data never does. */
var SHELL = 'sky-shell-v16', TILES = 'sky-tiles-v2', TILE_MAX = 4000, TRIM_EVERY = 100, puts = 0;
var FILES = ['./', 'app.css?v=16', 'app.js?v=16', 'stats.css?v=1', 'stats.js?v=2', 'vendor/leaflet/leaflet.min.css?v=1.9.4', 'vendor/leaflet/leaflet.min.js?v=1.9.4',
  'airports.json?v=1', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-180.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== SHELL && k !== TILES; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
/* trim is cheap: only every TRIM_EVERY puts, and one keys() then (oldest first) a batch of deletes */
function trim(c) {
  if (++puts % TRIM_EVERY) { return; }
  c.keys().then(function (ks) { var over = ks.length - TILE_MAX; if (over > 0) { over += 200; for (var i = 0; i < over && i < ks.length; i++) { c.delete(ks[i]); } } });
}
function tileFetch(e) {
  var req = e.request;
  return caches.open(TILES).then(function (c) {
    return c.match(req.url).then(function (hit) {
      if (hit && hit.ok && hit.type !== 'opaque') { return hit; }          /* tiles never change: cache first, no refresh */
      return fetch(req.url, { mode: 'cors' }).then(function (r) {
        if (r.ok && r.status === 200) { e.waitUntil(c.put(req.url, r.clone()).then(function () { trim(c); })); }
        return r;
      }).catch(function () { return hit || Response.error(); });
    });
  });
}
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET') { return; }
  if (u.hostname === 'server.arcgisonline.com') { e.respondWith(tileFetch(e)); return; }
  if (u.origin !== location.origin || u.pathname.indexOf('/data/') >= 0 || u.pathname.indexOf('/api/') >= 0) { return; }   /* live: network */
  if (u.pathname.endsWith('/') || u.pathname.endsWith('/index.html')) {   /* page: network first so updates land, cache when offline */
    e.respondWith(fetch(e.request).then(function (r) { var cp = r.clone(); caches.open(SHELL).then(function (c) { c.put('./', cp); }); return r; })
      .catch(function () { return caches.match('./'); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); }));
});
