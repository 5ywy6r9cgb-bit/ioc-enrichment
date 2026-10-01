# -*- coding: utf-8 -*-
"""Address neighbourhoods from stored rows only. The graph knows what was fetched, nothing else;
an empty neighbourhood is a statement about the fetch, not about the address.

Edges are aggregated per (from, to, token identity): count, raw sum, first/last block and the
weakest verification level among the rows. Different tokens are different edges, never summed.
For Bitcoin the graph is address → tx → address, because that is what the chain records.
"""
from collections import defaultdict, deque

import models as M


def neighbourhood(rows, center, hops=2, token_key=None, max_nodes=400):
    c = center.lower() if center.startswith("0x") else center
    rows = [t for t in rows if token_key is None or t["token_key"] == token_key]
    adj = defaultdict(list)
    for t in rows:
        adj[t["from_address"]].append(t)
        adj[t["to_address"]].append(t)
    seen, q, used = {c: 0}, deque([c]), {}
    while q and len(seen) < max_nodes:
        n = q.popleft()
        if seen[n] >= hops:
            continue
        for t in adj.get(n, []):
            used[M.transfer_key(t)] = t
            other = t["to_address"] if t["from_address"] == n else t["from_address"]
            if other not in seen:
                seen[other] = seen[n] + 1
                q.append(other)
    edges = {}
    for t in used.values():
        k = (t["from_address"], t["to_address"], t["token_key"])
        e = edges.setdefault(k, {"from": k[0], "to": k[1], "token_key": k[2], "symbol": t["asset_symbol"], "decimals": t.get("decimals"),
                                 "count": 0, "sum_raw": 0, "first_block": None, "last_block": None, "levels": set()})
        e["count"] += 1
        e["sum_raw"] += int(t["amount_raw"])
        bn = t.get("block_number")
        if bn is not None:
            e["first_block"] = bn if e["first_block"] is None else min(e["first_block"], bn)
            e["last_block"] = bn if e["last_block"] is None else max(e["last_block"], bn)
        e["levels"].add(t.get("verification", "V0_REPORTED"))
    for e in edges.values():
        e["weakest_level"] = next((l for l in M.LEVELS if l in e["levels"]), "V0_REPORTED")
        e["levels"] = sorted(e["levels"])
    nodes = [{"id": n, "hop": h, "kind": "tx" if n.startswith("tx:") else ("script" if n.startswith("script:") else "address")} for n, h in seen.items()]
    return nodes, sorted(edges.values(), key=lambda e: (-e["count"], e["from"], e["to"]))


def fmt_amount(e):
    if e.get("decimals") is None:
        return "{} raw".format(e["sum_raw"])
    return M.fmt_units(M.Decimal(e["sum_raw"]) / (M.Decimal(10) ** int(e["decimals"])), 8 if e["symbol"] == "BTC" else 2, e["symbol"])


def render(nodes, edges, center, top=25):
    c = center.lower() if center.startswith("0x") else center
    out = ["GRAPH  {}  ({} nodes, {} edges from stored rows)".format(center, len(nodes), len(edges))]
    ins = [e for e in edges if e["to"] == c]
    outs = [e for e in edges if e["from"] == c]
    for title, lst, key in (("INTO the address", ins, "from"), ("OUT of the address", outs, "to")):
        out.append(title)
        for e in lst[:top]:
            out.append("  {:<66} {:>4}×  {:>26}  {}".format(e[key], e["count"], fmt_amount(e), e["weakest_level"]))
        if len(lst) > top:
            out.append("  … {} more".format(len(lst) - top))
    out.append("An edge is a recorded movement between two addresses. It is not a relationship between people.")
    return "\n".join(out)


def to_dot(nodes, edges, center):
    c = center.lower() if center.startswith("0x") else center
    L = ["digraph G {", '  rankdir=LR; node [shape=box, fontname="Helvetica", fontsize=10]; edge [fontname="Helvetica", fontsize=9];']
    for n in nodes:
        shape = "ellipse" if n["kind"] == "tx" else "box"
        style = ', style="bold"' if n["id"] == c else ""
        L.append('  "{}" [shape={}{}, label="{}"];'.format(n["id"], shape, style, n["id"][:14] + "…" if len(n["id"]) > 16 else n["id"]))
    for e in edges:
        dash = ', style="dashed"' if e["weakest_level"] in ("V0_REPORTED", "MISMATCH") else ""
        L.append('  "{}" -> "{}" [label="{}× {}"{}];'.format(e["from"], e["to"], e["count"], fmt_amount(e), dash))
    L.append("}")
    return "\n".join(L)
