#!/usr/bin/env python3
"""verify_cards.py — arithmetic gate for ep04. Reads docs/EVIDENCE_CARDS.json (copied to data/), recomputes every sum and share
the episode puts on screen, and exits 1 if any disagrees. This checks the cards' ARITHMETIC. It does NOT re-check the FEC:
before posting, open each card's `verify` URL (the desk rule: verify every figure against the register before it goes on screen)."""
import json, sys, pathlib
here = pathlib.Path(__file__).parent
cards = {c["id"]: c for c in json.load(open(here / "data" / "EVIDENCE_CARDS.json"))["cards"]}
bad = []; rows = []
def chk(name, got, want, tol=0.5):
    ok = abs(got - want) <= tol; rows.append((ok, name, got, want))
    if not ok: bad.append(name)
# OH-FLYER-01: against + for = total
chk("OH-FLYER-01  3,342,670 + 1,117,199 = 4,459,869", 3342670 + 1117199, 4459869)
# TEAM-HUSTED-01: five recipients = 8,253,532; campaign share 63.2%; Flyer share 7.3%
five = [5215998, 1129393, 824033, 604861, 479247]
chk("TEAM-HUSTED-01  five recipients sum to 8,253,532", sum(five), 8253532)
chk("TEAM-HUSTED-01  5,215,998 / 8,253,532 = 63.2%", round(5215998 / 8253532 * 100, 1), 63.2, 0.05)
chk("TEAM-HUSTED-01  604,861 / 8,253,532 = 7.3%", round(604861 / 8253532 * 100, 1), 7.3, 0.05)
# HV-01: 2,755,532 / 3,636,779 = 75.8%
chk("HV-01  2,755,532 / 3,636,779 = 75.8%", round(2755532 / 3636779 * 100, 1), 75.8, 0.05)
# BROWN-01: six committees = 13,471,230 within $1
six = [4888349, 4508418, 3342670, 648371, 73419, 10002]
chk("BROWN-01  six committees sum to 13,471,230 (within $1)", sum(six), 13471230, 1.0)
# PAYEE-01: Flyer's against-Brown vendors = same $3,342,670 as OH-FLYER-01; all three = 4,459,869
chk("PAYEE-01  3,244,873 + 97,797 = 3,342,670 (the against-Brown total)", 3244873 + 97797, 3342670)
chk("PAYEE-01  + 1,117,199 = 4,459,869", 3244873 + 97797 + 1117199, 4459869)
# DELEG-01 DENOMINATOR GUARD. The card's headline puts "$47.4 million raised" next to "39.5% from PACs", but its own caveat says the 39.5%
# is measured against CONTRIBUTIONS, not receipts. 14,582,896 / 47,405,708 is 30.8%, so the two figures do NOT share a denominator.
# This episode therefore shows 39.5% as "of contributions" and never prints the $47.4M next to it.
chk("DELEG-01  guard: PAC dollars / total receipts is 30.8%, NOT 39.5% (different denominators; screen says 'of contributions')", round(14582896 / 47405708 * 100, 1), 30.8, 0.05)
# WS-01: 98,905 / 395 is about 250
chk("WS-01  98,905 / 395 = 250 (rounded)", round(98905 / 395), 250, 0.5)
# status gate: anything not GREEN, or RETRACTED, must not be on screen
used = ["DELEG-01", "BROWN-01", "OH-FLYER-01", "TEAM-HUSTED-01", "HV-01", "WS-01", "METHOD-02"]
for u in used:
    ok = cards[u]["status"] == "GREEN"; rows.append((ok, f"{u} status is GREEN", cards[u]["status"], "GREEN"))
    if not ok: bad.append(u + " status")
for ok, n, g, w in rows: print(("  ok   " if ok else "  FAIL ") + n + ("" if ok else f"   (got {g}, card says {w})"))
json.dump({"checked": len(rows), "failed": bad, "cards_file": "docs/EVIDENCE_CARDS.json generated " + json.load(open(here / "data" / "EVIDENCE_CARDS.json"))["generated"]}, open(here / "data" / "arith_check.json", "w"), indent=1)
print(f"\n{len(rows) - len(bad)} of {len(rows)} checks pass." + ("" if not bad else "  STOP: do not render."))
sys.exit(1 if bad else 0)
