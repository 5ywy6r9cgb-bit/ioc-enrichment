# -*- coding: utf-8 -*-
"""Integrity gate for a ledger file: structure, references, the desk's publication rules, the
verification record, and an optional private list of strings that must never appear.

    ledger check                    # exit 0 clean, 1 errors
    ledger check --ledger other.json

Private strings: put one per line in ~/.sentinel/ledger/forbidden.txt (names of private people,
case numbers, personal paths). The file stays on this machine; the check reports only the line
number that matched, never the string."""
import os

import lib_ledger as L

REQUIRED = ("meta", "vocabularies", "sources", "entities", "money_flows", "figures", "findings", "relationships",
            "claims", "corrections", "records_queue", "coverage", "timeline", "verification")
WEAK = ("REGISTER_ROW", "DESK_NOTE", "SECONDARY_REPORT")


def run(ledger, forbidden_path=None):
    errs, warns = [], []
    for k in REQUIRED:
        if k not in ledger:
            errs.append("missing section: " + k)
    if errs:
        return errs, warns
    V = ledger["vocabularies"]
    S = {s["id"] for s in ledger["sources"]}
    E = {e["id"] for e in ledger["entities"]}
    F = {f["id"] for f in ledger["findings"]}
    CX = {c["id"] for c in ledger["corrections"]}
    RQ = {r["id"] for r in ledger["records_queue"]}
    FG = {f["id"] for f in ledger["figures"]}

    def need(ref, pool, what, where):
        if ref not in pool:
            errs.append("{}: unknown {} {}".format(where, what, ref))

    for m in ledger["money_flows"]:
        need(m["from"], E, "entity", m["id"])
        need(m["to"], E, "entity", m["id"])
        need(m["kind"], V["money_kinds"], "money kind", m["id"])
        need(m["evidence_class"], V["evidence_class"], "evidence class", m["id"])
        for s in m["sources"]:
            need(s, S, "source", m["id"])
        for x in m.get("findings", []):
            need(x, F | CX, "finding", m["id"])
    for f in ledger["figures"]:
        need(f["kind"], V["figure_kinds"], "figure kind", f["id"])
        need(f["evidence_class"], V["evidence_class"], "evidence class", f["id"])
        for s in f["sources"]:
            need(s, S, "source", f["id"])
    for r in ledger["relationships"]:
        need(r["from"], E, "entity", r["id"])
        need(r["to"], E, "entity", r["id"])
        if r["level"] >= 5 and r["evidence_class"] in WEAK:
            errs.append("{}: level {} from a {} — a join cannot claim direction or authority".format(r["id"], r["level"], r["evidence_class"]))
    for f in ledger["findings"]:
        fid = f["id"]
        need(f["glassmark"], V["glassmark"], "tier", fid)
        need(f["evidence_class"], V["evidence_class"], "evidence class", fid)
        need(f["publication"], V["publication"], "publication", fid)
        for s in f["sources"]:
            need(s, S, "source", fid)
        for e in f["entities"]:
            need(e, E, "entity", fid)
        for x in f["figures"]:
            need(x, FG, "figure", fid)
        for x in f.get("missing_records", []):
            need(x, RQ, "records item", fid)
        if f["glassmark"] == "RED" and f["publication"] in ("PUBLISH_WITH_ATTRIBUTION", "PUBLISH_AFTER_VERIFY"):
            errs.append(fid + ": a RED finding cannot be published as a statement")
        if f["level"] >= 5 and f["evidence_class"] in WEAK:
            errs.append("{}: level {} rests on {}".format(fid, f["level"], f["evidence_class"]))
        if not f.get("ordinary_explanation"):
            errs.append(fid + ": the ordinary explanation is not written")
        if f["publication"] in ("PUBLISH_WITH_ATTRIBUTION", "PUBLISH_AFTER_VERIFY") and not f.get("does_not_show"):
            warns.append(fid + ": publishable finding with no 'does not show' limits")
    ver = ledger["verification"]
    for k, v in ver.get("locators", {}).items():
        if v.get("status") == "FAIL":
            errs.append("{}: its number or parties were not found at the cited locator ({})".format(k, v.get("reason")))
    for q in ver.get("quotes", []):
        if q.get("status") == "FAIL":
            errs.append("{}: quote not found at {}".format(q.get("record"), q.get("loc")))
    for a in ver.get("arithmetic", []):
        if a.get("status") == "FAIL":
            errs.append("{}: arithmetic does not reproduce ({})".format(a["id"], a["label"]))
    for x in ver.get("errors", []):
        errs.append("build: " + x)
    # the private list — never printed
    p = forbidden_path or os.path.join(os.path.expanduser("~"), ".sentinel", "ledger", "forbidden.txt")
    if os.path.exists(p):
        blob = L.canonical(ledger)
        with open(p, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                t = line.strip()
                if t and not t.startswith("#") and t in blob:
                    errs.append("private list line {} appears in the ledger".format(i))
    return errs, warns


def main(args):
    path = L.find_ledger(args.ledger)
    ledger = L.load(path)
    errs, warns = run(ledger)
    for w in warns:
        print("warn   " + w)
    for e in errs:
        print("ERROR  " + e)
    m = ledger.get("metrics", {}).get("verification", {})
    print("{}  ·  {} findings · {} flows · {} sources  ·  numbers verified {}/{}".format(
        os.path.basename(path), len(ledger["findings"]), len(ledger["money_flows"]), len(ledger["sources"]),
        m.get("numbers_machine_verified", "?"), m.get("numbers_total", "?")))
    print("CLEAN" if not errs else "{} error(s)".format(len(errs)))
    return 0 if not errs else 1
