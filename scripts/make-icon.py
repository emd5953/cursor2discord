#!/usr/bin/env python3
"""
Generate the extension icon (icon.png) shown on the Open VSX listing.

Deliberately not the Cursor or Discord mark — neither is ours to ship. It draws
the thing the extension actually produces: a presence card, as two stacked lines
inside a message bubble, with the online dot badged over the corner. A generic
rounded bubble is nobody's trademark; Discord's own mark is the face, not this.

Up to 0.1.4 the same two lines sat bare on the plate with the dot beside them,
which at list size read as two grey bars and a dot — any status app at all. The
bubble is what makes the silhouette legible at 32px, which is the only size that
decides whether anyone recognises it in the extensions panel.

Drawn at 4x and downsampled once, like make-assets.py: the bubble tail and the
dot's ring alias badly at 512 straight.

    python3 scripts/make-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

S = 4
SIZE = 512 * S
RADIUS = 112 * S
OUT = Path(__file__).resolve().parent.parent / "icon.png"

SLATE = "#111827"
BLURPLE = "#5865F2"
CREAM = "#F4F5F7"
DIM = "#A9B2F7"
ONLINE = "#23A55A"


def bar(draw, x, y, width, height, fill):
    draw.rounded_rectangle(
        (x * S, y * S, (x + width) * S, (y + height) * S), radius=height * S / 2, fill=fill
    )


def main():
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=RADIUS, fill=SLATE)

    # The bubble, with its tail on the lower left so the weight sits opposite
    # the badge. The tail overlaps the body by 6px so the seam never shows.
    bx, by, bw, bh = 64, 104, 352, 244
    draw.rounded_rectangle((bx * S, by * S, (bx + bw) * S, (by + bh) * S), radius=52 * S, fill=BLURPLE)
    draw.polygon(
        [(124 * S, (by + bh - 6) * S), (124 * S, (by + bh + 74) * S), (216 * S, (by + bh - 6) * S)],
        fill=BLURPLE,
    )

    # details over state, the same hierarchy the card itself uses: the first
    # line bright and long, the second dimmer and shorter.
    bar(draw, 112, 168, 236, 46, CREAM)
    bar(draw, 112, 242, 152, 38, DIM)

    # Online dot, ringed in the plate colour so it reads as a badge over the
    # bubble rather than a shape sharing its edge.
    cx, cy, r, ring = 398, 386, 58, 16
    draw.ellipse(((cx - r - ring) * S, (cy - r - ring) * S, (cx + r + ring) * S, (cy + r + ring) * S), fill=SLATE)
    draw.ellipse(((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S), fill=ONLINE)

    image.resize((512, 512), Image.LANCZOS).save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
