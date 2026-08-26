#!/usr/bin/env python3
"""
shelf.py — point the desk at external drives without lying about what it read.
================================================================================

WHY THIS EXISTS
    A corpus that does not fit on the laptop has to live on removable media.
    The moment it does, a new failure appears that has no equivalent for local
    files:

        AN UNPLUGGED DRIVE IS INDISTINGUISHABLE FROM AN EMPTY CORPUS.

    A scan of a folder that is not there returns zero files. Zero files is a
    perfectly ordinary-looking result. It prints calmly, exits clean, and reads
    as "there are no records matching that" — when the fact is "nobody looked."
    This is the same silent-green failure this desk is built around, except the
    trigger is a USB connector rather than a bug.

    So nothing here ever returns an empty result for an absent volume. It
    refuses, by name, with the reason.

THE FOUR WAYS /Volumes/N1 LIES TO YOU  (all of these are real macOS behaviour)

  1. STALE MOUNT POINT. Eject a drive uncleanly, or let anything create a
     folder in /Volumes while the drive is out, and /Volumes/N1 exists as an
     empty directory. Every path under it resolves. Every scan finds nothing.

  2. NAME COLLISION. If something already occupies /Volumes/N1, macOS mounts
     the real drive at "/Volumes/N1 1". Your path still points at the stub.

  3. LABEL SWAP. Two flash drives, and the labels get reused or the drives get
     swapped in the ports. /Volumes/N1 is now N2's contents. Nothing errors.
     Every identifier recorded in that run is attributed to the wrong physical
     object, and there is no way to notice afterwards.

  4. A CLONE. Copy a drive to a spare and both are mounted. Which one did the
     inventory read? The path cannot tell you.

    All four are defeated the same way: A SHELF IS NOT A PATH. It is a volume
    identity, written once onto the drive itself, and resolved by searching
    what is actually mounted. The path is an output of resolution, never an
    input to it.

WHAT GOES WHERE
    On the drives:  documents, page images, OCR output. Bulk, re-derivable.
    On the laptop:  the provenance ledger, inventories, case files, captures.

    That split is not about size. The ledger is an append-only hash chain and
    flash drives get yanked mid-write; a truncated final line breaks the chain
    for everything that came before it. Small and irreplaceable stays on the
    machine that is not designed to be unplugged.
================================================================================
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

MARKER = ".sentinel-volume.json"
MARKER_VERSION = 1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- discovery --
def mount_roots() -> list[Path]:
    """Where removable media appears.

    Overridable by env so this is testable without a USB port, and so an
    operator with an unusual setup is not stuck.
    """
    env = os.environ.get("SENTINEL_MOUNT_ROOTS")
    if env:
        return [Path(p).expanduser() for p in env.split(os.pathsep) if p.strip()]
    if platform.system() == "Darwin":
        return [Path("/Volumes")]
    return [Path("/media"), Path("/mnt"), Path("/run/media")]


@dataclass
class Volume:
    id: str
    label: str
    path: Path
    initialized: str = ""
    note: str = ""

    def marker_path(self) -> Path:
        return self.path / MARKER


def _read_marker(d: Path) -> Volume | None:
    m = d / MARKER
    try:
        if not m.is_file():
            return None
        data = json.loads(m.read_text())
    except Exception:
        return None
    if not isinstance(data, dict) or not data.get("id"):
        return None
    return Volume(
        id=str(data["id"]),
        label=str(data.get("label") or d.name),
        path=d,
        initialized=str(data.get("initialized") or ""),
        note=str(data.get("note") or ""),
    )


def scan_volumes() -> list[Volume]:
    """Every mounted volume carrying a Sentinel marker.

    Depth is deliberately one level under each mount root. Walking deeper would
    find markers inside backup copies of a drive and present a folder on the
    laptop as though it were the drive itself.
    """
    found: list[Volume] = []
    for root in mount_roots():
        try:
            entries = sorted(root.iterdir())
        except OSError:
            continue
        for d in entries:
            try:
                if not d.is_dir():
                    continue
            except OSError:
                continue
            v = _read_marker(d)
            if v:
                found.append(v)
    return found


def init_volume(path: Path, label: str, note: str = "", force: bool = False) -> Volume:
    """Give a drive a permanent identity.

    Written once. Re-initialising mints a NEW id, which orphans every shelf
    already bound to the old one and silently detaches the inventory rows that
    recorded it -- so it takes --force and says so.
    """
    path = Path(path).expanduser().resolve()
    if not path.is_dir():
        raise ShelfError(f"not a folder: {path}")
    existing = _read_marker(path)
    if existing and not force:
        return existing
    v = Volume(id=str(uuid.uuid4()), label=label, path=path,
               initialized=_now(), note=note)
    payload = {
        "sentinel_volume": MARKER_VERSION,
        "id": v.id,
        "label": v.label,
        "initialized": v.initialized,
        "note": note,
        "_comment": "Identifies this physical volume to the Sentinel desk. "
                    "Do not copy this file to another drive: two volumes "
                    "sharing an id make every shelf pointing at it ambiguous.",
    }
    tmp = path / (MARKER + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(tmp, path / MARKER)
    return v


# ------------------------------------------------------------------- config --
class ShelfError(Exception):
    pass


@dataclass
class Config:
    path: Path
    shelves: dict = field(default_factory=dict)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"shelves": self.shelves}, indent=2) + "\n")
        os.replace(tmp, self.path)


def default_config_path() -> Path:
    env = os.environ.get("SENTINEL_SHELVES")
    if env:
        return Path(env).expanduser()
    ev = os.environ.get("SENTINEL_EVIDENCE_DIR")
    base = Path(ev).expanduser() if ev else Path(__file__).resolve().parents[2] / "evidence"
    return base / "shelves.json"


def load_config(path: Path | None = None) -> Config:
    p = Path(path).expanduser() if path else default_config_path()
    if not p.is_file():
        return Config(path=p, shelves={})
    try:
        data = json.loads(p.read_text())
    except Exception as e:
        raise ShelfError(f"shelves.json is unreadable ({e}). Fix or delete: {p}")
    sh = data.get("shelves") if isinstance(data, dict) else None
    return Config(path=p, shelves=sh if isinstance(sh, dict) else {})


def bind(cfg: Config, name: str, volume: Volume, subpath: str = "") -> None:
    cfg.shelves[name] = {
        "volume_id": volume.id,
        "label": volume.label,
        "subpath": subpath.strip("/"),
        "bound": _now(),
        "last_seen_path": str(volume.path),
    }
    cfg.save()


# ---------------------------------------------------------------- resolution --
@dataclass
class Resolution:
    ok: bool
    kind: str            # ok | unknown_shelf | not_mounted | ambiguous |
                         # label_conflict | subpath_missing
    path: Path | None = None
    volume: Volume | None = None
    message: str = ""
    detail: list[str] = field(default_factory=list)


def resolve(name: str, cfg: Config | None = None,
            volumes: list[Volume] | None = None) -> Resolution:
    cfg = cfg or load_config()
    vols = scan_volumes() if volumes is None else volumes

    ent = cfg.shelves.get(name)
    if not ent:
        known = ", ".join(sorted(cfg.shelves)) or "none registered"
        return Resolution(False, "unknown_shelf",
                          message=f'no shelf named "{name}"',
                          detail=[f"registered shelves: {known}",
                                  "register one with:  bin/sentinel shelf add "
                                  f"{name} /Volumes/{name}"])

    want = ent.get("volume_id")
    matches = [v for v in vols if v.id == want]

    if len(matches) > 1:
        # Two mounted volumes claim the same identity. Almost always a clone.
        # Picking either one would attribute this run's findings to a physical
        # object we cannot name, so there is nothing to do but stop.
        return Resolution(False, "ambiguous",
                          message=f'"{name}" matches {len(matches)} mounted volumes',
                          detail=[f"  {v.path}" for v in matches] + [
                              "Two drives carry the same volume id -- one is a copy.",
                              "Unmount one, or re-initialise it:",
                              f"  bin/sentinel shelf init <path> <label> --force"])

    if not matches:
        detail: list[str] = []
        # THE DANGEROUS CASE. Something with the right name is mounted, but it
        # is not the drive this shelf was bound to. Reported as a conflict, not
        # as "missing", because "missing" invites you to just point at it.
        label = ent.get("label") or name
        impostors = [v for v in vols if v.label == label]
        if impostors:
            return Resolution(
                False, "label_conflict",
                message=f'a volume labelled "{label}" is mounted, but it is NOT '
                        f'the drive shelf "{name}" was bound to',
                detail=[f"  mounted: {v.path}  (id {v.id[:8]})" for v in impostors]
                       + [f"  expected id {str(want)[:8]}",
                          "This is a different physical drive. Reading it as "
                          f'"{name}" would file its contents under the wrong volume.',
                          f"If the swap is intended:  bin/sentinel shelf add {name} "
                          f"<path> --rebind"])

        last = ent.get("last_seen_path")
        if last:
            detail.append(f"last seen at {last}")

        # A stale mount point resolves and scans to nothing. Say so, or the
        # next thing tried is the exact path that will silently succeed.
        #
        # Deliberately NOT limited to last_seen_path. macOS parks the stub at
        # /Volumes/<label>, which is often not where the drive was last seen --
        # the previous run may have been the one that got bumped to "N1 1".
        # Checking only the breadcrumb misses the stub in exactly the case that
        # produced it.
        candidates: list[Path] = []
        if last:
            candidates.append(Path(last))
        for root in mount_roots():
            for n in {label, name}:
                candidates.append(root / n)
        seen: set[str] = set()
        for c in candidates:
            key = str(c)
            if key in seen:
                continue
            seen.add(key)
            try:
                if c.is_dir() and not (c / MARKER).is_file():
                    detail.append(f"NOTE: {c} exists but carries no volume marker.")
                    detail.append("      That is an empty stale mount point, not the drive.")
                    detail.append("      Scanning it would report zero files as a finding.")
            except OSError:
                continue
        if vols:
            detail.append("mounted Sentinel volumes right now:")
            detail += [f"  {v.label}  {v.path}" for v in vols]
        else:
            detail.append("no Sentinel volumes are mounted at all.")
        return Resolution(False, "not_mounted",
                          message=f'shelf "{name}" is not mounted', detail=detail)

    v = matches[0]
    target = v.path / ent["subpath"] if ent.get("subpath") else v.path
    if not target.is_dir():
        return Resolution(False, "subpath_missing", volume=v,
                          message=f'"{name}" is mounted, but {target} is not there',
                          detail=[f"volume root: {v.path}",
                                  "The drive is correct; the folder inside it is not."])

    # Keep the breadcrumb fresh so a later failure can say where it used to be.
    if str(v.path) != ent.get("last_seen_path"):
        ent["last_seen_path"] = str(v.path)
        try:
            cfg.save()
        except OSError:
            pass
    return Resolution(True, "ok", path=target, volume=v)


def require(name: str, cfg: Config | None = None) -> tuple[Path, Volume]:
    """Resolve or exit. The guard every command that touches a shelf calls."""
    r = resolve(name, cfg)
    if not r.ok:
        print(f"\n  SHELF UNAVAILABLE — {r.message}\n", file=sys.stderr)
        for line in r.detail:
            print(f"  {line}", file=sys.stderr)
        print("\n  Nothing was read. This is NOT a result about the records.\n",
              file=sys.stderr)
        raise SystemExit(3)
    return r.path, r.volume


def resolve_root(spec: str, cfg: Config | None = None) -> tuple[Path, Volume | None]:
    """Accept either a shelf name ("N1", "N1/records") or a plain path.

    A bare name that is not a registered shelf and not an existing path is an
    error rather than a relative-path guess, because a relative guess is how
    you end up scanning the current directory and reporting it as the corpus.
    """
    cfg = cfg or load_config()
    if spec.startswith(("/", ".", "~")) or os.sep in spec and Path(spec).exists():
        return Path(spec).expanduser().resolve(), None
    head, _, tail = spec.partition("/")
    if head in cfg.shelves:
        base, vol = require(head, cfg)
        target = base / tail if tail else base
        if not target.is_dir():
            print(f"\n  {target} is not a folder on shelf {head}.\n", file=sys.stderr)
            raise SystemExit(3)
        return target, vol
    p = Path(spec).expanduser()
    if p.is_dir():
        return p.resolve(), None
    print(f'\n  "{spec}" is neither a registered shelf nor an existing folder.\n',
          file=sys.stderr)
    known = ", ".join(sorted(cfg.shelves)) or "none"
    print(f"  registered shelves: {known}\n", file=sys.stderr)
    raise SystemExit(3)


# ------------------------------------------------------------- drive health --
def free_bytes(p: Path) -> int | None:
    try:
        return shutil.disk_usage(p).free
    except OSError:
        return None


def human(n: float | None) -> str:
    if n is None:
        return "unknown"
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return f"{n:.0f}{u}" if u == "B" or n >= 10 else f"{n:.1f}{u}"
        n /= 1024
    return f"{n:.1f}TB"


# Filesystems that cannot tell Exhibit_A.pdf from exhibit_a.pdf. Flash drives
# ship formatted this way, and a case-collision on copy loses a document with
# no error from anything.
CASE_BLIND_FS = ("exfat", "msdos", "fat", "vfat", "ntfs", "smbfs", "hfs")


def filesystem_of(p: Path) -> str:
    """Best-effort filesystem name for a mount point. Never raises.

    `mount` prints two different shapes and they must not be conflated:

        macOS:  /dev/disk4s1 on /Volumes/N1 (exfat, local, nodev, nosuid)
        Linux:  /dev/sda1 on /mnt type ext4 (rw,relatime)

    Reading the parenthesis on Linux yields "rw" -- a mount OPTION presented as
    a filesystem name. It looks like an answer, which is worse than "unknown".
    """
    try:
        out = subprocess.run(["df", "-P", str(p)], capture_output=True,
                             text=True, timeout=10).stdout.splitlines()
        dev = out[1].split()[0] if len(out) > 1 else ""
    except Exception:
        return "unknown"
    if not dev:
        return "unknown"
    try:
        lines = subprocess.run(["mount"], capture_output=True, text=True,
                               timeout=10).stdout.splitlines()
    except Exception:
        return "unknown"
    for line in lines:
        if not line.startswith(dev + " "):
            continue
        parts = line.split()
        if "type" in parts:                       # Linux
            i = parts.index("type")
            if i + 1 < len(parts):
                return parts[i + 1]
        if "(" in line:                           # macOS
            token = line.rsplit("(", 1)[1].split(",")[0].rstrip(")").strip()
            # Guard against picking up an option list that happens to be first.
            if token and token.lower() not in ("rw", "ro"):
                return token
    return "unknown"


def case_sensitive(p: Path) -> bool | None:
    """Does this filesystem tell A.pdf from a.pdf?

    Flash drives ship exFAT, which does not. Two records whose names differ
    only in case become one file on copy, and the second silently overwrites
    the first -- a document disappears from the corpus with no error anywhere.
    Worth knowing before 37GB moves onto it.
    """
    probe = p / "._sentinel_case_probe"
    upper = p / "._SENTINEL_CASE_PROBE"
    try:
        probe.write_text("x")
        try:
            return not upper.exists()
        finally:
            probe.unlink(missing_ok=True)
    except OSError:
        return None
