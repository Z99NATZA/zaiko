#!/usr/bin/env python3
"""Cut a transparent chibi sticker sheet into expression frames.

Usage: slice_sheet.py SHEET.png OUT_DIR COLSxROWS NAME [NAME ...]

Names are given in reading order (left to right, top to bottom); one per frame.
Neighbouring frames may touch, so each cut follows the path that crosses the
least artwork near the grid line. Nearly opaque pixels become fully opaque and a
faint glow is dropped. Every frame is placed on one shared canvas with the body
centred and its bottom edge on the canvas bottom, so all expressions draw at the
same scale and anchor. Requires Pillow.
"""
import sys
from collections import deque
from pathlib import Path

from PIL import Image

FAINT, SOLID = 16, 240  # alpha below FAINT is dropped; from SOLID up is opaque
SPECK = 6  # ignore stray specks smaller than this many pixels


def firm_alpha(a):
    return max(0, min(255, round((a - FAINT) * 255 / (SOLID - FAINT))))


def seam(cost, length, centre, reach):
    """Cheapest path of offsets in [centre - reach, centre + reach] along `length`
    steps, moving at most one pixel per step. cost(step, offset) -> number."""
    lo, hi = centre - reach, centre + reach
    span = range(lo, hi + 1)
    total = {o: cost(0, o) for o in span}
    back = []
    for step in range(1, length):
        prev, total, links = total, {}, {}
        for o in span:
            best = min((p for p in (o - 1, o, o + 1) if lo <= p <= hi), key=prev.__getitem__)
            total[o] = prev[best] + cost(step, o) + abs(o - centre) * 0.01
            links[o] = best
        back.append(links)
    path = [min(span, key=total.__getitem__)]
    for links in reversed(back):
        path.append(links[path[-1]])
    return path[::-1]


def body_parts(cell):
    """Opaque components of a cell as [(size, pixels)], largest first."""
    seen, parts = set(), []
    for start in cell:
        if start in seen:
            continue
        seen.add(start)
        queue, pixels = deque([start]), []
        while queue:
            x, y = queue.popleft()
            pixels.append((x, y))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    p = (x + dx, y + dy)
                    if p in cell and p not in seen:
                        seen.add(p)
                        queue.append(p)
        parts.append((len(pixels), pixels))
    return sorted(parts, key=lambda part: -part[0])


def main(argv):
    if len(argv) < 5 or 'x' not in argv[3]:
        sys.exit(__doc__)
    sheet, out_dir, names = Path(argv[1]), Path(argv[2]), argv[4:]
    cols, rows = (int(n) for n in argv[3].split('x'))
    if cols * rows != len(names):
        sys.exit(f'{cols}x{rows} grid needs {cols * rows} names, got {len(names)}')
    src = Image.open(sheet)
    if 'A' not in src.getbands() and 'transparency' not in src.info:
        sys.exit('The sheet has no transparency; export it with a transparent background.')
    src = src.convert('RGBA')
    w, h = src.size
    px = src.load()
    assert px is not None
    alpha = lambda x, y: px[x, y][3] if px[x, y][3] >= FAINT else 0

    # Column cuts span the whole sheet; row cuts are found per column.
    vcuts = [[0] * h] + [seam(lambda y, x: alpha(x, y), h, k * w // cols, w // (2 * cols))
                         for k in range(1, cols)] + [[w] * h]
    frames = []
    for r in range(rows):
        for c in range(cols):
            left = lambda y: vcuts[c][y]
            right = lambda y: vcuts[c + 1][y]
            x0, x1 = min(vcuts[c]), max(vcuts[c + 1])
            hcut = lambda k: ([0] * (x1 - x0) if k == 0 else [h] * (x1 - x0) if k == rows else
                              seam(lambda i, y: alpha(x0 + i, y), x1 - x0, k * h // rows, h // (2 * rows)))
            top, bottom = hcut(r), hcut(r + 1)
            cell = {(x, y) for x in range(x0, x1) for y in range(top[x - x0], bottom[x - x0])
                    if left(y) <= x < right(y) and alpha(x, y)}
            # Drop specks and faint fragments of a neighbour that crossed the cut.
            parts = [part for part in body_parts(cell)
                     if part[0] >= SPECK and any(px[p][3] >= SOLID for p in part[1])]
            keep = [p for _, pixels in parts for p in pixels]
            bx = [p[0] for p in parts[0][1]]
            by = [p[1] for p in parts[0][1]]
            fx0, fy0 = min(p[0] for p in keep), min(p[1] for p in keep)
            fx1, fy1 = max(p[0] for p in keep), max(p[1] for p in keep)
            frame = Image.new('RGBA', (fx1 - fx0 + 1, fy1 - fy0 + 1), (0, 0, 0, 0))
            fpx = frame.load()
            for x, y in keep:
                red, green, blue, a = px[x, y]
                fpx[x - fx0, y - fy0] = (red, green, blue, firm_alpha(a))
            frames.append((frame, (min(bx) + max(bx)) / 2 - fx0, max(by) - fy0))

    half = max(max(centre, frame.width - centre) for frame, centre, _ in frames)
    above = max(bottom for _, _, bottom in frames)
    below = max(frame.height - 1 - bottom for frame, _, bottom in frames)
    canvas = (int(2 * half + 1), int(above + below + 1))
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, (frame, centre, bottom) in zip(names, frames):
        out = Image.new('RGBA', canvas, (0, 0, 0, 0))
        out.alpha_composite(frame, (round(half - centre), above - bottom))
        out.save(out_dir / f'{name}.png', optimize=True)
    print(f'{len(frames)} frames, canvas {canvas[0]}x{canvas[1]}, body bottom at y={above}')


if __name__ == '__main__':
    main(sys.argv)
