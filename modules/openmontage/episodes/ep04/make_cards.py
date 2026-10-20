#!/usr/bin/env python3
"""make_cards.py — exports every scene's final frame as a PNG (post-ready cards). Vertical 1080x1920 for TikTok/Reels/Shorts;
a square 1080x1080 crop is centered on the content for feeds. Same renderer as the video, so a card and the video cannot disagree."""
import sys, pathlib
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE.parents[1] / "engine"))
import openmontage as om
from PIL import Image
spec_path = HERE / "episode.json"
spec = om.load_spec(spec_path)
ctx, scenes, _ = om.preflight(spec_path, pathlib.Path("/tmp/_cards.mp4"), spec, True)
out = HERE / "cards"; out.mkdir(exist_ok=True)
for i, s in enumerate(scenes, 1):
    im = om.RENDERERS[s["type"]](0.999, s, ctx).convert("RGB")
    name = f"{i:02d}_{s['type']}"
    im.save(out / f"{name}_vertical.png")
    top = 330; im.crop((0, top, 1080, top + 1080)).save(out / f"{name}_square.png")   # content band, clear of header and footer
print(len(scenes), "scenes ->", out)
