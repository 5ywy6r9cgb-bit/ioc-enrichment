# -*- coding: utf-8 -*-
"""Rug-pull and cash-out shapes over normalized transfers. Signals are leads, never findings.

Reuses the ledger module's seven explorer-export signals (CONCENTRATION, FRESH_MINT_FANOUT,
RAPID_EXIT, POOL_DRAIN, FAN_IN_FORWARD, ROUND_TRIP, FLAGGED_COUNTERPARTY) on verified, normalized
rows, and adds two that need the normalized model:

  LATE_MINT    new supply minted long after the token's first mint in the rows fetched
  PEEL_CHAIN   Bitcoin: a run of transactions that each pay out a small amount and pass the
               rest on to a fresh address (a common way to move funds in steps)

Every signal carries its ordinary explanations and the record that would settle it.
"""
import datetime
import os
import sys
from collections import defaultdict
from decimal import Decimal

import models as M

LEDGER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ledger")

EXTRA = {
    "LATE_MINT": {
        "ordinary": ["Scheduled emissions, bridges and stablecoin issuance mint continuously by design.",
                     "The rows fetched may start after the real launch."],
        "settle": "The token contract's mint permissions (owner / minter roles) and the project's published supply schedule.",
    },
    "PEEL_CHAIN": {
        "ordinary": ["Exchanges and wallets batch payouts this way; the shape is common in honest payment flows.",
                     "Which output is change is a heuristic; the chain does not say."],
        "settle": "An exchange's or custodian's attribution of the addresses, or the payer's own records.",
    },
}


def _rows_for_ledger(transfers):
    out = []
    for t in transfers:
        ts = None
        if t.get("timestamp"):
            ts = datetime.datetime.fromisoformat(t["timestamp"].replace("Z", "+00:00"))
        amt = M.amount(t) if t.get("decimals") is not None else Decimal(int(t["amount_raw"]))
        out.append({"chain": t["chain"], "tx_hash": t["tx_hash"], "row": t.get("log_index"), "block_number": t.get("block_number"),
                    "block_time_utc": t.get("timestamp"), "_t": ts, "from": t["from_address"], "to": t["to_address"],
                    "asset": t["asset_symbol"], "asset_contract": t.get("contract_address"), "amount": str(amt), "_amt": amt,
                    "usd_value_at_time": None, "method": None, "source_file_sha256": t["evidence_id"], "labels": []})
    return out


def run(transfers, labels=None, flagged=None, window_h=24, fanout_min=20, late_mint_blocks=50000):
    out = []
    by_token = defaultdict(list)
    for t in transfers:
        by_token[t["token_key"]].append(t)
    if LEDGER_DIR not in sys.path:
        sys.path.append(LEDGER_DIR)
    try:
        import onchain
    except ImportError:
        onchain = None
    for tkey, rows in sorted(by_token.items()):
        if onchain is not None and not tkey.startswith("bitcoin:"):
            for s in onchain.signals(_rows_for_ledger(rows), labels or {}, flagged or {}, window_h=window_h, fanout_min=fanout_min):
                s["token_key"] = tkey
                out.append(s)
        out += late_mint(rows, tkey, late_mint_blocks)
        if tkey.startswith("bitcoin:"):
            out += peel_chain(rows, tkey)
    return out


def _sig(name, tkey, addrs, txs, metrics, note):
    return {"signal": name, "status": "SIGNAL — not a finding", "token_key": tkey, "addresses": addrs[:12], "tx_hashes": txs[:20],
            "metrics": metrics, "note": note, "ordinary_explanations": EXTRA[name]["ordinary"], "what_would_settle_it": EXTRA[name]["settle"]}


def late_mint(rows, tkey, gap_blocks):
    mints = sorted((t for t in rows if t["from_address"] == "0x" + "0" * 40 and t.get("block_number") is not None), key=lambda t: t["block_number"])
    if len(mints) < 2:
        return []
    first = mints[0]["block_number"]
    late = [t for t in mints if t["block_number"] - first > gap_blocks]
    if not late:
        return []
    total_raw = sum(int(t["amount_raw"]) for t in mints)
    late_raw = sum(int(t["amount_raw"]) for t in late)
    return [_sig("LATE_MINT", tkey, sorted(set(t["to_address"] for t in late)), [t["tx_hash"] for t in late],
                 {"mints": len(mints), "late_mints": len(late), "late_share_of_minted_rows": "{:.1%}".format(late_raw / total_raw if total_raw else 0),
                  "first_mint_block": first, "gap_blocks": gap_blocks},
                 "{} mint(s) more than {:,} blocks after the first mint in these rows".format(len(late), gap_blocks))]


def peel_chain(rows, tkey, min_len=3, peel_max=0.2):
    """tx → (small output, large output); the large output's address funds the next tx."""
    outs = defaultdict(list)
    funds = defaultdict(list)
    for t in rows:
        if t["from_address"].startswith("tx:") and t["log_index"] >= 0:
            outs[t["from_address"]].append(t)
        if t["to_address"].startswith("tx:") and t["log_index"] < 0:
            funds[t["from_address"]].append(t["to_address"])
    nxt = {}
    for tx, os_ in outs.items():
        if len(os_) != 2:
            continue
        a, b = sorted(os_, key=lambda t: int(t["amount_raw"]))
        tot = int(a["amount_raw"]) + int(b["amount_raw"])
        if tot and int(a["amount_raw"]) / tot <= peel_max and funds.get(b["to_address"]):
            nxt[tx] = funds[b["to_address"]][0]
    chains, seen = [], set()
    for start in nxt:
        if start in seen or start in nxt.values():
            continue
        chain = [start]
        while chain[-1] in nxt and nxt[chain[-1]] not in chain:
            chain.append(nxt[chain[-1]])
        seen.update(chain)
        if len(chain) >= min_len:
            chains.append(chain)
    return [_sig("PEEL_CHAIN", tkey, [], [c[4:] for c in ch], {"length": len(ch)},
                 "{} transactions in a row each peel off ≤{:.0%} and pass the rest on".format(len(ch), peel_max)) for ch in chains]
