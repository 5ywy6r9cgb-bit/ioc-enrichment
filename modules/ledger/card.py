# -*- coding: utf-8 -*-
"""Publication cards: the approved wording for one finding, with its attribution, limits,
objections and open records — or a refusal that says what would release it.

    ledger card F-FARA-01
    ledger card F-OH-03             # PUBLISH_AS_QUESTION → printed as a question
    ledger card --publishable       # every card cleared for publication
    ledger card F-FARA-01 --format json
"""
import json

import lib_ledger as L

CLEARED = ("PUBLISH_WITH_ATTRIBUTION", "PUBLISH_AFTER_VERIFY")


def build(ledger, fid):
    F = {f["id"]: f for f in ledger["findings"]}
    S = {s["id"]: s for s in ledger["sources"]}
    RQ = {r["id"]: r for r in ledger["records_queue"]}
    if fid not in F:
        L.die("no finding {}".format(fid))
    f = F[fid]
    pp = f.get("proof_profile", {})
    anchors = f.get("anchors", [])
    card = {
        "id": fid, "lane": f["lane"], "title": f["title"], "tier": f["glassmark"], "evidence_class": f["evidence_class"],
        "level": f["level"], "publication": f["publication"], "status": f["status"],
        "headline": f["headline"], "statement": f["statement"],
        "attribution": [{"id": s, "title": S[s]["title"], "url": S[s].get("url"), "status": S[s]["status"]} for s in f["sources"]],
        "does_not_show": f.get("does_not_show", []),
        "ordinary_explanation": f.get("ordinary_explanation"), "adverse_explanation": f.get("adverse_explanation"),
        "discriminator": f.get("discriminator"),
        "objections": f.get("dispute_log", []),
        "open_records": [{"id": r, "priority": RQ[r]["priority"], "question": RQ[r]["question"], "action": RQ[r]["action_type"]}
                         for r in f.get("missing_records", []) if r in RQ],
        "numbers": "{}/{} linked numbers verified at their locators".format(pp.get("numbers_verified", 0), pp.get("numbers_linked", 0)),
        "anchors": "{}/{} anchor quotes found word-for-word".format(sum(1 for a in anchors if a.get("status") == "PASS"), len(anchors)),
        "public_interest": f.get("public_interest") or {},
    }
    if f["publication"] in ("HOLD", "INTERNAL"):
        card["refusal"] = ("NOT FOR PUBLICATION ({}). Release requires: {}".format(
            f["publication"], "; ".join(r["id"] + " " + r["question"] for r in card["open_records"]) or f.get("discriminator")))
    elif f["publication"] == "PUBLISH_AS_QUESTION":
        q = f.get("question") or "Open question: {}?".format(f["title"].rstrip("."))
        card["question_form"] = "{}  What is on the record: {}  The record that would settle it: {}".format(
            q, f["headline"], f.get("discriminator"))
    elif f["publication"] == "PUBLISH_AFTER_VERIFY":
        card["before_use"] = "Re-pull the primary record named in the attribution and confirm the numbers before this runs."
    return card


def render(c):
    out = []
    bar = "═" * 92
    out += [bar, "{}  ·  {}  ·  {} / {} · level {}".format(c["id"], c["lane"], c["tier"], c["evidence_class"], c["level"]), bar]
    if c.get("refusal"):
        out += ["", "✖ " + c["refusal"], "", "Title: " + c["title"]]
        return "\n".join(out)
    out += ["", c["title"].upper(), "", L.wrap(c["headline"])]
    if c.get("question_form"):
        out += ["", "PUBLISH ONLY AS A QUESTION:", L.wrap(c["question_form"], 92, "  ")]
    else:
        out += ["", "APPROVED STATEMENT ({}):".format(c["publication"]), L.wrap(c["statement"], 92, "  ")]
    if c.get("before_use"):
        out += ["", "BEFORE USE: " + c["before_use"]]
    out += ["", "ATTRIBUTION:"]
    for a in c["attribution"]:
        out.append("  [{}] {}{}".format(a["id"], a["title"], ("  " + a["url"]) if a.get("url") else ""))
    if c["does_not_show"]:
        out += ["", "WHAT THIS DOES NOT SHOW:"] + ["  – " + x for x in c["does_not_show"]]
    out += ["", "ORDINARY EXPLANATION (written first):", L.wrap(c["ordinary_explanation"] or "—", 92, "  ")]
    if c["objections"]:
        out += ["", "OBJECTIONS ANSWERED:"]
        for o in c["objections"]:
            out += [L.wrap("Q: " + o["objection"], 92, "  "), L.wrap("A: " + o["answer"], 92, "     ")]
    if c["open_records"]:
        out += ["", "OPEN RECORDS:"] + ["  {} [{}] {} ({})".format(r["id"], r["priority"], r["question"], r["action"]) for r in c["open_records"]]
    out += ["", "PROOF: " + c["numbers"] + " · " + c["anchors"]]
    return "\n".join(out)


def main(args):
    ledger = L.load(L.find_ledger(args.ledger))
    ids = [f["id"] for f in ledger["findings"] if f["publication"] in CLEARED] if args.publishable else [args.finding]
    if not ids or ids == [None]:
        L.die("give a finding id, or --publishable")
    cards = [build(ledger, i) for i in ids]
    if args.format == "json":
        print(json.dumps(cards if len(cards) > 1 else cards[0], ensure_ascii=False, indent=1))
    else:
        print("\n\n".join(render(c) for c in cards))
    refused = [c for c in cards if c.get("refusal")]
    return 3 if refused and len(cards) == 1 else 0
