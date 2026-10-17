#!/usr/bin/env python3
"""Turns a square source image into icon.png in the shape tinyjs expects: a 1024x1024 transparent canvas holding a
rounded square inset by 100px with a 185px corner radius (the geometry of tinyjs's own default icon).

    python3 tools/make-icon.py ~/Downloads/db-icon.jpg          # writes ./icon.png
    python3 tools/make-icon.py source.png --out icon.png

The source must be square, at least 1024px, and already a full-bleed picture. If it was drawn as a rounded tile with
white or transparent corners (as AI image tools often do), the 824px centre crop used here lies inside that tile, so
those corners never show up. Needs Pillow (pip install pillow).
"""
import argparse
from PIL import Image, ImageDraw

SIZE, INSET, RADIUS = 1024, 100, 185

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('source')
ap.add_argument('--out', default='icon.png')
args = ap.parse_args()

src = Image.open(args.source).convert('RGB')
if src.width != src.height or src.width < SIZE:
    raise SystemExit(f'the source must be square and at least {SIZE}px, not {src.width}x{src.height}')
src = src.resize((SIZE, SIZE), Image.LANCZOS)
side = SIZE - 2 * INSET
art = src.crop((INSET, INSET, SIZE - INSET, SIZE - INSET))
k = 4  # draw the mask 4x and shrink it for smooth edges
big = Image.new('L', (side * k, side * k), 0)
ImageDraw.Draw(big).rounded_rectangle((0, 0, side * k - 1, side * k - 1), radius=RADIUS * k, fill=255)
out = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
out.paste(art, (INSET, INSET), big.resize((side, side), Image.LANCZOS))
out.save(args.out)
print(f'wrote {args.out} ({SIZE}x{SIZE}, {side}px rounded square, transparent margin)')
