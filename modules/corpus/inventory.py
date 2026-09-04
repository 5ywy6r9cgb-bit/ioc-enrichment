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
import re
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
    """Hash a file. Raises OSError -- the CALLER decides what that means.

    Deliberately not caught here. An unreadable file and an unplugged drive
    both surface as OSError, and only the caller knows which one it is looking
    at. Swallowing it here would turn a vanished 8,000-file volume into 8,000
    calm rows saying "unreadable".
    """
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


def pdf_text(path: Path) -> str | None:
    """The text pdftotext can extract. None if it could not run at all."""
    try:
        out = subprocess.run(["pdftotext", "-layout", str(path), "-"],
                             capture_output=True, text=True, timeout=90)
        return out.stdout
    except Exception:
        return None


def pdf_text_chars(path: Path) -> int | None:
    """Characters pdftotext can extract. None if not applicable/failed."""
    t = pdf_text(path)
    return None if t is None else len(t.strip())


# Words that appear in essentially any English document of any length. Used
# only to tell readable text from a stream of correctly-decompressed garbage.
_COMMON = (" the ", " and ", " of ", " to ", " for ", " is ", " in ", " on ",
           " that ", " with ", " this ", " be ", " will ", " at ", " from ")


def text_looks_readable(text: str) -> bool:
    """
    Is this actually words, or is it a font-encoding failure?

    ─────────────────────────────────────────────────────────────────────
    THE THIRD FAILURE MODE, AND THE WORST OF THEM

    Two bad PDFs are already handled: the scan with no text layer, and the
    file where the extractor could not run. Both are visible — one extracts
    to nothing, the other reports a check that did not happen.

    This is the one that is invisible. A PDF built with a subset font and a
    missing or broken ToUnicode map has a real text layer, real font objects,
    and thousands of extractable characters — and every one of them decodes
    to the wrong glyph. A 15-page piping specification came out of this
    corpus as:

        !!"# $%&'( $%)*%+% + $%,*&'(%*&&

    It is not empty, so the scan check passes. It is not a failed run, so the
    unknown check passes. It lands in the corpus marked "searchable", with a
    healthy character count, and every keyword search over it returns nothing
    — forever, silently, while the file looks perfectly fine in the index.

    A document that cannot be searched and does not say so is worse than one
    that is plainly unreadable, because nobody goes back for it.

    NOTE ON CAUSE: broken encoding is one cause; a weak extractor is another.
    `pdftotext` reads ToUnicode maps that cruder readers ignore. So this
    reports "this text is not words", never "this document is corrupt".
    """
    if not text:
        return False
    sample = text[:20000].lower()
    letters = sum(c.isalpha() or c.isspace() for c in sample)
    if letters / max(1, len(sample)) < 0.55:
        return False
    # A page of real prose in any register hits several of these. Zero hits
    # across 20,000 characters means the bytes decoded to the wrong glyphs.
    return sum(w in sample for w in _COMMON) >= 3


def docx_text(path: Path) -> str | None:
    """
    The text of a Word document, without a library.

    ─────────────────────────────────────────────────────────────────────
    WHY THIS IS NOT A NICETY

    A .docx IS a ZIP, so every tool that sniffs magic bytes calls it an
    archive. `corpus ocr` did exactly that, looked for page images, found
    none, and skipped the file as "ZIP contains no page images" — which is a
    true sentence that means "we could not read this" and reads like "there
    was nothing in it".

    One of the two files skipped that way in this corpus was
    `6-19-20 OEPA LOT PTI Review Comments.docx`: the regulator's actual
    review comments on a public works project. It was reported as an empty
    bundle.

    The body text lives in word/document.xml. Paragraph and break tags become
    newlines, tab tags become tabs, everything else is stripped, and entities
    are decoded — enough to search and quote from, which is the whole job.
    """
    import zipfile
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
            if "word/document.xml" not in names:
                return None                      # not a Word document
            xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    except Exception:
        return None

    # Structure first, so paragraphs do not run together into one line.
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
    xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    for ent, ch in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                    ("&quot;", '"'), ("&apos;", "'"), ("&#160;", " ")):
        text = text.replace(ent, ch)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def save_text(path: Path, sha: str, outdir: Path) -> tuple[int | None, str]:
    """
    Extract a PDF's text and keep it, named by the hash of the bytes it
    came from.

    ─────────────────────────────────────────────────────────────────────
    WHY THE FILENAME CARRIES THE HASH

    A folder of extracted .txt files is a searchable corpus and NOT evidence
    — text on disk cannot prove which bytes produced it. Naming each file
    after the first 16 characters of the source's SHA-256 means a passage you
    quote leads back to a specific file whose hash you can re-check, and a
    later re-scan that produces a different hash for the "same" document
    lands beside the old one instead of silently overwriting it.

    The failure this prevents is the one that costs you a story: quoting a
    paragraph in print and being unable to say which document it came out of.

    ─────────────────────────────────────────────────────────────────────
    A SCAN IS NOT AN EMPTY DOCUMENT

    An image-only PDF extracts to nothing. Writing that empty result with no
    comment produces a corpus where a 200-page deposition reads as a document
    that says nothing, and every keyword search over it returns a confident,
    wrong null. So a file below the text-layer floor is written with a header
    saying so, and the manifest records it as needing OCR.
    """
    outdir.mkdir(parents=True, exist_ok=True)
    text = docx_text(path) if path.suffix.lower() == ".docx" else pdf_text(path)
    stem = f"{sha[:16]}__{path.stem[:60]}.txt"
    dest = outdir / stem

    if text is None:
        dest.write_text(
            f"[NO TEXT EXTRACTED — pdftotext could not run on this file]\n"
            f"[source: {path}]\n[sha256: {sha}]\n"
            f"[This is NOT a document that says nothing. It is a check that\n"
            f" did not happen. Install poppler (brew install poppler) and\n"
            f" re-run before treating any null search against it as absence.]\n",
            encoding="utf-8")
        return None, str(dest)

    chars = len(text.strip())
    header = (f"[source: {path}]\n[sha256: {sha}]\n[characters: {chars}]\n")
    if chars < TEXT_LAYER_MIN_CHARS:
        header += (
            "[NO TEXT LAYER — this document is almost certainly a scan.]\n"
            "[It will match no keyword search regardless of what it says.]\n"
            "[OCR it first:  bin/sentinel corpus ocr <folder> --out <folder>_derived]\n")
    elif not text_looks_readable(text):
        header += (
            "[TEXT EXTRACTED BUT IT IS NOT WORDS — font encoding problem.]\n"
            f"[{chars} characters came out and none of them read as English.]\n"
            "[This file has a text layer, so it does NOT look like a scan and\n"
            " will be reported as searchable by anything that only counts\n"
            " characters. It is not. Every keyword search over it will return\n"
            " nothing, silently, forever.]\n"
            "[Two possible causes, and they need different fixes:\n"
            "  1. The PDF uses a subset font with a broken or missing\n"
            "     ToUnicode map. OCR it like a scan.\n"
            "  2. The extractor here is too crude for it. Confirm by opening\n"
            "     it and trying to select and copy a sentence — if that works\n"
            "     in a viewer, the document is fine and the tooling is not.]\n")
    dest.write_text(header + "\n" + text, encoding="utf-8")
    return chars, str(dest)


def classify(row: dict) -> str:
    """The integrity verdict. Plain words, no jargon."""
    if row["size_bytes"] == 0 or row["sha256"].startswith(ZERO_BYTE_SHA):
        return "EMPTY FILE"
    if row["ext"] == ".docx":
        # A .docx IS a zip. Reporting that as a mislabelled bundle is true and
        # useless — it is a Word file, and it either yielded text or did not.
        if row.get("text_chars") is None:
            return "UNKNOWN — readability never tested"
        if row["text_chars"] < TEXT_LAYER_MIN_CHARS:
            return "WORD FILE WITH NO TEXT — check it by hand"
        return "searchable"
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
        if row.get("text_readable") is False:
            # Characters came out; words did not. Calling this "searchable"
            # is the one verdict that would send the operator away satisfied.
            return "TEXT IS NOT WORDS — encoding broken, needs OCR"
        return "searchable"
    return "ok"


def scan(root: Path, shelf_name: str = "", volume_id: str = "",
         volume_root: Path | None = None,
         done: dict | None = None,
         text_dir: Path | None = None) -> tuple[list[dict], str | None]:
    """Inventory one root.

    `shelf_name` and `volume_id` are carried onto every row. Without them a
    merged inventory of two drives is a list of relative paths you cannot
    locate: "records/a.pdf" exists on both, and nothing in the CSV says which
    physical object to plug in to go read it.

    Returns (rows, truncation_reason). A reason that is not None means the
    rows are a PREFIX of the folder, not the folder -- and the caller must not
    present them as an inventory of it.
    """
    volume_root = volume_root or root
    done = done or {}
    rows: list[dict] = []

    def blank(p: Path, note: str) -> dict:
        """A file that could not be read is still a file. It gets a row.

        The old code did `except OSError: continue`, which dropped the file
        from the inventory entirely -- so a file the desk could not read became
        a file the desk had never heard of, and the count looked clean.
        """
        return {
            "shelf": shelf_name, "volume_id": volume_id,
            "filename": p.name,
            "relpath": str(p.relative_to(root)),
            "ext": p.suffix.lower(), "size_bytes": 0, "size_kb": 0.0,
            "real_type": "unreadable", "sha256": "", "text_chars": None,
            "verdict": f"UNREADABLE — {note}",
        }

    try:
        files = [p for p in sorted(root.rglob("*")) if p.is_file()]
    except OSError as e:
        return [], f"could not list {root}: {e}"

    total = len(files)
    for i, p in enumerate(files, 1):
        if i % 25 == 0 or i == total:
            print(f"\r  scanning {i}/{total} ...", end="", file=sys.stderr)

        rel = str(p.relative_to(root))
        try:
            size = p.stat().st_size
        except OSError as e:
            if S.is_device_gone(e) or not S.volume_present(volume_root):
                print(file=sys.stderr)
                return rows, f"the drive disappeared after {i - 1} of {total} files"
            rows.append(blank(p, f"stat failed: {e.strerror or e}"))
            continue

        # Resume: an identical path+size that was already hashed is not
        # re-read. On a marginal USB drive the scan may take several attempts,
        # and re-hashing 8,000 files each time is how it never finishes.
        prior = done.get((shelf_name, rel, size))
        if prior is not None:
            rows.append(prior)
            continue

        row = {
            "shelf": shelf_name,
            "volume_id": volume_id,
            "filename": p.name,
            "relpath": rel,
            "ext": p.suffix.lower(),
            "size_bytes": size,
            "size_kb": round(size / 1024, 1),
            "real_type": magic_type(p),
            "sha256": "",
            "text_chars": None,
        }
        try:
            row["sha256"] = sha256_of(p) if size else "0" * 64
        except OSError as e:
            if S.is_device_gone(e) or not S.volume_present(volume_root):
                print(file=sys.stderr)
                return rows, f"the drive disappeared after {i - 1} of {total} files"
            rows.append(blank(p, f"read failed: {e.strerror or e}"))
            continue

        if row["ext"] in (".pdf", ".docx") and size > 0:
            if text_dir is not None:
                # One extraction, used twice: the count for the verdict and
                # the text for the corpus. Extracting twice would double the
                # slowest step in the scan for no gain.
                row["text_chars"], row["text_file"] = save_text(p, row["sha256"], text_dir)
                row["text_readable"] = None
                if row["text_file"]:
                    body = Path(row["text_file"]).read_text(encoding="utf-8", errors="replace")
                    row["text_readable"] = "TEXT EXTRACTED BUT IT IS NOT WORDS" not in body
            else:
                t = pdf_text(p)
                row["text_chars"] = None if t is None else len(t.strip())
                row["text_readable"] = None if t is None else text_looks_readable(t)
        row["verdict"] = classify(row)
        rows.append(row)

    print(file=sys.stderr)
    return rows, None


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


def load_previous(outdir: Path) -> dict:
    """Index a previous run's rows by (shelf, relpath, size) so --resume can
    skip re-hashing them.

    Size is part of the key on purpose. A file whose size changed is a
    different file, and reusing the old hash for it would put a digest in the
    ledger that does not match the bytes on the drive -- the one thing a hash
    exists to make impossible.
    """
    out: dict = {}
    for name in ("inventory.csv", "inventory.PARTIAL.csv"):
        f = outdir / name
        if not f.is_file():
            continue
        try:
            with f.open(newline="") as fh:
                for row in csv.DictReader(fh):
                    if not row.get("sha256"):
                        continue          # never resume an unread file
                    try:
                        size = int(row["size_bytes"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    row["size_bytes"] = size
                    row["size_kb"] = round(size / 1024, 1)
                    row["text_chars"] = (int(row["text_chars"])
                                         if row.get("text_chars") else None)
                    out[(row.get("shelf", ""), row["relpath"], size)] = row
        except OSError:
            continue
    return out


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
    ap.add_argument("--save-text", metavar="DIR",
                    help="also keep each PDF's extracted text, named by the "
                         "hash of the bytes it came from — a corpus you can "
                         "grep AND cite")
    ap.add_argument("--resume", action="store_true",
                    help="reuse hashes from a previous run in --out")
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
        targets.append((spec if vol else "", root, vol.id if vol else "",
                        vol.path if vol else root))

    outdir = Path(args.out).expanduser()
    outdir.mkdir(parents=True, exist_ok=True)

    done = load_previous(outdir) if args.resume else {}
    if done:
        print(f"Resuming — {len(done):,} files already hashed will not be re-read.")

    rows: list[dict] = []
    truncated: list[tuple[str, str]] = []
    for name, root, vid, vroot in targets:
        label = f"{name} ({root})" if name else str(root)
        print(f"Inventorying {label}")
        got, why = scan(root, shelf_name=name, volume_id=vid,
                        text_dir=(Path(args.save_text).expanduser()
                                  if args.save_text else None),
                        volume_root=vroot, done=done)
        rows.extend(got)
        if why:
            truncated.append((name or str(root), why))
            print(f"\n  !! {label}: {why}", file=sys.stderr)
            # Keep going. The OTHER drive's scan is complete and real, and
            # throwing it away because this one dropped is how 8,000 files of
            # hashing get done four times and finished never.

    # An empty folder is a real answer, not a crash. Writing a headerless CSV
    # or dying on rows[0] would both read as "the tool is broken" when the
    # actual fact is "you pointed it at nothing".
    if not rows:
        where = ", ".join(str(r) for _, r, _, _ in targets)
        print(f"\n  No files found under: {where}", file=sys.stderr)
        print("  Nothing was written. An empty result here is not a fact about",
              file=sys.stderr)
        print("  the records -- check the folder, or run: bin/sentinel shelf check",
              file=sys.stderr)
        return 1

    # A partial scan is NOT written to inventory.csv.
    #
    # The name is the only thing that survives into Numbers, into a later
    # session, into next month. A file called inventory.csv is read as the
    # inventory, and a truncated one read that way turns "the drive fell off
    # the bus" into "these records do not exist".
    complete = not truncated
    csv_path = outdir / ("inventory.csv" if complete else "inventory.PARTIAL.csv")
    fields = ["shelf", "volume_id", "filename", "relpath", "ext", "size_bytes",
              "size_kb", "real_type", "sha256", "text_chars", "verdict",
              "text_readable", "text_file"]
    with csv_path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    stale = outdir / ("inventory.PARTIAL.csv" if complete else "inventory.csv")
    if stale.exists():
        # A completed run must not leave last night's partial sitting beside
        # it, and a partial run must not leave a stale "complete" file that is
        # now the older, smaller truth.
        stale.rename(outdir / (stale.name + ".superseded"))

    if truncated:
        marker = outdir / "_INCOMPLETE.txt"
        with marker.open("w") as fh:
            fh.write("THIS INVENTORY IS INCOMPLETE.\n\n")
            for who, why in truncated:
                fh.write(f"  {who}: {why}\n")
            fh.write("\nRows for the shelves above are a PREFIX of what is on "
                     "them, not a list\nof what is on them. A file missing from "
                     "this CSV was not necessarily\nabsent from the drive -- "
                     "the scan stopped.\n\nRe-run with --resume to continue "
                     "without re-hashing what is already here.\n")

    make_charts(rows, outdir)

    # ---- the readable summary ----
    v = Counter(r["verdict"] for r in rows)
    total_mb = sum(r["size_bytes"] for r in rows) / 1e6
    print()
    print("=" * 64)
    print(f"  {len(rows)} files · {total_mb:,.1f} MB")
    if len(targets) > 1:
        print("-" * 64)
        for name, root, _, _ in targets:
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

    # Duplicates, split by whether they are on the SAME drive or both.
    #
    # Two drives with near-identical file counts usually means one is a copy of
    # the other, and a merged inventory then double-counts the corpus. That
    # changes what "37 GB of records" means, so it is reported rather than left
    # for someone to notice.
    by_hash: dict[str, list[dict]] = {}
    for r in rows:
        if r["size_bytes"] > 0 and r["sha256"]:
            by_hash.setdefault(r["sha256"], []).append(r)
    cross, within, wasted = 0, 0, 0
    for h, group in by_hash.items():
        if len(group) < 2:
            continue
        shelves = {g["shelf"] for g in group}
        if len(shelves) > 1:
            cross += 1
        else:
            within += 1
        wasted += group[0]["size_bytes"] * (len(group) - 1)
    if cross or within:
        print(f"\n {cross + within} file(s) appear more than once by SHA-256 "
              f"— {wasted/1e6:,.1f} MB of repeats")
        if cross:
            print(f"   {cross} of them exist on MORE THAN ONE shelf. If the drives")
            print(f"   are copies of each other, this corpus is smaller than it looks.")

    if truncated:
        print("\n" + "!" * 64)
        print("  THIS INVENTORY IS INCOMPLETE — the scan did not finish.")
        for who, why in truncated:
            print(f"    {who}: {why}")
        print("  A file missing from this CSV was not necessarily absent from")
        print("  the drive. The scan stopped.")
        print(f"  Continue with:  --resume")
        print("!" * 64)

    print(f"\n Dataset : {csv_path}")
    if HAVE_PLOT:
        print(f" Charts  : {outdir}/chart_*.png")
    else:
        print(" Charts  : skipped — matplotlib not installed "
              "(pip3 install matplotlib). The CSV above is the dataset.")
    # Non-zero on truncation. A caller that chains off this -- a script, a
    # later OCR pass -- must not treat a partial corpus as a finished one just
    # because the summary printed nicely.
    return 4 if truncated else 0


if __name__ == "__main__":
    sys.exit(main())
