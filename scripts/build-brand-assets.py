#!/usr/bin/env python3
"""
Build the MaaCash brand SVG assets with the wordmark converted to real
vector paths.

Why paths instead of <text>: the production logo must render identically on
every machine and in every renderer (browser, PWA installer, social scraper,
print). A <text> element depends on a font being present, so the wordmark is
converted to outlines here using the Noto Sans Bold outlines shipped with
Windows.

Outputs (public/branding/):
  maacash-mark.svg              symbol, colour, light background
  maacash-mark-mono-black.svg   symbol, black
  maacash-mark-mono-white.svg   symbol, white
  maacash-logo.svg              horizontal, colour, light background
  maacash-logo-light.svg        horizontal, colour, light background (explicit)
  maacash-logo-reversed.svg     horizontal, colour, dark background
  maacash-logo-mono-black.svg   horizontal, black
  maacash-logo-mono-white.svg   horizontal, white
  maacash-logo-stacked.svg      symbol above wordmark
  maacash-icon.svg              application icon tile
  maacash-og.svg                1200x630 social sharing image

Run from the repository root:
  python scripts/build-brand-assets.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "branding"

FONT_CANDIDATES = [
    Path(os.environ.get("WINDOWS_FONTS", r"C:\Windows\Fonts")) / "NotoSans-Bold.ttf",
    Path("/c/Windows/Fonts/NotoSans-Bold.ttf"),
    Path("/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"),
]

# ---------------------------------------------------------------------------
# Brand tokens
# ---------------------------------------------------------------------------
FOREST = "#0E4D34"
FOREST_DEEP = "#083122"
GOLD = "#C9A227"
IVORY = "#F6F5EC"
INK = "#17211C"
BLACK = "#111111"
WHITE = "#FFFFFF"

# ---------------------------------------------------------------------------
# Mark geometry — a 48x48 tile.
#
# The symbol is an open ring (connected operational paths around the business)
# with a gold core at the centre (the single control point). The opening at the
# lower right gives the mark direction and keeps it readable at 16x16.
# ---------------------------------------------------------------------------
TILE_RADIUS = 11.5
RING_PATH = "M31.17 34.24A12.5 12.5 0 1 1 31.17 13.76"
RING_WIDTH = 6.5
CORE_RADIUS = 4.4


def load_font() -> TTFont:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return TTFont(str(candidate))
    raise SystemExit(
        "Noto Sans Bold not found. Set WINDOWS_FONTS to the directory that "
        "contains NotoSans-Bold.ttf."
    )


def text_paths(font: TTFont, text: str, size: float, x: float, y: float) -> dict:
    """Return outline path data for `text` with its baseline at (x, y)."""
    upem = font["head"].unitsPerEm
    scale = size / upem
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()

    paths: list[str] = []
    cursor = x
    for char in text:
        glyph_name = cmap.get(ord(char))
        if glyph_name is None:
            raise SystemExit(f"glyph missing for {char!r}")
        glyph = glyph_set[glyph_name]
        pen = SVGPathPen(glyph_set, ntos=lambda value: f"{value:.2f}")
        transform = TransformPen(pen, (scale, 0, 0, -scale, cursor, y))
        glyph.draw(transform)
        data = pen.getCommands()
        if data:
            paths.append(data)
        cursor += glyph.width * scale
    return {"d": "".join(paths), "width": cursor - x}


def svg(width: int, height: int, body: str, title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-label="{title}">'
        f"{body}</svg>"
    )


def tile_group(scale: float = 1.0, tile: str | None = FOREST) -> str:
    parts = []
    if tile:
        parts.append(
            f'<rect width="48" height="48" rx="{TILE_RADIUS}" fill="{tile}"/>'
        )
    parts.append(
        f'<path d="{RING_PATH}" fill="none" stroke="{{ring}}" stroke-width="{RING_WIDTH}"/>'
    )
    parts.append(f'<circle cx="24" cy="24" r="{CORE_RADIUS}" fill="{{core}}"/>')
    body = "".join(parts)
    if scale != 1.0:
        body = f'<g transform="scale({scale})">{body}</g>'
    return body


def render_group(body: str, ring: str, core: str) -> str:
    return body.replace("{ring}", ring).replace("{core}", core)


def wordmark(font: TTFont, size: float, x: float, y: float, gap: float) -> dict:
    """'Maa' in ink and 'Cash' in the accent colour, as two path groups."""
    core_part = text_paths(font, "Maa", size, x, y)
    one_part = text_paths(font, "Cash", size, x + core_part["width"] + gap, y)
    return {"core": core_part, "one": one_part}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    font = load_font()

    # ---- symbol only -----------------------------------------------------
    (OUT / "maacash-mark.svg").write_text(
        svg(
            48,
            48,
            render_group(tile_group(), IVORY, GOLD),
            "MaaCash symbol",
        ),
        encoding="utf-8",
    )
    (OUT / "maacash-mark-mono-black.svg").write_text(
        svg(
            48,
            48,
            render_group(tile_group(tile=None), BLACK, BLACK),
            "MaaCash symbol",
        ),
        encoding="utf-8",
    )
    (OUT / "maacash-mark-mono-white.svg").write_text(
        svg(
            48,
            48,
            render_group(tile_group(tile=None), WHITE, WHITE),
            "MaaCash symbol",
        ),
        encoding="utf-8",
    )

    # ---- horizontal wordmark ---------------------------------------------
    def horizontal(
        filename: str,
        ring: str,
        core: str,
        text_fill: str,
        one_fill: str,
        tile: str | None = FOREST,
        label: str = "MaaCash",
    ) -> None:
        mark = render_group(tile_group(tile=tile), ring, core)
        wm = wordmark(font, 25, 62, 31.5, 0)
        logo_width = round(62 + wm["core"]["width"] + wm["one"]["width"] + 14)
        body = (
            f'<g>{mark}</g>'
            f'<path d="{wm["core"]["d"]}" fill="{text_fill}"/>'
            f'<path d="{wm["one"]["d"]}" fill="{one_fill}"/>'
        )
        (OUT / filename).write_text(svg(logo_width, 48, body, label), encoding="utf-8")

    horizontal(
        "maacash-logo.svg", IVORY, GOLD, INK, GOLD, tile=FOREST
    )
    horizontal(
        "maacash-logo-light.svg", IVORY, GOLD, INK, GOLD, tile=FOREST
    )
    horizontal(
        "maacash-logo-reversed.svg", IVORY, GOLD, IVORY, GOLD, tile=None
    )
    horizontal(
        "maacash-logo-mono-black.svg", BLACK, BLACK, BLACK, BLACK, tile=None
    )
    horizontal(
        "maacash-logo-mono-white.svg", WHITE, WHITE, WHITE, WHITE, tile=None
    )

    # ---- stacked ----------------------------------------------------------
    mark = render_group(tile_group(tile=FOREST), IVORY, GOLD)
    wm = wordmark(font, 27, 0, 0, 0)
    wm_width = wm["core"]["width"] + wm["one"]["width"]
    stacked_x = round((280 - wm_width) / 2, 2)
    stacked_body = (
        f'<g transform="translate(84 4) scale(1.5)">{mark}</g>'
        f'<g transform="translate({stacked_x} 106)">'
        f'<path d="{wm["core"]["d"]}" fill="{INK}"/>'
        f'<path d="{wm["one"]["d"]}" fill="{GOLD}"/>'
        f"</g>"
    )
    (OUT / "maacash-logo-stacked.svg").write_text(
        svg(280, 158, stacked_body, "MaaCash"), encoding="utf-8"
    )

    # ---- application icon -------------------------------------------------
    icon_body = (
        f'<rect width="512" height="512" rx="112" fill="{FOREST}"/>'
        f'<g transform="translate(64 64) scale(8)">'
        f'<rect width="48" height="48" rx="{TILE_RADIUS}" fill="{FOREST}"/>'
        f'<path d="{RING_PATH}" fill="none" stroke="{IVORY}" stroke-width="{RING_WIDTH}"/>'
        f'<circle cx="24" cy="24" r="{CORE_RADIUS}" fill="{GOLD}"/>'
        f"</g>"
    )
    (OUT / "maacash-icon.svg").write_text(
        svg(512, 512, icon_body, "MaaCash"), encoding="utf-8"
    )

    # ---- social sharing image --------------------------------------------
    og_line1 = text_paths(font, "One platform.", 62, 88, 330)
    og_line2 = text_paths(font, "Clearer control.", 62, 88, 404)
    og_small = text_paths(font, "Mobile Money, Susu & Multi-Branch Operations", 26, 88, 474)
    og_body = (
        f'<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{FOREST}"/>'
        f'<stop offset="1" stop-color="{FOREST_DEEP}"/>'
        f'</linearGradient></defs>'
        f'<rect width="1200" height="630" fill="url(#bg)"/>'
        f'<g opacity="0.12" fill="none" stroke="{IVORY}" stroke-width="2">'
        f'<circle cx="980" cy="120" r="320"/><circle cx="980" cy="120" r="240"/>'
        f'<circle cx="980" cy="120" r="160"/></g>'
        f'<g transform="translate(88 92) scale(2.6)">'
        f'<path d="{RING_PATH}" fill="none" stroke="{IVORY}" stroke-width="{RING_WIDTH}"/>'
        f'<circle cx="24" cy="24" r="{CORE_RADIUS}" fill="{IVORY}"/>'
        f"</g>"
        f'<path d="{og_line1["d"]}" fill="{IVORY}"/>'
        f'<path d="{og_line2["d"]}" fill="{GOLD}"/>'
        f'<path d="{og_small["d"]}" fill="{IVORY}" opacity="0.75"/>'
        f'<path d="{text_paths(font, "BloomCore Technologies", 24, 88, 540)["d"]}" '
        f'fill="{IVORY}" opacity="0.55"/>'
    )
    (OUT / "maacash-og.svg").write_text(
        svg(1200, 630, og_body, "MaaCash — One platform. Clearer control."),
        encoding="utf-8",
    )

    print(json.dumps({"written": sorted(p.name for p in OUT.glob("*.svg"))}, indent=2))


if __name__ == "__main__":
    main()
