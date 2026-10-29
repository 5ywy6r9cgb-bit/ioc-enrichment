#!/usr/bin/env python3
"""leads -- cross-record questions, each with the document that would settle it.

A card is a QUESTION. It must name the innocent explanation, the record that
would kill it, and the document that would settle it, or it is rejected.
Nothing here sends anything; `request` only prints a neutral draft.
"""
import json, os, sys, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS = os.path.join(HERE, "cards.json")
STATUS = ("HYPOTHESIS", "DERIVED", "DOCUMENTED")
REQUIRED = ("id", "title", "pair", "status", "question", "records", "settling_document",
            "innocent_explanation", "kill_condition", "publication_gate")


def load(path=CARDS):
    with open(path, encoding="utf-8") as f:
        return json.load(f)["cards"]


def validate(cards):
    errs, seen = [], set()
    for c in cards:
        cid = c.get("id", "?")
        for k in REQUIRED:
            v = c.get(k)
            if v in (None, "", [], {}):
                errs.append("%s: missing %s" % (cid, k))
        if c.get("status") not in STATUS:
            errs.append("%s: status must be one of %s" % (cid, "/".join(STATUS)))
        if cid in seen:
            errs.append("%s: duplicate id" % cid)
        seen.add(cid)
        if c.get("status") == "DOCUMENTED" and not c.get("documents_ingested"):
            errs.append("%s: DOCUMENTED needs documents_ingested (primary documents, with hashes)" % cid)
        for r in c.get("records") or []:
            for k in ("what", "custodian", "route"):
                if not r.get(k):
                    errs.append("%s: a record is missing %s" % (cid, k))
    return errs


def show(c):
    out = ["%s  [%s]" % (c["title"], c["status"]), "  id: " + c["id"],
           "  basis: " + c.get("basis", "-"), "", "QUESTION", textwrap.fill(c["question"], 78, initial_indent="  ", subsequent_indent="  "), "", "RECORDS"]
    for r in c["records"]:
        out.append("  - %s\n      custodian: %s\n      route: %s" % (r["what"], r["custodian"], r["route"]))
    out += ["", "VERIFY THE LAW FIRST (current text, not memory)"]
    out += ["  - " + s for s in (c.get("statutes_to_verify") or ["(none listed)"])]
    for k, h in (("settling_document", "SETTLES IT"), ("innocent_explanation", "BEST INNOCENT EXPLANATION"),
                 ("kill_condition", "KILLS THE LEAD"), ("publication_gate", "BEFORE ANY PUBLICATION")):
        out += ["", h, textwrap.fill(c[k], 78, initial_indent="  ", subsequent_indent="  ")]
    return "\n".join(out)


def request_draft(c):
    lines = ["DRAFT ONLY. Not sent. Review, fill in your details, send it yourself.", "",
             "Subject: Public records request: " + c["title"], "",
             "Under the public records law that applies to your office, I request copies, in electronic format where possible, of:"]
    for i, r in enumerate(c["records"], 1):
        lines.append("  %d. %s" % (i, r["what"]))
    lines += ["", "If any part is withheld, please identify the exemption relied on and release the remainder. "
              "Please tell me the cost before any charge above an agreed amount.", "",
              "[YOUR NAME] / [CONTACT]", "",
              "Custodian(s) to address: " + "; ".join(sorted({r["custodian"] for r in c["records"]})),
              "Verify before sending: " + ("; ".join(c.get("statutes_to_verify") or []) or "(none)")]
    return "\n".join(lines)


def main(argv=None, path=CARDS):
    a = list(sys.argv[1:] if argv is None else argv)
    cmd = a[0] if a else "list"
    cards = load(path)
    by = {c["id"]: c for c in cards}
    if cmd == "list":
        for c in cards:
            print("%-30s %-10s %s" % (c["id"], c["status"], c["title"]))
        return 0
    if cmd == "check":
        errs = validate(cards)
        for e in errs:
            print("  FAIL  " + e)
        print("%d card(s), %d problem(s)" % (len(cards), len(errs)))
        return 1 if errs else 0
    if cmd in ("show", "request"):
        if len(a) < 2 or a[1] not in by:
            print("usage: leads %s ID   (ids: %s)" % (cmd, ", ".join(by)), file=sys.stderr)
            return 2
        print(show(by[a[1]]) if cmd == "show" else request_draft(by[a[1]]))
        return 0
    print("leads list | show ID | request ID | check", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
