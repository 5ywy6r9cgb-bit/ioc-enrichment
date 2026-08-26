"""
cli.py — one command, everything under it.

    sentinel init
    sentinel case new <slug> "<title>" [--jurisdiction …]
    sentinel case list
    sentinel ingest <case> <file> --title … --custodian … [--shelf PRIMARY]
    sentinel claim add <case> "<text>" --tier GREEN [--formula …] [--outlet …]
                                        [--gate …] [--resolution …]
    sentinel cite <claim-id> <doc-id> --locator "p.3" [--quote "…"]
    sentinel request add <ref> "<title>" --office … [--case …] [--due …]
    sentinel request set <ref> --status PRODUCED [--responded 2026-08-19]
    sentinel correct <ref> "<headline>" [--retire 880000 --reason "…"]
    sentinel gate run [--claim N | --case slug]
    sentinel export <case>
    sentinel submit <case> "<title>"
    sentinel decide <submission-id> --approve|--reject --reason "…"
    sentinel serve [--port 8787]
    sentinel doctor
    sentinel verify

Writes go through the CLI. The browser dashboard reads. The single exception
is the publication-gate decision, which exists in both places because it is
the one action you want to be able to take with the whole packet in front of
you on screen.
"""

from __future__ import annotations
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import audit, export, gates, guard, ingest, store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _root(a) -> Path:
    return Path(a.root or os.environ.get("SENTINEL_ROOT") or store.default_root()).expanduser()


def _die(msg: str, code: int = 1):
    print(f"\n  {msg}\n", file=sys.stderr)
    sys.exit(code)


# ── commands ──────────────────────────────────────────────────────────────

def cmd_init(a, conn, root):
    audit.record(conn, "desk.init", "operator", None, {"root": str(root)},
                 mirror=store.audit_mirror(root))
    print(f"""
  Sentinel Desk initialised.

    store   {root / 'sentinel.db'}
    vault   {root / 'vault'}        (evidence bytes, addressed by hash)
    exports {root / 'exports'}
    audit   {root / 'audit.jsonl'}  (chain mirror — survives losing the db)

  Back up by copying the whole {root.name}/ folder. That is the entire
  procedure; there is no daemon and no dump command.

  Next:  sentinel case new dublin-dfr "Dublin Drone as First Responder"
""")


def cmd_case_new(a, conn, root):
    guard.assert_clean({"title": a.title, "slug": a.slug}, "case")
    now = _now()
    try:
        conn.execute(
            "INSERT INTO cases (slug,title,jurisdiction,status,opened,updated,note) "
            "VALUES (?,?,?,?,?,?,?)",
            (a.slug, a.title, a.jurisdiction, a.status, now, now, a.note))
    except sqlite3.IntegrityError:
        _die(f"A case with slug '{a.slug}' already exists.")
    audit.record(conn, "case.new", "operator", a.slug,
                 {"title": a.title, "jurisdiction": a.jurisdiction},
                 mirror=store.audit_mirror(root))
    print(f"  case created: {a.slug} — {a.title}")


def cmd_case_list(a, conn, root):
    rows = conn.execute("""
        SELECT cs.slug, cs.title, cs.status,
          (SELECT COUNT(*) FROM documents d WHERE d.case_id=cs.id) nd,
          (SELECT COUNT(*) FROM claims c WHERE c.case_id=cs.id) nc
        FROM cases cs ORDER BY cs.updated DESC""").fetchall()
    if not rows:
        return print("  no cases yet")
    print()
    for r in rows:
        print(f"  {r['slug']:<24} {r['status']:<18} {r['nd']:>3} docs  "
              f"{r['nc']:>3} claims   {r['title']}")
    print()


def cmd_ingest(a, conn, root):
    res = ingest.ingest(conn, root, a.case, Path(a.file), title=a.title,
                        custodian=a.custodian, shelf=a.shelf,
                        request_ref=a.request, note=a.note)
    print(f"\n  {res['status']}: {res['title']}")
    print(f"    id        {res['id']}")
    print(f"    sha256    {res['sha256']}")
    if res["status"] == "ingested":
        print(f"    bytes     {res['bytes']:,}")
        print(f"    container {res['container']}"
              + (f" ({res['pages']} pages)" if res.get("pages") else ""))
        if res["detail"]:
            print(f"\n    NOTE: {res['detail']}")
    else:
        print(f"    {res['detail']}")
    print()


def cmd_claim_add(a, conn, root):
    guard.assert_clean({"text": a.text}, "claim")
    cs = store.case_by_slug(conn, a.case)
    if cs is None:
        _die(f"No case '{a.case}'.")
    now = _now()
    origin = getattr(a, "origin", None) or "human"
    if origin not in ("human", "machine"):
        _die("--origin must be 'human' or 'machine'.")
    # A human-entered claim is disposed of by the act of entering it: somebody
    # typed the sentence. A machine-drafted one is not, and stays undisposed
    # until a person opens the source and says so.
    disposed_by = getattr(a, "by", None) if origin == "human" else None
    cur = conn.execute(
        "INSERT INTO claims (case_id,text,tier,formula,outlet,closing_gate,resolution,"
        "created,updated,origin,origin_note,disposed_by,disposed_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (cs["id"], a.text, a.tier, a.formula, a.outlet, a.gate, a.resolution, now, now,
         origin, getattr(a, "origin_note", None), disposed_by,
         now if disposed_by else None))
    cid = cur.lastrowid
    audit.record(conn, "claim.add", "operator", str(cid),
                 {"case": a.case, "tier": a.tier, "text": a.text,
                  "origin": origin, "origin_note": getattr(a, "origin_note", None)},
                 mirror=store.audit_mirror(root))
    r = gates.run(conn, cid)
    tag = "" if origin == "human" else "  [machine-drafted — nobody has read the source]"
    print(f"\n  claim {cid} recorded [{a.tier}]{tag}")
    _print_gates(r)


def cmd_claim_list(a, conn, root):
    """Every claim, its id, and whether anything is standing in its way.

    Without this there is no way to find a claim id, so `claim dispose` and
    `cite` -- both of which take one -- are unreachable from the CLI. The
    disposal workflow existed and could not be performed.
    """
    q = ("SELECT cl.*, cs.slug FROM claims cl JOIN cases cs ON cs.id = cl.case_id")
    args: list = []
    if a.case:
        q += " WHERE cs.slug = ?"
        args.append(a.case)
    q += " ORDER BY cs.slug, cl.id"
    rows = conn.execute(q, args).fetchall()

    if a.case and not rows:
        # A case with no claims and a case that does not exist are different
        # facts, and only one of them means "nothing to do".
        store.case_by_slug(conn, a.case)
        print(f"\n  {a.case}: no claims yet.\n")
        return
    if not rows:
        print("\n  No claims on the desk yet.\n")
        return

    shown = 0
    for r in rows:
        blocking = [g for g in gates.evaluate(conn, r["id"])
                    if not g["passed"] and g["level"] == gates.BLOCK]
        origin = (r["origin"] or "human")
        needs = origin in ("machine", "unknown") and not r["disposed_by"]

        if a.needs_disposition and not needs:
            continue
        if a.blocked and not blocking:
            continue
        if a.tier and r["tier"] != a.tier:
            continue
        shown += 1

        mark = "!" if blocking else " "
        tag = {"machine": " [machine-drafted]",
               "unknown": " [origin unknown]"}.get(origin, "")
        if r["disposed_by"]:
            tag += f" [disposed by {r['disposed_by']}]"
        text = (r["text"] or "")
        if len(text) > 92:
            text = text[:89] + "..."
        print(f" {mark} {str(r['id']).rjust(4)}  [{r['tier']:<8}] {r['slug']:<14} {text}")
        if tag.strip():
            print(f"        {tag.strip()}")
        for g in blocking:
            print(f"        · {g['gate']}")

    print(f"\n  {shown} claim(s) shown.")
    undisposed = sum(1 for r in rows
                     if (r["origin"] or "human") in ("machine", "unknown")
                     and not r["disposed_by"])
    if undisposed and not a.needs_disposition:
        print(f"  {undisposed} need a person to dispose of them — "
              f"sentinel claim list --needs-disposition")
    print()


def cmd_claim_dispose(a, conn, root):
    """A person takes responsibility for a machine-drafted claim.

    This is the only way a machine-origin claim becomes publishable, and it is
    deliberately a separate act from citing a document. Attaching a citation
    says "this document is related". Disposing says "I opened it and this
    sentence is mine now."
    """
    c = conn.execute("SELECT * FROM claims WHERE id=?", (a.claim,)).fetchone()
    if c is None:
        _die(f"No claim {a.claim}.")
    if c["disposed_by"]:
        _die(f"Claim {a.claim} was already disposed by {c['disposed_by']} "
             f"on {c['disposed_at']}.")
    now = _now()
    conn.execute("UPDATE claims SET disposed_by=?, disposed_at=?, updated=? WHERE id=?",
                 (a.by, now, now, a.claim))
    audit.record(conn, "claim.dispose", a.by, str(a.claim),
                 {"note": a.note}, mirror=store.audit_mirror(root))
    print(f"\n  claim {a.claim} disposed by {a.by}")
    _print_gates(gates.run(conn, a.claim))


def cmd_cite(a, conn, root):
    d = conn.execute("SELECT * FROM documents WHERE id=?", (a.doc,)).fetchone()
    if d is None:
        _die(f"No document {a.doc}.")
    try:
        conn.execute("INSERT INTO citations (claim_id,doc_id,locator,quote) VALUES (?,?,?,?)",
                     (a.claim, a.doc, a.locator, a.quote))
    except sqlite3.IntegrityError:
        _die("That claim already cites that document at that locator.")
    audit.record(conn, "citation.add", "operator", f"{a.claim}->{a.doc}",
                 {"locator": a.locator, "quote": a.quote},
                 mirror=store.audit_mirror(root))
    r = gates.run(conn, a.claim)
    print(f"\n  claim {a.claim} now cites '{d['title']}' at {a.locator}")
    _print_gates(r)


def cmd_request_add(a, conn, root):
    case_id = None
    if a.case:
        cs = store.case_by_slug(conn, a.case)
        if cs is None:
            _die(f"No case '{a.case}'.")
        case_id = cs["id"]
    try:
        conn.execute(
            "INSERT INTO requests (case_id,ref,title,office,statute,asked,status,filed,due,"
            "priority) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (case_id, a.ref, a.title, a.office, a.statute, a.asked,
             a.status, a.filed, a.due, a.priority))
    except sqlite3.IntegrityError:
        _die(f"Request '{a.ref}' already exists.")
    audit.record(conn, "request.add", "operator", a.ref,
                 {"office": a.office, "title": a.title, "statute": a.statute},
                 mirror=store.audit_mirror(root))
    print(f"  request {a.ref} logged → {a.office}")


def cmd_request_set(a, conn, root):
    r = conn.execute("SELECT * FROM requests WHERE ref=?", (a.ref,)).fetchone()
    if r is None:
        _die(f"No request '{a.ref}'.")
    fields, vals = [], []
    for k in ("status", "filed", "due", "responded", "refusal"):
        v = getattr(a, k)
        if v is not None:
            fields.append(f"{k}=?")
            vals.append(v)
    if not fields:
        _die("Nothing to change.")
    vals.append(a.ref)
    conn.execute(f"UPDATE requests SET {','.join(fields)} WHERE ref=?", vals)
    audit.record(conn, "request.update", "operator", a.ref,
                 {k: getattr(a, k) for k in ("status", "filed", "due", "responded")
                  if getattr(a, k) is not None},
                 mirror=store.audit_mirror(root))
    print(f"  request {a.ref} updated")


def cmd_correct(a, conn, root):
    try:
        conn.execute(
            "INSERT INTO corrections (ref,date,severity,headline,published,correct,why,action) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (a.ref, a.date or _now()[:10], a.severity, a.headline,
             a.published, a.correct, a.why, a.action))
    except sqlite3.IntegrityError:
        _die(f"Correction '{a.ref}' already exists. Corrections are permanent; "
             f"issue a new one rather than editing this.")
    for fig in (a.retire or []):
        conn.execute(
            "INSERT OR IGNORE INTO retired_figures (correction_ref,figure,reason) "
            "VALUES (?,?,?)", (a.ref, fig, a.reason))
    audit.record(conn, "correction.issue", "operator", a.ref,
                 {"headline": a.headline, "retired": a.retire or []},
                 mirror=store.audit_mirror(root))
    print(f"\n  correction {a.ref} recorded: {a.headline}")
    if a.retire:
        print(f"  retired figure(s): {', '.join(a.retire)}")
        print("  the RETIRED_FIGURE gate will now block any claim containing them.\n")
        # Re-run gates everywhere — a retirement is retroactive by design.
        n = 0
        for row in conn.execute("SELECT id FROM claims"):
            if not gates.run(conn, row["id"])["publishable"]:
                n += 1
        print(f"  re-ran gates on every claim: {n} now blocked.\n")


def _print_gates(r: dict) -> None:
    if r["publishable"]:
        print("    gates: clear")
    else:
        print("    gates: BLOCKED")
        for b in r["blocks"]:
            print(f"      · {b['gate']}: {b['detail']}")
    for w in r["warns"]:
        print(f"      ~ {w['gate']}: {w['detail']}")
    print()


def cmd_gate_run(a, conn, root):
    if a.claim:
        _print_gates(gates.run(conn, a.claim))
    elif a.case:
        res = gates.run_case(conn, a.case)
        print(f"\n  {res['case']}: {res['publishable']}/{res['claims']} publishable")
        for b in res["blocked"]:
            c = conn.execute("SELECT text,tier FROM claims WHERE id=?",
                             (b["claim_id"],)).fetchone()
            print(f"\n    [{c['tier']}] claim {b['claim_id']}: {c['text'][:80]}")
            for x in b["blocks"]:
                print(f"      · {x['gate']}: {x['detail']}")
        print()
    else:
        total = blocked = 0
        for row in conn.execute("SELECT id FROM claims"):
            total += 1
            if not gates.run(conn, row["id"])["publishable"]:
                blocked += 1
        print(f"\n  {total} claim(s) evaluated, {blocked} blocked.\n")


def cmd_export(a, conn, root):
    res = export.write(conn, root, a.case)
    print(f"""
  exported → {res['dir']}
    dossier.md      {res['published']} publishable claim(s)
    findings.json   ready for the video pipeline
    withheld        {res['withheld']} claim(s), listed in the dossier with reasons
    sha256          {res['dossier_sha256']}
""")


def cmd_submit(a, conn, root):
    res = export.submit(conn, root, a.case, a.title)
    print(f"""
  submission {res['id']} is waiting at the publication gate.
    payload sha256  {res['payload_sha256']}
    withheld        {res['withheld']} claim(s)

  Decide it:  sentinel decide {res['id']} --approve
  Or on screen at http://127.0.0.1:8787/gate
""")


def cmd_decide(a, conn, root):
    if not a.approve and not a.reject:
        _die("Choose --approve or --reject.")
    if a.reject and not a.reason:
        _die("A rejection needs --reason. A rejection with no reason teaches nothing.")
    d = "APPROVED" if a.approve else "REJECTED"
    cur = conn.execute(
        "UPDATE submissions SET decision=?, decided=?, decided_by=?, reason=? "
        "WHERE id=? AND decision='PENDING'", (d, _now(), "operator", a.reason, a.id))
    if cur.rowcount == 0:
        _die(f"No PENDING submission {a.id}.")
    audit.record(conn, f"gate.{d.lower()}", "operator", str(a.id),
                 {"reason": a.reason}, mirror=store.audit_mirror(root))
    print(f"  submission {a.id}: {d}")


def cmd_serve(a, conn, root):
    conn.close()
    from .server import serve
    serve(root, a.port)


def cmd_doctor(a, conn, root):
    ok, msg = audit.verify(conn)
    c = store.counts(conn)
    problems = ingest.verify_vault(conn)
    tok = "set" if os.environ.get("SENTINEL_TOKEN") else "NOT SET — the gate fails closed"
    print(f"""
  SENTINEL DESK — DOCTOR

    store          {root / 'sentinel.db'}
    vault          {root / 'vault'}
    python         {sys.version.split()[0]}
    dependencies   none (standard library only)
    network        none required, none made

    cases          {c['cases']}  ({c['open_cases']} open)
    documents      {c['documents']}  (primary {c['shelves']['PRIMARY']})
    claims         {c['claims']}  (green {c['tiers']['GREEN']}, open {c['tiers']['RED']})
    blocked        {c['blocks']}
    pending gate   {c['pending_gate']}
    retired figs   {c['retired']}

    audit chain    {'INTACT' if ok else 'BROKEN'} — {msg}
    vault check    {len(problems)} problem(s)
    operator token {tok}
""")
    for p in problems:
        print(f"      {p['problem']}: {p['title']} — {p['detail']}")
    print()


def cmd_verify(a, conn, root):
    ok, msg = audit.verify(conn)
    print(f"  audit chain: {'INTACT' if ok else 'BROKEN'} — {msg}")
    problems = ingest.verify_vault(conn)
    print(f"  vault: {len(problems)} problem(s)")
    for p in problems:
        print(f"    {p['problem']}: {p['title']} — {p['detail']}")
    sys.exit(0 if ok and not problems else 1)


# ── parser ────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser("sentinel", description="The Sentinel Desk — local, offline.")
    p.add_argument("--root", help="desk directory (default ~/Sentinel or $SENTINEL_ROOT)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create the desk").set_defaults(fn=cmd_init)

    c = sub.add_parser("case", help="cases")
    cs = c.add_subparsers(dest="sub", required=True)
    n = cs.add_parser("new")
    n.add_argument("slug"); n.add_argument("title")
    n.add_argument("--jurisdiction", default="")
    n.add_argument("--status", default="OPEN", choices=store.CASE_STATUS)
    n.add_argument("--note", default="")
    n.set_defaults(fn=cmd_case_new)
    cs.add_parser("list").set_defaults(fn=cmd_case_list)

    g = sub.add_parser("ingest", help="hash, classify and vault a document")
    g.add_argument("case"); g.add_argument("file")
    g.add_argument("--title", required=True)
    g.add_argument("--custodian", required=True)
    g.add_argument("--shelf", default="PRIMARY", choices=store.SHELVES)
    g.add_argument("--request", default=None)
    g.add_argument("--note", default="")
    g.set_defaults(fn=cmd_ingest)

    cl = sub.add_parser("claim")
    cls = cl.add_subparsers(dest="sub", required=True)
    ca = cls.add_parser("add")
    ca.add_argument("case"); ca.add_argument("text")
    ca.add_argument("--tier", required=True, choices=store.TIERS)
    ca.add_argument("--formula", default=None, help="required for ARITH")
    ca.add_argument("--outlet", default=None, help="required for REPORTED")
    ca.add_argument("--gate", default=None, help="required for RED: what would close it")
    ca.add_argument("--resolution", default=None, help="required for DEAD: what closed it")
    ca.add_argument("--origin", default="human", choices=["human", "machine"],
                    help="how this claim entered the ledger")
    ca.add_argument("--origin-note", dest="origin_note", default=None,
                    help="what drafted it, when origin is machine")
    ca.add_argument("--by", default=None, help="who entered it")
    ca.set_defaults(fn=cmd_claim_add)

    cll = cls.add_parser("list", help="every claim, its id, and what blocks it")
    cll.add_argument("case", nargs="?", default=None)
    cll.add_argument("--needs-disposition", dest="needs_disposition",
                     action="store_true", help="only claims awaiting a person")
    cll.add_argument("--blocked", action="store_true",
                     help="only claims failing a blocking gate")
    cll.add_argument("--tier", default=None, choices=store.TIERS)
    cll.set_defaults(fn=cmd_claim_list)

    cd = cls.add_parser("dispose",
                        help="take responsibility for a machine-drafted claim")
    cd.add_argument("claim", type=int)
    cd.add_argument("--by", required=True, help="your name — this goes in the ledger")
    cd.add_argument("--note", default=None)
    cd.set_defaults(fn=cmd_claim_dispose)

    ci = sub.add_parser("cite", help="attach a document to a claim")
    ci.add_argument("claim", type=int); ci.add_argument("doc", type=int)
    ci.add_argument("--locator", required=True)
    ci.add_argument("--quote", default="")
    ci.set_defaults(fn=cmd_cite)

    rq = sub.add_parser("request")
    rqs = rq.add_subparsers(dest="sub", required=True)
    ra = rqs.add_parser("add")
    ra.add_argument("ref"); ra.add_argument("title")
    ra.add_argument("--office", required=True)
    ra.add_argument("--case", default=None)
    ra.add_argument("--statute", default="ORC 149.43")
    ra.add_argument("--asked", default="")
    ra.add_argument("--status", default="DRAFTED", choices=store.REQUEST_STATUS)
    ra.add_argument("--filed", default=None); ra.add_argument("--due", default=None)
    ra.add_argument("--priority", type=int, default=50)
    ra.set_defaults(fn=cmd_request_add)
    rs = rqs.add_parser("set")
    rs.add_argument("ref")
    rs.add_argument("--status", default=None, choices=store.REQUEST_STATUS)
    rs.add_argument("--filed", default=None); rs.add_argument("--due", default=None)
    rs.add_argument("--responded", default=None); rs.add_argument("--refusal", default=None)
    rs.set_defaults(fn=cmd_request_set)

    co = sub.add_parser("correct", help="issue a correction, optionally retiring a figure")
    co.add_argument("ref"); co.add_argument("headline")
    co.add_argument("--date", default=None)
    co.add_argument("--severity", default="MATERIAL")
    co.add_argument("--published", default=""); co.add_argument("--correct", default="")
    co.add_argument("--why", default=""); co.add_argument("--action", default="")
    co.add_argument("--retire", action="append", help="figure to retire, repeatable")
    co.add_argument("--reason", default="")
    co.set_defaults(fn=cmd_correct)

    gr = sub.add_parser("gate")
    grs = gr.add_subparsers(dest="sub", required=True)
    gn = grs.add_parser("run")
    gn.add_argument("--claim", type=int, default=None)
    gn.add_argument("--case", default=None)
    gn.set_defaults(fn=cmd_gate_run)

    ex = sub.add_parser("export"); ex.add_argument("case"); ex.set_defaults(fn=cmd_export)
    sb = sub.add_parser("submit"); sb.add_argument("case"); sb.add_argument("title")
    sb.set_defaults(fn=cmd_submit)

    de = sub.add_parser("decide"); de.add_argument("id", type=int)
    de.add_argument("--approve", action="store_true")
    de.add_argument("--reject", action="store_true")
    de.add_argument("--reason", default=None)
    de.set_defaults(fn=cmd_decide)

    sv = sub.add_parser("serve"); sv.add_argument("--port", type=int, default=8787)
    sv.set_defaults(fn=cmd_serve)

    sub.add_parser("doctor").set_defaults(fn=cmd_doctor)
    sub.add_parser("verify").set_defaults(fn=cmd_verify)
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    root = _root(a)
    conn = store.open_db(root)
    try:
        a.fn(a, conn, root)
    except guard.RefusedInput as ex:
        _die(str(ex), 2)
    except (KeyError, FileNotFoundError) as ex:
        _die(str(ex).strip("'"), 1)
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return 0
