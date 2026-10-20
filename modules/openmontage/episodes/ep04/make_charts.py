#!/usr/bin/env python3
"""make_charts.py — draws ep04's chart images from the card figures, in the engine's own brand fonts and colours.
Every bar is a filed amount; every share printed is amount / stated total (ARITH). Nothing is estimated."""
import sys, pathlib
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE.parents[1] / "engine"))
import brand
from PIL import Image, ImageDraw
from openmontage import font   # same font resolver the renderer uses
T = brand.THEMES["sentinel_bright"]
W = 1000

def bars(path, rows, total=None, total_label="", row_h=92, **_):
    """rows: [(label, amount, color_key)]. Label sits above its bar so long names never collide. Bar length = amount / max."""
    H = row_h * len(rows) + 40 + (56 if total_label else 0)
    img = Image.new("RGB", (W, H), T["paperwhite"]); d = ImageDraw.Draw(img)
    mx = max(r[1] for r in rows); fl = font("sans_b", 27); fv = font("mono_b", 27); fs = font("mono", 23)
    y = 18; x0 = 18; full = W - 2 * x0
    for label, amt, ck in rows:
        v = "${:,.0f}".format(amt) + (f"   {amt / total * 100:.1f}%" if total else "")
        d.text((x0, y), label, font=fl, fill=T["ink"])
        tw = d.textlength(v, font=fv); d.text((W - x0 - tw, y), v, font=fv, fill=T["ink"])
        bw = max(4, int(full * amt / mx)); d.rectangle([x0, y + 38, x0 + bw, y + 62], fill=T[ck])
        y += row_h
    if total_label: d.text((x0, y + 8), total_label, font=fs, fill=T["muted"])
    img.save(path); print("->", path.name, img.size)

# BROWN-01: six committees, $13,471,230 spent against Sherrod Brown (FEC Schedule E)
bars(HERE / "charts" / "brown_six.png", [("AFP Action", 4888349, "accent"), ("SLF PAC", 4508418, "accent"), ("Ohio Flyer PAC", 3342670, "accent"),
     ("America PAC", 648371, "accent"), ("Conservative Caucus", 73419, "accent"), ("Red Senate", 10002, "accent")],
     total_label="Six committees = $13,471,230 (to within $1). FEC Schedule E.")
# OH-FLYER-01: one committee, two candidates
bars(HERE / "charts" / "flyer_split.png", [("AGAINST  Sherrod Brown", 3342670, "accent"), ("FOR  Jon Husted", 1117199, "cyan")], total=4459869,
     total_label="Share = amount / $4,459,869 total (ARITH). No third candidate.", row_h=130, label_w=330)
# TEAM-HUSTED-01: joint fundraiser split five ways
bars(HERE / "charts" / "jfc_split.png", [("HUSTED FOR SENATE", 5215998, "accent"), ("NRSC", 1129393, "gold"), ("JOBS OPPORTUNITY NOW PAC", 824033, "cyan"),
     ("OHIO FLYER PAC", 604861, "green"), ("Ohio Republican Party", 479247, "muted")], total=8253532,
     total_label="Share = amount / $8,253,532 (ARITH). Five recipients = the total.", row_h=92, label_w=330)
