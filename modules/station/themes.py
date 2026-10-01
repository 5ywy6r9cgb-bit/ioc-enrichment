# -*- coding: utf-8 -*-
"""Themes for the station, from the theme-factory set (colors and font pairings as published there),
turned into light and dark token sets with checked contrast.

Ocean Depths is the default: the theme-factory description is "professional and calming ... financial
reports, trust-building content", and its navy ground carries the ledger signature well. Its tokens are
hand-tuned; the other nine are derived from their four colors by the same contrast rules, so any of them
can be chosen with --theme and still read correctly in both modes.
"""
import colorsys

THEMES = {
    "ocean-depths": {"name": "Ocean Depths", "colors": ["#1a2332", "#2d8b8b", "#a8dadc", "#f1faee"], "head": "dejavu-sans-condensed-bold", "body": "dejavu-sans"},
    "sunset-boulevard": {"name": "Sunset Boulevard", "colors": ["#e76f51", "#f4a261", "#e9c46a", "#264653"], "head": "dejavu-serif-bold", "body": "dejavu-sans"},
    "forest-canopy": {"name": "Forest Canopy", "colors": ["#2d4a2b", "#7d8471", "#a4ac86", "#faf9f6"], "head": "freeserif-bold", "body": "freesans"},
    "modern-minimalist": {"name": "Modern Minimalist", "colors": ["#36454f", "#708090", "#d3d3d3", "#ffffff"], "head": "dejavu-sans-bold", "body": "dejavu-sans"},
    "golden-hour": {"name": "Golden Hour", "colors": ["#f4a900", "#c1666b", "#d4b896", "#4a403a"], "head": "freesans-bold", "body": "freesans"},
    "arctic-frost": {"name": "Arctic Frost", "colors": ["#d4e4f7", "#4a6fa5", "#c0c0c0", "#fafafa"], "head": "dejavu-sans-bold", "body": "dejavu-sans"},
    "desert-rose": {"name": "Desert Rose", "colors": ["#d4a5a5", "#b87d6d", "#e8d5c4", "#5d2e46"], "head": "freesans-bold", "body": "freesans"},
    "tech-innovation": {"name": "Tech Innovation", "colors": ["#0066ff", "#00ffff", "#1e1e1e", "#ffffff"], "head": "dejavu-sans-bold", "body": "dejavu-sans"},
    "botanical-garden": {"name": "Botanical Garden", "colors": ["#4a7c59", "#f9a620", "#b7472a", "#f5f3ed"], "head": "dejavu-serif-bold", "body": "dejavu-sans"},
    "midnight-galaxy": {"name": "Midnight Galaxy", "colors": ["#2b1e3e", "#4a4e8f", "#a490c2", "#e6e6fa"], "head": "freesans-bold", "body": "freesans"},
}
MONO = "dejavu-sans-mono"
FONT_FAMILY = {"dejavu-sans": "DejaVu Sans", "dejavu-sans-bold": "DejaVu Sans", "dejavu-sans-condensed-bold": "DejaVu Sans Condensed",
               "dejavu-sans-mono": "DejaVu Sans Mono", "dejavu-serif-bold": "DejaVu Serif", "freesans": "FreeSans",
               "freesans-bold": "FreeSans", "freeserif-bold": "FreeSerif"}
FONT_WEIGHT = {"dejavu-sans": 400, "dejavu-sans-bold": 700, "dejavu-sans-condensed-bold": 700, "dejavu-sans-mono": 400,
               "dejavu-serif-bold": 700, "freesans": 400, "freesans-bold": 700, "freeserif-bold": 700}
FALLBACK = {"DejaVu Sans": "Verdana, 'Segoe UI', system-ui, sans-serif", "DejaVu Sans Condensed": "'Arial Narrow', 'Roboto Condensed', system-ui, sans-serif",
            "DejaVu Sans Mono": "Menlo, Consolas, 'Liberation Mono', monospace", "DejaVu Serif": "Georgia, 'Times New Roman', serif",
            "FreeSans": "'Helvetica Neue', Helvetica, Arial, sans-serif", "FreeSerif": "'Times New Roman', Times, serif"}

# status (GlassMark tiers) and money families: fixed per mode, always shown with a text label
TIERS = {"dark": {"green": "#5cc98a", "arith": "#56c1c7", "reported": "#e3a93b", "red": "#f07b6d", "dead": "#97a6b2"},
         "light": {"green": "#1e7b45", "arith": "#0e7c86", "reported": "#8a5f00", "red": "#b3261e", "dead": "#5f6b76"}}
FAMILIES = {"dark": {"contracts": "#7cc6c1", "electoral": "#e9b44c", "lobbying": "#b3a3d6", "spending": "#8fb8d8",
                     "settlements": "#d9c38a", "alleged": "#ef7f6a", "onchain": "#e8eef2"},
            "light": {"contracts": "#1f6f6b", "electoral": "#9a6500", "lobbying": "#5d4fa3", "spending": "#2b5f87",
                      "settlements": "#7a6420", "alleged": "#b23a22", "onchain": "#1a2332"}}


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _hex(rgb):
    return "#" + "".join("{:02x}".format(max(0, min(255, round(c * 255)))) for c in rgb)


def lum(h):
    def ch(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in _rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def mix(a, b, t):
    ra, rb = _rgb(a), _rgb(b)
    return _hex(tuple(x * (1 - t) + y * t for x, y in zip(ra, rb)))


def push(color, bg, target):
    """Lighten or darken `color` until it reaches `target` contrast against `bg`."""
    toward = "#ffffff" if lum(bg) < 0.5 else "#000000"
    c, t = color, 0.0
    while contrast(c, bg) < target and t < 1:
        t += 0.04
        c = mix(color, toward, t)
    return c


def saturation(h):
    r, g, b = _rgb(h)
    return colorsys.rgb_to_hls(r, g, b)[2]


def tokens(key):
    th = THEMES[key]
    cols = th["colors"]
    darkest = min(cols, key=lum)
    lightest = max(cols, key=lum)
    accent_src = max([c for c in cols if c not in (darkest, lightest)] or cols, key=saturation)
    if key == "ocean-depths":
        dark = {"bg": "#1a2332", "panel": "#202b3d", "panel-2": "#26334a", "line": "#33425a", "ink": "#f1faee", "muted": "#a9bcc4",
                "accent": "#2d8b8b", "accent-ink": "#f1faee", "link": "#a8dadc", "focus": "#a8dadc", "art-bg": "#1a2332",
                "art-ink": "#f1faee", "art-wire": "#a8dadc", "art-counter": "#0c121b"}
        light = {"bg": "#f1faee", "panel": "#ffffff", "panel-2": "#e4f0ec", "line": "#c6d8d4", "ink": "#1a2332", "muted": "#4a5b69",
                 "accent": "#1d6f6f", "accent-ink": "#ffffff", "link": "#1d6f6f", "focus": "#1d6f6f", "art-bg": "#e9f4ef",
                 "art-ink": "#1a2332", "art-wire": "#2d8b8b", "art-counter": "#ffffff"}
    else:
        dbg = darkest if lum(darkest) < 0.06 else mix(darkest, "#000000", 0.65)
        dink = lightest if contrast(lightest, dbg) >= 10 else "#f5f5f2"
        lbg = lightest if lum(lightest) > 0.8 else mix(lightest, "#ffffff", 0.8)
        link_ = darkest if contrast(darkest, lbg) >= 9 else mix(darkest, "#000000", 0.5)
        dark = {"bg": dbg, "panel": mix(dbg, dink, 0.05), "panel-2": mix(dbg, dink, 0.09), "line": mix(dbg, dink, 0.18),
                "ink": dink, "muted": push(mix(dink, dbg, 0.3), dbg, 6.0), "accent": push(accent_src, dbg, 3.0),
                "accent-ink": dbg, "link": push(mix(accent_src, dink, 0.35), dbg, 7.0), "focus": push(accent_src, dbg, 4.5),
                "art-bg": dbg, "art-ink": dink, "art-wire": push(accent_src, dbg, 3.0), "art-counter": mix(dbg, "#000000", 0.5)}
        light = {"bg": lbg, "panel": "#ffffff", "panel-2": mix(lbg, link_, 0.05), "line": mix(lbg, link_, 0.18), "ink": link_,
                 "muted": push(mix(link_, lbg, 0.35), lbg, 6.0), "accent": push(accent_src, lbg, 4.5), "accent-ink": "#ffffff",
                 "link": push(accent_src, lbg, 5.0), "focus": push(accent_src, lbg, 4.5), "art-bg": mix(lbg, link_, 0.03),
                 "art-ink": link_, "art-wire": push(accent_src, lbg, 3.0), "art-counter": "#ffffff"}
    for mode, t in (("dark", dark), ("light", light)):
        for k, v in TIERS[mode].items():
            t["t-" + k] = push(v, t["bg"], 4.5)
        for k, v in FAMILIES[mode].items():
            t["f-" + k] = push(v, t["bg"], 3.0)
    head, body = th["head"], th["body"]
    return {"key": key, "name": th["name"], "source_colors": cols, "dark": dark, "light": light,
            "fonts": {"head": head, "body": body, "body_bold": body.replace("-bold", "") + "-bold" if not body.endswith("-bold") else body, "mono": MONO}}


def report(t):
    rows = []
    for mode in ("dark", "light"):
        m = t[mode]
        rows.append((mode, "ink/bg", round(contrast(m["ink"], m["bg"]), 2)))
        rows.append((mode, "muted/bg", round(contrast(m["muted"], m["bg"]), 2)))
        rows.append((mode, "link/bg", round(contrast(m["link"], m["bg"]), 2)))
        rows.append((mode, "ink/panel", round(contrast(m["ink"], m["panel"]), 2)))
        rows.append((mode, "accent-ink/accent", round(contrast(m["accent-ink"], m["accent"]), 2)))
        for k in ("t-green", "t-arith", "t-reported", "t-red", "t-dead"):
            rows.append((mode, k + "/bg", round(contrast(m[k], m["bg"]), 2)))
    return rows
