#!/usr/bin/env python3
"""
openmontage.py v0.3 — The Sentinel Report montage engine.

A general video renderer. It knows HOW to draw scenes; it does not know the
story. The story lives in an external spec (teaser.json). Scenes in, MP4 out,
plus a build manifest proving exactly which files produced which video.

    python3 openmontage.py --spec teaser.json --out builds/teaser.mp4
    python3 openmontage.py --spec teaser.json --dry-run
    python3 openmontage.py --spec teaser.json --contact-sheet sheet.png
    python3 openmontage.py --self-test

Design rules:
  * The engine never mutates the spec. resolve_scene() returns copies.
  * Everything is validated before ffmpeg is launched. Fail early, fail clearly.
  * Assets and fonts load once, not per frame.
  * Every render emits a manifest: input hashes, output hash, versions.
    If the video claims "hash-verified," the build process enforces it.

WHAT v0.3 CHANGED
  * Colour, type, presets and safe zones come from brand.py. Font paths are
    RESOLVED per machine instead of hardcoded to Linux — before this, the
    engine could not render on macOS at all, which is the platform the
    installer targets. It failed in preflight with "font missing".
  * Safe zones are ENFORCED, not merely drawable. `--check-safe` fails a build
    whose content sits where the platform's own UI will cover it.
  * Per-scene crossfade: a scene may set "xfade" to override the global value,
    including 0 for a hard cut.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import brand

VERSION = "0.3.0"
SPEC_VERSION = "OPENMONTAGE-SPEC/1"

REQUIRED = {
    "title":  ["dur", "title"],
    "bignum": ["dur", "value", "caption"],
    "vchart": ["dur", "data", "caption"],
    "chart":  ["dur", "image", "caption"],
    "hash":   ["dur", "title", "hash", "cta"],
}


class SpecError(Exception):
    """Raised for any invalid spec, asset, or data problem. Always fatal, always clear."""


# ----------------------------------------------------------------- helpers
@lru_cache(maxsize=256)
def font(key: str, size: int) -> ImageFont.FreeTypeFont:
    """Type roles resolve through brand.py, so a face missing on this machine
    is a brand error carrying the fix — not a stack trace from inside Pillow."""
    return ImageFont.truetype(brand.font_path(key), max(8, int(size)))


def ease(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * t * (t * (t * 6 - 15) + 10)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def wrap(draw, text: str, fnt, maxw: int) -> list[str]:
    lines, cur = [], ""
    for w_ in str(text).split():
        trial = (cur + " " + w_).strip()
        if draw.textlength(trial, font=fnt) <= maxw or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def fit(draw, text: str, key: str, size: int, maxw: int, maxh: int,
        min_size: int = 24) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    """Shrink until the wrapped block fits its box. A long title must not break a scene."""
    while size >= min_size:
        f = font(key, size)
        lines = wrap(draw, text, f, maxw)
        bb = f.getbbox("Ag")
        if len(lines) * int((bb[3] - bb[1]) * 1.22) <= maxh:
            return f, lines
        size -= 6
    f = font(key, min_size)
    return f, wrap(draw, text, f, maxw)


def draw_center(draw, lines, fnt, y: int, fill, w: int, lh: float = 1.22) -> int:
    """Returns the y just past the block, so callers never guess line heights."""
    bb = fnt.getbbox("Ag")
    line_h = int((bb[3] - bb[1]) * lh)
    for i, ln in enumerate(lines):
        tw = draw.textlength(ln, font=fnt)
        draw.text(((w - tw) / 2, y + i * line_h), ln, font=fnt, fill=fill)
    return y + len(lines) * line_h


def chunk_hash(h: str, n: int = 16) -> list[str]:
    return [h[i:i + n] for i in range(0, len(h), n)]


# ----------------------------------------------------------------- context
class Ctx:
    def __init__(self, preset: dict, theme: dict, footer: str, guides: bool = False):
        self.W, self.H, self.FPS = preset["w"], preset["h"], preset["fps"]
        self.safe = preset["safe"]
        self.t = theme
        self.footer = footer
        self.guides = guides
        self.s = self.H / 1920.0            # type scale, so presets stay proportional

    def fs(self, size: int) -> int:
        return max(10, int(size * self.s))

    def base_frame(self) -> Image.Image:
        img = Image.new("RGB", (self.W, self.H), self.t["paper"])
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, self.W, self.fs(10)], fill=self.t["accent"])
        if self.footer:
            fh = self.fs(88)
            d.rectangle([0, self.H - fh, self.W, self.H], fill=self.t["footer_bg"])
            f = font("mono", self.fs(26))
            tw = d.textlength(self.footer, font=f)
            d.text(((self.W - tw) / 2, self.H - fh + self.fs(26)), self.footer,
                   font=f, fill=self.t["footer_fg"])
        if self.guides:
            for y in (self.safe["top"], self.safe["bottom"]):
                d.line([(0, y), (self.W, y)], fill=(255, 0, 255), width=2)
            for x in (self.safe["left"], self.safe["right"]):
                d.line([(x, 0), (x, self.H)], fill=(255, 0, 255), width=2)
        return img

    def kicker(self, d, text: str, y: int, fill=None):
        """Letter-spaced eyebrow, fitted to the frame.

        The kicker is set at a fixed size with wide tracking, which looks right
        for a short word and runs clean off both edges for anything longer —
        "VALIDATED BEFORE FFMPEG STARTS" rendered as "TED BEFORE FFMPEG". Try
        progressively tighter tracking, then smaller type, and stop at the
        first combination that fits. Returns the drawn width so the caller (and
        the self-test) can check it.
        """
        maxw = self.W - self.fs(80)
        words = str(text).upper().split()
        if not words:
            return 0
        for size in (34, 31, 28, 25, 22, 19):
            for gap_in, gap_out in (("  ", "     "), (" ", "   "), ("", "  ")):
                f = font("mono_b", self.fs(size))
                spaced = gap_out.join(gap_in.join(list(w)) for w in words)
                tw = d.textlength(spaced, font=f)
                if tw <= maxw:
                    d.text(((self.W - tw) / 2, y), spaced, font=f,
                           fill=fill or self.t["accent"])
                    return tw
        # last resort: smallest type, no tracking at all
        f = font("mono_b", self.fs(19))
        spaced = " ".join(words)
        tw = d.textlength(spaced, font=f)
        d.text(((self.W - tw) / 2, y), spaced, font=f, fill=fill or self.t["accent"])
        return tw

    def scanline(self, img, t: float):
        d = ImageDraw.Draw(img)
        y = int(self.H * (0.08 + 0.84 * t))
        d.line([(60, y), (self.W - 60, y)], fill=self.t["accent"], width=2)
        d.rectangle([56, y - 4, 68, y + 4], fill=self.t["accent"])


# ----------------------------------------------------------------- scenes
def scene_title(t, s, ctx):
    img = ctx.base_frame()
    d = ImageDraw.Draw(img)
    ctx.kicker(d, s.get("kick", ""), ctx.fs(560))
    f, lines = fit(d, s["title"], "serif_b", ctx.fs(108), ctx.W - ctx.fs(160), ctx.fs(430))
    y = draw_center(d, lines, f, ctx.fs(700) - int(ctx.fs(30) * (1 - ease(t * 2.2))),
                    ctx.t["ink"], ctx.W)
    if s.get("sub"):
        f2 = font("mono", ctx.fs(40))
        draw_center(d, wrap(d, s["sub"], f2, ctx.W - ctx.fs(220)), f2,
                    y + ctx.fs(60), ctx.t["muted"], ctx.W)
    ctx.scanline(img, t)
    return img


def scene_bignum(t, s, ctx):
    img = ctx.base_frame()
    d = ImageDraw.Draw(img)
    ctx.kicker(d, s.get("kick", ""), ctx.fs(470))
    val = s["value"]
    mode = s.get("animation", "countup" if isinstance(val, (int, float)) else "fade")
    if isinstance(val, (int, float)) and mode == "countup":
        txt = s.get("fmt", "{:,.0f}").format(val * ease(min(1.0, t * 1.6)))
    elif mode == "typewriter":
        txt = str(val)[:max(1, int(len(str(val)) * min(1.0, t * 2.2)))]
    else:
        txt = str(val)
    f = font("sans_b", ctx.fs(s.get("size", 230)))
    tw = d.textlength(txt, font=f)
    d.text(((ctx.W - tw) / 2, ctx.fs(620)), txt, font=f, fill=s.get("_color", ctx.t["ink"]))
    f2, lines = fit(d, s["caption"], "serif_b", ctx.fs(62), ctx.W - ctx.fs(180), ctx.fs(260))
    y = draw_center(d, lines, f2, ctx.fs(950), ctx.t["ink"], ctx.W)
    if s.get("sub"):
        f3 = font("mono", ctx.fs(36))
        draw_center(d, wrap(d, s["sub"], f3, ctx.W - ctx.fs(220)), f3,
                    y + ctx.fs(50), ctx.t["muted"], ctx.W)
    ctx.scanline(img, t)
    return img


def scene_vchart(t, s, ctx):
    """Native vertical chart. Annotations come from the spec, not from the engine."""
    img = ctx.base_frame()
    d = ImageDraw.Draw(img)
    data = s["data"]
    key = s.get("y_key", "case_real_pct")
    n = len(data)
    L, R = ctx.fs(110), ctx.W - ctx.fs(90)
    # Axis labels hang below BOT on up to two lines. Pull the plot floor up so
    # that block lands inside the safe box instead of under the caption bar.
    TOP = ctx.fs(780)
    BOT = min(ctx.fs(1480), ctx.safe["bottom"] - ctx.fs(105))
    ymax = s.get("ymax") or (max(r[key] for r in data) * 1.15) or 1.0

    ctx.kicker(d, s.get("kick", ""), ctx.fs(450))
    f_ttl, lines = fit(d, s["caption"], "serif_b", ctx.fs(60), ctx.W - ctx.fs(140), ctx.fs(200))
    draw_center(d, lines, f_ttl, ctx.fs(540), ctx.t["ink"], ctx.W)

    fg = font("mono", ctx.fs(30))
    step = 10 if ymax > 12 else 5
    v = 0
    while v <= ymax:
        y = BOT - (v / ymax) * (BOT - TOP)
        d.line([(L, y), (R, y)], fill=ctx.t["rule"], width=2)
        d.text((L - ctx.fs(92), y - ctx.fs(18)), f"{v:g}%", font=fg, fill=ctx.t["muted"])
        v += step

    def px(i): return L + (R - L) * (i / max(1, n - 1))
    def py(val): return BOT - (val / ymax) * (BOT - TOP)

    marker = s.get("marker")           # {"month": "...", "label": ["DEC","2025"]}
    mi = None
    if marker:
        mi = next((i for i, r in enumerate(data) if r["month"] == marker["month"]), None)
        if mi is not None:
            x = px(mi)
            for yy in range(int(TOP), int(BOT), ctx.fs(22)):
                d.line([(x, yy), (x, yy + ctx.fs(11))], fill=ctx.t["accent"], width=3)

    shown = max(2, int(n * ease(min(1.0, t * 1.35))))
    pts = [(px(i), py(data[i][key])) for i in range(shown)]
    d.line(pts, fill=ctx.t["green"], width=ctx.fs(7), joint="curve")
    for x, y in pts:
        r = ctx.fs(8)
        d.ellipse([x - r, y - r, x + r, y + r], fill=ctx.t["green"])

    fx = font("mono", ctx.fs(28))
    for idx, lab in ((0, s.get("x_first", "")), (n - 1, s.get("x_last", ""))):
        for k, ln in enumerate(str(lab).split("|")):
            if ln:
                tw = d.textlength(ln, font=fx)
                d.text((px(idx) - tw / 2, BOT + ctx.fs(26) + k * ctx.fs(34)),
                       ln, font=fx, fill=ctx.t["muted"])
    if mi is not None and marker.get("label"):
        fb = font("mono_b", ctx.fs(28))
        for k, ln in enumerate(marker["label"]):
            tw = d.textlength(ln, font=fb)
            d.text((px(mi) - tw / 2, BOT + ctx.fs(26) + k * ctx.fs(34)),
                   ln, font=fb, fill=ctx.t["accent"])

    for a in s.get("annotations", []):
        if shown < int(a.get("after_points", 0)):
            continue
        fa = font("mono_b", ctx.fs(a.get("size", 34)))
        txt = a["text"]
        yv = py(a.get("at_value", 0)) - ctx.fs(a.get("dy", 60))
        col = {"ink": ctx.t["ink"], "green": ctx.t["green"], "red": ctx.t["accent"],
               "grey": ctx.t["muted"]}.get(a.get("color", "ink"), ctx.t["ink"])
        if a.get("align") == "right":
            d.text((R - d.textlength(txt, font=fa), yv), txt, font=fa, fill=col)
        else:
            d.text((L + ctx.fs(12), yv), txt, font=fa, fill=col)

    ctx.scanline(img, t)
    return img


def scene_chart(t, s, ctx):
    img = ctx.base_frame()
    d = ImageDraw.Draw(img)
    src = s["_image"]                         # preloaded once
    z = 1.0 + 0.06 * ease(t)
    cw = int(ctx.W * 0.92)
    ch = int(src.height * cw / src.width)
    chart = src.resize((int(cw * z), int(ch * z)), Image.LANCZOS)
    img.paste(chart, ((ctx.W - chart.width) // 2, ctx.fs(640) - (chart.height - ch) // 2))
    ctx.kicker(d, s.get("kick", ""), ctx.fs(470))
    f2, lines = fit(d, s["caption"], "serif_b", ctx.fs(58), ctx.W - ctx.fs(160), ctx.fs(220))
    draw_center(d, lines, f2, ctx.fs(660) + ch + ctx.fs(40), ctx.t["ink"], ctx.W)
    ctx.scanline(img, t)
    return img


def scene_hash(t, s, ctx):
    img = Image.new("RGB", (ctx.W, ctx.H), ctx.t["ink"])
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, ctx.W, ctx.fs(10)], fill=ctx.t["accent"])
    ctx.kicker(d, s.get("kick", "AUDIT US"), ctx.fs(560))
    f, lines = fit(d, s["title"], "serif_b", ctx.fs(92), ctx.W - ctx.fs(160), ctx.fs(380))
    y = draw_center(d, lines, f, ctx.fs(680), ctx.t["paper"], ctx.W)
    h = s["hash"]
    shown = h[:int(len(h) * min(1.0, t * 1.5))]
    fm = font("mono", ctx.fs(34))
    rows = chunk_hash(h, 16)
    wide = max(d.textlength(r, font=fm) for r in rows)
    for i, row in enumerate(chunk_hash(shown, 16)):
        d.text(((ctx.W - wide) / 2, y + ctx.fs(70) + i * ctx.fs(46)), row,
               font=fm, fill=ctx.t["green"])
    # The CTA is placed FIRST, bottom-anchored inside the safe zone, so the
    # closing line can never be covered by platform UI. Only then is the sub
    # fitted into the room that is actually left — otherwise a long sub line
    # silently overprints the closing line.
    f4, lines4 = fit(d, s["cta"], "serif_b", ctx.fs(66), ctx.W - ctx.fs(160), ctx.fs(200))
    bb4 = f4.getbbox("Ag")
    block4 = len(lines4) * int((bb4[3] - bb4[1]) * 1.22)
    cta_top = ctx.safe["bottom"] - block4 - ctx.fs(40)

    if s.get("sub"):
        sub_top = y + ctx.fs(70) + len(rows) * ctx.fs(46) + ctx.fs(40)
        room = cta_top - sub_top - ctx.fs(40)
        if room > ctx.fs(40):
            f3, lines3 = fit(d, s["sub"], "mono", ctx.fs(38),
                             ctx.W - ctx.fs(200), room, min_size=ctx.fs(22))
            draw_center(d, lines3, f3, sub_top, ctx.t["footer_fg"], ctx.W)

    draw_center(d, lines4, f4, cta_top, ctx.t["paper"], ctx.W)
    return img


RENDERERS = {"title": scene_title, "bignum": scene_bignum, "vchart": scene_vchart,
             "chart": scene_chart, "hash": scene_hash}


# ----------------------------------------------------------------- spec layer
def load_spec(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SpecError(f"spec not found: {path}")
    except json.JSONDecodeError as e:
        raise SpecError(f"spec is not valid JSON ({path}): line {e.lineno}, {e.msg}")


def validate_timeline(data, key: str, where: str):
    if not isinstance(data, list) or not data:
        raise SpecError(f"{where}: chart data must be a non-empty list")
    seen = set()
    prev = ""
    for i, r in enumerate(data):
        if "month" not in r or key not in r:
            raise SpecError(f"{where}: record {i} missing 'month' or '{key}'")
        if not re.fullmatch(r"\d{4}-\d{2}", str(r["month"])):
            raise SpecError(f"{where}: record {i} month '{r['month']}' is not YYYY-MM")
        if r["month"] in seen:
            raise SpecError(f"{where}: duplicate month {r['month']}")
        if r["month"] < prev:
            raise SpecError(f"{where}: months out of order at {r['month']}")
        if not isinstance(r[key], (int, float)):
            raise SpecError(f"{where}: {key} at {r['month']} is not numeric")
        seen.add(r["month"])
        prev = r["month"]


def resolve_scene(scene: dict, base: Path, theme: dict, idx: int) -> dict:
    """Return a RESOLVED COPY. The input spec is never mutated."""
    s = dict(scene)
    where = f"scene {idx + 1} ({s.get('type', '?')})"
    st = s.get("type")
    if st not in RENDERERS:
        raise SpecError(f"{where}: unknown scene type '{st}'. "
                        f"Known types: {', '.join(sorted(RENDERERS))}")
    for field in REQUIRED[st]:
        if field not in s:
            raise SpecError(f"{where}: missing required field '{field}'")
    try:
        dur = float(s["dur"])
    except (TypeError, ValueError):
        raise SpecError(f"{where}: 'dur' must be a number")
    if dur <= 0:
        raise SpecError(f"{where}: 'dur' must be greater than zero")
    s["dur"] = dur

    if "color" in s:
        try:
            s["_color"] = brand.color(theme, s["color"])
        except brand.BrandError as e:
            raise SpecError(f"{where}: {e}")

    if "xfade" in s:                        # per-scene transition override
        try:
            s["xfade"] = max(0.0, float(s["xfade"]))
        except (TypeError, ValueError):
            raise SpecError(f"{where}: 'xfade' must be a number of seconds")

    if st == "vchart":
        d = s["data"]
        if isinstance(d, str):
            p = (base / d).resolve()
            if not p.is_file():
                raise SpecError(f"{where}: data file not found: {p}")
            s["_data_path"] = p
            d = json.loads(p.read_text(encoding="utf-8"))
        validate_timeline(d, s.get("y_key", "case_real_pct"), where)
        s["data"] = d
        if s.get("marker") and not any(r["month"] == s["marker"].get("month") for r in d):
            raise SpecError(f"{where}: marker month {s['marker'].get('month')} not in data")

    if st == "chart":
        p = (base / s["image"]).resolve()
        if not p.is_file():
            raise SpecError(f"{where}: chart image not found: {p}")
        s["_image_path"] = p
        s["_image"] = Image.open(p).convert("RGB")   # loaded ONCE, not per frame

    if st == "hash":
        h = str(s["hash"])
        if not re.fullmatch(r"[0-9a-f]{64}", h):
            raise SpecError(f"{where}: 'hash' must be 64 lowercase hex characters")
        vf = s.get("verify_file")
        if vf:
            p = (base / vf).resolve()
            if not p.is_file():
                raise SpecError(f"{where}: verify_file not found: {p}")
            actual = sha256_file(p)
            if actual != h:
                raise SpecError(
                    f"{where}: HASH MISMATCH — the video would claim a hash the file "
                    f"does not have.\n    file:     {p}\n    claimed:  {h}\n    actual:   {actual}")
            s["_verified"] = str(p)
    return s


def preflight(spec_path: Path, out: Path, spec: dict, force: bool) -> tuple[Ctx, list, dict]:
    if shutil.which("ffmpeg") is None:
        raise SpecError("ffmpeg not found on PATH")
    for role, path in brand.font_report():
        if not path:
            raise SpecError(f"no font for type role '{role}' on this machine — run "
                            "`python3 brand.py` to see every path that was tried")
    if out.suffix.lower() != ".mp4":
        raise SpecError(f"output must end in .mp4 (got '{out.suffix}')")
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and not force:
        print(f"  note: overwriting existing {out}")

    try:
        preset = brand.preset(spec.get("preset", "vertical"))
        theme = brand.theme(spec.get("theme"))
    except brand.BrandError as e:
        raise SpecError(str(e))
    if spec.get("fps"):
        preset["fps"] = int(spec["fps"])

    scenes = spec.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise SpecError("spec has no 'scenes' list")
    base = spec_path.parent
    resolved = [resolve_scene(s, base, theme, i) for i, s in enumerate(scenes)]
    ctx = Ctx(preset, theme, spec.get("footer", ""), guides=False)
    return ctx, resolved, preset


# ------------------------------------------------------- safe-zone enforcement
def safe_zone_report(ctx: Ctx, scenes: list) -> list[str]:
    """Find content placed where the platform's own UI will cover it.

    A vertical video loses its top ~300px to the platform header and its bottom
    ~360px to captions, the handle and the like button. The engine could always
    DRAW those guides but never checked against them, so a caption could sit
    perfectly in a contact sheet and be covered in the feed.

    Each scene is rendered at its final frame and its ink measured. Three
    things are masked out first because they are full-bleed furniture that is
    MEANT to run under the platform UI: the accent bar, the footer plate, and
    the scanline, which sweeps the whole frame by design.
    """
    import numpy as np
    findings = []
    t = 0.999
    for i, s in enumerate(scenes, 1):
        frame = np.array(RENDERERS[s["type"]](t, s, ctx), dtype=np.int16)
        # measure against the scene's OWN background, so a full-bleed scene
        # such as `hash` is not read as entirely "content"
        bg = frame[ctx.H // 2, 2].astype(np.int16)
        ink = np.abs(frame - bg).sum(axis=2) > 24

        ink[0:ctx.fs(14), :] = False                          # accent bar
        if ctx.footer:
            ink[ctx.H - ctx.fs(92):, :] = False               # footer plate
        sy = int(ctx.H * (0.08 + 0.84 * t))                   # scanline, this frame
        ink[max(0, sy - ctx.fs(10)):sy + ctx.fs(10), :] = False

        rows = np.where(ink.any(axis=1))[0]
        if not len(rows):
            continue
        top, bottom = int(rows.min()), int(rows.max())
        if top < ctx.safe["top"]:
            findings.append(
                f"scene {i} ({s['type']}): content starts at y={top}, "
                f"{ctx.safe['top'] - top}px above the safe top ({ctx.safe['top']}) "
                f"— the platform header covers it")
        if bottom > ctx.safe["bottom"]:
            findings.append(
                f"scene {i} ({s['type']}): content ends at y={bottom}, "
                f"{bottom - ctx.safe['bottom']}px below the safe bottom "
                f"({ctx.safe['bottom']}) — captions and buttons cover it")
    return findings


# ----------------------------------------------------------------- render
def frames_for(scenes, fps):
    return sum(int(s["dur"] * fps) for s in scenes)


def render_frame(s, i, nf, ctx, prev_last, xf_frames):
    img = RENDERERS[s["type"]](i / nf, s, ctx)
    if prev_last is not None and i < xf_frames:
        img = Image.blend(prev_last, img, ease(i / xf_frames))
    return img


def build_manifest(spec_path, spec, scenes, out: Path, ctx, elapsed) -> dict:
    inputs = [{"role": "spec", "path": str(spec_path),
               "sha256": sha256_file(spec_path)}]
    for s in scenes:
        for role, kk in (("chart_data", "_data_path"), ("chart_image", "_image_path")):
            if kk in s:
                inputs.append({"role": role, "path": str(s[kk]),
                               "sha256": sha256_file(Path(s[kk]))})
        if "_verified" in s:
            inputs.append({"role": "hash_verified_source", "path": s["_verified"],
                           "sha256": s["hash"]})
    try:
        ff = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True
                            ).stdout.splitlines()[0]
    except Exception:
        ff = "unknown"
    return {
        "spec": SPEC_VERSION, "renderer": f"openmontage {VERSION}", "ffmpeg": ff,
        "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "output": {"path": str(out), "sha256": sha256_file(out),
                   "bytes": out.stat().st_size},
        "video": {"width": ctx.W, "height": ctx.H, "fps": ctx.FPS,
                  "duration_s": round(sum(s["dur"] for s in scenes), 3),
                  "frames": frames_for(scenes, ctx.FPS)},
        "render_seconds": round(elapsed, 1),
        "scenes": [{"n": i + 1, "type": s["type"], "dur": s["dur"],
                    "claim": s.get("caption") or s.get("title", "")} for i, s in enumerate(scenes)],
        "inputs": sorted(inputs, key=lambda x: (x["role"], x["path"])),
    }


def render(spec_path: Path, out: Path, force: bool, verbose: bool) -> dict:
    spec = load_spec(spec_path)
    ctx, scenes, _ = preflight(spec_path, out, spec, force)
    total = sum(s["dur"] for s in scenes)
    nframes = frames_for(scenes, ctx.FPS)
    print(f"openmontage {VERSION} · {len(scenes)} scenes · {total:.1f}s · "
          f"{ctx.W}x{ctx.H} @ {ctx.FPS}fps · {nframes} frames")

    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{ctx.W}x{ctx.H}", "-r", str(ctx.FPS), "-i", "-",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
           "-movflags", "+faststart", str(out)]
    audio = spec.get("audio")
    if audio:
        ap = (spec_path.parent / audio).resolve()
        if not ap.is_file():
            raise SpecError(f"audio file not found: {ap}")
        cmd = cmd[:-1] + ["-i", str(ap), "-shortest", "-c:a", "aac", "-b:a", "160k",
                          "-filter:a", f"volume={spec.get('audio_volume', 0.2)}", str(out)]
    err = None if verbose else subprocess.PIPE
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err)

    t0 = time.time()
    default_xf = float(spec.get("crossfade", 0.45))
    prev_last, done = None, 0
    try:
        for si, s in enumerate(scenes):
            nf = int(s["dur"] * ctx.FPS)
            # a scene may set its own transition; "xfade": 0 is a hard cut
            xf = int(float(s.get("xfade", default_xf)) * ctx.FPS)
            for i in range(nf):
                img = render_frame(s, i, nf, ctx, prev_last, xf)
                proc.stdin.write(img.tobytes())
                done += 1
            prev_last = img
            el = time.time() - t0
            eta = el / done * (nframes - done)
            print(f"  [{si+1}/{len(scenes)}] {s['type']:<7} {nf:4d} frames · "
                  f"{el:5.1f}s elapsed · ~{eta:4.1f}s left")
        proc.stdin.close()
    except BrokenPipeError:
        stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        raise SpecError("ffmpeg closed the pipe early.\n" + (stderr[-1500:] or "(run --verbose)"))
    proc.wait()
    if proc.returncode != 0:
        stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        raise SpecError(f"ffmpeg exited {proc.returncode}.\n" + (stderr[-1500:] or "(run --verbose)"))

    man = build_manifest(spec_path, spec, scenes, out, ctx, time.time() - t0)
    mp = out.with_suffix(".manifest.json")
    mp.write_text(json.dumps(man, indent=2) + "\n", encoding="utf-8")
    print(f"-> {out}\n-> {mp}")
    print(f"   output sha256 {man['output']['sha256']}")
    return man


def dry_run(spec_path: Path, out: Path):
    spec = load_spec(spec_path)
    ctx, scenes, _ = preflight(spec_path, out, spec, True)
    total = sum(s["dur"] for s in scenes)
    print(f"DRY RUN · openmontage {VERSION}")
    print(f"  spec      {spec_path}")
    print(f"  video     {ctx.W}x{ctx.H} @ {ctx.FPS}fps · {total:.1f}s · "
          f"{frames_for(scenes, ctx.FPS)} frames")
    for i, s in enumerate(scenes):
        extra = ""
        if s["type"] == "vchart":
            extra = f" · {len(s['data'])} data points"
        if s.get("_verified"):
            extra += " · hash VERIFIED against source"
        print(f"  [{i+1}] {s['type']:<7} {s['dur']:>4.1f}s{extra}")
    print("  all scenes valid · assets present · fonts present · ffmpeg present")

    findings = safe_zone_report(ctx, scenes)
    if findings:
        print(f"\n  SAFE ZONE — {len(findings)} scene(s) place content where the "
              "platform's own UI will sit on top of it:")
        for f in findings:
            print(f"    {f}")
    else:
        print("  safe zones  every scene keeps its content clear of platform UI")
    print("  nothing rendered (dry run)")
    return findings


def stills(spec_path: Path, out_png: Path, sheet: bool):
    spec = load_spec(spec_path)
    ctx, scenes, _ = preflight(spec_path, Path("/tmp/_dryrun.mp4"), spec, True)
    imgs = [RENDERERS[s["type"]](0.999, s, ctx) for s in scenes]
    if sheet:
        cols = min(3, len(imgs))
        rows = (len(imgs) + cols - 1) // cols
        tw, th = ctx.W // 3, ctx.H // 3
        board = Image.new("RGB", (tw * cols, th * rows), (255, 255, 255))
        for i, im in enumerate(imgs):
            board.paste(im.resize((tw, th), Image.LANCZOS), ((i % cols) * tw, (i // cols) * th))
        board.save(out_png)
    else:
        imgs[0].save(out_png)
    print(f"-> {out_png}")


# ----------------------------------------------------------------- self-test
def self_test() -> int:
    import tempfile
    print("=== SELF-TEST: openmontage engine ===")
    fails = ran = 0

    def check(label, ok):
        nonlocal fails, ran
        ran += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        fails += (not ok)

    check("ease(0)==0 and ease(1)==1", ease(0) == 0.0 and ease(1) == 1.0)
    check("ease clamps out-of-range input", ease(-5) == 0.0 and ease(5) == 1.0)

    img = Image.new("RGB", (500, 200))
    d = ImageDraw.Draw(img)
    f = font("mono", 20)
    lines = wrap(d, "one two three four five six seven eight nine ten", f, 160)
    check("wrap never exceeds max width", all(d.textlength(l, font=f) <= 160 for l in lines))
    check("wrap keeps every word", " ".join(lines).split() ==
          "one two three four five six seven eight nine ten".split())
    f2, l2 = fit(d, "A very long headline that would never fit on one line at all",
                 "serif_b", 200, 400, 120)
    bb = f2.getbbox("Ag")
    check("fit() shrinks text to its box", len(l2) * int((bb[3] - bb[1]) * 1.22) <= 120)
    check("font cache returns the same object", font("mono", 20) is font("mono", 20))
    check("hash chunks are fixed width", chunk_hash("a" * 64, 16) == ["a" * 16] * 4)

    theme = brand.theme("sentinel_light")
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        data = [{"month": "2025-01", "case_real_pct": 0.0},
                {"month": "2025-02", "case_real_pct": 5.0}]
        (base / "d.json").write_text(json.dumps(data))
        orig = {"type": "vchart", "dur": 2, "data": "d.json", "caption": "c"}
        r = resolve_scene(orig, base, theme, 0)
        check("resolve_scene does NOT mutate the original spec", orig["data"] == "d.json")
        check("resolve_scene loads referenced data", isinstance(r["data"], list))

        def expect(scene, needle):
            try:
                resolve_scene(scene, base, theme, 0)
                return False
            except SpecError as e:
                return needle in str(e)

        check("missing required field is caught",
              expect({"type": "title", "dur": 2}, "missing required field 'title'"))
        check("unknown scene type is caught",
              expect({"type": "wat", "dur": 2}, "unknown scene type"))
        check("zero duration is caught",
              expect({"type": "title", "dur": 0, "title": "x"}, "greater than zero"))
        check("non-numeric duration is caught",
              expect({"type": "title", "dur": "soon", "title": "x"}, "must be a number"))
        check("missing data file is caught",
              expect({"type": "vchart", "dur": 1, "data": "nope.json", "caption": "c"},
                     "data file not found"))
        check("unknown color name is caught",
              expect({"type": "title", "dur": 1, "title": "x", "color": "chartreuse"},
                     "unknown color"))
        check("marker month absent from data is caught",
              expect({"type": "vchart", "dur": 1, "data": "d.json", "caption": "c",
                      "marker": {"month": "1999-01"}}, "not in data"))

        (base / "bad.json").write_text(json.dumps([{"month": "2025-2", "case_real_pct": 1}]))
        check("malformed month format is caught",
              expect({"type": "vchart", "dur": 1, "data": "bad.json", "caption": "c"},
                     "is not YYYY-MM"))
        (base / "dup.json").write_text(json.dumps(
            [{"month": "2025-01", "case_real_pct": 1}, {"month": "2025-01", "case_real_pct": 2}]))
        check("duplicate months are caught",
              expect({"type": "vchart", "dur": 1, "data": "dup.json", "caption": "c"},
                     "duplicate month"))
        (base / "unsorted.json").write_text(json.dumps(
            [{"month": "2025-05", "case_real_pct": 1}, {"month": "2025-01", "case_real_pct": 2}]))
        check("out-of-order months are caught",
              expect({"type": "vchart", "dur": 1, "data": "unsorted.json", "caption": "c"},
                     "out of order"))

        # The claim the whole brand rests on: a displayed hash must be the file's hash
        (base / "src.csv").write_text("real,data\n1,2\n")
        real = sha256_file(base / "src.csv")
        good = {"type": "hash", "dur": 1, "title": "t", "hash": real,
                "cta": "go", "verify_file": "src.csv"}
        ok = resolve_scene(good, base, theme, 0)
        check("hash scene verifies against its source file", ok.get("_verified") is not None)
        check("WRONG hash against a real file is refused",
              expect({**good, "hash": "b" * 64}, "HASH MISMATCH"))
        check("non-hex hash is refused",
              expect({"type": "hash", "dur": 1, "title": "t", "hash": "nope",
                      "cta": "go"}, "64 lowercase hex"))

    check("frame count math is exact", frames_for([{"dur": 2.0}, {"dur": 0.5}], 24) == 60)

    # --- v0.3 ---------------------------------------------------------------
    # The brand is one system, and specs written for v0.2 must keep building.
    check("legacy theme name still resolves",
          brand.theme("broadsheet") is brand.theme("sentinel_light"))
    check("legacy colour 'red' resolves to brand accent",
          brand.color(theme, "red") == theme["accent"])
    with tempfile.TemporaryDirectory() as td3:
        b3 = Path(td3)
        r = resolve_scene({"type": "title", "dur": 2, "title": "x", "color": "red"},
                          b3, theme, 0)
        check("a v0.2 spec still resolves its colour", r["_color"] == theme["accent"])
        r2 = resolve_scene({"type": "title", "dur": 2, "title": "x", "xfade": 0.2},
                           b3, theme, 0)
        check("per-scene crossfade is accepted", r2["xfade"] == 0.2)
        try:
            resolve_scene({"type": "title", "dur": 2, "title": "x", "xfade": "slow"},
                          b3, theme, 0)
            ok_x = False
        except SpecError as e:
            ok_x = "must be a number" in str(e)
        check("non-numeric crossfade is caught", ok_x)

    # Safe zones are CHECKED now, not merely drawable.
    ctxs = Ctx(brand.preset("vertical"), theme, "", False)
    placed = [resolve_scene({"type": "title", "dur": 2, "kick": "K",
                             "title": "Short title", "sub": "one line"},
                            Path("."), theme, 0)]
    check("a well-placed scene reports no safe-zone violations",
          safe_zone_report(ctxs, placed) == [])
    narrow = brand.preset("vertical")
    narrow["safe"] = {"top": 900, "bottom": 950, "left": 60, "right": 1020}
    check("content outside the safe box IS reported",
          len(safe_zone_report(Ctx(narrow, theme, "", False), placed)) > 0)
    check("narrowing one preset copy does not mutate the brand",
          brand.preset("vertical")["safe"]["top"] == 300)

    # A kicker must never run off the frame, however long the text.
    ctxk = Ctx(brand.preset("vertical"), theme, "", False)
    for kt in ("SHORT",
               "AVERAGE LENGTH KICKER",
               "VALIDATED BEFORE FFMPEG STARTS",
               "PUBLIC RECORDS INVESTIGATION · COLUMBUS OHIO EXTENDED"):
        dk = ImageDraw.Draw(Image.new("RGB", (ctxk.W, 200), (255, 255, 255)))
        drawn = ctxk.kicker(dk, kt, 20)
        check(f"kicker fits the frame ({int(drawn)}px): '{kt[:28]}'", drawn <= ctxk.W)
    check("an empty kicker draws nothing rather than crashing",
          ctxk.kicker(ImageDraw.Draw(Image.new("RGB", (ctxk.W, 200))), "", 20) == 0)
    print(f"\nSelf-test: {ran - fails}/{ran} behaved correctly.")
    return 1 if fails else 0


# ----------------------------------------------------------------- cli
def main():
    ap = argparse.ArgumentParser(description="OpenMontage — code-driven montage renderer")
    ap.add_argument("--spec", default="teaser.json")
    ap.add_argument("--out", default="builds/teaser.mp4")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--poster", help="write scene-1 still to this PNG")
    ap.add_argument("--contact-sheet", help="write all scenes to one PNG")
    ap.add_argument("--force", action="store_true", help="overwrite without notice")
    ap.add_argument("--verbose", action="store_true", help="show ffmpeg output live")
    ap.add_argument("--check-safe", action="store_true",
                    help="validate, then exit 3 if any scene breaks the safe zone")
    ap.add_argument("--fonts", action="store_true",
                    help="show which font file each type role resolves to here")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()

    if a.fonts:
        print(brand.summary())
        sys.exit(0 if brand.fonts_ok() else 2)

    if a.self_test:
        sys.exit(self_test())
    spec_path = Path(a.spec).expanduser().resolve()
    out = Path(a.out).expanduser()
    try:
        if a.dry_run or a.check_safe:
            findings = dry_run(spec_path, out)
            if a.check_safe and findings:
                sys.exit(3)
        elif a.contact_sheet:
            stills(spec_path, Path(a.contact_sheet), sheet=True)
        elif a.poster:
            stills(spec_path, Path(a.poster), sheet=False)
        else:
            render(spec_path, out, a.force, a.verbose)
    except SpecError as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
