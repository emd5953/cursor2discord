#!/usr/bin/env python3
"""
Render docs/demo.gif — the Discord card in each of its states.

    python3 scripts/make-demo.py

A drawing, not a screen capture: it is built from the same strings the golden
payload tests assert in src/presence/build.test.ts, and from the icons in
assets/, so it cannot drift from what the extension actually sends without a
test failing first. Needs Pillow.
"""

import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "docs", "demo.gif")

S = 2  # drawn at 2x, downsampled once, so the text edges stay clean
W, H = 620, 190

BG = (43, 45, 49)
CARD = (30, 31, 34)
TEXT = (242, 243, 245)
MUTED = (181, 186, 193)
TIMER = (35, 165, 90)

BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
BOOK = "/System/Library/Fonts/Supplemental/Arial.ttf"
MONO = "/System/Library/Fonts/Menlo.ttc"

# (large icon, badge icon or None, line 1, line 2, seconds on screen)
STATES = [
    ("cursor", "typescript", "Editing build.ts", "my-project — main", 3),
    (
        "cursor",
        "claude",
        "Claude Code — editing client.ts",
        "add rate limiting · 15.5K in / 1.2K out · 8% ctx",
        4,
    ),
    ("cursor", None, "Idle", "in cursor2discord", 2),
]


def font(path, size, index=0):
    return ImageFont.truetype(path, size * S, index=index)


def rounded(image, radius):
    """Mask an image into a rounded square, antialiased."""
    mask = Image.new("L", (image.width * 4, image.height * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, mask.width - 1, mask.height - 1], radius=radius * 4, fill=255
    )
    image.putalpha(mask.resize(image.size, Image.LANCZOS))
    return image


def icon(name, size, radius):
    art = Image.open(os.path.join(ASSETS, f"{name}.png")).convert("RGBA")
    return rounded(art.resize((size, size), Image.LANCZOS), radius)


def circle(name, size):
    art = Image.open(os.path.join(ASSETS, f"{name}.png")).convert("RGBA")
    art = art.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
    art.putalpha(mask.resize((size, size), Image.LANCZOS))
    return art


def frame(large, badge, line1, line2, elapsed):
    img = Image.new("RGB", (W * S, H * S), BG)
    draw = ImageDraw.Draw(img)

    pad = 18 * S
    draw.rounded_rectangle(
        [pad, pad, W * S - pad, H * S - pad], radius=8 * S, fill=CARD
    )

    draw.text((pad + 20 * S, pad + 16 * S), "Playing", font=font(BOOK, 12), fill=MUTED)

    art_x, art_y, art = pad + 20 * S, pad + 40 * S, 96 * S
    img.paste(icon(large, art, 22 * S), (art_x, art_y), icon(large, art, 22 * S))
    if badge:
        mark, size = circle(badge, 34 * S), 34 * S
        # Discord hangs the badge off the bottom-right corner, half outside.
        img.paste(mark, (art_x + art - size + 6 * S, art_y + art - size + 6 * S), mark)

    text_x = art_x + art + 22 * S
    draw.text((text_x, art_y + 2 * S), "Cursor", font=font(BOLD, 17), fill=TEXT)
    draw.text((text_x, art_y + 30 * S), line1, font=font(BOOK, 14), fill=MUTED)
    draw.text((text_x, art_y + 52 * S), line2, font=font(BOOK, 14), fill=MUTED)
    # Discord puts a controller glyph here; Menlo has no emoji coverage and
    # renders tofu, so the dot stands in for it.
    dot = art_y + 80 * S
    draw.ellipse([text_x, dot, text_x + 8 * S, dot + 8 * S], fill=TIMER)
    draw.text(
        (text_x + 16 * S, art_y + 76 * S),
        f"{elapsed // 60}:{elapsed % 60:02d}",
        font=font(MONO, 13),
        fill=TIMER,
    )

    return img.resize((W, H), Image.LANCZOS)


def main() -> int:
    frames, seconds = [], 0
    for large, badge, line1, line2, hold in STATES:
        for _ in range(hold):
            seconds += 1
            frames.append(frame(large, badge, line1, line2, seconds))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=1000,
        loop=0,
        optimize=True,
    )
    print(f"wrote {OUT} ({len(frames)} frames)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
