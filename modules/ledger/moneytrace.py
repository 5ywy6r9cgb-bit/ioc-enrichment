# -*- coding: utf-8 -*-
"""Follow the money through the ledger, hop by hop, without ever adding different kinds of money.

    ledger trace "Clock Tower X"            downstream from an entity (name, alias or E:id)
    ledger trace E:udp --up --hops 2        who funded it
    ledger trace E:x --kind IE_OPPOSE       one kind only
    ledger trace E:x --json                 the same, machine-readable (the site draws from this)

At every entity the trace shows what came in and what went out, by kind, side by side. When money
arrives as one kind and leaves as another (contributions in, independent expenditures out) the
trace says so: those are not the same dollars and are never netted. A branch that stops is marked
with why: no outflow rows held (absence is not concealment), recipients unresolved, or hop limit.
"""
import json
import re
from collections import defaultdict
from decimal import Decimal

import lib_ledger as L


def _ents(ledger):
    return {e["id"]: e for e in ledger.get("entities", [])}


def resolve_entity(ledger, q):
    ents = _ents(ledger)
    if q in ents:
        return q
    ql = q.lower()
    exact = [e["id"] for e in ents.values() if (e.get("name") or "").lower() == ql or ql in [a.lower() for a in e.get("aliases") or []]]
    if len(exact) == 1:
        return exact[0]
    part = [e["id"] for e in ents.values() if ql in (e.get("name") or "").lower()]
    if len(part) == 1:
        return part[0]
    if not part and not exact:
        raise KeyError("no entity matches '{}'".format(q))
    raise KeyError("'{}' matches {} entities: {}".format(q, len(exact or part), ", ".join((exact or part)[:8])))


def shown(ents, eid):
    e = ents.get(eid)
    if not e:
        return eid
    if e.get("public_figure_or_org") is False:
        return "(private party, not named)"
    return e.get("name") or eid


def trace(ledger, start, direction="down", kinds=None, hops=3):
    ents = _ents(ledger)
    ver = {m["id"]: m.get("verification") for m in ledger.get("money_flows", [])}
    rows = [m for m in ledger.get("money_flows", []) if not kinds or m["kind"] in kinds]
    out_of, into = defaultdict(list), defaultdict(list)
    for m in rows:
        out_of[m["from"]].append(m)
        into[m["to"]].append(m)
    unresolved = {r["to"] for r in ledger.get("relationships", []) if r.get("type") == "UNRESOLVED_RECIPIENTS"}
    seen = {start: 0}
    frontier = [start]
    edges, stops = [], []
    for h in range(1, hops + 1):
        nxt = []
        for n in frontier:
            lst = out_of[n] if direction == "down" else into[n]
            if not lst:
                why = "recipients unresolved in every filing reviewed" if n in unresolved else \
                      ("no outflow rows held for this party (absence is not concealment)" if direction == "down" else "no inflow rows held for this party")
                if n != start or not edges:
                    stops.append({"at": n, "name": shown(ents, n), "why": why, "hop": h - 1})
                continue
            groups = defaultdict(list)
            for m in lst:
                other = m["to"] if direction == "down" else m["from"]
                groups[(other, m["kind"])].append(m)
            for (other, kind), ms in sorted(groups.items(), key=lambda kv: (-sum(Decimal(str(x["amount_usd"] or 0)) for x in kv[1]), kv[0])):
                amt = sum(Decimal(str(x["amount_usd"])) for x in ms if x.get("amount_usd") is not None)
                edges.append({"hop": h, "from": ms[0]["from"], "to": ms[0]["to"], "from_name": shown(ents, ms[0]["from"]), "to_name": shown(ents, ms[0]["to"]),
                              "kind": kind, "rows": [x["id"] for x in ms], "sum_usd_within_kind": str(amt) if amt else None,
                              "any_floor": any(x.get("is_floor") for x in ms), "periods": sorted(set(x.get("period") or "" for x in ms)),
                              "locators": [x.get("locator") for x in ms][:4], "verification": sorted(set(str(ver.get(x["id"])) for x in ms)),
                              "texts": [x.get("amount_text") for x in ms if x.get("amount_text")][:2]})
                if other not in seen:
                    seen[other] = h
                    nxt.append(other)
        frontier = nxt
    for n in frontier:
        if (out_of[n] if direction == "down" else into[n]):
            stops.append({"at": n, "name": shown(ents, n), "why": "hop limit reached; more rows continue", "hop": hops})
        else:
            why = "recipients unresolved in every filing reviewed" if n in unresolved else \
                  ("no outflow rows held for this party (absence is not concealment)" if direction == "down" else "no inflow rows held for this party")
            stops.append({"at": n, "name": shown(ents, n), "why": why, "hop": hops})
    nodes = {}
    for n in seen:
        ins, outs = defaultdict(Decimal), defaultdict(Decimal)
        for m in into[n]:
            if m.get("amount_usd") is not None:
                ins[m["kind"]] += Decimal(str(m["amount_usd"]))
        for m in out_of[n]:
            if m.get("amount_usd") is not None:
                outs[m["kind"]] += Decimal(str(m["amount_usd"]))
        changes = sorted(set(outs) - set(ins)) if ins and outs else []
        nodes[n] = {"id": n, "name": shown(ents, n), "hop": seen[n], "in_by_kind": {k: str(v) for k, v in sorted(ins.items())},
                    "out_by_kind": {k: str(v) for k, v in sorted(outs.items())},
                    "kind_change": ("in as {}; out as {} — not the same dollars, never netted".format(", ".join(sorted(ins)), ", ".join(changes))) if changes else None}
    return {"start": start, "start_name": shown(ents, start), "direction": direction, "kinds": kinds, "hops": hops,
            "edges": edges, "nodes": list(nodes.values()), "stops": stops,
            "rule": "Sums are within one kind of money only. Different kinds are never added."}


def render(t):
    arrow = "→" if t["direction"] == "down" else "←"
    out = ["TRACE {} {} ({}; {} hop(s){})".format(arrow, t["start_name"], "downstream" if t["direction"] == "down" else "upstream", t["hops"],
                                                   "; kinds " + ", ".join(t["kinds"]) if t["kinds"] else "")]
    for e in t["edges"]:
        amt = L.money(Decimal(e["sum_usd_within_kind"])) if e["sum_usd_within_kind"] else (e["texts"][0] if e["texts"] else "amount not stated")
        other = e["to_name"] if t["direction"] == "down" else e["from_name"]
        here = e["from_name"] if t["direction"] == "down" else e["to_name"]
        out.append("{}hop {}  {} {} {}".format("  " * (e["hop"] - 1), e["hop"], here[:38], arrow, other[:44]))
        out.append("{}        {:<26} {:>16}{}  {} row(s)  {}".format("  " * (e["hop"] - 1), e["kind"], ("at least " if e["any_floor"] else "") + amt,
                                                               "", len(e["rows"]), ", ".join(e["rows"][:3]) + (" …" if len(e["rows"]) > 3 else "")))
    kc = [n for n in t["nodes"] if n["kind_change"]]
    if kc:
        out.append("\nWHERE MONEY CHANGES KIND")
        for n in kc:
            out.append("  {}: {}".format(n["name"][:50], n["kind_change"]))
    if t["stops"]:
        out.append("\nWHERE THE TRAIL STOPS")
        for s in t["stops"]:
            out.append("  {}: {}".format(s["name"][:50], s["why"]))
    out.append("\n" + t["rule"])
    return "\n".join(out)


def main(args):
    lg = L.load(L.find_ledger(args.ledger))
    try:
        start = resolve_entity(lg, args.entity)
    except KeyError as e:
        L.die(str(e))
    kinds = [k.strip().upper() for k in args.kind.split(",")] if args.kind else None
    t = trace(lg, start, "up" if args.up else "down", kinds, args.hops)
    print(json.dumps(t, indent=1, ensure_ascii=False) if args.json else render(t))
    return 0
