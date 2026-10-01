# -*- coding: utf-8 -*-
"""Bitcoin from the bytes up.

An API's JSON is a claim about the chain. The raw transaction is evidence: its double SHA-256
(without witness data) IS the txid. A merkle proof ties that txid to a block header, and the
header's own hash must meet the difficulty target the header states. So three checks move a
transaction from REPORTED to proven, without trusting whoever served it:

  V1 HASH_BOUND   the raw bytes hash to the txid that was asked for
  V2 INCLUDED     the txid is committed in a block header whose proof of work is valid
  V3 CORROBORATED a second, independent source reports the same block hash at that height

What none of these prove: who controls an address (see attribution.py), or that the block is on
the main chain (a single source's confirmation count is REPORTED; V3 corroborates it).
"""
import struct

import primitives as P

HRP = {"mainnet": "bc", "testnet": "tb", "signet": "tb", "regtest": "bcrt"}
B58_VERSIONS = {"mainnet": (0x00, 0x05), "testnet": (0x6F, 0xC4), "signet": (0x6F, 0xC4), "regtest": (0x6F, 0xC4)}
SATS = 100000000


# ------------------------------------------------------------------------ varints and reading
def read_varint(b, i):
    n = b[i]
    if n < 0xFD:
        return n, i + 1
    if n == 0xFD:
        return struct.unpack_from("<H", b, i + 1)[0], i + 3
    if n == 0xFE:
        return struct.unpack_from("<I", b, i + 1)[0], i + 5
    return struct.unpack_from("<Q", b, i + 1)[0], i + 9


def varint(n):
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def rev_hex(b):
    return b[::-1].hex()


# ------------------------------------------------------------------------ transactions
def parse_tx(raw, network="mainnet"):
    """Parse a serialized transaction (legacy or segwit). Returns a dict with txid, wtxid, inputs,
    outputs (value in satoshis, script type, address when the script has one), sizes and weight."""
    b = bytes(raw)
    i = 0
    version = struct.unpack_from("<i", b, 0)[0]
    i = 4
    segwit = False
    if b[i] == 0x00 and b[i + 1] == 0x01:
        segwit = True
        i += 2
    n_in, i = read_varint(b, i)
    vin = []
    for _ in range(n_in):
        prev = b[i:i + 32]
        vout = struct.unpack_from("<I", b, i + 32)[0]
        i += 36
        slen, i = read_varint(b, i)
        script = b[i:i + slen]
        i += slen
        seq = struct.unpack_from("<I", b, i)[0]
        i += 4
        coinbase = prev == b"\x00" * 32 and vout == 0xFFFFFFFF
        vin.append({"prev_txid": rev_hex(prev), "prev_vout": vout, "script_sig": script.hex(), "sequence": seq,
                    "coinbase": coinbase, "witness": []})
    n_out, i = read_varint(b, i)
    vout_list = []
    for n in range(n_out):
        value = struct.unpack_from("<q", b, i)[0]
        i += 8
        slen, i = read_varint(b, i)
        spk = b[i:i + slen]
        i += slen
        c = classify_script(spk, network)
        vout_list.append({"n": n, "value_sats": value, "script_pubkey": spk.hex(), "type": c["type"], "address": c.get("address"),
                          "detail": c.get("detail")})
    wit_start = i
    if segwit:
        for k in range(n_in):
            items, i = read_varint(b, i)
            w = []
            for _ in range(items):
                ln, i = read_varint(b, i)
                w.append(b[i:i + ln].hex())
                i += ln
            vin[k]["witness"] = w
    locktime = struct.unpack_from("<I", b, i)[0]
    i += 4
    if i != len(b):
        raise ValueError("trailing bytes after locktime ({} of {} used) — not a single transaction".format(i, len(b)))
    if segwit:
        stripped = b[:4] + b[6:wit_start] + b[-4:]
    else:
        stripped = b
    base_size, total_size = len(stripped), len(b)
    weight = base_size * 3 + total_size
    return {
        "txid": rev_hex(P.sha256d(stripped)), "wtxid": rev_hex(P.sha256d(b)), "version": version, "segwit": segwit,
        "vin": vin, "vout": vout_list, "locktime": locktime, "size": total_size, "base_size": base_size,
        "weight": weight, "vsize": (weight + 3) // 4, "total_out_sats": sum(o["value_sats"] for o in vout_list),
        "coinbase": bool(vin and vin[0]["coinbase"]),
    }


def serialize_tx(tx, with_witness=True):
    """Inverse of parse_tx for the fields it reads (used by the self-test)."""
    out = struct.pack("<i", tx["version"])
    wit = with_witness and any(v["witness"] for v in tx["vin"])
    if wit:
        out += b"\x00\x01"
    out += varint(len(tx["vin"]))
    for v in tx["vin"]:
        s = bytes.fromhex(v["script_sig"])
        out += bytes.fromhex(v["prev_txid"])[::-1] + struct.pack("<I", v["prev_vout"]) + varint(len(s)) + s + struct.pack("<I", v["sequence"])
    out += varint(len(tx["vout"]))
    for o in tx["vout"]:
        s = bytes.fromhex(o["script_pubkey"])
        out += struct.pack("<q", o["value_sats"]) + varint(len(s)) + s
    if wit:
        for v in tx["vin"]:
            out += varint(len(v["witness"]))
            for item in v["witness"]:
                ib = bytes.fromhex(item)
                out += varint(len(ib)) + ib
    out += struct.pack("<I", tx["locktime"])
    return out


def classify_script(spk, network="mainnet"):
    """Name the output script and give its address where it has one. A P2PK output has no address;
    its P2PKH form is shown as DERIVED so no one mistakes it for what the chain recorded."""
    hrp = HRP.get(network, "bc")
    v_pkh, v_sh = B58_VERSIONS.get(network, (0x00, 0x05))
    L = len(spk)
    if L == 25 and spk[0] == 0x76 and spk[1] == 0xA9 and spk[2] == 0x14 and spk[23] == 0x88 and spk[24] == 0xAC:
        return {"type": "p2pkh", "address": P.b58check_encode(bytes([v_pkh]) + spk[3:23])}
    if L == 23 and spk[0] == 0xA9 and spk[1] == 0x14 and spk[22] == 0x87:
        return {"type": "p2sh", "address": P.b58check_encode(bytes([v_sh]) + spk[2:22])}
    if L == 22 and spk[0] == 0x00 and spk[1] == 0x14:
        return {"type": "p2wpkh", "address": P.segwit_encode(hrp, 0, spk[2:])}
    if L == 34 and spk[0] == 0x00 and spk[1] == 0x20:
        return {"type": "p2wsh", "address": P.segwit_encode(hrp, 0, spk[2:])}
    if L == 34 and spk[0] == 0x51 and spk[1] == 0x20:
        return {"type": "p2tr", "address": P.segwit_encode(hrp, 1, spk[2:])}
    if L in (35, 67) and spk[0] in (33, 65) and spk[-1] == 0xAC:
        pk = spk[1:-1]
        return {"type": "p2pk", "address": None,
                "detail": {"pubkey": pk.hex(), "p2pkh_form_DERIVED": P.b58check_encode(bytes([v_pkh]) + P.hash160(pk))}}
    if L >= 1 and spk[0] == 0x6A:
        data = spk[1:]
        if data and data[0] <= 75:
            data = data[1:1 + data[0]]
        txt = data.decode("utf-8", "replace") if data and all(32 <= c < 127 for c in data) else None
        return {"type": "op_return", "address": None, "detail": {"data_hex": data.hex(), "text": txt}}
    if L >= 4 and 0x51 <= spk[0] <= 0x60 and 0x51 <= spk[0] <= 0x60 and spk[-1] == 0xAE:
        return {"type": "bare_multisig", "address": None}
    return {"type": "nonstandard", "address": None}


def validate_address(s, network=None):
    """Check a Bitcoin address by its own checksum before it goes anywhere. Returns
    {valid, type, network, reason}. Catches typos that would silently query the wrong address."""
    s = s.strip()
    nets = [network] if network else ["mainnet", "testnet", "regtest"]
    for net_name in nets:
        hrp = HRP[net_name]
        if s.lower().startswith(hrp + "1"):
            try:
                ver, prog = P.segwit_decode(hrp, s)
            except ValueError as e:
                return {"valid": False, "type": None, "network": net_name, "reason": "bech32 check failed: {}".format(e)}
            t = {(0, 20): "p2wpkh", (0, 32): "p2wsh", (1, 32): "p2tr"}.get((ver, len(prog)), "witness_v{}".format(ver))
            return {"valid": True, "type": t, "network": net_name, "reason": "checksum OK"}
    try:
        payload = P.b58check_decode(s)
    except ValueError as e:
        return {"valid": False, "type": None, "network": None, "reason": "not a valid Bitcoin address ({})".format(e)}
    if len(payload) != 21:
        return {"valid": False, "type": None, "network": None, "reason": "base58 payload is {} bytes, expected 21".format(len(payload))}
    for net_name, (pkh, sh) in B58_VERSIONS.items():
        if payload[0] == pkh:
            return {"valid": True, "type": "p2pkh", "network": net_name, "reason": "checksum OK"}
        if payload[0] == sh:
            return {"valid": True, "type": "p2sh", "network": net_name, "reason": "checksum OK"}
    return {"valid": False, "type": None, "network": None, "reason": "unknown version byte {}".format(payload[0])}


# ------------------------------------------------------------------------ headers and proof of work
def bits_to_target(bits):
    exp = bits >> 24
    mant = bits & 0x007FFFFF
    if bits & 0x00800000:
        return 0  # negative targets are invalid
    return mant >> (8 * (3 - exp)) if exp <= 3 else mant << (8 * (exp - 3))


def parse_header(h):
    h = bytes(h)
    if len(h) != 80:
        raise ValueError("a block header is 80 bytes, got {}".format(len(h)))
    version, = struct.unpack_from("<i", h, 0)
    t, bits, nonce = struct.unpack_from("<III", h, 68)
    hsh = P.sha256d(h)
    target = bits_to_target(bits)
    return {"hash": rev_hex(hsh), "version": version, "prev_hash": rev_hex(h[4:36]), "merkle_root": rev_hex(h[36:68]),
            "time": t, "bits": "{:08x}".format(bits), "nonce": nonce, "target": "{:064x}".format(target),
            "pow_ok": target > 0 and int.from_bytes(hsh[::-1], "big") <= target,
            "work_leading_zero_bits": 256 - int.from_bytes(hsh[::-1], "big").bit_length()}


# ------------------------------------------------------------------------ merkle proofs
def merkle_root_of(txids_hex):
    layer = [bytes.fromhex(t)[::-1] for t in txids_hex]
    if not layer:
        raise ValueError("no transactions")
    while len(layer) > 1:
        if len(layer) % 2:
            layer.append(layer[-1])
        layer = [P.sha256d(layer[k] + layer[k + 1]) for k in range(0, len(layer), 2)]
    return rev_hex(layer[0])


def branch_for(txids_hex, index):
    """Sibling hashes (display order) from leaf to root for txids_hex[index] (self-test helper)."""
    layer = [bytes.fromhex(t)[::-1] for t in txids_hex]
    branch, pos = [], index
    while len(layer) > 1:
        if len(layer) % 2:
            layer.append(layer[-1])
        branch.append(rev_hex(layer[pos ^ 1]))
        layer = [P.sha256d(layer[k] + layer[k + 1]) for k in range(0, len(layer), 2)]
        pos //= 2
    return branch


def verify_branch(txid_hex, branch_hex, pos, root_hex):
    """REST-index style proof: {merkle: [sibling hashes], pos}. True when the txid hashes up to the root."""
    h = bytes.fromhex(txid_hex)[::-1]
    for sib in branch_hex:
        s = bytes.fromhex(sib)[::-1]
        h = P.sha256d(s + h) if pos & 1 else P.sha256d(h + s)
        pos >>= 1
    return rev_hex(h) == root_hex.lower()


def _tree_width(total, height):
    return (total + (1 << height) - 1) >> height


def parse_merkleblock(raw):
    """A node's gettxoutproof: header + partial merkle tree (BIP 37). Returns the header, the
    matched txids and whether the tree's root equals the header's merkle root."""
    b = bytes(raw)
    header = parse_header(b[:80])
    total = struct.unpack_from("<I", b, 80)[0]
    i = 84
    nh, i = read_varint(b, i)
    hashes = [b[i + 32 * k:i + 32 * (k + 1)] for k in range(nh)]
    i += 32 * nh
    nf, i = read_varint(b, i)
    flag_bytes = b[i:i + nf]
    bits = [(flag_bytes[k // 8] >> (k % 8)) & 1 for k in range(8 * nf)]
    height = 0
    while _tree_width(total, height) > 1:
        height += 1
    st = {"bit": 0, "hash": 0}
    matched = []

    def walk(h, pos):
        if st["bit"] >= len(bits):
            raise ValueError("merkle proof ran out of flag bits")
        flag = bits[st["bit"]]
        st["bit"] += 1
        if h == 0 or not flag:
            if st["hash"] >= len(hashes):
                raise ValueError("merkle proof ran out of hashes")
            x = hashes[st["hash"]]
            st["hash"] += 1
            if h == 0 and flag:
                matched.append(rev_hex(x))
            return x
        left = walk(h - 1, pos * 2)
        right = walk(h - 1, pos * 2 + 1) if pos * 2 + 1 < _tree_width(total, h - 1) else left
        if pos * 2 + 1 < _tree_width(total, h - 1) and right == left:
            raise ValueError("duplicate subtree (CVE-2012-2459 shape) — proof rejected")
        return P.sha256d(left + right)

    root = walk(height, 0)
    return {"header": header, "total_transactions": total, "matched_txids": matched,
            "root": rev_hex(root), "root_ok": rev_hex(root) == header["merkle_root"],
            "all_hashes_used": st["hash"] == len(hashes)}


def build_merkleblock(header80, txids_hex, match):
    """BIP 37 builder (self-test helper): a partial tree proving the txids in `match`."""
    leaves = [bytes.fromhex(t)[::-1] for t in txids_hex]
    total = len(leaves)
    flags_in = [t in match for t in txids_hex]

    def node_hash(h, pos):
        if h == 0:
            return leaves[pos]
        left = node_hash(h - 1, pos * 2)
        right = node_hash(h - 1, pos * 2 + 1) if pos * 2 + 1 < _tree_width(total, h - 1) else left
        return P.sha256d(left + right)

    bits, hashes = [], []

    def build(h, pos):
        parent_of_match = any(flags_in[p] for p in range(pos << h, min((pos + 1) << h, total)))
        bits.append(parent_of_match)
        if h == 0 or not parent_of_match:
            hashes.append(node_hash(h, pos))
        else:
            build(h - 1, pos * 2)
            if pos * 2 + 1 < _tree_width(total, h - 1):
                build(h - 1, pos * 2 + 1)

    height = 0
    while _tree_width(total, height) > 1:
        height += 1
    build(height, 0)
    fb = bytearray((len(bits) + 7) // 8)
    for k, bit in enumerate(bits):
        if bit:
            fb[k // 8] |= 1 << (k % 8)
    return bytes(header80) + struct.pack("<I", total) + varint(len(hashes)) + b"".join(hashes) + varint(len(fb)) + bytes(fb)


# ------------------------------------------------------------------------ cross-checks
def compare_with_json(parsed, api_json):
    """Does the provider's JSON agree with the bytes? Returns a list of disagreements (empty = agrees).
    Compares txid, output count, each output's value and address."""
    diffs = []
    if not isinstance(api_json, dict):
        return ["provider JSON is not an object"]
    if api_json.get("txid") and api_json["txid"] != parsed["txid"]:
        diffs.append("txid: provider {} vs bytes {}".format(api_json["txid"], parsed["txid"]))
    outs = api_json.get("vout") or []
    if outs and len(outs) != len(parsed["vout"]):
        diffs.append("output count: provider {} vs bytes {}".format(len(outs), len(parsed["vout"])))
    for o_api, o in zip(outs, parsed["vout"]):
        v = o_api.get("value")
        if isinstance(v, int) and v != o["value_sats"]:  # REST indexes give satoshis as integers
            diffs.append("output {} value: provider {} vs bytes {}".format(o["n"], v, o["value_sats"]))
        elif isinstance(v, float) and round(v * SATS) != o["value_sats"]:  # node RPC gives BTC as decimals
            diffs.append("output {} value: provider {} BTC vs bytes {} sats".format(o["n"], v, o["value_sats"]))
        a = o_api.get("scriptpubkey_address") or (o_api.get("scriptPubKey") or {}).get("address")
        if a and o.get("address") and a != o["address"]:
            diffs.append("output {} address: provider {} vs bytes {}".format(o["n"], a, o["address"]))
    return diffs


def btc(sats):
    """Satoshis as a BTC string with all eight places (no float arithmetic)."""
    neg = sats < 0
    s = "{}.{:08d}".format(abs(sats) // SATS, abs(sats) % SATS)
    return ("-" if neg else "") + s
