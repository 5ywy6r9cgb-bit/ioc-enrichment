#!/usr/bin/env python3
"""
shelf_cli.py — `sentinel shelf ...`

Registers external drives, and tells you the truth about whether the desk can
see them right now. Every command here is read-only against the records
themselves; the only thing ever written to a drive is its identity marker.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shelf as S  # noqa: E402

B = "\033[1m"; D = "\033[2m"; G = "\033[32m"; Y = "\033[33m"; R = "\033[31m"; X = "\033[0m"


def cmd_list(args) -> int:
    cfg = S.load_config(args.config)
    vols = S.scan_volumes()

    print(f"\n{B}Mounted Sentinel volumes{X}")
    if not vols:
        roots = ", ".join(str(r) for r in S.mount_roots())
        print(f"  {D}none found under {roots}{X}")
        print(f"  {D}Plug a drive in, then:  bin/sentinel shelf add N1 /Volumes/N1{X}")
    for v in vols:
        free = S.free_bytes(v.path)
        print(f"  {G}{v.label:<10}{X} {v.path}")
        print(f"  {D}           id {v.id[:8]}  ·  {S.human(free)} free{X}")

    print(f"\n{B}Registered shelves{X}")
    if not cfg.shelves:
        print(f"  {D}none — nothing is wired up yet{X}")
    for name in sorted(cfg.shelves):
        r = S.resolve(name, cfg, vols)
        ent = cfg.shelves[name]
        sub = ent.get("subpath") or ""
        if r.ok:
            print(f"  {G}●{X} {name:<10} {r.path}")
        else:
            tag = {"not_mounted": "not mounted",
                   "label_conflict": "WRONG DRIVE",
                   "ambiguous": "AMBIGUOUS",
                   "subpath_missing": "folder missing"}.get(r.kind, r.kind)
            colour = Y if r.kind == "not_mounted" else R
            print(f"  {colour}○{X} {name:<10} {colour}{tag}{X}"
                  + (f"  {D}(id {str(ent.get('volume_id'))[:8]}"
                     + (f", subpath {sub}" if sub else "") + f"){X}"))
    print()
    return 0


def cmd_init(args) -> int:
    p = Path(args.path).expanduser()
    if not p.is_dir():
        print(f"\n  Not a folder: {p}", file=sys.stderr)
        if str(p).startswith("/Volumes/"):
            print("  The drive is probably not mounted. Plug it in and retry.\n",
                  file=sys.stderr)
        return 2
    existing = S._read_marker(p)
    if existing and not args.force:
        print(f"\n  Already initialised as {B}{existing.label}{X} "
              f"(id {existing.id[:8]}, {existing.initialized})")
        print(f"  {D}Re-initialising mints a NEW id and orphans every shelf bound{X}")
        print(f"  {D}to the old one. Pass --force only if you mean that.{X}\n")
        return 0
    v = S.init_volume(p, args.label, note=args.note or "", force=args.force)
    print(f"\n  {G}initialised{X}  {v.path}")
    print(f"  {D}label {v.label}  ·  id {v.id}{X}")
    print(f"  {D}marker written to {v.marker_path()}{X}\n")
    return 0


def cmd_add(args) -> int:
    """Initialise if needed, then bind a name to it. The one command you need."""
    cfg = S.load_config(args.config)
    p = Path(args.path).expanduser()
    if not p.is_dir():
        print(f"\n  Not a folder: {p}\n", file=sys.stderr)
        return 2

    v = S._read_marker(p)
    if not v:
        v = S.init_volume(p, args.name)
        print(f"\n  {G}initialised{X} {p} as volume {v.id[:8]}")
    else:
        print(f"\n  {D}volume {v.label} (id {v.id[:8]}) already initialised{X}")

    prev = cfg.shelves.get(args.name)
    if prev and prev.get("volume_id") != v.id and not args.rebind:
        print(f"\n  {R}REFUSING TO REBIND.{X}")
        print(f"  Shelf \"{args.name}\" already points at volume "
              f"{str(prev.get('volume_id'))[:8]}; this drive is {v.id[:8]}.")
        print("  Rebinding means every inventory row recorded under this name")
        print("  came from a different physical drive than the next one will.")
        print(f"  If that is what you want:  --rebind\n")
        return 4

    S.bind(cfg, args.name, v, subpath=args.subpath or "")
    target = v.path / args.subpath if args.subpath else v.path
    print(f"  {G}shelf {args.name}{X} → {target}")
    print(f"  {D}recorded in {cfg.path}{X}\n")
    return 0


def cmd_where(args) -> int:
    """Print the resolved path and nothing else, for use in a shell."""
    path, _ = S.require(args.name, S.load_config(args.config))
    print(path)
    return 0


def cmd_check(args) -> int:
    cfg = S.load_config(args.config)
    names = [args.name] if args.name else sorted(cfg.shelves)
    if not names:
        print("\n  No shelves registered. Start with:")
        print("    bin/sentinel shelf add N1 /Volumes/N1\n")
        return 1

    bad = 0
    for name in names:
        r = S.resolve(name, cfg)
        print(f"\n{B}{name}{X}")
        if not r.ok:
            bad += 1
            print(f"  {R}{r.message}{X}")
            for line in r.detail:
                print(f"  {D}{line}{X}")
            continue

        p, v = r.path, r.volume
        print(f"  {G}mounted{X}    {p}")
        print(f"  {D}volume{X}     {v.label}  id {v.id[:8]}")

        free = S.free_bytes(p)
        print(f"  {D}free{X}       {S.human(free)}")

        fs = S.filesystem_of(v.path)
        print(f"  {D}filesystem{X} {fs}")
        if any(k in fs.lower() for k in S.CASE_BLIND_FS):
            print(f"  {Y}           {fs} does not distinguish upper from lower case.{X}")
            print(f"  {D}           Two records whose names differ only in case become{X}")
            print(f"  {D}           ONE file when copied here. The second overwrites the{X}")
            print(f"  {D}           first and nothing reports it.{X}")

        cs = S.case_sensitive(v.path) if args.probe else None
        if cs is False:
            print(f"  {Y}case-insensitive{X} — 'Exhibit A.pdf' and 'exhibit a.pdf'")
            print(f"  {D}           are ONE file here. A copy silently drops the second.{X}")
        elif cs is True:
            print(f"  {D}case{X}       sensitive")

        try:
            n = sum(1 for _ in p.rglob("*"))
            print(f"  {D}entries{X}    {n:,}")
            if n == 0:
                bad += 1
                print(f"  {R}The volume is mounted but EMPTY.{X}")
                print(f"  {D}           A scan here reports zero files, which reads as{X}")
                print(f"  {D}           'no records match'. It is not that.{X}")
        except OSError as e:
            print(f"  {Y}unreadable{X} {e}")
            bad += 1

    # The ledger must not live on something designed to be unplugged.
    ev = os.environ.get("SENTINEL_EVIDENCE_DIR")
    if ev:
        evp = Path(ev).expanduser().resolve()
        for root in S.mount_roots():
            try:
                evp.relative_to(root.resolve())
            except (ValueError, OSError):
                continue
            print(f"\n  {R}THE EVIDENCE STORE IS ON REMOVABLE MEDIA.{X}")
            print(f"  {D}SENTINEL_EVIDENCE_DIR={evp}{X}")
            print(f"  {D}The provenance ledger is an append-only hash chain. A drive{X}")
            print(f"  {D}pulled mid-write truncates the last line and breaks the chain{X}")
            print(f"  {D}for every record before it. Keep the ledger on the laptop and{X}")
            print(f"  {D}put only bulk documents on the drives.{X}")
            bad += 1
            break

    print()
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="sentinel shelf")
    ap.add_argument("--config", help="path to shelves.json")
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("list", help="mounted volumes and registered shelves")

    a = sub.add_parser("add", help="register a drive under a name")
    a.add_argument("name"); a.add_argument("path")
    a.add_argument("--subpath", help="folder inside the volume to use as the root")
    a.add_argument("--rebind", action="store_true",
                   help="allow pointing an existing name at a different drive")

    i = sub.add_parser("init", help="write a volume identity marker")
    i.add_argument("path"); i.add_argument("label")
    i.add_argument("--note"); i.add_argument("--force", action="store_true")

    c = sub.add_parser("check", help="is it actually there, and is it usable")
    c.add_argument("name", nargs="?")
    c.add_argument("--probe", action="store_true",
                   help="write one temp file to test case-sensitivity")

    w = sub.add_parser("where", help="print the resolved path")
    w.add_argument("name")

    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return 2
    return {"list": cmd_list, "add": cmd_add, "init": cmd_init,
            "check": cmd_check, "where": cmd_where}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
