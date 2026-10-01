# -*- coding: utf-8 -*-
"""Offline self-test for the station. Builds a small synthetic ledger into a temp folder and proves:
held findings never ship, private names never ship, the firewall text never ships, the gate refuses a
promoting verb, the never-print list stops a build, the manifest catches a changed byte, and a signed
build verifies (and fails when tampered)."""
import copy
import json
import os
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import station as S  # noqa: E402

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))


def mini():
    lad = [["C0", "OBSERVED", "x"], ["C1", "TEMPORAL", "x"], ["C2", "ASSOCIATED", "x"], ["C3", "PLAUSIBLE MECHANISM", "x"],
           ["C4", "DOCUMENTED INTERACTION", "x"], ["C5", "ALTERNATIVES TESTED", "x"], ["C6", "CONTRIBUTORY CAUSATION", "x"], ["C7", "DIRECT CAUSATION", "x"]]
    V = {"glassmark": {"GREEN": "primary", "RED": "open"}, "evidence_class": {"PRIMARY_IN_CUSTODY": "held", "REGISTER_ROW": "row", "DESK_NOTE": "note"},
         "publication": {"PUBLISH_WITH_ATTRIBUTION": "", "PUBLISH_AS_QUESTION": "", "HOLD": "", "PUBLISH_AFTER_VERIFY": "", "INTERNAL": ""},
         "level_ladder": {"0": "coincidence", "4": "contractual"}, "money_kinds": {"CONTRACT_SCHEDULE": "Scheduled fee. Not a payment."},
         "figure_kinds": {}, "lanes": {"FARA": {"name": "Foreign agents registry"}}, "relationship_classes": {"REPRESENTATION": "B represented A."},
         "causal_ladder": lad, "epistemic_rule": {"may": [], "must": [], "never_silently_promote": [["SEQUENCE_TO_CAUSATION", "sequence → causation"]]},
         "competing_models": [["M1", "Chain", "A → B"]], "say": {"REPRESENTATION": "registered as agent for"}}

    def F(fid, pub, statement, ents=("E:a", "E:b")):
        return {"id": fid, "lane": "FARA", "title": "Title " + fid, "headline": "Alpha LLC filed a schedule.", "statement": statement,
                "glassmark": "GREEN", "evidence_class": "PRIMARY_IN_CUSTODY", "level": 4, "publication": pub, "sources": ["SRC"],
                "entities": list(ents), "figures": [], "does_not_show": ["That it was paid."], "ordinary_explanation": "Lawful and disclosed.",
                "adverse_explanation": "Unknown downstream.", "discriminator": "The supplemental statement.", "dispute_log": [{"objection": "Budget?", "answer": "Yes."}],
                "missing_records": ["RQ-1"], "public_interest": {"what_changes_if_known": "Readers can check."}, "status": "OPEN", "snapshot": "2026-09-30",
                "proof_profile": {"numbers_verified": 1, "numbers_linked": 1}, "anchors": [], "question": "Did Alpha LLC pay Beta Corp?" if pub == "PUBLISH_AS_QUESTION" else None,
                "causal": {"rung": 4, "rung_code": "C4", "rung_name": "DOCUMENTED INTERACTION", "alleged": False, "competing": [{"id": "H1", "label": "Ordinary", "text": "Lawful."}]}}
    return {
        "meta": {"title": "mini", "standard": "Named sources.", "as_of": "2026-09-30", "built": "2026-09-30", "schema": "tsr.master/1",
                 "firewall": "FIREWALL-TEXT-SENTINEL: the excluded matter stays out.", "private_individuals_policy": "Private people are counted, never named.",
                 "no_grand_total_rule": "Never summed across kinds.", "reasoning": "Two ladders.", "method_precedents": []},
        "vocabularies": V,
        "sources": [{"id": "SRC", "title": "A public filing", "kind": "filing", "status": "reviewed_online", "url": "https://example.org/filing.pdf", "date": "2026-06-07"},
                    {"id": "U-DESK", "title": "private_notes_Paula.xlsx", "kind": "desk_document", "status": "upload"}],
        "entities": [{"id": "E:a", "name": "Alpha LLC", "type": "firm"}, {"id": "E:b", "name": "Beta Corp", "type": "company"},
                     {"id": "E:p", "name": "Paula Private", "type": "person", "public_figure_or_org": False}],
        "money_flows": [{"id": "MF-1", "from": "E:a", "to": "E:b", "amount_usd": 4500000, "kind": "CONTRACT_SCHEDULE", "period": "Apr 2026", "sources": ["SRC"],
                         "locator": "p. 2", "evidence_class": "PRIMARY_IN_CUSTODY", "is_floor": False, "findings": ["F-PUB"], "verification": "PASS"},
                        {"id": "MF-2", "from": "E:b", "to": "E:p", "amount_usd": 1000, "kind": "CONTRACT_SCHEDULE", "period": "May 2026", "sources": ["SRC"],
                         "locator": "p. 3", "evidence_class": "REGISTER_ROW", "is_floor": False, "findings": ["F-HOLD"], "verification": "PASS"}],
        "figures": [],
        "findings": [F("F-PUB", "PUBLISH_WITH_ATTRIBUTION", "Alpha LLC's filing schedules $4.5 million for Beta Corp. [SRC, p. 2]"),
                     F("F-Q", "PUBLISH_AS_QUESTION", "Alpha LLC probably paid Beta Corp."),
                     F("F-HOLD", "HOLD", "SECRET-HELD-STATEMENT about Paula Private.", ("E:b", "E:p"))],
        "relationships": [{"id": "R-1", "from": "E:a", "to": "E:b", "type": "REGISTERED_AGENT_FOR", "rel_class": "REPRESENTATION", "rung": 4, "level": 4,
                           "alleged": False, "evidence_class": "REGISTER_ROW", "sources": ["SRC"], "findings": ["F-PUB"]}],
        "claims": [], "corrections": [{"id": "CX-1", "title": "A fixed figure", "what_was_wrong": "x", "what_is_right": "The figure is now sourced.", "why_it_matters": "y",
                                       "status": "APPLIED", "findings": ["F-PUB"], "lane": "FARA"},
                                      {"id": "CX-2", "title": "HELD-CORRECTION", "what_was_wrong": "x", "what_is_right": "z", "status": "APPLIED", "findings": ["F-HOLD"]}],
        "records_queue": [{"id": "RQ-1", "priority": "P1", "lane": "FARA", "question": "Get the supplemental.", "record_target": "Supplemental statement",
                           "url": None, "status": "Open", "what_it_resolves": "Whether it was paid.", "action_type": "records_request"}],
        "coverage": [], "timeline": [{"id": "EV-1", "date": "2026-06-07", "precision": "day", "lane": "FARA", "event": "Schedule filed.", "grade": "GREEN",
                                      "evidence": [{"src": "SRC", "loc": "p. 1"}], "findings": ["F-PUB"]},
                                     {"id": "EV-2", "date": "2026-06-08", "precision": "day", "lane": "FARA", "event": "HELD-EVENT", "grade": "GREEN",
                                      "evidence": [], "findings": ["F-HOLD"]}],
        "verification": {"quotes": [{"status": "PASS"}], "locators": {}, "errors": [], "arithmetic": []},
        "metrics": {"verification": {"numbers_machine_verified": 2, "numbers_total": 2}, "counts": {}},
    }


class A(object):
    pass


def args_for(ledger, out, **kw):
    a = A()
    a.ledger, a.out, a.theme, a.approve, a.sign, a.base_url, a.built = ledger, out, "ocean-depths", None, False, None, "2026-09-30"
    a.no_images, a.forbidden, a.allow_ungated = True, [], False
    for k, v in kw.items():
        setattr(a, k, v)
    return a


def quiet(fn, *a):
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        return fn(*a), buf.getvalue()


def main():
    tmp = tempfile.mkdtemp(prefix="station-selftest-")
    old_key = os.environ.get("SENTINEL_STATION_KEY")
    try:
        run(tmp)
    finally:
        if old_key is None:
            os.environ.pop("SENTINEL_STATION_KEY", None)
        else:
            os.environ["SENTINEL_STATION_KEY"] = old_key
        shutil.rmtree(tmp, ignore_errors=True)
    bad = [r for r in RESULTS if not r[1]]
    for n, ok, d in RESULTS:
        print("{}  {}{}".format("PASS" if ok else "FAIL", n, "  — " + d if d and not ok else ""))
    print("\nstation selftest: {} passed, {} failed, {} checks".format(len(RESULTS) - len(bad), len(bad), len(RESULTS)))
    return 1 if bad else 0


def run(tmp):
    L = mini()
    lp = os.path.join(tmp, "ledger.json")
    json.dump(L, open(lp, "w"))
    out = os.path.join(tmp, "site")
    rc, _ = quiet(S.build, args_for(lp, out))
    check("a clean ledger builds", rc == 0 and os.path.exists(os.path.join(out, "index.html")))
    blob = ""
    for d, _, fs in os.walk(out):
        for f in fs:
            blob += open(os.path.join(d, f), encoding="utf-8", errors="replace").read()
    check("a HOLD finding's words never ship", "SECRET-HELD-STATEMENT" not in blob and "HELD-EVENT" not in blob and "HELD-CORRECTION" not in blob)
    check("a private person's name never ships", "Paula" not in blob)
    check("the firewall text never ships", "FIREWALL-TEXT-SENTINEL" not in blob)
    check("a desk file is identified by its id, never its file name", "private_notes" not in blob)
    check("a question ships as its question only", "Did Alpha LLC pay Beta Corp?" in blob and "probably paid" not in blob)
    pages = [os.path.join(d, f) for d, _, fs in os.walk(out) for f in fs if f.endswith(".html")]
    ext = [p for p in pages if re.search(r'<(script|link)[^>]+(src|href)="https?://', open(p, encoding="utf-8").read())]
    check("no page loads a script or stylesheet from another host", not ext, str(ext[:2]))
    check("every page has a <title>", all("<title>" in open(p, encoding="utf-8").read() for p in pages))
    man = json.load(open(os.path.join(out, "manifest.json")))
    pub = open(os.path.join(out, "data", "public-ledger.json"), "rb").read()
    check("the art is seeded by the published ledger's own hash", json.load(open(os.path.join(out, "art-spec.json")))["digest"] == S.sha256_bytes(pub) == man["public_ledger_sha256"])
    try:
        ET.parse(os.path.join(out, "feed.xml"))
        check("the Atom feed is well-formed XML", True)
    except ET.ParseError as e:
        check("the Atom feed is well-formed XML", False, str(e))
    rc, _ = quiet(S.verify, type("a", (), {"dir": out}))
    check("an untouched build verifies", rc == 0)
    p = os.path.join(out, "method.html")
    open(p, "a").write("<!-- one changed byte -->")
    rc, txt = quiet(S.verify, type("a", (), {"dir": out}))
    check("one changed file fails verification", rc == 1 and "CHANGED  method.html" in txt)
    # the gate refuses a promoting verb
    L2 = copy.deepcopy(L)
    L2["findings"][0]["statement"] = "Alpha LLC coordinated with Beta Corp on the schedule."
    json.dump(L2, open(lp, "w"))
    try:
        quiet(S.build, args_for(lp, os.path.join(tmp, "site2")))
        check("the gate refuses 'coordinated' when the record is a registration", False)
    except S.BuildError as e:
        check("the gate refuses 'coordinated' when the record is a registration", "coordination" in str(e))
    check("a refused build writes nothing", not os.path.exists(os.path.join(tmp, "site2")))
    # the never-print list stops a build
    json.dump(L, open(lp, "w"))
    fb = os.path.join(tmp, "never.txt")
    open(fb, "w").write("# private\nBeta Corp\n")
    try:
        quiet(S.build, args_for(lp, os.path.join(tmp, "site3"), forbidden=[fb]))
        check("a never-print hit stops the build", False)
    except S.BuildError as e:
        check("a never-print hit stops the build", "never-print" in str(e) and "Beta" not in str(e))
    # signing
    os.environ["SENTINEL_STATION_KEY"] = os.path.join(tmp, "keys", "publisher.key")
    rc, txt = quiet(S.keygen, None)
    check("keygen creates a key and prints only the public half", rc == 0 and "public key" in txt and
          open(os.environ["SENTINEL_STATION_KEY"]).read().strip() not in txt)
    rc2, _ = quiet(S.keygen, None)
    check("keygen never overwrites an existing key", rc2 == 3)
    out4 = os.path.join(tmp, "site4")
    quiet(S.build, args_for(lp, out4, sign=True, approve="TSR desk"))
    rc, txt = quiet(S.verify, type("a", (), {"dir": out4}))
    check("a signed build verifies, signature VALID", rc == 0 and "signature: VALID" in txt)
    check("an approved build says who approved it", "Approved for publication by TSR desk" in open(os.path.join(out4, "index.html"), encoding="utf-8").read())
    mp = os.path.join(out4, "manifest.json")
    m = json.load(open(mp))
    m["files"][0]["sha256"] = "0" * 64
    open(mp, "w").write(json.dumps(m, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
    rc, txt = quiet(S.verify, type("a", (), {"dir": out4}))
    check("an edited manifest breaks the signature", rc == 1 and "signature: INVALID" in txt)


if __name__ == "__main__":
    sys.exit(main())
