#!/usr/bin/env python3
"""
brand.py — The Sentinel Report brand, in one place.

Colour, type, canvas presets and safe zones. The montage engine and the motif
library both read this module, so a brand decision is made once and every
surface changes with it.

WHY THIS FILE EXISTS

Two problems it solves, both of which bite in practice:

1. FONTS WERE HARDCODED TO LINUX.
   The engine named `/usr/share/fonts/truetype/dejavu/...` directly. Those
   paths do not exist on macOS, which is the machine this system is installed
   on (`Install-Sentinel.command`, `scripts/setup_macos.sh`). The engine could
   not render there at all — it failed in preflight with "font missing" before
   drawing a frame. Here every type role carries a candidate list and the first
   file that exists wins, so one project folder builds on a laptop, on a Linux
   box, and in CI.

2. THE PALETTE HAD NO HOME.
   It lived inside the renderer, which meant any second surface that wanted to
   look like The Sentinel Report had to copy it. A copied palette is not a
   brand; it is two brands that look alike until one drifts.

COLOUR CARRIES MEANING, NOT DECORATION
    accent   brand red      series identity, kickers, the caution register
    cyan     source ink     citations, and only ever citations
    gold     document       a quoted exhibit
    green    verified       a hash that checked out
    muted    supporting     never carries a claim

TYPE — two families, never three
    serif    editorial voice. Headlines, pull quotes.
    sans     figures only. A number is data, not prose.
    mono     machine output. Source lines, hashes, kickers, timecodes —
             monospace reads as "unedited", which is the claim a citation makes.
"""
from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path

BRAND = "The Sentinel Report"
TAGLINE = "Named Sources · Public Documents · Verified Facts"
STANDARD = "Documents and dates. No characterization."


class BrandError(Exception):
    """A brand asset is missing, or a name was used that does not exist.

    Raised rather than silently substituting: a font that quietly falls back to
    the wrong face is a branding bug you discover after publishing.
    """


# --------------------------------------------------------------------- type
# Candidates in preference order. The first path that exists on THIS machine
# wins. Add your own at the front of a list if you license a face.
_FONT_CANDIDATES: dict[str, list[str]] = {
    # editorial serif, bold — headlines and pull quotes
    "serif_b": [
        "/System/Library/Fonts/Supplemental/Charter.ttc",      # macOS, ships with it
        "/Library/Fonts/Charter Bold.ttf",
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "/usr/share/fonts/X11/Type1/c0632bt_.pfb",             # Bitstream Charter Bold
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "C:/Windows/Fonts/georgiab.ttf",
    ],
    # editorial serif, regular — subheads and body notes
    "serif": [
        "/System/Library/Fonts/Supplemental/Charter.ttc",
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/usr/share/fonts/X11/Type1/c0648bt_.pfb",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "C:/Windows/Fonts/georgia.ttf",
    ],
    # grotesque bold — big numbers only
    "sans_b": [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
    # machine mono — source lines, hashes, kickers
    "mono": [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "C:/Windows/Fonts/consola.ttf",
    ],
    "mono_b": [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "C:/Windows/Fonts/consolab.ttf",
    ],
}


@lru_cache(maxsize=32)
def font_path(role: str) -> str:
    """Resolve a type role to a real file on this machine."""
    if role not in _FONT_CANDIDATES:
        raise BrandError(
            f"unknown type role '{role}'. Known: {', '.join(sorted(_FONT_CANDIDATES))}")
    for cand in _FONT_CANDIDATES[role]:
        if Path(cand).is_file():
            return cand
    raise BrandError(
        f"no font found for type role '{role}' on this machine ({sys.platform}).\n"
        "    Tried:\n" + "\n".join(f"      {c}" for c in _FONT_CANDIDATES[role]) +
        "\n    Install one of them, or add a path you do have to _FONT_CANDIDATES\n"
        "    in modules/openmontage/engine/brand.py.")


def font_report() -> list[tuple[str, str | None]]:
    """(role, resolved path or None) for every role — what `--fonts` prints."""
    out = []
    for role in sorted(_FONT_CANDIDATES):
        try:
            out.append((role, font_path(role)))
        except BrandError:
            out.append((role, None))
    return out


def fonts_ok() -> bool:
    return all(p for _, p in font_report())


# ------------------------------------------------------------------- colour
# One palette expressed twice. Role names are identical across themes, so a
# spec never has to know which theme it will be rendered in.
THEMES: dict[str, dict[str, tuple[int, int, int]]] = {
    "sentinel_light": {
        "paper":     (233, 235, 238),
        "paperwhite": (252, 252, 250),
        "ink":       (18, 22, 28),
        "accent":    (163, 34, 34),
        "green":     (27, 107, 74),
        "muted":     (143, 152, 166),
        "rule":      (198, 203, 210),
        "cyan":      (14, 116, 128),
        "gold":      (176, 132, 38),
        "footer_bg": (18, 22, 28),
        "footer_fg": (200, 206, 214),
    },
    "sentinel_dark": {
        "paper":     (18, 22, 28),
        "paperwhite": (252, 252, 250),
        "ink":       (233, 235, 238),
        "accent":    (196, 60, 60),
        "green":     (63, 156, 116),
        "muted":     (120, 130, 145),
        "rule":      (58, 66, 78),
        "cyan":      (86, 210, 218),
        "gold":      (224, 184, 90),
        "footer_bg": (8, 10, 14),
        "footer_fg": (150, 158, 170),
    },
}

THEME_ALIASES = {"light": "sentinel_light", "dark": "sentinel_dark",
                 "broadsheet": "sentinel_light", "slate": "sentinel_dark"}

# Older specs say "red" and "grey". Both still resolve, by design — a spec
# written for the previous engine must keep building.
COLOR_ALIASES = {"red": "accent", "grey": "muted", "gray": "muted"}


def theme(name: str | None = None) -> dict[str, tuple[int, int, int]]:
    key = THEME_ALIASES.get(name or "sentinel_light", name or "sentinel_light")
    if key not in THEMES:
        raise BrandError(
            f"unknown theme '{name}'. Known: {', '.join(sorted(THEMES))} "
            f"(aliases: {', '.join(sorted(THEME_ALIASES))})")
    return THEMES[key]


def color(pal: dict, name: str) -> tuple[int, int, int]:
    key = COLOR_ALIASES.get(name, name)
    if key in pal:
        return pal[key]
    raise BrandError(
        f"unknown color '{name}'. Known: {', '.join(sorted(pal))} "
        f"(aliases: {', '.join(sorted(COLOR_ALIASES))})")


def mix(c1, c2, k: float):
    """Blend two colours. k=0 returns c1, k=1 returns c2."""
    return tuple(int(round(a + (b - a) * k)) for a, b in zip(c1, c2))


# ------------------------------------------------------------------- canvas
# Safe zones are real estate you do not own. A vertical video loses its top
# ~300px to the platform header and its bottom ~360px to captions, the handle
# and the like button. Content placed outside the box gets covered in the feed
# even though it looked correct in a contact sheet.
PRESETS: dict[str, dict] = {
    "vertical":  {"w": 1080, "h": 1920, "fps": 24,
                  "safe": {"top": 300, "bottom": 1560, "left": 60, "right": 1020}},
    "square":    {"w": 1080, "h": 1080, "fps": 24,
                  "safe": {"top": 120, "bottom": 960, "left": 60, "right": 1020}},
    "landscape": {"w": 1920, "h": 1080, "fps": 24,
                  "safe": {"top": 80, "bottom": 1000, "left": 100, "right": 1820}},
}


def preset(name: str | None = None) -> dict:
    """Return a COPY, nested safe box included.

    A shallow dict() would hand back a shared reference to `safe`, so a caller
    adjusting the safe box for one render would silently redefine it for every
    later render in the same process.
    """
    key = name or "vertical"
    if key not in PRESETS:
        raise BrandError(f"unknown preset '{key}'. Known: {', '.join(sorted(PRESETS))}")
    p = dict(PRESETS[key])
    p["safe"] = dict(p["safe"])
    return p


# ------------------------------------------------------------------- pacing
# Documentary narration sits at 130-150 wpm; under 120 reads as deliberate,
# over 165 reads as rushed.
WPM_COMFORT = 155
WPM_SPARSE = 110
WPM_TARGET = 140


def summary() -> str:
    L = [f"{BRAND} — {TAGLINE}", f"standard: {STANDARD}", "", "TYPE"]
    for role, path in font_report():
        L.append(f"  {'ok     ' if path else 'MISSING'}  {role:<8} "
                 f"{path or '— no candidate found on this machine'}")
    L.append("")
    L.append("THEMES   " + ", ".join(sorted(THEMES)))
    L.append("PRESETS  " + ", ".join(f"{k} {v['w']}x{v['h']}" for k, v in PRESETS.items()))
    return "\n".join(L)


def self_test() -> int:
    print("=== SELF-TEST: brand ===")
    fails = ran = 0

    def check(label, ok):
        nonlocal fails, ran
        ran += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        fails += (not ok)

    for role, path in font_report():
        check(f"type role resolves on this machine: {role}", bool(path))

    check("legacy theme name 'broadsheet' resolves",
          theme("broadsheet") is theme("sentinel_light"))
    check("unknown theme raises a BrandError with the known names in it",
          _raises(lambda: theme("chartreuse"), "unknown theme"))

    pal = theme("sentinel_light")
    check("legacy colour 'red' still resolves to brand accent",
          color(pal, "red") == pal["accent"])
    check("legacy colour 'grey' still resolves to brand muted",
          color(pal, "grey") == pal["muted"])
    check("unknown colour raises rather than silently substituting",
          _raises(lambda: color(pal, "chartreuse"), "unknown color"))

    check("every theme defines every role",
          set(THEMES["sentinel_light"]) == set(THEMES["sentinel_dark"]))
    check("preset carries a safe box",
          set(preset("vertical")["safe"]) == {"top", "bottom", "left", "right"})
    check("preset() returns a copy, so callers cannot mutate the brand",
          (preset("vertical")["safe"].update({"top": 0}) or
           PRESETS["vertical"]["safe"]["top"]) == 300)
    check("unknown preset is refused", _raises(lambda: preset("banner"), "unknown preset"))
    check("mix blends endpoints exactly",
          mix((0, 0, 0), (10, 20, 30), 0.0) == (0, 0, 0) and
          mix((0, 0, 0), (10, 20, 30), 1.0) == (10, 20, 30))

    print(f"\nSelf-test: {ran - fails}/{ran} behaved correctly.")
    return 1 if fails else 0


def _raises(fn, needle: str) -> bool:
    try:
        fn()
        return False
    except BrandError as e:
        return needle in str(e)


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    print(summary())
    sys.exit(0 if fonts_ok() else 1)
