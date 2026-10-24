"""Sky API: sightings log + aircraft lookups for the Sky over Renton page.

Runs in the "sky-api" container (python:3.12-alpine, stdlib only) next to the
ultrafeeder receiver. nginx (sky-web) proxies /api/ here.

  recorder   every 15 s reads the receiver's aircraft.json and logs each airframe
             once per local day in SQLite (/state/sky.db): first seen, days seen,
             the day before today it was here, callsigns used.
  GET /api/ac/<hex>?cs=ASA631&lat=..&lon=..
             {aircraft, route, airline, history}
             aircraft  adsbdb.com registration/type/owner/photo (cached 14 days)
             route     adsbdb.com callsign route (cached 6 h), "trusted" only when
                       the plane is within ROUTE_SLACK_NM of the origin-destination
                       great circle (flight numbers fly several legs a day)
             airline   from the route, else the registered operator
             history   this airframe in our log
  GET /api/stats   airframes logged, seen today, log start
  GET /api/log?q=&type=&op=&sort=count|last|first&dir=asc|desc&offset=&limit=&facets=1
                   the airframe log, paged: reg, type, operator, times seen (visits: a new
                   one after 30 min away), first/last seen. q matches reg/callsign/type/operator/hex.
                   facets=1 adds the top operators and types for filter chips.
  GET /api/best    best range in the last 24 h (distance, plane, hourly bests; no positions)
  GET /api/rate?h= message rate samples (one a minute), for the Messages sparkline
  GET /api/range   best range per 10 degree bearing, last 24 h. PRIVATE ONLY (nginx does not
                   proxy it on the public site: it describes the receiver's surroundings)
  GET /api/pub/aircraft.json, /api/pub/receiver.json
                   the public site's copies (nginx maps /data/ to these there): aircraft
                   without r_dst/r_dir (each plane's distance and bearing from the
                   receiver, which would pin down where it is) and a coarse location.
  GET /api/v1/now?lat=&lon=&radius_nm=&max_alt_ft=&limit=
                   the public API (CORS open): aircraft around a point (default KRNT,
                   10 nm), our receiver and the network merged, nearest first, airline
                   and route from the lookup cache only (callers never trigger lookups),
                   per-airport ground/pattern counts, and sky.spenc.ee links.
  GET /api/fill    aircraft the community networks hear within FILL_NM of the receiver
                   (adsb.fi, then adsb.lol, airplanes.live), fetched at most every
                   FILL_S however many phones ask. Fills what our antenna can't hear:
                   planes parked or taxiing at SEA/BFI behind the terrain, and beyond
                   our range. Read only; nothing of ours is sent to them.

Lookups go out only when someone taps a plane, never per poll.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

RECEIVER = os.environ.get("SKY_RECEIVER", "http://ultrafeeder/data/aircraft.json")
DB_PATH = os.environ.get("SKY_DB", "/state/sky.db")
UA = "sky-over-renton/1.0 (personal ADS-B receiver page)"
ADSBDB = "https://api.adsbdb.com/v0"
POLL_S = 15
ROUTE_TTL, ROUTE_MISS_TTL = 6 * 3600, 3600
AC_TTL, AC_MISS_TTL = 14 * 86400, 86400
ROUTE_SLACK_NM = 120
FILL_NM, FILL_S = 60, 10
PUB_HOME = {"lat": float(os.environ.get("SKY_PUBLIC_LAT", "47.48")), "lon": float(os.environ.get("SKY_PUBLIC_LON", "-122.21"))}
PRIVATE_KEYS = ("r_dst", "r_dir")
_pub = {"ts": 0.0, "body": b""}
_pub_lock = threading.Lock()
FILL_FEEDS = ("https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}",
              "https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}",
              "https://api.airplanes.live/v2/point/{lat}/{lon}/{nm}")
HEX_RE = re.compile(r"^~?[0-9a-f]{6}$")
CS_RE = re.compile(r"^[A-Z0-9]{2,8}$")

_db_lock = threading.Lock()
_db = sqlite3.connect(DB_PATH, check_same_thread=False)
_db.executescript("""
CREATE TABLE IF NOT EXISTS seen (hex TEXT PRIMARY KEY, first_ts REAL, last_ts REAL, days INTEGER,
  last_day TEXT, prev_day TEXT, callsigns TEXT);
CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, ts REAL, v TEXT);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
""")
_db.executescript("""
CREATE TABLE IF NOT EXISTS rng (hour INTEGER, sec INTEGER, nm REAL, hex TEXT, cs TEXT, reg TEXT, typ TEXT, ts REAL,
  PRIMARY KEY (hour, sec));
CREATE TABLE IF NOT EXISTS rate (ts INTEGER PRIMARY KEY, mps REAL);
""")
# compatible migration: the log gains registration, type, operator and a visit count
_have = {r[1] for r in _db.execute("PRAGMA table_info(seen)")}
for _col, _ty in (("reg", "TEXT"), ("typ", "TEXT"), ("tdesc", "TEXT"), ("op", "TEXT"), ("cnt", "INTEGER")):
    if _col not in _have:
        _db.execute(f"ALTER TABLE seen ADD COLUMN {_col} {_ty}")
_db.execute("UPDATE seen SET cnt=COALESCE(days,1) WHERE cnt IS NULL")   # older rows: one visit a day seen
_db.execute("CREATE INDEX IF NOT EXISTS seen_last ON seen(last_ts)")
if not _db.execute("SELECT v FROM meta WHERE k='start'").fetchone():
    _db.execute("INSERT INTO meta VALUES ('start', ?)", (date.today().isoformat(),))
_db.commit()


def _get_json(url: str, timeout: float = 6.0):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(2_000_000))


def _nm(a, b) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 3440.065 * 2 * math.asin(math.sqrt(min(1.0, h)))


def _brg(a, b) -> float:
    p1, p2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    return math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))


def _xtrack_nm(p, a, b) -> float:
    """Distance of p from the great circle a->b; past either end, from that end (scored double:
    a plane 100 nm beyond its listed destination is not flying that route)."""
    d13 = _nm(a, p) / 3440.065
    t13, t12 = _brg(a, p), _brg(a, b)
    xt = abs(math.asin(max(-1.0, min(1.0, math.sin(d13) * math.sin(t13 - t12))))) * 3440.065
    along = math.acos(max(-1.0, min(1.0, math.cos(d13) / max(1e-9, math.cos(xt / 3440.065))))) * 3440.065
    if math.cos(t13 - t12) < 0:
        return 2 * _nm(a, p)
    if along > _nm(a, b):
        return 2 * _nm(b, p)
    return xt


# ---------------------------------------------------------------- cache ----

def _cached(key: str, ttl_hit: float, ttl_miss: float, fetch):
    with _db_lock:
        row = _db.execute("SELECT ts, v FROM cache WHERE k=?", (key,)).fetchone()
    if row:
        v = json.loads(row[1])
        if time.time() - row[0] < (ttl_hit if v is not None else ttl_miss):
            return v
    try:
        v = fetch()
    except urllib.error.HTTPError as exc:
        if exc.code not in (400, 404):
            return json.loads(row[1]) if row else None
        v = None
    except Exception:  # noqa: BLE001 - upstream down: serve what we had
        return json.loads(row[1]) if row else None
    with _db_lock:
        _db.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?)", (key, time.time(), json.dumps(v)))
        _db.commit()
    return v


def aircraft(hx: str):
    def f():
        a = _get_json(f"{ADSBDB}/aircraft/{hx.lstrip('~')}")["response"]["aircraft"]
        return {"type": a.get("type"), "icao_type": a.get("icao_type"), "maker": a.get("manufacturer"),
                "reg": a.get("registration"), "owner": a.get("registered_owner"),
                "owner_country": a.get("registered_owner_country_name"),
                "owner_flag": a.get("registered_owner_operator_flag_code"),
                "photo": a.get("url_photo_thumbnail"), "photo_large": a.get("url_photo")}
    return _cached("ac:" + hx, AC_TTL, AC_MISS_TTL, f)


def route(cs: str):
    def f():
        r = _get_json(f"{ADSBDB}/callsign/{cs}")["response"]["flightroute"]
        ap = lambda x: {"iata": x.get("iata_code") or x.get("icao_code"), "icao": x.get("icao_code"),  # noqa: E731
                        "city": x.get("municipality"), "name": x.get("name"),
                        "lat": x.get("latitude"), "lon": x.get("longitude")}
        al = r.get("airline") or {}
        return {"from": ap(r.get("origin") or {}), "to": ap(r.get("destination") or {}),
                "flight": r.get("callsign_iata"),
                "airline": {"name": al.get("name"), "iata": al.get("iata"), "icao": al.get("icao"),
                            "country": al.get("country")} if al.get("name") else None}
    return _cached("rt:" + cs, ROUTE_TTL, ROUTE_MISS_TTL, f)


def history(hx: str) -> dict:
    with _db_lock:
        row = _db.execute("SELECT first_ts, last_ts, days, prev_day, callsigns FROM seen WHERE hex=?", (hx,)).fetchone()
        start = _db.execute("SELECT v FROM meta WHERE k='start'").fetchone()[0]
    if not row:
        return {"days": 0, "since": start}
    first_ts, last_ts, days, prev_day, cs = row
    return {"days": days, "first": datetime.fromtimestamp(first_ts).date().isoformat(), "prev_day": prev_day,
            "callsigns": [c for c in (cs or "").split(",") if c][-6:], "since": start}


def lookup(hx: str, cs: str, lat, lon) -> dict:
    box: dict = {}
    want_rt = bool(cs and re.match(r"^[A-Z]{3}\d", cs))   # airline flights only; tail-number callsigns have no route
    th = threading.Thread(target=lambda: box.update(rt=route(cs)), daemon=True) if want_rt else None
    if th:
        th.start()                                     # both adsbdb lookups at once
    out = {"hex": hx, "aircraft": aircraft(hx), "route": None, "airline": None, "history": history(hx)}
    if th:
        th.join(8)
        rt = box.get("rt")
        if rt and rt["from"].get("lat") is not None and rt["to"].get("lat") is not None:
            rt = dict(rt)
            if lat is not None and lon is not None:
                rt["trusted"] = _xtrack_nm((lat, lon), (rt["from"]["lat"], rt["from"]["lon"]),
                                           (rt["to"]["lat"], rt["to"]["lon"])) < ROUTE_SLACK_NM
            out["route"] = rt
            out["airline"] = rt.get("airline")
    ac = out["aircraft"] or {}
    if not out["airline"] and ac.get("owner"):
        out["airline"] = {"name": ac["owner"], "icao": ac.get("owner_flag"), "iata": None}
    return out


# ----------------------------------------------------------------- fill ----

_fill = {"ts": 0.0, "body": None, "home": None}
_fill_lock = threading.Lock()


def _home():
    if not _fill["home"]:
        r = _get_json(RECEIVER.replace("aircraft.json", "receiver.json"), 4)
        _fill["home"] = (round(r["lat"], 3), round(r["lon"], 3))
    return _fill["home"]


def fill() -> bytes:
    """Network aircraft near home as readsb-style JSON (bytes, cached FILL_S)."""
    with _fill_lock:                                   # one upstream request at a time
        if _fill["body"] and time.time() - _fill["ts"] < FILL_S:
            return _fill["body"]
        try:
            lat, lon = _home()
        except Exception:  # noqa: BLE001
            return _fill["body"] or b'{"aircraft":[]}'
        for url in FILL_FEEDS:
            try:
                d = _get_json(url.format(lat=lat, lon=lon, nm=FILL_NM), 5)
            except Exception:  # noqa: BLE001 - rate limited or down: next one
                continue
            ac = d.get("aircraft") or d.get("ac")
            if ac is None:
                continue
            now = d.get("now", time.time() * 1000)
            now = now / 1000 if now > 1e11 else now
            keep = ("hex", "flight", "r", "t", "desc", "category", "alt_baro", "alt_geom", "gs", "track", "true_heading",
                    "baro_rate", "geom_rate", "squawk", "lat", "lon", "seen_pos", "seen")
            out = [{k: a[k] for k in keep if k in a} for a in ac if a.get("lat") is not None]
            _fill.update(ts=time.time(), body=json.dumps({"now": now, "src": url.split("/")[2], "aircraft": out}).encode())
            break
        return _fill["body"] or b'{"aircraft":[]}'


SITE = "https://sky.spenc.ee"
AIRPORTS = {"RNT": (47.4931, -122.2159), "BFI": (47.5300, -122.3020), "SEA": (47.4490, -122.3093)}
_now = {"ts": 0.0, "ac": []}
_now_lock = threading.Lock()


def _cache_get(key: str):
    with _db_lock:
        row = _db.execute("SELECT v FROM cache WHERE k=?", (key,)).fetchone()
    return json.loads(row[0]) if row else None


def _merged() -> list:
    """Receiver + network aircraft with a position (shared, cached 4 s)."""
    with _now_lock:
        if time.time() - _now["ts"] < 4:
            return _now["ac"]
        out, seen = [], set()
        try:
            for a in _get_json(RECEIVER, 4).get("aircraft") or []:
                if a.get("lat") is not None and a.get("seen_pos", 99) <= 60:
                    out.append(dict(a, _src="receiver")); seen.add(a["hex"])
        except Exception:  # noqa: BLE001
            pass
        try:
            for a in json.loads(fill()).get("aircraft") or []:
                if a.get("hex") not in seen and a.get("seen_pos", 0) <= 60:
                    out.append(dict(a, _src="network"))
        except Exception:  # noqa: BLE001
            pass
        _now.update(ts=time.time(), ac=out)
        return out


def now_api(q: dict) -> dict:
    def num(k, d, lo, hi):
        try:
            return max(lo, min(hi, float(q[k][0])))
        except (KeyError, ValueError, IndexError):
            return d
    lat, lon = num("lat", AIRPORTS["RNT"][0], -90, 90), num("lon", AIRPORTS["RNT"][1], -180, 180)
    radius, max_alt, limit = num("radius_nm", 10, .5, 60), num("max_alt_ft", 60000, 0, 60000), int(num("limit", 25, 1, 100))
    rows, flying, ground, mine = [], 0, 0, 0
    apt = {k: {"ground": 0, "low_nearby": 0} for k in AIRPORTS}
    for a in _merged():
        p = (a["lat"], a["lon"])
        on_ground = a.get("alt_baro") == "ground"
        alt = 0 if on_ground else (a.get("alt_baro") if isinstance(a.get("alt_baro"), (int, float)) else a.get("alt_geom"))
        for k, c in AIRPORTS.items():
            dk = _nm(c, p)
            if on_ground and dk < 1.5:
                apt[k]["ground"] += 1
            elif not on_ground and dk < 5 and alt is not None and alt < 3000:
                apt[k]["low_nearby"] += 1
        d = _nm((lat, lon), p)
        if d > radius or (alt or 0) > max_alt:
            continue
        flying += not on_ground; ground += on_ground; mine += a["_src"] == "receiver"
        cs = str(a.get("flight") or "").strip()
        ac = _cache_get("ac:" + a["hex"]) or {}
        rt = _cache_get("rt:" + cs) if cs else None
        route = None
        if rt and rt["from"].get("lat") is not None and rt["to"].get("lat") is not None and \
                _xtrack_nm(p, (rt["from"]["lat"], rt["from"]["lon"]), (rt["to"]["lat"], rt["to"]["lon"])) < ROUTE_SLACK_NM:
            route = {"from": rt["from"]["iata"], "to": rt["to"]["iata"], "from_city": rt["from"].get("city"), "to_city": rt["to"].get("city")}
        airline = (rt or {}).get("airline", {}) or {}
        rows.append({
            "hex": a["hex"], "flight": cs or None, "reg": a.get("r") or ac.get("reg"), "type": a.get("t"), "desc": a.get("desc"),
            "airline": airline.get("name") or a.get("ownOp") or ac.get("owner"),
            "on_ground": on_ground, "alt_ft": None if on_ground else alt, "gs_kt": a.get("gs"), "track": a.get("track"),
            "vrate_fpm": a.get("baro_rate", a.get("geom_rate")), "squawk": a.get("squawk"),
            "lat": round(a["lat"], 4), "lon": round(a["lon"], 4), "dist_nm": round(d, 1),
            "bearing": round(math.degrees(_brg((lat, lon), p)) % 360), "route": route,
            "photo": ac.get("photo"), "source": a["_src"], "url": f"{SITE}/#{a['hex']}"})
    rows.sort(key=lambda r: r["dist_nm"])
    return {"generated": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
            "center": {"lat": lat, "lon": lon, "radius_nm": radius},
            "counts": {"total": flying + ground, "flying": flying, "on_ground": ground, "own_receiver": mine, "network": flying + ground - mine},
            "airports": apt, "aircraft": rows[:limit],
            "link": f"{SITE}/?at={lat:.4f},{lon:.4f},12", "site": SITE,
            "attribution": "Sky over Renton (own ADS-B receiver) + adsb.fi/adsb.lol/airplanes.live; routes adsbdb.com"}


def pub_aircraft() -> bytes:
    """The receiver's aircraft.json minus anything relative to the receiver (shared, cached 0.8 s)."""
    with _pub_lock:
        if _pub["body"] and time.time() - _pub["ts"] < .8:
            return _pub["body"]
        d = _get_json(RECEIVER, 4)
        for a in d.get("aircraft") or []:
            for k in PRIVATE_KEYS:
                a.pop(k, None)
        _pub.update(ts=time.time(), body=json.dumps(d, separators=(",", ":")).encode())
        return _pub["body"]


# ------------------------------------------------------------- recorder ----

VISIT_GAP_S = 1800


def backfill() -> None:
    """Fill reg/type/operator on log rows from the lookup cache (adsbdb results kept by taps and
    the app's prefetch). Operator: the callsign's route airline, else the registered owner."""
    with _db_lock:
        rows = _db.execute("SELECT hex, callsigns, reg, typ, tdesc, op FROM seen WHERE op IS NULL OR reg IS NULL OR typ IS NULL").fetchall()
        cache = {k: v for k, v in _db.execute("SELECT k, v FROM cache WHERE k LIKE 'ac:%' OR k LIKE 'rt:%'")}
    ups = []
    for hx, css, reg, typ, tdesc, op in rows:
        try:
            ac = json.loads(cache.get("ac:" + hx) or "null") or {}
        except ValueError:
            ac = {}
        cs = [c for c in (css or "").split(",") if c]
        rt_op = None
        for c in reversed(cs):
            if re.match(r"^[A-Z]{3}\d", c):
                try:
                    rt = json.loads(cache.get("rt:" + c) or "null") or {}
                except ValueError:
                    rt = {}
                rt_op = ((rt.get("airline") or {}).get("name"))
                if rt_op:
                    break
        n_reg, n_typ = reg or ac.get("reg"), typ or ac.get("icao_type")
        n_desc, n_op = tdesc or ac.get("type"), op or rt_op or ac.get("owner")
        if (n_reg, n_typ, n_desc, n_op) != (reg, typ, tdesc, op):
            ups.append((n_reg, n_typ, n_desc, n_op, hx))
    if ups:
        with _db_lock:
            _db.executemany("UPDATE seen SET reg=?, typ=?, tdesc=?, op=? WHERE hex=?", ups)
            _db.commit()


def record_loop() -> None:
    done, today = set(), ""
    rate_prev, last_fill = None, 0.0
    while True:
        try:
            d = _get_json(RECEIVER, 5)
            day = time.strftime("%Y-%m-%d", time.localtime())
            if day != today:
                done, today = set(), day
            now = time.time()
            with _db_lock:
                for a in d.get("aircraft") or []:
                    hx, cs = str(a.get("hex") or "").lower(), str(a.get("flight") or "").strip()
                    if not hx or a.get("seen", 99) > 60:
                        continue
                    reg, typ, tdesc, op = a.get("r"), a.get("t"), a.get("desc"), a.get("ownOp")
                    row = _db.execute("SELECT last_day, days, callsigns, last_ts, cnt FROM seen WHERE hex=?", (hx,)).fetchone()
                    if row is None:
                        _db.execute("INSERT INTO seen (hex, first_ts, last_ts, days, last_day, prev_day, callsigns, reg, typ, tdesc, op, cnt)"
                                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,1)", (hx, now, now, 1, today, None, cs, reg, typ, tdesc, op))
                        done.add(hx + "|" + cs)
                    else:
                        last_day, days, css, last_ts, cnt = row
                        lst = [c for c in (css or "").split(",") if c]
                        if cs and cs not in lst:
                            lst = (lst + [cs])[-12:]
                        cnt = (cnt or days or 1) + (1 if now - (last_ts or 0) > VISIT_GAP_S else 0)
                        if last_day != today:
                            _db.execute("UPDATE seen SET prev_day=last_day, last_day=?, days=?, last_ts=?, callsigns=?, cnt=? WHERE hex=?",
                                        (today, (days or 0) + 1, now, ",".join(lst), cnt, hx))
                        else:
                            _db.execute("UPDATE seen SET last_ts=?, callsigns=?, cnt=? WHERE hex=?", (now, ",".join(lst), cnt, hx))
                        _db.execute("UPDATE seen SET reg=COALESCE(reg,?), typ=COALESCE(typ,?), tdesc=COALESCE(tdesc,?), op=COALESCE(op,?) WHERE hex=?",
                                    (reg, typ, tdesc, op, hx))
                        done.add(hx + "|" + cs)
                    # farthest this hour, per 10 degree sector (best 24 h, range by bearing)
                    dst, brg = a.get("r_dst"), a.get("r_dir")
                    if isinstance(dst, (int, float)) and isinstance(brg, (int, float)) and 0 < dst < 400 \
                            and a.get("lat") is not None and a.get("seen_pos", 99) <= 30:
                        _db.execute("INSERT INTO rng VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(hour, sec) DO UPDATE SET nm=excluded.nm, hex=excluded.hex,"
                                    " cs=excluded.cs, reg=excluded.reg, typ=excluded.typ, ts=excluded.ts WHERE excluded.nm>rng.nm",
                                    (int(now // 3600), int(brg // 10) % 36, round(dst, 1), hx, cs, reg, typ, now))
                # message rate, one sample a minute
                msgs = d.get("messages")
                if isinstance(msgs, (int, float)):
                    if rate_prev is None:
                        rate_prev = (now, msgs)
                    elif now - rate_prev[0] >= 60:
                        if msgs >= rate_prev[1]:
                            _db.execute("INSERT OR REPLACE INTO rate VALUES (?,?)", (int(now), round((msgs - rate_prev[1]) / (now - rate_prev[0]), 1)))
                        rate_prev = (now, msgs)
                        _db.execute("DELETE FROM rate WHERE ts<?", (now - 48 * 3600,))
                        _db.execute("DELETE FROM rng WHERE hour<?", (int(now // 3600) - 48,))
                _db.commit()
            if now - last_fill > 120:
                last_fill = now
                backfill()
        except Exception:  # noqa: BLE001 - receiver restarting; try again
            pass
        time.sleep(POLL_S)


# ------------------------------------------------------------ log / best ----

_SORTS = {"count": "COALESCE(cnt, days, 1)", "last": "last_ts", "first": "first_ts"}


def _like(tok: str) -> str:
    return "%" + tok.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def log_api(q: dict) -> dict:
    def s(k):
        return (q.get(k) or [""])[0].strip()

    def num(k, d, lo, hi):
        try:
            return max(lo, min(hi, int(s(k))))
        except ValueError:
            return d
    where, args = [], []
    for tok in s("q").lower()[:60].split()[:4]:
        lk = _like(tok)
        where.append("(lower(COALESCE(reg,'')) LIKE ?1 ESCAPE '\\' OR lower(COALESCE(callsigns,'')) LIKE ?1 ESCAPE '\\'"
                     " OR lower(COALESCE(typ,'')) LIKE ?1 ESCAPE '\\' OR lower(COALESCE(tdesc,'')) LIKE ?1 ESCAPE '\\'"
                     " OR lower(COALESCE(op,'')) LIKE ?1 ESCAPE '\\' OR hex LIKE ?1 ESCAPE '\\')".replace("?1", "?"))
        args += [lk] * 6
    if s("type"):
        where.append("typ = ? COLLATE NOCASE")
        args.append(s("type")[:20])
    if s("op"):
        where.append("op = ?")
        args.append(s("op")[:80])
    w = (" WHERE " + " AND ".join(where)) if where else ""
    key = _SORTS.get(s("sort"), _SORTS["last"])
    dr = "ASC" if s("dir").lower() == "asc" else "DESC"
    limit, offset = num("limit", 30, 1, 100), num("offset", 0, 0, 10_000_000)
    with _db_lock:
        total = _db.execute("SELECT COUNT(*) FROM seen" + w, args).fetchone()[0]
        rows = _db.execute("SELECT hex, reg, typ, tdesc, op, COALESCE(cnt, days, 1), days, first_ts, last_ts, callsigns FROM seen" + w +
                           f" ORDER BY {key} {dr}, last_ts DESC, hex LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        out = {"total": total, "offset": offset, "limit": limit,
               "rows": [{"hex": r[0], "reg": r[1], "type": r[2], "desc": r[3], "op": r[4], "count": r[5], "days": r[6],
                         "first": r[7], "last": r[8], "callsign": ([c for c in (r[9] or "").split(",") if c] or [None])[-1]} for r in rows]}
        if s("facets") == "1":
            out["facets"] = {
                "ops": [{"name": r[0], "airframes": r[1], "count": r[2]} for r in _db.execute(
                    "SELECT op, COUNT(*), SUM(COALESCE(cnt, days, 1)) FROM seen WHERE op IS NOT NULL AND op<>'' GROUP BY op ORDER BY 2 DESC, 3 DESC LIMIT 14")],
                "types": [{"code": r[0], "name": r[1], "airframes": r[2], "count": r[3]} for r in _db.execute(
                    "SELECT typ, MAX(tdesc), COUNT(*), SUM(COALESCE(cnt, days, 1)) FROM seen WHERE typ IS NOT NULL AND typ<>'' GROUP BY typ ORDER BY 3 DESC, 4 DESC LIMIT 14")],
                "airframes": _db.execute("SELECT COUNT(*) FROM seen").fetchone()[0]}
    return out


def best_api() -> dict:
    hr = int(time.time() // 3600)
    with _db_lock:
        top = _db.execute("SELECT nm, hex, cs, reg, typ, ts FROM rng WHERE hour>? ORDER BY nm DESC LIMIT 1", (hr - 24,)).fetchone()
        hours = _db.execute("SELECT hour, MAX(nm) FROM rng WHERE hour>? GROUP BY hour ORDER BY hour", (hr - 24,)).fetchall()
    out = {"nm": None, "hours": [[h * 3600, n] for h, n in hours]}
    if top:
        out.update(nm=top[0], plane={"hex": top[1], "flight": top[2] or None, "reg": top[3], "type": top[4]}, ts=top[5])
    return out


def range_api() -> dict:
    hr = int(time.time() // 3600)
    with _db_lock:
        rows = _db.execute("SELECT sec, MAX(nm) FROM rng WHERE hour>? GROUP BY sec", (hr - 24,)).fetchall()
    sec = [0.0] * 36
    for k, n in rows:
        sec[k] = n
    return {"sectors": sec, "step": 10}


def rate_api(q: dict) -> dict:
    try:
        h = max(1, min(48, int((q.get("h") or ["6"])[0])))
    except ValueError:
        h = 6
    with _db_lock:
        pts = _db.execute("SELECT ts, mps FROM rate WHERE ts>? ORDER BY ts", (time.time() - h * 3600,)).fetchall()
    step = max(1, -(-len(pts) // 120))
    if step > 1:                                       # average into <= ~120 points
        pts = [(g[0][0], round(sum(p[1] for p in g) / len(g), 1)) for g in (pts[i:i + step] for i in range(0, len(pts), step))]
    return {"hours": h, "pts": pts}


# ----------------------------------------------------------------- http ----

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, code: int, obj, cache: str = "no-cache") -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path.startswith("/api/ac/"):
            hx = u.path[len("/api/ac/"):].lower()
            cs = (q.get("cs") or [""])[0].upper().strip()
            if not HEX_RE.match(hx) or (cs and not CS_RE.match(cs)):
                return self._json(400, {"error": "bad request"})
            try:
                lat = float(q["lat"][0]); lon = float(q["lon"][0])  # noqa: E702
            except (KeyError, ValueError):
                lat = lon = None
            return self._json(200, lookup(hx, cs, lat, lon), "max-age=60")
        if u.path == "/api/v1/now":
            body = json.dumps(now_api(q), separators=(",", ":")).encode()
            self.send_response(200)
            for k, v in (("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                         ("Cache-Control", "public, max-age=5"), ("Access-Control-Allow-Origin", "*")):
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
            return None
        if u.path == "/api/pub/receiver.json":
            return self._json(200, PUB_HOME, "max-age=3600")
        if u.path == "/api/fill" or u.path == "/api/pub/aircraft.json":
            try:
                body = fill() if u.path == "/api/fill" else pub_aircraft()
            except Exception:  # noqa: BLE001 - receiver restarting
                return self._json(502, {"error": "receiver unavailable"})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return None
        if u.path == "/api/log":
            return self._json(200, log_api(q))
        if u.path == "/api/best":
            return self._json(200, best_api())
        if u.path == "/api/pub/best":   # public: no plane or time; a plane + time + range would draw a circle round home
            b = best_api()
            return self._json(200, {"nm": b["nm"], "hours": b["hours"]})
        if u.path == "/api/range":
            return self._json(200, range_api())
        if u.path == "/api/rate":
            return self._json(200, rate_api(q))
        if u.path == "/api/stats":
            with _db_lock:
                n = _db.execute("SELECT COUNT(*) FROM seen").fetchone()[0]
                t = _db.execute("SELECT COUNT(*) FROM seen WHERE last_day=?", (time.strftime("%Y-%m-%d"),)).fetchone()[0]
                start = _db.execute("SELECT v FROM meta WHERE k='start'").fetchone()[0]
            return self._json(200, {"airframes": n, "today": t, "since": start})
        return self._json(404, {"error": "not found"})


if __name__ == "__main__":
    threading.Thread(target=record_loop, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
