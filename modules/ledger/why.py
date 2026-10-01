# -*- coding: utf-8 -*-
"""ledger why F-ID: the investigation screen for one finding.

  EVENT · BEFORE / AFTER · ACTORS · FLOWS · RELATIONSHIPS (typed, with rung)
  CAUSAL STATUS · COMPETING EXPLANATIONS · DISCRIMINATOR · WHAT WOULD CHANGE OUR MIND

"What changed immediately before this?" is more useful than "what is connected?", so the screen
opens with the timeline around the finding's own events. Everything shown comes from the ledger.
"""
import datetime
import re
import textwrap
from collections import defaultdict
from decimal import Decimal

import lib_ledger as L


def _date(s):
    m = re.match(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", s or "")
    if not m:
        return None
    return datetime.date(int(m.group(1)), int(m.group(2) or 1), int(m.group(3) or 1))


def screen(ledger, fid, window_days=180):
    f = next((x for x in ledger["findings"] if x["id"] == fid), None)
    if f is None:
        raise KeyError("no finding " + fid)
    ents = {e["id"]: e for e in ledger.get("entities", [])}
    tl = ledger.get("timeline", [])
    own = [e for e in tl if fid in e.get("findings", [])]
    anchor_dates = [d for d in (_date(e["date"]) for e in own) if d]
    before, after = [], []
    if anchor_dates:
        lo, hi = min(anchor_dates), max(anchor_dates)
        for e in tl:
            if e in own:
                continue
            d = _date(e["date"])
            if not d:
                continue
            if lo - datetime.timedelta(days=window_days) <= d < lo:
                before.append(e)
            elif hi < d <= hi + datetime.timedelta(days=window_days):
                after.append(e)
    flows = defaultdict(lambda: {"sum": Decimal(0), "rows": 0, "floor": False})
    for m in ledger.get("money_flows", []):
        if fid in m.get("findings", []):
            k = flows[(m["kind"], m["from"], m["to"])]
            k["sum"] += Decimal(str(m["amount_usd"] or 0))
            k["rows"] += 1
            k["floor"] = k["floor"] or m.get("is_floor")
    rels = [r for r in ledger.get("relationships", []) if fid in (r.get("findings") or [])]
    name = lambda i: ("(private party, not named)" if ents.get(i, {}).get("public_figure_or_org") is False else ents.get(i, {}).get("name", i))
    rq = {r["id"]: r for r in ledger.get("records_queue", [])}
    return {"finding": f, "own_events": own, "before": before, "after": after,
            "actors": [(name(e), ents.get(e, {}).get("type")) for e in f.get("entities", [])],
            "flows": [{"kind": k[0], "from": name(k[1]), "to": name(k[2]), "sum": v["sum"], "rows": v["rows"], "floor": v["floor"]} for k, v in flows.items()],
            "relationships": [{"id": r["id"], "from": name(r["from"]), "to": name(r["to"]), "class": r.get("rel_class"), "rung": r.get("rung"),
                               "level": r.get("level"), "alleged": r.get("alleged")} for r in rels],
            "causal": f.get("causal") or {}, "records": [rq[x] for x in f.get("missing_records", []) if x in rq]}


def render(sc, width=78):
    f = sc["finding"]
    bar = "─" * width
    w = lambda t, ind="  ": textwrap.fill(t, width - 2, initial_indent=ind, subsequent_indent=ind)
    out = ["┌" + bar + "┐", "  EVENT  {}  [{} · {} · {}]".format(f["id"], f["glassmark"], f["evidence_class"], f["publication"]), w(f["headline"]), "├" + bar + "┤"]
    out.append("  BEFORE (180 days)                    │ AFTER (180 days)")
    rows = max(len(sc["before"]), len(sc["after"]), 1)
    for i in range(min(rows, 6)):
        b = sc["before"][i] if i < len(sc["before"]) else None
        a = sc["after"][i] if i < len(sc["after"]) else None
        out.append("  {:<36} │ {}".format((b["date"] + " " + b["event"])[:36] if b else "", (a["date"] + " " + a["event"])[:38] if a else ""))
    for e in sc["own_events"][:3]:
        out.append("  this finding: {} {}".format(e["date"], e["event"][:56]))
    out.append("├" + bar + "┤")
    out.append("  ACTORS  " + " | ".join("{} ({})".format(n, t) for n, t in sc["actors"][:6]))
    if sc["flows"]:
        out.append("  FLOWS (money, by kind; never summed across kinds)")
        for fl in sc["flows"][:6]:
            out.append("    {:<24} {} → {}  {}{} ({} row{})".format(fl["kind"], fl["from"][:22], fl["to"][:22], "at least " if fl["floor"] else "",
                                                             L.money(fl["sum"]), fl["rows"], "" if fl["rows"] == 1 else "s"))
    if sc["relationships"]:
        out.append("  RELATIONSHIPS (class · causal rung · link level)")
        for r in sc["relationships"][:6]:
            out.append("    {} {} → {}  {} · C{} · B{}{}".format(r["id"], r["from"][:24], r["to"][:24], r["class"], r["rung"], r["level"], " · ALLEGED" if r["alleged"] else ""))
    c = sc["causal"]
    out.append("├" + bar + "┤")
    out.append("  CAUSAL STATUS  {} {}{}".format(c.get("rung_code", "C0"), c.get("rung_name", "OBSERVED"), "  (alleged)" if c.get("alleged") else ""))
    out.append("├" + bar + "┤")
    out.append("  COMPETING EXPLANATIONS")
    for h in c.get("competing", []):
        out.append(w("{} {}: {}".format(h["id"], h["label"], h["text"]), "    "))
    out.append("├" + bar + "┤")
    out.append("  DISCRIMINATOR")
    out.append(w(f.get("discriminator") or "not written", "    "))
    out.append("  WHAT WOULD CHANGE OUR MIND")
    for r in sc["records"][:4]:
        out.append(w("{} ({}): {}".format(r["id"], r["status"], r["what_it_resolves"]), "    "))
    out.append("  WHAT THIS DOES NOT SHOW")
    for d in f.get("does_not_show", [])[:5]:
        out.append(w("- " + d, "    "))
    out.append("└" + bar + "┘")
    return "\n".join(out)


def main(args):
    lg = L.load(L.find_ledger(args.ledger))
    try:
        sc = screen(lg, args.finding, args.window)
    except KeyError as e:
        L.die(str(e))
    print(render(sc))
    return 0
