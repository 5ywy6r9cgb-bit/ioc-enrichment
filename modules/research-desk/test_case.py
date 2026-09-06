#!/usr/bin/env python3
"""
test_case.py -- the publish gate, tested against the failures it exists to stop.

Most of these are not "does the function work" tests. They are "does the gate
actually refuse" tests. A gate that can be talked out of blocking is not a gate,
and the way you find out it could be talked out of it is a correction notice.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"    PASS  {label}")
    else:
        FAIL += 1
        print(f"    FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def throws(label, fn, needle):
    try:
        fn()
    except Exception as e:
        check(label, needle in str(e), f"expected {needle!r}, got: {e}")
        return
    check(label, False, "no exception raised")


def main():
    tmp = tempfile.mkdtemp(prefix="sentinel-cases-")
    os.environ["SENTINEL_CASES"] = tmp

    # Exhibit paths below are REAL FILES, because add_exhibit now requires the
    # document to exist. A case that cites a path nothing ever wrote reads as
    # complete and cannot be checked, which is the failure the requirement is
    # for; the fixtures have to obey the same rule the operator does.
    def fixture(name):
        p = Path(tmp, name)
        p.write_bytes(b"%PDF-1.4 fixture\n")
        return str(p)
    import case as C
    import importlib
    importlib.reload(C)

    print("\n  case gate\n")

    # ── a case id becomes a filename, so it may not become a path ────────
    throws("a case id with a path separator is refused",
           lambda: C.new_case("../../etc/passwd", "x"), "invalid id")
    throws("so is an absolute one",
           lambda: C.new_case("/tmp/evil", "x"), "invalid id")
    throws("and an empty one",
           lambda: C.new_case("", "x"), "invalid id")

    # ── an empty case is not publishable ─────────────────────────────────
    C.new_case("CASE-1", "Gahanna contract award")
    s = C.compute(C.load("CASE-1"))
    check("a brand-new case is BLOCKED, not publishable", s["publishable"] is False)
    check("and says why: there is nothing to publish from",
          any(c == "R-00" for c, _ in s["blockers"]),
          str(s["blockers"]))
    throws("a duplicate case id is refused",
           lambda: C.new_case("CASE-1", "again"), "already exists")

    # ── R-01: the unread financial page ──────────────────────────────────
    C.add_exhibit("CASE-1", "EX-1", fixture("gahanna_award.pdf"), "financial", 44)
    s = C.compute(C.load("CASE-1"))
    check("an unread financial exhibit blocks on R-01",
          any(c == "R-01" for c, _ in s["blockers"]), str(s["blockers"]))
    C.mark_read("CASE-1", "EX-1", 43)
    s = C.compute(C.load("CASE-1"))
    check("43 of 44 pages still blocks -- the number is on the last page",
          s["publishable"] is False and any(c == "R-01" for c, _ in s["blockers"]))
    C.mark_read("CASE-1", "EX-1", 44)
    s = C.compute(C.load("CASE-1"))
    check("reading the last page clears R-01",
          not any(c == "R-01" for c, _ in s["blockers"]), str(s["blockers"]))
    check("and with nothing else open, the case is publishable", s["publishable"] is True)
    check("100% read", s["pct"] == 100.0)

    throws("you cannot read more pages than the exhibit has",
           lambda: C.mark_read("CASE-1", "EX-1", 45), "cannot read 45")
    throws("a negative page count is refused",
           lambda: C.mark_read("CASE-1", "EX-1", -1), "negative")
    throws("an unknown exhibit is refused",
           lambda: C.mark_read("CASE-1", "NOPE", 1), "no exhibit")
    throws("a duplicate exhibit id is refused",
           lambda: C.add_exhibit("CASE-1", "EX-1", fixture("other.pdf")), "already exists")
    throws("an invented exhibit kind is refused",
           lambda: C.add_exhibit("CASE-1", "EX-9", fixture("x.pdf"), "vibes", 2), "unknown kind")

    # ── THE PASTED STAND-IN ──────────────────────────────────────────────
    #
    # A command block said:
    #   case add securitization-2026 EX-1 THE_PATH_doc_last_PRINTED --pages REAL_COUNT
    # meaning "put the path `doc last` printed here, and the page count you
    # counted". It was pasted verbatim, and `add` answered with:
    #
    #   ValueError: invalid literal for int() with base 10: 'REAL_COUNT'
    #
    # -- a Python traceback, from the same file where `read` refused the same
    # kind of paste in a clean sentence. Both verbs go through _pages() now,
    # and the path itself is checked too: the run that produced the traceback
    # would ALSO have filed a nonexistent document as an exhibit if the page
    # count had happened to be a number.
    throws("a stand-in page count is refused, not thrown",
           lambda: C.add_exhibit("CASE-1", "EX-P", fixture("a.pdf"), "other", "REAL_COUNT"),
           "must be a number")
    throws("and `read` refuses it with the same sentence",
           lambda: C.mark_read("CASE-1", "EX-1", "PAGES_YOU_READ"),
           "must be a number")
    throws("a stand-in path is refused as a placeholder",
           lambda: C.add_exhibit("CASE-1", "EX-P", "THE_PATH_doc_last_PRINTED", "other", 4),
           "placeholder")
    throws("so is a shouted one with an extension",
           lambda: C.add_exhibit("CASE-1", "EX-P", "/x/THE_FILE.pdf", "other", 4),
           "placeholder")
    throws("an exhibit whose file does not exist is refused",
           lambda: C.add_exhibit("CASE-1", "EX-P", str(Path(tmp, "never-written.pdf")), "other", 4),
           "no such file")
    check("and none of those four landed in the case",
          "EX-P" not in C.load("CASE-1")["exhibits"],
          str(sorted(C.load("CASE-1")["exhibits"])))
    # A real filename that happens to shout is still a real filename.
    C.add_exhibit("CASE-1", "EX-OK", fixture("REPORT.pdf"), "other", 2)
    check("a single shouted word is a filename, not a placeholder",
          "EX-OK" in C.load("CASE-1")["exhibits"])
    # Read it, so this fixture does not leave an unread exhibit holding the
    # gate shut for every check below it.
    C.mark_read("CASE-1", "EX-OK", 2)

    # ── R-02: broken evidence ────────────────────────────────────────────
    C.mark_broken("CASE-1", "EX-1", "404 since 2026-08-01")
    s = C.compute(C.load("CASE-1"))
    check("a broken exhibit blocks even at 100% read",
          s["publishable"] is False and any(c == "R-02" for c, _ in s["blockers"]))
    check("and the reason travels with it",
          "404" in str(s["blockers"]), str(s["blockers"]))
    throws("marking something broken requires saying what is broken",
           lambda: C.mark_broken("CASE-1", "EX-1", ""), "what is broken")
    C.mark_fixed("CASE-1", "EX-1")
    check("fixing it unblocks", C.compute(C.load("CASE-1"))["publishable"] is True)

    # ── R-03: open questions ─────────────────────────────────────────────
    q = C.ask("CASE-1", "Who signed the amendment?")
    s = C.compute(C.load("CASE-1"))
    check("an open question blocks publication",
          s["publishable"] is False and any(c == "R-03" for c, _ in s["blockers"]))
    throws("answering requires recording the actual answer",
           lambda: C.answered("CASE-1", q["id"], ""), "what the answer actually was")
    C.answered("CASE-1", q["id"], "The deputy director, per p.41")
    d = C.load("CASE-1")
    check("an answered question leaves the open list", len(d["questions_open"]) == 0)
    check("but is KEPT, with its answer", d["questions_answered"][0]["answer"].startswith("The deputy"))
    check("and the case unblocks", C.compute(d)["publishable"] is True)
    throws("answering a question that is not open is refused",
           lambda: C.answered("CASE-1", "Q-99", "x"), "no open question")

    # ── R-04: contradictions ─────────────────────────────────────────────
    x = C.conflict("CASE-1", "Filing says $2.1M, minutes say $1.4M")
    s = C.compute(C.load("CASE-1"))
    check("an open contradiction blocks publication",
          s["publishable"] is False and any(c == "R-04" for c, _ in s["blockers"]))
    throws("resolving requires recording HOW it resolved",
           lambda: C.resolve("CASE-1", x["id"], ""), "record HOW")
    C.resolve("CASE-1", x["id"], "Minutes were a draft; the filing controls")
    d = C.load("CASE-1")
    check("a resolved contradiction is kept, not deleted", len(d["contradictions"]) == 1)
    check("with its reasoning attached",
          "draft" in d["contradictions"][0]["resolution"])
    check("and the case unblocks", C.compute(d)["publishable"] is True)
    throws("resolving twice is refused",
           lambda: C.resolve("CASE-1", x["id"], "again"), "already resolved")

    # ── there is no --force ──────────────────────────────────────────────
    check("nothing in the module can force a blocked case publishable",
          not any(n in dir(C) for n in ("force_publish", "override", "publish_anyway")))

    # ── a corrupt case file surfaces as blocked, not as a crash ──────────
    Path(tmp, "BROKEN.json").write_text("{ not json")
    allc = C.load_all()
    broken = [c for c in allc if c["case_id"] == "BROKEN"]
    check("a corrupt case file still appears in the list", len(broken) == 1)
    check("as a case that cannot publish",
          C.compute(broken[0])["publishable"] is False)
    throws("and loading it directly refuses rather than resetting it",
           lambda: C.load("BROKEN"), "not valid JSON")
    check("the corrupt file is left untouched",
          Path(tmp, "BROKEN.json").read_text() == "{ not json")

    # ── case files are written owner-only ────────────────────────────────
    check("case files are mode 600",
          (Path(tmp, "CASE-1.json").stat().st_mode & 0o077) == 0,
          oct(Path(tmp, "CASE-1.json").stat().st_mode & 0o777))

    # ── the dashboard renders the same gate it is handed ─────────────────
    import dashboard as D
    importlib.reload(D)
    out = Path(tmp, "dash.html")
    D.build(str(out))
    htmltext = out.read_text()
    check("the dashboard renders the case", "CASE-1" in htmltext)
    check("and reports it publishable, agreeing with case.py",
          "PUBLISHABLE" in htmltext)
    check("the dashboard does not compute its own gate",
          "def _compute" not in Path(D.__file__).read_text())

    # HTML escaping: a case subject is operator-typed text.
    C.new_case("CASE-XSS", '<script>alert(1)</script>')
    D.build(str(out))
    htmltext = out.read_text()
    check("operator text is HTML-escaped, not injected",
          "<script>alert(1)</script>" not in htmltext
          and "&lt;script&gt;" in htmltext)

    print(f"\n  {'PASS' if FAIL == 0 else 'FAIL'} -- {PASS}/{PASS + FAIL} checks\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
