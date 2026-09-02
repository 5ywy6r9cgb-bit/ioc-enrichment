#!/usr/bin/env python3
"""
test_video_seam.py -- the door between the desk and the video engine.

Video is the least correctable thing this desk publishes to. A wrong number in
a document gets amended; a wrong number burned into 900 frames and posted is a
re-render, a delete, and a correction notice. So the tests here are all about
what the door REFUSES, not what it lets through.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sentinel_video.findings import load_deck  # noqa: E402

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"\n         {detail}" if detail else ""))


def deck(*findings, **over):
    d = {"project": "Test Case", "standard": "S", "motto": "M",
         "findings": list(findings)}
    d.update(over)
    return d


GREEN = {"id": "g1", "tier": "GREEN", "claim": "The contract commits $328,000.",
         "confidence": "high", "source": {"doc": "PO 483191", "page": "p.1"}}
RED = {"id": "r1", "tier": "RED_APPLE", "question": "Has the city produced Exhibit C?",
       "gate": "The signed Exhibit C.", "confidence": "medium"}
DEAD = {"id": "d1", "tier": "DEAD_END", "thread": "An Ohio/Delaware conflict.",
        "resolution": "Delaware is scoped to the safe-harbour clause only.",
        "confidence": "high"}


def errs(d):
    return load_deck(d)[1]


def warns(d):
    return load_deck(d)[2]


print("\nVIDEO SEAM\n")

# ── the happy path ────────────────────────────────────────────────────────
d, e, w = load_deck(deck(GREEN, RED, DEAD))
check("a well-formed deck passes", e == [], "; ".join(e))
check("and counts each screen tier",
      d["counts"] == {"DEAD_END": 1, "GREEN": 1, "RED_APPLE": 1}, str(d["counts"]))

# ── GREEN must carry a source ─────────────────────────────────────────────
no_src = dict(GREEN); no_src.pop("source")
e = errs(deck(no_src))
check("a GREEN with no source is refused", any("no source document" in x for x in e), str(e))
check("and the refusal explains why video is stricter",
      any("invisible" in x for x in e), str(e))
check("an empty source doc is also refused",
      errs(deck({**GREEN, "source": {"doc": ""}})) != [])

# ── RED_APPLE must read as a question and name its gate ───────────────────
e = errs(deck({**RED, "question": "The city has not produced Exhibit C."}))
check("a RED_APPLE written as a statement is refused",
      any("insinuation" in x for x in e), str(e))
e = errs(deck({k: v for k, v in RED.items() if k != "gate"}))
check("a RED_APPLE with no closing gate is refused",
      any("only repeated" in x for x in e), str(e))
e = errs(deck({**RED, "claim": "asserted"}))
check("a RED_APPLE carrying a 'claim' key is refused",
      any("presented as a claim" in x for x in e), str(e))

# ── DEAD_END must carry what closed it ────────────────────────────────────
e = errs(deck({k: v for k, v in DEAD.items() if k != "resolution"}))
check("a DEAD_END with no resolution is refused",
      any("unanswered allegation" in x for x in e), str(e))
check("a DEAD_END reads its text from 'thread', not 'claim'",
      errs(deck(DEAD)) == [])

# ── the three-tier rule ───────────────────────────────────────────────────
for internal in ["ARITH", "REPORTED", "VERIFY", "RED", "DEAD"]:
    e = errs(deck({**GREEN, "tier": internal}))
    check(f"internal tier {internal!r} never reaches the screen",
          any("not a screen tier" in x for x in e), str(e))

# ── deck-level ────────────────────────────────────────────────────────────
check("a deck with no project name is refused",
      any("title card would be blank" in x for x in errs(deck(GREEN, project=""))))
check("an empty deck is refused",
      any("pulled" in x for x in errs(deck())))
check("a non-dict payload is refused, not crashed on",
      errs(["not", "a", "deck"]) != [])
check("a missing findings list is refused",
      any("no 'findings' list" in x for x in errs({"project": "X"})))
check("duplicate ids are caught",
      any("duplicate id" in x for x in errs(deck(GREEN, dict(GREEN)))))
check("a finding that is not an object is caught",
      any("not an object" in x for x in errs(deck("just a string"))))
check("an unknown confidence value is refused",
      errs(deck({**GREEN, "confidence": "pretty sure"})) != [])

# ── warnings are not refusals ─────────────────────────────────────────────
w = warns(deck(RED, DEAD))
check("a deck of only questions and dead ends WARNS rather than refuses",
      errs(deck(RED, DEAD)) == [] and any("entirely open questions" in x for x in w),
      str(w))
long_claim = {**GREEN, "claim": "x" * 300}
check("an over-long claim warns about legibility, and does not refuse",
      errs(deck(long_claim)) == [] and any("phone viewer" in x for x in warns(deck(long_claim))))
check("text too short to be a finding IS refused",
      errs(deck({**GREEN, "claim": "yes"})) != [])

# ── the deck comes back even when rejected ────────────────────────────────
d, e, _ = load_deck(deck(no_src))
check("a rejected deck is still returned, so a caller can show what failed",
      d.get("project") == "Test Case" and e != [])

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
