# -*- coding: utf-8 -*-
"""On-chain transfer intake: an explorer CSV export in, normalized rows and SIGNALS out.

    ledger onchain transfers.csv --chain ethereum
    ledger onchain transfers.csv --chain base --labels labels.csv --flagged flagged.csv --out out/

Every row keeps its transaction hash and the SHA-256 of the file it came from, so any line can be
checked on a block explorer. Signals are leads, never findings:
  CONCENTRATION        a few addresses hold most of what moved in this file
  FRESH_MINT_FANOUT    newly minted tokens fanned out to many wallets fast
  RAPID_EXIT           an early large receiver sent most of it out within the window
  POOL_DRAIN           an address you labelled as a pool lost most of its inflow in one transfer
  FAN_IN_FORWARD       many senders → one address → forwarded on (cash-out shape)
  ROUND_TRIP           the same amount went A→B and back B→A
  FLAGGED_COUNTERPARTY a transfer touched an address on YOUR flagged list (with your source)

An address is not a person. Nothing here identifies anyone; attribution needs an off-chain
document (a filing, a court record, an exchange's own disclosure)."""
import csv
import datetime
import hashlib
import io
import json
import os
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation

import lib_ledger as L

ZERO_ADDRS = {"0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"}
COLS = {
    "tx": ["transactionhash", "txhash", "hash", "txid", "signature", "txsignature"],
    "block": ["blockno", "blocknumber", "block", "slot"],
    "time": ["datetimeutc", "datetime", "blocktime", "timestamp", "unixtimestamp", "time", "date"],
    "from": ["from", "fromaddress", "sender", "source"],
    "to": ["to", "toaddress", "recipient", "receiver", "destination"],
    "amount": ["tokenvalue", "quantity", "amount", "value", "valueineth", "valuein"],
    "amount_out": ["valueouteth", "valueout"],
    "asset": ["tokensymbol", "symbol", "asset", "token", "currency", "tokenname"],
    "contract": ["contractaddress", "tokenaddress", "mint", "tokencontract"],
    "usd": ["usdvaluedayoftx", "usdvalue", "valueusd", "historicalusd", "usd"],
    "method": ["method", "functionname", "type"],
}
ORDINARY = {
    "CONCENTRATION": ["Exchange hot wallets, treasuries, vesting and liquidity contracts routinely hold large balances.",
                      "The file may cover only part of the token's history."],
    "FRESH_MINT_FANOUT": ["Airdrops and scheduled distributions fan out newly minted tokens by design."],
    "RAPID_EXIT": ["Market makers, custodians and team wallets move large balances for ordinary reasons.",
                   "A transfer is not a sale; the receiving address may belong to the same holder."],
    "POOL_DRAIN": ["Liquidity providers withdraw liquidity they supplied; migrations move pools.",
                   "The 'pool' label is yours — confirm it from the contract before relying on it."],
    "FAN_IN_FORWARD": ["Exchanges sweep deposit addresses into one hot wallet many times a day."],
    "ROUND_TRIP": ["Refunds, test transfers and failed-trade reversals return the same amount."],
    "FLAGGED_COUNTERPARTY": ["A shared counterparty is not a shared owner; mixers and exchanges touch everyone."],
}
SETTLE = {
    "CONCENTRATION": "Contract labels from the explorer and the project's own disclosures of treasury and vesting wallets.",
    "FRESH_MINT_FANOUT": "The project's published distribution plan, with addresses.",
    "RAPID_EXIT": "An off-chain document tying the address to a person or firm, and exchange deposit records.",
    "POOL_DRAIN": "The pool contract's events (Burn / RemoveLiquidity) and who owned the LP position.",
    "FAN_IN_FORWARD": "An exchange's attribution of the receiving address.",
    "ROUND_TRIP": "The counterparties' own records.",
    "FLAGGED_COUNTERPARTY": "The source you recorded for the flag, and the transaction itself.",
}


def _key(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def map_columns(header):
    k = {_key(h): h for h in header}
    out = {}
    for field, cands in COLS.items():
        for c in cands:
            for hk, h in k.items():
                if hk == c or (len(c) > 4 and hk.startswith(c)):
                    out.setdefault(field, h)
                    break
            if field in out:
                break
    return out


def dec(s):
    if s is None:
        return None
    t = str(s).replace(",", "").replace("$", "").strip()
    if not t:
        return None
    try:
        return Decimal(t)
    except InvalidOperation:
        return None


def when(s):
    s = (s or "").strip()
    if re.fullmatch(r"\d{9,11}", s):
        return datetime.datetime.fromtimestamp(int(s), datetime.timezone.utc)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(s.replace(" UTC", ""), fmt).replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            pass
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def norm_addr(a, chain):
    a = (a or "").strip()
    return a.lower() if a.startswith("0x") else a


def read_rows(path, chain):
    raw = open(path, "rb").read()
    file_sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8-sig", "replace")
    rdr = csv.DictReader(io.StringIO(text))
    cmap = map_columns(rdr.fieldnames or [])
    need = [x for x in ("tx", "from", "to") if x not in cmap]
    if need:
        L.die("could not find column(s) {} in {}; header was: {}".format(need, path, rdr.fieldnames))
    rows = []
    for i, r in enumerate(rdr, start=2):
        amt = dec(r.get(cmap.get("amount")))
        if (amt is None or amt == 0) and "amount_out" in cmap:
            amt = dec(r.get(cmap["amount_out"]))
        t = when(r.get(cmap.get("time")))
        rows.append({
            "chain": chain, "tx_hash": (r.get(cmap["tx"]) or "").strip(), "row": i,
            "block_number": int(dec(r.get(cmap.get("block"))) or 0) if cmap.get("block") else None,
            "block_time_utc": t.isoformat().replace("+00:00", "Z") if t else None, "_t": t,
            "from": norm_addr(r.get(cmap["from"]), chain), "to": norm_addr(r.get(cmap["to"]), chain),
            "asset": (r.get(cmap.get("asset")) or "").strip() or "NATIVE",
            "asset_contract": norm_addr(r.get(cmap.get("contract")), chain) or None,
            "amount": str(amt) if amt is not None else None, "_amt": amt or Decimal(0),
            "usd_value_at_time": (str(dec(r.get(cmap.get("usd")))) if cmap.get("usd") and dec(r.get(cmap.get("usd"))) is not None else None),
            "method": (r.get(cmap.get("method")) or "").strip() or None,
            "source_file_sha256": file_sha, "labels": [],
        })
    return rows, file_sha, cmap


def load_list(path):
    """CSV with address,label,source — or one address per line."""
    out = {}
    if not path:
        return out
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            parts = [p.strip() for p in line.rstrip("\n").split(",")]
            if not parts or not parts[0] or parts[0].startswith("#") or parts[0].lower() == "address":
                continue
            out[norm_addr(parts[0], "")] = {"label": parts[1] if len(parts) > 1 else "", "source": parts[2] if len(parts) > 2 else ""}
    return out


def sig(name, asset, addrs, txs, metrics, note):
    return {"signal": name, "status": "SIGNAL — not a finding", "asset": asset, "addresses": addrs[:12],
            "tx_hashes": txs[:20], "metrics": metrics, "note": note,
            "ordinary_explanations": ORDINARY[name], "what_would_settle_it": SETTLE[name]}


def signals(rows, labels, flagged, window_h=24, fanout_min=20, top_share=Decimal("0.8")):
    out = []
    W = datetime.timedelta(hours=window_h)
    by_asset = defaultdict(list)
    for r in rows:
        by_asset[r["asset_contract"] or r["asset"]].append(r)
    for asset, rs in by_asset.items():
        rs.sort(key=lambda r: (r["_t"] or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc), r["row"]))
        bal = defaultdict(Decimal)
        inflow = defaultdict(Decimal)
        for r in rs:
            bal[r["to"]] += r["_amt"]
            inflow[r["to"]] += r["_amt"]
            if r["from"] not in ZERO_ADDRS:
                bal[r["from"]] -= r["_amt"]
        pos = sorted(((a, b) for a, b in bal.items() if b > 0 and a not in ZERO_ADDRS), key=lambda x: -x[1])
        tot = sum(b for _, b in pos)
        if tot > 0 and len(pos) >= 3:
            top = pos[:10]
            share = sum(b for _, b in top) / tot
            hhi = sum((b / tot) ** 2 for _, b in pos)
            if share >= top_share:
                out.append(sig("CONCENTRATION", asset, [a for a, _ in top], [],
                               {"top10_share": str(round(share, 4)), "hhi": str(round(hhi, 4)), "holders_in_file": len(pos)},
                               "Net positions computed from this file only."))
        # fresh mint fan-out and rapid exit
        mints = [r for r in rs if r["from"] in ZERO_ADDRS]
        minted = sum(r["_amt"] for r in mints)
        for m in mints:
            recv = m["to"]
            outs = [r for r in rs if r["from"] == recv and r["_t"] and m["_t"] and m["_t"] <= r["_t"] <= m["_t"] + W]
            dests = {r["to"] for r in outs}
            if len(dests) >= fanout_min:
                out.append(sig("FRESH_MINT_FANOUT", asset, [recv] + sorted(dests)[:10], [m["tx_hash"]] + [r["tx_hash"] for r in outs],
                               {"recipients_within_window": len(dests), "window_hours": window_h}, "Mint → many wallets within the window."))
        if minted > 0:
            for addr, got in inflow.items():
                if addr in ZERO_ADDRS or got < minted * Decimal("0.05"):
                    continue
                firsts = [r for r in rs if r["to"] == addr and r["_t"]]
                if not firsts:
                    continue
                t0 = firsts[0]["_t"]
                sent = [r for r in rs if r["from"] == addr and r["_t"] and t0 <= r["_t"] <= t0 + W]
                out_amt = sum(r["_amt"] for r in sent)
                if out_amt >= got * Decimal("0.8") and sent:
                    out.append(sig("RAPID_EXIT", asset, [addr] + sorted({r["to"] for r in sent})[:8], [r["tx_hash"] for r in sent],
                                   {"received": str(got), "sent_within_window": str(out_amt), "share_of_minted": str(round(got / minted, 4))},
                                   "An early receiver of ≥5% of minted supply sent ≥80% out within the window."))
        # labelled pools
        for addr, meta in labels.items():
            if "pool" not in (meta.get("label") or "").lower():
                continue
            pin = inflow.get(addr, Decimal(0))
            if pin <= 0:
                continue
            for r in rs:
                if r["from"] == addr and r["_amt"] >= pin * Decimal("0.5"):
                    out.append(sig("POOL_DRAIN", asset, [addr, r["to"]], [r["tx_hash"]],
                                   {"pool_inflow_in_file": str(pin), "single_outflow": str(r["_amt"]), "share": str(round(r["_amt"] / pin, 4))},
                                   "One transfer out of a labelled pool took ≥50% of everything that flowed in."))
        # fan-in then forward
        senders = defaultdict(set)
        for r in rs:
            senders[r["to"]].add(r["from"])
        for addr, ss in senders.items():
            if len(ss) < fanout_min or addr in ZERO_ADDRS:
                continue
            got = inflow[addr]
            outs = [r for r in rs if r["from"] == addr]
            dest = defaultdict(Decimal)
            for r in outs:
                dest[r["to"]] += r["_amt"]
            topd = sorted(dest.items(), key=lambda x: -x[1])[:2]
            fwd = sum(v for _, v in topd)
            if got > 0 and fwd >= got * Decimal("0.8"):
                out.append(sig("FAN_IN_FORWARD", asset, [addr] + [d for d, _ in topd], [r["tx_hash"] for r in outs],
                               {"distinct_senders": len(ss), "received": str(got), "forwarded_to_top2": str(fwd)},
                               "Many senders into one address, then most of it forwarded to one or two addresses."))
        # round trips
        seen = {}
        for r in rs:
            k = (r["from"], r["to"], r["_amt"])
            back = (r["to"], r["from"], r["_amt"])
            if back in seen and r["_t"] and seen[back]["_t"] and r["_t"] - seen[back]["_t"] <= W and r["_amt"] > 0:
                out.append(sig("ROUND_TRIP", asset, [r["from"], r["to"]], [seen[back]["tx_hash"], r["tx_hash"]],
                               {"amount": str(r["_amt"])}, "Same amount out and back within the window."))
            seen[k] = r
        for r in rs:
            for a in (r["from"], r["to"]):
                if a in flagged:
                    out.append(sig("FLAGGED_COUNTERPARTY", asset, [a], [r["tx_hash"]],
                                   {"your_label": flagged[a]["label"], "your_source": flagged[a]["source"]},
                                   "Touches an address on the operator's own flagged list."))
    return out


def to_ledger_rows(rows):
    """Ledger-compatible money_flows rows (kind ON_CHAIN_TRANSFER). Entities are addresses, not people."""
    out = []
    for r in rows:
        out.append({"id": "OC-{}-{}".format(r["tx_hash"][:12], r["row"]), "from": "ADDR:" + r["from"], "to": "ADDR:" + r["to"],
                     "amount_usd": float(r["usd_value_at_time"]) if r["usd_value_at_time"] else None,
                     "amount_text": "{} {}".format(r["amount"], r["asset"]), "kind": "ON_CHAIN_TRANSFER",
                     "period": r["block_time_utc"], "sources": ["ONCHAIN:" + r["source_file_sha256"][:16]],
                     "locator": "{}:{} row {}".format(r["chain"], r["tx_hash"], r["row"]), "evidence_class": "REGISTER_ROW",
                     "is_floor": False, "caveat": "Public-chain transfer. An address is not a person; attribution needs an off-chain record.",
                     "findings": []})
    return out


def run(path, chain, labels_path=None, flagged_path=None, outdir=None, window_h=24, fanout_min=20):
    rows, file_sha, cmap = read_rows(path, chain)
    labels, flagged = load_list(labels_path), load_list(flagged_path)
    for r in rows:
        for a in (r["from"], r["to"]):
            if a in labels:
                r["labels"].append("{}={}".format(a[:10], labels[a]["label"]))
    sigs = signals(rows, labels, flagged, window_h, fanout_min)
    if outdir:
        os.makedirs(outdir, exist_ok=True)
        cols = ["chain", "tx_hash", "row", "block_number", "block_time_utc", "from", "to", "asset", "asset_contract", "amount",
                "usd_value_at_time", "method", "source_file_sha256", "labels"]
        with open(os.path.join(outdir, "onchain_rows.csv"), "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(cols)
            for r in rows:
                w.writerow([";".join(r[c]) if isinstance(r[c], list) else ("" if r[c] is None else r[c]) for c in cols])
        with open(os.path.join(outdir, "signals.json"), "w", encoding="utf-8") as fh:
            json.dump({"file": os.path.basename(path), "file_sha256": file_sha, "columns_used": cmap, "rows": len(rows),
                       "signals": sigs, "rule": "Signals are leads, never findings. An address is not a person."}, fh, indent=1)
        with open(os.path.join(outdir, "money_flows_onchain.json"), "w", encoding="utf-8") as fh:
            json.dump(to_ledger_rows(rows), fh, indent=1)
    return rows, sigs, file_sha, cmap


def main(args):
    rows, sigs, sha, cmap = run(args.csv, args.chain, args.labels, args.flagged, args.out, args.window, args.fanout)
    print("{} · {} rows · sha256 {}…".format(os.path.basename(args.csv), len(rows), sha[:16]))
    print("columns used: " + ", ".join("{}←{}".format(k, v) for k, v in cmap.items()))
    counts = defaultdict(int)
    for s in sigs:
        counts[s["signal"]] += 1
    if not sigs:
        print("no signals at these thresholds (a quiet file is not a clean project — it is a quiet file)")
    for k, n in sorted(counts.items()):
        print("  SIGNAL  {:<22} {}".format(k, n))
    if args.out:
        print("wrote onchain_rows.csv, signals.json, money_flows_onchain.json → " + args.out)
    print("Signals are leads, never findings. An address is not a person.")
    return 0
