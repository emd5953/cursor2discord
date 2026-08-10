#!/usr/bin/env python3
"""
Generate the extension icon (icon.png) shown on the Open VSX listing.

Deliberately not the Cursor or Discord mark — neither is ours to ship. It draws
the thing the extension actually produces: the two presence lines and the online
dot, in Discord's blurple on the same dark slate and corner radius as the
`cursor` badge in make-assets.py.

    python3 scripts/make-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512
RADIUS = 112
OUT = Path(__file__).resolve().parent.parent / "icon.png"

SLATE = "#111827"
BLURPLE = "#5865F2"
MUTED = "#6B7280"
ONLINE = "#23A55A"


def rounded_bar(draw, x, y, width, height, fill):
    draw.rounded_rectangle((x, y, x + width, y + height), radius=height / 2, fill=fill)


def main():
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=RADIUS, fill=SLATE)

    # The two presence lines: details (bright, longer) over state (muted, shorter),
    # sitting left-aligned the way Discord stacks them under the game name.
    left = 100
    rounded_bar(draw, left, 168, 312, 56, BLURPLE)
    rounded_bar(draw, left, 264, 200, 44, MUTED)

    # Online dot, ringed in the background colour so it reads as an overlay
    # rather than a third bar. It sits below the state line and inset from the
    # right edge, which balances the block optically without centring it.
    cx, cy, r = 372, 350, 64
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=SLATE)
    r -= 14
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ONLINE)

    image.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
