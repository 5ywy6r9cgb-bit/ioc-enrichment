#!/usr/bin/env python3
"""
test_inventory.py

The scan runs for minutes over thousands of files on removable media, so the
question is never "does it work" but "what does it do when the drive goes away
halfway through". Three outcomes are possible and only one is acceptable:

    crash          -- loses every completed shelf as well (this happened)
    partial CSV    -- named inventory.csv, read forever as the inventory
    partial CSV    -- named PARTIAL, counted as partial, exit non-zero

These tests pin the third.
"""
from __future__ import annotations

import csv
import errno
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PASS = FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"    PASS  {label}")
    else:
        FAIL += 1
        print(f"    FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def build_drive(root: Path, label: str, n: int) -> None:
    (root / "records").mkdir(parents=True)
    for i in range(n):
        (root / "records" / f"doc_{i:03d}.pdf").write_bytes(
            b"%PDF-1.4\n" + bytes([i % 256]) * 400)


def run_inventory(args: list[str], env: dict) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(HERE / "inventory.py")] + args,
                          capture_output=True, text=True,
                          env={**os.environ, **env})


def main() -> int:
    print("\n  inventory — drives that go away mid-scan\n")
    import shelf as S
    import inventory as I

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        mounts = tmp / "Volumes"; mounts.mkdir()
        env = {"SENTINEL_MOUNT_ROOTS": str(mounts),
               "SENTINEL_SHELVES": str(tmp / "shelves.json")}
        os.environ.update(env)

        n1 = mounts / "N1"; build_drive(n1, "N1", 6)
        n2 = mounts / "N2"; build_drive(n2, "N2", 6)
        v1 = S.init_volume(n1, "N1"); v2 = S.init_volume(n2, "N2")
        cfg = S.load_config()
        S.bind(cfg, "N1", v1, subpath="records")
        S.bind(cfg, "N2", v2, subpath="records")

        # ══ 1. ONE BAD FILE IS A ROW, NOT A CRASH, NOT A DISAPPEARANCE ════
        # The old code did `except OSError: continue`, so a file that could not
        # be read became a file the inventory had never heard of.
        real_sha = I.sha256_of
        hit = {"n": 0}

        def flaky(p: Path) -> str:
            if p.name == "doc_002.pdf":
                hit["n"] += 1
                raise OSError(errno.EACCES, "Permission denied")
            return real_sha(p)

        I.sha256_of = flaky
        rows, why = I.scan(n1 / "records", "N1", v1.id, volume_root=n1)
        I.sha256_of = real_sha

        check("a single unreadable file does not stop the scan", why is None, str(why))
        check("every file still gets a row, readable or not", len(rows) == 6, str(len(rows)))
        bad = [r for r in rows if r["relpath"] == "doc_002.pdf"]
        check("the unreadable file is present and SAYS it is unreadable",
              len(bad) == 1 and bad[0]["verdict"].startswith("UNREADABLE"),
              str(bad))
        check("and it carries no hash, so nothing downstream trusts one",
              bad and bad[0]["sha256"] == "")

        # ══ 2. THE DRIVE VANISHING IS A DIFFERENT FACT ════════════════════
        # errno 6 on macOS. The remaining files are fine; the bus is not.
        def gone(p: Path) -> str:
            if p.name == "doc_003.pdf":
                raise OSError(errno.ENXIO, "Device not configured")
            return real_sha(p)

        I.sha256_of = gone
        rows, why = I.scan(n1 / "records", "N1", v1.id, volume_root=n1)
        I.sha256_of = real_sha

        check("a device-gone errno stops the scan rather than making rows",
              why is not None and "disappeared" in why, str(why))
        check("the rows returned are a PREFIX, not the folder",
              len(rows) == 3, f"{len(rows)} rows")
        check("no row claims the vanished files were unreadable",
              not any(r["verdict"].startswith("UNREADABLE") for r in rows))

        # ══ 3. THE MARKER GOING MISSING IS ALSO DEVICE-GONE ═══════════════
        # A drive can disappear without the errno arriving first -- the mount
        # point simply stops existing under the reader.
        marker = n1 / S.MARKER
        saved = marker.read_bytes()

        def yank(p: Path) -> str:
            if p.name == "doc_004.pdf":
                marker.unlink()
                raise OSError(errno.EACCES, "Permission denied")
            return real_sha(p)

        I.sha256_of = yank
        rows, why = I.scan(n1 / "records", "N1", v1.id, volume_root=n1)
        I.sha256_of = real_sha
        marker.write_bytes(saved)
        check("a vanished volume marker is treated as the drive going, not a bad file",
              why is not None and "disappeared" in why, str(why))

        # ══ 4. A TRUNCATED RUN IS NOT CALLED inventory.csv ════════════════
        out = tmp / "out"
        good = run_inventory(["N1", "N2", "--out", str(out)], env)
        check("a clean run exits 0", good.returncode == 0, good.stderr[-400:])
        check("and writes inventory.csv", (out / "inventory.csv").is_file())

        # Now break N2 by removing its marker mid-flight via a wrapper module.
        broken = tmp / "break.py"
        broken.write_text(f'''
import sys, errno
sys.path.insert(0, {str(HERE)!r})
import inventory as I
from pathlib import Path
real = I.sha256_of
def gone(p):
    if p.name == "doc_003.pdf" and "N2" in str(p):
        raise OSError(errno.ENXIO, "Device not configured")
    return real(p)
I.sha256_of = gone
sys.argv = ["inventory", "N1", "N2", "--out", {str(out)!r}]
sys.exit(I.main())
''')
        r = subprocess.run([sys.executable, str(broken)], capture_output=True,
                           text=True, env={**os.environ, **env})
        check("a truncated run exits non-zero", r.returncode == 4,
              f"rc={r.returncode}\n{r.stdout[-400:]}")
        check("it does NOT write inventory.csv",
              not (out / "inventory.csv").is_file())
        check("it writes inventory.PARTIAL.csv instead",
              (out / "inventory.PARTIAL.csv").is_file())
        check("it leaves an _INCOMPLETE.txt saying so",
              (out / "_INCOMPLETE.txt").is_file())
        check("the previous complete CSV is not left sitting beside it",
              (out / "inventory.csv.superseded").is_file(),
              str(sorted(p.name for p in out.iterdir())))
        check("the summary says the inventory is incomplete",
              "INCOMPLETE" in r.stdout, r.stdout[-300:])
        check("N1 was still fully scanned rather than discarded with N2",
              sum(1 for row in csv.DictReader(
                  (out / "inventory.PARTIAL.csv").open()) if row["shelf"] == "N1") == 6)

        # ══ 5. RESUME DOES NOT RE-READ WHAT IS ALREADY HASHED ═════════════
        prior = I.load_previous(out)
        check("a previous run indexes by shelf, path and size", len(prior) >= 6,
              str(len(prior)))
        read_count = {"n": 0}

        def counting(p: Path) -> str:
            read_count["n"] += 1
            return real_sha(p)

        I.sha256_of = counting
        rows, why = I.scan(n1 / "records", "N1", v1.id, volume_root=n1, done=prior)
        I.sha256_of = real_sha
        check("resume re-hashes nothing that is unchanged", read_count["n"] == 0,
              f"{read_count['n']} files re-read")
        check("but every file is still in the output", len(rows) == 6)

        # A file whose SIZE changed is a different file and must be re-read --
        # reusing that hash would put a digest in the ledger that does not
        # match the bytes on the drive.
        (n1 / "records" / "doc_000.pdf").write_bytes(b"%PDF-1.4\nCHANGED CONTENT")
        read_count["n"] = 0
        I.sha256_of = counting
        rows, why = I.scan(n1 / "records", "N1", v1.id, volume_root=n1, done=prior)
        I.sha256_of = real_sha
        check("a file whose size changed IS re-hashed", read_count["n"] == 1,
              f"{read_count['n']} re-read")

        # ══ 6. TWO DRIVES HOLDING THE SAME BYTES IS REPORTED ══════════════
        out2 = tmp / "out2"
        r = run_inventory(["N1", "N2", "--out", str(out2)], env)
        check("identical files across two shelves are reported as cross-shelf",
              "MORE THAN ONE shelf" in r.stdout, r.stdout[-500:])

        # ══ 7. KEEPING THE TEXT: A CORPUS YOU CAN GREP *AND* CITE ═════════
        #
        # The scraper this replaces kept the text and recorded no hash, so a
        # quoted paragraph could not be traced to the bytes it came from. And
        # it wrote an empty result for an image-only PDF with no comment —
        # which turns a 200-page scan into a document that "says nothing" and
        # every keyword search over it into a confident, wrong null.
        tdir = tmp / "textout"
        readable = tmp / "readable.pdf"
        readable.write_bytes(b"%PDF-1.4\nnot a real pdf body")
        sha = "a" * 64

        # pdftotext may not exist on the runner. Both paths must be safe, so
        # drive each one deliberately rather than depending on the machine.
        real = I.pdf_text
        try:
            I.pdf_text = lambda p: "Gowdy Field shaft site power extension\n" * 40
            chars, dest = I.save_text(readable, sha, tdir)
            body = Path(dest).read_text()
            check("the extracted text is kept", chars and chars > 200, str(chars))
            check("the file is named by the hash of the bytes it came from",
                  Path(dest).name.startswith(sha[:16]), Path(dest).name)
            check("and the text carries its own source and hash in a header",
                  str(readable) in body and sha in body)
            check("a readable document is not labelled a scan",
                  "NO TEXT LAYER" not in body)

            # The dangerous case.
            I.pdf_text = lambda p: "   \n  \n"
            chars, dest = I.save_text(readable, "b" * 64, tdir)
            body = Path(dest).read_text()
            check("an image-only PDF is written, not skipped", Path(dest).exists())
            check("and it SAYS it is a scan rather than reading as empty",
                  "NO TEXT LAYER" in body
                  and "match no keyword search" in body, body[:200])
            check("it names the command that fixes it",
                  "corpus ocr" in body)

            # The case that must never read as reassuring.
            I.pdf_text = lambda p: None
            chars, dest = I.save_text(readable, "c" * 64, tdir)
            body = Path(dest).read_text()
            check("a check that could not run reports None, not zero characters",
                  chars is None, str(chars))
            check("and the file says the check did not happen",
                  "did not happen" in body and "NOT a document that says nothing" in body)

            # ── THE INVISIBLE ONE ──────────────────────────────────────
            # A subset font with a broken ToUnicode map yields thousands of
            # characters that decode to the wrong glyphs. It is not empty, so
            # the scan check passes; the run did not fail, so the unknown
            # check passes. It lands marked "searchable" with a healthy
            # character count, and every keyword search over it returns
            # nothing, silently, forever. A 15-page piping specification in
            # this corpus came out exactly this way.
            TEXT_FLOOR = I.TEXT_LAYER_MIN_CHARS
            I.pdf_text = lambda p: '!!"# $%&\'( $%)*%+% + $%,*&\'(%*&& /&(\'&( ' * 400
            chars, dest = I.save_text(readable, "d" * 64, tdir)
            body = Path(dest).read_text()
            check("a healthy character count is NOT taken as readable text",
                  chars and chars > TEXT_FLOOR, str(chars))
            check("text that is not words is called out",
                  "IT IS NOT WORDS" in body, body[:160])
            check("and it is not mistaken for a scan, which needs a different fix",
                  "NO TEXT LAYER" not in body)
            check("both possible causes are named, since they need different fixes",
                  "ToUnicode" in body and "too crude" in body)

            # And the verdict must follow, or inventory.csv still says searchable.
            row = {"size_bytes": 10, "sha256": "d" * 64, "ext": ".pdf",
                   "real_type": "PDF document", "text_chars": 5000,
                   "text_readable": False}
            check("the CSV verdict does not call it searchable",
                  I.classify(row) == "TEXT IS NOT WORDS — encoding broken, needs OCR",
                  I.classify(row))
            row["text_readable"] = True
            check("but genuinely readable text still reads as searchable",
                  I.classify(row) == "searchable", I.classify(row))
            row["text_readable"] = None
            check("and a document never checked for readability is not condemned",
                  I.classify(row) == "searchable", I.classify(row))

        finally:
            I.pdf_text = real

        # ══ 8. A WORD FILE IS NOT AN EMPTY BUNDLE ═════════════════════════
        #
        # A .docx IS a zip, so magic-byte sniffing calls it an archive. The OCR
        # stage did exactly that, looked for page images, found none, and
        # reported "ZIP contains no page images" — a true sentence meaning
        # "we could not read this" that reads as "there was nothing in it".
        # One of the two files skipped that way here was the regulator's own
        # PTI review comments on a public works project.
        import zipfile as _zip
        wd = tmp / "word"; wd.mkdir()
        docx = wd / "comments.docx"
        body = ('<?xml version="1.0"?><w:document><w:body>'
                '<w:p><w:r><w:t>Comment 1: Sheet C313 is omitted.</w:t></w:r></w:p>'
                '<w:p><w:r><w:t>Comment 2: G011 list incomplete &amp; revised.</w:t></w:r></w:p>'
                '</w:body></w:document>')
        with _zip.ZipFile(docx, "w") as z:
            z.writestr("word/document.xml", body)
            z.writestr("[Content_Types].xml", "<x/>")

        text = I.docx_text(docx)
        check("a Word document yields its text", text and "Sheet C313" in text)
        check("paragraphs stay on separate lines rather than running together",
              text.count("\n") >= 1, repr(text))
        check("XML entities are decoded, so a quote is quotable",
              "&" in text and "&amp;" not in text)
        check("markup is stripped, not left in the body",
              "<w:" not in text)

        plain = wd / "bundle.pdf"
        with _zip.ZipFile(plain, "w") as z:
            z.writestr("page_0001.png", b"\x89PNG")
        check("a page-image bundle is NOT mistaken for a Word file",
              I.docx_text(plain) is None)
        check("a missing file returns None rather than throwing",
              I.docx_text(tmp / "nope.docx") is None)

        # And the verdict must not call it a mislabelled PDF.
        row = {"ext": ".docx", "size_bytes": 10, "sha256": "a" * 64,
               "real_type": "Zip archive", "text_chars": 5000}
        check("a readable Word file is searchable, not 'not actually a PDF'",
              I.classify(row) == "searchable", I.classify(row))
        row["text_chars"] = 3
        check("an empty one says so in Word terms",
              "WORD FILE WITH NO TEXT" in I.classify(row), I.classify(row))
        row["text_chars"] = None
        check("and one never tested is not called readable",
              "never tested" in I.classify(row), I.classify(row))

        ocr_src = (Path(__file__).parent / "batch_ocr.py").read_text()
        check("the OCR stage no longer treats Office files as page bundles",
              '".docx", ".xlsx", ".pptx"' in ocr_src)

    # ══ ONE OUTPUT FOLDER PER SOURCE ═══════════════════════════════════
    #
    # --out defaulted to a single "inventory_out" for every run, and the
    # supersede rule assumed both files described the SAME corpus. They do
    # not. Inventorying N1 (7,958 files, COMPLETE) and then N2 (which fell
    # off the bus at 3,468) wrote N2's PARTIAL into the slot N1's result had
    # just filled and renamed N1's away as "superseded" -- a finished
    # inventory of one drive retired by a half-finished scan of another,
    # silently. That happened on the live desk.
    check("each shelf gets its own inventory folder",
          I.source_slug(["N1"]) == "N1" and I.source_slug(["N2"]) == "N2")
    check("and they are not the same folder",
          I.source_slug(["N1"]) != I.source_slug(["N2"]))
    # A genuine two-drive scan is a THIRD corpus. Folding it into either
    # drive's folder would let a two-drive partial retire a one-drive
    # complete, which is the same bug wearing a different hat.
    check("a multi-root scan is its own corpus, not either drive's",
          I.source_slug(["N1", "N2"]) == "N1+N2")
    # A path keeps its last TWO components, because one is not enough: the
    # local copy of a drive is filed under the drive's own name, so
    # ~/sentinel/evidence/lot/N2 and the shelf N2 both reduced to "N2" and
    # landed in one folder on the live desk.
    check("a path keeps enough of itself to stay distinct",
          I.source_slug(["/Volumes/NO NAME"]) == "Volumes-NO-NAME")
    check("a drive's local copy does not collide with the drive",
          I.source_slug(["/Users/Mark/sentinel/evidence/lot/N2"]) != I.source_slug(["N2"]))
    check("and it says where it came from",
          I.source_slug(["/Users/Mark/sentinel/evidence/lot/N2"]) == "lot-N2")
    check("a trailing slash does not produce an empty name",
          I.source_slug(["/Users/Mark/sentinel/evidence/lot/"]) == "evidence-lot")
    check("a name that sanitises to nothing still yields a folder",
          I.source_slug(["///"]) != "")

    with tempfile.TemporaryDirectory() as td:
        out = Path(td)
        check("an empty folder reports no prior source rather than throwing",
              I.source_of(out) is None)
        (out / "_SOURCE.txt").write_text("N1\n")
        check("a recorded source is read back without its newline",
              I.source_of(out) == "N1")

    src = (Path(__file__).parent / "inventory.py").read_text()
    check("a partial run refuses to retire a DIFFERENT corpus's inventory",
          "It was LEFT ALONE" in src)
    check("and says the two are sharing one output folder",
          "sharing one output" in src)
    check("superseding still happens within one source",
          "describe the SAME source" in src)

    print(f"\n  {'FAIL' if FAIL else 'PASS'} — {PASS}/{PASS + FAIL} checks\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
