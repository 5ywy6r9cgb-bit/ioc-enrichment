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
    python3 visual_manifest.py --self-test

Requires: pillow, imagehash, piexif  (piexif is optional — GPS is skipped
without it rather than failing).
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

MANIFEST_VERSION = 1
OVERRIDES_VERSION = 1
MANIFEST_NAME = "visual_manifest.json"
OVERRIDES_NAME = "visual_editorial_overrides.json"

SUPPORTED = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".heic", ".heif"}
DEFAULT_THRESHOLD = 5           # Hamming distance over a 64-bit perceptual hash
REVIEW_STATES = {"unreviewed", "reviewed", "rejected"}


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
        "editorial_notes": "",
        "review_status": "unreviewed",
        "reviewed_at": None,
        "reviewer": None,
        "approved_for_documentary": False,
        "usage": [],
    }


def validate_override(record, where: str = "override") -> None:
    if not isinstance(record, dict):
        raise ValueError(f"{where}: must be an object")
    missing = set(default_override("x")) - set(record)
    if missing:
        raise ValueError(f"{where}: missing field(s) {sorted(missing)}")
    for key in ("classification", "tags", "usage"):
        if not isinstance(record[key], list):
            raise ValueError(f"{where}: '{key}' must be a list")
    if not isinstance(record["approved_for_documentary"], bool):
        raise ValueError(f"{where}: 'approved_for_documentary' must be true or false")
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


def build_record(path: Path, root: Path, prev_by_sha: dict) -> dict:
    st = path.stat()
    digest = sha256_file(path)
    with Image.open(path) as im:
        width, height = im.size
        phash = str(imagehash.phash(im))
        stddev = detail_stddev(im)
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


def inventory(root: Path, threshold: int = DEFAULT_THRESHOLD,
              write: bool = True) -> dict:
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"visual library does not exist: {root}")

    manifest_path = root / MANIFEST_NAME
    overrides_path = root / OVERRIDES_NAME

    previous = load_previous(manifest_path)
    prev_by_sha = {v["sha256"]: v for v in previous.get("visuals", [])
                   if isinstance(v, dict) and isinstance(v.get("sha256"), str)}

    records, errors = [], []
    for p in collect_images(root):
        try:
            records.append(build_record(p, root, prev_by_sha))
        except Exception as exc:
            # one unreadable file must not abandon the scan
            errors.append({"relative_path": str(p.relative_to(root)),
                           "error": f"{type(exc).__name__}: {exc}"})

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
    similar = similarity_groups(records, threshold)
    low_detail = sorted(r["relative_path"] for r in records if r["low_detail"])

    approved = sorted(vid for vid, rec in overrides["visuals"].items()
                      if rec.get("approved_for_documentary") and vid in ids)
    reviewed = sum(1 for vid, rec in overrides["visuals"].items()
                   if vid in ids and rec.get("review_status") != "unreviewed")

    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "generated_at": utc_now(),
        "root": str(root),
        "similarity_engine": {"algorithm": "phash", "hash_bits": 64,
                              "distance_metric": "hamming", "threshold": threshold},
        "counts": {
            "images": len(records),
            "unreadable": len(errors),
            "exact_duplicate_groups": len(exact_dupes),
            "hard_link_groups": len(hard_links),
            "similarity_groups": len(similar),
            "low_detail_excluded": len(low_detail),
            "orphan_editorial_records": len(orphans),
            "reviewed": reviewed,
            "approved_for_documentary": len(approved),
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
            "unreadable": errors,
        },
        "approved_for_documentary": approved,
    }

    if write:
        atomic_write_json(manifest_path, manifest)
        atomic_write_json(overrides_path, overrides)
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
    print()
    print(f"  reviewed                {c['reviewed']:>5} / {c['images']}")
    print(f"  approved for use        {c['approved_for_documentary']:>5}")
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
        from PIL import ImageDraw
        a = Image.new("RGB", (1200, 900), (80, 100, 130))
        d = ImageDraw.Draw(a)
        for x in range(0, 1200, 90):                       # windows on a facade
            d.rectangle([x + 10, 120, x + 55, 780], fill=(225, 225, 215))
        d.rectangle([0, 780, 1200, 900], fill=(30, 34, 40))
        a.save(root / "shot_a.jpg", quality=92)
        (root / "shot_a_copy.jpg").write_bytes((root / "shot_a.jpg").read_bytes())
        a.crop((0, 0, 1180, 890)).resize((1200, 900)).save(root / "shot_a_recrop.jpg",
                                                           quality=92)
        Image.new("RGB", (800, 1200), (240, 240, 235)).save(root / "different.png")
        (root / "notes.txt").write_text("not an image")

        m = inventory(root)
        check("scans only supported image types", m["counts"]["images"] == 4)
        check("an identical copy is caught by SHA-256",
              m["counts"]["exact_duplicate_groups"] == 1)
        check("a re-crop is caught as a near-duplicate",
              m["counts"]["similarity_groups"] >= 1)
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
                                  credit="Photo: M. Rosenburg, 2026-09-08",
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

        # --- a malformed overrides file fails loudly rather than being ignored
        (root / OVERRIDES_NAME).write_text('{"version":1,"visuals":{"x":{}}}')
        try:
            inventory(root)
            ok = False
        except ValueError as e:
            ok = "missing field" in str(e)
        check("a malformed overrides file is refused with a reason", ok)

    print(f"\nSelf-test: {ran - fails}/{ran} behaved correctly.")
    return 1 if fails else 0


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
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()

    if a.self_test:
        return self_test()
    if not a.library:
        ap.print_help()
        return 2
    if a.threshold < 0:
        print("ERROR: --threshold must be zero or more", file=sys.stderr)
        return 2

    try:
        m = inventory(Path(a.library), threshold=a.threshold,
                      write=not (a.check_only or a.approved))
    except (NotADirectoryError, ValueError) as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted — nothing was written", file=sys.stderr)
        return 130

    if a.approved:
        print_approved(m)
    else:
        print_summary(m, a.check_only)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
