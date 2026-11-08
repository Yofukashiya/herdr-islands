"""Grid-over-gradient backdrop for the Islands layout (idea: herdr-van's tokyo-grid.png).

Herdr draws a layout background image with `fit: cover`: scaled to fill the window and
cropped, at whatever size the window is. So this image is built to survive that:

- 3840x2160, so 1080p, 1440p, 4K and Retina windows all draw it at 0.5x..1.4x;
- grid lines have a soft 3px profile instead of 1px hairlines, so any scale resamples
  them evenly (hairlines turn into uneven, flickering lines when scaled);
- everything that matters runs top to bottom (grid fading into the gradient); the
  sheen is broad and off in the corners, so cropping for ultrawide, 16:10 (Mac) or a
  tall half-screen window loses nothing important;
- ordered (Bayer) dithering keeps the dark gradient free of bands.

Colors are tuned to Herdr's dark `graphite` theme (canvas #131518). For another dark
theme, change TOP / BOTTOM / GLOWS and run again; the layout picks the new file up live.

Usage: python3 make_islands_grid.py OUT.png [WIDTH HEIGHT]
"""
import math
import struct
import sys
import zlib

OUT = sys.argv[1]
W = int(sys.argv[2]) if len(sys.argv) > 2 else 3840
H = int(sys.argv[3]) if len(sys.argv) > 3 else 2160
S = W / 2560                # sizes below are in 2560-wide units

TOP = (5, 6, 9)             # near black, like herdr-van's #000 start
BOTTOM = (15, 17, 29)       # deep indigo: the cards' graphite reads warmer on it, not gray
CURVE = 1.8                 # base gradient: t**CURVE, so the dark top holds longer
PITCH = 40 * S              # grid cell
OFFSET = 12 * S             # first line on the layout's 12px padding
HALF = 1.0 * S              # line half-width of the soft profile
LINE = 0.062                # grid line strength at the top (white mix)
CROSS = 0.040               # extra at each crossing
FADE = (0.30, 0.98)         # the grid fades out slowly between these heights (0..1)

# (center x, center y, radius x, radius y, strength, rgb), all in 0..1 of the image.
# Deep, saturated hues: mixing toward them adds color. Light pastels would wash it gray.
GLOWS = [
    (0.10, -0.10, 0.60, 0.55, 0.060, (40, 62, 112)),    # blue, top left
    (0.95, 1.05, 0.75, 0.80, 0.110, (72, 50, 122)),     # violet, bottom right
    (0.40, 0.95, 0.55, 0.40, 0.060, (28, 78, 96)),      # teal, low middle
]

BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
BAYER = [[(v + 0.5) / 16 - 0.5 for v in row] for row in BAYER]


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def line_weight(p):
    """0..1: how much of a grid line covers pixel p (a triangle 2*HALF+1 px wide)."""
    d = (p + 0.5 - OFFSET) % PITCH
    d = min(d, PITCH - d)
    return max(0.0, 1.0 - d / (HALF + 0.5))


# Gaussians are separable: precompute per-column and per-row factors.
gx = [[math.exp(-(((x / (W - 1)) - g[0]) / g[2]) ** 2) for x in range(W)] for g in GLOWS]
gy = [[math.exp(-(((y / (H - 1)) - g[1]) / g[3]) ** 2) for y in range(H)] for g in GLOWS]
lx = [line_weight(x) for x in range(W)]

raw = bytearray()
for y in range(H):
    t = y / (H - 1)
    k = t ** CURVE
    base = [TOP[c] + (BOTTOM[c] - TOP[c]) * k for c in range(3)]
    grid = LINE * (1 - smoothstep(FADE[0], FADE[1], t))
    ly = line_weight(y)
    rows = [(gy[i][y] * g[4], g[5]) for i, g in enumerate(GLOWS)]
    bay = BAYER[y % 4]
    raw.append(0)  # PNG filter: none
    for x in range(W):
        r, g_, b = base
        for i, (fy, col) in enumerate(rows):
            f = fy * gx[i][x]
            r += (col[0] - r) * f
            g_ += (col[1] - g_) * f
            b += (col[2] - b) * f
        if grid:
            w = lx[x]
            a = grid * max(w, ly) + CROSS * grid / LINE * w * ly
            if a:
                r += (255 - r) * a
                g_ += (255 - g_) * a
                b += (255 - b) * a
        d = bay[x % 4]
        raw += bytes((
            min(255, max(0, int(r + d + 0.5))),
            min(255, max(0, int(g_ + d + 0.5))),
            min(255, max(0, int(b + d + 0.5))),
        ))


def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
png += chunk(b"IEND", b"")
with open(OUT, "wb") as f:
    f.write(png)
print(f"{OUT}: {W}x{H}, {len(png) / 1024:.0f} KB")
