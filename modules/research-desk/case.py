#!/usr/bin/env python3
"""
case.py -- the case file, and the gate that decides whether it can be published.

A case is the unit of work above a records request. A request gets you a
document; a case is the claim that document is supposed to support, plus every
other document, every question you have not answered yet, and every place two
sources disagree.

WHY THE GATE IS THE POINT
    The dashboard is a view. This file is the rule. A case is PUBLISHABLE only
    when four things are all true at once, and each one exists because the
    failure it prevents is a correction or a retraction:

      R-01  Every financial exhibit is read to the last page.
            The number that ruins a story is on page 40 of a 44-page filing.
      R-02  No exhibit is marked broken.
            A dead link or an unverifiable file cannot support a claim.
      R-03  No open questions remain.
            An open question is a hole you already know about.
      R-04  No open contradictions remain.
            Two sources disagreeing is the single best predictor that a
            published claim is wrong.

    The gate is deliberately not overridable from the terminal. There is no
    --force. If you want to publish past a blocker, you resolve the blocker or
    you change what you are claiming; a flag that lets you skip the check is a
    flag that eventually gets used at 1am.

WHERE CASES LIVE
    <repo>/evidence/sentinel_cases/*.json  -- gitignored, and it stays that way.
    A case file names subjects, describes unproven allegations, and records
    what you have not verified yet. That is the most sensitive material in the
    system. Override with SENTINEL_CASES if you keep it elsewhere.

USAGE
    sentinel case new  CASE-ID "What the case is about"
    sentinel case add  CASE-ID EX-1 path/to/file.pdf --kind financial --pages 44
    sentinel case read CASE-ID EX-1 44            pages read to date
    sentinel case break CASE-ID EX-1 "404 since 2026-08-01"
    sentinel case fix  CASE-ID EX-1
    sentinel case ask  CASE-ID "Who signed the amendment?"
    sentinel case answered CASE-ID Q-1 "Signed by the deputy director"
    sentinel case conflict CASE-ID "Filing says $2.1M, minutes say $1.4M"
    sentinel case resolve  CASE-ID X-1 "Minutes were a draft; filing controls"
    sentinel case status CASE-ID
    sentinel case list
"""

from __future__ import annotations

import json
import os
import re
import sys
import datetime as dt
from pathlib import Path

FINANCIAL_KINDS = {"financial"}
VALID_KINDS = {"financial", "legal", "correspondence", "record", "media", "other"}


def cases_dir() -> Path:
    env = os.environ.get("SENTINEL_CASES")
    if env:
        return Path(env)
    # modules/research-desk/ -> repo root
    return Path(__file__).resolve().parents[2] / "evidence" / "sentinel_cases"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


class CaseError(Exception):
    pass


def _safe_id(cid: str) -> str:
    """A case id becomes a filename, so it may not become a path.

    'ex/../../.ssh/id_rsa' is a valid-looking case id and an invalid filename.
    """
    if not cid or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", cid):
        raise CaseError(
            f"invalid id {cid!r} -- letters, digits, dot, dash, underscore only"
        )
    return cid


def path_for(cid: str) -> Path:
    return cases_dir() / f"{_safe_id(cid)}.json"


def load(cid: str) -> dict:
    p = path_for(cid)
    if not p.exists():
        raise CaseError(f"no case {cid!r}. Create it: sentinel case new {cid} \"...\"")
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError as e:
        # Never silently reset. This file is the record of what you have read.
        raise CaseError(
            f"{p} is not valid JSON ({e}). It has NOT been modified."
        ) from None


def save(d: dict) -> Path:
    """Write via temp + rename. A half-written case file is worse than none."""
    p = path_for(d["case_id"])
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(d, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(p)
    return p


def load_all() -> list[dict]:
    d = cases_dir()
    if not d.is_dir():
        return []
    out = []
    for f in sorted(d.glob("*.json")):
        try:
            out.append(json.loads(f.read_text()))
        except json.JSONDecodeError:
            # One corrupt file must not blind the whole dashboard. Surface it
            # as a case that cannot be published rather than dropping it.
            out.append({
                "case_id": f.stem, "subject": "(unreadable file)",
                "exhibits": {}, "questions_open": [],
                "contradictions": [{"id": "X-PARSE", "status": "open",
                                    "text": f"{f.name} is not valid JSON"}],
            })
    return out


# ------------------------------------------------------------------ the gate

def compute(d: dict) -> dict:
    """The publish gate. The dashboard renders this; it does not decide it."""
    ex = list(d.get("exhibits", {}).values())
    total = sum(e["pages_total"] for e in ex) or 1
    read = sum(e["pages_read"] for e in ex)
    broken = [e for e in ex if e.get("broken")]
    open_q = list(d.get("questions_open", []))
    open_x = [c for c in d.get("contradictions", []) if c.get("status") == "open"]
    unread_fin = [e for e in ex
                  if e.get("kind") in FINANCIAL_KINDS and e["pages_read"] < e["pages_total"]]
    unread_any = [e for e in ex if e["pages_read"] < e["pages_total"]]
    pct = round(100 * read / total, 1) if ex else 0.0

    # An empty case is NOT publishable. 0 exhibits reads as 100% of nothing,
    # and "we verified everything we had" is not a defence when you had nothing.
    publishable = bool(ex) and pct == 100.0 and not broken and not open_q and not open_x

    blockers = []
    if not ex:
        blockers.append(("R-00", "no exhibits -- there is nothing to publish from"))
    if unread_fin:
        blockers.append(("R-01", "unread financial exhibit: "
                         + ", ".join(e["id"] for e in unread_fin)))
    if broken:
        blockers.append(("R-02", "broken evidence: "
                         + ", ".join(f'{e["id"]} ({e["broken"]})' for e in broken)))
    if open_q:
        blockers.append(("R-03", f"{len(open_q)} open question(s)"))
    if open_x:
        blockers.append(("R-04", f"{len(open_x)} open contradiction(s)"))
    nonfin_unread = [e["id"] for e in unread_any if e not in unread_fin]
    if nonfin_unread:
        blockers.append(("--", "unread: " + ", ".join(nonfin_unread)))

    return dict(pct=pct, total=total, read=read, broken=broken, open_q=open_q,
                open_x=open_x, unread_fin=unread_fin, unread_any=unread_any,
                publishable=publishable, n_ex=len(ex), blockers=blockers)


# ------------------------------------------------------------------ mutations

def new_case(cid: str, subject: str) -> dict:
    p = path_for(cid)
    if p.exists():
        raise CaseError(f"{cid} already exists at {p}")
    d = {"case_id": _safe_id(cid), "subject": subject, "created_at": _now(),
         "exhibits": {}, "questions_open": [], "questions_answered": [],
         "contradictions": [], "log": []}
    save(d)
    return d


def _log(d: dict, what: str) -> None:
    d.setdefault("log", []).append({"at": _now(), "what": what})


def add_exhibit(cid, ex_id, file, kind="other", pages=1) -> dict:
    d = load(cid)
    _safe_id(ex_id)
    if kind not in VALID_KINDS:
        raise CaseError(f"unknown kind {kind!r} -- one of: {', '.join(sorted(VALID_KINDS))}")
    pages = int(pages)
    if pages < 1:
        raise CaseError("pages must be at least 1")
    if ex_id in d["exhibits"]:
        raise CaseError(f"{ex_id} already exists in {cid}")
    d["exhibits"][ex_id] = {"id": ex_id, "file": file, "kind": kind,
                            "pages_total": pages, "pages_read": 0, "broken": None,
                            "added_at": _now()}
    _log(d, f"added exhibit {ex_id} ({kind}, {pages}p): {file}")
    save(d)
    return d["exhibits"][ex_id]


def mark_read(cid, ex_id, pages) -> dict:
    d = load(cid)
    e = d["exhibits"].get(ex_id)
    if not e:
        raise CaseError(f"no exhibit {ex_id} in {cid}")
    pages = int(pages)
    if pages < 0:
        raise CaseError("pages read cannot be negative")
    if pages > e["pages_total"]:
        raise CaseError(
            f"{ex_id} has {e['pages_total']} pages; you cannot read {pages}. "
            f"If the page count was wrong, that is its own correction.")
    before = e["pages_read"]
    e["pages_read"] = pages
    _log(d, f"{ex_id} read {before} -> {pages}/{e['pages_total']}")
    save(d)
    return e


def mark_broken(cid, ex_id, why) -> dict:
    d = load(cid)
    e = d["exhibits"].get(ex_id)
    if not e:
        raise CaseError(f"no exhibit {ex_id} in {cid}")
    if not why:
        raise CaseError("say what is broken about it")
    e["broken"] = why
    _log(d, f"{ex_id} marked broken: {why}")
    save(d)
    return e


def mark_fixed(cid, ex_id) -> dict:
    d = load(cid)
    e = d["exhibits"].get(ex_id)
    if not e:
        raise CaseError(f"no exhibit {ex_id} in {cid}")
    was = e["broken"]
    e["broken"] = None
    _log(d, f"{ex_id} no longer broken (was: {was})")
    save(d)
    return e


def ask(cid, text) -> dict:
    d = load(cid)
    if not text:
        raise CaseError("a question needs text")
    qid = f"Q-{len(d['questions_open']) + len(d.get('questions_answered', [])) + 1}"
    q = {"id": qid, "text": text, "asked_at": _now()}
    d["questions_open"].append(q)
    _log(d, f"asked {qid}: {text}")
    save(d)
    return q


def answered(cid, qid, answer) -> dict:
    d = load(cid)
    hit = next((q for q in d["questions_open"] if q["id"] == qid), None)
    if not hit:
        raise CaseError(f"no open question {qid} in {cid}")
    if not answer:
        raise CaseError("record what the answer actually was")
    d["questions_open"].remove(hit)
    hit["answer"] = answer
    hit["answered_at"] = _now()
    d.setdefault("questions_answered", []).append(hit)
    _log(d, f"answered {qid}: {answer}")
    save(d)
    return hit


def conflict(cid, text) -> dict:
    d = load(cid)
    if not text:
        raise CaseError("describe what disagrees with what")
    xid = f"X-{len(d['contradictions']) + 1}"
    x = {"id": xid, "text": text, "status": "open", "raised_at": _now()}
    d["contradictions"].append(x)
    _log(d, f"raised {xid}: {text}")
    save(d)
    return x


def resolve(cid, xid, how) -> dict:
    d = load(cid)
    hit = next((x for x in d["contradictions"] if x["id"] == xid), None)
    if not hit:
        raise CaseError(f"no contradiction {xid} in {cid}")
    if hit["status"] != "open":
        raise CaseError(f"{xid} is already {hit['status']}")
    if not how:
        raise CaseError(
            "record HOW it resolved. 'resolved' with no reasoning is the same "
            "as an unresolved contradiction you have stopped looking at.")
    hit["status"] = "resolved"
    hit["resolution"] = how
    hit["resolved_at"] = _now()
    _log(d, f"resolved {xid}: {how}")
    save(d)
    return hit


# ------------------------------------------------------------------------ CLI

B, DIM, G, Y, R, X = "\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[31m", "\033[0m"


def _status(cid: str) -> None:
    d = load(cid)
    s = compute(d)
    print(f"\n  {B}{d['case_id']}{X}  {DIM}{d.get('subject','')}{X}")
    colour = G if s["publishable"] else R
    label = "PUBLISHABLE" if s["publishable"] else "BLOCKED"
    print(f"  {colour}{label}{X}  {DIM}{s['pct']}% read "
          f"({s['read']}/{s['total']} pages, {s['n_ex']} exhibit(s)){X}\n")
    for code, text in s["blockers"]:
        print(f"    {R if code.startswith('R') else Y}{code:5}{X} {text}")
    if s["publishable"]:
        print(f"    {DIM}Nothing is blocking. The gate does not say the story is "
              f"right -- only that you have read everything you have.{X}")
    print("")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]

    def need(n, usage):
        if len(rest) < n:
            raise CaseError(f"usage: sentinel case {usage}")

    try:
        if cmd == "list":
            cases = load_all()
            if not cases:
                print(f"\n  {DIM}No cases yet at {cases_dir()}{X}")
                print(f"  {DIM}Start one:  sentinel case new CASE-ID \"what it is about\"{X}\n")
                return 0
            print("")
            for d in cases:
                s = compute(d)
                colour = G if s["publishable"] else R
                mark = "OK " if s["publishable"] else "BLK"
                print(f"  {colour}{mark}{X}  {B}{d['case_id']:<24}{X} "
                      f"{DIM}{s['pct']:>5}%  {len(s['blockers'])} blocker(s){X}  "
                      f"{DIM}{d.get('subject','')[:40]}{X}")
            print("")
            return 0

        if cmd == "new":
            need(2, 'new CASE-ID "what the case is about"')
            d = new_case(rest[0], " ".join(rest[1:]))
            print(f"\n  {G}created{X}  {B}{d['case_id']}{X}  {DIM}{path_for(d['case_id'])}{X}")
            print(f"  {DIM}Add the first exhibit:  sentinel case add {d['case_id']} "
                  f"EX-1 path/to/file.pdf --kind financial --pages 44{X}\n")
            return 0

        if cmd == "add":
            need(3, "add CASE-ID EX-ID path/to/file [--kind K] [--pages N]")
            kind, pages = "other", 1
            args = list(rest)
            if "--kind" in args:
                i = args.index("--kind"); kind = args[i + 1]; del args[i:i + 2]
            if "--pages" in args:
                i = args.index("--pages"); pages = args[i + 1]; del args[i:i + 2]
            e = add_exhibit(args[0], args[1], args[2], kind, pages)
            print(f"\n  {G}added{X}  {B}{e['id']}{X}  {DIM}{e['kind']}, "
                  f"{e['pages_total']} page(s){X}")
            if e["kind"] == "financial":
                print(f"  {Y}Financial exhibit: this case cannot publish until all "
                      f"{e['pages_total']} pages are read (R-01).{X}")
            print("")
            return 0

        if cmd == "read":
            # `case add` takes --pages N, so an operator reasonably writes
            # `case read CASE EX --pages 4` — and this used to hand the literal
            # string "--pages" to int() and die with a traceback. A CLI that
            # accepts a flag in one verb and crashes on it in the next is a CLI
            # that teaches the wrong thing, loudly, in the middle of the work.
            argv2 = list(rest)
            if "--pages" in argv2:
                i = argv2.index("--pages")
                if i + 1 >= len(argv2):
                    raise CaseError("--pages needs a number:  sentinel case read CASE-ID EX-ID --pages 4")
                pages_arg = argv2[i + 1]
                del argv2[i:i + 2]
            else:
                need(3, "read CASE-ID EX-ID PAGES   (or --pages N)")
                pages_arg = argv2[2]
            if len(argv2) < 2:
                raise CaseError("usage: sentinel case read CASE-ID EX-ID PAGES   (or --pages N)")
            try:
                int(pages_arg)
            except ValueError:
                raise CaseError(
                    f"pages must be a number, got {pages_arg!r}. "
                    "usage: sentinel case read CASE-ID EX-ID PAGES   (or --pages N)")
            e = mark_read(argv2[0], argv2[1], pages_arg)
            done = e["pages_read"] == e["pages_total"]
            print(f"\n  {G if done else DIM}{'complete' if done else 'progress'}{X}  "
                  f"{B}{e['id']}{X}  {e['pages_read']}/{e['pages_total']}\n")
            return 0

        if cmd == "break":
            need(3, 'break CASE-ID EX-ID "what is wrong with it"')
            e = mark_broken(rest[0], rest[1], " ".join(rest[2:]))
            print(f"\n  {R}broken{X}  {B}{e['id']}{X}  {e['broken']}")
            print(f"  {DIM}R-02: this blocks publication until fixed.{X}\n")
            return 0

        if cmd == "fix":
            need(2, "fix CASE-ID EX-ID")
            e = mark_fixed(rest[0], rest[1])
            print(f"\n  {G}fixed{X}  {B}{e['id']}{X}\n")
            return 0

        if cmd == "ask":
            need(2, 'ask CASE-ID "the question"')
            q = ask(rest[0], " ".join(rest[1:]))
            print(f"\n  {Y}open{X}  {B}{q['id']}{X}  {q['text']}")
            print(f"  {DIM}R-03: an open question blocks publication.{X}\n")
            return 0

        if cmd == "answered":
            need(3, 'answered CASE-ID Q-ID "the answer"')
            q = answered(rest[0], rest[1], " ".join(rest[2:]))
            print(f"\n  {G}answered{X}  {B}{q['id']}{X}  {q['answer']}\n")
            return 0

        if cmd == "conflict":
            need(2, 'conflict CASE-ID "A says X, B says Y"')
            x = conflict(rest[0], " ".join(rest[1:]))
            print(f"\n  {R}open{X}  {B}{x['id']}{X}  {x['text']}")
            print(f"  {DIM}R-04: two sources disagreeing is the best single predictor "
                  f"that a published claim is wrong.{X}\n")
            return 0

        if cmd == "resolve":
            need(3, 'resolve CASE-ID X-ID "how it resolved"')
            x = resolve(rest[0], rest[1], " ".join(rest[2:]))
            print(f"\n  {G}resolved{X}  {B}{x['id']}{X}  {x['resolution']}\n")
            return 0

        if cmd == "status":
            need(1, "status CASE-ID")
            _status(rest[0])
            return 0

        print(__doc__)
        return 2

    except CaseError as e:
        print(f"\n  {R}{e}{X}\n", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
