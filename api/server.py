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
  GET /api/pub/aircraft.json, /api/pub/receiver.json
                   the public site's copies (nginx maps /data/ to these there): aircraft
                   without r_dst/r_dir (each plane's distance and bearing from the
                   receiver, which would pin down where it is) and a coarse location.
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

def record_loop() -> None:
    done, today = set(), ""
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
                    key = hx + "|" + cs
                    if key in done:
                        continue
                    done.add(key)
                    row = _db.execute("SELECT last_day, days, callsigns FROM seen WHERE hex=?", (hx,)).fetchone()
                    if row is None:
                        _db.execute("INSERT INTO seen VALUES (?,?,?,?,?,?,?)", (hx, now, now, 1, today, None, cs))
                        continue
                    last_day, days, css = row
                    lst = [c for c in (css or "").split(",") if c]
                    if cs and cs not in lst:
                        lst = (lst + [cs])[-12:]
                    if last_day != today:
                        _db.execute("UPDATE seen SET prev_day=last_day, last_day=?, days=?, last_ts=?, callsigns=? WHERE hex=?",
                                    (today, (days or 0) + 1, now, ",".join(lst), hx))
                    else:
                        _db.execute("UPDATE seen SET last_ts=?, callsigns=? WHERE hex=?", (now, ",".join(lst), hx))
                _db.commit()
        except Exception:  # noqa: BLE001 - receiver restarting; try again
            pass
        time.sleep(POLL_S)


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
