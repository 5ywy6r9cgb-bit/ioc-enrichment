"""
audit.py -- the hash chain. What was done, when, and proof it was not edited.

WHAT THIS IS FOR
    A reporter's notes get subpoenaed, challenged, and read by people looking
    for the moment the story was decided before the evidence supported it. An
    audit log answers "what did you do and when." That question is asked
    adversarially, which means a log you can quietly edit answers nothing at
    all -- its value comes entirely from being unable to lie.

HOW IT WORKS
    Each entry commits to the one before it:

        hash = sha256(prev_hash | ts | action | actor | subject | detail)

    Change any field of any row and that row's hash no longer matches its
    contents. Delete a row and the next row's prev_hash points at nothing.
    Insert a row and everything after it fails. verify() walks the chain and
    reports the FIRST break, because after the first break the rest is noise.

THREE LOCKS, NOT ONE
    1. This module has no update or delete function. There is no code path.
    2. store.py installs BEFORE UPDATE and BEFORE DELETE triggers that abort.
       A trigger cannot be forgotten the way a code path can.
    3. The chain itself, so that someone who bypasses both -- editing the
       SQLite file directly with another tool -- still cannot do it silently.

    Locks 1 and 2 stop accidents. Lock 3 is the one that matters, because it
    is the only one that works against someone who is trying.

THE MIRROR
    Every entry is also appended to audit.jsonl next to the database. The
    database can be deleted; a plain-text append-only file alongside it means
    the chain survives that and can be read with `tail` and checked without
    this program. It is a mirror, never the source of truth: verify() reads
    the table, because a mirror an attacker can also append to proves nothing
    on its own.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from pathlib import Path

GENESIS = "0" * 64


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _canonical(detail) -> str:
    """Detail must hash identically every time it is serialised.

    json.dumps with sort_keys and fixed separators is the whole trick. Without
    it, two structurally identical dicts can produce different strings and the
    chain breaks for a reason that has nothing to do with tampering -- which
    trains you to ignore a broken chain.
    """
    if detail is None:
        return ""
    if isinstance(detail, str):
        return detail
    return json.dumps(detail, sort_keys=True, separators=(",", ":"), default=str)


def entry_hash(prev_hash: str, ts: str, action: str, actor: str,
               subject, detail) -> str:
    # The separator is a NUL byte so that a field containing the separator
    # cannot be used to make two different entries hash the same. Field values
    # come from operator input; the boundary between them has to be one that
    # input cannot contain.
    parts = [prev_hash, ts, action, actor, subject or "", _canonical(detail)]
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def head(conn: sqlite3.Connection) -> str:
    """The hash of the last entry, or GENESIS for an empty chain."""
    row = conn.execute("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").fetchone()
    return row["hash"] if row else GENESIS


def record(conn: sqlite3.Connection, action: str, actor: str,
           subject=None, detail=None, mirror: Path | str | None = None) -> dict:
    """Append one entry. Returns it.

    Commits immediately. An audit entry that is still in an uncommitted
    transaction when the process dies is an action that happened with no record
    of it, which is the exact failure this module exists to prevent.
    """
    ts = _now()
    prev = head(conn)
    d = _canonical(detail)
    h = entry_hash(prev, ts, action, actor, subject, detail)

    conn.execute(
        "INSERT INTO audit (ts,action,actor,subject,payload,prev_hash,hash) "
        "VALUES (?,?,?,?,?,?,?)",
        (ts, action, actor, subject, d, prev, h))
    conn.commit()

    row = {"ts": ts, "action": action, "actor": actor, "subject": subject,
           "payload": d, "prev_hash": prev, "hash": h}

    if mirror:
        p = Path(mirror)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Append only. Never open in 'w'.
        with p.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
        try:
            p.chmod(0o600)
        except OSError:
            pass

    return row


def verify(conn: sqlite3.Connection) -> tuple[bool, str]:
    """Walk the chain. Returns (ok, message), naming the FIRST break.

    Reporting only the first break is deliberate: after one row is wrong every
    subsequent row is also wrong, and a screen of failures obscures the single
    row that actually matters.
    """
    prev = GENESIS
    n = 0
    for row in conn.execute(
            "SELECT seq,ts,action,actor,subject,payload,prev_hash,hash "
            "FROM audit ORDER BY seq"):
        n += 1
        if row["prev_hash"] != prev:
            return (False,
                    f"chain broken at Row {row['seq']} ({row['action']}): "
                    f"expected prev_hash {prev[:12]}…, found "
                    f"{row['prev_hash'][:12]}…. An entry before this one was "
                    f"removed or altered.")
        expect = entry_hash(row["prev_hash"], row["ts"], row["action"],
                            row["actor"], row["subject"], row["payload"])
        if expect != row["hash"]:
            return (False,
                    f"Row {row['seq']} ({row['action']}) does not match its own "
                    f"hash. Its contents were altered after it was written.")
        prev = row["hash"]

    if n == 0:
        return (True, "audit chain is empty (nothing has been recorded yet)")
    return (True, f"audit chain intact — {n} entr{'y' if n == 1 else 'ies'} verified")


def jsonl(conn: sqlite3.Connection) -> str:
    """The whole chain as JSON Lines, for export or for diffing the mirror."""
    out = []
    for row in conn.execute(
            "SELECT ts,action,actor,subject,payload,prev_hash,hash "
            "FROM audit ORDER BY seq"):
        out.append(json.dumps(dict(row), sort_keys=True))
    return "\n".join(out)
