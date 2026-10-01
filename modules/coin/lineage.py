# -*- coding: utf-8 -*-
"""Lineage: never store just the number.

  FINDING      "Address A received 4,728,122.00 USDC (Ethereum) between blocks X and Y"
    ↓ supported_by
  CALCULATION  kind, token, address, block range, rule, result, and the exact input rows
    ↓ inputs
  TRANSFERS    each row points at the evidence_id of the response it was read from
    ↓
  RESPONSE     provider, endpoint, retrieval time, SHA-256 of the bytes, chain, block, verification

`provenance --check` walks the chain back down and re-proves each link: the calculation
recomputes to the same result, every raw file still hashes to its id, and every transfer is
actually present in the bytes it cites.
"""
import json
from decimal import Decimal

import btc
import evidence as E
import evm
import models as M

SCHEMA = "tsr.coin.calc/1"
RULES = {
    "RECEIVED": "sum of amount where to_address = ADDRESS (one token identity; no conversion)",
    "SENT": "sum of amount where from_address = ADDRESS (one token identity; for Bitcoin: gross inputs spent, change included)",
    "COUNT_IN": "number of rows where to_address = ADDRESS",
    "COUNT_OUT": "number of rows where from_address = ADDRESS",
    "TX_COUNT": "number of distinct transaction hashes touching ADDRESS",
    "COUNTERPARTIES": "number of distinct other addresses (Bitcoin: distinct transactions) touching ADDRESS",
}


class MixedAssetsError(Exception):
    pass


def select(transfers, token_key, address, block_from=None, block_to=None):
    a = address.lower() if address.startswith("0x") else address
    out = []
    for t in transfers:
        if t["token_key"] != token_key:
            continue
        if a not in (t["from_address"], t["to_address"]):
            continue
        bn = t.get("block_number")
        if block_from is not None and (bn is None or bn < block_from):
            continue
        if block_to is not None and (bn is None or bn > block_to):
            continue
        out.append(t)
    return out


def _compute(kind, address, rows):
    a = address.lower() if address.startswith("0x") else address
    if kind == "RECEIVED":
        return sum(int(t["amount_raw"]) for t in rows if t["to_address"] == a)
    if kind == "SENT":
        return sum(int(t["amount_raw"]) for t in rows if t["from_address"] == a)
    if kind == "COUNT_IN":
        return sum(1 for t in rows if t["to_address"] == a)
    if kind == "COUNT_OUT":
        return sum(1 for t in rows if t["from_address"] == a)
    if kind == "TX_COUNT":
        return len(set(t["tx_hash"] for t in rows))
    if kind == "COUNTERPARTIES":
        return len(set((t["to_address"] if t["from_address"] == a else t["from_address"]) for t in rows))
    raise ValueError("unknown calculation kind " + kind)


def calculate(store, kind, token_key, address, rows, block_from=None, block_to=None, note=None):
    keys = set(t["token_key"] for t in rows)
    if len(keys) > 1:
        raise MixedAssetsError("refused: rows mix {} token identities {} — the same symbol on two chains is two assets".format(len(keys), sorted(keys)))
    if keys and keys != {token_key}:
        raise MixedAssetsError("rows are {} but the calculation is for {}".format(sorted(keys), token_key))
    raw = _compute(kind, address, rows)
    decimals = rows[0].get("decimals") if rows else None
    is_amount = kind in ("RECEIVED", "SENT")
    result = {"raw": str(raw)}
    if is_amount and decimals is not None:
        result["units"] = str(Decimal(raw) / (Decimal(10) ** int(decimals)))
        result["decimals"] = decimals
    body = {"kind": kind, "token_key": token_key, "address": address.lower() if address.startswith("0x") else address,
            "block_range": [block_from, block_to], "inputs": sorted(M.transfer_key(t) for t in rows), "result": result}
    calc = dict(body)
    calc.update({"schema": SCHEMA, "calc_id": "calc:" + E.sha256_hex(E.canonical(body))[:40], "rule": RULES[kind],
                 "unit": rows[0]["asset_symbol"] if rows and is_amount else ("rows" if not is_amount else None),
                 "input_evidence": sorted(set(t["evidence_id"] for t in rows)),
                 "input_verification": _level_counts(rows), "computed_at": E.now_utc(), "tool": E.TOOL, "note": note})
    store.put_calc(calc)
    return calc


def _level_counts(rows):
    c = {}
    for t in rows:
        c[t.get("verification", "V0_REPORTED")] = c.get(t.get("verification", "V0_REPORTED"), 0) + 1
    return c


def link_finding(store, finding_id, calc_ids, statement):
    for cid in calc_ids:
        if store.get_calc(cid) is None:
            raise KeyError("no calculation " + cid)
    row = {"finding_id": finding_id, "calc_ids": list(calc_ids), "statement": statement, "linked_at": E.now_utc()}
    store.append_rows("derived/findings.jsonl", [row], key=lambda r: (r["finding_id"], tuple(r["calc_ids"]), r["statement"]))
    return row


# -------------------------------------------------------------------------------- re-proving the chain
def present_in_raw(t, raw):
    """Is this transfer actually in the bytes it cites? Returns PASS / FAIL / UNCHECKED."""
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        doc = None
    if t["chain"] == "bitcoin":
        txid = t["tx_hash"]
        cands = []
        if isinstance(doc, list):
            cands = [x for x in doc if isinstance(x, dict) and x.get("txid") == txid]
        elif isinstance(doc, dict):
            res = doc.get("result") if "result" in doc else doc
            if isinstance(res, dict) and (res.get("txid") == txid or res.get("hex")):
                cands = [res]
        for tx in cands:
            n = t["log_index"]
            if n >= 0:
                if tx.get("hex"):
                    p = btc.parse_tx(bytes.fromhex(tx["hex"]))
                    o = p["vout"][n] if n < len(p["vout"]) else None
                    ok = o is not None and str(o["value_sats"]) == t["amount_raw"] and (o["address"] or "script:" + o["type"]) == t["to_address"]
                else:
                    o = (tx.get("vout") or [])[n] if n < len(tx.get("vout") or []) else None
                    ok = o is not None and str(o.get("value", 0)) == t["amount_raw"] and (o.get("scriptpubkey_address") or "script:" + str(o.get("scriptpubkey_type"))) == t["to_address"]
                return "PASS" if ok else "FAIL"
            k = -n - 1
            vin = tx.get("vin") or []
            if k < len(vin):
                p = (vin[k] or {}).get("prevout") or {}
                ok = str(p.get("value", 0)) == t["amount_raw"] and (p.get("scriptpubkey_address") or "script:unknown") == t["from_address"]
                return "PASS" if ok else "FAIL"
        return "UNCHECKED"
    res = doc.get("result") if isinstance(doc, dict) else None
    logs = res if isinstance(res, list) else ((res or {}).get("logs") if isinstance(res, dict) else None)
    if logs is None:
        return "UNCHECKED"
    for lg in logs:
        d, _ = evm.decode_transfer(lg)
        if d and d["tx_hash"] == t["tx_hash"] and d["log_index"] == t["log_index"]:
            same = d["amount_raw"] == t["amount_raw"] and d["from_address"] == t["from_address"] and d["to_address"] == t["to_address"]
            return "PASS" if same else "FAIL"
    return "FAIL"


def provenance(store, ident, check=True):
    """Resolve any id (finding, calc:, sha256:, env:, tx hash) into its lineage tree, re-proving links."""
    transfers = {M.transfer_key(t): t for t in store.rows("normalized/transfers.jsonl")}
    tree = {"id": ident, "kind": None, "nodes": [], "checks": []}
    calcs = []
    if ident.startswith("calc:"):
        c = store.get_calc(ident)
        if c:
            calcs = [c]
        tree["kind"] = "calculation"
    elif ident.startswith("sha256:") or ident.startswith("env:"):
        tree["kind"] = "evidence"
        envs = [e for e in store.envelopes() if ident in (e["evidence_id"], e["envelope_id"])]
        tree["nodes"] = [{"envelope": e} for e in envs]
        if check:
            for e in envs:
                tree["checks"].append(_rehash(store, e["evidence_id"]))
        tree["used_by"] = [k for k, t in transfers.items() if t["evidence_id"] in [e["evidence_id"] for e in envs]]
        return tree
    else:
        links = [r for r in store.rows("derived/findings.jsonl") if r["finding_id"] == ident]
        if links:
            tree["kind"] = "finding"
            tree["statements"] = [l["statement"] for l in links]
            for l in links:
                calcs += [store.get_calc(c) for c in l["calc_ids"] if store.get_calc(c)]
        else:
            rows = [t for t in transfers.values() if t["tx_hash"] == ident.lower() or t["tx_hash"] == ident]
            tree["kind"] = "transaction"
            tree["nodes"] = [{"transfer": t} for t in rows]
            if check:
                for eid in sorted(set(t["evidence_id"] for t in rows)):
                    tree["checks"].append(_rehash(store, eid))
            return tree
    for c in calcs:
        node = {"calculation": c, "transfers": [], "evidence": []}
        rows = [transfers.get(k) for k in c["inputs"]]
        missing = [k for k, r in zip(c["inputs"], rows) if r is None]
        rows = [r for r in rows if r]
        if check:
            if missing:
                tree["checks"].append({"check": "inputs on file", "id": c["calc_id"], "result": "FAIL", "detail": "{} input row(s) missing".format(len(missing))})
            again = _compute(c["kind"], c["address"], rows)
            tree["checks"].append({"check": "recompute", "id": c["calc_id"], "result": "PASS" if str(again) == c["result"]["raw"] else "FAIL",
                                   "detail": "recomputed {} from {} rows (stored {})".format(again, len(rows), c["result"]["raw"])})
        by_eid = {}
        for t in rows:
            by_eid.setdefault(t["evidence_id"], []).append(t)
        for eid, ts in sorted(by_eid.items()):
            envs = store.envelopes_for(eid)
            node["evidence"].append({"evidence_id": eid, "envelopes": [e["envelope_id"] for e in envs],
                                     "source": envs[0]["source"] if envs else None,
                                     "verification": envs[0]["verification"]["level"] if envs else None, "rows": len(ts)})
            if check:
                rh = _rehash(store, eid)
                tree["checks"].append(rh)
                if rh["result"] == "PASS":
                    raw = store.get_raw(eid)
                    res = [present_in_raw(t, raw) for t in ts]
                    tree["checks"].append({"check": "rows present in the bytes they cite", "id": eid,
                                           "result": "FAIL" if "FAIL" in res else ("PASS" if all(r == "PASS" for r in res) else "PARTIAL"),
                                           "detail": "{} PASS, {} FAIL, {} UNCHECKED of {}".format(res.count("PASS"), res.count("FAIL"), res.count("UNCHECKED"), len(res))})
        node["transfers"] = [M.transfer_key(t) for t in rows]
        tree["nodes"].append(node)
    return tree


def _rehash(store, eid):
    try:
        store.get_raw(eid)
        return {"check": "raw bytes re-hashed", "id": eid, "result": "PASS", "detail": "file still hashes to its id"}
    except E.TamperError as e:
        return {"check": "raw bytes re-hashed", "id": eid, "result": "FAIL", "detail": str(e)}
    except KeyError as e:
        return {"check": "raw bytes re-hashed", "id": eid, "result": "MISSING", "detail": str(e)}


def render_tree(tree):
    L = []
    L.append("PROVENANCE  {}  ({})".format(tree["id"], tree["kind"] or "not found"))
    for s in tree.get("statements", []):
        L.append("  FINDING      " + s)
    for n in tree["nodes"]:
        if "calculation" in n:
            c = n["calculation"]
            res = c["result"].get("units", c["result"]["raw"])
            L.append("  ↓ supported_by")
            L.append("  CALCULATION  {}  {} {} {}".format(c["calc_id"], c["kind"], res, c.get("unit") or ""))
            L.append("               token {}  address {}  blocks {}".format(c["token_key"], c["address"], c["block_range"]))
            L.append("               rule: " + c["rule"])
            L.append("  ↓ inputs     {} transfer rows  (verification: {})".format(len(n["transfers"]), c.get("input_verification")))
            for ev in n["evidence"]:
                s = ev["source"] or {}
                L.append("  RESPONSE     {}  rows {}".format(ev["evidence_id"], ev["rows"]))
                L.append("               provider {}  endpoint {}".format(s.get("provider"), s.get("endpoint")))
                L.append("               retrieved {}  chain {}/{}  level {}".format(s.get("retrieved_at"), s.get("chain"), s.get("network"), ev["verification"]))
        elif "envelope" in n:
            e = n["envelope"]
            s = e["source"]
            L.append("  RESPONSE     {}  ({})".format(e["evidence_id"], e["envelope_id"]))
            L.append("               provider {}  endpoint {}  retrieved {}".format(s["provider"], s["endpoint"], s["retrieved_at"]))
            L.append("               {} bytes  level {}".format(e["raw_bytes"], e["verification"]["level"]))
        elif "transfer" in n:
            t = n["transfer"]
            L.append("  TRANSFER     {} → {}  {} {}  ({})".format(t["from_address"], t["to_address"], t["amount_raw"], t["asset_symbol"], t["evidence_id"][:23]))
    if tree.get("used_by"):
        L.append("  used by {} transfer row(s)".format(len(tree["used_by"])))
    if tree["checks"]:
        L.append("CHECKS")
        for c in tree["checks"]:
            L.append("  {:<8} {:<36} {}".format(c["result"], c["check"], c.get("detail", "")))
    return "\n".join(L)
