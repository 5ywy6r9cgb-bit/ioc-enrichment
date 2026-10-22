#!/usr/bin/env python3
"""
studio.py — ep05: Ohio Senate money, animated from the filings.

A frame-by-frame motion renderer (PIL + numpy → ffmpeg) for the one thing the card engine cannot do:
animated money flows, counting numbers, kinetic captions, Ken Burns on YOUR OWN photographs, real transitions, and a mixed sound bed.

Rules carried over from the desk:
  * Only GREEN cards (docs/EVIDENCE_CARDS.json) are on screen. Each scene names its card, its register URL, and its caveat.
  * Every figure is a filed amount, or arithmetic shown from filed amounts (verify_cards.py checks the arithmetic before a render).
  * Photographs are your own camera (declared in PHOTOS below); nothing generated is presented as a record.
  * Nothing here is a claim of wrongdoing. Where a card says "a question, not a finding", the screen says so.

Usage:
  python3 studio.py --stills 1.0,5.0,...      write PNG stills at those global seconds into builds/stills/
  python3 studio.py --sheet                   contact sheet of key moments
  python3 studio.py --render builds/ep05.mp4  full render (silent video, then mixed with sound)
"""
import math, sys, os, io, json, hashlib, subprocess, pathlib, argparse
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

HERE = pathlib.Path(__file__).parent
W, H, FPS = 1080, 1920, 30
SAFE_TOP, SAFE_BOT = 300, 1560

# ---------------------------------------------------------------- palette (brand: charcoal / off-white / editorial red / brass)
BG1, BG2 = (17, 19, 27), (8, 9, 13)
INK = (241, 238, 230); MUTED = (143, 150, 164); RED = (214, 52, 52); BRASS = (201, 166, 96)
TEAL = (62, 190, 200); GREEN = (84, 200, 140); DIM = (60, 66, 80); GOLD = (232, 190, 80)

# ---------------------------------------------------------------- fonts
FONTS = {
    "black": "/usr/share/fonts/opentype/inter/InterDisplay-Black.otf",
    "xbold": "/usr/share/fonts/opentype/inter/InterDisplay-ExtraBold.otf",
    "semi": "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf",
    "med": "/usr/share/fonts/opentype/inter/Inter-Medium.otf",
    "reg": "/usr/share/fonts/opentype/inter/Inter-Regular.otf",
    "serif": "/usr/share/fonts/X11/Type1/c0632bt_.pfb",
    "serifi": "/usr/share/fonts/X11/Type1/c0633bt_.pfb",
    "mono": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
}
_fc = {}
def font(k, size):
    key = (k, size)
    if key not in _fc:
        try: _fc[key] = ImageFont.truetype(FONTS[k], size)
        except Exception: _fc[key] = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size)
    return _fc[key]

# ---------------------------------------------------------------- easing
def clamp(x, a=0.0, b=1.0): return a if x < a else b if x > b else x
def prog(t, t0, d): return clamp((t - t0) / d) if d > 0 else (1.0 if t >= t0 else 0.0)
def e_out(p): return 1 - (1 - p) ** 3
def e_expo(p): return 1.0 if p >= 1 else 1 - 2 ** (-10 * p)
def e_io(p): return 4 * p ** 3 if p < .5 else 1 - (-2 * p + 2) ** 3 / 2
def e_back(p):
    c1 = 1.70158; c3 = c1 + 1; return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2
def lerp(a, b, p): return a + (b - a) * p
def money(n): return "${:,.0f}".format(n)

# ---------------------------------------------------------------- drawing helpers
def put_text(img, x, y, s, f, fill=INK, a=1.0, anchor="l", glow=0, track=0, glow_a=1.0):
    """y is the TOP of the text line. anchor l/m/r horizontal. glow = blur radius of a soft halo in the same colour."""
    if a <= 0.003 or not s: return
    if track:
        w = int(sum(f.getlength(c) for c in s) + track * (len(s) - 1))
    else:
        w = int(f.getlength(s))
    pad = int(glow * 3) + 10; hh = int(f.size * 1.45)
    layer = Image.new("RGBA", (w + 2 * pad, hh + 2 * pad), (0, 0, 0, 0)); d = ImageDraw.Draw(layer)
    if track:
        cx = pad
        for c in s: d.text((cx, pad), c, font=f, fill=fill + (255,)); cx += f.getlength(c) + track
    else:
        d.text((pad, pad), s, font=f, fill=fill + (255,))
    if glow:
        g = layer.filter(ImageFilter.GaussianBlur(glow))
        ga = g.getchannel("A").point(lambda v: min(255, int(v * 2.2 * glow_a))); g.putalpha(ga)
        layer = Image.alpha_composite(g, layer)
    if a < 1:
        layer.putalpha(layer.getchannel("A").point(lambda v: int(v * a)))
    px = x - (w / 2 if anchor == "m" else w if anchor == "r" else 0) - pad
    img.paste(layer, (int(px), int(y - pad)), layer)

def text_w(s, f): return f.getlength(s)

def wrap(s, f, maxw):
    words = s.split(); lines = []; cur = ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if f.getlength(t) <= maxw or not cur: cur = t
        else: lines.append(cur); cur = w_
    if cur: lines.append(cur)
    return lines

_spr = {}
def aa_layer(size, fn, ss=3):
    img = Image.new("RGBA", (size[0] * ss, size[1] * ss), (0, 0, 0, 0)); fn(ImageDraw.Draw(img), ss)
    return img.resize(size, Image.LANCZOS)

def rrect(img, box, r=18, fill=None, outline=None, width=2, a=1.0):
    x0, y0, x1, y1 = [int(v) for v in box]; w, h = x1 - x0, y1 - y0
    if w < 2 or h < 2 or a <= 0.003: return
    pad = 4
    def fn(d, ss):
        d.rounded_rectangle([pad * ss, pad * ss, (pad + w) * ss, (pad + h) * ss], radius=r * ss, fill=(fill + (255,)) if fill else None,
                            outline=(outline + (255,)) if outline else None, width=width * ss)
    lay = aa_layer((w + 2 * pad, h + 2 * pad), fn)
    if a < 1: lay.putalpha(lay.getchannel("A").point(lambda v: int(v * a)))
    img.paste(lay, (x0 - pad, y0 - pad), lay)

def circle(img, cx, cy, r, fill, a=1.0):
    key = ("c", int(r * 4), fill)
    if key not in _spr:
        R = max(1, int(math.ceil(r)) + 2)
        _spr[key] = aa_layer((2 * R, 2 * R), lambda d, ss: d.ellipse([2 * ss, 2 * ss, (2 * R - 2) * ss, (2 * R - 2) * ss], fill=fill + (255,)) if False else d.ellipse([(R - r) * ss, (R - r) * ss, (R + r) * ss, (R + r) * ss], fill=fill + (255,)))
    s_ = _spr[key]
    if a < 1:
        s_ = s_.copy(); s_.putalpha(s_.getchannel("A").point(lambda v: int(v * a)))
    img.paste(s_, (int(cx - s_.width / 2), int(cy - s_.height / 2)), s_)

def glow_dot(img, cx, cy, r, col, a=1.0):
    key = ("g", int(r), col)
    if key not in _spr:
        S = int(r * 6); lay = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
        d.ellipse([S / 2 - r, S / 2 - r, S / 2 + r, S / 2 + r], fill=col + (255,))
        g = lay.filter(ImageFilter.GaussianBlur(r * .9)); g.putalpha(g.getchannel("A").point(lambda v: min(255, int(v * 2.0))))
        _spr[key] = Image.alpha_composite(g, lay)
    s_ = _spr[key]
    if a < 1:
        s_ = s_.copy(); s_.putalpha(s_.getchannel("A").point(lambda v: int(v * a)))
    img.paste(s_, (int(cx - s_.width / 2), int(cy - s_.height / 2)), s_)

def bez(p0, p1, p2, p3, s):
    u = 1 - s
    return (u ** 3 * p0[0] + 3 * u * u * s * p1[0] + 3 * u * s * s * p2[0] + s ** 3 * p3[0],
            u ** 3 * p0[1] + 3 * u * u * s * p1[1] + 3 * u * s * s * p2[1] + s ** 3 * p3[1])

# ---------------------------------------------------------------- background, furniture, caption
_bg = {}
def background(T):
    if "base" not in _bg:
        y = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
        a = np.array(BG1, np.float32)[None, None, :]; b = np.array(BG2, np.float32)[None, None, :]
        arr = np.repeat(a * (1 - y) + b * y, W, axis=1)
        im = Image.fromarray(arr.astype(np.uint8), "RGB"); d = ImageDraw.Draw(im, "RGBA")
        for gx in range(0, W, 60): d.line([(gx, 0), (gx, H)], fill=(255, 255, 255, 6))      # ledger grid
        for gy in range(0, H, 60): d.line([(0, gy), (W, gy)], fill=(255, 255, 255, 6))
        _bg["base"] = im
        blob = Image.new("RGBA", (900, 900), (0, 0, 0, 0)); ImageDraw.Draw(blob).ellipse([100, 100, 800, 800], fill=(60, 150, 170, 70))
        _bg["blob"] = blob.filter(ImageFilter.GaussianBlur(120))
        blob2 = Image.new("RGBA", (900, 900), (0, 0, 0, 0)); ImageDraw.Draw(blob2).ellipse([100, 100, 800, 800], fill=(190, 50, 50, 55))
        _bg["blob2"] = blob2.filter(ImageFilter.GaussianBlur(120))
    img = _bg["base"].copy()
    bx = 540 + 260 * math.sin(T * .35); by = 650 + 140 * math.cos(T * .28)
    img.paste(_bg["blob"], (int(bx - 450), int(by - 450)), _bg["blob"])
    cx = 620 + 240 * math.cos(T * .31 + 1); cy = 1100 + 120 * math.sin(T * .4)
    img.paste(_bg["blob2"], (int(cx - 450), int(cy - 450)), _bg["blob2"])
    return img

_lay = {}
def layout(text, fkey, size, maxw):
    key = (text, fkey, size, maxw)
    if key not in _lay:
        f = font(fkey, size); lines = wrap(text, f, maxw); out = []; n = 0
        for ln in lines:
            ws = ln.split(); sp = f.getlength(" "); tot = f.getlength(ln); x = (W - tot) / 2; row = []
            for w_ in ws: row.append((w_, x, n)); x += f.getlength(w_) + sp; n += 1
            out.append(row)
        _lay[key] = (out, n)
    return _lay[key]

def caption(img, t, t0, text, y=1165, wps=3.0, size=50, maxw=940, hold_color=INK):
    """Narration as kinetic type: each word rises and fades in at the pace it is spoken. The newest word is brass."""
    rows, n = layout(text, "serif", size, maxw); f = font("serif", size); lh = int(size * 1.32)
    cur = int((t - t0) * wps)
    for li, row in enumerate(rows):
        for (w_, x, idx) in row:
            ts = t0 + idx / wps
            p = prog(t, ts, .22)
            if p <= 0: continue
            col = BRASS if idx == cur and t < t0 + n / wps + .3 else hold_color
            put_text(img, x, y + li * lh + (1 - e_out(p)) * 16, w_, f, col, a=e_out(p))

def furniture(img, T_global, t, label, idx, total, cav, src, cav_t=1.6, tag=None):
    d = ImageDraw.Draw(img, "RGBA")
    # progress bar (whole video)
    d.rectangle([0, 0, int(W * clamp(T_global / TOTAL)), 7], fill=RED + (255,))
    put_text(img, 70, 318, "THE SENTINEL REPORT", font("semi", 24), MUTED, track=5)
    put_text(img, W - 70, 318, f"{idx:02d} / {total:02d}", font("semi", 24), MUTED, anchor="r", track=3)
    put_text(img, 70, 354, label, font("xbold", 30), BRASS, a=e_out(prog(t, .1, .4)), track=4)
    # caveat strip: the caveat is shown IN FULL (never truncated), source line wrapped under it
    p = e_out(prog(t, cav_t, .5))
    fs = font("mono", 16); sl = wrap(src, fs, 930)[:2] if src else []
    src_h = 21 * len(sl)
    f = font("med", 25); lines = wrap(cav, f, 930) if cav else []
    assert len(lines) <= 5, "caveat too long for the strip: " + cav[:40]
    top = 1556 - src_h - 8 - 30 * len(lines)
    if cav and p > 0:
        d.rectangle([60, top - 14, W - 60, 1556], fill=(0, 0, 0, int(165 * p)))
        d.rectangle([60, top - 14, 66, 1556], fill=RED + (int(255 * p),))
        for i, ln in enumerate(lines): put_text(img, 84, top + i * 30 - 3, ln, f, (232, 228, 218), a=p)
    for i, ln in enumerate(sl):
        put_text(img, 84, 1556 - src_h + i * 21 - 3, ln, fs, (122, 200, 208), a=p if cav else e_out(prog(t, cav_t, .5)))

def stamp(img, t, t0, text, cx, cy, col=BRASS, size=64, rot=-8):
    p = prog(t, t0, .28)
    if p <= 0: return
    f = font("black", size); w = int(f.getlength(text)) + 70; h = int(size * 1.7)
    lay = Image.new("RGBA", (w + 40, h + 40), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
    d.rounded_rectangle([20, 20, 20 + w, 20 + h], radius=10, outline=col + (255,), width=7)
    d.text((20 + 35, 20 + int(size * .22)), text, font=f, fill=col + (255,))
    s = lerp(1.9, 1.0, e_out(p)); lay = lay.rotate(rot, expand=True, resample=Image.BICUBIC)
    lay = lay.resize((int(lay.width * s), int(lay.height * s)), Image.LANCZOS)
    lay.putalpha(lay.getchannel("A").point(lambda v: int(v * clamp(p * 2.2))))
    img.paste(lay, (int(cx - lay.width / 2), int(cy - lay.height / 2)), lay)

def count_text(v, p, fmt):
    return fmt.format(v * e_expo(clamp(p)))

def punch_scale(img, t, t0, amt=.035, dur=.45):
    """a quick scale-pop on the whole frame at an impact"""
    p = prog(t, t0, dur)
    if p <= 0 or p >= 1: return img
    s = 1 + amt * math.sin(math.pi * p) * (1 - p)
    w2, h2 = int(W * s), int(H * s)
    big = img.resize((w2, h2), Image.BICUBIC)
    return big.crop(((w2 - W) // 2, (h2 - H) // 2, (w2 - W) // 2 + W, (h2 - H) // 2 + H))

# ================================================================ SCENES
# every scene: f(t, T) -> RGB image.  t = seconds inside the scene, T = global seconds.
TOTAL = 0.0   # set after the timeline is built

def scene_hook(t, T):
    img = background(T); d = ImageDraw.Draw(img, "RGBA")
    put_text(img, W / 2, 470, "SPENT AGAINST ONE OHIO SENATOR · 2026", font("semi", 27), (225, 190, 190), a=e_out(prog(t, .25, .5)), anchor="m", track=4)
    v = 13471230; p = prog(t, .45, 2.2)
    shake = (1 - prog(t, 2.6, .3)) * (1 if 2.4 < t < 2.9 else 0) * math.sin(t * 90) * 4
    s = count_text(v, p, "${:,.0f}")
    put_text(img, W / 2 + shake, 520, s, font("black", 142), INK, anchor="m", glow=22 if p >= 1 else 8, glow_a=.55)
    put_text(img, W / 2, 690, "against Sherrod Brown", font("serif", 44), (214, 208, 196), a=e_out(prog(t, 2.5, .5)), anchor="m")
    rows = [("AFP Action", 4888349), ("SLF PAC", 4508418), ("Ohio Flyer PAC", 3342670), ("America PAC", 648371), ("Conservative Caucus", 73419), ("Red Senate", 10002)]
    mx = rows[0][1]; y0 = 790
    for i, (n_, a_) in enumerate(rows):
        ps = prog(t, 2.5 + i * .16, .7); y = y0 + i * 64
        if ps <= 0: continue
        put_text(img, 70, y - 2, n_, font("semi", 27), INK, a=e_out(ps))
        put_text(img, W - 70, y - 2, money(a_ * e_out(ps)), font("mono", 25), INK, a=e_out(ps), anchor="r")
        bw = max(4, int(940 * a_ / mx * e_out(ps))); d.rectangle([70, y + 34, 70 + 940, y + 44], fill=(255, 255, 255, 14))
        d.rectangle([70, y + 34, 70 + bw, y + 44], fill=RED + (255,))
        if ps > .9: glow_dot(img, 70 + bw, y + 39, 7, RED, .9)
    put_text(img, W / 2, 1180 - 50, "six committees · 91 expenditures · to within a dollar", font("med", 25), MUTED, a=e_out(prog(t, 4.4, .6)), anchor="m", track=1) if False else None
    caption(img, t, 1.2, "Thirteen point four seven million dollars. Six committees. Every dollar filed with the FEC.", y=1190)
    furniture(img, T, t, "FOLLOW THE MONEY", 1, 7, "Schedule E is complete (3 of 25 pages). The outside-pressure multiple on this card is a CEILING, so it is not shown here. The six committees sum to the total to within a dollar.",
              "SOURCE · FEC fec.gov/data/candidate/S6OH00163 · card BROWN-01 · verified sum", cav_t=4.2)
    return img

_flow = {}
def _curve_layer(key, p0, p1, p2, p3, width, col):
    if key in _flow: return _flow[key]
    x0 = int(min(p0[0], p3[0]) - width - 8); x1 = int(max(p0[0], p3[0]) + width + 8)
    y0 = int(min(p0[1], p3[1]) - width - 8); y1 = int(max(p0[1], p3[1]) + width + 8)
    ss = 3; lay = Image.new("RGBA", ((x1 - x0) * ss, (y1 - y0) * ss), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
    pts = [bez(p0, p1, p2, p3, i / 60) for i in range(61)]
    pts = [((x - x0) * ss, (y - y0) * ss) for x, y in pts]
    d.line(pts, fill=col + (255,), width=int(width * ss), joint="curve")
    lay = lay.resize((x1 - x0, y1 - y0), Image.LANCZOS)
    _flow[key] = (lay, x0, y0); return _flow[key]

def flow_link(img, key, p0, p1, p2, p3, width, col, t, t0, dur, a=.55, particles=True, speed=.35, n=4):
    p = prog(t, t0, dur)
    if p <= 0: return
    lay, x0, y0 = _curve_layer(key, p0, p1, p2, p3, width, col)
    # reveal left → right with a mask that grows
    rev = e_io(p); xr = int(lerp(0, lay.width, rev))
    m = lay.getchannel("A").point(lambda v: int(v * a))
    mask = Image.new("L", lay.size, 0); ImageDraw.Draw(mask).rectangle([0, 0, xr, lay.height], fill=255)
    m = ImageChops.multiply(m, mask)
    img.paste(lay, (x0, y0), m)
    if particles and p >= 1:
        for k in range(n):
            s_ = ((t - t0 - dur) * speed + k / n) % 1.0
            x, y = bez(p0, p1, p2, p3, s_)
            glow_dot(img, x, y, max(3, width * .28), (255, 255, 255) if col != RED else (255, 190, 190), .9)

def box(img, x0, y0, x1, y1, title, sub, col, t, t0, big=False):
    p = e_out(prog(t, t0, .45))
    if p <= 0: return
    dy = (1 - p) * 20
    rrect(img, (x0, y0 + dy, x1, y1 + dy), 16, fill=(24, 28, 38), outline=col, width=3, a=p)
    put_text(img, (x0 + x1) / 2, y0 + dy + 14, title, font("xbold", 26 if not big else 30), INK, a=p, anchor="m")
    if sub: put_text(img, (x0 + x1) / 2, y0 + dy + (y1 - y0) / 2 + 2, sub, font("mono", 21), col if col not in (DIM,) else MUTED, a=p, anchor="m")

def scene_flow(t, T):
    img = background(T)
    put_text(img, W / 2, 440, "ONE COMMITTEE · OHIO FLYER PAC", font("semi", 27), (200, 215, 225), a=e_out(prog(t, .1, .5)), anchor="m", track=4)
    put_text(img, W / 2, 482, money(4459869 * e_expo(prog(t, .3, 1.6))), font("black", 96), INK, anchor="m", glow=12, glow_a=.4)
    put_text(img, W / 2, 598, "two candidates · both Ohio Senate seats · opposite directions", font("med", 24), MUTED, a=e_out(prog(t, 1.6, .6)), anchor="m")
    # nodes
    box(img, 50, 780, 290, 940, "OHIO FLYER", "PAC · $4,459,869", GOLD, t, .5, big=True)
    V = [(700, "STRATEGIC MEDIA", "PLACEMENT INC.", 3244873, RED), (850, "THE STRATEGY GROUP", "FOR MEDIA", 97797, RED), (1000, "MAJORITY", "STRATEGIES", 1117199, TEAL)]
    ys = {0: 715, 1: 865, 2: 1015}
    tx = (700, 1030)
    for i, (yy, n1, n2, amt, col) in enumerate(V):
        y = ys[i]; t0 = 1.6 + i * .35
        wd = max(7, 58 * math.sqrt(amt / 3244873)) if False else max(7, 56 * amt / 3244873)
        flow_link(img, ("a", i), (290, 860), (370, 860), (370, y + 40), (440, y + 40), wd, col, t, t0, .8, a=.55, particles=True, n=3)
        box(img, 440, y, 690, y + 80, n1, None, col, t, t0 + .5)
        put_text(img, 565, y + 46, n2, font("semi", 20), INK, a=e_out(prog(t, t0 + .5, .4)), anchor="m")
        put_text(img, 565, y + 80 + 4, money(amt * e_expo(prog(t, t0 + .6, 1.0))), font("mono", 23), col, a=e_out(prog(t, t0 + .6, .4)), anchor="m")
        tgt_y = 780 if col == RED else 1000
        flow_link(img, ("b", i), (690, y + 40), (780, y + 40), (780, tgt_y + 60), (850, tgt_y + 60), wd, col, t, t0 + 1.2, .8, a=.55, particles=True, n=3)
    box(img, 850, 780, 1030, 920, "AGAINST", "Brown", RED, t, 3.6, big=True)
    put_text(img, 940, 925, money(3342670 * e_expo(prog(t, 4.0, 1.0))), font("mono", 22), RED, a=e_out(prog(t, 4.0, .4)), anchor="m")
    box(img, 850, 1000, 1030, 1110, "FOR", "Husted", TEAL, t, 3.8, big=True)
    put_text(img, 940, 1115, money(1117199 * e_expo(prog(t, 4.2, 1.0))), font("mono", 22), TEAL, a=e_out(prog(t, 4.2, .4)), anchor="m")
    ph = e_out(prog(t, 6.2, .6))
    put_text(img, W / 2, 1140, "None of the three media firms is shared with any Husted committee.", font("semi", 24), (220, 214, 200), a=ph, anchor="m")
    caption(img, t, 1.0, "One committee. Three media firms. Two candidates. The attack money and the support money went to different vendors.", y=1195, size=46)
    furniture(img, T, t, "FOLLOW THE MONEY", 2, 7,
              "Concentration is not intent. A state-focused committee is single-state by design. A shared vendor is not evidence of coordination: the Husted committees share back-office firms, not media firms.",
              "SOURCE · FEC fec.gov/data/committee/C00912865 · cards OH-FLYER-01, PAYEE-01, VENDOR-01 · 3,244,873 + 97,797 = 3,342,670", cav_t=5.2)
    return img

def scene_jfc(t, T):
    img = background(T); d = ImageDraw.Draw(img, "RGBA")
    put_text(img, W / 2, 440, "TEAM HUSTED · JOINT FUNDRAISER", font("semi", 27), (200, 215, 225), a=e_out(prog(t, .1, .5)), anchor="m", track=4)
    put_text(img, W / 2, 482, money(8253532 * e_expo(prog(t, .3, 1.6))), font("black", 110), INK, anchor="m", glow=12, glow_a=.4)
    put_text(img, W / 2, 620, "split five ways", font("serif", 46), (214, 208, 196), a=e_out(prog(t, 1.4, .5)), anchor="m")
    parts = [("HUSTED FOR SENATE", 5215998, RED), ("NRSC", 1129393, GOLD), ("JOBS OPPORTUNITY NOW PAC", 824033, TEAL), ("OHIO FLYER PAC", 604861, GREEN), ("OHIO REPUBLICAN PARTY", 479247, (150, 160, 180))]
    tot = 8253532; x = 70; bw_total = 940; y = 720; bh = 70
    rrect(img, (70, y, 70 + bw_total, y + bh), 10, fill=(255, 255, 255, 0) if False else (30, 34, 46))
    for i, (n_, a_, c_) in enumerate(parts):
        w_ = bw_total * a_ / tot; p = e_io(prog(t, 1.2 + i * .35, .8)); ww = w_ * p
        if ww > 4: d.rectangle([x, y, x + ww - (3 if i < 4 else 0), y + bh], fill=c_ + (255,))
        x += w_
    y2 = 840
    for i, (n_, a_, c_) in enumerate(parts):
        ps = e_out(prog(t, 2.2 + i * .28, .5)); yy = y2 + i * 62 + (1 - ps) * 14
        if ps <= 0: continue
        rrect(img, (70, yy + 10, 94, yy + 34), 5, fill=c_, a=ps)
        put_text(img, 112, yy + 4, n_, font("semi", 27), INK, a=ps)
        put_text(img, W - 70, yy + 4, f"{money(a_ * ps)}  ·  {a_ / tot * 100:.1f}%", font("mono", 24), INK, a=ps, anchor="r")
    put_text(img, W / 2, 1150, "share = amount ÷ $8,253,532 · five recipients equal the total", font("med", 22), MUTED, a=e_out(prog(t, 4.6, .6)), anchor="m")
    caption(img, t, 1.0, "Sixty-three percent went to the candidate's own campaign. About seven percent went to the super PAC.", y=1195, size=46)
    furniture(img, T, t, "FOLLOW THE MONEY", 3, 7, "A transfer is not a gift and not an endorsement. Whether a super PAC may participate in a candidate JFC is a question of FEC rules this desk has NOT answered. Nothing here asserts a violation.",
              "SOURCE · FEC fec.gov/data/committee/C00896928 · card TEAM-HUSTED-01 · 5,215,998 ÷ 8,253,532 = 63.2%", cav_t=4.6)
    return img

def scene_hv(t, T):
    img = background(T)
    put_text(img, W / 2, 440, "HUSTED VICTORY · RAISED $3,636,779", font("semi", 27), (200, 215, 225), a=e_out(prog(t, .1, .5)), anchor="m", track=4)
    pct = 75.8 * e_expo(prog(t, .3, 1.8))
    put_text(img, W / 2, 482, f"{pct:.1f}%", font("black", 190), INK, anchor="m", glow=16, glow_a=.45)
    put_text(img, W / 2, 700, "went to one media firm: SRCP MEDIA INC.", font("serif", 40), (214, 208, 196), a=e_out(prog(t, 1.8, .5)), anchor="m")
    # 10 x 10 coins; 75.8 filled (75 full + 0.8 of the 76th)
    cell = 78; gx = (W - 10 * cell) // 2; gy = 790
    for k in range(100):
        r_, c_ = divmod(k, 10); cx = gx + c_ * cell + cell / 2; cy = gy + r_ * cell * .43 * 1.0 + 0
    gy = 800; rowh = 33
    for k in range(100):
        r_, c_ = divmod(k, 10); cx = gx + c_ * cell + cell / 2; cy = gy + r_ * rowh + rowh / 2
        ts = 1.6 + k * .022; pf = prog(t, ts, .3)
        base_a = e_out(prog(t, .5 + k * .004, .4))
        circle(img, cx, cy, 14, (46, 52, 68), a=base_a)
        if k < 75 and pf > 0: circle(img, cx, cy, 14 * (.6 + .4 * e_back(pf)), GOLD, a=min(1, pf * 1.5))
        if k == 75 and pf > 0:
            circle(img, cx, cy, 14, (46, 52, 68), a=1)
            lay = Image.new("RGBA", (40, 40), (0, 0, 0, 0)); cc = aa_layer((40, 40), lambda d, ss: d.ellipse([6 * ss, 6 * ss, 34 * ss, 34 * ss], fill=GOLD + (255,)))
            cc2 = cc.copy(); cc2.paste((0, 0, 0, 0), (int(6 + 28 * .8), 0, 40, 40)); img.paste(cc2, (int(cx - 20), int(cy - 20)), cc2)
    put_text(img, W / 2, 758, "each coin = 1¢ of every dollar raised", font("med", 22), MUTED, a=e_out(prog(t, 1.2, .5)), anchor="m")
    stamp(img, t, 5.2, "A QUESTION, NOT A FINDING", 540, 1165, BRASS, size=34, rot=-3)
    caption(img, t, 1.2, "Seventy-six cents of every dollar went to a single media firm. The filing does not say why.", y=1225, size=44)
    furniture(img, T, t, "FOLLOW THE MONEY", 4, 7, "A joint fundraiser legitimately pays the COST of raising money. 'MEDIA' does not say whether this is fundraising solicitation or campaign advertising, and the purpose code cannot distinguish them. THIS IS A QUESTION, NOT A FINDING.",
              "SOURCE · FEC fec.gov/data/committee/C00937797 · card HV-01 · 2,755,532 ÷ 3,636,779 = 75.8%", cav_t=3.6)
    return img

def scene_ws(t, T):
    img = background(T)
    put_text(img, W / 2, 440, "FLORIDA 25TH · WASSERMAN SCHULTZ · 2024", font("semi", 27), (200, 215, 225), a=e_out(prog(t, .1, .5)), anchor="m", track=4)
    # 250 red dots (25 x 10) vs one teal dot
    cols, rows_ = 25, 10; sp = 36; gx = (W - (cols - 1) * sp) // 2; gy = 590
    for k in range(250):
        r_, c_ = divmod(k, cols); ts = .5 + (c_ + r_ * .4) * .045; p = prog(t, ts, .35)
        if p > 0: circle(img, gx + c_ * sp, gy + r_ * sp, 11 * (.5 + .5 * e_back(p)), RED, a=min(1, p * 1.6))
    pt = e_out(prog(t, 2.6, .5))
    put_text(img, W / 2, 930, "$98,905 AGAINST  ·  46 expenditures", font("semi", 27), (240, 170, 170), a=pt, anchor="m")
    p1 = prog(t, 3.0, .4)
    if p1 > 0: glow_dot(img, W / 2, 1040, 14 * (.6 + .4 * e_back(p1)), TEAL, 1.0); circle(img, W / 2, 1040, 14 * (.6 + .4 * e_back(p1)), TEAL)
    put_text(img, W / 2, 1066, "$395 FOR  ·  2 expenditures", font("semi", 27), (170, 225, 232), a=e_out(prog(t, 3.2, .5)), anchor="m")
    s = "250 : 1"; n_ = max(1, int(len(s) * e_out(prog(t, 3.6, .7))))
    put_text(img, W / 2, 1090, s[:n_], font("black", 110), INK, anchor="m", glow=14, glow_a=.45) if False else None
    put_text(img, W / 2, 1100 + 0, "", font("reg", 10))
    put_text(img, W / 2, 1112, "98,905 ÷ 395 ≈ 250", font("mono", 22), MUTED, a=e_out(prog(t, 4.0, .5)), anchor="m")
    caption(img, t, 1.0, "About two hundred fifty dollars spent attacking her for every dollar spent defending her.", y=1195, size=46)
    # the ratio as a big stamp-like number at the top right of the grid
    put_text(img, W / 2, 478, s[:n_], font("black", 74), INK, anchor="m", glow=10, glow_a=.4)
    furniture(img, T, t, "FOLLOW THE MONEY", 5, 7, "The SMALLER ratio is often the larger operation — Brown is 10:1 on $13.5m, which is 136x this money. A ratio describes balance, not size.",
              "SOURCE · FEC fec.gov/data/candidate/H4FL20023 · card WS-01 · independent expenditures, 2024 cycle", cav_t=4.0)
    return img

def scene_method(t, T):
    img = background(T); d = ImageDraw.Draw(img, "RGBA")
    put_text(img, W / 2, 440, "HOW WE WORK", font("semi", 27), (200, 215, 225), a=e_out(prog(t, .1, .5)), anchor="m", track=6)
    lines = ["We tried to break", "our own best finding."]
    for i, ln in enumerate(lines):
        p = e_out(prog(t, .3 + i * .45, .6))
        put_text(img, W / 2, 500 + i * 80 + (1 - p) * 24, ln, font("serif", 62), INK, a=p, anchor="m")
    p40 = e_out(prog(t, 2.0, .5))
    put_text(img, W / 2, 740, "40.19×", font("black", 190), (230, 120, 120) if t > 3.4 else INK, a=p40 * (1 - .55 * prog(t, 3.6, .5)), anchor="m", glow=12 if t < 3.4 else 0, glow_a=.4)
    # strike-through
    ps = e_io(prog(t, 3.4, .4))
    if ps > 0:
        wl = font("black", 190).getlength("40.19×"); d.rectangle([W / 2 - wl / 2 - 10, 840, W / 2 - wl / 2 - 10 + (wl + 20) * ps, 856], fill=RED + (255,))
    stamp(img, t, 3.9, "RETRACTED", 800, 712, RED, size=44, rot=-10)
    p135 = e_back(prog(t, 4.6, .6))
    if p135 > 0: put_text(img, W / 2, 960 + (1 - clamp(p135)) * 40, "1.35×", font("black", 160), GREEN, a=clamp(p135), anchor="m", glow=16, glow_a=.5)
    put_text(img, W / 2, 1150, "divided by a truncated $475,873 sample, not the $14,350,624 the committee reported", font("med", 22), MUTED, a=e_out(prog(t, 5.4, .6)), anchor="m")
    caption(img, t, 1.0, "We withdrew our own number. Five times we broke our best finding, and we kept the corrections.", y=1195, size=46)
    furniture(img, T, t, "HOW WE WORK", 6, 7, "Every one was caught by dividing, or by reading the same figure from another register. None was caught by looking harder at the original number.",
              "SOURCE · cards METHOD-02, HUSTED-01 (retraction kept on file) · desk findings 2026-09-09", cav_t=5.0)
    return img

PHOTOS = [  # your own camera. Declared here because the visual policy requires an origin on every photograph.
    ("gahanna_planning.jpg", "own_camera"), ("gahanna_hall.jpg", "own_camera"), ("gahanna_chamber.jpg", "own_camera")]
_ph = {}
def kenburns(i, p, zoom0=1.04, zoom1=1.22, dx=0, dy=0):
    if i not in _ph:
        im = Image.open(HERE / "assets" / PHOTOS[i][0]).convert("RGB"); sc = max(W / im.width, H / im.height) * 1.0
        _ph[i] = im.resize((int(im.width * sc * 1.25), int(im.height * sc * 1.25)), Image.LANCZOS)
    im = _ph[i]; z = lerp(zoom0, zoom1, e_io(p)) / 1.25
    cw, ch = W / z / 1.0 * 1.0 / (im.width / (im.width)), H / z
    cw, ch = min(im.width, W / z * 1.25 / 1.25 * 1.0), min(im.height, H / z * 1.25 / 1.25 * 1.0)
    cw, ch = W / z, H / z
    cw, ch = min(cw, im.width), min(ch, im.height)
    cx = im.width / 2 + dx * (p - .5) * 90; cy = im.height / 2 + dy * (p - .5) * 90
    box_ = (int(cx - cw / 2), int(cy - ch / 2), int(cx + cw / 2), int(cy + ch / 2))
    box_ = (max(0, box_[0]), max(0, box_[1]), min(im.width, max(0, box_[0]) + int(cw)), min(im.height, max(0, box_[1]) + int(ch)))
    return im.crop(box_).resize((W, H), Image.BICUBIC)

def grade(img, k=.55):
    """cooler, darker, slightly desaturated: the photo is the setting, the type is the point"""
    g = ImageChops.multiply(img, Image.new("RGB", img.size, (int(255 * (1 - k * .55)), int(255 * (1 - k * .45)), int(255 * (1 - k * .30)))))
    return Image.blend(g, Image.new("RGB", img.size, (10, 12, 18)), .22)

def scene_close(t, T):
    D = 10.0
    seg = D / 3.0 + .5
    i = min(2, int(t / (D / 3.0)))
    base = kenburns(i, prog(t - i * D / 3.0, 0, D / 3.0 + .6), dx=(1 if i % 2 == 0 else -1), dy=0)
    img = grade(base)
    if i < 2 and t > (i + 1) * D / 3.0 - .5:     # dissolve into the next photo
        q = prog(t, (i + 1) * D / 3.0 - .5, .5)
        nxt = grade(kenburns(i + 1, prog(t - (i + 1) * D / 3.0 + .5, 0, D / 3.0 + .6), dx=(-1 if i % 2 == 0 else 1)))
        img = Image.blend(img, nxt, e_io(q))
    # bottom and top scrims so type always reads
    sc = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(sc)
    for y in range(0, H, 4):
        a = int(210 * clamp((y - 560) / 700)) if y > 560 else int(120 * clamp((420 - y) / 420))
        d.rectangle([0, y, W, y + 4], fill=(6, 8, 12, a))
    img.paste(sc, (0, 0), sc)
    put_text(img, W / 2, 330, "THE SENTINEL REPORT", font("semi", 24), (225, 225, 225), a=e_out(prog(t, .2, .5)), anchor="m", track=6)
    lines = ["Every number here", "is a public record."]
    for k, ln in enumerate(lines):
        p = e_out(prog(t, .6 + k * .5, .7)); put_text(img, W / 2, 640 + k * 90 + (1 - p) * 30, ln, font("serif", 72), INK, a=p, anchor="m", glow=10, glow_a=.3)
    put_text(img, W / 2, 900, "Anyone can pull them. Anyone can check them.", font("med", 30), (225, 222, 212), a=e_out(prog(t, 2.0, .6)), anchor="m")
    p = e_out(prog(t, 3.2, .6))
    for k, ln in enumerate(["fec.gov/data/committee/C00912865", "fec.gov/data/committee/C00896928", "fec.gov/data/committee/C00937797", "fec.gov/data/candidate/S6OH00163"]):
        put_text(img, W / 2, 1010 + k * 40, ln, font("mono", 25), (122, 210, 220), a=e_out(prog(t, 3.2 + k * .25, .5)), anchor="m")
    h = hashlib.sha256((HERE / "data" / "EVIDENCE_CARDS.json").read_bytes()).hexdigest()
    put_text(img, W / 2, 1200, "evidence file SHA-256", font("med", 21), MUTED, a=e_out(prog(t, 5.0, .5)), anchor="m", track=2)
    put_text(img, W / 2, 1232, h[:32], font("mono", 22), (170, 190, 195), a=e_out(prog(t, 5.0, .5)), anchor="m")
    put_text(img, W / 2, 1262, h[32:], font("mono", 22), (170, 190, 195), a=e_out(prog(t, 5.2, .5)), anchor="m")
    ps = e_out(prog(t, 6.4, .8))
    put_text(img, W / 2, 1340, "Spread truth — but make sure it is truth.", font("serifi", 44), BRASS, a=ps, anchor="m", glow=8, glow_a=.35)
    put_text(img, W / 2, 1520, "Photos: The Sentinel Report, Gahanna Civic Center (own camera) · figures verified to FEC filings listed above", font("reg", 19), (170, 170, 170), a=.8 * e_out(prog(t, 1.0, .6)), anchor="m")
    d2 = ImageDraw.Draw(img, "RGBA"); d2.rectangle([0, 0, int(W * clamp(T / TOTAL)), 7], fill=RED + (255,))
    return img

# ---------------------------------------------------------------- timeline + transitions
# (name, function, duration seconds, transition INTO this scene, overlap seconds)
SCENES = [("hook", scene_hook, 7.0, None, 0), ("flow", scene_flow, 11.0, "push", .55), ("jfc", scene_jfc, 9.0, "wipe", .55),
          ("hv", scene_hv, 9.0, "zoom", .5), ("ws", scene_ws, 8.0, "glitch", .45), ("method", scene_method, 9.0, "dip", .6), ("close", scene_close, 10.0, "iris", .7)]
def timeline():
    t = 0.0; out = []
    for name, fn, dur, tr, ov in SCENES:
        start = t - (ov if tr else 0); out.append(dict(name=name, fn=fn, start=start, dur=dur, end=start + dur, trans=tr, ov=ov)); t = start + dur
    return out, t
TL, TOTAL = timeline()

def transition(a, b, p, kind):
    p = clamp(p)
    if kind == "push":                                  # the new scene pushes the old one up, with a soft blur on the leaving edge
        q = e_io(p); off = int(H * q)
        out = Image.new("RGB", (W, H)); out.paste(a, (0, -off)); out.paste(b, (0, H - off)); return out
    if kind == "wipe":                                  # diagonal wipe with a red edge
        q = e_io(p); m = Image.new("L", (W, H), 0); d = ImageDraw.Draw(m)
        k = (W + H) * q; d.polygon([(0, 0), (k, 0), (k - H, H), (0, H)] if k > H else [(0, 0), (k, 0), (0, k)], fill=255) if False else None
        xs = int(-H * .35 + (W + H * .35) * q)
        d.polygon([(0, 0), (xs + int(H * .35), 0), (xs, H), (0, H)], fill=255)
        out = b.copy(); out.paste(a, (0, 0), ImageChops.invert(m)) if False else None
        out = a.copy(); out.paste(b, (0, 0), m)
        e = ImageDraw.Draw(out); e.line([(xs + int(H * .35), 0), (xs, H)], fill=RED, width=8); return out
    if kind == "zoom":                                  # push through the old frame into the new one
        q = e_io(p)
        if q < .5:
            s = 1 + .35 * (q * 2) ** 2; w2, h2 = int(W * s), int(H * s); z = a.resize((w2, h2), Image.BILINEAR).crop(((w2 - W) // 2, (h2 - H) // 2, (w2 - W) // 2 + W, (h2 - H) // 2 + H))
            return Image.blend(z, Image.new("RGB", (W, H), (240, 238, 230)), (q * 2) ** 3 * .55)
        s = 1.25 - .25 * ((q - .5) * 2); w2, h2 = int(W * s), int(H * s); z = b.resize((w2, h2), Image.BILINEAR).crop(((w2 - W) // 2, (h2 - H) // 2, (w2 - W) // 2 + W, (h2 - H) // 2 + H))
        return Image.blend(z, Image.new("RGB", (W, H), (240, 238, 230)), (1 - (q - .5) * 2) ** 3 * .55)
    if kind == "glitch":                                # RGB split and horizontal slice jitter, cut at the midpoint
        src = a if p < .5 else b; arr = np.asarray(src).copy(); amp = int(46 * math.sin(math.pi * p))
        rng = np.random.default_rng(int(p * 1000))
        for _ in range(9):
            y0 = int(rng.integers(0, H - 80)); hh = int(rng.integers(20, 110)); sh = int(rng.integers(-amp, amp + 1)) if amp else 0
            arr[y0:y0 + hh] = np.roll(arr[y0:y0 + hh], sh, axis=1)
        arr[:, :, 0] = np.roll(arr[:, :, 0], amp, axis=1); arr[:, :, 2] = np.roll(arr[:, :, 2], -amp, axis=1)
        return Image.fromarray(arr)
    if kind == "dip":                                   # dip through black
        q = p * 2
        return Image.blend(a, Image.new("RGB", (W, H), (0, 0, 0)), clamp(q)) if p < .5 else Image.blend(Image.new("RGB", (W, H), (0, 0, 0)), b, clamp(q - 1))
    if kind == "iris":                                  # circular reveal from the centre
        q = e_io(p); r = int(math.hypot(W, H) / 2 * q); m = Image.new("L", (W, H), 0)
        ImageDraw.Draw(m).ellipse([W / 2 - r, H / 2 - r, W / 2 + r, H / 2 + r], fill=255)
        out = a.copy(); out.paste(b, (0, 0), m)
        if 0 < r < 900: ImageDraw.Draw(out).ellipse([W / 2 - r, H / 2 - r, W / 2 + r, H / 2 + r], outline=BRASS, width=6)
        return out
    return b

# ---------------------------------------------------------------- final look: vignette + film grain
_post = {}
def post(img, frame_no):
    if "vig" not in _post:
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32); r = np.sqrt(((xx - W / 2) / (W * .75)) ** 2 + ((yy - H / 2) / (H * .72)) ** 2)
        _post["vig"] = (1 - .38 * np.clip(r, 0, 1.2) ** 2.2)[..., None].astype(np.float32)
        rng = np.random.default_rng(7); _post["grain"] = [rng.normal(0, 5.0, (H, W, 1)).astype(np.float32) for _ in range(6)]
    arr = np.asarray(img, dtype=np.float32) * _post["vig"] + _post["grain"][frame_no % 6]
    return np.clip(arr, 0, 255).astype(np.uint8)

def frame_at(T, n=0):
    cur = [s for s in TL if s["start"] <= T < s["end"] or (s is TL[-1] and T >= s["start"])]
    s = cur[-1] if cur else TL[-1]
    img = s["fn"](clamp(T - s["start"], 0, s["dur"]), T)
    if s["trans"] and T < s["start"] + s["ov"]:                 # inside the overlap: blend with the previous scene
        prev = TL[TL.index(s) - 1]
        a = prev["fn"](clamp(T - prev["start"], 0, prev["dur"]), T)
        img = transition(a, img, (T - s["start"]) / s["ov"], s["trans"])
    # a small punch on the big reveals
    for t0 in IMPACTS:
        if t0 <= T < t0 + .5: img = punch_scale(img, T, t0, .03)
    return post(img, n)

IMPACTS = []   # filled from sound cues below
def cues():
    c = {"impacts": [], "whooshes": [], "ticks": [], "risers": []}
    st = {s["name"]: s["start"] for s in TL}
    c["impacts"] += [st["hook"] + 2.65, st["hv"] + 5.2 + .05, st["method"] + 3.9 + .05, st["method"] + 4.6 + .1]
    for s in TL:
        if s["trans"]: c["whooshes"].append((s["start"], s["ov"], s["trans"]))
    c["ticks"] += [(st["hook"] + .45, 2.2), (st["flow"] + .3, 1.6), (st["jfc"] + .3, 1.6)]
    c["risers"] += [(st["method"] + 2.9, 1.0), (st["close"] - .9, .9)]
    return c
CUES = cues(); IMPACTS[:] = [x for x in CUES["impacts"]]

# ---------------------------------------------------------------- sound design (numpy, no samples, no licensing)
SR = 44100
def synth_audio(total):
    n = int(total * SR); L = np.zeros(n, np.float32); R = np.zeros(n, np.float32); tt = np.arange(n) / SR
    rng = np.random.default_rng(3)
    def add(sig, t0, gain=1.0, pan=0.0):
        i0 = int(t0 * SR); i1 = min(n, i0 + len(sig))
        if i0 >= n or i1 <= i0: return
        s_ = sig[:i1 - i0] * gain; L[i0:i1] += s_ * (1 - max(0, pan)); R[i0:i1] += s_ * (1 + min(0, pan))
    def lowpass(x, fc):
        a = math.exp(-2 * math.pi * fc / SR); y = np.empty_like(x); acc = 0.0
        for i in range(len(x)): acc = (1 - a) * x[i] + a * acc; y[i] = acc
        return y
    # --- pad: a slow minor progression (Am  F  C  G), detuned saw-ish stacks, ~7.5 s per chord, gently swelling
    chords = [(110.0, 130.81, 164.81), (87.31, 130.81, 174.61), (130.81, 164.81, 196.0), (98.0, 123.47, 146.83)]
    pad = np.zeros(n, np.float32); seg = 7.5
    for k in range(int(total / seg) + 2):
        t0 = k * seg; ch = chords[k % 4]; i0 = int(t0 * SR); ln = int((seg + 3.0) * SR); t_ = np.arange(min(ln, n - i0)) / SR if i0 < n else None
        if t_ is None or len(t_) == 0: continue
        env = np.minimum(1, t_ / 2.5) * np.minimum(1, (seg + 3.0 - t_) / 3.0)
        v = np.zeros(len(t_), np.float32)
        for f0 in ch:
            for det in (-0.9, 0.0, 1.1):
                f = f0 * (1 + det / 600.0)
                for h_ in range(1, 6): v += (np.sin(2 * math.pi * f * h_ * t_ + h_) / h_ ** 1.4).astype(np.float32)
        pad[i0:i0 + len(t_)] += v * env.astype(np.float32) * .018
    pad = lowpass(pad, 1400); L += pad * 1.0; R += np.roll(pad, 90) * 1.0
    # --- low heartbeat pulse at 62 bpm
    bpm = 62; beat = 60 / bpm
    for k in range(int(total / beat)):
        t_ = np.arange(int(.45 * SR)) / SR; f = 46 + 40 * np.exp(-t_ * 18)
        s_ = (np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t_ * 7.5)).astype(np.float32)
        add(s_, k * beat, .17 if k % 2 == 0 else .11)
    # --- soft hi-frequency ticks (every half beat) to give the bed a pulse
    for k in range(int(total / (beat / 2))):
        t_ = np.arange(int(.03 * SR)) / SR; s_ = (rng.normal(0, 1, len(t_)) * np.exp(-t_ * 240)).astype(np.float32); add(s_, k * beat / 2, .012, pan=.3 if k % 2 else -.3)
    # --- counter ticks
    for t0, dur in CUES["ticks"]:
        k = 0; t = 0.0
        while t < dur:
            rate = lerp(26, 6, clamp(t / dur)); t_ = np.arange(int(.012 * SR)) / SR
            add((np.sin(2 * math.pi * 2400 * t_) * np.exp(-t_ * 420)).astype(np.float32), t0 + t, .05); t += 1 / rate
    # --- whooshes at each transition (band-passed noise sweeping up)
    for t0, ov, kind in CUES["whooshes"]:
        ln = int((ov + .35) * SR); t_ = np.arange(ln) / SR; nz = rng.normal(0, 1, ln).astype(np.float32)
        a = lowpass(nz, 4200) - lowpass(nz, 500 + 1800 * (t_ / t_[-1]).mean()); env = np.sin(np.pi * np.clip(t_ / t_[-1], 0, 1)) ** 2
        add((a * env).astype(np.float32), t0 - .1, .55 if kind != "dip" else .3, pan=-.2 if kind in ("push", "wipe") else .2)
    # --- impacts
    for t0 in CUES["impacts"]:
        t_ = np.arange(int(1.4 * SR)) / SR; f = 38 + 110 * np.exp(-t_ * 9)
        s_ = (np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t_ * 3.2)).astype(np.float32)
        nz = lowpass(rng.normal(0, 1, len(t_)).astype(np.float32), 900) * np.exp(-t_ * 9).astype(np.float32)
        add(s_ * .9 + nz * .35, t0, .6)
    # --- risers into the retraction and into the close
    for t0, dur in CUES["risers"]:
        ln = int(dur * SR); t_ = np.arange(ln) / SR; f = 220 * 2 ** (t_ / dur * 2.2)
        s_ = (np.sin(2 * math.pi * np.cumsum(f) / SR) * (t_ / dur) ** 2).astype(np.float32)
        nz = (lowpass(rng.normal(0, 1, ln).astype(np.float32), 5000) * (t_ / dur) ** 3).astype(np.float32)
        add(s_ * .10 + nz * .12, t0, 1.0)
    out = np.stack([L, R], 1)
    fade = np.minimum(1, np.minimum(tt / .8, (total - tt) / 1.6)).astype(np.float32)[:, None]; out *= fade
    pk = float(np.max(np.abs(out)) or 1); out = out / pk * .70
    return (out * 32767).astype(np.int16)

def write_wav(path, pcm):
    import wave
    with wave.open(str(path), "wb") as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

# ---------------------------------------------------------------- CLI
def _render_one(i): return i, frame_at(i / FPS, i).tobytes()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--stills"); ap.add_argument("--sheet", action="store_true"); ap.add_argument("--render"); ap.add_argument("--audio-only", action="store_true")
    a = ap.parse_args(); b = HERE / "builds"; b.mkdir(exist_ok=True)
    print(f"timeline: {TOTAL:.1f}s · " + " · ".join(f"{s['name']} {s['start']:.1f}-{s['end']:.1f}" for s in TL))
    if a.stills:
        (b / "stills").mkdir(exist_ok=True)
        for tok in a.stills.split(","):
            T = float(tok); Image.fromarray(frame_at(T, 0)).save(b / "stills" / f"t{T:06.2f}.png")
        print("stills ->", b / "stills")
    if a.sheet:
        times = []
        for s in TL: times += [s["start"] + min(s["dur"] - .1, x) for x in (1.0, 3.0, s["dur"] * .8)]
        W2, H2 = 270, 480; cols = 7; rows = (len(times) + cols - 1) // cols; sh = Image.new("RGB", (W2 * cols, H2 * rows))
        for k, T in enumerate(times): sh.paste(Image.fromarray(frame_at(T, 0)).resize((W2, H2), Image.LANCZOS), ((k % cols) * W2, (k // cols) * H2))
        sh.save(b / "sheet05.png"); print("sheet ->", b / "sheet05.png")
    if a.audio_only or a.render:
        print("mixing sound ..."); pcm = synth_audio(TOTAL + .5); wav = b / "ep05.bed.wav"; write_wav(wav, pcm)
    if a.render:
        import multiprocessing as mp
        out = pathlib.Path(a.render); silent = b / "ep05.silent.mp4"; nfr = int(TOTAL * FPS)
        ff = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
                               "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(silent)], stdin=subprocess.PIPE)
        with mp.Pool(2) as pool:
            for k, (i, buf) in enumerate(pool.imap(_render_one, range(nfr), chunksize=4)):
                ff.stdin.write(buf)
                if k % 90 == 0: print(f"  frame {k}/{nfr}", flush=True)
        ff.stdin.close(); ff.wait()
        subprocess.check_call(["ffmpeg", "-y", "-v", "error", "-i", str(silent), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(out)])
        print("->", out)

if __name__ == "__main__":
    main()
