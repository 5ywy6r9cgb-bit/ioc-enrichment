#!/usr/bin/env python3
"""sentinel-routes - the route ledger: every number traced to the findings it serves.

    bin/sentinel-routes build                  write evidence/ledger/routes.json and routes.csv
    bin/sentinel-routes finding F-ID           every route into one finding, each marked IS / WAS / OPEN
    bin/sentinel-routes row ID                 every finding one number, figure or relationship feeds
    bin/sentinel-routes denominators           every division in the ledger, with its inputs' states
    bin/sentinel-routes open [--p1]            everything not concrete, with the record that settles it
    bin/sentinel-routes ladder [F-ID]          where each finding stands and what raises it one rung
    bin/sentinel-routes pass [SP-ID]           the strength passes on file: confirms, contests, answers
    bin/sentinel-routes ie-audit --notices F   every IE row against the FEC's 24/48-hour notice file
    bin/sentinel-routes verify                 rebuild and compare with the saved routes.json
    bin/sentinel-routes selftest

IS    concrete now: the record says it today, checked at its locator.
WAS   concrete for a stated past date or period, per the record. Says nothing about today.
OPEN  not concrete: a question, a lead, an allegation, a contested number, or a gap.
      Every OPEN line names the record that would settle it, when one is known.

Reads evidence/ledger/current.json (or --ledger PATH: a ledger JSON or the
sentinel_master.sqlite export) and every strength pass in evidence/ledger/passes/.
Offline. Standard library only. Python 3.8+. It never edits the ledger: passes
propose, the desk decides.
"""
import argparse
import csv
import datetime
import hashlib
import io
import json
import os
import re
import sqlite3
import sys

VERSION = "routes/1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))

LIST_FIELDS = {"sources", "custody", "entities", "figures", "does_not_show", "missing_records", "findings",
               "lanes", "aliases", "evidence", "more_urls"}
EVENT_KINDS = {"IE_SUPPORT", "IE_OPPOSE", "IE_VENDOR_PAYMENT", "DIRECT_CONTRIBUTION", "CONDUIT_FORWARDED",
               "MIXED_OWN_FORWARDED", "COMMITTEE_TRANSFER", "JFC_PROCEEDS", "RECEIPT", "OPERATING_DISBURSEMENT",
               "DISBURSEMENT_UNCLASSIFIED", "REFUND", "AWARD_VALUE", "AWARD_AGGREGATE", "LOBBYING_INCOME",
               "AGENT_EXPENDITURE", "AGENT_EXPENDITURE_AGGREGATE", "APPROPRIATION", "APPROPRIATION_ACTUAL",
               "SETTLEMENT", "REPORTED_SPEND", "ON_CHAIN_TRANSFER", "FARA_RECEIPT", "FARA_DISBURSEMENT",
               "IE_TOTAL", "RECEIPT_TOTAL", "DISBURSEMENT_TOTAL", "VENDOR_REVENUE", "CASH", "FUND_BALANCE",
               "LOBBYING_EXPENSE", "COUNT"}
DOCUMENT_KINDS = {"CONTRACT_SCHEDULE": "a scheduled amount in a filed agreement - not a payment",
                  "CONTRACT_TERMS": "contract terms that may be superseded - not a payment",
                  "BUDGET_REQUEST": "an amount requested - not an appropriation",
                  "PROGRAM_ESTIMATE": "an estimate in a solicitation - not spending",
                  "THRESHOLD": "a rule's threshold - not an amount anyone paid"}
ALLEGATION_KINDS = {"ALLEGED_TRANSFER"}
UNRESOLVED_KINDS = {"UNRESOLVED", "MISLABELLED"}
DERIVED_KINDS = {"SHARE", "RATIO"}
LEAD_CLASSES = {"DESK_NOTE", "SECONDARY_REPORT"}
FAILED = {"FAIL", "NOT_FOUND", "UNCHECKED", "MISMATCH"}
RUNG = {"HOLD": 0, "INTERNAL": 0, "CORRECTION": 0, "PUBLISH_AS_QUESTION": 1, "PUBLISH_AFTER_VERIFY": 2,
        "PUBLISH_WITH_ATTRIBUTION": 3}
RUNG_NAME = {0: "held", 1: "question", 2: "publish after verify", 3: "publish with attribution", 4: "corroborated"}
ID_RX = re.compile(r"\b(?:MF|FIG)-[A-Z0-9][A-Z0-9-]*[A-Z0-9]\b")


# ---- loading ----------------------------------------------------------------

def _split(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    s = str(v).strip()
    if not s:
        return []
    if s.startswith("["):
        try:
            x = json.loads(s)
            if isinstance(x, list):
                return x
        except ValueError:
            pass
    return [p.strip() for p in s.split(";") if p.strip()]


def load_ledger(path):
    """A tsr.master/1 ledger JSON, or the sentinel_master.sqlite export -> one dict shape."""
    with open(path, "rb") as fh:
        head = fh.read(16)
    if head.startswith(b"SQLite format 3"):
        db = sqlite3.connect(path)
        db.row_factory = sqlite3.Row
        tabs = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
        L = {"meta": {"schema": "tsr.master/1", "loaded_from": "sqlite"}}
        for t in ("findings", "money_flows", "figures", "relationships", "claims", "corrections",
                  "records_queue", "sources", "entities", "timeline", "coverage"):
            if t in tabs:
                rows = []
                for r in db.execute('select * from "%s"' % t):
                    d = dict(r)
                    for k in list(d):
                        if k in LIST_FIELDS:
                            d[k] = _split(d[k])
                    rows.append(d)
                L[t] = rows
        ver = {"locators": {}, "arithmetic": []}
        if "verify_locators" in tabs:
            for r in db.execute("select * from verify_locators"):
                ver["locators"][r["id"]] = dict(r)
        if "verify_arithmetic" in tabs:
            for r in db.execute("select * from verify_arithmetic"):
                d = dict(r)
                d["figures"] = _split(d.get("figures"))
                ver["arithmetic"].append(d)
        L["verification"] = ver
        return L
    with open(path, "r", encoding="utf-8") as fh:
        L = json.load(fh)
    for t in ("findings", "money_flows", "figures", "relationships", "claims", "corrections", "records_queue"):
        for r in L.get(t, []) or []:
            for k in list(r):
                if k in LIST_FIELDS:
                    r[k] = _split(r[k])
    return L


def load_passes(paths):
    out = []
    for p in paths:
        with open(p, "r", encoding="utf-8") as fh:
            d = json.load(fh)
        if d.get("schema") != "tsr.supplement/1":
            raise ValueError("%s is not a strength pass (schema tsr.supplement/1)" % p)
        d["_path"] = p
        out.append(d)
    return sorted(out, key=lambda d: d.get("id", ""))


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


# ---- rows and states --------------------------------------------------------

def rows_of(L):
    """Every citable number or link in the ledger as a uniform row."""
    loc = (L.get("verification") or {}).get("locators") or {}
    rows = {}
    for m in L.get("money_flows", []) or []:
        rows[m["id"]] = {"id": m["id"], "table": "money", "kind": m.get("kind"), "value": m.get("amount_usd"),
                         "text": m.get("amount_text"), "from": m.get("from"), "to": m.get("to"),
                         "period": m.get("period"), "snapshot": m.get("snapshot"), "locator": m.get("locator"),
                         "evidence_class": m.get("evidence_class"), "is_floor": bool(m.get("is_floor")),
                         "findings": m.get("findings") or [], "sources": m.get("sources") or [],
                         "verification": (loc.get(m["id"]) or {}).get("status") or m.get("verification")}
    for f in L.get("figures", []) or []:
        rows[f["id"]] = {"id": f["id"], "table": "figure", "kind": f.get("kind"), "value": f.get("value"),
                         "unit": f.get("unit"), "label": f.get("label"), "entity": f.get("entity"),
                         "period": f.get("period"), "snapshot": f.get("snapshot"), "locator": f.get("locator"),
                         "evidence_class": f.get("evidence_class"), "is_floor": bool(f.get("is_floor")),
                         "findings": f.get("findings") or [], "sources": f.get("sources") or [],
                         "semantics": f.get("semantics"),
                         "verification": (loc.get(f["id"]) or {}).get("status") or f.get("verification")}
    for r in L.get("relationships", []) or []:
        rows[r["id"]] = {"id": r["id"], "table": "relationship", "kind": r.get("rel_class") or r.get("type"),
                         "value": None, "from": r.get("from"), "to": r.get("to"), "period": r.get("period"),
                         "locator": r.get("locator"), "evidence_class": r.get("evidence_class"),
                         "level": r.get("level"), "rung": r.get("rung"), "alleged": bool(r.get("alleged")),
                         "limitation": r.get("limitation"), "findings": r.get("findings") or [],
                         "sources": r.get("sources") or [], "verification": r.get("verification")}
    return rows


def pass_index(passes):
    """row id -> list of pass effects; finding id -> pass items."""
    eff, by_f, adds = {}, {}, []
    for P in passes:
        for it in P.get("items", []):
            for f in it.get("findings", []):
                by_f.setdefault(f, []).append((P["id"], it))
            for key in ("confirms", "contests", "resolves"):
                for c in it.get(key, []):
                    eff.setdefault(c["row"], []).append(dict(c, effect=key[:-1] if key != "resolves" else "resolve",
                                                             item=it["id"], pass_id=P["id"]))
            for a in it.get("adds", []):
                adds.append(dict(a, item=it["id"], pass_id=P["id"]))
    return eff, by_f, adds


def state_of(row, effects):
    """-> (state, reason, trap)"""
    trap = None
    kind = row.get("kind") or ""
    contests = [e for e in effects if e["effect"] == "contest"]
    resolves = [e for e in effects if e["effect"] == "resolve"]
    confirms = [e for e in effects if e["effect"] == "confirm"]
    if kind in DOCUMENT_KINDS:
        trap = DOCUMENT_KINDS[kind]
    if row.get("is_floor"):
        trap = (trap + "; " if trap else "") + "a floor: at least this much"
    if contests:
        e = contests[0]
        return "OPEN", "contested by a primary record (%s): %s" % (e["item"], e["why"]), trap
    if resolves:
        e = resolves[0]
        return "IS", "resolved by a primary record (%s): %s" % (e["item"], e["reading"]), trap
    if row["table"] == "relationship":
        if row.get("alleged"):
            return "OPEN", "alleged in a sworn or charging document", "an allegation, not a fact"
        if row.get("evidence_class") in LEAD_CLASSES:
            return "OPEN", "a lead: the primary record has not been read", trap
        return ("WAS" if row.get("period") else "IS"), "documented link (%s%s)" % (
            row.get("evidence_class"), ", rung %s" % row["rung"] if row.get("rung") is not None else ""), row.get("limitation")
    if (row.get("verification") or "").upper() in FAILED:
        return "OPEN", "not found at its locator (%s)" % row.get("verification"), trap
    if row.get("evidence_class") in LEAD_CLASSES:
        return "OPEN", "a lead: the primary record has not been read (%s)" % row.get("evidence_class"), trap
    if kind in ALLEGATION_KINDS:
        return "OPEN", "alleged in a charging document or affidavit", "an allegation, not a fact"
    if kind in UNRESOLVED_KINDS:
        return "OPEN", "the desk marked it unresolved", trap
    if kind in DOCUMENT_KINDS:
        return "IS", "the document states it" + (" (a second record agrees)" if confirms else ""), trap
    if kind in DERIVED_KINDS:
        return "WAS", "calculated from dated rows", trap
    why = "dated register row" + (" for %s" % row["period"] if row.get("period") else "")
    if confirms:
        why += "; a second record agrees (%s)" % ", ".join(sorted({e["item"] for e in confirms}))
    return "WAS", why, trap


# ---- the build --------------------------------------------------------------

def parse_formula(formula):
    """'A ÷ B' -> (numerator ids, denominator ids) or None."""
    if not formula or "÷" not in formula:
        return None
    left, right = formula.split("÷", 1)
    left = left.split("=")[-1]
    return ID_RX.findall(left), ID_RX.findall(right)


def build(L, passes, ledger_sha=None):
    rows = rows_of(L)
    eff, by_f, adds = pass_index(passes)
    worked = {}
    for P in passes:
        for it in P.get("items", []):
            for q in it.get("rq", []):
                worked.setdefault(q, []).append("%s/%s" % (P["id"], it["id"]))
    findings = {f["id"]: f for f in L.get("findings", []) or []}
    rq = {q["id"]: q for q in L.get("records_queue", []) or []}
    corrections = L.get("corrections", []) or []
    routes = []
    for rid in sorted(rows):
        r = rows[rid]
        st, why, trap = state_of(r, eff.get(rid, []))
        r.update({"state": st, "reason": why, "trap": trap})
        for fid in r["findings"] or ["(none)"]:
            routes.append({"finding": fid, "row": rid, "table": r["table"], "kind": r.get("kind"),
                           "value": r.get("value"), "state": st, "reason": why, "trap": trap,
                           "locator": r.get("locator"), "evidence_class": r.get("evidence_class"),
                           "verification": r.get("verification"), "proposed": False})
    for a in adds:
        st = a.get("state", "WAS")
        for fid in a.get("findings", []):
            routes.append({"finding": fid, "row": a["id"], "table": a.get("table"), "kind": a.get("kind"),
                           "value": a.get("amount_usd", a.get("value")), "state": st,
                           "reason": "proposed by %s from %s (%s)" % (a["item"], a.get("source"), a.get("locator")),
                           "trap": None, "locator": a.get("locator"), "evidence_class": "PASS_PROPOSED",
                           "verification": None, "proposed": True})
    # denominators
    dens = []
    for a in (L.get("verification") or {}).get("arithmetic", []) or []:
        pf = parse_formula(a.get("formula"))
        if not pf:
            continue
        num, den = pf
        flags = []
        ins = [rows.get(i) for i in num + den]
        if any(x and x["state"] == "OPEN" for x in ins):
            flags.append("OPEN INPUT")
        if any(x and x.get("is_floor") for x in (rows.get(i) for i in num)):
            flags.append("FLOOR NUMERATOR (the share is at least this)")
        if any(x and x.get("is_floor") for x in (rows.get(i) for i in den)):
            flags.append("FLOOR DENOMINATOR (the share is at most this)")
        snaps = {x.get("snapshot") for x in ins if x and x.get("snapshot")}
        if len(snaps) > 1:
            flags.append("DIFFERENT SNAPSHOTS (%s)" % ", ".join(sorted(snaps)))
        locs = {(x.get("locator") or "").split(":")[0] for x in ins if x}
        if len(locs) > 1:
            flags.append("DIFFERENT RECORDS (%s)" % ", ".join(sorted(locs)))
        for i in num + den:
            for e in eff.get(i, []):
                if e["effect"] == "contest":
                    flags.append("CONTESTED %s (%s)" % (i, e["item"]))
        for fig in a.get("figures") or []:
            for e in eff.get(fig, []):
                if e["effect"] == "contest":
                    flags.append("CONTESTED RESULT %s (%s): %s" % (fig, e["item"], e["why"]))
        dens.append({"id": a["id"], "label": a.get("label"), "formula": a.get("formula"), "numerator": num,
                     "denominator": den, "result": a.get("computed"), "status": a.get("status"),
                     "figures": a.get("figures") or [], "flags": flags})
    for a in adds:
        if a.get("numerator") and a.get("denominator"):
            dens.append({"id": a["id"], "label": a.get("label"), "formula": "%s ÷ %s" % (a["numerator"], a["denominator"]),
                         "numerator": [a["numerator"]], "denominator": [a["denominator"]], "result": a.get("value"),
                         "status": "PROPOSED", "figures": [a["id"]], "flags": ["PROPOSED by %s" % a["item"]]})
    # the ladder
    ladder = {}
    for fid in sorted(findings):
        f = findings[fid]
        rung = RUNG.get(f.get("publication"), 0)
        if rung == 3 and str(f.get("status", "")).upper().startswith("CORROBORAT"):
            rung = 4
        mine = [x for x in routes if x["finding"] == fid]
        counts = {s: sum(1 for x in mine if x["state"] == s and not x["proposed"]) for s in ("IS", "WAS", "OPEN")}
        blockers, next_steps = [], []
        contested = sorted({x["row"] for x in mine if x["state"] == "OPEN" and x["reason"].startswith("contested")})
        if contested:
            blockers.append("%d contested number(s): %s" % (len(contested), ", ".join(contested[:6]) + (" …" if len(contested) > 6 else "")))
        leads = sorted({x["row"] for x in mine if x["state"] == "OPEN" and x["reason"].startswith("a lead")})
        if leads:
            blockers.append("%d lead(s) resting on notes or secondary reports: %s" % (len(leads), ", ".join(leads[:6])))
        pp = f.get("proof_profile") or {}
        if isinstance(pp, dict) and pp.get("numbers_failed"):
            blockers.append("%s number(s) failed verification" % pp["numbers_failed"])
        for q in f.get("missing_records") or []:
            item = rq.get(q)
            if not item:
                continue
            open_q = not str(item.get("status") or "").lower().startswith(("resolved", "done", "closed"))
            if open_q and q in worked:
                next_steps.append({"record": q, "action": "review", "target": "worked in %s: read it, then update the queue" % ", ".join(worked[q]),
                                   "url": None, "authorization": False})
            elif open_q:
                blockers.append("%s %s open: %s" % (q, item.get("priority", ""), item.get("question", "")))
                next_steps.append({"record": q, "action": item.get("action_type"), "target": item.get("record_target"),
                                   "url": item.get("url"), "authorization": item.get("action_type") in ("records_request", "voluntary_request")})
        answered = []
        for pid, it in by_f.get(fid, []):
            for ans in it.get("answered", []):
                if ans.get("finding") == fid:
                    answered.append({"pass": pid, "item": it["id"], "question": ans.get("question"),
                                     "answer": ans.get("answer"), "fully": ans.get("fully")})
            prop = (it.get("proposed") or {}).get(fid)
            if prop:
                next_steps.append({"record": it["id"], "action": "pass_proposal", "target": prop, "url": None, "authorization": False})
        for c in corrections:
            if fid in (c.get("findings") or []) and str(c.get("status", "")).upper().startswith(("OPEN", "HOLD")):
                blockers.append("correction %s: %s" % (c["id"], (c.get("what_is_right") or c.get("title") or "")[:90]))
        for P in passes:
            for c in P.get("corrections_proposed", []):
                if fid in c.get("findings", []):
                    blockers.append("proposed correction %s (%s): %s" % (c["id"], P["id"], c["what_is_right"][:100]))
        ladder[fid] = {"title": f.get("title"), "publication": f.get("publication"), "rung": rung,
                       "rung_name": RUNG_NAME[rung], "counts": counts, "blockers": blockers,
                       "answered": answered, "next": next_steps}
    open_items = []
    for x in routes:
        if x["state"] == "OPEN":
            open_items.append({"kind": "row", "finding": x["finding"], "id": x["row"], "why": x["reason"]})
    for q in sorted(rq):
        item = rq[q]
        if not str(item.get("status") or "").lower().startswith(("resolved", "done", "closed")):
            open_items.append({"kind": "record", "finding": None, "id": q, "priority": item.get("priority"),
                               "why": item.get("question"), "settle_by": item.get("record_target"), "url": item.get("url"),
                               "action": item.get("action_type"), "worked_in": worked.get(q)})
    for P in passes:
        for it in P.get("items", []):
            for fct in it.get("facts", []):
                if fct.get("state") == "OPEN":
                    open_items.append({"kind": "pass", "finding": ",".join(it.get("findings", [])), "id": fct["id"],
                                       "why": fct["text"], "settle_by": fct.get("settle_by")})
    body = {"schema": "tsr.routes/1", "version": VERSION,
            "ledger": {"sha256": ledger_sha, "schema": (L.get("meta") or {}).get("schema"),
                       "as_of": (L.get("meta") or {}).get("as_of")},
            "passes": [{"id": P["id"], "sha256": sha256_file(P["_path"]) if P.get("_path") else None} for P in passes],
            "states": {"IS": "concrete now: the record says it today, checked at its locator",
                       "WAS": "concrete for a stated past date or period; says nothing about today",
                       "OPEN": "not concrete: question, lead, allegation, contested number or gap"},
            "counts": {s: sum(1 for x in routes if x["state"] == s and not x["proposed"]) for s in ("IS", "WAS", "OPEN")},
            "proposed_rows": sum(1 for x in routes if x["proposed"]),
            "routes": sorted(routes, key=lambda x: (x["finding"], x["row"])),
            "denominators": dens, "ladder": ladder, "open": open_items}
    canon = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    body["digest"] = hashlib.sha256(canon).hexdigest()
    return body


# ---- the IE audit -----------------------------------------------------------

def ie_audit(L, notices_csv):
    rows = [r for r in L.get("money_flows", []) or [] if r.get("kind") in ("IE_SUPPORT", "IE_OPPOSE")]
    ents = {e["id"]: e for e in L.get("entities", []) or []}
    with open(notices_csv, "r", encoding="latin-1") as fh:
        raw = list(csv.DictReader(fh))
    best = {}
    for r in raw:
        k = (r["spe_id"], r["tran_id"])
        if k not in best or int(r["file_num"] or 0) > int(best[k]["file_num"] or 0):
            best[k] = r
    ie = list(best.values())
    names = {}
    for r in ie:
        names.setdefault(r["spe_nam"].strip().upper(), set()).add(r["spe_id"])

    def when(s):
        for fmt in ("%d-%b-%y", "%Y-%m-%d", "%m/%d/%Y"):
            try:
                return datetime.datetime.strptime(s, fmt).date()
            except (TypeError, ValueError):
                continue
        return None

    def committee(eid):
        e = ents.get(eid) or {}
        ids = e.get("identifiers")
        if isinstance(ids, str):
            try:
                ids = json.loads(ids or "{}")
            except ValueError:
                ids = {}
        if isinstance(ids, dict) and ids.get("fec_committee_id"):
            return ids["fec_committee_id"]
        nm = (e.get("name") or "").upper()
        for n, s in names.items():
            if nm and (nm in n or n in nm):
                return sorted(s)[0]
        return None

    out = []
    for r in rows:
        cid = committee(r.get("from"))
        nm = ((ents.get(r.get("to")) or {}).get("name") or "").replace("Rep. ", "").split()
        last = nm[-1].upper() if nm else None
        so = "S" if r["kind"] == "IE_SUPPORT" else "O"
        snap = when(r.get("snapshot") or "") or datetime.date.max
        m = [x for x in ie if x["spe_id"] == cid and x["sup_opp"] == so and last and last in x["cand_name"].upper()]
        at = round(sum(float(x["exp_amo"] or 0) for x in m if (when(x["dissem_dt"]) or when(x["exp_date"]) or datetime.date.min) <= snap), 2)
        ratio = round(float(r["amount_usd"]) / at, 3) if at else None
        if ratio is None:
            cls = "NO NOTICES"
        elif 1.95 <= ratio <= 2.06:
            cls = "DOUBLED"
        elif 0.995 <= ratio <= 1.005:
            cls = "MATCHES"
        elif ratio > 1.005:
            cls = "OVER"
        else:
            cls = "UNDER"
        out.append({"row": r["id"], "finding": ",".join(r.get("findings") or []), "committee": cid,
                    "candidate": " ".join(nm), "side": so, "ledger": r["amount_usd"], "snapshot": r.get("snapshot"),
                    "notices_to_snapshot": at, "ratio": ratio, "class": cls})
    return out


# ---- printing ---------------------------------------------------------------

def money(v):
    if v is None:
        return ""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return str(v)
    if abs(v) < 1 and v != 0:
        return "%.1f%%" % (v * 100)
    return "$" + format(v, ",.2f").replace(".00", "")


def w(out, s=""):
    out.write(s + "\n")


def print_finding(R, fid, out):
    lad = R["ladder"].get(fid)
    if not lad:
        w(out, "unknown finding: %s" % fid)
        return 2
    w(out, "%s  %s" % (fid, lad["title"]))
    w(out, "  rung       %d · %s (%s)" % (lad["rung"], lad["rung_name"], lad["publication"]))
    w(out, "  states     IS %d · WAS %d · OPEN %d" % (lad["counts"]["IS"], lad["counts"]["WAS"], lad["counts"]["OPEN"]))
    w(out, "")
    for x in [r for r in R["routes"] if r["finding"] == fid]:
        w(out, "  %-4s %-22s %-24s %14s  %s%s" % (x["state"], x["row"], (x["kind"] or "")[:24], money(x["value"]),
                                                 x["reason"][:110], "  [proposed]" if x["proposed"] else ""))
        if x.get("trap"):
            w(out, "  %-4s %-22s never read as: %s" % ("", "", x["trap"]))
    for a in lad["answered"]:
        w(out, "\n  answered   %s (%s): %s" % (a["question"], a["item"], a["answer"]))
    if lad["blockers"]:
        w(out, "\n  blockers")
        for b in lad["blockers"]:
            w(out, "    - " + b)
    if lad["next"]:
        w(out, "\n  next")
        for n in lad["next"]:
            w(out, "    - %s %s: %s%s%s" % (n["record"], n["action"] or "", (n["target"] or "")[:120],
                                        ("  " + n["url"]) if n.get("url") else "",
                                        "  (needs your authorization)" if n.get("authorization") else ""))
    return 0


def print_row(R, rid, out):
    xs = [r for r in R["routes"] if r["row"] == rid]
    if not xs:
        w(out, "no row %s in the route ledger" % rid)
        return 2
    x = xs[0]
    w(out, "%s  %s  %s  %s" % (rid, x["table"], x["kind"] or "", money(x["value"])))
    w(out, "  state   %s — %s" % (x["state"], x["reason"]))
    if x.get("trap"):
        w(out, "  never   %s" % x["trap"])
    w(out, "  locator %s  (%s, verification %s)" % (x.get("locator"), x.get("evidence_class"), x.get("verification")))
    w(out, "  feeds   %s" % ", ".join(sorted({r["finding"] for r in xs})))
    for d in R["denominators"]:
        if rid in d["denominator"]:
            w(out, "  divides %s: %s = %s" % (d["id"], d["formula"], d["result"]))
        if rid in d["numerator"]:
            w(out, "  divided %s: %s = %s" % (d["id"], d["formula"], d["result"]))
    return 0


def print_denominators(R, flagged, out):
    n = 0
    for d in R["denominators"]:
        if flagged and not d["flags"]:
            continue
        n += 1
        w(out, "%-22s %s" % (d["id"], (d["label"] or "")[:90]))
        w(out, "   %s = %s  [%s]" % (d["formula"], d["result"], d["status"]))
        for f in d["flags"]:
            w(out, "   ! %s" % f)
    w(out, "\n%d division(s)%s" % (n, " with flags" if flagged else ""))
    return 0


def print_open(R, p1, out):
    n = 0
    for o in R["open"]:
        if p1 and o.get("priority") != "P1" and o["kind"] != "pass":
            continue
        n += 1
        tag = {"row": "ROW", "record": "RECORD", "pass": "PASS"}[o["kind"]]
        w(out, "%-6s %-14s %s%s%s" % (tag, o["id"], ("[%s] " % o["priority"]) if o.get("priority") else "", (o["why"] or "")[:140],
                                     ("  (worked in %s)" % ", ".join(o["worked_in"])) if o.get("worked_in") else ""))
        if o.get("settle_by"):
            w(out, "       %-14s settles with: %s" % ("", str(o["settle_by"])[:150]))
    w(out, "\n%d open item(s)" % n)
    return 0


def print_ladder(R, fid, out):
    if fid:
        return print_finding(R, fid, out)
    w(out, "%-10s %-5s %-26s %5s %5s %5s  %s" % ("FINDING", "RUNG", "PUBLICATION", "IS", "WAS", "OPEN", "FIRST BLOCKER"))
    for k in sorted(R["ladder"], key=lambda k: (-R["ladder"][k]["rung"], k)):
        v = R["ladder"][k]
        w(out, "%-10s %-5d %-26s %5d %5d %5d  %s" % (k, v["rung"], v["publication"] or "", v["counts"]["IS"],
                                                    v["counts"]["WAS"], v["counts"]["OPEN"], (v["blockers"][0] if v["blockers"] else "-")[:80]))
    return 0


def print_pass(passes, sid, out):
    if not passes:
        w(out, "no strength passes in evidence/ledger/passes/")
        return 1
    for P in passes:
        w(out, "%s  %s  (%s)" % (P["id"], P.get("title", ""), P.get("prepared", "")))
        for it in P.get("items", []):
            if sid and it["id"] != sid:
                continue
            w(out, "\n  %s  %s   [%s]" % (it["id"], it["title"], ", ".join(it.get("findings", []))))
            for f in it.get("facts", []):
                w(out, "    %-4s %s" % (f["state"], f["text"]))
                if f.get("settle_by"):
                    w(out, "         settles with: %s" % f["settle_by"])
            c = it.get("confirms", [])
            x = it.get("contests", [])
            if c or x:
                w(out, "    confirms %d · contests %d · adds %d" % (len(c), len(x), len(it.get("adds", []))))
            if sid:
                for k, v in (it.get("proposed") or {}).items():
                    w(out, "    propose  %s: %s" % (k, v))
    return 0


# ---- cli --------------------------------------------------------------------

def root_dir(given):
    if given:
        return os.path.abspath(given)
    if os.environ.get("SENTINEL_ROOT"):
        return os.path.abspath(os.environ["SENTINEL_ROOT"])
    return os.path.abspath(os.path.join(HERE, "..", ".."))


def default_ledger(root):
    for p in ("evidence/ledger/current.json", "modules/ledger/data/ledger.json"):
        if os.path.isfile(os.path.join(root, p)):
            return os.path.join(root, p)
    return None


def default_passes(root):
    d = os.path.join(root, "evidence", "ledger", "passes")
    if not os.path.isdir(d):
        return []
    return sorted(os.path.join(d, n) for n in os.listdir(d) if n.endswith(".json"))


def main(argv):
    ap = argparse.ArgumentParser(prog="sentinel-routes")
    ap.add_argument("--root", help=argparse.SUPPRESS)
    ap.add_argument("--ledger")
    ap.add_argument("--pass", dest="passes", action="append")
    ap.add_argument("--json", action="store_true")
    sub = ap.add_subparsers(dest="cmd")
    b = sub.add_parser("build")
    b.add_argument("--out")
    sub.add_parser("finding").add_argument("id")
    sub.add_parser("row").add_argument("id")
    d = sub.add_parser("denominators")
    d.add_argument("--flagged", action="store_true")
    o = sub.add_parser("open")
    o.add_argument("--p1", action="store_true")
    sub.add_parser("ladder").add_argument("id", nargs="?")
    sub.add_parser("pass").add_argument("id", nargs="?")
    ia = sub.add_parser("ie-audit")
    ia.add_argument("--notices", required=True)
    sub.add_parser("verify")
    sub.add_parser("selftest")
    sub.add_parser("version")
    a = ap.parse_args(argv)
    out = sys.stdout
    if not a.cmd:
        out.write(__doc__)
        return 0
    if a.cmd == "version":
        w(out, VERSION)
        return 0
    if a.cmd == "selftest":
        sys.path.insert(0, HERE)
        import selftest
        return selftest.main()
    root = root_dir(a.root)
    lp = a.ledger or default_ledger(root)
    if not lp or not os.path.isfile(lp):
        w(out, "no ledger found: install one with bin/sentinel-ledger install-data, or pass --ledger PATH")
        return 2
    L = load_ledger(lp)
    passes = load_passes(a.passes if a.passes else default_passes(root))
    if a.cmd == "ie-audit":
        res = ie_audit(L, a.notices)
        if a.json:
            json.dump(res, out, indent=1)
            return 0
        for r in res:
            w(out, "%-14s %-9s %-10s %-22s %s  ledger %14s  notices %14s  %-8s %s" % (
                r["row"], r["finding"], r["committee"] or "?", r["candidate"][:22], r["side"], money(r["ledger"]),
                money(r["notices_to_snapshot"]), r["ratio"] if r["ratio"] is not None else "-", r["class"]))
        counts = {}
        for r in res:
            counts[r["class"]] = counts.get(r["class"], 0) + 1
        w(out, "\n%d IE rows: %s" % (len(res), " · ".join("%s %d" % kv for kv in sorted(counts.items()))))
        w(out, "DOUBLED means the row equals twice the notices to its snapshot date: counted once as a notice and again on Schedule E.")
        return 0
    R = build(L, passes, sha256_file(lp))
    if a.cmd == "build":
        dest = a.out or os.path.join(root, "evidence", "ledger", "routes.json")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        R2 = dict(R, built=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        with open(dest, "w", encoding="utf-8") as fh:
            json.dump(R2, fh, indent=1, ensure_ascii=False, sort_keys=True)
        cpath = os.path.splitext(dest)[0] + ".csv"
        with open(cpath, "w", encoding="utf-8", newline="") as fh:
            cw = csv.writer(fh)
            cw.writerow(["finding", "row", "table", "kind", "value", "state", "reason", "never_read_as", "locator",
                         "evidence_class", "verification", "proposed"])
            for x in R["routes"]:
                cw.writerow([x["finding"], x["row"], x["table"], x["kind"], x["value"], x["state"], x["reason"],
                             x["trap"] or "", x["locator"], x["evidence_class"], x["verification"], x["proposed"]])
        w(out, "ROUTE LEDGER  %s" % VERSION)
        w(out, "ledger    %s  (sha256 %s…)" % (os.path.relpath(lp, root) if lp.startswith(root) else os.path.basename(lp), R["ledger"]["sha256"][:12]))
        w(out, "passes    %s" % (", ".join(p["id"] for p in R["passes"]) or "none"))
        w(out, "routes    %d  ·  IS %d · WAS %d · OPEN %d  ·  proposed rows %d" % (
            len(R["routes"]), R["counts"]["IS"], R["counts"]["WAS"], R["counts"]["OPEN"], R["proposed_rows"]))
        w(out, "divisions %d  (%d flagged)" % (len(R["denominators"]), sum(1 for d_ in R["denominators"] if d_["flags"])))
        w(out, "open      %d item(s)" % len(R["open"]))
        w(out, "wrote     %s and %s" % (os.path.relpath(dest, root), os.path.relpath(cpath, root)))
        w(out, "digest    %s" % R["digest"])
        return 0
    if a.json:
        json.dump(R, out, indent=1, ensure_ascii=False)
        return 0
    if a.cmd == "finding":
        return print_finding(R, a.id, out)
    if a.cmd == "row":
        return print_row(R, a.id, out)
    if a.cmd == "denominators":
        return print_denominators(R, a.flagged, out)
    if a.cmd == "open":
        return print_open(R, a.p1, out)
    if a.cmd == "ladder":
        return print_ladder(R, a.id, out)
    if a.cmd == "pass":
        return print_pass(passes, a.id, out)
    if a.cmd == "verify":
        dest = os.path.join(root, "evidence", "ledger", "routes.json")
        if not os.path.isfile(dest):
            w(out, "no routes.json yet: bin/sentinel-routes build")
            return 1
        with open(dest, "r", encoding="utf-8") as fh:
            saved = json.load(fh)
        same = saved.get("digest") == R["digest"]
        w(out, "routes.json digest %s" % saved.get("digest"))
        w(out, "rebuilt     digest %s" % R["digest"])
        w(out, "result      %s" % ("SAME: the saved route ledger matches the ledger and passes on disk" if same else
                                  "DIFFERENT: the ledger or a pass changed since the last build (run build)"))
        return 0 if same else 1
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(0)
