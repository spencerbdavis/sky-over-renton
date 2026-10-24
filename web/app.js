/* Sky over Renton: live aircraft from our own receiver (readsb, /data/aircraft.json),
   topped up from the community networks (/api/fill) with what our antenna can't hear
   (parked and taxiing at SEA/BFI, beyond range); airline/route/photo/history from the
   sky-api (/api/ac/<hex>), map tiles from Esri. */
(function () {
  'use strict';
  var HOME = [47.48, -122.21];                /* replaced by receiver.json */
  var NM = 1852, OPEN_NM = 22;                 /* the first view: this many nm around home */
  var map, tiles, labels, outline = null, outlinePts = null, markers = {}, trails = {}, sel = null, planes = [];
  var lastMsg = null, info = {}, me = null, meMarker = null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var store = function (k, v) { try { if (v === undefined) { return localStorage.getItem(k); } localStorage.setItem(k, v); } catch (e) {} return null; };

  /* ---------- theme ---------- */
  if (store('sky-theme')) { document.documentElement.setAttribute('data-theme', store('sky-theme')); }
  function dark() {
    var t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function setTiles() {
    var base = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_' + (dark() ? 'Dark' : 'Light') + '_Gray_',
      url = base + 'Base/MapServer/tile/{z}/{y}/{x}', ref = base + 'Reference/MapServer/tile/{z}/{y}/{x}';
    document.querySelector('meta[name=theme-color]').setAttribute('content', dark() ? '#0d0d0e' : '#f6f4ef');
    if (tiles) { tiles.setUrl(url); labels.setUrl(ref); return; }
    var opt = { maxNativeZoom: 16, maxZoom: 18, detectRetina: false, crossOrigin: true, keepBuffer: 2,
      updateWhenIdle: false, updateWhenZooming: false, updateInterval: 120 };
    tiles = L.tileLayer(url, L.extend({ attribution: 'Esri, HERE, Garmin, © OpenStreetMap' }, opt)).addTo(map);
    labels = L.tileLayer(ref, L.extend({ pane: 'labels', opacity: .9 }, opt)).addTo(map);
    [tiles, labels].forEach(retryTiles);
  }
  /* an errored tile is retried (3 times, backing off) instead of staying a hole in the map */
  function retryTiles(layer) {
    layer.on('tileerror', function (e) {
      var t = e.tile, n = (t._retry || 0) + 1;
      if (n > 3 || !t.parentNode) { return; }
      t._retry = n;
      setTimeout(function () { if (t.parentNode) { t.src = e.tile.src.split('#')[0] + (n > 1 ? '#r' + n : ''); } }, 600 * n * n);
    });
  }
  /* warm the service-worker cache: a few tiles around home one zoom level either side of the opening view */
  function prefetch() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller || (navigator.connection && navigator.connection.saveData)) { return; }
    var z0 = Math.min(16, Math.round(map.getZoom())), urls = [];
    [z0, z0 - 1, z0 + 1, z0 - 2].forEach(function (z) {
      if (z < 3 || z > 16) { return; }
      var n = Math.pow(2, z), r = z === z0 ? 3 : 2, p = Math.PI / 180,
        x = Math.floor((HOME[1] + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(HOME[0] * p) + 1 / Math.cos(HOME[0] * p)) / Math.PI) / 2 * n);
      for (var i = -r; i <= r; i++) { for (var j = -r; j <= r; j++) {
        ['Base', 'Reference'].forEach(function (k) {
          urls.push('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_' + (dark() ? 'Dark' : 'Light') + '_Gray_' + k + '/MapServer/tile/' + z + '/' + (y + j) + '/' + (x + i));
        });
      } }
    });
    (function next() { var u = urls.shift(); if (u) { fetch(u, { mode: 'cors' }).catch(function () {}).then(function () { setTimeout(next, 60); }); } })();
  }
  /* the shadow filter on the airport pane is dropped while zooming: re-filtering a huge SVG every frame starves iOS of GPU memory and the tiles go blank */
  function zoomFilter() {
    map.on('zoomstart', function () { map._container.classList.add('zooming'); });
    map.on('zoomend', function () { map._container.classList.remove('zooming'); });
  }
  $('theme').onclick = function () {
    var next = dark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next); store('sky-theme', next);
    setTiles(); drawOutline();
  };

  /* ---------- geometry ---------- */
  function distNm(a, b, c, d) {
    var p = Math.PI / 180, x = Math.sin(a * p) * Math.sin(c * p) + Math.cos(a * p) * Math.cos(c * p) * Math.cos((b - d) * p);
    return 3440.1 * Math.acos(Math.min(1, x));
  }
  function bearing(a, b, c, d) {
    var p = Math.PI / 180, y = Math.sin((d - b) * p) * Math.cos(c * p),
      x = Math.cos(a * p) * Math.sin(c * p) - Math.sin(a * p) * Math.cos(c * p) * Math.cos((d - b) * p);
    return (Math.atan2(y, x) / p + 360) % 360;
  }
  function compass(deg) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]; }
  function altOf(a) { return a.alt_baro === 'ground' ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : a.alt_geom); }
  function altColor(ft) {
    if (ft == null || ft <= 0) { return dark() ? '#e9e3d6' : '#4f4c47'; }      /* on the ground: stands off the airport greys */
    var t = Math.min(1, Math.log(1 + ft / 500) / Math.log(1 + 40000 / 500));
    return 'hsl(' + Math.round(20 + t * 250) + ',' + Math.round(88 - t * 18) + '%,' + Math.round(54 - Math.abs(t - .5) * 8) + '%)';
  }
  function fmt(n) { return n == null ? '–' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function circleBounds(c, nm) {
    var dLat = nm / 60, dLon = nm / (60 * Math.cos(c[0] * Math.PI / 180));
    return [[c[0] - dLat, c[1] - dLon], [c[0] + dLat, c[1] + dLon]];
  }

  /* ---------- map: open straight onto the home area (no waiting for anything) ---------- */
  map = L.map('map', { zoomControl: false, zoomSnap: .25, preferCanvas: false });
  var AT = /[?&]at=(-?[\d.]+),(-?[\d.]+),([\d.]+)/.exec(location.search);   /* ?at=lat,lon,zoom opens on that view */
  if (AT) { map.setView([+AT[1], +AT[2]], +AT[3]); } else { map.fitBounds(circleBounds(HOME, OPEN_NM), { padding: [0, 0] }); }
  map.createPane('labels').style.zIndex = 390;
  map.getPane('labels').style.pointerEvents = 'none';
  zoomFilter();
  setTiles();
  if (window.requestIdleCallback) { requestIdleCallback(prefetch, { timeout: 8000 }); } else { setTimeout(prefetch, 4000); }
  var homeMarker = L.marker(HOME, { icon: L.divIcon({ className: '', html: '<div class="home"></div>', iconSize: [0, 0] }), interactive: false }).addTo(map);
  var rings = [10, 25, 50].map(function (r) {
    return L.circle(HOME, { radius: r * NM, color: '#9a9183', weight: 1, opacity: .35, fill: false, interactive: false }).addTo(map);
  });
  /* ---------- local airports: SEA, BFI, RNT (web/airports.json, built from OpenStreetMap by tools/build_airports.py) ----------
     Drawn like a 3-D map: aprons and taxiways in concrete, runways in asphalt with their
     painted centre line, threshold stripes and numbers, and every building extruded to its
     height (the roof lifted north by its height, the walls between shaded by which way they
     face). Detail comes in with zoom: runways always, taxiways at 12, buildings at 13,
     markings at 14. */
  var AIRPORTS = [
    { code: 'SEA', name: 'Sea-Tac', at: [47.4510, -122.3200], west: 1 },
    { code: 'BFI', name: 'Boeing Field', at: [47.5330, -122.2930] },
    { code: 'RNT', name: 'Renton', at: [47.4932, -122.2125] }
  ];
  AIRPORTS.forEach(function (ap) {
    L.marker(ap.at, { icon: L.divIcon({ className: '', html: '<div class="ap' + (ap.west ? ' w' : '') + '"><b>' + ap.code + '</b><span>' + ap.name + '</span></div>', iconSize: [0, 0] }), interactive: false, zIndexOffset: -500 }).addTo(map);
  });
  map.createPane('aptBase').style.zIndex = 250;
  map.createPane('aptBld').style.zIndex = 260;
  var aptBase = L.svg({ pane: 'aptBase', padding: .3 }), aptBld = L.svg({ pane: 'aptBld', padding: .3 }), apt = null;
  function mOff(ll, north, east) { return [ll[0] + north / 111320, ll[1] + east / (111320 * Math.cos(ll[0] * Math.PI / 180))]; }
  function drawAirports(d) {
    var o = function (cls, more) { var x = { className: cls, interactive: false, smoothFactor: .5, stroke: false, fillOpacity: 1 }, k; for (k in more || {}) { x[k] = more[k]; } return x; };
    var base = { renderer: aptBase }, bld = { renderer: aptBld }, rw = [], cl = [], keys = [], nums = [], walls = [[], [], []], roofs = [], troofs = [];
    d.rwy.forEach(function (r) {
      var a = r.a, b = r.b, k = Math.cos(a[0] * Math.PI / 180), dn = (b[0] - a[0]) * 111320, de = (b[1] - a[1]) * 111320 * k,
        len = Math.sqrt(dn * dn + de * de), un = dn / len, ue = de / len, hw = r.w / 2, brg = (Math.atan2(de, dn) * 180 / Math.PI + 360) % 360;
      var at = function (along, across) { return mOff(a, un * along - ue * across, ue * along + un * across); };
      rw.push([at(0, -hw), at(len, -hw), at(len, hw), at(0, hw)]);
      cl.push([at(150, 0), at(len - 150, 0)]);
      keys.push([at(18, -hw * .82), at(18, hw * .82)], [at(len - 18, -hw * .82), at(len - 18, hw * .82)]);
      var ends = String(r.ref).split('/'), h0 = parseInt(ends[0], 10) * 10, aFirst = Math.abs(((brg - h0 + 540) % 360) - 180) < 90;
      nums.push({ ll: at(75, 0), t: aFirst ? ends[0] : ends[1], rot: brg }, { ll: at(len - 75, 0), t: aFirst ? ends[1] : ends[0], rot: brg + 180 });
    });
    d.bld.forEach(function (bd) {
      var lift = bd.h * 1.1, r = bd.r, top = r.map(function (p) { return mOff(p, lift, 0); }), i, p, q, en, ee, nx;
      for (i = 0; i < r.length - 1; i++) {
        p = r[i]; q = r[i + 1];
        en = q[0] - p[0]; ee = (q[1] - p[1]) * Math.cos(p[0] * Math.PI / 180);
        nx = en / (Math.sqrt(en * en + ee * ee) || 1);          /* east-west part of the wall's facing */
        walls[nx > .35 ? 0 : nx < -.35 ? 2 : 1].push([p, q, top[i + 1], top[i]]);
      }
      (bd.t ? troofs : roofs).push(top);
    });
    apt = {
      area: L.polygon(d.area, o('apt-area', base)),
      apron: L.polygon(d.apron, o('apt-apron', base)),
      taxi: L.polyline(d.taxi, o('apt-twy', { renderer: aptBase, stroke: true, fill: false, lineCap: 'round', lineJoin: 'round' })),
      taxiCl: L.polyline(d.taxi, o('apt-twy-cl', { renderer: aptBase, stroke: true, fill: false, weight: 1 })),
      rwy: L.polygon(rw, o('apt-rwy', base)),
      rwyCl: L.polyline(cl, o('apt-mark', { renderer: aptBase, stroke: true, fill: false, lineCap: 'butt' })),
      keys: L.polyline(keys, o('apt-mark', { renderer: aptBase, stroke: true, fill: false, lineCap: 'butt' })),
      walls: walls.map(function (w, i) { return L.polygon(w, o('apt-wall' + i, bld)); }),
      roofs: [L.polygon(roofs, o('apt-roof', bld)), L.polygon(troofs, o('apt-roof apt-term', bld))],
      nums: nums.map(function (n) {
        return L.marker(n.ll, { interactive: false, pane: 'aptBld', icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="rw-n" style="transform:translate(-50%,-50%) rotate(' + n.rot.toFixed(1) + 'deg)">' + esc(n.t) + '</div>' }) });
      })
    };
    [apt.area, apt.apron, apt.taxi, apt.taxiCl, apt.rwy, apt.rwyCl, apt.keys].forEach(function (l) { l.addTo(map); });
    sizeAirports();
  }
  function sizeAirports() {
    if (!apt) { return; }
    var z = map.getZoom(), mpp = 40075016 * Math.cos(47.47 * Math.PI / 180) / Math.pow(2, z + 8), px = function (m) { return m / mpp; };
    var show = function (l, on) { if (on && !map.hasLayer(l)) { l.addTo(map); } else if (!on && map.hasLayer(l)) { map.removeLayer(l); } };
    show(apt.taxi, z >= 12); show(apt.taxiCl, z >= 15);
    show(apt.rwyCl, z >= 13.5); show(apt.keys, z >= 14);
    apt.walls.concat(apt.roofs).forEach(function (l) { show(l, z >= 13); });
    apt.nums.forEach(function (l) { show(l, z >= 14.5); });
    apt.taxi.setStyle({ weight: Math.max(1.2, px(23)) });
    apt.rwyCl.setStyle({ weight: Math.max(1, px(1)), dashArray: px(36).toFixed(1) + ' ' + px(24).toFixed(1) });
    apt.keys.setStyle({ weight: px(30), dashArray: Math.max(.8, px(1.8)).toFixed(2) + ' ' + Math.max(.8, px(1.8)).toFixed(2) });
    map.getContainer().style.setProperty('--rwn', Math.max(8, Math.min(26, px(18))).toFixed(1) + 'px');
  }
  fetch('airports.json?v=1').then(function (r) { return r.json(); }).then(drawAirports).catch(function () {});
  function apNames() { map.getContainer().classList.toggle('z-near', map.getZoom() >= 11); map.getContainer().classList.toggle('z-apt', map.getZoom() >= 14); }   /* names only once zoomed in; tags give way to the drawing up close */
  apNames();
  map.on('zoomend', function () { sizeAirports(); apNames(); });
  function setHome(h) {
    HOME = h; homeMarker.setLatLng(h);
    rings.forEach(function (c) { c.setLatLng(h); });
  }

  /* ---------- where am I (HTTPS only: browsers refuse location on plain http) ---------- */
  function locate(pan) {
    if (!window.isSecureContext || !navigator.geolocation) { if (pan) { map.flyToBounds(circleBounds(HOME, OPEN_NM)); } return; }
    navigator.geolocation.getCurrentPosition(function (p) {
      me = [p.coords.latitude, p.coords.longitude];
      if (!meMarker) { meMarker = L.marker(me, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [0, 0] }), interactive: false, zIndexOffset: 500 }).addTo(map); }
      else { meMarker.setLatLng(me); }
      $('locate').classList.add('on');
      /* near home: open around me; far away the receiver can't hear my sky, so stay home */
      if (pan || distNm(me[0], me[1], HOME[0], HOME[1]) < 60) { map.flyToBounds(circleBounds(pan ? me : HOME, pan ? 12 : OPEN_NM), { duration: .6 }); }
    }, function () { if (pan) { map.flyToBounds(circleBounds(HOME, OPEN_NM)); } }, { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 });
  }
  $('locate').onclick = function () { locate(true); };

  /* ---------- markers ---------- */
  /* ---------- aircraft shapes (web/shapes, built by tools/build_shapes.py) ----------
     A top-down silhouette per ICAO type, drawn to scale (1 unit ~ 1 m), fetched only
     when that type is in the sky; size on the map follows the real airframe. */
  var SHAPES = { size: {}, aliases: {}, category: {} }, shapeSvg = {}, shapeAsk = {};
  var GENERIC = '<path d="M12 1.5c.9 0 1.5 1.2 1.5 2.6v5.2l7.6 4.6v2l-7.6-2.3v4.6l2.2 1.7v1.6L12 20.4l-3.7 1.1v-1.6l2.2-1.7v-4.6L2.9 15.9v-2l7.6-4.6V4.1c0-1.4.6-2.6 1.5-2.6z"/>';
  function shapeOf(a) {
    var t = String(a.t || '').toUpperCase();
    if (SHAPES.size[t]) { return t; }
    if (SHAPES.aliases[t]) { return SHAPES.aliases[t]; }
    return SHAPES.category[a.category] || 'Unidentified';
  }
  function shapePx(code) {
    var span = SHAPES.size[code] || 30, mpp = 40075016 * Math.cos(47.47 * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
    /* icon size by real size; zoomed right in (the airports) the plane is drawn at its true size */
    return Math.round(Math.max(Math.max(18, Math.min(46, 10 + span * .42)), Math.min(220, span * 1.1 / mpp)));
  }
  function wantShape(code) {
    if (shapeSvg[code] || shapeAsk[code] || !SHAPES.size[code]) { return; }
    shapeAsk[code] = 1;
    var x = new XMLHttpRequest();
    x.open('GET', 'shapes/' + code + '.svg?v=1', true);
    x.onload = function () {
      var m = x.status === 200 && /viewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/.exec(x.responseText);
      if (m) { shapeSvg[code] = { vb: m[1], body: m[2] }; for (var h in markers) { if (markers[h]._shape === code) { markers[h]._key = ''; } } }
    };
    x.send();
  }
  function planeSvg(color, code) {
    var sh = shapeSvg[code];
    if (!sh) { return '<svg viewBox="0 0 24 24" fill="' + color + '" stroke="rgba(0,0,0,.35)" stroke-width=".6">' + GENERIC + '</svg>'; }
    return '<svg viewBox="' + sh.vb + '" fill="' + color + '" stroke="' + color + '" stroke-width=".5" stroke-linejoin="round">' + sh.body + '</svg>';
  }
  function name(a) { return (a.flight || '').trim() || a.r || a.hex.toUpperCase(); }
  /* ---------- motion: dead reckoning between fixes ----------
     Each plane flies on from its last fix at its reported speed and track, every
     animation frame. A new fix that disagrees with where we drew it is blended in
     over BLEND_S (no snap); the heading eases round the same way. Nothing is drawn
     more than MAX_COAST_S past a fix, so a plane that stops reporting stops too. */
  var motion = {}, BLEND_S = 1.2, MAX_COAST_S = 12;
  function predict(st, t) {
    var dt = Math.min(MAX_COAST_S, Math.max(0, t - st.t)), nm = (st.gs || 0) * dt / 3600, r = st.trk * Math.PI / 180;
    return [st.lat + nm * Math.cos(r) / 60, st.lon + nm * Math.sin(r) / (60 * Math.cos(st.lat * Math.PI / 180))];
  }
  function drawn(hx, t) {
    var st = motion[hx], p, k;
    if (!st) { return null; }
    p = predict(st, t);
    k = Math.exp(-(t - st.t0) / (BLEND_S / 3));        /* ~95 % of the correction gone after BLEND_S */
    return [p[0] + st.dLat * k, p[1] + st.dLon * k];
  }
  function fix(a, fixT, nowT) {
    var st = motion[a.hex], cur = st && drawn(a.hex, nowT), trk = a.track != null ? a.track : (a.true_heading || 0), p;
    var next = { lat: a.lat, lon: a.lon, t: fixT, gs: a.alt_baro === 'ground' ? Math.min(a.gs || 0, 40) : a.gs, trk: trk, t0: nowT, dLat: 0, dLon: 0,
      hdg: st ? st.hdg : trk };
    if (cur) {
      p = predict(next, nowT);
      next.dLat = cur[0] - p[0]; next.dLon = cur[1] - p[1];
      if (Math.abs(next.dLat) > .05 || Math.abs(next.dLon) > .07) { next.dLat = next.dLon = 0; }   /* a big jump (bad fix, gap): just move */
    }
    motion[a.hex] = next;
  }
  var RAF = window.requestAnimationFrame || function (f) { return setTimeout(f, 33); };
  function frame() {
    var t = Date.now() / 1000, hx, m, st, p, el, d;
    if (!document.hidden && !map._animatingZoom) {
      for (hx in markers) {
        m = markers[hx]; st = motion[hx];
        if (!st) { continue; }
        p = drawn(hx, t);
        m.setLatLng(p);
        d = ((st.trk - st.hdg + 540) % 360) - 180;          /* shortest way round */
        st.hdg = Math.abs(d) < .5 ? st.trk : st.hdg + d * .12;
        el = m._pl || (m._pl = m.getElement() && m.getElement().querySelector('.pl'));
        if (el && el._h !== Math.round(st.hdg * 2)) { el._h = Math.round(st.hdg * 2); el.style.transform = 'rotate(' + st.hdg.toFixed(1) + 'deg)'; }
      }
    }
    RAF(frame);
  }
  function upsert(a) {
    var m = markers[a.hex], col = altColor(altOf(a)), html, t, st = motion[a.hex];
    var code = shapeOf(a), px = Math.round(shapePx(code) * (sel === a.hex ? 1.3 : a.alt_baro === 'ground' ? .85 : 1));
    wantShape(code);
    html = '<div class="pl' + (sel === a.hex ? ' sel' : '') + (a._net && sel !== a.hex ? ' net' : '') + '" style="width:' + px + 'px;height:' + px + 'px;margin:' + (-px / 2) + 'px 0 0 ' + (-px / 2) + 'px;transform:rotate(' + (st ? st.hdg : (a.track || 0)).toFixed(1) + 'deg)">' + planeSvg(col, code) + '</div>' +
      (map.getZoom() >= 10 || sel === a.hex ? '<div class="lb" style="left:' + Math.round(px / 2 + 4) + 'px">' + esc(name(a)) + '</div>' : '');
    var key = col + '|' + (sel === a.hex) + '|' + (map.getZoom() >= 10 ? name(a) : '') + '|' + code + (shapeSvg[code] ? '+' : '') + (a._net ? 'n' : '') + px;
    if (!m) {
      m = markers[a.hex] = L.marker(drawn(a.hex, Date.now() / 1000) || [a.lat, a.lon], { icon: L.divIcon({ className: '', html: html, iconSize: [0, 0] }) }).addTo(map);
      m.on('click', function (e) { L.DomEvent.stopPropagation(e); select(a.hex, false); });
    } else if (m._key !== key) {                           /* colour, label or selection changed (turning never rebuilds) */
      m.setIcon(L.divIcon({ className: '', html: html, iconSize: [0, 0] })); m._pl = null;
    }
    m._key = key; m._shape = code;
    m.setZIndexOffset(sel === a.hex ? 1000 : 100);
    t = trails[a.hex] = trails[a.hex] || [];
    if (!t.length || t[t.length - 1][0] !== a.lat || t[t.length - 1][1] !== a.lon) { t.push([a.lat, a.lon, col]); if (t.length > 600) { t.shift(); } }
  }
  var trailLine = null;
  function drawTrail() {
    var t = sel && trails[sel], i;
    if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
    if (!t || t.length < 2) { return; }
    trailLine = L.layerGroup();
    for (i = 1; i < t.length; i++) { L.polyline([t[i - 1], t[i]], { color: t[i][2], weight: 3, opacity: .9, interactive: false }).addTo(trailLine); }
    trailLine.addTo(map);
  }
  /* the receiver's own trace (everything we heard of this flight, not just since the page opened) */
  function loadTrace(hex) {
    get('data/traces/' + hex.slice(-2) + '/trace_full_' + hex + '.json', function (d) {
      var t = d && d.trace, out = [], i, e, start = 0;
      if (!t || hex !== sel) { return; }
      /* the trace holds the airframe's whole day: keep only this leg (after the last
         10-minute silence or the last time it sat on the ground) */
      for (i = 1; i < t.length; i++) {
        if (t[i][0] - t[i - 1][0] > 600 || (t[i - 1][3] === 'ground' && t[i][3] !== 'ground' && i < t.length - 1)) { start = i; }
      }
      for (i = start; i < t.length; i++) {
        e = t[i];
        if (e[1] != null && e[2] != null) { out.push([e[1], e[2], altColor(e[3] === 'ground' ? 0 : e[3])]); }
      }
      if (out.length > (trails[hex] || []).length) { trails[hex] = out; drawTrail(); }
    });
  }

  /* ---------- coverage outline (readsb, last 24 h), 10 deg sectors ---------- */
  function drawOutline() {
    if (outline) { map.removeLayer(outline); outline = null; }
    if (!outlinePts || outlinePts.length < 3) { return; }
    outline = L.polygon(outlinePts, { color: dark() ? '#f4ecdc' : '#151515', weight: 1.5, opacity: .4, dashArray: '4 5', fillOpacity: .04, interactive: false }).addTo(map);
  }
  function loadOutline() {
    get('data/outline.json', function (o) {
      var p = o && o.actualRange && o.actualRange.last24h && o.actualRange.last24h.points, best = 0, i, sec = [], dd, k;
      if (!p) { return; }
      for (i = 0; i < p.length; i++) {
        dd = distNm(HOME[0], HOME[1], p[i][0], p[i][1]); k = Math.floor(bearing(HOME[0], HOME[1], p[i][0], p[i][1]) / 10);
        best = Math.max(best, dd);
        if (!sec[k] || dd > sec[k].d) { sec[k] = { d: dd, ll: [p[i][0], p[i][1]] }; }
      }
      outlinePts = [];
      for (i = 0; i < 36; i++) { if (sec[i]) { outlinePts.push(sec[i].ll); } }
      $('s-24').innerHTML = Math.round(best) + '<small>nm</small>';
      drawOutline();
    });
  }

  /* ---------- list ---------- */
  function sub(a) {
    var x = info[a.hex], al = x && x.airline && x.airline.name, rt = x && x.route && x.route.trusted ? x.route.from.iata + ' → ' + x.route.to.iata : '';
    return [rt || al, a.t, (a.flight || '').trim() ? a.r : ''].filter(Boolean).join(' · ') || 'Unknown type';
  }
  /* row picture: the airline's logo (by the callsign's ICAO prefix, so it shows before any lookup),
     else the airframe's photo, else its silhouette */
  var badLogo = {};
  window.skyNoLogo = function (img) { badLogo[img.getAttribute('data-al')] = 1; img.parentNode.innerHTML = img.getAttribute('data-sil'); };
  function avatar(a) {
    var x = info[a.hex], cs = (a.flight || '').trim(), al = /^[A-Z]{3}\d/.test(cs) ? cs.slice(0, 3) : '',
      ph = x && x.aircraft && x.aircraft.photo, sil = planeSvg(altColor(altOf(a)), shapeOf(a));
    if (al && !badLogo[al]) {
      return '<i class="r-av r-logo"><img alt="" src="https://www.flightaware.com/images/airline_logos/90p/' + al + '.png" data-al="' + al +
        '" data-sil="' + esc(sil) + '" onerror="skyNoLogo(this)"></i>';
    }
    if (ph) { return '<i class="r-av r-ph" style="background-image:url(' + esc(ph) + ')"></i>'; }
    return '<i class="r-av r-sil">' + sil + '</i>';
  }
  function rowParts(a) {
    var alt = altOf(a), vr = a.baro_rate || a.geom_rate || 0;
    return [avatar(a),
      '<i class="alt-bar" style="background:' + altColor(alt) + '"></i>' +
      '<div class="r-m"><b>' + esc(name(a)) + (a._net ? '<em class="r-net">NET</em>' : '') + '</b><span>' + esc(sub(a)) + '</span></div>' +
      '<div class="r-n"><b>' + (alt ? fmt(alt) + ' ft' : (a.gs > 5 ? 'Taxiing' : 'Parked')) + (vr > 300 ? ' ↑' : vr < -300 ? ' ↓' : '') + '</b><span>' + a._d.toFixed(1) + ' nm ' + compass(a._b) + '</span></div>'];
  }
  /* rows are kept and patched (not rebuilt each second) so logos and photos don't flicker */
  var rows = {}, groundHead = null;
  function renderList() {
    var box = $('list'), keep = {}, i, a, r, p, air = 0, gnd = 0, at = 0, kids = [];
    for (i = 0; i < planes.length; i++) {
      a = planes[i];
      if (a.alt_baro === 'ground') { gnd++; } else { air++; }
      if (a.alt_baro === 'ground' && gnd === 1) {
        groundHead = groundHead || (function () { var d = document.createElement('div'); d.className = 'r-hd'; return d; })();
        kids.push(groundHead);
      }
      r = rows[a.hex];
      if (!r) { r = rows[a.hex] = document.createElement('div'); r.setAttribute('data-hex', a.hex); r._a = r._b = ''; r.innerHTML = '<span class="r-avw"></span><span class="r-rest"></span>'; }
      p = rowParts(a);
      if (r._a !== p[0]) { r._a = p[0]; r.firstChild.innerHTML = p[0]; }
      if (r._b !== p[1]) { r._b = p[1]; r.lastChild.innerHTML = p[1]; }
      r.className = 'row' + (sel === a.hex ? ' sel' : '');
      keep[a.hex] = 1; kids.push(r);
    }
    if (groundHead) { groundHead.textContent = 'On the ground · ' + gnd; }
    for (i = 0; i < kids.length; i++) { if (box.children[at] !== kids[i]) { box.insertBefore(kids[i], box.children[at] || null); } at++; }
    while (box.children.length > kids.length) { box.removeChild(box.lastChild); }
    for (var h in rows) { if (!keep[h]) { delete rows[h]; } }
    if (!kids.length) { box.innerHTML = '<div class="empty">No aircraft in range right now</div>'; }
    $('cnt').textContent = air + ' flying' + (gnd ? ' · ' + gnd + ' on ground' : '');
  }
  $('list').onclick = function (e) {
    var t = e.target; while (t && t !== this && !t.getAttribute('data-hex')) { t = t.parentNode; }
    if (t && t !== this) { select(t.getAttribute('data-hex'), true); }
  };

  /* ---------- card ---------- */
  var PLANE = '<svg viewBox="0 0 24 24"><path fill="currentColor" transform="rotate(90 12 12)" d="M12 1.5c.9 0 1.5 1.2 1.5 2.6v5.2l7.6 4.6v2l-7.6-2.3v4.6l2.2 1.7v1.6L12 20.4l-3.7 1.1v-1.6l2.2-1.7v-4.6L2.9 15.9v-2l7.6-4.6V4.1c0-1.4.6-2.6 1.5-2.6z"/></svg>';
  function dayStr(iso) { var d = new Date(iso + 'T12:00'); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function historyText(h) {
    var today = new Date().toISOString().slice(0, 10), bits = [];
    if (!h) { return ''; }
    if (h.days <= 1 && h.first === today) { bits.push('First time our receiver has heard it'); }
    else if (h.days) { bits.push('Heard on ' + h.days + (h.days === 1 ? ' day' : ' days') + ' since ' + dayStr(h.since)); }
    if (h.prev_day) {
      var gap = Math.round((new Date(today) - new Date(h.prev_day)) / 864e5);
      bits.push('last here ' + (gap === 1 ? 'yesterday' : gap + ' days ago'));
    }
    if (h.callsigns && h.callsigns.length > 1) { bits.push('as ' + h.callsigns.slice(-4).join(', ')); }
    return bits.join(' · ');
  }
  var EMERG = { '7500': 'Hijack', '7600': 'Radio failure', '7700': 'Emergency' };
  function hm(t) { var d = new Date(t); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function cardHtml(a) {
    var x = info[a.hex] || {}, ac = x.aircraft || {}, al = x.airline, rt = x.route, alt = altOf(a), vr = a.baro_rate || a.geom_rate,
      cs = (a.flight || '').trim(), h = '', pct, df, dt, ht, mins, em = EMERG[a.squawk], code = shapeOf(a);
    h += '<div class="c-grab"><i></i></div><div class="c-in">';
    h += '<div class="c-h">' + (ac.photo ? '<a class="c-ph" target="_blank" rel="noopener" href="' + esc(ac.photo_large || ac.photo) + '" style="background-image:url(' + esc(ac.photo) + ')"></a>'
      : '<div class="c-ph c-sil" style="color:' + altColor(alt) + '">' + planeSvg('currentColor', code) + '</div>') +
      '<div class="tt"><b style="color:' + altColor(alt) + '">' + esc(name(a)) + '</b>' +
      (al && al.name ? '<div class="c-al">' + (al.iata ? '<img alt="" src="https://pics.avs.io/200/80/' + encodeURIComponent(al.iata) + '.png" onerror="this.remove()">' : '') + '<span>' + esc(al.name) + '</span></div>' : '') +
      '<span>' + esc([ac.maker && ac.type ? ac.maker + ' ' + ac.type : (a.desc || a.t), a.r || ac.reg].filter(Boolean).join(' · ') || 'Unknown aircraft') + '</span></div>' +
      '<button class="c-x" id="cx" aria-label="Close">×</button></div>';
    if (em) { h += '<div class="c-em">Squawking ' + esc(a.squawk) + ' · ' + em + '</div>'; }
    if (rt && rt.from && rt.to && rt.trusted !== false) {
      df = distNm(rt.from.lat, rt.from.lon, a.lat, a.lon); dt = distNm(a.lat, a.lon, rt.to.lat, rt.to.lon);
      pct = Math.max(3, Math.min(97, 100 * df / (df + dt || 1)));
      mins = a.gs > 60 ? dt / a.gs * 60 : null;
      h += '<div class="c-rt"><div class="c-ap"><b>' + esc(rt.from.iata) + '</b><span>' + esc(rt.from.city || rt.from.name) + '</span></div>' +
        '<div class="c-pr"><i style="width:' + pct.toFixed(0) + '%"></i><em style="left:' + pct.toFixed(0) + '%"></em></div>' +
        '<div class="c-ap"><b>' + esc(rt.to.iata) + '</b><span>' + esc(rt.to.city || rt.to.name) + '</span></div></div>' +
        '<div class="c-note">' + (dt < 8 && alt < 3000 ? 'Arriving now' : Math.round(dt) + ' nm to go' + (mins != null ? ' · about ' + (mins < 90 ? Math.round(mins) + ' min' : Math.round(mins / 60 * 10) / 10 + ' h') + ' · lands ~' + hm(Date.now() + mins * 60000) : '')) + '</div>';
    } else if (rt && rt.from && rt.trusted === false) {
      h += '<div class="c-note">No current route for ' + esc(cs) + ' (listed ' + esc(rt.from.iata) + '–' + esc(rt.to.iata) + ' is another leg)</div>';
    } else if (x.failed) {
      h += '<div class="c-note">Airline and route details are unavailable right now</div>';
    } else if (!x.aircraft && !x.history) {
      h += '<div class="c-note">Looking up airline, route and history…</div>';
    }
    h += '<div class="c-g">' +
      '<div><b>' + (alt ? fmt(alt) : (a.gs > 5 ? 'Taxiing' : 'Parked')) + (alt ? '<small>ft</small>' : '') + '</b><span>Altitude</span></div>' +
      '<div><b>' + fmt(a.gs) + '<small>kt</small></b><span>' + fmt((a.gs || 0) * 1.15078) + ' mph</span></div>' +
      '<div><b>' + (vr == null || Math.abs(vr) < 100 ? 'Level' : (vr > 0 ? '↑ ' : '↓ ') + fmt(Math.abs(vr))) + (vr != null && Math.abs(vr) >= 100 ? '<small>fpm</small>' : '') + '</b><span>Climb</span></div>' +
      '<div><b>' + a._d.toFixed(1) + '<small>nm ' + compass(a._b) + '</small></b><span>From home</span></div>' +
      '<div><b>' + fmt(a.track) + '<small>° ' + compass(a.track || 0) + '</small></b><span>Heading</span></div>' +
      '<div><b>' + (a.squawk ? esc(a.squawk) : '–') + '</b><span>Squawk</span></div></div>';
    ht = historyText(x.history);
    if (ht || ac.owner) { h += '<div class="c-hi">' + esc(ht || '') + (ac.owner && (!al || ac.owner !== al.name) ? (ht ? ' · ' : '') + 'Registered to ' + esc(ac.owner) : '') + '</div>'; }
    h += '<div class="c-l">' + (cs ? '<a target="_blank" rel="noopener" href="https://www.flightaware.com/live/flight/' + encodeURIComponent(cs) + '">FlightAware</a>' : '') +
      '<a target="_blank" rel="noopener" href="https://globe.adsb.fi/?icao=' + a.hex + '">adsb.fi</a>' +
      '<a href="#' + a.hex + '" id="cshare">Share</a></div></div>';
    return h;
  }
  function byHex(hx) { for (var i = 0; i < planes.length; i++) { if (planes[i].hex === hx) { return planes[i]; } } return null; }
  var cardKey = '';
  function paintCard(a) {
    var k = JSON.stringify(info[a.hex] || null) + '|' + Math.round((a.alt_baro || 0) / 25) + '|' + Math.round(a.gs || 0) + '|' + Math.round(a._d * 10) + '|' + Math.round(a.track || 0);
    if (k === cardKey) { return; }
    var sc = $('card').scrollTop;
    cardKey = k; $('card').innerHTML = cardHtml(a); $('card').scrollTop = sc;
    $('cx').onclick = function () { select(null); };
    $('cshare').onclick = function (e) {
      var u = location.origin + location.pathname + '#' + a.hex;
      e.preventDefault();
      if (navigator.share) { navigator.share({ title: name(a), url: u }).catch(function () {}); }
      else if (navigator.clipboard) { navigator.clipboard.writeText(u); this.textContent = 'Link copied'; }
    };
  }
  function lookup(a) {
    if (info[a.hex] && info[a.hex]._at > Date.now() - 300000) { return; }
    info[a.hex] = info[a.hex] || {};
    info[a.hex]._at = Date.now();
    get('api/ac/' + a.hex + '?cs=' + encodeURIComponent((a.flight || '').trim()) + '&lat=' + a.lat.toFixed(4) + '&lon=' + a.lon.toFixed(4), function (d) {
      if (!d) { info[a.hex] = { _at: Date.now() - 240000, failed: true }; var f = byHex(a.hex); if (f && sel === a.hex) { paintCard(f); } return; }   /* retry in a minute */
      d._at = Date.now(); info[a.hex] = d;
      var b = byHex(a.hex);
      if (b && sel === a.hex) { paintCard(b); }
      renderList();
    });
  }
  function reveal(a) {                              /* centre the plane in the map area left above the card */
    var cardH = innerWidth >= 860 ? 0 : $('card').offsetHeight || 380, p = map.latLngToContainerPoint([a.lat, a.lon]);
    var target = L.point(map.getSize().x / 2, (map.getSize().y - cardH) / 2 + 40);
    map.panBy(p.subtract(target), { animate: true });
  }
  /* swipe the card down to close it */
  (function () {
    var c = $('card'), y0 = null, dy = 0;
    c.addEventListener('touchstart', function (e) { y0 = c.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
    c.addEventListener('touchmove', function (e) {
      if (y0 == null) { return; }
      dy = Math.max(0, e.touches[0].clientY - y0);
      if (dy > 6) { c.style.transition = 'none'; c.style.transform = 'translateY(' + dy + 'px)'; }
    }, { passive: true });
    c.addEventListener('touchend', function () {
      if (y0 == null) { return; }
      c.style.transition = ''; c.style.transform = '';
      if (dy > 80) { select(null); }
      y0 = null;
    });
  })();
  function select(hex, fly) {
    var a = byHex(hex), prev = sel;
    sel = a ? hex : null; cardKey = '';
    if (prev && markers[prev]) { markers[prev]._key = ''; }
    if (!a) { $('card').className = ''; $('sheet').classList.remove('away'); drawTrail(); renderList(); return; }
    lookup(a); paintCard(a); $('card').className = 'on';
    $('sheet').classList.remove('open'); $('sheet').classList.add('away');
    if (fly || !map.getBounds().contains([a.lat, a.lon])) { reveal(a); }
    upsert(a); drawTrail(); loadTrace(hex); renderList();
  }

  /* ---------- sheet drag ---------- */
  (function () {
    var sh = $('sheet'), y0 = 0, start = 0, h = 0, moved = false;
    function down(e) { var t = e.touches ? e.touches[0] : e; y0 = t.clientY; h = sh.offsetHeight - 200; start = sh.classList.contains('open') ? 0 : h; moved = false; sh.classList.add('drag'); }
    function move(e) {
      if (!sh.classList.contains('drag')) { return; }
      var t = e.touches ? e.touches[0] : e;
      if (Math.abs(t.clientY - y0) > 4) { moved = true; }
      sh.style.transform = 'translateY(' + Math.max(0, Math.min(h, start + t.clientY - y0)) + 'px)';
    }
    function up(e) {
      if (!sh.classList.contains('drag')) { return; }
      var t = e.changedTouches ? e.changedTouches[0] : e, dy = t.clientY - y0;
      sh.classList.remove('drag'); sh.style.transform = '';
      if (!moved) { sh.classList.toggle('open'); return; }
      if (dy < -40) { sh.classList.add('open'); } else if (dy > 40) { sh.classList.remove('open'); }
    }
    ['grab', 'shh'].forEach(function (id) { $(id).addEventListener('touchstart', down, { passive: true }); $(id).addEventListener('mousedown', down); });
    addEventListener('touchmove', move, { passive: true }); addEventListener('mousemove', move);
    addEventListener('touchend', up); addEventListener('mouseup', up);
  })();

  /* ---------- data ---------- */
  function get(url, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url + (url.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(), true);
    x.timeout = 8000;
    x.onload = function () { var o = null; if (x.status === 200) { try { o = JSON.parse(x.responseText); } catch (e) {} } cb(o); };
    x.onerror = x.ontimeout = function () { cb(null); };
    x.send();
  }
  var net = null, netBusy = false, NET_MAX_AGE = 90;
  function pullNet() {
    if (netBusy) { return; }
    netBusy = true;
    get('api/fill', function (d) { netBusy = false; if (d && d.aircraft) { var first = !net; net = d; if (first) { tick(); } } });
  }
  function tick() {
    get('data/aircraft.json', function (d) {
      var ok = d && d.aircraft && Date.now() / 1000 - d.now < 20, seen = {}, i, a, far = 0, hx;
      $('live').className = 'dot' + (ok ? '' : ' off');
      $('livet').textContent = ok ? 'Own receiver · live' : 'Receiver not answering';
      if (!ok) { return; }
      if (lastMsg && d.now > lastMsg[1]) { $('s-m').innerHTML = Math.round((d.messages - lastMsg[0]) / (d.now - lastMsg[1])) + '<small>/s</small>'; }
      lastMsg = [d.messages, d.now];
      planes = [];
      var nowT = Date.now() / 1000, off = nowT - d.now;     /* receiver clock -> this phone's clock */
      for (i = 0; i < d.aircraft.length; i++) {
        a = d.aircraft[i];
        if (a.lat == null || a.seen_pos > 60) { continue; }
        if (!motion[a.hex] || motion[a.hex].lat !== a.lat || motion[a.hex].lon !== a.lon) { fix(a, d.now - (a.seen_pos || 0) + off, nowT); }
        else if (a.track != null) { motion[a.hex].trk = a.track; motion[a.hex].gs = a.gs; }
        a._d = distNm(HOME[0], HOME[1], a.lat, a.lon); a._b = bearing(HOME[0], HOME[1], a.lat, a.lon);
        far = Math.max(far, a._d);
        planes.push(a); seen[a.hex] = 1; upsert(a);
      }
      var mine = planes.length;
      /* the networks' planes our antenna isn't hearing (same NTP clocks, so the same offset) */
      if (net && nowT - (net.now + off) < NET_MAX_AGE) {
        for (i = 0; i < net.aircraft.length; i++) {
          a = net.aircraft[i];
          if (seen[a.hex] || a.lat == null || nowT - (net.now - (a.seen_pos || 0) + off) > 60) { continue; }
          a._net = 1;
          if (!motion[a.hex] || motion[a.hex].lat !== a.lat || motion[a.hex].lon !== a.lon) { fix(a, net.now - (a.seen_pos || 0) + off, nowT); }
          a._d = distNm(HOME[0], HOME[1], a.lat, a.lon); a._b = bearing(HOME[0], HOME[1], a.lat, a.lon);
          planes.push(a); seen[a.hex] = 1; upsert(a);
        }
      }
      planes.sort(function (p, q) { return ((p.alt_baro === 'ground') - (q.alt_baro === 'ground')) || p._d - q._d; });   /* flying first, then the ground */
      for (hx in markers) { if (!seen[hx]) { map.removeLayer(markers[hx]); delete markers[hx]; delete motion[hx]; } }
      $('s-n').textContent = planes.length;
      $('livet').textContent = 'Own receiver · ' + mine + (planes.length > mine ? ' + ' + (planes.length - mine) + ' network' : ' live');
      $('s-r').innerHTML = Math.round(far) + '<small>nm</small>';
      if (sel) { a = byHex(sel); if (a) { paintCard(a); drawTrail(); } else { select(null); } }
      else if (/^#[0-9a-f]{6}$/.test(location.hash) && byHex(location.hash.slice(1))) { select(location.hash.slice(1), true); history.replaceState(null, '', location.pathname); }   /* link to a plane: /#a1b2c3 */
      renderList();
    });
  }
  /* the nearest few get their airline and route ahead of a tap (one lookup at a time, cached on the server) */
  var preBusy = false;
  function prefetch() {
    var i, a;
    if (preBusy) { return; }
    for (i = 0; i < Math.min(12, planes.length); i++) {
      a = planes[i];
      if (!info[a.hex]) {
        preBusy = true; lookup(a);
        setTimeout(function () { preBusy = false; }, 1500);
        return;
      }
    }
  }
  setInterval(prefetch, 2000);
  function stats() { get('api/stats', function (s) { if (s) { $('s-db').textContent = fmt(s.airframes); } }); }

  map.on('zoomend', function () { for (var h in markers) { markers[h]._key = ''; } tick(); });
  RAF(frame);
  map.on('click', function () { if (sel) { select(null); } });
  tick();
  get('shapes/index.json?v=1', function (d) { if (d && d.size) { SHAPES = d; for (var h in markers) { markers[h]._key = ''; } tick(); } });
  get('data/receiver.json', function (r) { if (r && r.lat != null) { setHome([r.lat, r.lon]); } loadOutline(); });
  if (!AT) { locate(false); }
  stats();
  pullNet();
  setInterval(pullNet, 10000);
  setInterval(tick, 1000);
  setInterval(stats, 60000);
  setInterval(loadOutline, 300000);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { setTiles(); drawOutline(); });
  /* app shell + map tiles cached on the phone (service workers need HTTPS) */
  if ('serviceWorker' in navigator && window.isSecureContext) { navigator.serviceWorker.register('sw.js'); }
})();
