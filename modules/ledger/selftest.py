# -*- coding: utf-8 -*-
"""Self-test for the ledger module. Runs offline in a temporary directory; touches nothing of yours.
Prints passed / failed / skipped — a skipped check is never counted as a pass."""
import argparse
import contextlib
import copy
import io
import json
import os
import shutil
import stat
import tempfile
from decimal import Decimal

import lib_ledger as L

RESULTS = {"passed": 0, "failed": 0, "skipped": 0}


def ok(cond, label):
    RESULTS["passed" if cond else "failed"] += 1
    print(("PASS " if cond else "FAIL ") + label)


def quiet(fn, *a, **k):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
        try:
            rc = fn(*a, **k)
        except SystemExit as e:
            rc = e.code
    return rc, buf.getvalue()


def mini_ledger():
    V = {"glassmark": {"GREEN": "", "ARITH": "", "REPORTED": "", "RED": "", "DEAD END": ""},
         "evidence_class": {k: "" for k in ("PRIMARY_IN_CUSTODY", "PRIMARY_REVIEWED", "OFFICIAL_RECORD", "OFFICIAL_ATTRIBUTION",
                                            "SWORN_ALLEGATION", "REGISTER_ROW", "SECONDARY_REPORT", "DESK_NOTE", "ARITH")},
         "publication": {k: "" for k in ("PUBLISH_WITH_ATTRIBUTION", "PUBLISH_AFTER_VERIFY", "PUBLISH_AS_QUESTION", "HOLD", "CORRECTION", "INTERNAL")},
         "money_kinds": {k: "" for k in ("CONTRACT_SCHEDULE", "CONDUIT_FORWARDED", "IE_SUPPORT", "AWARD_VALUE", "ALLEGED_TRANSFER")},
         "figure_kinds": {k: "" for k in ("IE_SUPPORT", "UNRESOLVED", "SHARE")}, "level_ladder": {}, "lanes": {"FARA": {}, "FEC": {}}}

    def F(id, pub, tier="GREEN", cls="PRIMARY_IN_CUSTODY", level=4):
        return {"id": id, "lane": "FARA", "title": "Test " + id, "headline": "Test headline for " + id + ".",
                "statement": "A statement for " + id + ".", "glassmark": tier, "evidence_class": cls, "level": level,
                "publication": pub, "sources": ["SRC"], "entities": ["E:a", "E:b"], "figures": [], "does_not_show": ["That it was paid."],
                "ordinary_explanation": "Lawful and disclosed.", "adverse_explanation": "—", "discriminator": "The supplemental statement.",
                "dispute_log": [{"objection": "It is only a budget.", "answer": "Correct."}], "missing_records": ["RQ-1"],
                "public_interest": {}, "status": "OPEN", "custody": [], "proof_profile": {"numbers_verified": 1, "numbers_linked": 1}, "anchors": []}
    M = lambda id, amt, kind, fid, cls="REGISTER_ROW": {"id": id, "from": "E:a", "to": "E:b", "amount_usd": amt, "kind": kind,
                                                        "sources": ["SRC"], "evidence_class": cls, "findings": [fid], "is_floor": False,
                                                        "locator": "L-0000:1", "period": None, "caveat": None}
    return {
        "meta": {"title": "mini", "schema": "tsr.master/1", "as_of": "2026-09-26", "built": "2026-09-29"},
        "vocabularies": V,
        "sources": [{"id": "SRC", "title": "Test source", "kind": "filing", "status": "reviewed_online", "url": "https://example.org/doc.pdf"}],
        "entities": [{"id": "E:a", "name": "Alpha LLC", "type": "firm", "lanes": ["FARA"]}, {"id": "E:b", "name": "Beta Corp", "type": "company", "lanes": ["FARA"]}],
        "money_flows": [M("MF-1", 4500000, "CONTRACT_SCHEDULE", "F-A", "PRIMARY_IN_CUSTODY"), M("MF-2", 2738626, "CONDUIT_FORWARDED", "F-A"),
                        M("MF-3", 3409008, "AWARD_VALUE", "F-A"), M("MF-4", 10000000, "ALLEGED_TRANSFER", "F-A", "SWORN_ALLEGATION")],
        "figures": [{"id": "FIG-MULTI", "label": "multi-cycle total", "value": 103974317, "unit": "USD", "kind": "IE_SUPPORT",
                     "evidence_class": "REGISTER_ROW", "findings": ["CX-12"], "semantics": "MULTI-CYCLE. Never label as 2024.", "sources": ["SRC"]},
                    {"id": "FIG-HELD", "label": "unresolved column", "value": 1011135938, "unit": "USD", "kind": "UNRESOLVED",
                     "evidence_class": "DESK_NOTE", "findings": ["F-B"], "semantics": None, "sources": ["SRC"]},
                    {"id": "FIG-Q", "label": "share", "value": 0.2134, "unit": "share", "kind": "SHARE", "evidence_class": "ARITH",
                     "findings": ["F-Q"], "semantics": None, "sources": ["SRC"]}],
        "findings": [F("F-A", "PUBLISH_WITH_ATTRIBUTION"), F("F-B", "HOLD", "RED", "DESK_NOTE", 0), F("F-Q", "PUBLISH_AS_QUESTION", "RED", "REGISTER_ROW", 3)],
        "relationships": [], "claims": [], "corrections": [{"id": "CX-12", "status": "APPLIED"}],
        "records_queue": [{"id": "RQ-1", "priority": "P1", "question": "Get the supplemental.", "action_type": "open_public_url", "status": "open"}],
        "coverage": [], "timeline": [], "verification": {"locators": {}, "quotes": [], "arithmetic": [], "errors": []},
        "metrics": {"counts": {}, "verification": {}},
    }


def t_numbers():
    ns = L.parse_numbers("It lists $31.5 million, 21.3%, about 384× and $604,861 — in 2024, row 7.")
    got = [(n["kind"], str(n["value"])) for n in ns]
    ok(("money", "31500000.0") in got or ("money", "31500000") in [(k, v.rstrip("0").rstrip(".") if "." in v else v) for k, v in got],
       "parse: '$31.5 million' → 31,500,000")
    ok(any(k == "share" and Decimal(v) == Decimal("0.213") for k, v in got), "parse: '21.3%' → 0.213")
    ok(any(k == "multiple" and Decimal(v) == 384 for k, v in got), "parse: '384×' → multiple")
    ok(any(k == "money" and Decimal(v) == 604861 for k, v in got), "parse: '$604,861'")
    ok(not any(Decimal(v) == 2024 for _, v in got), "parse: a bare year is not a number to gate")


def t_gate():
    import gate
    lg = mini_ledger()
    cases = [
        ("Alpha LLC's June schedule lists $4.5 million a month for digital advertising.", "MATCH", None),
        ("A separate $4.5 million buy ran in Ohio.", "MATCH", "CONTEXT_UNCONFIRMED"),
        ("The firm was paid $4.5 million.", "MATCH", "SCHEDULE_IS_NOT_PAYMENT"),
        ("The PAC donated $2,738,626 to candidates.", "MATCH", "FORWARDED_IS_NOT_GIVEN"),
        ("The agency paid Ntrepid $3,409,008.", "MATCH", "AWARD_IS_NOT_CASH"),
        ("RT sent $10 million to the company.", "MATCH", "ALLEGATION_MUST_SAY_SO"),
        ("UDP spent $103,974,317 supporting candidates in 2024.", "CORRECTION_ONLY", "MULTI_CYCLE_NOT_2024"),
        ("Handle was $1,011,135,938.", "HELD", "FIGURE_NOT_USABLE"),
        ("A new figure of $999,999 appeared.", "UNMATCHED", "NOT_IN_LEDGER"),
        ("The transfer was 21.3% of its receipts.", "QUESTION_ONLY", "MUST_BE_A_QUESTION"),
    ]
    for text, status, flag in cases:
        res, clean = gate.run(text, lg)
        r = res[0] if res else {}
        codes = [c for c, _ in r.get("flags", [])]
        good = r.get("status") == status and ((flag is None and not codes) or (flag in codes))
        ok(good, "gate: {} → {}{}".format(text[:48], status, " + " + flag if flag else " (clean)"))
    res, clean = gate.run("Alpha LLC's June schedule lists $4.5 million a month.", lg)
    ok(clean, "gate: a draft with only cleared, correctly described numbers is CLEAN")


def t_card():
    import card
    lg = mini_ledger()
    c = card.build(lg, "F-B")
    ok("refusal" in c and "RQ-1" in c["refusal"], "card: a HOLD finding is refused, with what would release it")
    c = card.build(lg, "F-Q")
    ok("question_form" in c and c["question_form"].startswith("Open question"), "card: PUBLISH_AS_QUESTION prints as a question")
    c = card.build(lg, "F-A")
    ok("refusal" not in c and c["attribution"][0]["url"], "card: a cleared finding prints wording plus attribution")


def t_check():
    import check
    lg = mini_ledger()
    errs, _ = check.run(lg, forbidden_path="/nonexistent")
    ok(not errs, "check: the mini ledger is clean")
    bad = copy.deepcopy(lg)
    bad["findings"][1]["publication"] = "PUBLISH_WITH_ATTRIBUTION"
    errs, _ = check.run(bad, forbidden_path="/nonexistent")
    ok(any("RED" in e for e in errs), "check: a RED finding published as a statement is an error")
    bad = copy.deepcopy(lg)
    bad["findings"][0]["level"] = 5
    bad["findings"][0]["evidence_class"] = "REGISTER_ROW"
    errs, _ = check.run(bad, forbidden_path="/nonexistent")
    ok(any("level 5" in e for e in errs), "check: a register join cannot claim level 5 (direction)")
    tmp = tempfile.mkdtemp()
    fp = os.path.join(tmp, "forbidden.txt")
    open(fp, "w").write("# private\nBeta Corp\n")
    errs, _ = check.run(lg, forbidden_path=fp)
    ok(any("private list line 2" in e for e in errs) and not any("Beta Corp" in e for e in errs),
       "check: private-list hit reported by line number, string never printed")
    shutil.rmtree(tmp)


def t_chain_and_seal():
    import chain
    tmp = tempfile.mkdtemp()
    os.environ["SENTINEL_LEDGER_DIR"] = tmp
    os.environ["SENTINEL_SEAL_KEY"] = os.path.join(tmp, "keys", "seal.key")
    lp = os.path.join(tmp, "l1.json")
    lg = mini_ledger()
    json.dump(lg, open(lp, "w"))
    ns = argparse.Namespace(ledger=lp, note="first", force=True, dir=tmp, anchor=None)
    rc, _ = quiet(chain.append, ns)
    lg2 = copy.deepcopy(lg)
    lg2["findings"][0]["publication"] = "PUBLISH_AFTER_VERIFY"
    lp2 = os.path.join(tmp, "l2.json")
    json.dump(lg2, open(lp2, "w"))
    rc2, _ = quiet(chain.append, argparse.Namespace(ledger=lp2, note="second", force=True, dir=tmp, anchor=None))
    rc3, out = quiet(chain.verify, argparse.Namespace(dir=tmp, anchor=None))
    ok(rc == 0 and rc2 == 0 and rc3 == 0 and "2 entries" in out, "chain: two versions appended and verified")
    cpath = os.path.join(tmp, "chain.jsonl")
    lines = open(cpath).read().splitlines()
    head = json.loads(lines[-1])["entry_sha256"]
    rc, out = quiet(chain.verify, argparse.Namespace(dir=tmp, anchor=head))
    ok(rc == 0, "chain: the head anchor is found")
    tampered = lines[0].replace('"note":"first"', '"note":"edited"')
    open(cpath, "w").write("\n".join([tampered] + lines[1:]) + "\n")
    rc, out = quiet(chain.verify, argparse.Namespace(dir=tmp, anchor=None))
    ok(rc == 1 and "changed after it was written" in out, "chain: an edited entry is detected")
    open(cpath, "w").write(lines[0] + "\n")
    rc, out = quiet(chain.verify, argparse.Namespace(dir=tmp, anchor=head))
    ok(rc == 1 and "truncated" in out, "chain: a deleted tail is caught by the outside anchor")
    open(cpath, "w").write("\n".join(lines) + "\n")
    rc, out = quiet(chain.keygen, None)
    kp = os.environ["SENTINEL_SEAL_KEY"]
    mode = stat.S_IMODE(os.stat(kp).st_mode)
    key_hex = open(kp).read().strip()
    ok(rc == 0 and mode == 0o600 and key_hex not in out, "seal: key created owner-only and never printed")
    rc, out = quiet(chain.keygen, None)
    ok(rc != 0, "seal: refuses to overwrite an existing key")
    rc, _ = quiet(chain.sign, argparse.Namespace(dir=tmp))
    rc2, out = quiet(chain.seal_verify, argparse.Namespace(dir=tmp))
    ok(rc == 0 and rc2 == 0 and "VALID" in out, "seal: chain head sealed and verified")
    spath = os.path.join(tmp, "seals.jsonl")
    s = json.loads(open(spath).read().splitlines()[0])
    s["mac"] = ("0" if s["mac"][0] != "0" else "1") + s["mac"][1:]
    open(spath, "w").write(json.dumps(s) + "\n")
    rc, out = quiet(chain.seal_verify, argparse.Namespace(dir=tmp))
    ok(rc == 1 and "INVALID" in out, "seal: a forged seal is rejected")
    shutil.rmtree(tmp)
    del os.environ["SENTINEL_LEDGER_DIR"], os.environ["SENTINEL_SEAL_KEY"]


def t_diff():
    import diff
    a = mini_ledger()
    b = copy.deepcopy(a)
    b["findings"][0]["publication"] = "PUBLISH_AFTER_VERIFY"
    b["findings"].append(dict(b["findings"][0], id="F-NEW"))
    d = diff.compare(a, b)
    ok("F-NEW" in d["findings"]["added"] and any(k == "F-A" for k, _ in d["findings"]["changed"]),
       "diff: added finding and changed publication are reported")


def t_onchain():
    import onchain
    tmp = tempfile.mkdtemp()
    Z = "0x0000000000000000000000000000000000000000"
    DEP, POOL, FLAG = "0x" + "d1" * 20, "0x" + "a1" * 20, "0x" + "f1" * 20
    rows = [("0xmint", 1, "2026-01-01 00:00:00", Z, DEP, "1000000")]
    rows.append(("0xseed", 2, "2026-01-01 00:10:00", DEP, POOL, "600000"))
    for i in range(25):
        rows.append(("0xair%02d" % i, 3, "2026-01-01 00:20:00", DEP, "0x%040x" % (1000 + i), "1000"))
    for i in range(30):
        rows.append(("0xbuy%02d" % i, 4, "2026-01-01 01:00:00", POOL, "0x%040x" % (5000 + i), "500"))
    rows.append(("0xpull", 5, "2026-01-01 02:00:00", POOL, DEP, "580000"))
    rows.append(("0xflag", 6, "2026-01-01 03:00:00", DEP, FLAG, "123.456789012345678"))
    p = os.path.join(tmp, "export.csv")
    with open(p, "w") as fh:
        fh.write('"Transaction Hash","Blockno","DateTime (UTC)","From","To","TokenValue","TokenSymbol"\n')
        for r in rows:
            fh.write('"{}","{}","{}","{}","{}","{}","TST"\n'.format(*r))
    lab = os.path.join(tmp, "labels.csv")
    open(lab, "w").write("address,label,source\n{},test pool,self-test\n".format(POOL))
    fl = os.path.join(tmp, "flagged.csv")
    open(fl, "w").write("{},test flag,self-test\n".format(FLAG))
    out = os.path.join(tmp, "out")
    rs, sigs, sha, cmap = onchain.run(p, "ethereum", lab, fl, out, 24, 20)
    names = {s["signal"] for s in sigs}
    ok(len(rs) == len(rows), "onchain: every CSV row normalized")
    ok(any(r["amount"] == "123.456789012345678" for r in rs), "onchain: amounts kept as exact decimals (18 places)")
    ok("POOL_DRAIN" in names, "onchain: pool drain signalled")
    ok("FRESH_MINT_FANOUT" in names, "onchain: mint fan-out signalled")
    ok("FLAGGED_COUNTERPARTY" in names, "onchain: flagged counterparty signalled")
    ok(all(s["status"].startswith("SIGNAL") and s["ordinary_explanations"] for s in sigs),
       "onchain: every signal says it is not a finding and carries the ordinary explanation")
    ok(os.path.exists(os.path.join(out, "money_flows_onchain.json")), "onchain: ledger-compatible rows written")
    shutil.rmtree(tmp)


def t_verify_plan():
    import verify_sources
    lg = mini_ledger()
    ts = verify_sources.targets(lg)
    ok(len(ts) == 1 and ts[0]["id"] == "SRC", "verify-sources: plan lists cited URLs without touching the network")
    d = verify_sources.robots_decision
    ok(d(200) == "PARSE" and d(404) == "ALLOW" and d(403) == "DISALLOW" and d(503) == "UNKNOWN" and d(error=OSError()) == "UNKNOWN",
       "verify-sources: robots.txt answers read politely (unreachable means do not fetch)")


def reasoning_ledger():
    lg = mini_ledger()
    lg["entities"] += [{"id": "E:c", "name": "Gamma Agency", "type": "government", "lanes": ["FARA"]},
                       {"id": "E:d", "name": "Delta Network", "type": "operation", "lanes": ["FARA"]},
                       {"id": "E:p", "name": "Paula Private", "type": "person", "lanes": ["FEC"], "public_figure_or_org": False}]
    lg["relationships"] = [
        {"id": "R-1", "from": "E:a", "to": "E:b", "type": "REGISTERED_AGENT_FOR", "rel_class": "REPRESENTATION", "rung": 4, "level": 4,
         "alleged": False, "evidence_class": "REGISTER_ROW", "findings": ["F-A"]},
        {"id": "R-2", "from": "E:c", "to": "E:d", "type": "DIRECTED_PER_AFFIDAVIT", "rel_class": "DIRECTION", "rung": 4, "level": 5,
         "alleged": True, "evidence_class": "SWORN_ALLEGATION", "findings": ["F-A"]}]
    lg["vocabularies"]["say"] = {"REPRESENTATION": "registered as agent for (per the filing)"}
    lg["vocabularies"]["causal_ladder"] = [["C%d" % i, n, ""] for i, n in enumerate(
        ["OBSERVED", "TEMPORAL", "ASSOCIATED", "PLAUSIBLE MECHANISM", "DOCUMENTED INTERACTION", "ALTERNATIVES TESTED", "CONTRIBUTORY", "DIRECT"])]
    lg["money_flows"].append({"id": "MF-9", "from": "E:b", "to": "E:p", "amount_usd": 1000, "kind": "OPERATING_DISBURSEMENT", "sources": ["SRC"],
                              "evidence_class": "REGISTER_ROW", "findings": ["F-A"], "is_floor": False, "locator": "L-0000:2"})
    lg["timeline"] = [{"id": "EV-1", "date": "2026-06-07", "event": "Schedule filed", "findings": ["F-A"]},
                      {"id": "EV-2", "date": "2026-05-01", "event": "Earlier event", "findings": []}]
    return lg


def t_epistemic():
    import epistemic
    lg = reasoning_ledger()
    run = lambda t: [(i["code"], i["status"]) for i in epistemic.check(t, lg)]
    ok(("RELATIONSHIP_TO_COORDINATION", "FAIL") in run("Alpha LLC coordinated with Beta Corp on the campaign."),
       "epistemic: a registration (REPRESENTATION, C4) does not support 'coordinated'")
    ok(run("Alpha LLC is registered as agent for Beta Corp, according to its filing.") == [],
       "epistemic: saying what the record shows is clean")
    ok(("ALLEGATION_TO_FACT", "FAIL") in run("Gamma Agency directed Delta Network."),
       "epistemic: a sworn allegation stated as fact fails")
    ok(run("According to the affidavit, Gamma Agency directed Delta Network.") == [],
       "epistemic: the same allegation, attributed, is clean")
    ok(("ACCESS_TO_INFLUENCE", "FAIL") in run("Alpha LLC influenced Beta Corp."), "epistemic: access → influence needs C6")
    ok(("ABSENCE_TO_NONEXISTENCE", "FAIL") in run("No records exist of the payments."), "epistemic: absence of a search result is not nonexistence")
    ok(run("We found no payments in the filings reviewed as of 26 September 2026.") == [], "epistemic: a scoped search result is clean")
    ok(("SECRECY_TO_WRONGDOING", "FAIL") in run("The money was secretly routed."), "epistemic: 'secretly' without attribution fails")
    ok(("RARITY_TO_REALITY", "FAIL") in run("It is the largest schedule ever."), "epistemic: rarity in the corpus is not rarity in the world")
    ok(("SEQUENCE_TO_CAUSATION", "WARN") in run("The vote came in response to the ads."), "epistemic: an unanchored causal verb is flagged")


def t_trace_and_why():
    import moneytrace as trace
    import why
    lg = reasoning_ledger()
    t = trace.trace(lg, "E:a", "down", None, 2)
    kinds = set(e["kind"] for e in t["edges"])
    ok({"CONTRACT_SCHEDULE", "CONDUIT_FORWARDED", "AWARD_VALUE", "ALLEGED_TRANSFER"} <= kinds and
       all(e["sum_usd_within_kind"] is None or e["kind"] in kinds for e in t["edges"]), "trace: each kind of money is its own edge; nothing added across kinds")
    ok(any(e["to_name"] == "(private party, not named)" for e in t["edges"]), "trace: a private party is never named")
    ok(any("absence is not concealment" in s["why"] for s in t["stops"]), "trace: a branch that stops says why")
    sc = why.screen(lg, "F-A")
    ok(sc["before"] and sc["before"][0]["id"] == "EV-2" and any(r["alleged"] for r in sc["relationships"]),
       "why: the screen shows what came before and marks alleged links")


def main():
    for t in (t_numbers, t_gate, t_card, t_check, t_chain_and_seal, t_diff, t_onchain, t_verify_plan, t_epistemic, t_trace_and_why):
        try:
            t()
        except Exception as e:           # a crash is a failure, never a skip
            RESULTS["failed"] += 1
            print("FAIL {} crashed: {}: {}".format(t.__name__, type(e).__name__, e))
    print("{passed} passed, {failed} failed, {skipped} skipped".format(**RESULTS))
    return 0 if RESULTS["failed"] == 0 else 1
