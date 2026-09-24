#!/usr/bin/env python3
"""
bridge.py — the command center's read-only window into the Python side.

    python3 bridge.py cases          every case file, with its publish gate
    python3 bridge.py case CASE-ID   one case, in full
    python3 bridge.py claims         the claim layer's counts, read-only

WHY THIS EXISTS INSTEAD OF A SECOND IMPLEMENTATION
    The publish gate lives in modules/research-desk/case.py, in compute().
    The dashboard imports it rather than restating it, and so does this.
    "Two copies of a rule that decides whether something can be published is
    one copy too many" — that line is in dashboard.py and it applies here.

    The claim layer is opened read-only (sqlite `mode=ro`). Nothing this
    script does can change a case, a claim, or a citation.

Output is JSON on stdout. Errors are JSON on stdout too, with "error", and a
non-zero exit — the gateway shows the message instead of a blank panel.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "modules" / "research-desk"))

import case as C  # noqa: E402  — the one copy of the gate


def _jsonable(x):
    if isinstance(x, tuple):
        return list(x)
    raise TypeError(f"not JSON serialisable: {type(x).__name__}")


def summarize(d: dict) -> dict:
    g = C.compute(d)
    return {
        "id": d.get("case_id"),
        "subject": d.get("subject"),
        "created": d.get("created_at"),
        # The last thing logged is when the case last changed.
        "updated": ((d.get("log") or [{}])[-1] or {}).get("at") or d.get("created_at"),
        "publishable": g["publishable"],
        "pct_read": g["pct"],
        "pages_read": g["read"],
        "pages_total": g["total"] if g["n_ex"] else 0,
        "exhibits": g["n_ex"],
        "open_questions": len(g["open_q"]),
        "open_contradictions": len(g["open_x"]),
        "broken": len(g["broken"]),
        "blockers": [list(b) for b in g["blockers"]],
    }


def cmd_cases() -> dict:
    cases = C.load_all()
    rows = [summarize(d) for d in cases]
    # Blocked first, and the most-blocked first among those: the order is
    # what needs you, not what is alphabetical.
    rows.sort(key=lambda r: (r["publishable"], -len(r["blockers"]), r["id"] or ""))
    return {"dir": str(C.cases_dir()), "total": len(rows),
            "publishable": sum(1 for r in rows if r["publishable"]), "cases": rows}


def cmd_case(cid: str) -> dict:
    d = C.load(cid)
    out = summarize(d)
    out["file"] = d  # the whole case, exhibits, questions, contradictions, log
    return out


def cmd_claims() -> dict:
    root = Path(os.environ.get("SENTINEL_ROOT", Path.home() / "SentinelDesk"))
    db = root / "sentinel.db"
    if not db.is_file():
        return {"exists": False, "path": str(db),
                "note": "The claim layer has never been stood up. "
                        "Nothing can be cleared for publication until it exists.",
                "command": "bin/sentinel sdesk doctor"}
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}

        def n(sql):
            try:
                return con.execute(sql).fetchone()[0]
            except sqlite3.Error:
                return None
        out = {"exists": True, "path": str(db), "tables": sorted(tables)}
        if "claims" in tables:
            out["claims"] = n("select count(*) from claims")
            if "citations" in tables:
                out["citations"] = n("select count(*) from citations")
                out["uncited"] = n("select count(*) from claims c where not exists "
                                   "(select 1 from citations x where x.claim_id = c.id)")
        if "cases" in tables:
            out["cases"] = n("select count(*) from cases")
            out["open_cases"] = n("select count(*) from cases where status='OPEN'")
        if "documents" in tables:
            out["documents"] = n("select count(*) from documents")
        return out
    finally:
        con.close()


def main(argv: list[str]) -> int:
    try:
        if not argv:
            raise ValueError("usage: bridge.py cases | case ID | claims")
        if argv[0] == "cases":
            res = cmd_cases()
        elif argv[0] == "case" and len(argv) == 2:
            res = cmd_case(argv[1])
        elif argv[0] == "claims":
            res = cmd_claims()
        else:
            raise ValueError(f"unknown: {' '.join(argv)}")
    except SystemExit as e:           # case.py exits on a missing/corrupt case
        print(json.dumps({"error": str(e) or "case not found"}))
        return 2
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 2
    print(json.dumps(res, default=_jsonable))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
