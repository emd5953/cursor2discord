#!/usr/bin/env python3
"""
Generate the presence icon set into assets/.

These are lettermarks, not the real language logos: consistent at the 60px
Discord actually renders them, no licences to audit, and reproducible from
this file. The file names are the contract with src/presence/assets.ts, so a
later swap to real logos is a drop-in replacement.

    python3 scripts/make-assets.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 512
RADIUS = 112
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
OUT = Path(__file__).resolve().parent.parent / "assets"

# name: (label, background). Colours follow each language's own brand where it
# has one, so the icons read correctly to people who know the ecosystem.
ICONS = {
    "typescript": ("TS", "#3178C6"),
    "javascript": ("JS", "#F7DF1E", "#1A1A1A"),
    "python": ("PY", "#3776AB"),
    "rust": ("RS", "#CE422B"),
    "go": ("GO", "#00ADD8"),
    "java": ("JV", "#E76F00"),
    "kotlin": ("KT", "#7F52FF"),
    "swift": ("SW", "#F05138"),
    "c": ("C", "#5C6BC0"),
    "cpp": ("C++", "#00599C"),
    "csharp": ("C#", "#68217A"),
    "ruby": ("RB", "#CC342D"),
    "php": ("PHP", "#777BB4"),
    "html": ("HT", "#E34F26"),
    "css": ("CSS", "#1572B6"),
    "json": ("{ }", "#5B5B5B"),
    "yaml": ("YML", "#CB171E"),
    "toml": ("TML", "#9C4121"),
    "markdown": ("MD", "#4A5568"),
    "shell": ("SH", "#4EAA25"),
    "sql": ("SQL", "#00758F"),
    "docker": ("DK", "#2496ED"),
    "lua": ("LUA", "#000080"),
    "dart": ("DT", "#0175C2"),
    "elixir": ("EX", "#6E4A7E"),
    "haskell": ("HS", "#5D4F85"),
    "scala": ("SC", "#DC322F"),
    "vue": ("VUE", "#42B883"),
    "svelte": ("SV", "#FF3E00"),
    "file": ("</>", "#6B7280"),
    # Badges, shown small in the corner.
    "cursor": ("C", "#111827"),
    "cursor-ai": ("AI", "#7C3AED"),
    "claude": ("CC", "#D97757"),
}


def render(name, label, background, foreground="#FFFFFF"):
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=RADIUS, fill=background)

    # Fit the label to a box rather than a fixed point size, so "C" and "C++"
    # end up optically the same weight. The box widens with the label, since a
    # width-bound fit alone makes every 3-character icon read as smaller.
    box = SIZE * (0.62 if len(label) <= 2 else 0.80)
    size = SIZE
    while size > 8:
        font = ImageFont.truetype(FONT, size)
        left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
        if right - left <= box and bottom - top <= box:
            break
        size -= 4

    left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
    draw.text(
        ((SIZE - (right + left)) / 2, (SIZE - (bottom + top)) / 2),
        label,
        font=font,
        fill=foreground,
    )

    image.save(OUT / f"{name}.png")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, spec in ICONS.items():
        label, background = spec[0], spec[1]
        foreground = spec[2] if len(spec) > 2 else "#FFFFFF"
        render(name, label, background, foreground)
    print(f"wrote {len(ICONS)} icons to {OUT}")


if __name__ == "__main__":
    main()
