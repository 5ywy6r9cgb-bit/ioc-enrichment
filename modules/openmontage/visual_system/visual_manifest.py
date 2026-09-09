#!/usr/bin/env python3
"""
visual_manifest.py — the photo library, inventoried and under custody.

Scans a folder of photographs and writes two files beside it:

    visual_manifest.json              WHAT IS THERE — machine-generated, never
                                      hand-edited. Rewritten on every run.
    visual_editorial_overrides.json   WHAT YOU DECIDED — human-owned. Merged
                                      forward on every run and never clobbered.

That split is the whole design. A rescan must be safe to run at any time, so
the facts about a file (its hash, its size, its EXIF) are re-derived every
time, while your judgement about it (is this usable, is it cleared, what is it
of) is preserved and only ever added to.

WHY IT EXISTS

`evidence/` holds originals and is never rendered. `assets/` holds crops that
are. Between them sits a folder of raw photographs, and until now nothing knew
what was in it. This is the thing that knows.

It also closes the gap the shot list left open: a photograph carries no
provenance unless something records it. Here every image gets a stable
`visual_id` derived from its content hash, so a photo can be cited by ID in an
episode spec and verified later even if the filename changes.

THREE THINGS IT CATCHES

  Exact duplicates      same SHA-256. The same shot copied twice under two
                        names, which is how a library quietly doubles in size.
  Near duplicates       perceptual hash within a Hamming threshold. Burst
                        shots, the same frame re-exported, a re-crop. You
                        almost always want one of these, not five.
  Hard links            same device+inode. Two paths, one file — deleting one
                        does not free anything, and editing one edits both.

APPROVAL IS A GATE, NOT A LABEL

Every image lands as `review_status: unreviewed` and
`approved_for_documentary: false`. Nothing you have not looked at can be
published. `--approved` lists what has cleared; the montage engine can read
that list and refuse anything else.

USAGE

    python3 visual_manifest.py ~/Pictures/TSR
    python3 visual_manifest.py ~/Pictures/TSR --check-only
    python3 visual_manifest.py ~/Pictures/TSR --threshold 8
    python3 visual_manifest.py ~/Pictures/TSR --approved
    python3 visual_manifest.py ~/Pictures/TSR --backgrounds
    python3 visual_manifest.py "~/Pictures/Photos Library.photoslibrary/originals" \\
        --manifest-dir ~/Pictures/TSR-records     # source never written to
    python3 visual_manifest.py --find          # where are my photos?
    python3 visual_manifest.py --self-test

Requires: pillow, imagehash, piexif, pillow-heif

    pip install pillow numpy imagehash piexif pillow-heif

piexif is optional — GPS is skipped without it rather than failing.
pillow-heif is NOT optional if your photographs came off an iPhone: HEIC is
the default capture format and Pillow cannot open one without it. Every .heic
is reported unreadable until it is installed, which looks like file corruption
and is not.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image
except ImportError:                                    # pragma: no cover
    sys.exit("visual_manifest needs Pillow.  pip install pillow")

try:
    import imagehash
except ImportError:                                    # pragma: no cover
    sys.exit("visual_manifest needs ImageHash.  pip install ImageHash")

try:
    import piexif
except ImportError:                                    # GPS is a bonus, not a
    piexif = None                                      # requirement

# HEIC is the DEFAULT iPhone photo format, and Pillow cannot open one on its
# own — it needs pillow-heif to register a decoder. Without it every .heic in
# a library fails with `UnidentifiedImageError: cannot identify image file`,
# which reads like a corrupt file and is not: the file is fine, the reader is
# missing. Listing .heic as supported while being unable to open one is the
# tool lying about its own coverage, so the gap is now named at the point it
# bites.
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIF_OK = True
except ImportError:
    HEIF_OK = False

MANIFEST_VERSION = 1
OVERRIDES_VERSION = 1
MANIFEST_NAME = "visual_manifest.json"
OVERRIDES_NAME = "visual_editorial_overrides.json"

SUPPORTED = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".heic", ".heif"}

# Video is NOT inventoried. It is counted and reported, because a folder that
# holds 400 clips and says nothing about them reads as "there is no video
# here", and a silent omission in an evidence tool is the worst kind. Stills
# and video need different machinery — no PIL, no perceptual hash, metadata
# via ffprobe rather than EXIF — so until that exists these are named, not
# quietly skipped.
VIDEO = {".mov", ".mp4", ".m4v", ".avi", ".mkv", ".hevc", ".mts", ".m2ts", ".webm"}
DEFAULT_THRESHOLD = 5           # Hamming distance over a 64-bit perceptual hash
REVIEW_STATES = {"unreviewed", "reviewed", "rejected"}
POLICY_NAME = "visual_policy.json"

# Where an image came from. This is the field that decides what it may be used
# for, and it is the reason this tool exists rather than a folder of JPEGs.
#
#   own_camera      shot by you, on a device this library recognises
#   own_screenshot  a capture you made of something on your own screen
#   licensed        someone else's, with a licence you can produce on request
#   generated       made by a model. NEVER documentary — see below.
#   third_party     someone else's, no licence recorded
#   unknown         no attribution at all
#
# THE RULE THAT MATTERS: only own_camera, own_screenshot and licensed may be
# approved for documentary use. A generated image can be approved for
# ILLUSTRATION only, and the montage engine stamps a visible label on it.
#
# This is not squeamishness. The entire claim of this newsroom is that every
# frame traces to a record. One generated photograph of a real building,
# presented as a photograph of that building, retires that claim permanently —
# and it would be discovered, because generated images are detectable and
# because someone always checks. So the rule is enforced here instead of
# remembered at 2 a.m.
ORIGINS = {"own_camera", "own_screenshot", "licensed",
           "generated", "third_party", "unknown"}
DOCUMENTARY_ORIGINS = {"own_camera", "own_screenshot", "licensed"}


# ---------------------------------------------------------------- utilities
def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def atomic_write_json(path: Path, data) -> None:
    """Write via a temp file in the same directory, then rename.

    A half-written manifest is worse than no manifest — it looks valid and is
    not. os.replace is atomic on the same filesystem, so a crash mid-write
    leaves the previous file intact.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp",
                               dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def visual_id(digest: str) -> str:
    """Stable id derived from content, so renaming a file does not orphan the
    editorial record attached to it."""
    return f"vis_{digest[:24]}"


def default_policy() -> dict:
    return {
        "version": 1,
        "_note": ("Devices you own. An image whose EXIF Make/Model matches one "
                  "of these is classified own_camera automatically. Anything "
                  "unattributed stays 'unknown' and cannot be approved for "
                  "documentary use."),
        "own_devices": [],
        "_own_devices_example": ["Apple iPhone 15 Pro", "Apple iPhone SE"],

        # --- authorship -------------------------------------------------
        # Copyright in a photograph exists the moment it is taken; nothing
        # here creates it. What this block does is record, once, the facts a
        # registration application asks for and that nobody can reconstruct
        # from a folder of JPEGs two years later: who made it, under what
        # name the claim is held, and whether it has been published.
        #
        # NOT LEGAL ADVICE, and deliberately not a filing tool. It produces
        # the schedule of works — `--registration` — and the filing is yours.
        "copyright": {
            "_note": ("Filled in once. Every image in this library inherits it "
                      "unless its editorial record overrides it."),
            "author": "",
            "_author_example": "Mark W. Griswold",
            "claimant": "",
            "_claimant_note": ("Who holds the copyright — usually the same as "
                               "author. Different if you have assigned it to a "
                               "business entity."),
            "work_type": "photograph",
            "default_publication_status": "unpublished",
            "_publication_note": (
                "unpublished | published. This is the field people get wrong. "
                "Posting a photograph publicly is generally publication; "
                "keeping it in a private archive is not. It matters because "
                "the Copyright Office groups published and unpublished works "
                "under different procedures and a group cannot mix them."),
            "notice_year": "",
            "_notice_note": ("Year of first publication, for the © line. Blank "
                             "until something is published."),
        },
    }


def notice_string(policy: dict) -> str:
    """The © line for this library, from the policy. Empty if not declared."""
    c = policy.get("copyright", {}) or {}
    holder = str(c.get("claimant") or c.get("author") or "").strip()
    year = str(c.get("notice_year") or "").strip()
    if not holder:
        return ""
    return f"© {year} {holder}. All rights reserved." if year \
        else f"© {holder}. All rights reserved."


def load_policy(path: Path) -> dict:
    if not path.exists():
        return default_policy()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path} is not valid JSON: line {e.lineno}, {e.msg}") from e
    if not isinstance(data.get("own_devices"), list):
        raise ValueError(f"{path}: 'own_devices' must be a list of device names")
    return data


def classify_origin(exif: dict, override: dict, own_devices: list) -> str:
    """Decide where an image came from.

    A declared origin in the overrides file always wins — you know things EXIF
    does not, and licensing in particular can only ever be asserted by a human.
    Otherwise a device match makes it own_camera, and everything else is
    unknown until someone says otherwise.
    """
    declared = str(override.get("origin", "") or "").strip()
    if declared in ORIGINS and declared != "unknown":
        return declared
    make = str(exif.get("make", "")).strip()
    model = str(exif.get("model", "")).strip()
    if make or model:
        label = f"{make} {model}".strip()
        for own in own_devices:
            o = str(own).strip().lower()
            if o and (o == label.lower() or o in label.lower()):
                return "own_camera"
    return "unknown"


# --------------------------------------------------------------------- exif
def _ratio(v) -> float:
    if hasattr(v, "numerator") and hasattr(v, "denominator"):
        return float(v.numerator) / float(v.denominator)
    if isinstance(v, (tuple, list)) and len(v) == 2:
        return float(v[0]) / float(v[1])
    return float(v)


def parse_gps(gps: dict) -> dict | None:
    """Decode EXIF GPS into decimal degrees, or None if it is not there.

    Worth knowing: a photograph taken on a phone usually carries the exact
    coordinates it was taken at. That is useful for you and a disclosure risk
    for anyone else, which is why coordinates are recorded here and never
    rendered into a frame.
    """
    try:
        lat, lon = gps.get(2), gps.get(4)
        if not lat or not lon:
            return None
        latitude = _ratio(lat[0]) + _ratio(lat[1]) / 60 + _ratio(lat[2]) / 3600
        longitude = _ratio(lon[0]) + _ratio(lon[1]) / 60 + _ratio(lon[2]) / 3600
        if gps.get(1) in (b"S", "S"):
            latitude = -latitude
        if gps.get(3) in (b"W", "W"):
            longitude = -longitude
        return {"latitude": round(latitude, 6), "longitude": round(longitude, 6)}
    except (TypeError, ValueError, ZeroDivisionError, IndexError, KeyError):
        return None


def _txt(v) -> str:
    return v.decode("utf-8", "replace").strip("\x00 ") if isinstance(v, bytes) \
        else str(v).strip()


def extract_exif(path: Path, image) -> tuple[dict, str, str]:
    """Return (exif dict, where it came from, parse status).

    Reported honestly: 'absent' and 'parse_error' are different things, and a
    file with no metadata is a different evidentiary object from one whose
    metadata would not parse.
    """
    if piexif is None:
        return {}, "none", "piexif_not_installed"
    raw = image.info.get("exif")
    source = "image.info"
    if not raw:
        try:
            raw = image.getexif().tobytes()
            source = "getexif"
        except Exception:
            raw = None
    if not raw:
        return {}, source, "absent"
    try:
        data = piexif.load(raw)
    except Exception:
        return {}, source, "parse_error"

    out: dict = {}
    gps = parse_gps(data.get("GPS", {}) or {})
    if gps:
        out["gps"] = gps
    zeroth = data.get("0th", {}) or {}
    exif_ifd = data.get("Exif", {}) or {}
    for key, tag, src in (("make", piexif.ImageIFD.Make, zeroth),
                          ("model", piexif.ImageIFD.Model, zeroth)):
        if tag in src:
            out[key] = _txt(src[tag])
    for key, tag in (("datetime_original", piexif.ExifIFD.DateTimeOriginal),):
        if tag in exif_ifd:
            out[key] = _txt(exif_ifd[tag])
    return out, source, "complete"


# --------------------------------------------------------------- overrides
def default_override(vid: str) -> dict:
    """A new photo is unreviewed and unapproved. Both, deliberately."""
    return {
        "visual_id": vid,
        "classification": [],
        "tags": [],
        "description": "",
        "location_label": "",
        "credit": "",
        # blank means "work it out from EXIF". Set it explicitly to declare
        # something the file cannot tell us — a licence, or a generated image.
        "origin": "",
        "license_ref": "",
        "generation": {},
        "editorial_notes": "",
        "review_status": "unreviewed",
        "reviewed_at": None,
        "reviewer": None,
        "approved_for_documentary": False,
        "usage": [],
    }


# fields added after the first release; an older overrides file is upgraded in
# place rather than rejected
OPTIONAL_FIELDS = {"origin", "license_ref", "generation"}


def validate_override(record, where: str = "override") -> None:
    if not isinstance(record, dict):
        raise ValueError(f"{where}: must be an object")
    for k in OPTIONAL_FIELDS:
        record.setdefault(k, {} if k == "generation" else "")
    missing = set(default_override("x")) - set(record) - OPTIONAL_FIELDS
    if missing:
        raise ValueError(f"{where}: missing field(s) {sorted(missing)}")
    for key in ("classification", "tags", "usage"):
        if not isinstance(record[key], list):
            raise ValueError(f"{where}: '{key}' must be a list")
    if not isinstance(record["approved_for_documentary"], bool):
        raise ValueError(f"{where}: 'approved_for_documentary' must be true or false")
    origin = str(record.get("origin", "") or "")
    if origin and origin not in ORIGINS:
        raise ValueError(f"{where}: origin {origin!r} is not one of "
                         f"{sorted(ORIGINS)}")
    if record["review_status"] not in REVIEW_STATES:
        raise ValueError(f"{where}: review_status {record['review_status']!r} "
                         f"is not one of {sorted(REVIEW_STATES)}")


def load_overrides(path: Path) -> dict:
    if not path.exists():
        return {"version": OVERRIDES_VERSION, "visuals": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path} is not valid JSON: line {e.lineno}, {e.msg}") from e
    if not isinstance(data, dict) or not isinstance(data.get("visuals"), dict):
        raise ValueError(f"{path}: expected an object with a 'visuals' object")
    for vid, rec in data["visuals"].items():
        validate_override(rec, where=f"{path.name}:{vid}")
    return data


def load_previous(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}          # a corrupt manifest is regenerated, not fatal


# ----------------------------------------------------------------- scanning
def collect_images(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*")
                  if p.is_file() and not p.name.startswith(".")
                  and p.suffix.lower() in SUPPORTED)


def collect_videos(root: Path) -> list[Path]:
    """Video files present but not inventoried. Reported, never silently skipped."""
    return sorted(p for p in root.rglob("*")
                  if p.is_file() and not p.name.startswith(".")
                  and p.suffix.lower() in VIDEO)


LOW_DETAIL_STDDEV = 12.0        # grayscale standard deviation, 0-255 scale


def detail_stddev(im) -> float:
    """How much variation the image actually contains.

    A perceptual hash describes structure, and an image with almost no
    structure — a blank wall, a white page, an overexposed sky — produces a
    near-degenerate hash. Two unrelated flat images then land within any
    sensible Hamming threshold and get reported as near-duplicates, which is
    wrong and, worse, trains you to ignore the warning.

    So flat images are measured and excluded from similarity grouping. They are
    still hashed, still inventoried, still exact-duplicate checked — only the
    perceptual comparison is skipped, because for them it means nothing.
    """
    px = im.convert("L").resize((64, 64)).tobytes()
    n = len(px)
    mean = sum(px) / n
    return (sum((v - mean) ** 2 for v in px) / n) ** 0.5


def background_fitness(im, target_w: int = 1080, target_h: int = 1920) -> dict:
    """Can this photograph hold type at the target aspect?

    This is a measurement, not taste. A photograph works as a background when
    the region where words sit is calm enough to read against and dark enough
    for the scrim to finish the job — and when there are enough pixels to fill
    the frame without upscaling. All three are measurable, so they are measured
    and reported rather than judged by eye across two thousand files.

    What it does NOT claim: that the picture is good, that it means anything,
    or that it belongs in a particular episode. Those are yours. This only
    rules out the ones that cannot physically work, which is most of the labour
    and none of the judgement.

    The type band is the lower-middle of the frame, where the engine puts
    caption and credit over its scrim. A busy band there is the single most
    common reason a beautiful photograph is unusable behind words.
    """
    from PIL import ImageFilter, ImageStat

    w, h = im.size
    target_ratio = target_w / target_h

    # centre-crop to the target aspect, which is what full-bleed rendering does
    if w / h > target_ratio:
        cw, ch = int(h * target_ratio), h
    else:
        cw, ch = w, int(w / target_ratio)
    left, top = (w - cw) // 2, (h - ch) // 2
    crop = im.convert("L").crop((left, top, left + cw, top + ch))

    # resolution is a gate, not a score: upscaling a small photo to fill a
    # 1080x1920 frame looks soft in a way no amount of grading fixes
    scale = min(cw / target_w, ch / target_h)
    enough_pixels = scale >= 1.0

    work = crop.resize((270, 480))
    band = work.crop((0, int(480 * 0.55), 270, int(480 * 0.85)))

    def busyness(img) -> float:
        # FIND_EDGES lights up the outer border of whatever it is given, so
        # trim a pixel before measuring or every crop reads as busy
        e = img.filter(ImageFilter.FIND_EDGES)
        e = e.crop((1, 1, e.width - 1, e.height - 1))
        return ImageStat.Stat(e).mean[0]

    band_busy = busyness(band)
    frame_busy = busyness(work)
    band_luma = ImageStat.Stat(band).mean[0]

    # Thresholds from measuring real frames, not from theory. Around 12 the
    # band is calm enough that white type reads with the scrim alone; past
    # ~28 no scrim saves it.
    calm = max(0.0, min(100.0, 100.0 - (band_busy - 6.0) * (100.0 / 22.0)))
    # the engine darkens the lower frame, so a mid-to-dark band is ideal and a
    # blown-out one is the hard case
    luma_fit = max(0.0, min(100.0, 100.0 - max(0.0, band_luma - 140.0) * 1.4))
    score = round(0.65 * calm + 0.35 * luma_fit, 1) if enough_pixels else 0.0

    if not enough_pixels:
        verdict = f"too small — {cw}x{ch} after crop, needs {target_w}x{target_h}"
    elif band_busy > 28:
        verdict = "too busy where the type sits"
    elif band_luma > 190:
        verdict = "usable, but the band is bright — expect a heavy scrim"
    elif score >= 70:
        verdict = "good background"
    elif score >= 50:
        verdict = "workable background"
    else:
        verdict = "poor background"

    return {
        "target": f"{target_w}x{target_h}",
        "score": score,
        "verdict": verdict,
        "type_band_busyness": round(band_busy, 2),
        "type_band_luma": round(band_luma, 1),
        "frame_busyness": round(frame_busy, 2),
        "crop_px": f"{cw}x{ch}",
        "enough_pixels": enough_pixels,
    }


def build_record(path: Path, root: Path, prev_by_sha: dict) -> dict:
    st = path.stat()
    digest = sha256_file(path)
    with Image.open(path) as im:
        width, height = im.size
        phash = str(imagehash.phash(im))
        stddev = detail_stddev(im)
        fitness = background_fitness(im)
        exif, meta_src, meta_status = extract_exif(path, im)
        fmt = im.format
    prev = prev_by_sha.get(digest, {})
    return {
        "visual_id": visual_id(digest),
        "filename": path.name,
        "relative_path": str(path.relative_to(root)),
        "sha256": digest,
        "size_bytes": st.st_size,
        "mtime_ns": st.st_mtime_ns,
        "inode": st.st_ino,
        "device": st.st_dev,
        "mode": stat.filemode(st.st_mode),
        "mime_type": mimetypes.guess_type(path.name)[0],
        "format": fmt,
        "width": width,
        "height": height,
        "orientation": ("landscape" if width > height else
                        "portrait" if height > width else "square"),
        "phash": phash,
        "detail_stddev": round(stddev, 2),
        # too flat for a perceptual hash to mean anything — see detail_stddev()
        "low_detail": stddev < LOW_DETAIL_STDDEV,
        # measured suitability as a full-bleed background behind type
        "background": fitness,
        # first time we ever saw this content, carried forward across rescans
        "discovered_at": prev.get("discovered_at", utc_now()),
        "provenance": {
            "inventory_source": "filesystem",
            "content_hash": "sha256",
            "metadata_source": meta_src,
            "metadata_parse_status": meta_status,
        },
        "exif": exif,
    }


def hamming(a: str, b: str) -> int:
    return imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)


def similarity_groups(records: list[dict], threshold: int) -> list[list[dict]]:
    """Group perceptually similar images.

    O(n²) on purpose. A personal photo library is thousands of images, not
    millions, and an exact pairwise comparison is easier to trust than an
    approximate index. If this ever gets slow, that is the moment to reach for
    BK-trees — not before.
    """
    # flat images are excluded: their hashes are degenerate and would group
    # everything featureless together
    records = [r for r in records if not r.get("low_detail")]
    groups, seen = [], set()
    for i, rec in enumerate(records):
        if i in seen:
            continue
        group = [rec]
        seen.add(i)
        for j in range(i + 1, len(records)):
            if j in seen:
                continue
            if hamming(rec["phash"], records[j]["phash"]) <= threshold:
                group.append(records[j])
                seen.add(j)
        if len(group) > 1:
            groups.append(group)
    return groups


def resolve_library(spec: str) -> tuple[Path, object | None]:
    """Accept a shelf name or a path, and refuse an absent drive by name.

    A photo library on a flash drive introduces a failure with no local
    equivalent: AN UNPLUGGED DRIVE SCANS AS AN EMPTY LIBRARY. Zero images
    prints calmly and exits clean, and reads as "there are no photographs"
    when the fact is "nobody looked." macOS makes it worse — eject a drive
    uncleanly and /Volumes/NAME survives as an empty folder, so every path
    under it still resolves.

    modules/corpus/shelf.py already solved this for the document corpus, down
    to the four distinct ways /Volumes lies. Rather than learn it twice, this
    borrows it when it is importable and falls back to a plain path when it is
    not.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "corpus"))
        import shelf
        return shelf.resolve_root(spec)
    except ImportError:
        p = Path(spec).expanduser()
        if not p.is_dir():
            raise NotADirectoryError(f"visual library does not exist: {p}")
        return p.resolve(), None


def inventory(root: Path, threshold: int = DEFAULT_THRESHOLD,
              write: bool = True, manifest_dir: Path | None = None) -> dict:
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"visual library does not exist: {root}")

    # Where the three sidecar files live. By default beside the photographs,
    # which is right for a folder you own. `manifest_dir` puts them somewhere
    # else so the source tree is never written to at all — the case that
    # matters is an Apple Photos package, where the originals are perfectly
    # readable but writing anything inside risks the library's own database.
    # Read-only source, records kept elsewhere.
    side = Path(manifest_dir).expanduser().resolve() if manifest_dir else root
    if manifest_dir:
        side.mkdir(parents=True, exist_ok=True)

    manifest_path = side / MANIFEST_NAME
    policy_path = side / POLICY_NAME
    overrides_path = side / OVERRIDES_NAME

    previous = load_previous(manifest_path)
    prev_by_sha = {v["sha256"]: v for v in previous.get("visuals", [])
                   if isinstance(v, dict) and isinstance(v.get("sha256"), str)}

    videos = collect_videos(root)
    records, errors = [], []
    for p in collect_images(root):
        try:
            records.append(build_record(p, root, prev_by_sha))
        except Exception as exc:
            # one unreadable file must not abandon the scan
            msg = f"{type(exc).__name__}: {exc}"
            if not HEIF_OK and p.suffix.lower() in {".heic", ".heif"}:
                msg = ("HEIC decoder not installed — the file is fine, the "
                       "reader is missing. Run: pip install pillow-heif")
            errors.append({"relative_path": str(p.relative_to(root)),
                           "error": msg})

    # --- merge editorial judgement forward. Existing records are never touched.
    overrides = load_overrides(overrides_path)
    ids = {r["visual_id"] for r in records}
    added = 0
    for vid in sorted(ids):
        if vid not in overrides["visuals"]:
            overrides["visuals"][vid] = default_override(vid)
            added += 1
    orphans = sorted(set(overrides["visuals"]) - ids)

    # --- integrity
    by_sha, by_inode = {}, {}
    for r in records:
        by_sha.setdefault(r["sha256"], []).append(r["relative_path"])
        by_inode.setdefault(f"{r['device']}:{r['inode']}", []).append(r["relative_path"])
    exact_dupes = sorted([v for v in by_sha.values() if len(v) > 1])
    hard_links = sorted([v for v in by_inode.values() if len(v) > 1])
    # A near-duplicate group that is ALSO an exact-duplicate group tells you
    # nothing new — the same pair was already reported, byte-identical, one
    # section above. On a real library that was 150 of 169 groups: the useful
    # signal (a re-crop, a burst, a re-export) buried under restatement of
    # something already known. One representative per SHA-256 goes into the
    # perceptual pass, so what survives is genuinely "similar but not the same".
    one_per_sha, seen_sha = [], set()
    for r in records:
        if r["sha256"] not in seen_sha:
            seen_sha.add(r["sha256"])
            one_per_sha.append(r)
    similar = similarity_groups(one_per_sha, threshold)
    low_detail = sorted(r["relative_path"] for r in records if r["low_detail"])

    # --- origin. Stamp each record, then enforce what its origin permits.
    policy = load_policy(policy_path)
    own_devices = policy.get("own_devices", [])
    for r in records:
        ov = overrides["visuals"].get(r["visual_id"], {})
        r["origin"] = classify_origin(r["exif"], ov, own_devices)
        r["documentary_eligible"] = r["origin"] in DOCUMENTARY_ORIGINS
    origin_of = {r["visual_id"]: r["origin"] for r in records}

    # An approval flag on an image whose origin does not permit documentary use
    # is REFUSED, not honoured. Ticking the box does not make a generated image
    # a photograph, and the failure mode this prevents — a model's picture of a
    # real building going out as a record of that building — is unrecoverable.
    approved, blocked = [], []
    for vid, rec in overrides["visuals"].items():
        if vid not in ids or not rec.get("approved_for_documentary"):
            continue
        origin = origin_of.get(vid, "unknown")
        if origin in DOCUMENTARY_ORIGINS:
            approved.append(vid)
        else:
            blocked.append({"visual_id": vid, "origin": origin,
                            "reason": ("generated imagery is never documentary"
                                       if origin == "generated" else
                                       f"origin '{origin}' carries no attribution")})
    approved = sorted(approved)
    blocked = sorted(blocked, key=lambda x: x["visual_id"])
    illustration_only = sorted(
        vid for vid, rec in overrides["visuals"].items()
        if vid in ids and rec.get("approved_for_documentary")
        and origin_of.get(vid) == "generated")
    reviewed = sum(1 for vid, rec in overrides["visuals"].items()
                   if vid in ids and rec.get("review_status") != "unreviewed")

    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "generated_at": utc_now(),
        "root": str(root),
        # Authorship travels with the inventory, so a registration schedule
        # can be produced from the manifest alone — including from a copy of
        # it on another machine, months later.
        "copyright_policy": policy.get("copyright", {}),
        "notice": notice_string(policy),
        "editorial": overrides["visuals"],
        "similarity_engine": {"algorithm": "phash", "hash_bits": 64,
                              "distance_metric": "hamming", "threshold": threshold},
        "records_dir": str(side),
        "counts": {
            "images": len(records),
            "videos_not_inventoried": len(videos),
            "unreadable": len(errors),
            "exact_duplicate_groups": len(exact_dupes),
            "hard_link_groups": len(hard_links),
            "similarity_groups": len(similar),
            "low_detail_excluded": len(low_detail),
            "orphan_editorial_records": len(orphans),
            "reviewed": reviewed,
            "approved_for_documentary": len(approved),
            "approval_blocked_by_origin": len(blocked),
            "unattributed": sum(1 for r in records if r["origin"] == "unknown"),
        },
        "visuals": records,
        "integrity": {
            "exact_duplicate_groups": exact_dupes,
            "hard_link_groups": hard_links,
            "similarity_groups": [
                [{"visual_id": r["visual_id"], "relative_path": r["relative_path"],
                  "phash": r["phash"]} for r in g] for g in similar],
            "orphan_editorial_records": orphans,
            "low_detail_excluded_from_similarity": low_detail,
            "approval_blocked_by_origin": blocked,
            "unreadable": errors,
        },
        "approved_for_documentary": approved,
        "illustration_only": illustration_only,
        "origin_counts": {o: sum(1 for r in records if r["origin"] == o)
                          for o in sorted(ORIGINS)
                          if any(r["origin"] == o for r in records)},
    }

    if write:
        atomic_write_json(manifest_path, manifest)
        atomic_write_json(overrides_path, overrides)
        if not policy_path.exists():
            atomic_write_json(policy_path, policy)
    manifest["_paths"] = {"manifest": str(manifest_path),
                          "overrides": str(overrides_path), "new_records": added}
    return manifest


# ------------------------------------------------------------------ output
def print_summary(m: dict, check_only: bool) -> None:
    c = m["counts"]
    print()
    print(f"  VISUAL LIBRARY · {m['root']}")
    print(f"  {c['images']} image(s)"
          + (f" · {c['unreadable']} unreadable" if c["unreadable"] else ""))
    unread = m["integrity"].get("unreadable", [])
    heic_blocked = [e for e in unread if "HEIC decoder" in e.get("error", "")]
    if heic_blocked:
        print()
        print(f"  {len(heic_blocked)} HEIC file(s) COULD NOT BE READ — and HEIC "
              f"is the default")
        print( "  iPhone photo format, so these are probably your camera "
               "originals.")
        print( "  Pillow cannot open one without a decoder:")
        print()
        print( "      pip install pillow-heif")
        print()
        print( "  then rescan. Nothing is wrong with the files.")
    if c.get("videos_not_inventoried"):
        print(f"  {c['videos_not_inventoried']} video file(s) SEEN BUT NOT "
              f"INVENTORIED — this tool handles stills only.")
        print(f"  They are not duplicate-checked, not origin-classified, and "
              f"not approvable.")
    print()
    print(f"  reviewed                {c['reviewed']:>5} / {c['images']}")
    print(f"  approved for use        {c['approved_for_documentary']:>5}")
    if c.get("unattributed"):
        print(f"  UNATTRIBUTED            {c['unattributed']:>5}"
              f"  (cannot be used until origin is declared)")
    if m.get("origin_counts"):
        print("  origin                  "
              + ", ".join(f"{k} {v}" for k, v in m["origin_counts"].items()))
    print(f"  exact duplicate groups  {c['exact_duplicate_groups']:>5}")
    print(f"  near-duplicate groups   {c['similarity_groups']:>5}"
          f"  (pHash <= {m['similarity_engine']['threshold']})")
    if c["low_detail_excluded"]:
        print(f"  too flat to compare     {c['low_detail_excluded']:>5}"
              f"  (excluded from the above)")
    print(f"  hard-link groups        {c['hard_link_groups']:>5}")
    print(f"  orphaned overrides      {c['orphan_editorial_records']:>5}")

    for grp in m["integrity"]["exact_duplicate_groups"][:5]:
        print(f"\n  IDENTICAL — same SHA-256:")
        for p in grp:
            print(f"    {p}")
    for grp in m["integrity"]["similarity_groups"][:5]:
        print(f"\n  NEAR-DUPLICATE — keep one:")
        for r in grp:
            print(f"    {r['relative_path']}")
    for blk in m["integrity"].get("approval_blocked_by_origin", [])[:5]:
        print(f"\n  APPROVAL REFUSED  {blk['visual_id']}")
        print(f"    origin '{blk['origin']}' — {blk['reason']}")
        print(f"    It stays out of the approved list until its origin says")
        print(f"    otherwise. Generated images can be used as ILLUSTRATION")
        print(f"    only, and the renderer labels them on the frame.")
    for e in m["integrity"]["unreadable"][:5]:
        print(f"\n  UNREADABLE  {e['relative_path']}\n    {e['error']}")

    print()
    if check_only:
        print("  --check-only: nothing was written.")
    else:
        print(f"  -> {m['_paths']['manifest']}")
        print(f"  -> {m['_paths']['overrides']}"
              + (f"   ({m['_paths']['new_records']} new record(s))"
                 if m["_paths"]["new_records"] else ""))
        if c["approved_for_documentary"] == 0 and c["images"]:
            print()
            print("  Nothing is approved yet. Open the overrides file, set")
            print("  \"approved_for_documentary\": true and \"review_status\":")
            print("  \"reviewed\" on the shots you want, and add a \"credit\".")
    print()


def print_approved(m: dict) -> None:
    by_id = {v["visual_id"]: v for v in m["visuals"]}
    if not m["approved_for_documentary"]:
        print("Nothing approved yet.")
        return
    for vid in m["approved_for_documentary"]:
        r = by_id[vid]
        print(f"{vid}  {r['orientation']:<9} {r['width']}x{r['height']:<6} "
              f"{r['relative_path']}")


def write_registration(m: dict, out_dir: Path) -> dict:
    """Write the schedule of works a group registration application asks for.

    WHAT THIS IS. The Copyright Office wants, for each photograph in a group,
    a title and a date — and for published groups, the date of publication.
    That is a spreadsheet, and building it by hand from 800 files is how
    people give up on registering at all. Everything needed is already in the
    manifest: content hash, EXIF capture date, declared author.

    WHAT THIS IS NOT. Not legal advice, not a filing, and not a judgement
    about whether a work qualifies or which procedure applies. It produces the
    list. Published and unpublished works are separated because they are filed
    differently and a group cannot mix them — putting them in one file would
    invite exactly that mistake.

    Works with no declared author are listed separately and NOT included.
    A registration naming an author the library cannot evidence is worse than
    a smaller registration.
    """
    import csv
    pol = m.get("copyright_policy", {}) or {}
    author = str(pol.get("author") or "").strip()
    claimant = str(pol.get("claimant") or author).strip()
    default_pub = str(pol.get("default_publication_status") or "unpublished")

    by_id = {v["visual_id"]: v for v in m["visuals"]}
    ed = m.get("editorial", {}) or {}

    rows_pub, rows_unpub, excluded = [], [], []
    for vid, rec in sorted(by_id.items()):
        e = ed.get(vid, {}) or {}
        a = str(e.get("author") or author).strip()
        if not a:
            excluded.append((vid, rec, "no author declared"))
            continue
        if rec.get("origin") == "generated":
            # A model made it. Whatever the law settles on, this library will
            # not put one into a registration claiming human authorship.
            excluded.append((vid, rec, "generated — not claimed as authored"))
            continue
        created = (rec.get("exif", {}) or {}).get("datetime_original") or ""
        year = created[:4] if created[:4].isdigit() else ""
        title = str(e.get("description") or "").strip() or rec["filename"]
        row = {
            "title": title,
            "visual_id": vid,
            "author": a,
            "claimant": claimant,
            "date_created": created,
            "year_created": year,
            "date_published": str(e.get("date_published") or "").strip(),
            "sha256": rec["sha256"],
            "file": rec["relative_path"],
            "width": rec["width"],
            "height": rec["height"],
        }
        status = str(e.get("publication_status") or default_pub).lower()
        (rows_pub if status == "published" else rows_unpub).append(row)

    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for name, rows in (("registration_unpublished.csv", rows_unpub),
                       ("registration_published.csv", rows_pub)):
        if not rows:
            continue
        fp = out_dir / name
        with fp.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        written.append((fp, len(rows)))

    summary = {
        "generated_utc": utc_now(),
        "library": m["root"],
        "author": author,
        "claimant": claimant,
        "notice": m.get("notice", ""),
        "counts": {"published": len(rows_pub), "unpublished": len(rows_unpub),
                   "excluded": len(excluded)},
        "excluded": [{"visual_id": v, "file": r["relative_path"], "reason": why}
                     for v, r, why in excluded],
        "_disclaimer": ("A schedule of works generated from recorded metadata. "
                        "Not legal advice and not a filing."),
    }
    atomic_write_json(out_dir / "registration_summary.json", summary)
    return {"written": written, "summary": summary}


def print_registration(res: dict) -> None:
    s = res["summary"]
    c = s["counts"]
    print()
    print(f"  SCHEDULE OF WORKS · {s['library']}")
    if not s["author"]:
        print()
        print("  NO AUTHOR DECLARED — nothing can be listed.")
        print("  Put your name in visual_policy.json under copyright.author,")
        print("  then run this again.")
        return
    print(f"  author     {s['author']}")
    print(f"  claimant   {s['claimant']}")
    if s.get("notice"):
        print(f"  notice     {s['notice']}")
    print()
    print(f"  unpublished  {c['unpublished']:>5}")
    print(f"  published    {c['published']:>5}")
    if c["excluded"]:
        print(f"  EXCLUDED     {c['excluded']:>5}  (listed in the summary, with reasons)")
    print()
    for fp, n in res["written"]:
        print(f"  -> {fp}  ({n} work(s))")
    print()
    print("  Published and unpublished are separate files because they are")
    print("  filed under different procedures and a group cannot mix them.")
    print()
    print("  This is a schedule of works built from recorded metadata. It is")
    print("  not legal advice and not a filing. Registration procedure, group")
    print("  limits and fees are the Copyright Office's to state — check")
    print("  copyright.gov, or ask a lawyer, before you file.")


def print_backgrounds(m: dict) -> None:
    """Rank by measured fitness behind type. Best first.

    This narrows two thousand photographs to the few dozen that can physically
    hold words, which is the part worth automating. Which of those belongs in
    an episode is not a thing a score knows.
    """
    def _area(v):
        w, h = v["background"]["crop_px"].split("x")
        return int(w) * int(h)

    # Sort by score, then by how close a rejected image is to being usable.
    # When the resolution gate rejects everything, sixty rows of 0.0 in
    # arbitrary order say nothing; the biggest near-misses are the useful end.
    rows = sorted((v for v in m["visuals"] if v.get("background")),
                  key=lambda v: (-v["background"]["score"], -_area(v)))
    if not rows:
        print("No images scanned.")
        return
    usable = [r for r in rows if r["background"]["score"] >= 50]
    too_small = [r for r in rows if not r["background"]["enough_pixels"]]
    print()
    print(f"  BACKGROUND FITNESS · {m['root']}")
    print(f"  {len(usable)} of {len(rows)} can hold type at "
          f"{rows[0]['background']['target']}")

    # If resolution is the blocker for nearly everything, that is one finding
    # about the LIBRARY, not hundreds of findings about photographs.
    if len(too_small) >= len(rows) * 0.9:
        widest = max(int(r["background"]["crop_px"].split("x")[0]) for r in rows)
        print()
        print(f"  RESOLUTION IS THE BLOCKER, not composition — {len(too_small)} "
              f"of {len(rows)} are too small.")
        print(f"  The widest image here is {widest}px after crop; the frame "
              f"needs 1080px.")
        print()
        print("  A whole library under half the needed width is a source "
              "problem, not a")
        print("  photography problem. The usual cause is iCloud 'Optimise Mac "
              "Storage',")
        print("  which replaces originals/ with downscaled proxies. Check:")
        print()
        print("    System Settings > [your name] > iCloud > Photos")
        print()
        print("  If it is on, these ARE proxies and the real files are in "
              "iCloud. Turn on")
        print("  'Download Originals to this Mac', wait for the sync, and "
              "rescan — or export")
        print("  the ones you want: Photos > File > Export > Export Unmodified "
              "Original.")
    print()
    print(f"  {'score':>5}  {'busy':>5} {'luma':>5}  {'origin':<15} verdict / file")
    for r in rows[:60]:
        b = r["background"]
        flag = " " if r.get("documentary_eligible") else "!"
        print(f"  {b['score']:>5.1f}  {b['type_band_busyness']:>5.1f} "
              f"{b['type_band_luma']:>5.0f}  {r.get('origin', '?'):<15}"
              f"{flag}{b['verdict']}")
        print(f"         {r['relative_path']}")
    if len(rows) > 60:
        print(f"\n  … {len(rows) - 60} more.")
    print()
    print("  score    0-100, measured: 65% how calm the type band is, "
          "35% how well it takes a scrim")
    print("  busy     edge energy where caption and credit sit. Over ~28 no "
          "scrim rescues it")
    print("  luma     brightness of that band, 0-255. Over ~190 expect a heavy "
          "scrim")
    print("  !        origin not yet declared — cannot be approved, whatever "
          "it scores")
    print()
    print("  A score says a photograph CAN hold words. It does not say the "
          "photograph means")
    print("  anything, or belongs in a particular episode. That part is still "
          "yours.")


# ------------------------------------------------------------------ discovery
# Where a Mac actually keeps photographs. Scanned only to REPORT what is there
# — nothing is read, hashed, or written during a --find.
SEARCH_ROOTS = ["~/Pictures", "~/Desktop", "~/Documents", "~/Downloads",
                "~/Movies", "/Volumes"]
SKIP_DIRS = {"node_modules", "venv", ".git", "Library", "Caches",
             "com.apple.mediaanalysisd", "resources", "private"}


def find_libraries(min_images: int = 5, max_depth: int = 4) -> list[tuple[int, Path]]:
    """Report folders that hold photographs, biggest first.

    Apple Photos libraries are reported but never descended into. A
    `.photoslibrary` is a package holding a database and re-encoded
    derivatives, and scanning inside it gives you thousands of thumbnails
    instead of your originals — which is exactly the DERIVATIVE problem the
    media intake tool warns about. Export from Photos first:
    File > Export > Export Unmodified Original.
    """
    found: dict[Path, int] = {}
    packages: list[Path] = []
    for root in SEARCH_ROOTS:
        base = Path(root).expanduser()
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            here = Path(dirpath)
            try:
                depth = len(here.relative_to(base).parts)
            except ValueError:
                continue
            if depth >= max_depth:
                dirnames[:] = []
            # do not descend into packages or noise
            keep = []
            for d in dirnames:
                if d.startswith(".") or d in SKIP_DIRS:
                    continue
                if d.endswith((".photoslibrary", ".photolibrary", ".aplibrary")):
                    packages.append(here / d)
                    continue
                keep.append(d)
            dirnames[:] = keep
            n = sum(1 for f in filenames
                    if not f.startswith(".")
                    and Path(f).suffix.lower() in SUPPORTED)
            if n >= min_images:
                found[here] = n
    for pkg in packages:
        found[pkg] = -1                       # marked, not counted
    return sorted(found.items(), key=lambda kv: (-kv[1], str(kv[0])))


def print_found(rows) -> None:
    print()
    if not rows:
        print("  No folders with photographs found under:")
        for r in SEARCH_ROOTS:
            print(f"    {r}")
        print()
        print("  If your photos are on an external drive, plug it in and")
        print("  run this again — /Volumes is searched.")
        print()
        return
    print("  FOLDERS HOLDING PHOTOGRAPHS")
    print()
    for path, n in rows:
        if n < 0:
            print(f"      pkg  {path}")
            print(f"           ^ Apple Photos library — do NOT scan this.")
            print(f"             Photos > File > Export > Export Unmodified")
            print(f"             Original, into a normal folder, then scan that.")
        else:
            print(f"    {n:>5}  {path}")
    print()
    print("  Point the inventory at whichever one is your working library:")
    real = next((p for p, n in rows if n > 0), None)
    if real:
        print(f'    python3 {Path(__file__).name} "{real}"')
    print()


# --------------------------------------------------------------- self-test
def self_test() -> int:
    import tempfile as tf
    print("=== SELF-TEST: visual manifest ===")
    fails = ran = 0

    def check(label, ok):
        nonlocal fails, ran
        ran += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        fails += (not ok)

    with tf.TemporaryDirectory() as td:
        root = Path(td)
        # a photo, an identical copy, a near-duplicate, and something different
        # Structured on purpose. A perceptual hash describes STRUCTURE, so the
        # test image needs edges and shapes — per-pixel noise averages back to
        # flat when downscaled and would exercise the low-detail path instead.
        # NOT a regular pattern. The first version of this fixture drew evenly
        # spaced windows on a facade, and a perceptual hash treats a periodic
        # pattern as a pathological case: a 2% re-crop of it lands 28 bits
        # away, while the same crop of an organic image lands 4. The re-crop
        # check passed anyway, on the byte-identical copy rather than on the
        # crop — a test green for the wrong reason, which is worse than red.
        from PIL import ImageDraw
        import random as _rr
        _rr.seed(3)
        a = Image.new("RGB", (1200, 900), (70, 85, 110))
        d = ImageDraw.Draw(a)
        for _ in range(40):
            _x, _y = _rr.randint(0, 1100), _rr.randint(0, 800)
            _w, _h = _rr.randint(40, 220), _rr.randint(40, 200)
            _v = _rr.randint(30, 230)
            d.rectangle([_x, _y, _x + _w, _y + _h], fill=(_v, _v - 6, _v - 14))
        d.ellipse([300, 200, 760, 640], fill=(210, 200, 180))
        a.save(root / "shot_a.jpg", quality=92)
        (root / "shot_a_copy.jpg").write_bytes((root / "shot_a.jpg").read_bytes())
        a.crop((0, 0, 1176, 882)).resize((1200, 900)).save(root / "shot_a_recrop.jpg",
                                                           quality=92)
        Image.new("RGB", (800, 1200), (240, 240, 235)).save(root / "different.png")
        (root / "notes.txt").write_text("not an image")
        (root / "broll_courthouse.mov").write_bytes(b"not really a movie")
        (root / "clip.mp4").write_bytes(b"nor is this")

        m = inventory(root)
        check("scans only supported image types", m["counts"]["images"] == 4)
        # video is the thing most likely to be silently dropped, because a
        # library of clips scans clean and reports nothing about them
        check("video is counted, not silently ignored",
              m["counts"]["videos_not_inventoried"] == 2)
        check("video is not mixed into the image inventory",
              not any(v["filename"].endswith((".mov", ".mp4"))
                      for v in m["visuals"]))
        check("a document is neither an image nor a video",
              m["counts"]["images"] == 4 and m["counts"]["videos_not_inventoried"] == 2)
        check("an identical copy is caught by SHA-256",
              m["counts"]["exact_duplicate_groups"] == 1)
        check("a re-crop is caught as a near-duplicate",
              m["counts"]["similarity_groups"] >= 1)
        # the group that survives must be the CROP pair, not the byte-identical
        # pair restated — that restatement was 150 of 169 groups on a real
        # library, burying the signal under something already reported above
        _near = [{r["relative_path"] for r in g}
                 for g in m["integrity"]["similarity_groups"]]
        check("a near-duplicate group is not an exact-duplicate group restated",
              all(set(g) not in _near
                  for g in m["integrity"]["exact_duplicate_groups"]))
        check("the near-duplicate group found is the re-crop",
              any("shot_a_recrop.jpg" in g for g in _near))
        check("a textured photo is not treated as flat",
              not next(v for v in m["visuals"]
                       if v["filename"] == "shot_a.jpg")["low_detail"])
        check("a blank image IS treated as flat and left out of grouping",
              next(v for v in m["visuals"]
                   if v["filename"] == "different.png")["low_detail"]
              and m["counts"]["low_detail_excluded"] >= 1)
        check("orientation is recorded",
              {v["orientation"] for v in m["visuals"]} == {"landscape", "portrait"})
        check("visual_id is derived from content",
              all(v["visual_id"] == f"vis_{v['sha256'][:24]}" for v in m["visuals"]))
        check("identical files share a visual_id",
              len({v["visual_id"] for v in m["visuals"]}) == 3)

        check("manifest and overrides are written",
              (root / MANIFEST_NAME).is_file() and (root / OVERRIDES_NAME).is_file())
        ov = json.loads((root / OVERRIDES_NAME).read_text())
        check("every image gets an editorial record",
              len(ov["visuals"]) == 3)
        check("nothing is approved by default",
              m["counts"]["approved_for_documentary"] == 0
              and all(not r["approved_for_documentary"] for r in ov["visuals"].values()))

        # --- the property that matters most: a rescan must not destroy judgement
        vid = sorted(ov["visuals"])[0]
        ov["visuals"][vid].update(review_status="reviewed",
                                  approved_for_documentary=True,
                                  origin="own_camera",
                                  credit="Photo: M. Griswold, 2026-09-08",
                                  description="the counter")
        atomic_write_json(root / OVERRIDES_NAME, ov)

        m2 = inventory(root)
        ov2 = json.loads((root / OVERRIDES_NAME).read_text())
        check("a rescan preserves human edits",
              ov2["visuals"][vid]["description"] == "the counter"
              and ov2["visuals"][vid]["approved_for_documentary"] is True)
        check("approved images are listed for the renderer",
              m2["approved_for_documentary"] == [vid])
        check("review progress is counted", m2["counts"]["reviewed"] == 1)
        check("discovered_at is carried across rescans",
              {v["sha256"]: v["discovered_at"] for v in m["visuals"]} ==
              {v["sha256"]: v["discovered_at"] for v in m2["visuals"]})

        # --- ORIGIN GATE. The rule the whole newsroom rests on.
        other = sorted(v for v in ov2["visuals"] if v != vid)[0]
        ov2["visuals"][other].update(review_status="reviewed",
                                     approved_for_documentary=True,
                                     origin="generated",
                                     generation={"provider": "example",
                                                 "model": "example-1",
                                                 "prompt": "a courthouse"})
        atomic_write_json(root / OVERRIDES_NAME, ov2)
        mg = inventory(root)
        check("a GENERATED image is refused documentary approval",
              other not in mg["approved_for_documentary"])
        check("the refusal is reported with its reason",
              any(x["visual_id"] == other and x["origin"] == "generated"
                  for x in mg["integrity"]["approval_blocked_by_origin"]))
        check("a generated image is offered as illustration instead",
              mg["illustration_only"] == [other])
        check("a camera image is still approved alongside it",
              vid in mg["approved_for_documentary"])

        # unattributed is not the same as generated, and is also refused
        third = sorted(v for v in ov2["visuals"] if v not in (vid, other))[0]
        ov2["visuals"][third].update(review_status="reviewed",
                                     approved_for_documentary=True)
        atomic_write_json(root / OVERRIDES_NAME, ov2)
        mu = inventory(root)
        check("an UNATTRIBUTED image is refused documentary approval",
              third not in mu["approved_for_documentary"])
        check("unattributed images are counted",
              mu["counts"]["unattributed"] >= 1)

        # a device allowlist promotes matching EXIF to own_camera
        check("classify_origin matches a device from the policy",
              classify_origin({"make": "Apple", "model": "iPhone 15 Pro"}, {},
                              ["Apple iPhone 15 Pro"]) == "own_camera")
        check("classify_origin leaves an unknown device unattributed",
              classify_origin({"make": "Canon", "model": "EOS R"}, {},
                              ["Apple iPhone 15 Pro"]) == "unknown")
        check("a declared origin overrides EXIF",
              classify_origin({}, {"origin": "licensed"}, []) == "licensed")
        check("an invalid origin is refused",
              _raises_origin())

        # a starter policy file is written so the allowlist is discoverable
        check("a policy file is created on first run",
              (root / POLICY_NAME).is_file())

        # --- an override for a deleted photo is reported, not silently dropped
        (root / "different.png").unlink()
        m3 = inventory(root)
        check("an override with no image is flagged as orphaned",
              m3["counts"]["orphan_editorial_records"] == 1)
        check("orphaned overrides are kept, not deleted",
              len(json.loads((root / OVERRIDES_NAME).read_text())["visuals"]) == 3)

        # --- a corrupt file must not abandon the scan
        (root / "broken.jpg").write_bytes(b"\xff\xd8\xff\xe0 not really a jpeg")
        m4 = inventory(root)
        check("an unreadable file is recorded and the scan continues",
              m4["counts"]["unreadable"] == 1 and m4["counts"]["images"] == 3)

        # --- check-only writes nothing
        before = (root / MANIFEST_NAME).read_bytes()
        inventory(root, write=False)
        check("--check-only writes nothing",
              (root / MANIFEST_NAME).read_bytes() == before)

        # --- discovery: find the library without reading anything in it
        # Patch the RUNNING module's globals. `import visual_manifest` here
        # would create a second module object (this file is __main__ when run
        # directly), and patching that copy would leave find_libraries reading
        # the original list.
        g = globals()
        saved = g["SEARCH_ROOTS"][:]
        try:
            (root / "sub" / "deeper").mkdir(parents=True)
            for i in range(6):
                Image.new("RGB", (40, 40), (i * 30, 80, 110)).save(
                    root / "sub" / "deeper" / f"p{i}.jpg")
            (root / "My Photos.photoslibrary" / "originals").mkdir(parents=True)
            for i in range(20):
                Image.new("RGB", (20, 20), (5, 5, 5)).save(
                    root / "My Photos.photoslibrary" / "originals" / f"t{i}.jpg")
            (root / "node_modules" / "x").mkdir(parents=True)
            for i in range(9):
                Image.new("RGB", (20, 20), (5, 5, 5)).save(
                    root / "node_modules" / "x" / f"n{i}.png")

            g["SEARCH_ROOTS"] = [str(root)]
            rows = find_libraries()
            names = {pp.name: n for pp, n in rows}
            check("--find reports a folder of photographs",
                  names.get("deeper") == 6)
            check("--find flags an Apple Photos library instead of scanning it",
                  names.get("My Photos.photoslibrary") == -1)
            check("--find skips node_modules",
                  not any("node_modules" in str(pp) for pp, _ in rows))
        finally:
            g["SEARCH_ROOTS"] = saved

        # --- a malformed overrides file fails loudly rather than being ignored
        (root / OVERRIDES_NAME).write_text('{"version":1,"visuals":{"x":{}}}')
        try:
            inventory(root)
            ok = False
        except ValueError as e:
            ok = "missing field" in str(e)
        check("a malformed overrides file is refused with a reason", ok)

    # Background fitness and --manifest-dir get their own tree: these fixtures
    # add images and directories, and the blocks above count what a recursive
    # scan finds. Sharing a root made two unrelated checks fail.
    with tf.TemporaryDirectory() as tdbg:
        root = Path(tdbg)
        # --- background fitness: a measurement, so it is tested like one
        from PIL import ImageDraw as _ID
        bg = root / "bg"
        bg.mkdir()
        calm = Image.new("RGB", (1600, 2400))
        _d = _ID.Draw(calm)
        for _y in range(2400):
            _v = int(30 + 60 * (_y / 2400))
            _d.line([(0, _y), (1600, _y)], fill=(_v, _v + 4, _v + 10))
        calm.save(bg / "calm.jpg", quality=92)
        busy = Image.new("RGB", (1600, 2400), (40, 45, 55))
        _d = _ID.Draw(busy)
        import random as _r
        _r.seed(7)
        for _ in range(4000):                    # noise ONLY where type sits
            _x, _y = _r.randint(0, 1600), _r.randint(1320, 2040)
            _d.rectangle([_x, _y, _x + 9, _y + 9], fill=(_r.randint(150, 255),) * 3)
        busy.save(bg / "busy.jpg", quality=92)
        bright = Image.new("RGB", (1600, 2400), (60, 60, 70))
        _ID.Draw(bright).rectangle([0, 1320, 1600, 2040], fill=(250, 250, 248))
        bright.save(bg / "bright.jpg", quality=92)
        Image.new("RGB", (400, 700), (70, 80, 95)).save(bg / "small.jpg", quality=92)

        mb = inventory(bg)
        score = {v["filename"]: v["background"] for v in mb["visuals"]}
        check("a calm frame scores well as a background",
              score["calm.jpg"]["score"] >= 70)
        check("noise where the type sits is caught, not the frame overall",
              score["busy.jpg"]["verdict"] == "too busy where the type sits")
        check("a calm frame beats a busy one",
              score["calm.jpg"]["score"] > score["busy.jpg"]["score"])
        check("a blown-out band is flagged rather than failed",
              "bright" in score["bright.jpg"]["verdict"])
        check("too few pixels is a gate, not a low score",
              score["small.jpg"]["score"] == 0.0
              and not score["small.jpg"]["enough_pixels"])
        check("the crop measured is the target aspect, not the original",
              score["calm.jpg"]["crop_px"] == "1350x2400")

        # --- --manifest-dir: the source tree must not be written to at all.
        # This is what makes an Apple Photos package scannable in place.
        ro = root / "readonly_src"
        ro.mkdir()
        calm.save(ro / "one.jpg", quality=92)
        before = sorted(q.name for q in ro.iterdir())
        elsewhere = root / "records"
        inventory(ro, manifest_dir=elsewhere)
        check("--manifest-dir leaves the source folder byte-for-byte alone",
              sorted(q.name for q in ro.iterdir()) == before)
        check("the three sidecar files are written to the given directory",
              (elsewhere / MANIFEST_NAME).is_file()
              and (elsewhere / OVERRIDES_NAME).is_file()
              and (elsewhere / POLICY_NAME).is_file())
        check("the manifest records where its own records live",
              json.loads((elsewhere / MANIFEST_NAME).read_text())["records_dir"]
              == str(elsewhere.resolve()))
        m_again = inventory(ro, manifest_dir=elsewhere)
        check("a rescan against an external records dir still finds the image",
              m_again["counts"]["images"] == 1)

    # --- authorship and the schedule of works
    with tf.TemporaryDirectory() as tdc:
        root = Path(tdc)
        from PIL import ImageDraw as _ID2
        import random as _r2
        _r2.seed(11)
        for nm in ("a.jpg", "b.jpg"):
            im = Image.new("RGB", (1600, 2400), (60, 70, 90))
            _d2 = _ID2.Draw(im)
            for _ in range(30):
                _x, _y = _r2.randint(0, 1500), _r2.randint(0, 2300)
                _d2.rectangle([_x, _y, _x + _r2.randint(40, 200),
                               _y + _r2.randint(40, 200)],
                              fill=(_r2.randint(40, 220),) * 3)
            im.save(root / nm, quality=92)

        m0 = inventory(root)
        check("a fresh policy carries an empty copyright block",
              "copyright" in json.loads((root / POLICY_NAME).read_text()))
        r0 = write_registration(m0, root / "reg0")
        check("no author means nothing is listed, rather than a blank claim",
              r0["summary"]["counts"]["unpublished"] == 0
              and r0["summary"]["counts"]["excluded"] == 2)
        check("the reason for exclusion is recorded, not just the count",
              all("no author" in e["reason"] for e in r0["summary"]["excluded"]))

        pol = json.loads((root / POLICY_NAME).read_text())
        pol["copyright"].update({"author": "A. Photographer",
                                 "claimant": "A. Photographer",
                                 "notice_year": "2026"})
        (root / POLICY_NAME).write_text(json.dumps(pol))
        m1 = inventory(root)
        check("the notice line is built from the policy",
              m1["notice"] == "\u00a9 2026 A. Photographer. All rights reserved.")
        r1 = write_registration(m1, root / "reg1")
        check("with an author declared, works are listed",
              r1["summary"]["counts"]["unpublished"] == 2)
        check("unpublished is the default, so nothing is claimed as published",
              r1["summary"]["counts"]["published"] == 0)
        check("a schedule file is written",
              (root / "reg1" / "registration_unpublished.csv").is_file())
        check("published works get no file when there are none",
              not (root / "reg1" / "registration_published.csv").exists())

        # published and unpublished must never share a file
        ov = json.loads((root / OVERRIDES_NAME).read_text())
        first = sorted(ov["visuals"])[0]
        ov["visuals"][first]["publication_status"] = "published"
        ov["visuals"][first]["date_published"] = "2026-07-01"
        (root / OVERRIDES_NAME).write_text(json.dumps(ov))
        m2 = inventory(root)
        r2 = write_registration(m2, root / "reg2")
        check("a published work moves to its own schedule",
              r2["summary"]["counts"]["published"] == 1
              and r2["summary"]["counts"]["unpublished"] == 1)

        # a generated image is never claimed as an authored work
        ov = json.loads((root / OVERRIDES_NAME).read_text())
        ov["visuals"][first]["origin"] = "generated"
        (root / OVERRIDES_NAME).write_text(json.dumps(ov))
        m3 = inventory(root)
        r3 = write_registration(m3, root / "reg3")
        check("a generated image is excluded from the schedule",
              r3["summary"]["counts"]["excluded"] == 1
              and "generated" in r3["summary"]["excluded"][0]["reason"])

        # the schedule lists WORKS, not files: a byte-identical copy is one work
        (root / "a_copy.jpg").write_bytes((root / "a.jpg").read_bytes())
        m4 = inventory(root)
        r4 = write_registration(m4, root / "reg4")
        check("a duplicate file does not become a second work",
              m4["counts"]["images"] == 3
              and (r4["summary"]["counts"]["published"]
                   + r4["summary"]["counts"]["unpublished"]
                   + r4["summary"]["counts"]["excluded"]) == 2)

    print(f"\nSelf-test: {ran - fails}/{ran} behaved correctly.")
    return 1 if fails else 0


def _raises_origin() -> bool:
    try:
        rec = default_override("vis_x")
        rec["origin"] = "borrowed_from_a_friend"
        validate_override(rec)
        return False
    except ValueError as e:
        return "is not one of" in str(e)


# ---------------------------------------------------------------------- cli
def main() -> int:
    ap = argparse.ArgumentParser(
        description="Inventory a photo library: hashes, near-duplicates, EXIF, "
                    "and an editorial record per image.")
    ap.add_argument("library", nargs="?", help="folder of photographs to scan")
    ap.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD,
                    help=f"pHash Hamming distance for near-duplicates "
                         f"(default {DEFAULT_THRESHOLD}; higher groups more)")
    ap.add_argument("--check-only", action="store_true",
                    help="report, write nothing")
    ap.add_argument("--approved", action="store_true",
                    help="list images cleared for use, one per line")
    ap.add_argument("--find", action="store_true",
                    help="locate folders on this machine that hold photographs")
    ap.add_argument("--manifest-dir", metavar="DIR",
                    help="write the manifest, overrides and policy HERE instead "
                         "of beside the photographs, leaving the source untouched")
    ap.add_argument("--registration", nargs="?", const=True, metavar="DIR",
                    help="write the schedule of works for a copyright "
                         "registration (default: beside the manifest)")
    ap.add_argument("--backgrounds", action="store_true",
                    help="rank images by measured suitability as a background "
                         "behind type, best first")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()

    if a.self_test:
        return self_test()
    if a.find:
        print_found(find_libraries())
        return 0
    if not a.library:
        ap.print_help()
        return 2
    if a.threshold < 0:
        print("ERROR: --threshold must be zero or more", file=sys.stderr)
        return 2

    try:
        lib, vol = resolve_library(a.library)
        if vol is not None:
            print(f"\n  shelf {vol.label}  ({vol.id})")
        m = inventory(lib, threshold=a.threshold,
                      write=not (a.check_only or a.approved or a.backgrounds
                                 or a.registration),
                      manifest_dir=Path(a.manifest_dir) if a.manifest_dir else None)
    except (NotADirectoryError, ValueError) as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted — nothing was written", file=sys.stderr)
        return 130

    if a.approved:
        print_approved(m)
    elif a.registration:
        out = Path(a.registration) if isinstance(a.registration, str) else \
            Path(m.get("records_dir") or m["root"])
        print_registration(write_registration(m, out))
    elif a.backgrounds:
        print_backgrounds(m)
    else:
        print_summary(m, a.check_only)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
