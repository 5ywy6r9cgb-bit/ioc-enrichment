#!/usr/bin/env python3
"""
om_motifs.py — surveillance iconography for The Sentinel Report.

Every icon is DRAWN, not sourced. No stock photos, no licensing questions, no
"where did this image come from" at a hearing. Line art in brand ink, rendered
at whatever size the frame needs.

Design intent: these sit BEHIND the story at low contrast, the way a newspaper
uses a tinted illustration behind a feature. They must never compete with a
number or a document. If you can read the icon before you read the headline,
the icon is too strong.

    flock_camera   the ALPR unit: housing, lens, solar panel, pole
    drone          quadcopter, top-down
    dome_camera    the ceiling dome
    signal         broadcast arcs — data leaving the device
"""
from __future__ import annotations

import math
from PIL import Image, ImageDraw


def _blend(bg, fg, k):
    """k=0 -> background, k=1 -> full foreground colour."""
    return tuple(int(round(b + (f - b) * k)) for b, f in zip(bg, fg))


def flock_camera(d: ImageDraw.ImageDraw, x: int, y: int, s: float, col, w: int = 3):
    """ALPR camera on a pole with solar panel. s = overall scale in px (height)."""
    # pole
    d.line([(x, y), (x, y + int(s * 0.62))], fill=col, width=w)
    # housing (the camera box) — slight wedge, lens end lower-left
    bw, bh = s * 0.40, s * 0.19
    bx, by = x - bw * 0.5, y - bh
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=int(s * 0.03),
                        outline=col, width=w)
    # lens
    lr = s * 0.05
    lcx, lcy = bx + bw * 0.16, by + bh * 0.5
    d.ellipse([lcx - lr, lcy - lr, lcx + lr, lcy + lr], outline=col, width=w)
    # solar panel above, angled
    px0, py0 = x - s * 0.24, by - s * 0.13
    px1, py1 = x + s * 0.30, by - s * 0.05
    d.line([(px0, py0), (px1, py1)], fill=col, width=w)
    d.line([(x, by), (x + s * 0.03, py1 - s * 0.005)], fill=col, width=max(1, w - 1))
    # mounting arm
    d.line([(x, by + bh), (x, by + bh + s * 0.04)], fill=col, width=w)


def drone(d: ImageDraw.ImageDraw, x: int, y: int, s: float, col, w: int = 3):
    """Quadcopter, top-down. s = rotor-tip to rotor-tip."""
    body = s * 0.14
    d.rounded_rectangle([x - body, y - body * 0.72, x + body, y + body * 0.72],
                        radius=int(s * 0.03), outline=col, width=w)
    arm = s * 0.42
    rr = s * 0.15
    for ax, ay in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        ex, ey = x + ax * arm * 0.72, y + ay * arm * 0.60
        d.line([(x + ax * body * 0.7, y + ay * body * 0.5), (ex, ey)],
               fill=col, width=w)
        d.ellipse([ex - rr, ey - rr * 0.55, ex + rr, ey + rr * 0.55],
                  outline=col, width=max(1, w - 1))
    # downward camera gimbal
    d.ellipse([x - s * 0.045, y - s * 0.045, x + s * 0.045, y + s * 0.045],
              outline=col, width=w)


def dome_camera(d: ImageDraw.ImageDraw, x: int, y: int, s: float, col, w: int = 3):
    """Ceiling dome. s = width."""
    d.line([(x - s * 0.5, y), (x + s * 0.5, y)], fill=col, width=w)
    d.arc([x - s * 0.42, y - s * 0.02, x + s * 0.42, y + s * 0.80],
          start=0, end=180, fill=col, width=w)
    d.ellipse([x - s * 0.10, y + s * 0.26, x + s * 0.10, y + s * 0.46],
              outline=col, width=max(1, w - 1))


def signal(d: ImageDraw.ImageDraw, x: int, y: int, s: float, col, w: int = 3,
           arcs: int = 3, direction: str = "up"):
    """Broadcast arcs — the data leaving the device. This is the editorial point
    of the whole series, so it earns its own mark."""
    for i in range(1, arcs + 1):
        r = s * 0.18 * i
        box = [x - r, y - r, x + r, y + r]
        if direction == "up":
            d.arc(box, start=215, end=325, fill=col, width=w)
        else:
            d.arc(box, start=35, end=145, fill=col, width=w)
    d.ellipse([x - s * 0.03, y - s * 0.03, x + s * 0.03, y + s * 0.03], fill=col)


ICONS = {"flock_camera": flock_camera, "drone": drone,
         "dome_camera": dome_camera, "signal": signal}


def draw_motif(img: Image.Image, kind: str, placements, paper, ink,
               strength: float = 0.16):
    """Draw icons onto a copy of img at low contrast.

    placements: list of (x_frac, y_frac, scale_frac) in 0..1 of frame width.
    strength:   0.10 barely there · 0.20 clearly visible · above 0.28 competes.
    """
    if kind == "none" or not placements:
        return img
    W, H = img.size
    col = _blend(paper, ink, strength)
    layer = img.copy()
    d = ImageDraw.Draw(layer)
    for p in placements:
        xf, yf, sf = p[0], p[1], p[2]
        k = p[3] if len(p) > 3 else kind
        fn = ICONS.get(k)
        if fn is None:
            continue
        fn(d, int(xf * W), int(yf * H), sf * W, col,
           w=max(2, int(sf * W * 0.022)))
    return layer


# Preset arrangements. Chosen so nothing lands in the centre text column.
PRESETS = {
    # a lone camera watching from the upper right — for title cards
    "watchtower": [(0.84, 0.20, 0.20, "flock_camera")],
    # a row along the bottom, like poles receding down a street
    "the_row": [(0.13, 0.90, 0.13, "flock_camera"),
                (0.36, 0.905, 0.115, "flock_camera"),
                (0.58, 0.91, 0.10, "flock_camera"),
                (0.79, 0.915, 0.085, "flock_camera")],
    # drones in formation, upper corners
    "patrol": [(0.17, 0.17, 0.17, "drone"), (0.83, 0.235, 0.13, "drone")],
    # camera plus the signal it sends — the thesis of the series
    "uplink": [(0.16, 0.235, 0.17, "flock_camera"),
               (0.16, 0.10, 0.16, "signal")],
    # sparse mixed field for closing cards
    "the_network": [(0.13, 0.16, 0.12, "flock_camera"),
                    (0.87, 0.22, 0.13, "drone"),
                    (0.20, 0.88, 0.11, "dome_camera"),
                    (0.83, 0.86, 0.115, "flock_camera")],
    "none": [],
}


def self_test() -> int:
    print("=== SELF-TEST: motifs ===")
    fails = ran = 0

    def check(label, ok):
        nonlocal fails, ran
        ran += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        fails += (not ok)

    import numpy as np
    paper, ink = (233, 235, 238), (18, 22, 28)

    for name, fn in ICONS.items():
        img = Image.new("RGB", (400, 400), paper)
        d = ImageDraw.Draw(img)
        fn(d, 200, 200, 240, (0, 0, 0), 3)
        a = np.array(img)
        drew = (a.sum(axis=2) < 600).sum()
        check(f"{name}: draws visible geometry", drew > 200)
        # must stay inside its own box, not bleed to frame edge
        ink_mask = (a.sum(axis=2) < 600)
        edge = ink_mask[0, :].any() or ink_mask[-1, :].any() or \
            ink_mask[:, 0].any() or ink_mask[:, -1].any()
        check(f"{name}: stays within bounds", not edge)

    base = Image.new("RGB", (1080, 1920), paper)
    out = draw_motif(base, "flock_camera", PRESETS["watchtower"], paper, ink, 0.16)
    a0, a1 = np.array(base).astype(int), np.array(out).astype(int)
    delta = np.abs(a1 - a0).sum(axis=2)
    changed = (delta > 0).sum()
    check(f"motif actually draws ({changed} px changed)", changed > 500)
    # measured on the pixels it TOUCHES — averaging over 2M pixels hides everything
    touched = delta[delta > 0].mean() if changed else 0
    check(f"motif ink is present but restrained (delta {touched:.0f}, 20-200)",
          20 < touched < 200)

    strong = draw_motif(base, "flock_camera", PRESETS["watchtower"], paper, ink, 0.30)
    ds = np.abs(np.array(strong).astype(int) - a0).sum(axis=2)
    check("strength parameter increases contrast",
          ds[ds > 0].mean() > touched)

    # the centre text column must stay clean on every preset
    for pname, pl in PRESETS.items():
        if not pl:
            continue
        o = draw_motif(base, "mixed", pl, paper, ink, 0.16)
        arr = np.abs(np.array(o).astype(int) - a0).sum(axis=2)
        centre = arr[int(1920 * 0.34):int(1920 * 0.62), int(1080 * 0.10):int(1080 * 0.90)]
        check(f"preset '{pname}' keeps the headline band clear", centre.max() < 5)

    check("'none' returns the frame untouched",
          np.array_equal(np.array(draw_motif(base, "none", [], paper, ink)), a0))

    print(f"\nSelf-test: {ran - fails}/{ran} behaved correctly.")
    return 1 if fails else 0


if __name__ == "__main__":
    import sys
    sys.exit(self_test())
