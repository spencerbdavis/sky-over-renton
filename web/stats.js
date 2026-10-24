/* Sky over Renton: detail sheets for the header stat chips (Planes, Messages, Farthest, Best 24 h, Logged).
   Bound by the ids inside each .st (s-n, s-m, s-r, s-24, s-db) with one delegated click handler, so the
   header can be restyled or moved. Live data comes from window.Sky (app.js); history from /api/log, /api/best,
   /api/rate and (private site only) /api/range. */
(function () {
  'use strict';
  var Sky = function () { return window.Sky || { planes: function () { return []; }, info: function () {}, byHex: function () {}, select: function () {} }; };
  var KINDS = { 's-n': 'planes', 's-m': 'rate', 's-r': 'far', 's-24': 'best', 's-db': 'log' };
  var TITLES = { planes: 'Traffic now', rate: 'Messages', far: 'Farthest now', best: 'Best range, 24 h', log: 'Airframe log' };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmt = function (n) { return n == null ? '–' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  var root, panel, body, titleEl, kind = null, timer = null, opener = null, seq = 0;

  function getJSON(url, cb) {
    var mine = ++seq;
    fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      .then(function (d) { cb(d, mine); });
  }
  function ago(ts) {
    var s = Date.now() / 1000 - ts, d = new Date(ts * 1000);
    if (s < 90) { return 'just now'; }
    if (s < 3600) { return Math.round(s / 60) + ' min ago'; }
    if (s < 86400) { return Math.round(s / 3600) + ' h ago'; }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function when(ts) {
    var d = new Date(ts * 1000), same = d.toDateString() === new Date().toDateString();
    return (same ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ') + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function bars(items, cls) {
    var max = 1, i, h = '';
    for (i = 0; i < items.length; i++) { max = Math.max(max, items[i][1]); }
    for (i = 0; i < items.length; i++) {
      h += '<div class="ss-bar"><span>' + esc(items[i][0]) + '</span><i><u style="width:' + (100 * items[i][1] / max).toFixed(1) + '%' + (items[i][2] ? ';background:' + items[i][2] : '') + '"></u></i><em>' + items[i][1] + '</em></div>';
    }
    return h || '<div class="ss-note">Nothing yet.</div>';
  }
  function kpis(list, cls) {
    return '<div class="ss-k ' + (cls || '') + '">' + list.map(function (k) { return '<div><b>' + k[0] + '</b><span>' + esc(k[1]) + '</span></div>'; }).join('') + '</div>';
  }
  function toast(msg) {
    var t = panel.querySelector('.ss-toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }
  function show(hex) {
    var S = Sky();
    if (hex && S.byHex(hex)) { close(); S.select(hex, true); return true; }
    toast('Not in the air right now');
    return false;
  }

  /* ---------- Planes ---------- */
  function renderPlanes() {
    var S = Sky(), P = S.planes(), fly = 0, gnd = 0, own = 0, net = 0, i, a, alt, band, bands = { 'On ground': 0, '< 3,000 ft': 0, '3–10k ft': 0, '10–25k ft': 0, '> 25k ft': 0 },
      ops = {}, opName = {}, types = {}, k, x, cs, out;
    for (i = 0; i < P.length; i++) {
      a = P[i];
      if (a.alt_baro === 'ground') { gnd++; band = 'On ground'; } else {
        fly++; alt = S.altOf ? S.altOf(a) : a.alt_baro;
        band = alt == null ? null : alt < 3000 ? '< 3,000 ft' : alt < 10000 ? '3–10k ft' : alt < 25000 ? '10–25k ft' : '> 25k ft';
      }
      if (band) { bands[band]++; }
      if (a._net) { net++; } else { own++; }
      cs = (a.flight || '').trim(); x = S.info(a.hex);
      k = /^[A-Z]{3}\d/.test(cs) ? cs.slice(0, 3) : '';
      if (k) { ops[k] = (ops[k] || 0) + 1; if (x && x.airline && x.airline.name) { opName[k] = x.airline.name; } } else { ops['GA / other'] = (ops['GA / other'] || 0) + 1; }
      k = a.t || (a.desc ? String(a.desc).slice(0, 14) : '');
      if (k) { types[k] = (types[k] || 0) + 1; }
    }
    function top(m, names) { return Object.keys(m).map(function (z) { return [(names && names[z]) || z, m[z]]; }).sort(function (p, q) { return q[1] - p[1]; }).slice(0, 6); }
    out = kpis([[fly, 'Flying'], [gnd, 'On ground'], [own, 'Own receiver'], [net, 'Network']]) +
      '<div class="ss-s">Altitude</div>' + bars(Object.keys(bands).map(function (z) { return [z, bands[z]]; })) +
      '<div class="ss-s">Top operators</div>' + bars(top(ops, opName)) +
      '<div class="ss-s">Top types</div>' + bars(top(types)) +
      '<div class="ss-note">Network planes come from adsb.fi / adsb.lol / airplanes.live and fill in what the antenna can\'t hear. Updates live.</div>';
    body.innerHTML = out;
  }

  /* ---------- Messages ---------- */
  var rateH = 6;
  function spark(pts, w, h) {
    var i, max = 1, min = 0, x, y, d = '', t0, t1, pad = 22;
    for (i = 0; i < pts.length; i++) { max = Math.max(max, pts[i][1]); }
    max = Math.ceil(max / 10) * 10 || 10;
    t0 = pts[0][0]; t1 = pts[pts.length - 1][0] || t0 + 1;
    for (i = 0; i < pts.length; i++) {
      x = pad + (w - pad - 4) * (pts[i][0] - t0) / Math.max(1, t1 - t0); y = h - 16 - (h - 26) * (pts[i][1] - min) / (max - min);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return '<svg class="ss-chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Message rate">' +
      '<line class="g" x1="' + pad + '" x2="' + w + '" y1="10" y2="10"/><line class="g" x1="' + pad + '" x2="' + w + '" y1="' + (h - 16) + '" y2="' + (h - 16) + '"/>' +
      '<text x="0" y="13">' + max + '</text><text x="0" y="' + (h - 13) + '">0</text>' +
      '<path class="a" d="' + d + 'L' + (w - 4) + ' ' + (h - 16) + 'L' + pad + ' ' + (h - 16) + 'Z"/><path class="l" d="' + d + '"/>' +
      '<text x="' + pad + '" y="' + (h - 2) + '">' + rateH + ' h ago</text><text x="' + (w - 4) + '" y="' + (h - 2) + '" text-anchor="end">now</text></svg>';
  }
  function renderRate() {
    var cur = parseInt(($('s-m') || {}).textContent, 10);
    body.innerHTML = kpis([[(isNaN(cur) ? '–' : fmt(cur)) + '<small>/s</small>', 'Right now']], '') +
      '<div class="ss-tabs">' + [1, 6, 24].map(function (h) { return '<button data-h="' + h + '"' + (h === rateH ? ' class="on"' : '') + '>' + h + ' h</button>'; }).join('') + '</div><div id="ss-rc"><div class="ss-note">Loading…</div></div>';
    getJSON('api/rate?h=' + rateH, function (d, mine) {
      var el = $('ss-rc'), p, sum = 0, mx = 0, i;
      if (!el || kind !== 'rate') { return; }
      p = d && d.pts;
      if (!p || p.length < 2) { el.innerHTML = '<div class="ss-note">' + (d ? 'Still collecting. A sample is logged each minute.' : 'History unavailable.') + '</div>'; return; }
      for (i = 0; i < p.length; i++) { sum += p[i][1]; mx = Math.max(mx, p[i][1]); }
      el.innerHTML = spark(p, 358, 150) + kpis([[fmt(sum / p.length) + '<small>/s</small>', 'Average'], [fmt(mx) + '<small>/s</small>', 'Peak']], '') +
        '<div class="ss-note">Messages the receiver decodes per second. Quiet hours run low; busy arrival banks and nearby traffic push it up.</div>';
    });
  }

  /* ---------- Farthest ---------- */
  function rose(sec) {
    var i, max = 1, c = 100, h = '', a0, a1, r, p;
    for (i = 0; i < sec.length; i++) { max = Math.max(max, sec[i]); }
    function pt(a, rr) { return (c + rr * Math.sin(a)).toFixed(1) + ' ' + (c - rr * Math.cos(a)).toFixed(1); }
    for (i = 0; i < sec.length; i++) {
      if (!sec[i]) { continue; }
      r = 14 + 74 * sec[i] / max; a0 = (i * 10 + 1) * Math.PI / 180; a1 = (i * 10 + 9) * Math.PI / 180;
      h += '<path class="r" d="M' + pt(a0, 14) + 'L' + pt(a0, r) + 'L' + pt(a1, r) + 'L' + pt(a1, 14) + 'Z"/>';
    }
    return '<svg class="ss-chart" style="max-width:300px;margin:0 auto" viewBox="0 0 200 200" role="img" aria-label="Range by bearing">' +
      '<circle class="g" cx="100" cy="100" r="88" fill="none"/><circle class="g" cx="100" cy="100" r="51" fill="none"/>' + h +
      '<text class="n" x="100" y="9" text-anchor="middle">N</text><text class="n" x="196" y="104" text-anchor="end">E</text><text class="n" x="100" y="199" text-anchor="middle">S</text><text class="n" x="4" y="104">W</text>' +
      '<text x="103" y="' + (100 - 51 + 11) + '">' + Math.round(max / 2) + '</text><text x="103" y="22">' + Math.round(max) + ' nm</text></svg>';
  }
  function renderFar() {
    var S = Sky(), P = S.planes().filter(function (a) { return !a._net && a._d != null; }).sort(function (p, q) { return q._d - p._d; }), top5 = P.slice(0, 5), h;
    if (!document.getElementById('ss-far')) { body.innerHTML = '<div id="ss-far"></div><div id="ss-rose"></div>'; loadRose(); }
    if (!P.length) { h = '<div class="ss-note">No planes with a position from the antenna right now.</div>'; }
    else {
      h = kpis([[Math.round(P[0]._d) + '<small>nm</small>', 'Farthest (own receiver)'], [fmt(P.length), 'Planes in range']], '') + '<div class="ss-s">Tap to show on the map</div>' +
        top5.map(function (a) {
          return '<button class="ss-card" data-hex="' + a.hex + '"><b>' + esc(S.name(a)) + '</b><span>' + esc([a.t, a.r].filter(Boolean).join(' · ')) + ' · ' + a._d.toFixed(1) + ' nm</span></button>';
        }).join('');
    }
    $('ss-far').innerHTML = h;
  }
  function loadRose() {
    getJSON('api/range', function (d) {
      var el = $('ss-rose');
      if (!el || kind !== 'far' || !d || !d.sectors) { return; }       /* 404 on the public site: no bearing chart */
      el.innerHTML = '<div class="ss-s">Best range by bearing, last 24 h</div>' + rose(d.sectors) + '<div class="ss-note">Each wedge is a 10° sector; the rings are half and full range.</div>';
    });
  }

  /* ---------- Best 24 h ---------- */
  function renderBest() {
    body.innerHTML = '<div class="ss-note">Loading…</div>';
    getJSON('api/best', function (d) {
      var p, hrs, i, w = 358, h = 120, max = 1, bw, svg = '';
      if (kind !== 'best') { return; }
      if (!d || d.nm == null) {
        body.innerHTML = kpis([[($('s-24') || {}).textContent || '–', 'Best 24 h (receiver outline)']], '') +
          '<div class="ss-note">' + (d ? 'The plane behind this record is logged from now on; check back after a few minutes of traffic.' : 'Detail unavailable.') + '</div>';
        return;
      }
      p = d.plane || {}; hrs = d.hours || [];
      for (i = 0; i < hrs.length; i++) { max = Math.max(max, hrs[i][1]); }
      bw = (w - 8) / 24;
      for (i = 0; i < hrs.length; i++) {
        var slot = 23 - Math.floor((Date.now() / 1000 - hrs[i][0]) / 3600), bh = Math.max(2, (h - 28) * hrs[i][1] / max);
        if (slot < 0) { continue; }
        svg += '<rect class="r" x="' + (4 + slot * bw + 1).toFixed(1) + '" y="' + (h - 16 - bh).toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2"/>';
      }
      /* the public site leaves out the plane and time (they'd let anyone draw a range circle round the antenna) */
      body.innerHTML = (p.hex ? kpis([[d.nm.toFixed(1) + '<small>nm</small>', 'Best range'], [ago(d.ts), 'When']], '') + '<div class="ss-s">The plane</div>' +
        '<button class="ss-card" data-hex="' + esc(p.hex) + '"><b>' + esc(p.flight || p.reg || (p.hex || '').toUpperCase()) + '</b><span>' + esc([p.type, p.reg, when(d.ts)].filter(Boolean).join(' · ')) + '</span></button>'
        : kpis([[d.nm.toFixed(1) + '<small>nm</small>', 'Best range']], '')) +
        '<div class="ss-s">Best range by hour</div><svg class="ss-chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Best range per hour">' + svg +
        '<line class="g" x1="0" x2="' + w + '" y1="' + (h - 16) + '" y2="' + (h - 16) + '"/><text x="4" y="' + (h - 3) + '">24 h ago</text><text x="' + (w - 4) + '" y="' + (h - 3) + '" text-anchor="end">now</text>' +
        '<text x="' + (w - 4) + '" y="10" text-anchor="end">' + Math.round(max) + ' nm</text></svg>' +
        '<div class="ss-note">The header figure comes from the receiver\'s coverage outline; this is the farthest position the logger itself saw.</div>';
    });
  }

  /* ---------- Logged ---------- */
  var L = { q: '', op: '', type: '', sort: 'last', dir: 'desc', offset: 0, total: 0, busy: false, done: false, facets: null, gen: 0 };
  var SORTS = [['count', 'Times seen'], ['last', 'Last seen'], ['first', 'First seen']];
  function logRow(r) {
    var live = Sky().byHex(r.hex), id = r.reg || r.callsign || r.hex.toUpperCase();
    return '<button class="ss-r" data-hex="' + r.hex + '"><div class="m"><b>' + esc(id) + (live ? '<i class="ss-live" title="In the air now"></i>' : '') + '</b>' +
      '<span>' + esc([r.type || (r.desc ? String(r.desc) : ''), r.op].filter(Boolean).join(' · ') || 'Unknown') + '</span>' +
      '<span class="d">first ' + esc(when(r.first)) + ' · last ' + esc(ago(r.last)) + '</span></div>' +
      '<div class="n"><b>' + fmt(r.count) + '</b><span>seen</span></div></button>';
  }
  function chipsHTML() {
    var f = L.facets, h = '';
    if (!f) { return ''; }
    f.ops.forEach(function (o) { h += '<button class="ss-chip' + (L.op === o.name ? ' on' : '') + '" data-op="' + esc(o.name) + '">' + esc(o.name) + '<small>' + o.airframes + '</small></button>'; });
    f.types.forEach(function (t) { h += '<button class="ss-chip' + (L.type === t.code ? ' on' : '') + '" data-type="' + esc(t.code) + '" title="' + esc(t.name || '') + '">' + esc(t.code) + '<small>' + t.airframes + '</small></button>'; });
    return h;
  }
  function sortHTML() {
    return SORTS.map(function (s) { return '<button class="ss-chip' + (L.sort === s[0] ? ' on' : '') + '" data-sort="' + s[0] + '">' + s[1] + '</button>'; }).join('') +
      '<button class="ss-chip" data-dir="1" aria-label="Reverse order">' + (L.dir === 'desc' ? '↓ Desc' : '↑ Asc') + '</button>';
  }
  function buildLog() {
    body.innerHTML = '<div class="ss-lg"><div class="ss-fx"><input class="ss-q" type="search" placeholder="Search airline, type, reg, callsign" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search the log">' +
      '<div class="ss-sort"></div><div class="ss-chips"></div></div><div class="ss-ct"></div><div class="ss-rows"></div></div>';
    var q = body.querySelector('.ss-q'), t;
    q.value = L.q;
    q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { L.q = q.value.trim(); logReset(); }, 250); });
    paintLogHead();
    logReset();
  }
  function paintLogHead() {
    var s = body.querySelector('.ss-sort'), c = body.querySelector('.ss-chips');
    if (!s) { return; }
    s.innerHTML = sortHTML(); c.innerHTML = chipsHTML(); c.style.display = L.facets ? '' : 'none';
  }
  function logReset() { L.offset = 0; L.done = false; L.gen++; var r = body.querySelector('.ss-rows'); if (r) { r.innerHTML = ''; } body.scrollTop = 0; logMore(); }
  function logMore() {
    if (L.busy || L.done || kind !== 'log') { return; }
    var gen = L.gen, rows = body.querySelector('.ss-rows'), ct = body.querySelector('.ss-ct');
    if (!rows) { return; }
    L.busy = true;
    var url = 'api/log?limit=30&offset=' + L.offset + '&sort=' + L.sort + '&dir=' + L.dir + '&q=' + encodeURIComponent(L.q) + '&op=' + encodeURIComponent(L.op) +
      '&type=' + encodeURIComponent(L.type) + (L.facets ? '' : '&facets=1');
    getJSON(url, function (d) {
      L.busy = false;
      if (gen !== L.gen || kind !== 'log') { return; }
      var more = rows.querySelector('.ss-more');
      if (more) { more.remove(); }
      if (!d) { if (!L.offset) { rows.innerHTML = '<div class="ss-note">Log unavailable.</div>'; } return; }
      if (d.facets) { L.facets = d.facets; paintLogHead(); }
      L.total = d.total; L.offset += d.rows.length; L.done = L.offset >= d.total || !d.rows.length;
      rows.insertAdjacentHTML('beforeend', d.rows.map(logRow).join(''));
      ct.textContent = fmt(d.total) + (d.total === 1 ? ' airframe' : ' airframes') + (L.q || L.op || L.type ? ' match' : ' logged');
      if (!d.total) { rows.innerHTML = '<div class="ss-note">Nothing matches.</div>'; }
      else if (!L.done) { rows.insertAdjacentHTML('beforeend', '<button class="ss-more">Load more</button>'); }
      if (!L.done && body.scrollHeight <= body.clientHeight + 40) { logMore(); }
    });
  }

  /* ---------- open / close ---------- */
  function paint() {
    var y = body.scrollTop;
    if (kind === 'planes') { renderPlanes(); } else if (kind === 'far') { renderFar(); }
    body.scrollTop = y;
  }
  function open(k, from) {
    kind = k; opener = from || null;
    titleEl.textContent = TITLES[k];
    body.innerHTML = ''; body.scrollTop = 0;
    root.classList.add('on'); root.setAttribute('aria-hidden', 'false');
    if (k === 'planes') { renderPlanes(); } else if (k === 'rate') { renderRate(); } else if (k === 'far') { renderFar(); }
    else if (k === 'best') { renderBest(); } else if (k === 'log') { buildLog(); }
    clearInterval(timer);
    timer = setInterval(function () { if (kind === 'planes' || kind === 'far') { paint(); } }, 2000);
    panel.querySelector('.ss-x').focus({ preventScroll: true });
  }
  function close() {
    if (!kind) { return; }
    kind = null; clearInterval(timer); L.gen++; L.busy = false;
    root.classList.remove('on'); root.setAttribute('aria-hidden', 'true');
    if (opener && opener.focus) { try { opener.focus({ preventScroll: true }); } catch (e) {} }
  }

  function build() {
    root = document.createElement('div');
    root.className = 'ss'; root.setAttribute('aria-hidden', 'true');
    root.innerHTML = '<div class="ss-bd"></div><section class="ss-p" role="dialog" aria-modal="true" aria-labelledby="ss-t"><div class="ss-grab"><i></i></div>' +
      '<div class="ss-h"><b id="ss-t"></b><button class="ss-x" aria-label="Close">✕</button></div><div class="ss-b"></div><div class="ss-toast" role="status"></div></section>';
    document.body.appendChild(root);
    panel = root.querySelector('.ss-p'); body = root.querySelector('.ss-b'); titleEl = $('ss-t');

    root.querySelector('.ss-bd').addEventListener('click', close);
    root.addEventListener('click', function (e) { if (e.target === root) { close(); } });
    root.querySelector('.ss-x').addEventListener('click', close);
    addEventListener('keydown', function (e) { if (e.key === 'Escape' && kind) { e.preventDefault(); close(); } });

    /* swipe down on the handle / title to close */
    (function () {
      var y0 = null, dy = 0;
      function pt(e) { return e.touches ? e.touches[0] : e; }
      function down(e) { y0 = pt(e).clientY; dy = 0; panel.classList.add('drag'); }
      function move(e) { if (y0 == null) { return; } dy = Math.max(0, pt(e).clientY - y0); panel.style.transform = 'translateY(' + dy + 'px)'; }
      function up() { if (y0 == null) { return; } panel.classList.remove('drag'); panel.style.transform = ''; y0 = null; if (dy > 70) { close(); } }
      [panel.querySelector('.ss-grab'), panel.querySelector('.ss-h')].forEach(function (el) {
        el.addEventListener('touchstart', down, { passive: true }); el.addEventListener('mousedown', down);
      });
      addEventListener('touchmove', move, { passive: true }); addEventListener('mousemove', move);
      addEventListener('touchend', up); addEventListener('mouseup', up); addEventListener('touchcancel', up);
    })();

    /* clicks inside the sheet */
    body.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null, hx;
      if (!t) { return; }
      if (t.hasAttribute('data-h')) { rateH = +t.getAttribute('data-h'); renderRate(); return; }
      if (t.classList.contains('ss-more')) { logMore(); return; }
      if (t.hasAttribute('data-sort')) { L.sort = t.getAttribute('data-sort'); L.dir = 'desc'; if (L.sort === 'first') { L.dir = 'asc'; } paintLogHead(); logReset(); return; }
      if (t.hasAttribute('data-dir')) { L.dir = L.dir === 'desc' ? 'asc' : 'desc'; paintLogHead(); logReset(); return; }
      if (t.hasAttribute('data-op')) { L.op = L.op === t.getAttribute('data-op') ? '' : t.getAttribute('data-op'); paintLogHead(); logReset(); return; }
      if (t.hasAttribute('data-type')) { L.type = L.type === t.getAttribute('data-type') ? '' : t.getAttribute('data-type'); paintLogHead(); logReset(); return; }
      hx = t.getAttribute('data-hex');
      if (hx) { show(hx); }
    });
    body.addEventListener('scroll', function () {
      if (kind === 'log' && body.scrollTop + body.clientHeight > body.scrollHeight - 300) { logMore(); }
    }, { passive: true });
  }

  function chipKind(el) {
    var st = el && el.closest ? el.closest('.st') : null, id;
    if (!st) { return null; }
    for (id in KINDS) { if (st.querySelector('#' + id)) { return { k: KINDS[id], el: st }; } }
    return null;
  }
  function init() {
    var id, b;
    build();
    for (id in KINDS) {                                 /* make the chips behave as buttons */
      b = $(id) && $(id).closest('.st');
      if (b) { b.setAttribute('role', 'button'); b.setAttribute('tabindex', '0'); b.setAttribute('aria-haspopup', 'dialog'); }
    }
    document.addEventListener('click', function (e) { var c = chipKind(e.target); if (c) { open(c.k, c.el); } });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && !kind) { var c = chipKind(e.target); if (c && e.target === c.el) { e.preventDefault(); open(c.k, c.el); } }
    });
    window.SkyStats = { open: open, close: close };
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
