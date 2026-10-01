# -*- coding: utf-8 -*-
"""EVM chains (Ethereum, Base, ...): token transfers from the logs a node returns.

A token transfer is an event log. The ERC-20 Transfer event has one fixed topic, the Keccak-256
of "Transfer(address,address,uint256)", computed here rather than pasted in. Logs are execution
results, so unlike a Bitcoin transaction they cannot be re-derived from the bytes alone. What can
be done, and is:

  V1 HASH_BOUND    for a transaction: Keccak-256 of the raw signed transaction equals its hash
  V3 CORROBORATED  the same log range, fetched from a second, independent endpoint, gives the
                   identical set of transfers (any difference is reported as MISMATCH)
  REPORTED         everything else, including confirmations and block timestamps from one source
"""
import json

import net
import primitives as P

TRANSFER_TOPIC = "0x" + P.keccak256(b"Transfer(address,address,uint256)").hex()
ZERO = "0x" + "0" * 40


def hex_int(x):
    if x is None:
        return None
    if isinstance(x, int):
        return x
    return int(x, 16) if str(x).startswith("0x") else int(x)


def pad_topic(addr):
    a = addr.lower()
    if not (a.startswith("0x") and len(a) == 42):
        raise ValueError("not an EVM address: " + addr)
    return "0x" + "0" * 24 + a[2:]


def topic_addr(t):
    return "0x" + t[-40:].lower()


def validate_address(a):
    st = P.checksum_status(a)
    if st == "MALFORMED":
        return {"valid": False, "reason": "not 0x + 40 hex characters"}
    if st == "INVALID":
        return {"valid": False, "reason": "mixed-case checksum (EIP-55) fails — one character is probably wrong"}
    return {"valid": True, "reason": "checksum OK" if st == "VALID" else "no checksum present (all one case); cannot catch typos",
            "checksummed": P.to_checksum_address(a)}


def decode_transfer(log):
    """ERC-20 Transfer log → dict, or (None, reason) for logs that are not fungible transfers."""
    topics = log.get("topics") or []
    if not topics or topics[0].lower() != TRANSFER_TOPIC:
        return None, "not a Transfer event"
    if log.get("removed"):
        return None, "log removed by a chain reorganisation"
    if len(topics) == 4:
        return None, "ERC-721 style transfer (token id indexed) — not a fungible amount"
    if len(topics) != 3:
        return None, "unexpected topic count {}".format(len(topics))
    data = log.get("data") or "0x"
    try:
        amount = int(data, 16) if data not in ("0x", "") else 0
    except ValueError:
        return None, "unreadable amount data"
    return {
        "contract_address": (log.get("address") or "").lower(),
        "from_address": topic_addr(topics[1]),
        "to_address": topic_addr(topics[2]),
        "amount_raw": str(amount),
        "tx_hash": (log.get("transactionHash") or "").lower(),
        "block_number": hex_int(log.get("blockNumber")),
        "log_index": hex_int(log.get("logIndex")),
        "block_hash": (log.get("blockHash") or "").lower() or None,
        "timestamp_hex": log.get("blockTimestamp"),
    }, None


class Rpc(object):
    """JSON-RPC over the shared transport. Every response is sealed as evidence by the caller."""

    def __init__(self, transport, url):
        self.t = transport
        self.url = url
        self.n = 0

    def call(self, method, params):
        self.n += 1
        body = {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}
        status, ctype, raw = self.t.request("POST", self.url, body=body)
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise net.NetError("{} returned something that is not JSON".format(method))
        if isinstance(doc, dict) and doc.get("error"):
            raise net.NetError("{}: {}".format(method, net.redact(json.dumps(doc["error"])[:300])))
        return status, ctype, raw, doc.get("result") if isinstance(doc, dict) else None


def log_filter(contract, address, direction, from_block, to_block):
    """eth_getLogs filters for transfers of one token into and/or out of one address."""
    topic_a = pad_topic(address) if address else None
    out = []
    if direction in ("in", "both"):
        out.append(("in", {"address": contract, "fromBlock": hex(from_block), "toBlock": hex(to_block),
                           "topics": [TRANSFER_TOPIC, None, topic_a]}))
    if direction in ("out", "both"):
        out.append(("out", {"address": contract, "fromBlock": hex(from_block), "toBlock": hex(to_block),
                            "topics": [TRANSFER_TOPIC, topic_a, None]}))
    return out


def transfer_set(transfers):
    """The comparable content of a set of transfers (for corroboration between endpoints)."""
    return sorted((t["tx_hash"], t["log_index"], t["from_address"], t["to_address"], t["amount_raw"]) for t in transfers)


def verify_raw_tx(raw_hex, tx_hash):
    """V1 for an EVM transaction: the hash of the raw signed bytes is the transaction hash."""
    raw = bytes.fromhex(raw_hex[2:] if raw_hex.startswith("0x") else raw_hex)
    return "0x" + P.keccak256(raw).hex() == tx_hash.lower()
