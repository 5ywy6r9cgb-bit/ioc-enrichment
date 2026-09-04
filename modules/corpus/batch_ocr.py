#!/usr/bin/env python3
"""
batch_ocr.py — The Sentinel Report · Research Desk
================================================================================
Reads ZIP-wrapped "PDF" record bundles and produces searchable DERIVED text.

WHY
    Records portals are producing bundles that carry a .pdf extension but are
    actually ZIP archives of page images. On 2026-08-25 an inventory of 349
    files found 78 of them. grep, pdftotext, and every keyword search ever run
    against those files returned nothing regardless of content. This makes them
    readable.

WHAT IT PRODUCES  (per bundle, under --out)
    <stem>__<sha8>/page_0001.txt ...   one file per page
    <stem>__<sha8>/_combined.txt       all pages, with page markers
    <stem>__<sha8>/provenance.json     per-page: native text or OCR, char count
    _manifest.jsonl                    one append-only row per bundle
    _report.csv                        flat summary you can open in Numbers

PROVENANCE — READ THIS
    Output is DERIVED, never primary. Two different origins are tracked per
    page and you must not conflate them:
      source="native"  text came from the bundle's own text layer. Reliable.
      source="ocr"     text was machine-read off a page image. Contains
                       character errors. NEVER quote from it. Open the page
                       image and quote what you see.
    Shelve this output as DERIVED so PRIMARY_ONLY gates do not treat a machine
    transcript as a document.

SAFETY
    Originals are opened read-only and never modified.
    Zip entries with absolute paths or '..' are refused (path traversal).
    Every page render is timeout-capped so one bad image cannot hang the run.
    Resumable: re-running skips bundles already completed, keyed on source
    SHA-256. Interrupt it with Ctrl-C and start it again; nothing is lost.

USAGE
    python3 batch_ocr.py ~/sentinel/library --out ~/sentinel/library_derived
    python3 batch_ocr.py ~/sentinel/library --out ~/derived --dry-run
    python3 batch_ocr.py ~/sentinel/library --out ~/derived --limit 2
    python3 batch_ocr.py ~/sentinel/library --out ~/derived --workers 2 --force
================================================================================
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import csv
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shelf as S

# --------------------------------------------------------------- tunables ---
IMAGE_EXTS = {".jpeg", ".jpg", ".png", ".tif", ".tiff", ".bmp"}
PAGE_TIMEOUT_SEC = 180        # per page; a hung tesseract cannot stall the run
TESS_PSM = "6"                # one uniform block of text — right for contracts
NATIVE_TEXT_MIN_CHARS = 120   # below this, a bundled .txt is treated as empty
MIN_FREE_BYTES = 500 * 1024 * 1024

# Bundled page text often contains only a Docusign envelope stamp. That is not
# document text and must not count toward the native-text threshold.
BOILERPLATE = re.compile(
    r"^\s*(docusign envelope id\s*:.*|certificate of completion.*|page \d+ of \d+)\s*$",
    re.IGNORECASE)


class Skip(Exception):
    """Bundle cannot be processed. Carries a plain-English reason."""


# ----------------------------------------------------------------- helpers ---
def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def natural_key(name: str):
    """Order 2.jpeg before 10.jpeg. Lexical sort gets this wrong."""
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r"(\d+)", name)]


def safe_member(name: str) -> bool:
    """Refuse absolute paths, drive letters, and parent traversal."""
    if not name or name.endswith("/"):
        return False
    if name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", name):
        return False
    parts = Path(name).parts
    return ".." not in parts


def meaningful_chars(text: str) -> int:
    """Length of text with boilerplate lines removed."""
    keep = [ln for ln in text.splitlines() if ln.strip()
            and not BOILERPLATE.match(ln)]
    return len("\n".join(keep).strip())


def require_tools() -> str:
    if shutil.which("tesseract") is None:
        sys.exit("tesseract not found.  Install it:  brew install tesseract")
    # The scanned-PDF path renders pages with poppler before reading them.
    # Discovering that halfway through a folder wastes the whole run.
    for tool in ("pdftoppm", "pdftotext"):
        if shutil.which(tool) is None:
            sys.exit(f"{tool} not found (poppler).  Install it:  brew install poppler")
    try:
        v = subprocess.run(["tesseract", "--version"], capture_output=True,
                           text=True, timeout=20).stdout.splitlines()[0]
    except Exception:
        v = "tesseract (version unknown)"
    return v.strip()


def ocr_image(img: Path) -> tuple[str, str | None]:
    """Returns (text, error). Never raises."""
    with tempfile.TemporaryDirectory() as td:
        stem = Path(td) / "o"
        try:
            r = subprocess.run(
                ["tesseract", str(img), str(stem), "--psm", TESS_PSM],
                capture_output=True, text=True, timeout=PAGE_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            return "", f"timeout after {PAGE_TIMEOUT_SEC}s"
        except Exception as e:
            return "", f"tesseract failed: {e}"
        out = stem.with_suffix(".txt")
        if not out.exists():
            return "", (r.stderr or "no output produced").strip()[:200]
        return out.read_text(errors="replace"), None


# ------------------------------------------------------------ core worker ---
def is_pdf(path: Path) -> bool:
    """A real PDF, by its magic bytes rather than its name."""
    try:
        with path.open("rb") as f:
            return f.read(5) == b"%PDF-"
    except OSError:
        return False


def pdf_page_count(path: Path) -> int | None:
    try:
        out = subprocess.run(["pdfinfo", str(path)], capture_output=True,
                             text=True, timeout=60)
        m = re.search(r"^Pages:\s+(\d+)", out.stdout, re.M)
        return int(m.group(1)) if m else None
    except Exception:
        return None


def process_scanned_pdf(src: Path, outroot: Path) -> dict:
    """
    OCR an ordinary scanned PDF.

    ─────────────────────────────────────────────────────────────────────
    WHY THIS BRANCH EXISTS

    This module was written for one problem: records portals serving ZIP
    archives of page images under a .pdf name. It refused anything that was
    not a ZIP, which is correct for that job and useless for the far more
    common one — a PDF that really is a PDF and really has no text layer,
    because somebody scanned paper.

    The consequence was quiet and bad. An inventory would report
    `NO TEXT LAYER — needs OCR` and name `corpus ocr` as the fix; `corpus ocr`
    would then find no bundles and report nothing wrong. The operator has been
    told to run a command that cannot help, by a tool that will not say so.

    Pages are rendered with pdftoppm (poppler) and read with tesseract — the
    same two tools the ZIP path already requires.

    ─────────────────────────────────────────────────────────────────────
    THE OUTPUT IS DERIVED, AND THAT IS NOT A FORMALITY

    OCR text contains character errors. A misread digit in a bid amount or a
    date is invisible in the transcript and fatal in print. This output is for
    SEARCHING — for finding which page says the thing. Quote from the page
    image, never from here.
    """
    size = src.stat().st_size
    if size == 0:
        raise Skip("empty file — zero bytes, nothing to read")

    sha = sha256_of(src)
    dest = outroot / f"{src.stem}__{sha[:8]}"
    dest.mkdir(parents=True, exist_ok=True)
    img_dir = dest / "pages"
    img_dir.mkdir(exist_ok=True)

    # 300 dpi is the floor at which tesseract reads a typed page reliably.
    # Lower is faster and produces a transcript that looks fine and is wrong.
    try:
        subprocess.run(
            ["pdftoppm", "-r", "300", "-png", str(src), str(img_dir / "page")],
            capture_output=True, timeout=PAGE_TIMEOUT_SEC * 20, check=True)
    except subprocess.CalledProcessError as e:
        raise Skip(f"pdftoppm failed: {(e.stderr or b'')[:120]!r}")
    except subprocess.TimeoutExpired:
        raise Skip("pdftoppm timed out")

    images = sorted(img_dir.glob("page-*.png"), key=lambda p: natural_key(p.name))
    if not images:
        raise Skip("no pages rendered")

    pages, n_ocr, n_failed = [], 0, 0
    combined = []
    for idx, img in enumerate(images, 1):
        rec = {"page": idx, "zip_entry": None, "error": None}
        text, err = ocr_image(img)
        if err:
            rec.update(source="failed", error=err)
            n_failed += 1
            text = ""
        else:
            rec["source"] = "ocr"
            n_ocr += 1
        rec["chars"] = meaningful_chars(text)
        (dest / f"page_{idx:04d}.txt").write_text(text, encoding="utf-8")
        combined.append(f"\n[Page {idx} — source: {rec['source']}]\n{text}")
        pages.append(rec)

    (dest / "_combined.txt").write_text(
        "[DERIVED — machine-read from page images. Contains character errors.]\n"
        "[Use it to FIND the page. Quote from the page image, never from here.]\n"
        f"[source: {src}]\n[sha256: {sha}]\n" + "".join(combined),
        encoding="utf-8")

    row = {
        "source_path": str(src), "sha256": sha, "bytes": size,
        "kind": "scanned_pdf", "pages": len(images),
        "native_pages": 0, "ocr_pages": n_ocr, "failed_pages": n_failed,
        "out_dir": str(dest),
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    (dest / "provenance.json").write_text(
        json.dumps({"bundle": row, "pages": pages}, indent=2), encoding="utf-8")
    return row


def needs_ocr(path: Path) -> bool:
    """
    Does this PDF actually need OCR?

    Re-reading a searchable PDF costs minutes per file and produces a WORSE
    transcript than the text layer it already had. So the same floor the
    inventory uses decides it here: a PDF whose own text layer is thin enough
    to fail a search is the only one worth rendering and reading.
    """
    try:
        out = subprocess.run(["pdftotext", str(path), "-"],
                             capture_output=True, text=True, timeout=90)
        return meaningful_chars(out.stdout) < NATIVE_TEXT_MIN_CHARS
    except Exception:
        # If pdftotext cannot run, we do not know. Attempting OCR is the
        # answer that cannot hide a document; skipping is the one that can.
        return True


def process_bundle(src: Path, outroot: Path) -> dict:
    """Process one bundle. Returns a manifest row. Raises Skip if unusable."""
    size = src.stat().st_size
    if size == 0:
        raise Skip("empty file — zero bytes, nothing to read")
    if not zipfile.is_zipfile(src):
        if is_pdf(src):
            return process_scanned_pdf(src, outroot)
        raise Skip("not a ZIP bundle and not a PDF")

    sha = sha256_of(src)
    dest = outroot / f"{src.stem}__{sha[:8]}"

    with zipfile.ZipFile(src) as z:
        members = z.namelist()
        unsafe = [m for m in members if m and not m.endswith("/")
                  and not safe_member(m)]
        if unsafe:
            raise Skip(f"unsafe zip entries refused: {unsafe[:3]}")

        images = sorted([m for m in members
                         if Path(m).suffix.lower() in IMAGE_EXTS],
                        key=natural_key)
        if not images:
            raise Skip("ZIP contains no page images")

        # bundled per-page text, matched to an image by stem
        sidecars: dict[str, str] = {}
        for m in members:
            if Path(m).suffix.lower() == ".txt":
                try:
                    sidecars[Path(m).stem] = z.read(m).decode(
                        "utf-8", errors="replace")
                except Exception:
                    pass

        dest.mkdir(parents=True, exist_ok=True)
        img_dir = dest / "pages"
        img_dir.mkdir(exist_ok=True)

        pages, n_native, n_ocr, n_failed = [], 0, 0, 0
        for idx, member in enumerate(images, 1):
            stem = Path(member).stem
            native = sidecars.get(stem, "")
            rec = {"page": idx, "zip_entry": member, "error": None}

            if meaningful_chars(native) >= NATIVE_TEXT_MIN_CHARS:
                text, rec["source"] = native, "native"
                n_native += 1
            else:
                # extract the image only when OCR is actually needed
                target = img_dir / f"page_{idx:04d}{Path(member).suffix.lower()}"
                try:
                    with z.open(member) as fsrc, target.open("wb") as fdst:
                        shutil.copyfileobj(fsrc, fdst)
                except Exception as e:
                    rec.update(source="failed", error=f"extract failed: {e}")
                    pages.append({**rec, "chars": 0})
                    n_failed += 1
                    continue
                text, err = ocr_image(target)
                if err:
                    rec.update(source="failed", error=err)
                    n_failed += 1
                else:
                    rec["source"] = "ocr"
                    n_ocr += 1

            chars = meaningful_chars(text)
            rec["chars"] = chars
            if rec["source"] == "ocr" and chars == 0:
                # OCR ran clean but found nothing. Blank page, or a scan too
                # poor to read. Either way it is NOT "no text in the document".
                rec["error"] = "OCR produced no text — blank page or unreadable scan"
            (dest / f"page_{idx:04d}.txt").write_text(text)
            pages.append(rec)

    header = (
        f"{src.name}\n"
        f"SHELF: DERIVED — machine-processed. Not a primary source.\n"
        f"Source SHA-256: {sha}\n"
        f"Extracted: {datetime.now(timezone.utc).isoformat()}\n"
        f"Pages: {len(pages)}  (native text {n_native} · OCR {n_ocr} · failed {n_failed})\n"
        f"Pages marked [OCR] contain character errors. Quote from the page\n"
        f"image in ./pages/, never from this transcript.\n"
        + "=" * 72 + "\n")
    with (dest / "_combined.txt").open("w") as fh:
        fh.write(header)
        for rec in pages:
            tag = {"native": "NATIVE TEXT", "ocr": "[OCR]",
                   "failed": "[FAILED]"}.get(rec["source"], "?")
            fh.write(f"\n----- PAGE {rec['page']} · {tag} -----\n")
            if rec["error"]:
                fh.write(f"!! {rec['error']}\n")
            fh.write((dest / f"page_{rec['page']:04d}.txt").read_text())

    (dest / "provenance.json").write_text(json.dumps({
        "source_file": src.name,
        "source_sha256": sha,
        "source_bytes": size,
        "extracted_utc": datetime.now(timezone.utc).isoformat(),
        "shelf": "DERIVED",
        "tesseract_psm": TESS_PSM,
        "pages": pages,
    }, indent=2))

    return {
        "source_file": src.name,
        "source_sha256": sha,
        "output_dir": dest.name,
        "pages": len(pages),
        "native": n_native,
        "ocr": n_ocr,
        "failed": n_failed,
        "chars_total": sum(p["chars"] for p in pages),
        "status": "ok" if n_failed == 0 else "partial",
        "reason": "",
        "processed_utc": datetime.now(timezone.utc).isoformat(),
    }


# ------------------------------------------------------------------- main ---
def load_done(manifest: Path) -> set[str]:
    if not manifest.exists():
        return set()
    done = set()
    for line in manifest.read_text().splitlines():
        try:
            r = json.loads(line)
            if r.get("status") in ("ok", "partial"):
                done.add(r["source_sha256"])
        except Exception:
            continue
    return done


def resolve_out(spec: str) -> Path:
    """Resolve --out, allowing a shelf name for a folder that does not exist yet.

    resolve_root() insists the target already exists, which is right for a
    corpus you are reading and wrong for a derived folder you are creating.
    But the VOLUME still has to be mounted -- writing derived text to a stale
    mount point puts it on the laptop's boot disk under a name that says
    otherwise, and it is only found again when the disk fills up.
    """
    cfg = S.load_config()
    head, _, tail = spec.partition("/")
    if head in cfg.shelves:
        base, _ = S.require(head, cfg)
        return (base / tail if tail else base).resolve()
    return Path(spec).expanduser().resolve()


def main() -> int:
    ap = argparse.ArgumentParser(prog="sentinel corpus ocr")
    ap.add_argument("root", help="folder of record bundles")
    ap.add_argument("--out", required=True, help="DERIVED output folder")
    ap.add_argument("--workers", type=int, default=0,
                    help="parallel bundles; 0 = auto (cpu-1, max 4)")
    ap.add_argument("--limit", type=int, default=0, help="stop after N bundles")
    ap.add_argument("--force", action="store_true", help="reprocess completed")
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would be processed; read nothing")
    args = ap.parse_args()

    root, src_vol = S.resolve_root(args.root)
    if not root.is_dir():
        sys.exit(f"Not a folder: {root}")

    # --out takes a shelf name too, but must not REQUIRE one to exist yet:
    # the derived folder is normally created by this run.
    outroot = resolve_out(args.out)
    if outroot == root or root in outroot.parents:
        sys.exit("--out must not be inside the source folder.")

    # Both problems, not just the one this module started with: a ZIP wearing
    # a .pdf name, AND a PDF that really is one and really has no text layer.
    candidates = sorted(p for p in root.rglob("*")
                        if p.is_file()
                        and (zipfile.is_zipfile(p)
                             or (is_pdf(p) and needs_ocr(p))))
    if not candidates:
        # Distinguish "no bundles here" from "nothing here at all". The second
        # usually means the drive is not mounted, and reporting it as the first
        # reads as a fact about the records.
        if not any(root.rglob("*")):
            print(f"\n  {root} is EMPTY -- not 'no bundles', nothing at all.",
                  file=sys.stderr)
            print("  If this is an external drive, check it is really mounted:",
                  file=sys.stderr)
            print("    bin/sentinel shelf check\n", file=sys.stderr)
            return 1
        print("No ZIP bundles found. Nothing to do.")
        return 0

    # Page images are extracted next to the text, so the output is bulk, not a
    # summary. Running out of room mid-corpus leaves a half-OCR'd folder that
    # looks finished, so the space is checked against the source size first.
    need = sum(p.stat().st_size for p in candidates)
    free = S.free_bytes(outroot if outroot.exists() else outroot.parent)
    if free is not None and free < need:
        print(f"\n  NOT ENOUGH ROOM on the output drive.", file=sys.stderr)
        print(f"  bundles {S.human(need)}  ·  free {S.human(free)}", file=sys.stderr)
        print(f"  Page images are extracted alongside the text, so plan on at",
              file=sys.stderr)
        print(f"  least the size of the source. Point --out at a drive with room.\n",
              file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"DRY RUN — {len(candidates)} bundle(s) would be processed:\n")
        for p in candidates[:40]:
            print(f"  {p.stat().st_size/1024:9.1f} KB  {p.relative_to(root)}")
        if len(candidates) > 40:
            print(f"  ... and {len(candidates)-40} more")
        print("\nNothing was read or written.")
        return 0

    version = require_tools()
    outroot.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(outroot).free
    if free < MIN_FREE_BYTES:
        sys.exit(f"Only {free/1e6:.0f} MB free at {outroot}. Free up space first.")

    manifest = outroot / "_manifest.jsonl"
    done = set() if args.force else load_done(manifest)
    already = [p for p in candidates if not args.force and sha256_of(p) in done]
    todo = [p for p in candidates if p not in already]
    limited = 0
    if args.limit and len(todo) > args.limit:
        limited = len(todo) - args.limit
        todo = todo[:args.limit]

    print(f"{version}")
    print(f"Source : {root}")
    print(f"Output : {outroot}")
    print(f"Bundles: {len(candidates)} found · {len(already)} already done "
          f"· {len(todo)} to process"
          + (f" · {limited} deferred by --limit" if limited else ""))
    print()
    if not todo:
        print("Everything is already processed. Use --force to redo.")
        return 0

    workers = args.workers or max(1, min(4, (os.cpu_count() or 2) - 1))
    rows: list[dict] = []
    interrupted = False

    def write_row(row: dict) -> None:
        with manifest.open("a") as fh:      # append after EVERY bundle,
            fh.write(json.dumps(row) + "\n")  # so a crash loses at most one

    signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        with futures.ThreadPoolExecutor(max_workers=workers) as ex:
            future_map = {ex.submit(process_bundle, p, outroot): p for p in todo}
            for i, fut in enumerate(futures.as_completed(future_map), 1):
                src = future_map[fut]
                try:
                    row = fut.result()
                except Skip as e:
                    row = {"source_file": src.name,
                           "source_sha256": sha256_of(src),
                           "output_dir": "", "pages": 0, "native": 0, "ocr": 0,
                           "failed": 0, "chars_total": 0, "status": "skipped",
                           "reason": str(e),
                           "processed_utc": datetime.now(timezone.utc).isoformat()}
                except Exception as e:
                    row = {"source_file": src.name,
                           "source_sha256": sha256_of(src),
                           "output_dir": "", "pages": 0, "native": 0, "ocr": 0,
                           "failed": 0, "chars_total": 0, "status": "error",
                           "reason": f"{type(e).__name__}: {e}",
                           "processed_utc": datetime.now(timezone.utc).isoformat()}
                rows.append(row)
                write_row(row)
                flag = {"ok": " ", "partial": "!", "skipped": "-",
                        "error": "!"}[row["status"]]
                print(f" {flag} [{i}/{len(todo)}] {row['source_file'][:44]:<44} "
                      f"{row['pages']:>3}p  native {row['native']:>3} "
                      f"ocr {row['ocr']:>3} fail {row['failed']:>2}"
                      + (f"  — {row['reason'][:40]}" if row["reason"] else ""))
    except KeyboardInterrupt:
        interrupted = True
        print("\n\nInterrupted. Completed bundles are saved. "
              "Re-run the same command to resume.")

    report = outroot / "_report.csv"
    all_rows = []
    for line in manifest.read_text().splitlines():
        try:
            all_rows.append(json.loads(line))
        except Exception:
            pass
    if all_rows:
        with report.open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(all_rows[0].keys()))
            w.writeheader()
            w.writerows(all_rows)

    ok = sum(1 for r in rows if r["status"] == "ok")
    part = sum(1 for r in rows if r["status"] == "partial")
    skip = sum(1 for r in rows if r["status"] == "skipped")
    err = sum(1 for r in rows if r["status"] == "error")
    print("\n" + "=" * 66)
    print(f"  {ok} complete · {part} partial · {skip} skipped · {err} error")
    print(f"  {sum(r['pages'] for r in rows)} pages "
          f"({sum(r['native'] for r in rows)} native · "
          f"{sum(r['ocr'] for r in rows)} OCR · "
          f"{sum(r['failed'] for r in rows)} failed)")
    print("=" * 66)
    for r in rows:
        if r["status"] in ("skipped", "error"):
            print(f"  {r['status'].upper():<8} {r['source_file'][:40]:<40} {r['reason'][:40]}")
    print(f"\n  Text     : {outroot}/<bundle>/_combined.txt")
    print(f"  Report   : {report}")
    print("\n  This output is DERIVED. Shelve it separately from primary")
    print("  sources. Quote from the page image, never from OCR text.")
    return 1 if (err or interrupted) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # piped into head/less and the reader closed early — not an error
        try:
            sys.stdout.close()
        except Exception:
            pass
        os._exit(0)
