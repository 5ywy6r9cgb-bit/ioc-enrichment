# -*- coding: utf-8 -*-
"""The shapes every chain is normalized into. Plain dicts, so they stay readable as JSON lines.

TRANSFER (one row = one movement of one asset)
  chain, network        "ethereum"/"mainnet", "base"/"mainnet", "bitcoin"/"mainnet" ...
  token_key             chain:network:contract (or :native) — the asset's identity; never the symbol alone
  asset_symbol, contract_address, decimals
  tx_hash, block_number, log_index
  from_address, to_address
  amount_raw            integer string in the asset's smallest unit (wei-style units, satoshis)
  timestamp             ISO-8601 UTC or null (REPORTED by one source unless corroborated)
  evidence_id           sha256 of the raw response the row was read from
  verification          V0_REPORTED | V1_HASH_BOUND | V2_INCLUDED | V3_CORROBORATED | MISMATCH

Bitcoin is not account-based. A Bitcoin transaction spends inputs and creates outputs, so it is
normalized as two kinds of row: address → "tx:<txid>" (an input it funded, log_index < 0) and
"tx:<txid>" → address (an output it received, log_index = vout). Which output is "change" is
unknown from the chain and is never assumed.
"""
from decimal import Decimal, getcontext

getcontext().prec = 80

LEVELS = ["MISMATCH", "V0_REPORTED", "V1_HASH_BOUND", "V2_INCLUDED", "V3_CORROBORATED"]
LEVEL_TEXT = {
    "MISMATCH": "two sources disagree — do not use until resolved",
    "V0_REPORTED": "as reported by one source",
    "V1_HASH_BOUND": "raw bytes hash to the transaction id",
    "V2_INCLUDED": "committed in a block header with valid proof of work",
    "V3_CORROBORATED": "a second independent source returns the same data",
}


def transfer_key(t):
    return "{}:{}:{}:{}".format(t["chain"], t["network"], t["tx_hash"], t["log_index"])


def amount(t):
    """Exact decimal amount in whole units (no floats anywhere)."""
    d = t.get("decimals")
    if d is None:
        raise ValueError("decimals unknown for {} — record the token before converting units".format(t.get("token_key")))
    return Decimal(int(t["amount_raw"])) / (Decimal(10) ** int(d))


def fmt_units(value, decimals=2, symbol=""):
    q = Decimal(1).scaleb(-decimals)
    s = "{:,}".format(value.quantize(q))
    return (s + " " + symbol).strip()


def make_transfer(token, **kw):
    t = {"chain": token["chain"], "network": token["network"], "token_key": kw.pop("token_key"),
         "asset_symbol": token["symbol"], "contract_address": token.get("contract_address"),
         "decimals": token.get("decimals"), "verification": "V0_REPORTED", "timestamp": None}
    t.update(kw)
    return t
