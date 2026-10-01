"""selftest.py - the route ledger proves itself on an invented ledger. No network."""
import csv
import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import routes  # noqa: E402

LEDGER = {
    "meta": {"schema": "tsr.master/1", "as_of": "2026-01-01"},
    "findings": [
        {"id": "F-A", "title": "Published and corroborated", "publication": "PUBLISH_WITH_ATTRIBUTION", "status": "CORROBORATED", "missing_records": []},
        {"id": "F-B", "title": "A question", "publication": "PUBLISH_AS_QUESTION", "status": "OPEN", "missing_records": ["RQ-1"]},
        {"id": "F-C", "title": "After verify", "publication": "PUBLISH_AFTER_VERIFY", "status": "OPEN", "missing_records": ["RQ-2", "RQ-3"],
         "proof_profile": {"numbers_failed": 1}},
    ],
    "money_flows": [
        {"id": "MF-ONE", "kind": "RECEIPT", "amount_usd": 1000, "period": "2025 Q1", "snapshot": "2026-01-01", "locator": "L-1:10", "evidence_class": "REGISTER_ROW", "findings": ["F-A", "F-B"]},
        {"id": "MF-TWO", "kind": "CONTRACT_SCHEDULE", "amount_usd": 5000, "period": "Apr 2026", "locator": "U-WB:Money!B2", "evidence_class": "PRIMARY_IN_CUSTODY", "findings": ["F-A"]},
        {"id": "MF-THREE", "kind": "ALLEGED_TRANSFER", "amount_usd": 700, "locator": "affidavit p. 3", "evidence_class": "SWORN_ALLEGATION", "findings": ["F-C"]},
        {"id": "MF-FOUR", "kind": "IE_OPPOSE", "amount_usd": 200, "snapshot": "2026-01-10", "locator": "L-1:20", "evidence_class": "REGISTER_ROW", "findings": ["F-C"], "from": "E:pac", "to": "E:cand"},
        {"id": "MF-FIVE", "kind": "RECEIPT", "amount_usd": 50, "locator": "P-NOTE", "evidence_class": "DESK_NOTE", "findings": ["F-C"]},
        {"id": "MF-SIX", "kind": "IE_SUPPORT", "amount_usd": 300, "snapshot": "2026-01-10", "locator": "L-1:21", "evidence_class": "REGISTER_ROW", "findings": ["F-C"], "from": "E:pac", "to": "E:cand2"},
        {"id": "MF-SEVEN", "kind": "IE_SUPPORT", "amount_usd": 999, "snapshot": "2026-01-10", "locator": "L-1:22", "evidence_class": "REGISTER_ROW", "findings": ["F-C"], "from": "E:pac", "to": "E:cand3"},
    ],
    "figures": [
        {"id": "FIG-SHARE", "kind": "SHARE", "value": 0.25, "locator": "ARITH", "evidence_class": "ARITH", "findings": ["F-A"]},
        {"id": "FIG-TOTAL", "kind": "RECEIPT_TOTAL", "value": 4000, "period": "2025", "snapshot": "2026-01-02", "locator": "L-2:5", "evidence_class": "REGISTER_ROW", "is_floor": True, "findings": ["F-A"]},
        {"id": "FIG-ODD", "kind": "UNRESOLVED", "value": 123, "locator": "P-NOTE", "evidence_class": "REGISTER_ROW", "findings": ["F-C"]},
    ],
    "relationships": [
        {"id": "R-1", "from": "E:a", "to": "E:b", "type": "DIRECTED", "evidence_class": "SWORN_ALLEGATION", "alleged": True, "findings": ["F-C"]},
        {"id": "R-2", "from": "E:a", "to": "E:c", "type": "KNOWS", "evidence_class": "SECONDARY_REPORT", "findings": ["F-C"]},
        {"id": "R-3", "from": "E:a", "to": "E:d", "type": "PAID", "evidence_class": "OFFICIAL_RECORD", "rung": 4, "period": "2025", "findings": ["F-A"]},
    ],
    "records_queue": [
        {"id": "RQ-1", "priority": "P1", "question": "What does the form say?", "status": "Not started", "action_type": "open_public_url", "record_target": "Form 1", "url": "https://example.gov/f1"},
        {"id": "RQ-2", "priority": "P2", "question": "Resolved already", "status": "Resolved 2026-01-05", "action_type": "open_public_url"},
        {"id": "RQ-3", "priority": "P2", "question": "Ask the firm", "status": "Needs authorization", "action_type": "voluntary_request", "record_target": "A reply"},
    ],
    "corrections": [
        {"id": "CX-1", "findings": ["F-C"], "status": "OPEN — needs a decision", "what_is_right": "Fix it"},
        {"id": "CX-2", "findings": ["F-A"], "status": "APPLIED IN LEDGER", "what_is_right": "Done"},
    ],
    "entities": [
        {"id": "E:pac", "name": "Example PAC", "identifiers": {"fec_committee_id": "C00000001"}},
        {"id": "E:cand", "name": "Jane Roe"}, {"id": "E:cand2", "name": "John Doe"}, {"id": "E:cand3", "name": "Ann Poe"},
    ],
    "verification": {
        "locators": {"MF-FOUR": {"status": "FAIL"}, "MF-ONE": {"status": "PASS"}},
        "arithmetic": [
            {"id": "A1", "label": "one over total", "formula": "MF-ONE ÷ FIG-TOTAL", "computed": 0.25, "status": "PASS", "figures": ["FIG-SHARE"]},
            {"id": "A2", "label": "a sum", "formula": "Σ MF-ONE + MF-TWO", "computed": 6000, "status": "PASS", "figures": []},
        ],
    },
}

PASS = {
    "schema": "tsr.supplement/1", "id": "SP-TEST", "title": "test pass", "prepared": "2026-01-03",
    "items": [
        {"id": "SP-X1", "rq": ["RQ-1"], "findings": ["F-B", "F-A"], "title": "answer",
         "facts": [{"id": "SP-X1-a", "state": "IS", "text": "The form names it."},
                   {"id": "SP-X1-b", "state": "OPEN", "text": "One more record.", "settle_by": "The next report."}],
         "contests": [{"row": "MF-ONE", "why": "the record says 900"}],
         "confirms": [{"row": "FIG-TOTAL", "ledger_value": 4000, "record_value": 4000.2, "why": "summary agrees"}],
         "resolves": [{"row": "FIG-ODD", "reading": "January only"}],
         "answered": [{"finding": "F-B", "question": "What does the form say?", "answer": "It names it.", "fully": False}],
         "adds": [{"id": "FIG-NEW", "table": "figure", "kind": "SHARE", "value": 0.2, "state": "IS", "findings": ["F-A"],
                   "source": "X-TEST", "locator": "ARITH", "numerator": "MF-ONE", "denominator": "FIG-TOTAL", "label": "new share"}],
         "proposed": {"F-B": "Answer it."}},
    ],
    "corrections_proposed": [{"id": "CX-9", "findings": ["F-A"], "what_is_right": "Use the new share."}],
}

NOTICES = [
    # spe_id, spe_nam, cand_name, sup_opp, exp_amo, dissem_dt, exp_date, file_num, tran_id
    ("C00000001", "EXAMPLE PAC", "ROE, JANE", "O", "100", "05-JAN-26", "", "1", "T1"),
    ("C00000001", "EXAMPLE PAC", "DOE, JOHN", "S", "150", "05-JAN-26", "", "1", "T2"),
    ("C00000001", "EXAMPLE PAC", "DOE, JOHN", "S", "150", "06-JAN-26", "", "1", "T3"),
    ("C00000001", "EXAMPLE PAC", "ROE, JANE", "O", "40", "20-JAN-26", "", "1", "T4"),
    ("C00000001", "EXAMPLE PAC", "ROE, JANE", "O", "100", "05-JAN-26", "", "2", "T1"),
]


class T(object):
    def __init__(self):
        self.n, self.fail = 0, []

    def ok(self, cond, label):
        self.n += 1
        if not cond:
            self.fail.append(label)


def route(R, row, finding=None):
    for x in R["routes"]:
        if x["row"] == row and (finding is None or x["finding"] == finding):
            return x
    return None


def to_sqlite(L, path):
    db = sqlite3.connect(path)
    for t in ("findings", "money_flows", "figures", "relationships", "records_queue", "corrections", "entities"):
        rows = L[t]
        cols = sorted({k for r in rows for k in r})
        db.execute('create table "%s" (%s)' % (t, ", ".join('"%s"' % c for c in cols)))
        for r in rows:
            vals = []
            for c in cols:
                v = r.get(c)
                if isinstance(v, list):
                    v = "; ".join(v)
                elif isinstance(v, dict):
                    v = json.dumps(v)
                elif isinstance(v, bool):
                    v = int(v)
                vals.append(v)
            db.execute('insert into "%s" values (%s)' % (t, ",".join("?" * len(cols))), vals)
    db.execute("create table verify_locators (id, status)")
    for k, v in L["verification"]["locators"].items():
        db.execute("insert into verify_locators values (?,?)", (k, v["status"]))
    db.execute("create table verify_arithmetic (id, label, formula, computed, status, figures)")
    for a in L["verification"]["arithmetic"]:
        db.execute("insert into verify_arithmetic values (?,?,?,?,?,?)", (a["id"], a["label"], a["formula"], a["computed"], a["status"], "; ".join(a["figures"])))
    db.commit()
    db.close()


def main():
    t = T()
    base = tempfile.mkdtemp(prefix="routes-selftest-")
    try:
        lp = os.path.join(base, "ledger.json")
        pp = os.path.join(base, "sp-test.json")
        json.dump(LEDGER, open(lp, "w"))
        json.dump(PASS, open(pp, "w"))
        before = routes.sha256_file(lp)
        L = routes.load_ledger(lp)
        P = routes.load_passes([pp])
        R = routes.build(L, P, before)
        st = lambda r, f=None: (route(R, r, f) or {}).get("state")
        t.ok(st("MF-TWO") == "IS" and "not a payment" in (route(R, "MF-TWO")["trap"] or ""), "a schedule is IS, never a payment")
        t.ok(st("MF-THREE") == "OPEN" and "allegation" in route(R, "MF-THREE")["trap"], "an alleged transfer is OPEN")
        t.ok(st("MF-FOUR") == "OPEN" and "locator" in route(R, "MF-FOUR")["reason"], "a number not found at its locator is OPEN")
        t.ok(st("MF-FIVE") == "OPEN" and "lead" in route(R, "MF-FIVE")["reason"], "a desk note is a lead, OPEN")
        t.ok(st("FIG-SHARE") == "WAS", "a derived share is WAS")
        t.ok(st("FIG-ODD") == "IS" and "January only" in route(R, "FIG-ODD")["reason"], "a pass can resolve an unresolved figure")
        t.ok(st("MF-ONE", "F-A") == "OPEN" and "contested" in route(R, "MF-ONE", "F-A")["reason"], "a contested row is OPEN")
        t.ok(st("MF-ONE", "F-B") == "OPEN", "a contest follows the row into every finding")
        t.ok(st("FIG-TOTAL") == "WAS" and "agrees" in route(R, "FIG-TOTAL")["reason"] and "floor" in route(R, "FIG-TOTAL")["trap"], "a confirmed floor keeps its warning")
        t.ok(st("R-1") == "OPEN" and st("R-2") == "OPEN" and st("R-3") == "WAS", "relationships: alleged and secondary are OPEN, documented is WAS")
        new = route(R, "FIG-NEW")
        t.ok(new and new["proposed"] and new["state"] == "IS", "a pass's new row is carried as proposed")
        t.ok(R["counts"]["IS"] + R["counts"]["WAS"] + R["counts"]["OPEN"] == sum(1 for x in R["routes"] if not x["proposed"]), "proposed rows are kept out of the counts")
        a1 = [d for d in R["denominators"] if d["id"] == "A1"][0]
        t.ok(a1["numerator"] == ["MF-ONE"] and a1["denominator"] == ["FIG-TOTAL"], "divisions are parsed")
        t.ok(any("CONTESTED MF-ONE" in f for f in a1["flags"]) and any("FLOOR DENOMINATOR" in f for f in a1["flags"]), "division flags: contested input and floor denominator")
        t.ok(not [d for d in R["denominators"] if d["id"] == "A2"], "sums are not divisions")
        t.ok(any(d["id"] == "FIG-NEW" and "PROPOSED" in d["status"] for d in R["denominators"]), "a proposed share is listed with its inputs")
        lad = R["ladder"]
        t.ok(lad["F-A"]["rung"] == 4 and lad["F-B"]["rung"] == 1 and lad["F-C"]["rung"] == 2, "rungs follow publication and corroboration")
        t.ok(lad["F-B"]["answered"] and lad["F-B"]["answered"][0]["answer"] == "It names it.", "answered questions are listed")
        t.ok(any(n["record"] == "RQ-1" and n["action"] == "review" for n in lad["F-B"]["next"]) and not any("RQ-1" in b for b in lad["F-B"]["blockers"]), "a record worked by a pass is a review step, not a blocker")
        t.ok(any("CX-1" in b for b in lad["F-C"]["blockers"]) and not any("CX-2" in b for b in lad["F-A"]["blockers"]), "open corrections block; applied ones do not")
        t.ok(any("failed verification" in b for b in lad["F-C"]["blockers"]), "failed numbers block")
        t.ok(any(n["record"] == "RQ-3" and n["authorization"] for n in lad["F-C"]["next"]), "requests that contact someone are marked as needing authorization")
        t.ok(not any("RQ-2" in b for b in lad["F-C"]["blockers"]), "resolved records do not block")
        t.ok(any(b.startswith("proposed correction CX-9") for b in lad["F-A"]["blockers"]), "a pass's proposed correction shows on the ladder")
        opens = {o["id"]: o for o in R["open"]}
        t.ok("RQ-1" in opens and opens["RQ-1"]["worked_in"] and "SP-X1-b" in opens and opens["SP-X1-b"]["settle_by"], "open list: records with who worked them, pass gaps with what settles them")
        R2 = routes.build(routes.load_ledger(lp), routes.load_passes([pp]), before)
        t.ok(R2["digest"] == R["digest"], "the build is deterministic")
        P2 = json.loads(json.dumps(PASS))
        P2["items"][0]["contests"] = []
        json.dump(P2, open(os.path.join(base, "sp-test2.json"), "w"))
        R3 = routes.build(routes.load_ledger(lp), routes.load_passes([os.path.join(base, "sp-test2.json")]), before)
        t.ok(R3["digest"] != R["digest"] and (route(R3, "MF-ONE", "F-A") or {}).get("state") == "WAS", "changing a pass changes the digest and the state")
        sp = os.path.join(base, "ledger.sqlite")
        to_sqlite(LEDGER, sp)
        RS = routes.build(routes.load_ledger(sp), routes.load_passes([pp]), None)
        same = all((route(RS, x["row"], x["finding"]) or {}).get("state") == x["state"] for x in R["routes"])
        t.ok(same, "the SQLite export gives the same states as the JSON ledger")
        # ie audit
        np_ = os.path.join(base, "notices.csv")
        with open(np_, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["spe_id", "spe_nam", "cand_name", "sup_opp", "exp_amo", "dissem_dt", "exp_date", "file_num", "tran_id"])
            for r in NOTICES:
                w.writerow(r)
        au = {a["row"]: a for a in routes.ie_audit(L, np_)}
        t.ok(au["MF-FOUR"]["class"] == "DOUBLED" and au["MF-FOUR"]["notices_to_snapshot"] == 100, "the audit finds a doubled row, amendments counted once, later notices ignored")
        t.ok(au["MF-SIX"]["class"] == "MATCHES", "the audit finds a matching row")
        t.ok(au["MF-SEVEN"]["class"] == "NO NOTICES", "the audit says when there is nothing to compare")
        # the cli
        root = os.path.join(base, "repo")
        os.makedirs(os.path.join(root, "evidence", "ledger", "passes"))
        shutil.copy(lp, os.path.join(root, "evidence", "ledger", "current.json"))
        shutil.copy(pp, os.path.join(root, "evidence", "ledger", "passes", "sp-test.json"))
        run = lambda *a: subprocess.run([sys.executable, os.path.join(HERE, "routes.py"), "--root", root] + list(a),
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        p = run("build")
        t.ok(p.returncode == 0 and os.path.isfile(os.path.join(root, "evidence", "ledger", "routes.json"))
             and os.path.isfile(os.path.join(root, "evidence", "ledger", "routes.csv")), "build writes routes.json and routes.csv")
        t.ok(run("verify").returncode == 0, "verify: SAME right after a build")
        json.dump(P2, open(os.path.join(root, "evidence", "ledger", "passes", "sp-test.json"), "w"))
        p = run("verify")
        t.ok(p.returncode == 1 and "DIFFERENT" in p.stdout, "verify notices a changed pass")
        for cmd in (("finding", "F-A"), ("row", "MF-ONE"), ("denominators",), ("open",), ("ladder",), ("pass",)):
            p = run(*cmd)
            t.ok(p.returncode == 0 and p.stdout.strip(), "cli: %s prints" % " ".join(cmd))
        t.ok(run("finding", "F-NOPE").returncode == 2, "an unknown finding is an error")
        t.ok(routes.sha256_file(lp) == before, "the ledger is never written")
    except Exception as e:
        import traceback
        t.fail.append("crashed: %s\n%s" % (e, traceback.format_exc()))
    finally:
        shutil.rmtree(base, ignore_errors=True)
    if t.fail:
        print("routes selftest: %d/%d passed" % (t.n - len([f for f in t.fail if not f.startswith("crashed")]), t.n))
        for f in t.fail:
            print("  FAIL " + f)
        return 1
    print("routes selftest: %d/%d passed" % (t.n, t.n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
