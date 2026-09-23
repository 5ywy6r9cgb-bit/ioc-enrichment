#!/usr/bin/env python3
"""
caseindex.py — one worklist across both case stores. Read-only, always.

WHY TWO STORES IS NOT A BUG
  sentinel case   flat JSON, one file per case:
                  case_id, subject, exhibits, questions_open,
                  questions_answered, contradictions, log
                  -> the working notebook. What you are reading and asking.

  sentinel sdesk  SQLite + audit.jsonl + vault/:
                  claims, gates, dossiers
                  -> the claims layer. What can be published, and on whose word.

  Those are different jobs and they want different storage. Merging them would
  put a mutable research notebook inside a store whose value is an append-only
  audit trail. The real gap is that nothing reads BOTH, so a case with an
  unresolved contradiction in one store is invisible from the other.

WHAT THIS DOES NOT DO
  Never writes to either store. Opens the SQLite database with mode=ro so it
  cannot, even by accident, and never touches the JSON files at all. There are
  24 case files and an append-only ledger here; a tool that indexes them has
  no business being able to damage them.

USAGE
  python3 caseindex.py                       # the worklist
  python3 caseindex.py --json                # machine-readable, for `sentinel today`
  python3 caseindex.py --schema              # what it found in the SQLite store
  --cases  evidence/sentinel_cases
  --desk   ~/SentinelDesk

EXIT  0 nothing blocking · 3 an unresolved contradiction exists
      4 a store could not be read (never a silent empty worklist)
"""
import argparse, json, os, re, sqlite3, sys
from pathlib import Path

OK, BLOCKING, CANNOT = 0, 3, 4


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def n(v):
    """Length of a list-ish field, 0 for anything else. These files are hand
    edited; a field that should be a list is sometimes a string or null."""
    if isinstance(v, (list, tuple, set, dict)):
        return len(v)
    return 1 if v else 0


# ── store A: flat JSON case files ─────────────────────────────────────────
def read_cases(root: Path):
    if not root.is_dir():
        return None, f"{root} is not a directory"
    out, bad = {}, []
    for p in sorted(root.glob("*.json")):
        try:
            d = json.loads(p.read_text())
        except Exception as e:
            bad.append(f"{p.name}: {type(e).__name__}")
            continue
        cid = d.get("case_id") or p.stem
        out[slug(cid)] = {
            "case_id": cid,
            "subject": d.get("subject") or "",
            "created": d.get("created_at") or "",
            "exhibits": n(d.get("exhibits")),
            "open": n(d.get("questions_open")),
            "answered": n(d.get("questions_answered")),
            "contradictions": n(d.get("contradictions")),
            "log": n(d.get("log")),
            "file": p.name,
        }
    return (out, bad), None


# ── store B: the SQLite desk. Schema is discovered, never assumed. ────────
def read_desk(root: Path):
    db = root / "sentinel.db"
    if not db.is_file():
        return None, f"{db} not found"
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)   # cannot write
        con.row_factory = sqlite3.Row
    except sqlite3.Error as e:
        return None, f"cannot open {db} read-only: {e}"

    tables = {}
    try:
        for (t,) in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%'"):
            cols = [r[1] for r in con.execute(f"PRAGMA table_info('{t}')")]
            cnt = con.execute(f"SELECT COUNT(*) FROM '{t}'").fetchone()[0]
            tables[t] = {"columns": cols, "rows": cnt}
    except sqlite3.Error as e:
        con.close()
        return None, f"reading schema: {e}"

    def pick(*words):
        for t in tables:
            if any(w in t.lower() for w in words):
                return t
        return None

    t_case, t_claim = pick("case"), pick("claim")
    cases, claims = {}, {}

    if t_case:
        idc = next((c for c in tables[t_case]["columns"]
                    if c.lower() in ("case_id","slug","id","name")), None)
        if idc:
            for r in con.execute(f"SELECT * FROM '{t_case}'"):
                d = dict(r)
                cases[slug(d[idc])] = d

    if t_claim:
        cols = tables[t_claim]["columns"]
        link = next((c for c in cols if "case" in c.lower()), None)
        stat = next((c for c in cols if c.lower() in
                     ("status","state","tier","grade")), None)
        for r in con.execute(f"SELECT * FROM '{t_claim}'"):
            d = dict(r)
            k = slug(d.get(link)) if link else "(unlinked)"
            b = claims.setdefault(k, {"n": 0, "by_status": {}})
            b["n"] += 1
            if stat:
                s = str(d.get(stat) or "unknown")
                b["by_status"][s] = b["by_status"].get(s, 0) + 1
    con.close()
    return (tables, cases, claims, t_case, t_claim), None


def main():
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cases", default="evidence/sentinel_cases")
    p.add_argument("--desk", default=str(Path.home() / "SentinelDesk"))
    p.add_argument("--json", action="store_true")
    p.add_argument("--schema", action="store_true")
    a = p.parse_args()

    A, e1 = read_cases(Path(a.cases))
    B, e2 = read_desk(Path(os.path.expanduser(a.desk)))

    if a.schema:
        if e2:
            print(f"  CANNOT VERIFY — {e2}"); return CANNOT
        tables, cases, claims, t_case, t_claim = B
        print(f"  {a.desk}/sentinel.db — {len(tables)} table(s)\n")
        for t, meta in sorted(tables.items()):
            mark = "  <- cases" if t == t_case else ("  <- claims" if t == t_claim else "")
            print(f"    {t:<28} {meta['rows']:>6} row(s){mark}")
            print(f"      {', '.join(meta['columns'])}")
        return OK

    if e1 and e2:
        print(f"  CANNOT VERIFY — {e1}\n  CANNOT VERIFY — {e2}")
        return CANNOT

    notebook, bad = (A if A else ({}, []))
    _, desk_cases, desk_claims, _, _ = (B if B else ({}, {}, {}, None, None))

    keys = sorted(set(notebook) | set(desk_cases) | set(desk_claims))
    rows = []
    for k in keys:
        nb = notebook.get(k)
        cl = desk_claims.get(k, {})
        rows.append({
            "slug": k,
            "subject": (nb or {}).get("subject") or (nb or {}).get("case_id") or k,
            "in_notebook": bool(nb),
            "in_desk": k in desk_cases or k in desk_claims,
            "exhibits": (nb or {}).get("exhibits", 0),
            "open_questions": (nb or {}).get("open", 0),
            "contradictions": (nb or {}).get("contradictions", 0),
            "claims": cl.get("n", 0),
            "claim_status": cl.get("by_status", {}),
        })

    if a.json:
        print(json.dumps({"cases": rows, "unreadable": bad}, indent=2))
        return BLOCKING if any(r["contradictions"] for r in rows) else OK

    def rank(r):
        return (-r["contradictions"], -r["open_questions"],
                r["in_notebook"] and r["in_desk"], r["slug"])

    print(f"  {len(rows)} case(s) — {len(notebook)} in the notebook, "
          f"{len(desk_cases) or len(desk_claims)} in the desk")
    if e1: print(f"  NOTE  notebook unreadable: {e1}")
    if e2: print(f"  NOTE  desk unreadable: {e2}")
    if bad: print(f"  NOTE  {len(bad)} unparseable case file(s): {', '.join(bad[:3])}")

    contra = [r for r in rows if r["contradictions"]]
    if contra:
        print(f"\n  ══ UNRESOLVED CONTRADICTION — {len(contra)} ══")
        print("  A recorded contradiction is the thing that ends a story after")
        print("  publication. These come before new work.")
        for r in sorted(contra, key=rank):
            print(f"    {r['slug']:<30} {r['contradictions']} contradiction(s) · "
                  f"{r['open_questions']} open")

    gap = [r for r in rows if r["in_notebook"] != r["in_desk"]]
    if gap:
        print(f"\n  ══ IN ONE STORE ONLY — {len(gap)} ══")
        print("  Not wrong. But a notebook case with no claims has produced")
        print("  nothing publishable yet, and claims with no notebook have no")
        print("  open questions tracked against them.")
        for r in sorted(gap, key=rank)[:20]:
            where = "notebook only" if r["in_notebook"] else "desk only"
            print(f"    {r['slug']:<30} {where:<14} "
                  f"{r['exhibits']} exhibit(s) · {r['claims']} claim(s)")

    work = [r for r in rows if r["open_questions"] and not r["contradictions"]]
    if work:
        print(f"\n  ══ OPEN QUESTIONS — {len(work)} ══")
        for r in sorted(work, key=rank)[:20]:
            print(f"    {r['slug']:<30} {r['open_questions']} open · "
                  f"{r['exhibits']} exhibit(s) · {r['claims']} claim(s)")

    print("\n  Ordering is a heuristic, not a judgement: contradictions, then")
    print("  open questions, then cases present in only one store.")
    return BLOCKING if contra else OK


if __name__ == "__main__":
    sys.exit(main())
