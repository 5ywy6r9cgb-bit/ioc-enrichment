#!/usr/bin/env python3
"""
test_shelf.py

The failure being tested for is not a crash. It is a scan that runs cleanly
over a drive that is not there, finds nothing, and reports nothing found.
Every test below is a variation on "does the desk notice it is reading the
wrong thing, or no thing at all".
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PASS = FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"    PASS  {label}")
    else:
        FAIL += 1
        print(f"    FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def main() -> int:
    print("\n  shelves\n")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        mounts = tmp / "Volumes"
        mounts.mkdir()
        os.environ["SENTINEL_MOUNT_ROOTS"] = str(mounts)
        import shelf as S
        cfgp = tmp / "shelves.json"

        # ── a drive gets an identity, and it survives a remount ────────────
        n1 = mounts / "N1"; n1.mkdir()
        (n1 / "records").mkdir()
        (n1 / "records" / "a.pdf").write_text("%PDF-1.4")
        v1 = S.init_volume(n1, "N1")
        check("initialising a drive writes a marker", (n1 / S.MARKER).is_file())
        check("the volume gets a durable id", bool(v1.id) and len(v1.id) > 8)
        check("re-initialising without --force keeps the SAME id",
              S.init_volume(n1, "N1").id == v1.id)
        check("--force mints a new one", S.init_volume(n1, "N1", force=True).id != v1.id)
        v1 = S._read_marker(n1)

        cfg = S.load_config(cfgp)
        S.bind(cfg, "N1", v1, subpath="records")
        r = S.resolve("N1", cfg)
        check("a bound shelf resolves to its folder",
              r.ok and r.path == n1 / "records", str(r))

        # ── TRAP 1: the drive moves to a different mount point ────────────
        moved = mounts / "N1 1"
        n1.rename(moved)
        r = S.resolve("N1", S.load_config(cfgp))
        check("the shelf follows the VOLUME, not the path, when macOS renames it",
              r.ok and r.path == moved / "records", str(r))
        moved.rename(n1)

        # ── TRAP 2: a stale mount point with no drive behind it ───────────
        cfg = S.load_config(cfgp)
        stash = tmp / "unplugged"
        n1.rename(stash)                 # drive unplugged
        (mounts / "N1").mkdir()          # empty stub left behind
        r = S.resolve("N1", cfg)
        check("an unplugged drive is refused, not reported as empty",
              (not r.ok) and r.kind == "not_mounted", str(r))
        check("and the empty stub at the old path is named as a stub",
              any("stale mount point" in d for d in r.detail),
              "\n".join(r.detail))
        check("the refusal says nothing was read",
              "not mounted" in r.message)
        (mounts / "N1").rmdir()
        stash.rename(n1)

        # ── TRAP 3: a DIFFERENT drive wearing the same label ──────────────
        cfg = S.load_config(cfgp)
        stash = tmp / "unplugged2"
        n1.rename(stash)
        impostor = mounts / "N1"; impostor.mkdir()
        (impostor / "records").mkdir()
        S.init_volume(impostor, "N1")
        r = S.resolve("N1", cfg)
        check("a same-label DIFFERENT drive is refused",
              (not r.ok) and r.kind == "label_conflict", str(r))
        check("the refusal says it is a different physical drive",
              any("different physical drive" in d for d in r.detail),
              "\n".join(r.detail))
        import shutil as _sh
        _sh.rmtree(impostor)
        stash.rename(n1)

        # ── TRAP 4: a clone — two mounted volumes, one identity ───────────
        cfg = S.load_config(cfgp)
        clone = mounts / "N1-copy"
        _sh.copytree(n1, clone)
        r = S.resolve("N1", cfg)
        check("two volumes sharing an id are refused as ambiguous",
              (not r.ok) and r.kind == "ambiguous", str(r))
        check("both candidates are printed so you can unmount one",
              sum(1 for d in r.detail if str(mounts) in d) == 2,
              "\n".join(r.detail))
        _sh.rmtree(clone)

        # ── the folder inside the drive is gone, but the drive is fine ────
        cfg = S.load_config(cfgp)
        _sh.rmtree(n1 / "records")
        r = S.resolve("N1", cfg)
        check("a missing subfolder is distinguished from a missing drive",
              (not r.ok) and r.kind == "subpath_missing", str(r))
        (n1 / "records").mkdir()
        (n1 / "records" / "a.pdf").write_text("%PDF-1.4")

        # ── an unknown name is not silently treated as a path ─────────────
        r = S.resolve("N7", S.load_config(cfgp))
        check("an unregistered shelf name is refused by name",
              (not r.ok) and r.kind == "unknown_shelf", str(r))

        # ── resolve_root: shelf name vs real path ─────────────────────────
        cfg = S.load_config(cfgp)
        p, vol = S.resolve_root("N1", cfg)
        check("resolve_root accepts a bare shelf name", p == n1 / "records", str(p))
        (n1 / "records" / "sub").mkdir()
        p, vol = S.resolve_root("N1/sub", cfg)
        check("resolve_root accepts shelf/subfolder", p == n1 / "records" / "sub", str(p))
        p, vol = S.resolve_root(str(tmp), cfg)
        check("resolve_root still accepts an ordinary path", p == tmp.resolve())
        check("a path outside any shelf reports no volume", vol is None)

        # ── require() exits rather than returning something falsy ─────────
        cfg = S.load_config(cfgp)
        stash = tmp / "unplugged3"
        n1.rename(stash)
        try:
            S.require("N1", cfg)
            check("require() refuses to return for an absent drive", False,
                  "it returned instead of exiting")
        except SystemExit as e:
            check("require() exits non-zero for an absent drive", e.code != 0,
                  f"exit code {e.code}")
        stash.rename(n1)

        # ── a corrupt marker is not a volume ──────────────────────────────
        bad = mounts / "BAD"; bad.mkdir()
        (bad / S.MARKER).write_text("{not json")
        check("a corrupt marker is ignored rather than crashing the scan",
              all(v.path != bad for v in S.scan_volumes()))
        (bad / S.MARKER).write_text(json.dumps({"label": "BAD"}))
        check("a marker with no id is not a volume",
              all(v.path != bad for v in S.scan_volumes()))
        _sh.rmtree(bad)

        # ── a corrupt config is reported, not silently emptied ────────────
        cfgp2 = tmp / "broken.json"
        cfgp2.write_text("{{{")
        try:
            S.load_config(cfgp2)
            check("an unreadable shelves.json raises rather than reading as empty",
                  False, "it returned a config")
        except S.ShelfError:
            check("an unreadable shelves.json raises rather than reading as empty", True)

        # ── the filesystem probe never reports a mount OPTION as a type ──
        # `mount` prints "(exfat, local, ...)" on macOS and "type ext4 (rw,...)"
        # on Linux. Reading the parenthesis on Linux yields "rw", which reads
        # as an answer and is not one.
        fs = S.filesystem_of(tmp)
        check("filesystem_of does not return a mount option as a filesystem",
              fs.lower() not in ("rw", "ro"), fs)
        check("filesystem_of returns a name or an honest 'unknown'",
              bool(fs), fs)

        # ── discovery does not descend into copies on the laptop ──────────
        nested = n1 / "records" / "backup_of_a_drive"
        nested.mkdir()
        S.init_volume(nested, "NESTED")
        check("scan_volumes stays one level deep, so a backup folder is not a drive",
              all(v.path != nested for v in S.scan_volumes()))

    print(f"\n  {'FAIL' if FAIL else 'PASS'} — {PASS}/{PASS + FAIL} checks\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
