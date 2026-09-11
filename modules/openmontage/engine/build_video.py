#!/usr/bin/env python3
"""
build_video.py — scene images + narration → one MP4, with Ken Burns.

WHY THIS IS A REWRITE, NOT A TIDY-UP

The previous version rendered scene 1 for the entire runtime. Scenes 2-7
never appeared, and ffmpeg exited 0, so nothing said so.

    -loop 1 -i img          an image loop with no -t is an INFINITE stream
    zoompan d=N             emits N frames for EVERY input frame
    concat                  reads [v0] until end-of-stream

[v0] never ends, so concat never reaches [v1]. `-shortest` stops the encode
when the audio runs out, and the result is one image, zoomed to its clamp,
for the whole video. Verified by sampling the centre pixel of a three-colour
build at 1s, 4s and 7s: red, red, red.

The fix is two changes:

    -loop 1 -t D -framerate FPS -i img      bound the input to D seconds
    zoompan=…:d=1:…                         one output frame per input frame

Same build, sampled at the same three times: red, green, blue.

WHAT ELSE CHANGED, AND WHY EACH ONE MATTERS

  * Durations come from the SPEC when there is one. Dividing the audio into
    equal slices gave "WHAT IT DOES NOT PROVE" exactly as long as the hook.
    Pacing should follow the script; the script already carries the numbers.
  * Frame counts are distributed, not truncated. int() on seven scenes threw
    away up to seven frames, and `-shortest` took them off the END — the
    last words of the narration.
  * Every input is checked before ffmpeg starts, and named when missing. A
    missing PNG used to surface as a filter-graph error about a pad index.
  * Arguments are built as a list. The old code joined paths into a string
    and split on whitespace, so any path with a space became two arguments.
  * A manifest is written: sha256 of every input and of the output. Every
    other artefact this desk produces is hashed and ledgered; a published
    video is the one that most needs to be.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

FPS = 25
W, H = 1920, 1080

# Ken Burns: how much to zoom, and how fast. Per OUTPUT frame, so the rate is
# tied to FPS rather than to the number of scenes.
ZOOM_MAX = 1.08
ZOOM_STEP = 0.0008


class BuildError(Exception):
    """Something wrong with the inputs. Reported before ffmpeg is launched."""


# ── preflight ────────────────────────────────────────────────────────────

def need_tool(name: str) -> str:
    p = shutil.which(name)
    if p:
        return p
    raise BuildError(f"{name} not found on PATH. It ships with ffmpeg: "
                     f"brew install ffmpeg")


def _duration_via_ffmpeg(path: Path) -> float:
    """Length of a file, measured by decoding it.

    ffprobe is the right tool and is not always installed — some static
    ffmpeg builds ship without it. Refusing to run at all in that case makes
    a missing convenience into a missing capability, so fall back to ffmpeg,
    which is by definition present. `-f null -` decodes and discards; the
    final progress line carries the time reached.
    """
    r = subprocess.run([need_tool("ffmpeg"), "-i", str(path), "-f", "null", "-"],
                       capture_output=True, text=True)
    best = 0.0
    for m in __import__("re").finditer(r"time=(\d+):(\d\d):(\d\d(?:\.\d+)?)", r.stderr):
        hh, mm, ss = int(m.group(1)), int(m.group(2)), float(m.group(3))
        best = max(best, hh * 3600 + mm * 60 + ss)
    if best <= 0:
        raise BuildError(f"could not measure the length of {path.name}. "
                         f"ffmpeg said:\n  " + (r.stderr.strip()[-400:] or "nothing"))
    return best


def probe_duration(path: Path) -> float:
    """Seconds of audio. Checked, because a failed probe used to surface as
    `could not convert string to float: ''`."""
    if shutil.which("ffprobe") is None:
        return _duration_via_ffmpeg(path)
    cmd = ["ffprobe", "-v", "error", "-show_entries",
           "format=duration", "-of", "csv=p=0", str(path)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise BuildError(f"ffprobe could not read {path.name}:\n  "
                         + (r.stderr.strip() or "no error text"))
    raw = r.stdout.strip()
    try:
        d = float(raw)
    except ValueError:
        # A container can omit format-level duration. Decoding always works.
        return _duration_via_ffmpeg(path)
    if d <= 0:
        raise BuildError(f"{path.name} reports a duration of {d}s.")
    return d


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ── timing ───────────────────────────────────────────────────────────────

def scene_frames(weights: list[float], total_frames: int) -> list[int]:
    """Split total_frames across scenes in the given proportions, losing
    nothing.

    int(seconds * FPS) per scene discarded a fraction each time and the
    shortfall came off the end of the narration. Here the running remainder
    is carried forward, so the parts sum to the whole exactly.
    """
    if not weights or total_frames <= 0:
        raise BuildError("nothing to time")
    if len(weights) > total_frames:
        raise BuildError(f"{len(weights)} scenes will not fit in "
                         f"{total_frames} frames — the audio is too short.")
    span = sum(weights)
    out, used, acc = [], 0, 0.0
    for i, w in enumerate(weights):
        if i == len(weights) - 1:
            out.append(total_frames - used)
            break
        acc += w / span * total_frames
        n = max(1, round(acc) - used)
        out.append(n)
        used += n
    # The carry can leave the last scene short when earlier ones rounded up.
    if out[-1] < 1:
        raise BuildError("rounding left a scene with no frames; give the "
                         "shorter scenes more weight or use a longer audio "
                         "track.")
    return out


# ── the filter graph ─────────────────────────────────────────────────────

def scene_filter(img_idx: int, out_label: str) -> str:
    """One scene: fill the frame, then drift in.

    d=1 is the whole point. zoompan emits d frames per INPUT frame; with the
    input bounded by -t the input already carries the right number, so one
    output frame per input frame is what keeps the segment its stated length
    and lets it reach end-of-stream so concat can move on. `zoom` carries
    across frames, so the drift still accumulates.
    """
    return (
        f"[{img_idx}:v]"
        f"scale={W}:{H}:force_original_aspect_ratio=increase,"
        f"crop={W}:{H},"
        f"zoompan=z='min(zoom+{ZOOM_STEP},{ZOOM_MAX})':d=1:s={W}x{H}:fps={FPS},"
        f"setsar=1,format=yuv420p[{out_label}]"
    )


def build_command(audio: Path, scenes: list[dict], out: Path,
                  crf: int, preset: str) -> list[str]:
    args = [need_tool("ffmpeg"), "-y", "-i", str(audio)]
    for s in scenes:
        # -t BOUNDS the loop. Without it the stream never ends and every
        # scene after the first is unreachable.
        args += ["-loop", "1", "-t", f"{s['frames'] / FPS:.6f}",
                 "-framerate", str(FPS), "-i", str(s["image"])]

    parts = [scene_filter(i + 1, f"v{i}") for i in range(len(scenes))]
    chain = "".join(f"[v{i}]" for i in range(len(scenes)))
    parts.append(f"{chain}concat=n={len(scenes)}:v=1:a=0[vout]")

    args += [
        "-filter_complex", ";".join(parts),
        "-map", "[vout]", "-map", "0:a",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out),
    ]
    return args


# ── spec loading ─────────────────────────────────────────────────────────

DEFAULT_SCENES = [
    ("scene1_hook.png", "HOOK"),
    ("scene2_question.png", "QUESTION"),
    ("scene3_record.png", "THE RECORD"),
    ("scene4_pattern.png", "THE PATTERN"),
    ("scene5_disclaimer.png", "WHAT IT DOES NOT PROVE"),
    ("scene6_matters.png", "WHY IT MATTERS"),
    ("scene7_next.png", "NEXT RECORD"),
]


def load_scenes(workspace: Path, spec_path: Path | None) -> list[dict]:
    """Scenes, with a weight each.

    A spec entry may carry `suggested_duration`; those become the weights, so
    a long beat stays long. Without a spec every scene weighs the same, which
    is the old behaviour — stated, rather than assumed.
    """
    if spec_path:
        try:
            data = json.loads(spec_path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            raise BuildError(f"could not read {spec_path}: {e}")
        rows = data.get("scenes", data) if isinstance(data, dict) else data
        if not isinstance(rows, list) or not rows:
            raise BuildError(f"{spec_path} contains no scenes.")
        scenes = []
        for i, r in enumerate(rows):
            img = r.get("image") or r.get("png")
            if not img:
                img = DEFAULT_SCENES[i][0] if i < len(DEFAULT_SCENES) else None
            if not img:
                raise BuildError(f"scene {i + 1} in {spec_path.name} names no "
                                 f"image and there is no default for it.")
            p = Path(img)
            scenes.append({
                "image": p if p.is_absolute() else workspace / p,
                "label": r.get("beat") or r.get("label") or f"SC-{i + 1:03d}",
                "weight": float(r.get("suggested_duration") or 1.0),
            })
        return scenes
    return [{"image": workspace / f, "label": lab, "weight": 1.0}
            for f, lab in DEFAULT_SCENES]


def check_inputs(audio: Path, scenes: list[dict]) -> None:
    missing = [str(audio)] if not audio.is_file() else []
    missing += [str(s["image"]) for s in scenes if not s["image"].is_file()]
    if missing:
        raise BuildError("missing input file(s):\n  " + "\n  ".join(missing))


# ── main ─────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--workspace", default="/home/user/workspace", type=Path)
    ap.add_argument("--audio", type=Path, help="narration; default "
                    "<workspace>/ohio_narration.mp3")
    ap.add_argument("--out", type=Path, help="default "
                    "<workspace>/ohio_documentary.mp4")
    ap.add_argument("--spec", type=Path, help="scene JSON; uses each entry's "
                    "suggested_duration as its share of the runtime")
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--dry-run", action="store_true",
                    help="preflight and print the timing; render nothing")
    a = ap.parse_args()

    ws = a.workspace
    audio = a.audio or ws / "ohio_narration.mp3"
    out = a.out or ws / "ohio_documentary.mp4"

    try:
        need_tool("ffmpeg")
        scenes = load_scenes(ws, a.spec)
        check_inputs(audio, scenes)
        seconds = probe_duration(audio)

        total = max(len(scenes), round(seconds * FPS))
        for s, n in zip(scenes, scene_frames([s["weight"] for s in scenes], total)):
            s["frames"] = n
    except BuildError as e:
        print(f"\n  {e}\n", file=sys.stderr)
        return 2

    print(f"\n  narration  {audio.name}  {seconds:.2f}s  "
          f"({total} frames @ {FPS}fps)")
    if a.spec:
        given = sum(s["weight"] for s in scenes)
        print(f"  spec       {a.spec.name} — {len(scenes)} scenes totalling "
              f"{given:.1f}s, scaled to the narration")
    else:
        print(f"  spec       none — {len(scenes)} equal scenes")
    print()
    for s in scenes:
        print(f"    {s['frames'] / FPS:6.2f}s  {s['label']:<24} "
              f"{s['image'].name}")
    # The parts sum to the whole, so nothing is trimmed off the last words.
    assert sum(s["frames"] for s in scenes) == total
    print(f"\n    {total / FPS:6.2f}s  TOTAL — matches the narration exactly")

    cmd = build_command(audio, scenes, out, a.crf, a.preset)
    if a.dry_run:
        print("\n  DRY RUN — nothing rendered.\n")
        return 0

    print(f"\n  rendering → {out}")
    # stderr is NOT captured: a multi-minute encode with no output looks hung.
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print(f"\n  ffmpeg exited {r.returncode}. Nothing was written.\n",
              file=sys.stderr)
        return 1
    if not out.is_file():
        print("\n  ffmpeg reported success but wrote no file.\n", file=sys.stderr)
        return 1

    digest = sha256_file(out)
    manifest = out.with_suffix(".manifest.json")
    manifest.write_text(json.dumps({
        "output": str(out),
        "sha256": digest,
        "bytes": out.stat().st_size,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "fps": FPS, "size": f"{W}x{H}",
        "narration": {"path": str(audio), "sha256": sha256_file(audio),
                      "seconds": round(seconds, 3)},
        "scenes": [{"label": s["label"], "image": str(s["image"]),
                    "sha256": sha256_file(s["image"]),
                    "seconds": round(s["frames"] / FPS, 3)} for s in scenes],
    }, indent=2) + "\n")

    print(f"\n  {out}")
    print(f"  {out.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"  sha256    {digest}")
    print(f"  manifest  {manifest.name}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
