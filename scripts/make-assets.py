#!/usr/bin/env python3
"""
Regenerate everything in `assets/`.

    python3 scripts/make-assets.py

Needs Pillow, network access, and Google Chrome (used headless, as the SVG
renderer — macOS ships no `rsvg-convert`, and `qlmanage` hands back the Finder's
generic SVG thumbnail rather than the drawing).

Every icon is a 512x512 rounded plate. Language marks are the real brand logos
from devicon, on a light plate: they are drawn for a light ground, and inverting
a coloured mark to fit a dark one turns Ruby cyan. Cursor and Claude keep their
own plates — those two are app icons, not language icons, and they are the ones
a reader identifies at badge size.

Up to 0.1.2 these were all lettermarks drawn from scratch, which is how a
markdown file ended up on the card as a 512px "MD". That version avoided having
any licences to audit; this one trades that for icons people recognise, so the
attribution in README's licence section is part of the deal.
"""

import base64
import os
import subprocess
import sys
import tempfile
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

# Supersampling factor. Rounded corners and the sparkle's points alias badly at
# 512 straight; everything is drawn at 4x and downsampled once at the end.
S = 4
N = 512 * S
RADIUS = 112

LIGHT = (244, 245, 247, 255)
INK = (43, 47, 58, 255)
CURSOR_BLACK = (20, 18, 11, 255)
CLAUDE_CREAM = (240, 238, 230, 255)

DEVICON = "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/{n}/{n}-original.svg"
CURSOR_ICON = "https://cursor.com/pwa/icon-512x512.png"
CLAUDE_ICON = "https://claude.ai/images/claude_app_icon.png"

# asset basename -> devicon icon name
LANGUAGES = {
    "c": "c",
    "cpp": "cplusplus",
    "csharp": "csharp",
    "css": "css3",
    "dart": "dart",
    "docker": "docker",
    "elixir": "elixir",
    "go": "go",
    "haskell": "haskell",
    "html": "html5",
    "java": "java",
    "javascript": "javascript",
    "json": "json",
    "kotlin": "kotlin",
    "lua": "lua",
    "markdown": "markdown",
    "php": "php",
    "python": "python",
    "ruby": "ruby",
    "rust": "rust",
    "scala": "scala",
    "shell": "bash",
    "svelte": "svelte",
    "swift": "swift",
    "typescript": "typescript",
    "vue": "vuejs",
    "yaml": "yaml",
}

# No logo of their own upstream — a wordmark is honest, invented marks are not.
WORDMARKS = {"toml": "TOML", "sql": "SQL"}


def fetch(url: str) -> bytes:
    # `www.cursor.com` 308s to the apex, and python's redirect handler does not
    # follow 308 before 3.11 — hence the apex host in CURSOR_ICON rather than
    # the one a browser lands on.
    request = urllib.request.Request(url, headers={"User-Agent": "cursor2discord-assets"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def plate(fill) -> Image.Image:
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle([0, 0, N - 1, N - 1], radius=RADIUS * S, fill=fill)
    return img


def save(img: Image.Image, name: str) -> None:
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(ASSETS, f"{name}.png"))


def render_language_marks(work: str) -> Image.Image:
    """One Chrome run for all of devicon, as a transparent grid to slice up."""
    columns = 6
    rows = (len(LANGUAGES) + columns - 1) // columns
    width, height = columns * 512, rows * 512

    cells = []
    for icon in LANGUAGES.values():
        svg = base64.b64encode(fetch(DEVICON.format(n=icon))).decode()
        cells.append(f'<div class=c><img src="data:image/svg+xml;base64,{svg}"></div>')

    html = (
        "<style>html,body{margin:0;padding:0;background:transparent}"
        f".g{{display:grid;grid-template-columns:repeat({columns},512px);width:{width}px}}"
        ".c{width:512px;height:512px;display:flex;align-items:center;justify-content:center}"
        ".c img{width:320px;height:320px;object-fit:contain}</style>"
        f"<div class=g>{''.join(cells)}</div>"
    )
    page = os.path.join(work, "grid.html")
    shot = os.path.join(work, "grid.png")
    with open(page, "w") as handle:
        handle.write(html)

    subprocess.run(
        [
            CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
            "--default-background-color=00000000",
            f"--window-size={width},{height}",
            f"--screenshot={shot}", f"file://{page}",
        ],
        check=True,
        capture_output=True,
    )
    return Image.open(shot).convert("RGBA")


def write_languages(work: str) -> None:
    grid = render_language_marks(work)
    for index, name in enumerate(LANGUAGES):
        x, y = (index % 6) * 512, (index // 6) * 512
        mark = grid.crop((x, y, x + 512, y + 512)).resize((N, N), Image.LANCZOS)
        img = plate(LIGHT)
        img.alpha_composite(mark)
        save(img, name)


def write_wordmarks() -> None:
    for name, text in WORDMARKS.items():
        img = plate(LIGHT)
        font = ImageFont.truetype(FONT, (200 if len(text) <= 3 else 150) * S)
        ImageDraw.Draw(img).text((N / 2, N / 2), text, font=font, fill=INK, anchor="mm")
        save(img, name)


def write_file_icon() -> None:
    """A page with a folded corner: it stands for "some file", and any wordmark
    there would be a claim about a language we did not recognise."""
    img = plate(LIGHT)
    draw = ImageDraw.Draw(img)
    x0, y0, x1, y1, fold = 150 * S, 118 * S, 362 * S, 394 * S, 74 * S
    draw.polygon(
        [(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)],
        fill=(107, 114, 128, 255),
    )
    draw.polygon([(x1 - fold, y0), (x1, y0 + fold), (x1 - fold, y0 + fold)], fill=LIGHT)
    save(img, "file")


def write_cursor(source: Image.Image) -> None:
    save(source.resize((N, N), Image.LANCZOS), "cursor")


def write_cursor_ai(source: Image.Image) -> None:
    """The Cursor mark plus a sparkle, so the badge reads as "Cursor, doing
    something" rather than as a second copy of the large image next to it."""
    scaled = source.resize((N, N), Image.LANCZOS)
    pixels = scaled.load()

    # Lift the cube off Cursor's own plate rather than shrinking the whole icon,
    # which would leave its border stroke floating inside ours.
    cube = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    target = cube.load()
    for y in range(N):
        for x in range(N):
            r, g, b, _ = pixels[x, y]
            if 0.2126 * r + 0.7152 * g + 0.0722 * b > 150:
                target[x, y] = (235, 235, 235, 255)
    cube = cube.crop(cube.getbbox())

    img = plate(CURSOR_BLACK)
    width = int(N * 0.60)
    img.alpha_composite(
        cube.resize((width, int(cube.height * width / cube.width)), Image.LANCZOS),
        (int(N * 0.13), int(N * 0.11)),
    )

    draw = ImageDraw.Draw(img)

    def sparkle(cx, cy, radius, waist):
        draw.polygon(
            [
                (cx, cy - radius), (cx + waist, cy - waist), (cx + radius, cy),
                (cx + waist, cy + waist), (cx, cy + radius), (cx - waist, cy + waist),
                (cx - radius, cy), (cx - waist, cy - waist),
            ],
            fill=(255, 255, 255, 255),
        )

    sparkle(398 * S, 392 * S, 84 * S, 21 * S)
    sparkle(312 * S, 442 * S, 38 * S, 10 * S)
    save(img, "cursor-ai")


def write_claude(work: str) -> None:
    raw = os.path.join(work, "claude.png")
    with open(raw, "wb") as handle:
        handle.write(fetch(CLAUDE_ICON))
    # Cropped inside the source's drop shadow, so the plate edge is ours rather
    # than a smudge of someone else's.
    source = Image.open(raw).convert("RGBA").crop((5, 3, 331, 329)).resize((512, 512), Image.LANCZOS)

    img = Image.new("RGBA", (512, 512), CLAUDE_CREAM)
    img.alpha_composite(source)
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=RADIUS * S, fill=255)
    img.putalpha(mask.resize((512, 512), Image.LANCZOS))
    img.save(os.path.join(ASSETS, "claude.png"))


def main() -> int:
    if not os.path.exists(CHROME):
        print(f"Chrome not found at {CHROME}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as work:
        cursor = Image.open(
            _download(work, "cursor.png", CURSOR_ICON)
        ).convert("RGBA")
        write_languages(work)
        write_wordmarks()
        write_file_icon()
        write_cursor(cursor)
        write_cursor_ai(cursor)
        write_claude(work)

    print(f"wrote {len(LANGUAGES) + len(WORDMARKS) + 4} icons to {ASSETS}")
    return 0


def _download(work: str, name: str, url: str) -> str:
    path = os.path.join(work, name)
    with open(path, "wb") as handle:
        handle.write(fetch(url))
    return path


if __name__ == "__main__":
    raise SystemExit(main())
