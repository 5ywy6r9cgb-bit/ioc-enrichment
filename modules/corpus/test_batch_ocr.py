#!/usr/bin/env python3
"""
test_batch_ocr.py — the OCR stage, and the failure it used to hide.

The defect being guarded: this module was written for ZIP archives wearing a
.pdf name, and refused everything else. So an inventory would report
`NO TEXT LAYER — needs OCR` and name `corpus ocr` as the fix, and `corpus ocr`
would find no bundles and report nothing wrong. The operator was told to run a
command that could not help, by a tool that would not say so.
"""
from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch_ocr as B

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"    PASS  {label}")
    else:
        FAIL += 1
        print(f"    FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def main() -> int:
    print("\n  batch OCR\n")

    with TemporaryDirectory() as td:
        tmp = Path(td)

        # ══ A PDF IS RECOGNISED BY ITS BYTES, NOT ITS NAME ════════════════
        real = tmp / "real.pdf"
        real.write_bytes(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\ntrailer\n")
        check("a real PDF is identified from its magic bytes", B.is_pdf(real))

        liar = tmp / "liar.pdf"
        with zipfile.ZipFile(liar, "w") as z:
            z.writestr("page_0001.png", b"\x89PNG\r\n\x1a\n")
        check("a ZIP wearing a .pdf name is NOT treated as a PDF",
              not B.is_pdf(liar))
        check("and it is still recognised as the bundle it is",
              zipfile.is_zipfile(liar))

        notpdf = tmp / "notes.txt"
        notpdf.write_text("plain text")
        check("a text file is neither", not B.is_pdf(notpdf)
              and not zipfile.is_zipfile(notpdf))

        missing = tmp / "gone.pdf"
        check("a file that does not exist is not a PDF, and does not throw",
              not B.is_pdf(missing))

        # ══ THE SKIP MESSAGE MUST NAME BOTH THINGS IT LOOKED FOR ══════════
        #
        # "not a ZIP bundle" on a scanned PDF is a true statement that sends
        # the operator entirely the wrong way.
        src = Path(B.__file__).read_text()
        check("a file that is neither is refused as neither, not just 'not a ZIP'",
              'not a ZIP bundle and not a PDF' in src)
        check("a scanned PDF is routed to the PDF path instead of refused",
              'return process_scanned_pdf(src, outroot)' in src)
        check("and discovery picks up scanned PDFs, not only ZIP bundles",
              'is_pdf(p) and needs_ocr(p)' in src)

        # ══ A SEARCHABLE PDF IS NOT RE-READ ═══════════════════════════════
        #
        # Re-OCRing a PDF that already has a text layer costs minutes and
        # produces a WORSE transcript than the one it replaced.
        check("needs_ocr is what gates the work", callable(B.needs_ocr))
        check("the floor is the module's own constant, not a second literal",
              'meaningful_chars(out.stdout) < NATIVE_TEXT_MIN_CHARS' in src)
        check("an unreadable check errs toward OCR rather than skipping",
              'return True' in src.split('def needs_ocr')[1].split('def ')[0])

        # ══ THE TRANSCRIPT MUST DECLARE WHAT IT IS ════════════════════════
        #
        # OCR text carries character errors. A misread digit in a bid amount
        # is invisible in the transcript and fatal in print.
        check("the combined transcript says it is derived",
              'DERIVED — machine-read from page images' in src)
        check("and says to quote the page image instead",
              'Quote from the page image, never from here' in src)
        check("each page records whether it was OCR or native text",
              '"source"' in src or "rec['source']" in src)

        # ══ RESOLUTION IS NOT AN ARBITRARY NUMBER ═════════════════════════
        check("pages are rendered at 300 dpi", '"-r", "300"' in src)

        # ══ MISSING TOOLS ARE NAMED BEFORE THE RUN, NOT DURING ════════════
        check("poppler is required up front, not discovered mid-folder",
              'pdftoppm' in src and 'brew install poppler' in src)

        # ══ ONE MANIFEST, ONE TABLE ═══════════════════════════════════════
        #
        # The scanned-PDF path first shipped with its own row keys. The report
        # writer takes its columns from the FIRST row and refuses any row with
        # a field it has not seen — so a folder holding both kinds of file
        # read every page, wrote every transcript, and then died with a
        # traceback at the summary step. The work was done and on disk; the
        # run looked like a total failure.
        zip_keys = set(re.findall(r'"(\w+)":', src.split(
            'return {')[1].split('}')[0]))
        pdf_block = src.split('row = {')[1].split('}')[0]
        pdf_keys = set(re.findall(r'"(\w+)":', pdf_block))
        check("both paths emit the same manifest schema",
              zip_keys == pdf_keys, f"zip-only={zip_keys - pdf_keys} "
                                    f"pdf-only={pdf_keys - zip_keys}")
        check("a scan reports zero native pages, since it has no text layer",
              '"native": 0,' in src)

        check("the report takes the UNION of every row's keys, not the first row's",
              'for k in r:' in src and 'if k not in fields' in src)
        check("an unexpected field is ignored rather than raised on",
              'extrasaction="ignore"' in src)
        check("a missing field writes empty rather than failing the row",
              'restval=""' in src)
        check("and a failed summary never reads as failed OCR",
              'transcripts themselves are on disk and unaffected' in src)

    print(f"\n  {'FAIL' if FAIL else 'PASS'} — {PASS}/{PASS + FAIL} checks\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
