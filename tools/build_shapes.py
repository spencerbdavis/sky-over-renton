"""Build web/shapes/ from shapes-src/ (RexKramer1/AircraftShapesSVG outlines).

The sources are Inkscape files: outline-only paths in an 80-unit box drawn to a
common scale (1 unit ~ 1 m), with lots of padding and metadata (~5 KB each).
For each type this writes web/shapes/<CODE>.svg holding only the path data,
cropped to a square around the aircraft's centre (so it rotates about itself),
and web/shapes/index.json:
  size     {code: span in units}  -> the app scales icons by real size
  aliases  {type code: shape}     -> common types the set lacks
  category {ADS-B emitter category: shape} -> last resort before "Unidentified"

Run with any Python that has cairosvg + Pillow (pip install cairosvg Pillow):
  python3 tools/build_shapes.py
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / "shapes-src", ROOT / "web" / "shapes"
RENDER = 400            # px for the 80-unit box when measuring

# Types we see around Seattle that the set lacks, pointed at the closest shape it has.
ALIASES = {
    # regional and narrow-body jets
    "E75L": "E170", "E75S": "E170", "E75": "E170", "E190": "E195", "E290": "E195", "E295": "E195",
    "B737": "B737", "B736": "B737", "B37M": "B38M", "B3XM": "B39M", "A19N": "A19N", "A20N": "A20N",
    "A319": "A320", "BCS1": "BCS1", "CRJ1": "CRJ2", "CRJ9": "CRJ9",
    # wide-bodies and freighters
    "B744": "B744", "B74F": "B744", "B77F": "B77L", "B763": "B763", "B762": "B762", "B788": "B788",
    "A332": "A332", "A333": "A333", "MD11": "MD11", "B752": "B752", "B753": "B753",
    # business jets
    "CL30": "C750", "CL35": "C750", "CL60": "C750", "C680": "C750", "C68A": "C750", "C700": "C750",
    "E55P": "C25B", "E545": "C25B", "E550": "C25B", "C25A": "C25B", "C25C": "C25B", "C525": "C25B",
    "C510": "C25B", "C560": "C25B", "C56X": "C25B", "LJ45": "LJ35", "LJ60": "LJ35", "LJ75": "LJ35",
    "GLF4": "GLF6", "GLF5": "GLF6", "G280": "GLF6", "GL7T": "GL5T", "GLEX": "GL5T", "F2TH": "FA7X",
    "F900": "FA7X", "FA8X": "FA7X", "PC24": "C25B", "HDJT": "C25B", "SF50": "SR22",
    # turboprops
    "DH8A": "DH8C", "DH8B": "DH8C", "AT72": "AT75", "AT76": "AT75", "AT43": "AT45", "B190": "B190",
    "BE20": "B350", "B300": "B350", "BE9L": "B350", "BE99": "B190", "PC12": "PC12", "TBM7": "PA46",
    "TBM8": "PA46", "TBM9": "PA46", "P46T": "PA46", "C208": "C208", "DHC6": "D228", "C441": "B350",
    "SW4": "J328", "DHC2": "C208", "DHC3": "C208", "KODI": "C208",
    # light singles and twins
    "C150": "C172", "C152": "C172", "C170": "C172", "C180": "C172", "C182": "C172", "C82R": "C172",
    "C185": "C172", "C210": "C172", "C206": "C208", "C207": "C208", "T206": "C208", "P28B": "P28A",
    "P28R": "P28A", "P32R": "P28A", "PA32": "P28A", "PA28": "P28A", "PA24": "P28A", "M20P": "P28A",
    "M20T": "P28A", "BE33": "P28A", "BE35": "P28A", "BE36": "P28A", "RV6": "P28A", "RV7": "P28A",
    "RV8": "P28A", "RV10": "P28A", "DA40": "SR22", "SR20": "SR22", "S22T": "SR22", "COL4": "SR22",
    "C310": "DA42", "C340": "DA42", "C402": "DA42", "C414": "DA42", "C421": "DA42", "BE55": "DA42",
    "BE58": "DA42", "PA34": "DA42", "PA31": "DA42", "PA44": "DA42", "P68": "DA42", "DA62": "DA42",
    # helicopters
    "B06": "R44", "B407": "EC35", "B429": "EC35", "A109": "EC35", "A119": "EC35", "AS50": "EC35",
    "AS55": "EC35", "EC30": "EC35", "EC130": "EC35", "H125": "EC35", "H130": "EC35", "EC55": "EC45",
    "R22": "R44", "R66": "R44", "S76": "S61", "B412": "UH1", "B212": "UH1", "S70": "H60", "UH60": "H60",
    # military seen over the Sound
    "P8": "P8", "E6": "E3CF", "C40": "B737", "K35R": "K35E", "KC46": "KC46", "C17": "C17", "C130": "C130",
    "C30J": "C130", "EA18": "F18S", "F18": "F18H", "E2": "C2",
}
# ADS-B emitter category (readsb "category") -> shape, when the type is unknown
CATEGORY = {"A1": "C172", "A2": "C25B", "A3": "A320", "A4": "B752", "A5": "B77W", "A6": "F16", "A7": "R44",
            "B1": "SF25", "B2": "BALL", "B4": "SF25", "B6": "Unidentified"}

ATTR = re.compile(r'\sd="([^"]+)"', re.S)


def measure(svg: str):
    """Content bbox in source units from a render with the outlines filled."""
    filled = re.sub(r"fill:none", "fill:#000", svg)
    filled = re.sub(r"stroke-width:[\d.]+(px)?", "stroke-width:0.6", filled)
    png = cairosvg.svg2png(bytestring=filled.encode(), output_width=RENDER, output_height=RENDER)
    im = Image.open(io.BytesIO(png)).convert("RGBA")
    box = im.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
    if not box:
        return None
    vb = [float(x) for x in re.search(r'viewBox="([^"]+)"', svg).group(1).split()]
    k = vb[2] / RENDER
    return (vb[0] + box[0] * k, vb[1] + box[1] * k, vb[0] + box[2] * k, vb[1] + box[3] * k)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sizes, total = {}, 0
    for f in sorted(SRC.glob("*.svg")):
        code = f.stem
        if not re.fullmatch(r"[A-Za-z0-9]+", code):       # "B1 fast" style variants: skip
            continue
        svg = f.read_text()
        ds = [re.sub(r"\s+", " ", d).strip() for d in ATTR.findall(svg)]
        bb = measure(svg)
        if not ds or not bb:
            continue
        x0, y0, x1, y1 = bb
        cx, cy, half = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) / 2 + 0.6
        vb = f"{cx - half:.2f} {cy - half:.2f} {2 * half:.2f} {2 * half:.2f}"
        body = "".join(f'<path d="{d}"/>' for d in ds)
        out = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">{body}</svg>'
        (OUT / f"{code}.svg").write_text(out)
        sizes[code] = round(max(x1 - x0, y1 - y0), 1)
        total += len(out)
    have = set(sizes)
    aliases = {k: v for k, v in ALIASES.items() if v in have and k not in have}
    category = {k: v for k, v in CATEGORY.items() if v in have}
    (OUT / "index.json").write_text(json.dumps({"size": sizes, "aliases": aliases, "category": category}, separators=(",", ":")))
    print(f"{len(sizes)} shapes, {total // 1024} KB total (avg {total // max(1, len(sizes))} B), "
          f"{len(aliases)} aliases; span range {min(sizes.values())}-{max(sizes.values())}")


if __name__ == "__main__":
    main()
