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

    print(f"\n  {'FAIL' if FAIL else 'PASS'} — {PASS}/{PASS + FAIL} checks\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
