"""Build web/airports.json: SEA, BFI and RNT drawn from OpenStreetMap.

Fetches (Overpass) every runway, taxiway, apron and building inside the three
aerodromes and writes a compact file the app draws as a 3-D-ish airport layer:
  area     aerodrome outlines              [[ring]]
  apron    aprons                          [[ring]]
  taxi     taxiway/taxilane centre lines   [[line]]
  rwy      runways                         [{ref, a, b, w}]   ends [lat, lon], width m
  bld      buildings                       [{r: ring, h: height m, t: 1 if terminal}]
Coordinates are rounded to 5 decimals (~1 m) and thinned within ~1.5 m.

  python3 tools/build_airports.py            (stdlib only; ~10 s)
OSM data (c) OpenStreetMap contributors, ODbL.
"""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "airports.json"
ICAO = ("KSEA", "KBFI", "KRNT")
QUERY = f"""[out:json][timeout:90];
(way["aeroway"="aerodrome"]["icao"~"^({'|'.join(ICAO)})$"];relation["aeroway"="aerodrome"]["icao"~"^({'|'.join(ICAO)})$"];)->.ad;
.ad map_to_area->.a;
(way(area.a)["aeroway"~"^(runway|taxiway|apron|terminal|hangar|taxilane)$"];way(area.a)["building"];
 relation(area.a)["building"];relation(area.a)["aeroway"="apron"];);
out geom tags;
.ad out geom tags;"""
TOL = 1.5e-5            # degrees, ~1.5 m


def thin(pts):
    """Douglas-Peucker on [lat, lon] pairs."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    dx, dy = b[1] - a[1], b[0] - a[0]
    n = math.hypot(dx, dy) or 1e-12
    far, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        p = pts[i]
        d = abs(dx * (a[0] - p[0]) - (a[1] - p[1]) * dy) / n if n > 1e-12 else math.hypot(p[0] - a[0], p[1] - a[1])
        if d > far:
            far, idx = d, i
    if far <= TOL:
        return [a, b]
    return thin(pts[: idx + 1])[:-1] + thin(pts[idx:])


def pts(geom):
    return thin([[round(g["lat"], 5), round(g["lon"], 5)] for g in geom if g])


def outers(e):
    """Rings of a way, or the outer rings of a relation (members joined end to end)."""
    if e["type"] == "way":
        return [pts(e["geometry"])]
    segs = [[(g["lat"], g["lon"]) for g in m["geometry"]] for m in e.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        rings.append(pts([{"lat": p[0], "lon": p[1]} for p in ring]))
    return rings


def height(t) -> float:
    for k in ("height", "building:height"):
        try:
            return max(3.0, min(60.0, float(str(t[k]).split()[0])))
        except (KeyError, ValueError):
            pass
    try:
        return max(3.0, min(60.0, float(t["building:levels"]) * 4.0))
    except (KeyError, ValueError):
        pass
    if t.get("aeroway") == "terminal" or t.get("building") == "terminal":
        return 22.0
    if t.get("aeroway") == "hangar" or t.get("building") == "hangar":
        return 18.0
    if t.get("building") in ("roof", "parking"):
        return 14.0
    return 9.0


def main() -> None:
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": QUERY}).encode(),
                                 headers={"User-Agent": "sky-over-renton/1.0 (airport layer build)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        els = json.loads(r.read())["elements"]
    out = {"area": [], "apron": [], "taxi": [], "rwy": [], "bld": []}
    rw = defaultdict(lambda: {"p": [], "w": 45.0})
    for e in els:
        t = e.get("tags", {})
        aw = t.get("aeroway")
        if aw == "aerodrome":
            out["area"] += outers(e)
        elif aw == "apron":
            out["apron"] += outers(e)
        elif aw in ("taxiway", "taxilane") and e["type"] == "way":
            out["taxi"].append(pts(e["geometry"]))
        elif aw == "runway" and e["type"] == "way":
            r = rw[t.get("ref", str(e["id"]))]
            r["p"] += [(g["lat"], g["lon"]) for g in e["geometry"]]
            try:
                r["w"] = float(t["width"])
            except (KeyError, ValueError):
                pass
        elif "building" in t or aw in ("terminal", "hangar"):
            for ring in outers(e):
                if len(ring) >= 4:
                    out["bld"].append({"r": ring, "h": round(height(t)), **({"t": 1} if aw == "terminal" or t.get("building") == "terminal" else {})})
    for ref, r in rw.items():
        p = r["p"]
        a, b = max(((x, y) for x in p for y in p), key=lambda q: (q[0][0] - q[1][0]) ** 2 + ((q[0][1] - q[1][1]) * .675) ** 2)
        out["rwy"].append({"ref": ref, "a": [round(a[0], 5), round(a[1], 5)], "b": [round(b[0], 5), round(b[1], 5)], "w": r["w"]})
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print({k: len(v) for k, v in out.items()}, f"{OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
