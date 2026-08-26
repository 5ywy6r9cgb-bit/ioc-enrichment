#!/usr/bin/env python3
"""
desk_inventory.py — The Sentinel Report · Research Desk
================================================================================
Answers the question "what am I actually looking at?" for a folder of records.

Walks a directory, and for every file records:
    real type (from magic bytes, NOT the extension)
    extension-vs-reality mismatch
    size, SHA-256
    for PDFs: whether a text layer exists, and how much

Writes:
    inventory.csv          one row per file — this is your dataset
    chart_types.png        what kinds of files you hold
    chart_readability.png  how much of your PDF corpus is machine-readable
    chart_integrity.png    files that failed validation

WHY THIS EXISTS
    A .pdf extension is a claim, not a fact. On 2026-08-24 a 52-page contract
    in this corpus turned out to be a ZIP archive, and 41 of its pages had no
    text layer at all. grep read those pages as empty. A null search result
    against a file in the RED column below is not evidence of absence.

USAGE
    python3 desk_inventory.py /path/to/records
    python3 desk_inventory.py /path/to/records --out ~/sentinel/inventory
================================================================================
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shelf as S

# Charts are a bonus; inventory.csv is the dataset. A missing plotting
# library must not cost you the scan of 349 files -- the run degrades to
# CSV-only and says so, rather than dying at import with a stack trace.
try:
    import matplotlib
    matplotlib.use("Agg")      # required — no display on a headless run
    import matplotlib.pyplot as plt
    HAVE_PLOT = True
except ImportError:
    HAVE_PLOT = False

ZERO_BYTE_SHA = "e3b0c44298fc1c14"   # sha256 of an empty file, first 16 chars

# A PDF page with fewer than this many characters of extractable text is
# treated as having no usable text layer.
TEXT_LAYER_MIN_CHARS = 200


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def magic_type(path: Path) -> str:
    try:
        out = subprocess.run(["file", "-b", str(path)],
                             capture_output=True, text=True, timeout=20)
        return out.stdout.strip()[:70] or "unknown"
    except Exception:
        return "unknown"


def pdf_text_chars(path: Path) -> int | None:
    """Characters pdftotext can extract. None if not applicable/failed."""
    try:
        out = subprocess.run(["pdftotext", str(path), "-"],
                             capture_output=True, text=True, timeout=90)
        return len(out.stdout.strip())
    except Exception:
        return None


def classify(row: dict) -> str:
    """The integrity verdict. Plain words, no jargon."""
    if row["size_bytes"] == 0 or row["sha256"].startswith(ZERO_BYTE_SHA):
        return "EMPTY FILE"
    if row["ext"] == ".pdf" and "PDF" not in row["real_type"]:
        if "Zip" in row["real_type"] or "ZIP" in row["real_type"]:
            return "ZIP MISLABELED AS PDF"
        return "NOT ACTUALLY A PDF"
    if row["ext"] == ".pdf":
        # text_chars is None when pdftotext could not run AT ALL — missing,
        # timed out, crashed. That is not the same as a PDF with no text, and
        # falling through to "ok" would mark every PDF in the corpus readable
        # on a machine where pdftotext is not installed. The reassuring word
        # must never be the default for a check that did not happen.
        if row["text_chars"] is None:
            return "UNKNOWN — readability never tested"
        if row["text_chars"] < TEXT_LAYER_MIN_CHARS:
            return "NO TEXT LAYER — needs OCR"
        return "searchable"
    return "ok"


def scan(root: Path, shelf_name: str = "", volume_id: str = "") -> list[dict]:
    """Inventory one root.

    `shelf_name` and `volume_id` are carried onto every row. Without them a
    merged inventory of two drives is a list of relative paths you cannot
    locate: "records/a.pdf" exists on both, and nothing in the CSV says which
    physical object to plug in to go read it.
    """
    rows = []
    files = [p for p in sorted(root.rglob("*")) if p.is_file()]
    total = len(files)
    for i, p in enumerate(files, 1):
        if i % 25 == 0 or i == total:
            print(f"\r  scanning {i}/{total} ...", end="", file=sys.stderr)
        try:
            size = p.stat().st_size
        except OSError:
            continue
        row = {
            "shelf": shelf_name,
            "volume_id": volume_id,
            "filename": p.name,
            "relpath": str(p.relative_to(root)),
            "ext": p.suffix.lower(),
            "size_bytes": size,
            "size_kb": round(size / 1024, 1),
            "real_type": magic_type(p),
            "sha256": sha256_of(p) if size else "0" * 64,
            "text_chars": None,
        }
        if row["ext"] == ".pdf" and size > 0:
            row["text_chars"] = pdf_text_chars(p)
        row["verdict"] = classify(row)
        rows.append(row)
    print(file=sys.stderr)
    return rows


def bar(ax, labels, values, colors, title, xlabel):
    y = range(len(labels))
    ax.barh(list(y), values, color=colors)
    ax.set_yticks(list(y))
    ax.set_yticklabels(labels, fontsize=9)
    ax.invert_yaxis()
    ax.set_xlabel(xlabel, fontsize=9)
    ax.set_title(title, fontsize=11, fontweight="bold", loc="left")
    for i, v in enumerate(values):
        ax.text(v, i, f" {v}", va="center", fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)


def make_charts(rows: list[dict], outdir: Path) -> None:
    if not HAVE_PLOT:
        return
    # 1. what kinds of files do I hold
    fam = Counter()
    for r in rows:
        t = r["real_type"]
        key = ("PDF" if "PDF" in t else
               "Zip archive" if "ip archive" in t else
               "Word/Office" if "Microsoft" in t or "Composite" in t else
               "Image" if "image" in t.lower() or "JPEG" in t or "PNG" in t else
               "Text/Data" if "text" in t.lower() or "JSON" in t else
               "Other")
        fam[key] += 1
    fig, ax = plt.subplots(figsize=(8, 4))
    items = fam.most_common()
    bar(ax, [k for k, _ in items], [v for _, v in items],
        ["#2f4f6f"] * len(items),
        "What is actually in this folder (by magic bytes, not extension)",
        "files")
    fig.tight_layout()
    fig.savefig(outdir / "chart_types.png", dpi=150)
    plt.close(fig)

    # 2. how much of the PDF corpus can a search actually read
    pdfs = [r for r in rows if r["ext"] == ".pdf"]
    read = Counter(r["verdict"] for r in pdfs)
    order = ["searchable", "NO TEXT LAYER — needs OCR",
             "ZIP MISLABELED AS PDF", "NOT ACTUALLY A PDF", "EMPTY FILE",
             "UNKNOWN — readability never tested"]
    labels = [o for o in order if read.get(o)]
    values = [read[o] for o in labels]
    colors = ["#2e7d32" if l == "searchable" else "#c62828" for l in labels]
    if labels:
        fig, ax = plt.subplots(figsize=(8, 3.6))
        bar(ax, labels, values, colors,
            f"Can a keyword search read it?  ({len(pdfs)} PDFs)", "files")
        fig.text(0.01, 0.01,
                 "Red = grep returns nothing regardless of content. "
                 "A null result on these files is NOT evidence of absence.",
                 fontsize=8, color="#c62828")
        fig.tight_layout(rect=(0, 0.06, 1, 1))
        fig.savefig(outdir / "chart_readability.png", dpi=150)
        plt.close(fig)

    # 3. the integrity failures, named
    bad = [r for r in rows if r["verdict"] not in ("ok", "searchable")]
    if bad:
        bad = sorted(bad, key=lambda r: r["size_bytes"])[:20]
        fig, ax = plt.subplots(figsize=(9, max(3, 0.35 * len(bad))))
        bar(ax, [f"{r['filename'][:38]}" for r in bad],
            [max(r["size_kb"], 0.1) for r in bad],
            ["#c62828"] * len(bad),
            f"Files that failed validation ({len(bad)} shown)", "size (KB)")
        fig.tight_layout()
        fig.savefig(outdir / "chart_integrity.png", dpi=150)
        plt.close(fig)


def explain_missing(root: Path) -> None:
    """Say WHY the path is not there, not just that it isn't.

    "Not a folder" is true and useless. Three different situations produce it
    and they need three different next moves: a typo, a drive that is not
    mounted, and a folder that simply has not been created yet. Guessing
    wrong costs an hour of looking in the wrong place.
    """
    print(f"Not a folder: {root}", file=sys.stderr)

    # An external volume that is unplugged looks exactly like a bad path.
    parts = root.parts
    if len(parts) > 2 and parts[1] == "Volumes":
        vol = Path("/Volumes") / parts[2]
        if not vol.exists():
            print(f"\n  /Volumes/{parts[2]} is not mounted.", file=sys.stderr)
            print("  Plug the drive in, or point this at a local copy instead.",
                  file=sys.stderr)
            return

    # Walk up to the deepest ancestor that DOES exist and show what is in it,
    # so the real folder name is on screen rather than being guessed at.
    here = root
    while here != here.parent and not here.is_dir():
        here = here.parent
    if here.is_dir():
        try:
            kids = sorted(p.name for p in here.iterdir() if p.is_dir())
        except OSError:
            kids = []
        print(f"\n  Deepest folder that exists: {here}", file=sys.stderr)
        if kids:
            print("  It contains these folders:", file=sys.stderr)
            for k in kids[:20]:
                print(f"    {here / k}", file=sys.stderr)
            if len(kids) > 20:
                print(f"    ... and {len(kids) - 20} more", file=sys.stderr)
        else:
            print("  It has no subfolders.", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(prog="sentinel corpus inventory")
    ap.add_argument("roots", nargs="+",
                    help="shelf names (N1, N2, N1/records) or folder paths")
    ap.add_argument("--out", default="inventory_out", help="output folder")
    args = ap.parse_args()

    # Resolve EVERY root before scanning ANY of them.
    #
    # Scanning as we go would inventory N1, then hit an unplugged N2, and leave
    # behind a CSV that looks like a complete two-drive inventory and is not.
    # A partial corpus that does not announce itself is the thing this whole
    # module exists to prevent.
    targets: list[tuple[str, Path, str]] = []
    for spec in args.roots:
        try:
            root, vol = S.resolve_root(spec, cfg=None)
        except SystemExit:
            # resolve_root already explained itself on stderr.
            return 3
        if not root.is_dir():
            explain_missing(root)
            return 2
        targets.append((spec if vol else "", root, vol.id if vol else ""))

    outdir = Path(args.out).expanduser()
    outdir.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    for name, root, vid in targets:
        label = f"{name} ({root})" if name else str(root)
        print(f"Inventorying {label}")
        rows.extend(scan(root, shelf_name=name, volume_id=vid))

    # An empty folder is a real answer, not a crash. Writing a headerless CSV
    # or dying on rows[0] would both read as "the tool is broken" when the
    # actual fact is "you pointed it at nothing".
    if not rows:
        where = ", ".join(str(r) for _, r, _ in targets)
        print(f"\n  No files found under: {where}", file=sys.stderr)
        print("  Nothing was written. An empty result here is not a fact about",
              file=sys.stderr)
        print("  the records -- check the folder, or run: bin/sentinel shelf check",
              file=sys.stderr)
        return 1

    csv_path = outdir / "inventory.csv"
    with csv_path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    make_charts(rows, outdir)

    # ---- the readable summary ----
    v = Counter(r["verdict"] for r in rows)
    total_mb = sum(r["size_bytes"] for r in rows) / 1e6
    print()
    print("=" * 64)
    print(f"  {len(rows)} files · {total_mb:,.1f} MB")
    if len(targets) > 1:
        print("-" * 64)
        for name, root, _ in targets:
            sub = [r for r in rows if r["shelf"] == name] if name else \
                  [r for r in rows if not r["shelf"]]
            mb = sum(r["size_bytes"] for r in sub) / 1e6
            unreadable = sum(1 for r in sub
                             if r["verdict"] not in ("ok", "searchable"))
            print(f"  {(name or str(root))[:24]:<24} {len(sub):>5} files "
                  f"{mb:>9,.1f} MB   {unreadable:>4} unreadable")
    print("=" * 64)
    for verdict, n in v.most_common():
        mark = " " if verdict in ("ok", "searchable") else "!"
        print(f" {mark} {verdict:<32} {n:>4}")
    print("=" * 64)

    bad = [r for r in rows if r["verdict"] not in ("ok", "searchable")]
    if bad:
        print("\n FILES THAT WILL SILENTLY FAIL A SEARCH:")
        for r in sorted(bad, key=lambda r: r["size_bytes"])[:15]:
            print(f"   {r['verdict']:<26} {r['size_kb']:>8.1f} KB  {r['filename'][:44]}")
        if len(bad) > 15:
            print(f"   ... and {len(bad)-15} more — see inventory.csv")

    dupes = Counter(r["sha256"] for r in rows if r["size_bytes"] > 0)
    dupe_hashes = [h for h, n in dupes.items() if n > 1]
    if dupe_hashes:
        print(f"\n {len(dupe_hashes)} duplicate file(s) by SHA-256 "
              f"(same bytes, different names) — filter inventory.csv by sha256")

    print(f"\n Dataset : {csv_path}")
    if HAVE_PLOT:
        print(f" Charts  : {outdir}/chart_*.png")
    else:
        print(" Charts  : skipped — matplotlib not installed "
              "(pip3 install matplotlib). The CSV above is the dataset.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
