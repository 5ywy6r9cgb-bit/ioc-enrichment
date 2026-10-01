# -*- coding: utf-8 -*-
"""The number gate: every dollar figure, percentage and multiple in a draft must trace to the
ledger, belong to a finding cleared for that use, and be described the way its record allows.

    ledger gate draft.md            # text report, exit 1 on anything not clean
    ledger gate draft.md --json     # machine-readable
"""
import json
import re
from decimal import Decimal

import lib_ledger as L

PUB_RANK = {"PUBLISH_WITH_ATTRIBUTION": 5, "PUBLISH_AFTER_VERIFY": 4, "PUBLISH_AS_QUESTION": 3, "CORRECTION": 2,
            "INTERNAL": 1, "HOLD": 0}

RULES = [
    ("SCHEDULE_IS_NOT_PAYMENT", lambda it, s, p: it["kind"] in ("CONTRACT_SCHEDULE", "CONTRACT_TERMS")
     and re.search(r"\b(paid|spent|spending|received|receipts?)\b", s, re.I),
     "A contract schedule or term is not a payment. Say 'scheduled' or 'agreed'."),
    ("FORWARDED_IS_NOT_GIVEN", lambda it, s, p: it["kind"] in ("CONDUIT_FORWARDED", "MIXED_OWN_FORWARDED")
     and re.search(r"\b(gave|donated|donation|contributed|its own)\b", s, re.I),
     "Earmarked money passing through a conduit is the individuals' giving, not the committee's."),
    ("AWARD_IS_NOT_CASH", lambda it, s, p: it["kind"] in ("AWARD_VALUE", "AWARD_AGGREGATE")
     and re.search(r"\b(paid|payments?|received|spent)\b", s, re.I),
     "An award value is obligated-plus-potential, not cash paid. Say 'awards valued at'."),
    ("ALLEGATION_MUST_SAY_SO", lambda it, s, p: (it["kind"] == "ALLEGED_TRANSFER" or it["cls"] == "SWORN_ALLEGATION")
     and not re.search(r"alleg|indictment|affidavit|charg|according to", p, re.I),
     "This number comes from a charging document or affidavit. Attribute it as an allegation."),
    ("MULTI_CYCLE_NOT_2024", lambda it, s, p: "MULTI-CYCLE" in (it.get("semantics") or "") and re.search(r"\b2024\b", s),
     "This total covers several cycles. It may never be labelled as 2024."),
    ("FIGURE_NOT_USABLE", lambda it, s, p: it["kind"] in ("MISLABELLED", "UNRESOLVED"),
     "This figure exists in the ledger only to show a correction or an unresolved column. It may not be used."),
    ("FLOOR_AS_TOTAL", lambda it, s, p: it.get("floor") and not re.search(r"at least|more than|over|minimum|floors?\b|no fewer|>", p, re.I),
     "This is a floor. Say 'at least'."),
    ("IE_IS_NOT_A_GIFT", lambda it, s, p: it["kind"] in ("IE_SUPPORT", "IE_OPPOSE", "IE_TOTAL", "IE_VENDOR_PAYMENT")
     and re.search(r"\b(donat\w*|contribut\w*|gave|gift)\b", s, re.I),
     "An independent expenditure is not a contribution to anyone."),
    ("ESTIMATE_IS_NOT_SPENDING", lambda it, s, p: it["kind"] == "PROGRAM_ESTIMATE"
     and re.search(r"\b(spent|paid|awarded|received|obligated)\b", s, re.I),
     "A program estimate in a solicitation is not money awarded or spent. Say 'estimated at'."),
    ("ABSENCE_IS_NOT_CONCEALMENT", lambda it, s, p: re.search(r"\b(hid|hidden|secret(ly)?|conceal\w*|cover[- ]?up)\b", s, re.I)
     and it["cls"] != "SWORN_ALLEGATION",
     "The record shows a gap in the collection, not that anyone hid anything."),
]


CTX_STOP = {"committee", "political", "action", "department", "united", "states", "america", "american", "national",
            "group", "corp", "corporation", "company", "fund", "foundation", "public", "affairs", "federal", "government",
            "strategies", "media", "with", "from", "that", "this", "into", "rows", "share", "total", "report", "figure",
            "cycle", "awards", "award", "value", "state", "office", "services", "inc", "llc"}


def terms_of(*texts):
    out = set()
    for t in texts:
        for w in re.findall(r"[A-Za-z][A-Za-z\-]{3,}", t or ""):
            if w.lower() not in CTX_STOP:
                out.add(w.lower())
        for w in re.findall(r"\b[A-Z][A-Z0-9]{1,5}\b", t or ""):      # acronyms: UDP, SLF, AFP, RT, OCCC …
            if w not in ("PAC", "LLC", "INC", "THE", "AND", "USD", "FEC", "LDA", "FY", "Q1", "Q2", "Q3", "Q4"):
                out.add(w.lower())
    return out


LOCAL_RULES = {"SCHEDULE_IS_NOT_PAYMENT", "FORWARDED_IS_NOT_GIVEN", "AWARD_IS_NOT_CASH", "IE_IS_NOT_A_GIFT", "ESTIMATE_IS_NOT_SPENDING"}


def index(ledger):
    fin = {f["id"]: f for f in ledger["findings"]}
    ent = {e["id"]: e for e in ledger.get("entities", [])}
    en = lambda i: " ".join([ent.get(i, {}).get("name", "")] + list(ent.get(i, {}).get("aliases") or []))
    items = []

    def pub_of(fids):
        pubs = [fin[x]["publication"] for x in fids if x in fin]
        corr = [x for x in fids if x.startswith("CX-")]
        if corr and not pubs:
            return "CORRECTION", corr
        if not pubs:
            return "INTERNAL", fids
        best = max(pubs, key=lambda p: PUB_RANK[p])
        return best, fids

    for m in ledger["money_flows"]:
        if m.get("amount_usd") is None:
            continue
        pub, refs = pub_of(m.get("findings", []))
        items.append({"id": m["id"], "type": "money", "value": Decimal(str(m["amount_usd"])), "unit": "USD", "kind": m["kind"],
                      "cls": m["evidence_class"], "pub": pub, "refs": refs, "floor": m.get("is_floor"),
                      "label": "{} → {}".format(ent.get(m["from"], {}).get("name", m["from"]), ent.get(m["to"], {}).get("name", m["to"])),
                      "semantics": m.get("caveat"), "terms": terms_of(en(m["from"]), en(m["to"]))})
    for f in ledger["figures"]:
        if f.get("value") is None:
            continue
        pub, refs = pub_of(f.get("findings", []))
        unit = f.get("unit") or "USD"
        items.append({"id": f["id"], "type": "figure", "value": Decimal(str(f["value"])), "unit": unit, "kind": f["kind"],
                      "cls": f["evidence_class"], "pub": pub, "refs": refs, "floor": f.get("is_floor"),
                      "label": f["label"], "semantics": f.get("semantics"), "terms": terms_of(f["label"], en(f.get("entity")))})
    for r in ledger.get("financials", []):
        refs = [f["id"] for f in ledger["findings"] if r.get("entity") in f.get("entities", [])]
        pub, refs = pub_of(refs)
        for key, kind in (("revenue", "RECEIPT_TOTAL"), ("expenses", "DISBURSEMENT_TOTAL"), ("assets", "FUND_BALANCE")):
            if r.get(key) is None:
                continue
            items.append({"id": "FIN-{}-{}-{}".format(r["entity"][2:], r["fiscal_year_end"], key), "type": "financials",
                          "value": Decimal(str(r[key])), "unit": "USD", "kind": kind, "cls": r.get("evidence_class", "SECONDARY_REPORT"),
                          "pub": pub, "refs": refs, "floor": False,
                          "label": "{} {} FY ending {}".format(ent.get(r["entity"], {}).get("name", r["entity"]), key, r["fiscal_year_end"]),
                          "semantics": r.get("note"), "terms": terms_of(en(r["entity"]))})
    for a in ledger.get("verification", {}).get("arithmetic", []):
        v = a.get("computed")
        if v is None:
            continue
        unit = "share" if 0 < abs(v) < 1 else ("ratio" if abs(v) < 1000 and "÷" in a["formula"] else "USD")
        figs = a.get("figures") or []
        refs = []
        for x in figs:
            for f in ledger["figures"]:
                if f["id"] == x:
                    refs += f.get("findings", [])
        pub, refs = pub_of(refs) if refs else ("INTERNAL", [])
        items.append({"id": a["id"], "type": "arithmetic", "value": Decimal(str(v)), "unit": unit, "kind": "ARITH",
                      "cls": "ARITH", "pub": pub if refs else "PUBLISH_AFTER_VERIFY", "refs": refs, "floor": False,
                      "label": a["label"], "semantics": a.get("note"), "terms": terms_of(a["label"])})
    return items


def candidates(items, n):
    out = []
    for it in items:
        if n["kind"] == "share" and it["unit"] != "share":
            continue
        if n["kind"] == "multiple" and it["unit"] not in ("ratio",):
            continue
        if n["kind"] == "money" and it["unit"] != "USD":
            continue
        if n["kind"] == "number" and it["unit"] in ("share",):
            continue
        diff = abs(it["value"] - n["value"])
        exact_tol = Decimal("0.5") if it["unit"] == "USD" else Decimal("0.00005")
        if diff <= exact_tol:
            out.append(dict(it, quality="EXACT", diff=diff))
            continue
        # a rounded figure matches only if the ledger value rounds to what the draft shows AND is within 2.5%
        rel = diff / abs(it["value"]) if it["value"] else Decimal(1)
        if diff <= n["precision"] and rel <= Decimal("0.025"):
            out.append(dict(it, quality="ROUNDED", diff=diff))
    out.sort(key=lambda c: (c["diff"], -PUB_RANK.get(c["pub"], 0)))
    return out


def run(draft_text, ledger):
    items = index(ledger)
    results = []
    for n in L.parse_numbers(draft_text):
        sent = L.sentence_around(draft_text, n["start"], n["end"])
        para = L.paragraph_around(draft_text, n["start"], n["end"])
        clause = L.clause_around(draft_text, n["start"], n["end"])
        cands = candidates(items, n)
        r = {"number": n["text"], "value": str(n["value"]), "sentence": sent, "matches": [], "status": None, "flags": []}
        if not cands:
            r["status"] = "UNMATCHED"
            r["flags"].append(("NOT_IN_LEDGER", "No ledger row carries this number. It cannot be published without a source."))
            results.append(r)
            continue
        words = terms_of(para)
        for c in cands:
            c["context"] = bool(c.get("terms", set()) & words)
        in_ctx = [c for c in cands if c["context"]]
        if in_ctx:
            cands = in_ctx + [c for c in cands if not c["context"]]
        best = cands[0]
        if not best["context"]:
            r["flags"].append(("CONTEXT_UNCONFIRMED", "The nearest ledger row ({}: {}) names none of the parties in this sentence. "
                               "Confirm it is the same money, or source the number.".format(best["id"], best["label"][:60])))
        r["matches"] = [{"id": c["id"], "label": c["label"], "kind": c["kind"], "publication": c["pub"], "refs": c["refs"],
                         "quality": c["quality"]} for c in cands[:4]]
        if best["quality"] == "ROUNDED":
            r.setdefault("notes", []).append("Rounded in the draft; nearest ledger value is {} ({}).".format(best["value"], best["id"]))
        if len(cands) > 1:
            r.setdefault("notes", []).append("{} ledger rows fit this number; the nearest is {} — cite the one you mean.".format(len(cands), best["id"]))
        pub = best["pub"]
        if pub in ("HOLD", "INTERNAL"):
            r["status"] = "HELD"
            r["flags"].append(("FINDING_ON_HOLD", "This number belongs to a finding that is on HOLD or internal."))
        elif pub == "PUBLISH_AS_QUESTION":
            r["status"] = "QUESTION_ONLY"
            if "?" not in sent:
                r["flags"].append(("MUST_BE_A_QUESTION", "Its finding may only be published as an open question."))
        elif pub == "CORRECTION":
            r["status"] = "CORRECTION_ONLY"
            r["flags"].append(("CORRECTION_FIGURE", "This number exists to show a correction; use the corrected figures."))
        else:
            r["status"] = "MATCH"
        for code, test, msg in RULES:
            try:
                if test(best, clause if code in LOCAL_RULES else sent, para):
                    r["flags"].append((code, msg))
            except Exception:
                pass
        results.append(r)
    clean = all(x["status"] == "MATCH" and not x["flags"] for x in results)
    for x in results:
        x.setdefault("notes", [])
    return results, clean


def render(results, clean, path):
    out = ["LEDGER GATE  {}".format(path), ""]
    if not results:
        out.append("No money amounts, percentages or multiples found.")
    for r in results:
        head = "{:<16} {}".format(r["status"], r["number"])
        out.append(head)
        for m in r["matches"][:2]:
            out.append("    ↳ {}  {}  [{} · {}]".format(m["id"], m["label"][:66], m["publication"], m["quality"]))
        for code, msg in r["flags"]:
            out.append("    ! {}: {}".format(code, msg))
        for note in r.get("notes", []):
            out.append("    · " + note)
        out.append(L.wrap("“" + r["sentence"][:300] + "”", 92, "      "))
    n = len(results)
    ok = sum(1 for r in results if r["status"] == "MATCH" and not r["flags"])
    out += ["", "{} number(s) checked · {} clean · {} need attention".format(n, ok, n - ok),
            "CLEAN — every number traces to the ledger and is used as its record allows." if clean else
            "NOT CLEAN — fix or source every flagged number before publication."]
    return "\n".join(out)


def main(args):
    import epistemic
    ledger = L.load(L.find_ledger(args.ledger))
    text = open(args.draft, encoding="utf-8").read()
    results, clean = run(text, ledger)
    issues = [] if getattr(args, "numbers_only", False) else epistemic.check(text, ledger)
    ep_clean = not any(i["status"] == "FAIL" for i in issues)
    if args.json:
        print(json.dumps({"clean": clean and ep_clean, "numbers_clean": clean, "epistemic_clean": ep_clean,
                          "results": results, "epistemic": issues}, ensure_ascii=False, indent=1, default=str))
    else:
        print(render(results, clean, args.draft))
        print("")
        print(epistemic.render(issues))
        if not ep_clean:
            print("NOT CLEAN — a sentence claims more than its evidence reaches.")
    return 0 if clean and ep_clean else 1
