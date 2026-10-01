# -*- coding: utf-8 -*-
"""Offline self-test for the coin desk. No network: every source is a fixture.

The Bitcoin checks use the real genesis block (public chain data): its coinbase transaction must
hash to its txid, that txid must be the header's merkle root, and the header must hash to the
known block hash with valid proof of work. If any byte of the fixture were wrong, these would fail.
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import attribution as A  # noqa: E402
import btc  # noqa: E402
import connect  # noqa: E402
import evidence as E  # noqa: E402
import evm  # noqa: E402
import graph as G  # noqa: E402
import lineage as LN  # noqa: E402
import models as M  # noqa: E402
import net  # noqa: E402
import primitives as P  # noqa: E402
import registry as R  # noqa: E402
import report  # noqa: E402
import signals  # noqa: E402

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))


def genesis():
    msg = b"The Times 03/Jan/2009 Chancellor on brink of second bailout for banks"
    ss = bytes.fromhex("04ffff001d0104") + bytes([len(msg)]) + msg
    pk = bytes.fromhex("04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f")
    spk = bytes([65]) + pk + b"\xac"
    raw = struct.pack("<i", 1) + b"\x01" + b"\x00" * 32 + b"\xff\xff\xff\xff" + btc.varint(len(ss)) + ss + b"\xff\xff\xff\xff" + b"\x01" + \
        struct.pack("<q", 5000000000) + btc.varint(len(spk)) + spk + b"\x00\x00\x00\x00"
    return raw


GENESIS_HEADER = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c"
GENESIS_TXID = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"
GENESIS_HASH = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"


def synthetic_segwit():
    x = P.segwit_encode("bc", 0, bytes(range(20)))
    y = P.segwit_encode("bc", 1, bytes(range(32, 64)))
    tx = {"version": 2, "locktime": 0,
          "vin": [{"prev_txid": "ab" * 32, "prev_vout": 0, "script_sig": "", "sequence": 0xFFFFFFFD, "witness": ["30" * 71, "02" + "11" * 32]}],
          "vout": [{"value_sats": 50000000, "script_pubkey": "0014" + bytes(range(20)).hex()},
                   {"value_sats": 20000000, "script_pubkey": "5120" + bytes(range(32, 64)).hex()}]}
    return btc.serialize_tx(tx), x, y


def mine_regtest_header(merkle_root_hex, prev="00" * 32):
    for nonce in range(1 << 20):
        h = struct.pack("<i", 0x20000000) + bytes.fromhex(prev)[::-1] + bytes.fromhex(merkle_root_hex)[::-1] + struct.pack("<III", 1760000000, 0x207FFFFF, nonce)
        if btc.parse_header(h)["pow_ok"]:
            return h
    raise RuntimeError("could not mine")


def main():
    tmp = tempfile.mkdtemp(prefix="coin-selftest-")
    saved_env = dict(os.environ)
    try:
        run(tmp)
    finally:
        os.environ.clear()
        os.environ.update(saved_env)
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in RESULTS if not r[1]]
    for name, ok, detail in RESULTS:
        print("{}  {}{}".format("PASS" if ok else "FAIL", name, "  — " + detail if detail and not ok else ""))
    print("\ncoin selftest: {} passed, {} failed, {} checks".format(len(RESULTS) - len(failed), len(failed), len(RESULTS)))
    return 1 if failed else 0


def run(tmp):
    # ------------------------------------------------------------ primitives (their own suite)
    r = subprocess.run([sys.executable, os.path.join(HERE, "test_primitives.py")], capture_output=True, text=True)
    last = [l for l in r.stdout.splitlines() if l.startswith("RESULT")]
    check("primitives suite (keccak, EIP-55, base58, bech32/m, RIPEMD-160, Ed25519)", r.returncode == 0, last[0] if last else r.stdout[-200:])

    # ------------------------------------------------------------ Bitcoin from bytes: the genesis block
    g = btc.parse_tx(genesis())
    check("genesis coinbase bytes hash to its txid", g["txid"] == GENESIS_TXID, g["txid"])
    h = btc.parse_header(bytes.fromhex(GENESIS_HEADER))
    check("genesis header hashes to the genesis block hash", h["hash"] == GENESIS_HASH, h["hash"])
    check("genesis header proof of work is valid", h["pow_ok"])
    check("genesis merkle root = coinbase txid (one-transaction block)", h["merkle_root"] == GENESIS_TXID)
    check("P2PK output has no address; P2PKH form shown as DERIVED", g["vout"][0]["address"] is None and
          g["vout"][0]["detail"]["p2pkh_form_DERIVED"] == "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
    check("serialize(parse(tx)) round-trips byte for byte", btc.serialize_tx(g) == genesis())
    bad_h = bytearray(bytes.fromhex(GENESIS_HEADER)); bad_h[76] ^= 1
    check("one changed nonce bit breaks the proof of work", not btc.parse_header(bytes(bad_h))["pow_ok"])

    # ------------------------------------------------------------ segwit: txid excludes witness
    raw, x_addr, y_addr = synthetic_segwit()
    s1 = btc.parse_tx(raw)
    tx2 = btc.parse_tx(raw); tx2["vin"][0]["witness"] = ["31" * 71, "02" + "22" * 32]
    s2 = btc.parse_tx(btc.serialize_tx(tx2))
    check("segwit: changing the witness keeps the txid", s1["txid"] == s2["txid"])
    check("segwit: changing the witness changes the wtxid", s1["wtxid"] != s2["wtxid"])
    check("segwit outputs decode to p2wpkh / p2tr addresses", s1["vout"][0]["address"] == x_addr and s1["vout"][1]["type"] == "p2tr")
    check("weight and vsize are computed from base and total size", s1["weight"] == s1["base_size"] * 3 + s1["size"])

    # ------------------------------------------------------------ merkle proofs
    txids = [P.sha256d(bytes([k])).hex() for k in range(7)]
    root = btc.merkle_root_of(txids)
    check("merkle branch verifies for every position (7 leaves, odd layers)",
          all(btc.verify_branch(t, btc.branch_for(txids, k), k, root) for k, t in enumerate(txids)))
    check("a branch for the wrong position fails", not btc.verify_branch(txids[2], btc.branch_for(txids, 2), 3, root))
    hdr = mine_regtest_header(root)
    mb = btc.parse_merkleblock(btc.build_merkleblock(hdr, txids, {txids[1], txids[5]}))
    check("node-style partial merkle tree (BIP 37) proves the matched txids", mb["root_ok"] and mb["matched_txids"] == [txids[1], txids[5]])
    mb_bad = bytearray(btc.build_merkleblock(hdr, txids, {txids[1]})); mb_bad[90] ^= 1
    check("a tampered partial tree does not reach the header's root", not btc.parse_merkleblock(bytes(mb_bad))["root_ok"])

    # ------------------------------------------------------------ address checks
    check("BIP-173 address validates", btc.validate_address("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")["valid"])
    check("one wrong character in a bech32 address is caught", not btc.validate_address("bc1qw508d6qejxtdg4c5r3zarvary0c5xw7kv8f3t4")["valid"])
    check("one wrong character in a legacy address is caught", not btc.validate_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")["valid"])
    check("EVM: EIP-55 mixed-case typo is caught", not evm.validate_address("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")["valid"])

    # ------------------------------------------------------------ tokens
    check("Transfer topic = keccak256('Transfer(address,address,uint256)')",
          evm.TRANSFER_TOPIC == "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
    check("every shipped contract passes its EIP-55 checksum", all(s == "VALID" for *_, s in R.check_default_tokens()))
    reg = R.TokenRegistry()
    u_eth, u_base = reg.resolve("USDC", "ethereum"), reg.resolve("USDC", "base")
    check("USDC on Ethereum and USDC on Base are different identities", R.TokenRegistry.key_of(u_eth) != R.TokenRegistry.key_of(u_base))
    try:
        reg.add({"chain": "ethereum", "network": "mainnet", "contract_address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4b", "symbol": "X", "decimals": 6})
        check("token add refuses a contract with a bad checksum", False)
    except ValueError:
        check("token add refuses a contract with a bad checksum", True)

    # ------------------------------------------------------------ secrets never reach disk
    SECRET_KEY = "sk_live_FAKE_9f8e7d6c5b4a39281706"
    SECRET_PATH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
    SECRET_PW = "pw_fake_77aa88bb"
    os.environ["STABLECOIN_API_KEY"] = SECRET_KEY
    os.environ["BITCOIN_API_KEY"] = SECRET_KEY + "b"
    os.environ["SENTINEL_EVM_RPC_ETHEREUM"] = "https://desk:{}@rpc.fixture.test/v3/{}?apikey=qwertyuiop1234".format(SECRET_PW, SECRET_PATH)
    os.environ["SENTINEL_EVM_RPC2_ETHEREUM"] = "https://rpc2.fixture.test/"
    os.environ["SENTINEL_BTC_REST_URL"] = "https://btc.fixture.test/api"
    os.environ["SENTINEL_BTC_REST2_URL"] = "https://btc2.fixture.test/api"
    red = net.redact_url(os.environ["SENTINEL_EVM_RPC_ETHEREUM"])
    check("redact_url removes userinfo, path token and api key", SECRET_PW not in red and SECRET_PATH not in red and "qwertyuiop1234" not in red, red)
    check("redaction keeps txids and addresses readable",
          "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" in net.redact_url("https://x.test/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa/txs") and
          GENESIS_TXID in net.redact_url("https://x.test/tx/" + GENESIS_TXID))
    try:
        net.HttpTransport().request("GET", "http://example.test/")
        check("plain http to a remote host is refused", False)
    except net.NetError:
        check("plain http to a remote host is refused", True)

    store = E.Store(os.path.join(tmp, "evidence"))

    # ------------------------------------------------------------ connect bitcoin tx (REST fixture) → V1, V2, V3
    raw_tx, x_addr, y_addr = synthetic_segwit()
    ptx = btc.parse_tx(raw_tx)
    txid = ptx["txid"]
    block_txids = [P.sha256d(b"cb").hex(), txid, P.sha256d(b"t3").hex(), P.sha256d(b"t4").hex()]
    root = btc.merkle_root_of(block_txids)
    header = mine_regtest_header(root)
    bhash = btc.parse_header(header)["hash"]
    z_addr = P.segwit_encode("bc", 0, bytes(range(100, 120)))
    tx_json = {"txid": txid, "vin": [{"txid": "ab" * 32, "vout": 0, "is_coinbase": False, "prevout": {"scriptpubkey_address": z_addr, "value": 70010000}}],
               "vout": [{"scriptpubkey_address": x_addr, "value": 50000000, "scriptpubkey_type": "v0_p2wpkh"},
                        {"scriptpubkey_address": y_addr, "value": 20000000, "scriptpubkey_type": "v1_p2tr"}],
               "status": {"confirmed": True, "block_height": 101, "block_hash": bhash, "block_time": 1760000000}}
    B = "https://btc.fixture.test/api"
    J = "application/json"
    fx = net.FixtureTransport({
        ("GET", "{}/tx/{}".format(B, txid)): (200, J, json.dumps(tx_json).encode()),
        ("GET", "{}/tx/{}/hex".format(B, txid)): (200, "text/plain", raw_tx.hex().encode()),
        ("GET", "{}/tx/{}/merkle-proof".format(B, txid)): (200, J, json.dumps({"block_height": 101, "merkle": btc.branch_for(block_txids, 1), "pos": 1}).encode()),
        ("GET", "{}/block/{}/header".format(B, bhash)): (200, "text/plain", header.hex().encode()),
    })
    fx2 = net.FixtureTransport({("GET", "https://btc2.fixture.test/api/block-height/101"): (200, "text/plain", bhash.encode())})
    desk = connect.Desk(store=store, transport=fx, second_transport=fx2, tokens=R.TokenRegistry())
    row = desk.bitcoin_tx(txid)
    checks = {c["check"]: c["result"] for c in row["verification"]["checks"]}
    check("bitcoin tx: raw bytes hash to the txid (V1)", checks.get("raw bytes → txid") == "PASS")
    check("bitcoin tx: provider JSON agrees with the bytes", checks.get("provider JSON vs raw bytes") == "PASS")
    check("bitcoin tx: merkle proof + header proof of work (V2)", checks.get("inclusion in block") == "PASS")
    check("bitcoin tx: second index reports the same block (V3)", row["verification"]["level"] == "V3_CORROBORATED")
    inc = [c for c in row["verification"]["checks"] if c["check"] == "inclusion in block"][0]["detail"]
    check("bitcoin tx: the proof of work actually done is stated, not just 'valid'", "leading zero bits" in inc, inc)

    # a source that lies: JSON says 0.6 BTC, the bytes say 0.5
    lie = dict(tx_json); lie["vout"] = [dict(tx_json["vout"][0], value=60000000), tx_json["vout"][1]]
    fx_lie = net.FixtureTransport(dict(fx.table)); fx_lie.table[("GET", "{}/tx/{}".format(B, txid))] = (200, J, json.dumps(lie).encode())
    row_lie = connect.Desk(store=E.Store(os.path.join(tmp, "lie")), transport=fx_lie, second_transport=fx2, tokens=R.TokenRegistry()).bitcoin_tx(txid)
    check("a provider whose JSON contradicts its own bytes is caught",
          any(c["check"] == "provider JSON vs raw bytes" and c["result"] == "FAIL" for c in row_lie["verification"]["checks"]))
    # a source that serves the wrong transaction
    fx_wrong = net.FixtureTransport(dict(fx.table)); fx_wrong.table[("GET", "{}/tx/{}/hex".format(B, txid))] = (200, "text/plain", genesis().hex().encode())
    row_wrong = connect.Desk(store=E.Store(os.path.join(tmp, "wrong")), transport=fx_wrong, second_transport=fx2, tokens=R.TokenRegistry()).bitcoin_tx(txid)
    check("a source serving a different transaction stays V0 (never promoted)", row_wrong["verification"]["level"] == "V0_REPORTED")
    fx2_bad = net.FixtureTransport({("GET", "https://btc2.fixture.test/api/block-height/101"): (200, "text/plain", GENESIS_HASH.encode())})
    row_mm = connect.Desk(store=E.Store(os.path.join(tmp, "mm")), transport=fx, second_transport=fx2_bad, tokens=R.TokenRegistry()).bitcoin_tx(txid)
    check("a second source reporting a different block → MISMATCH", row_mm["verification"]["level"] == "MISMATCH")

    # ------------------------------------------------------------ connect stablecoin (EVM logs fixture) → V3 corroborated
    usdc = reg.resolve("USDC", "ethereum")
    A1 = "0x" + "11" * 20
    others = ["0x" + "{:02x}".format(k) * 20 for k in range(0x21, 0x27)]

    def log(frm, to, amt, block, idx, tx):
        return {"address": usdc["contract_address"].lower(), "topics": [evm.TRANSFER_TOPIC, evm.pad_topic(frm), evm.pad_topic(to)],
                "data": hex(amt), "blockNumber": hex(block), "transactionHash": "0x" + tx * 32, "logIndex": hex(idx), "removed": False}
    logs_in = [log(others[0], A1, 2500000000000, 400, 0, "a1"), log(others[1], A1, 2228122000000, 410, 3, "a2")]
    logs_out = [log(A1, others[2], 4510991000000, 450, 1, "b1")]
    nft = dict(logs_in[0]); nft["topics"] = nft["topics"] + ["0x" + "00" * 31 + "07"]
    table = {("RPC", "eth_blockNumber", "[]"): (200, J, "0x1f4")}
    for label, flt in evm.log_filter(usdc["contract_address"], A1, "both", 0, 500):
        table[("RPC", "eth_getLogs", json.dumps([flt], sort_keys=True))] = (200, J, logs_in + [nft] if label == "in" else logs_out)
    for bn, ts in ((400, 1759000000), (410, 1759000600), (450, 1759003000)):
        table[("RPC", "eth_getBlockByNumber", json.dumps([hex(bn), False], sort_keys=True))] = (200, J, {"timestamp": hex(ts)})
    table2 = {k: v for k, v in table.items() if k[1] == "eth_getLogs"}
    evm_store = E.Store(os.path.join(tmp, "evm"))
    d2 = connect.Desk(store=evm_store, transport=net.FixtureTransport(table), second_transport=net.FixtureTransport(table2), tokens=R.TokenRegistry())
    res = d2.token_transfers("USDC", "ethereum", A1)
    check("EVM: ERC-721 style log (4 topics) is not counted as a fungible transfer", len(res["transfers"]) == 3)
    check("EVM: identical log sets from two endpoints → V3_CORROBORATED", all(t["verification"] == "V3_CORROBORATED" for t in res["transfers"]))
    tkey = R.TokenRegistry.key_of(usdc)
    text, calcs = report.address_report(evm_store, usdc, tkey, A1, 0, 500)
    check("report: received = 4,728,122.00 USDC exactly", calcs["RECEIVED"]["result"]["units"] == "4728122", calcs["RECEIVED"]["result"])
    check("report: sent = 4,510,991.00 USDC exactly", calcs["SENT"]["result"]["units"] == "4510991")
    check("report: token units carry the symbol, never a dollar sign", "4,728,122.00 USDC" in text and "$" not in text)
    check("report: OBSERVED / DERIVED / ATTRIBUTION / SOURCE / VERIFICATION sections",
          all(s in text for s in ("OBSERVED", "DERIVED", "ATTRIBUTION", "SOURCE", "VERIFICATION", "WHAT THIS DOES NOT SHOW")))
    check("report: address attribution defaults to UNVERIFIED", "Address attribution UNVERIFIED" in text)

    # corroboration mismatch
    table_bad = dict(table2)
    k_in = [k for k in table_bad if "0x" + "0" * 24 + A1[2:] in k[2] and json.loads(k[2])[0]["topics"][2]]
    table_bad[k_in[0]] = (200, J, logs_in[:1])
    d3 = connect.Desk(store=E.Store(os.path.join(tmp, "evm_mm")), transport=net.FixtureTransport(table), second_transport=net.FixtureTransport(table_bad), tokens=R.TokenRegistry())
    res3 = d3.token_transfers("USDC", "ethereum", A1)
    check("EVM: a second endpoint missing one transfer → MISMATCH", any(t["verification"] == "MISMATCH" for t in res3["transfers"]))

    # ------------------------------------------------------------ lineage and provenance
    LN.link_finding(evm_store, "F-TEST-01", [calcs["RECEIVED"]["calc_id"]], "Address A received 4,728,122.00 USDC (Ethereum) in blocks 0–500.")
    tree = LN.provenance(evm_store, "F-TEST-01")
    res_checks = {c["check"]: c["result"] for c in tree["checks"]}
    check("provenance: the calculation recomputes to the stored result", res_checks.get("recompute") == "PASS")
    check("provenance: raw bytes still hash to their evidence ids", res_checks.get("raw bytes re-hashed") == "PASS")
    check("provenance: every input row is present in the bytes it cites", res_checks.get("rows present in the bytes they cite") == "PASS")
    eid = calcs["RECEIVED"]["input_evidence"][0]
    p = evm_store.raw_path(eid.split(":")[1])
    b = bytearray(open(p, "rb").read()); b[-3] = ord("9") if b[-3] != ord("9") else ord("8"); open(p, "wb").write(bytes(b))
    tree2 = LN.provenance(evm_store, "F-TEST-01")
    check("provenance: a raw file edited after intake is detected", any(c["result"] == "FAIL" for c in tree2["checks"]))
    base_rows = [dict(t, token_key=R.TokenRegistry.key_of(u_base), chain="base") for t in res["transfers"]]
    try:
        LN.calculate(evm_store, "RECEIVED", tkey, A1, res["transfers"] + base_rows)
        check("a calculation mixing USDC on two chains is refused", False)
    except LN.MixedAssetsError:
        check("a calculation mixing USDC on two chains is refused", True)

    # ------------------------------------------------------------ nothing secret on disk
    leaked = []
    for root_dir, _, files in os.walk(tmp):
        for f in files:
            data = open(os.path.join(root_dir, f), "rb").read()
            for s in (SECRET_KEY, SECRET_PATH, SECRET_PW, "qwertyuiop1234"):
                if s.encode() in data:
                    leaked.append((f, s[:6]))
    check("no credential appears in any stored file ({} files scanned)".format(sum(len(f) for _, _, f in os.walk(tmp))), not leaked, str(leaked[:3]))
    check("an API key travels in a request header, never in a stored URL",
          any(c[2].get("X-API-Key") for c in fx.calls) and not any(SECRET_KEY in c[1] for c in fx.calls))

    # ------------------------------------------------------------ attribution
    A.add(evm_store, A1, "Some Exchange hot wallet", "PROVIDER_LABEL", "explorer label")
    check("a provider label stays UNVERIFIED", A.status(evm_store, A1)["status"] == "UNVERIFIED")
    try:
        A.add(evm_store, A1, "X", "OFFICIAL_ATTRIBUTION", "S-99")
        check("an official attribution without quote + locator is refused", False)
    except ValueError:
        check("an official attribution without quote + locator is refused", True)
    try:
        A.add(evm_store, A1, "X", "OFFICIAL_ATTRIBUTION", "S-99", locator="p. 4", quote="the wallet 0xdeadbeef")
        check("a quote that does not contain the address is refused", False)
    except ValueError:
        check("a quote that does not contain the address is refused", True)
    A.add(evm_store, others[3], "Jane Q. Private", "COURT_RECORD", "case 1:26-cv-1", locator="¶ 12", quote="address {} belongs to".format(others[3]), private_person=True)
    st = A.status(evm_store, others[3])
    check("a private person's name is never shown", "Jane" not in st["text"] and "private person" in st["text"])
    check("exports exclude private people and provider labels", all(not r["private_person"] and r["class"] != "PROVIDER_LABEL" for r in A.public_rows(evm_store)))

    # ------------------------------------------------------------ signals (synthetic rug-pull)
    zero = "0x" + "0" * 40
    dev = "0x" + "de" * 20
    tok = {"chain": "ethereum", "network": "mainnet", "symbol": "RUG", "contract_address": "0x" + "ab" * 20, "decimals": 18}
    rk = "ethereum:mainnet:" + tok["contract_address"]
    rows = [M.make_transfer(tok, token_key=rk, tx_hash="0xm1", block_number=100, log_index=0, from_address=zero, to_address=dev,
                            amount_raw=str(10 ** 24), evidence_id="sha256:x", timestamp="2026-01-01T00:00:00Z")]
    for k in range(25):
        rows.append(M.make_transfer(tok, token_key=rk, tx_hash="0xf{}".format(k), block_number=101, log_index=k, from_address=dev,
                                    to_address="0x" + "{:040x}".format(k + 1), amount_raw=str(10 ** 22), evidence_id="sha256:x",
                                    timestamp="2026-01-01T00:{:02d}:00Z".format(k)))
    rows.append(M.make_transfer(tok, token_key=rk, tx_hash="0xm2", block_number=100 + 60000, log_index=0, from_address=zero, to_address=dev,
                                amount_raw=str(5 * 10 ** 23), evidence_id="sha256:x", timestamp="2026-02-01T00:00:00Z"))
    sig = signals.run(rows)
    names = set(s["signal"] for s in sig)
    check("rug-pull shape: fresh mint fanned out to 25 wallets → FRESH_MINT_FANOUT", "FRESH_MINT_FANOUT" in names, str(names))
    check("rug-pull shape: supply minted 60,000 blocks later → LATE_MINT", "LATE_MINT" in names)
    check("every signal says it is not a finding and names what would settle it",
          all(s["status"].startswith("SIGNAL") and s["what_would_settle_it"] for s in sig))
    # peel chain
    btok = {"chain": "bitcoin", "network": "mainnet", "symbol": "BTC", "contract_address": None, "decimals": 8}
    bk = "bitcoin:mainnet:native"
    prow = []
    for k in range(4):
        prow.append(M.make_transfer(btok, token_key=bk, tx_hash="p{}".format(k), block_number=k, log_index=0, from_address="tx:p{}".format(k),
                                    to_address="pay{}".format(k), amount_raw="1000000", evidence_id="sha256:y"))
        prow.append(M.make_transfer(btok, token_key=bk, tx_hash="p{}".format(k), block_number=k, log_index=1, from_address="tx:p{}".format(k),
                                    to_address="hop{}".format(k), amount_raw=str(90000000 - k * 1000000), evidence_id="sha256:y"))
        if k:
            prow.append(M.make_transfer(btok, token_key=bk, tx_hash="p{}".format(k), block_number=k, log_index=-1, from_address="hop{}".format(k - 1),
                                        to_address="tx:p{}".format(k), amount_raw=str(90000000 - (k - 1) * 1000000), evidence_id="sha256:y"))
    check("Bitcoin peel chain of 4 transactions → PEEL_CHAIN", any(s["signal"] == "PEEL_CHAIN" for s in signals.run(prow)))

    # ------------------------------------------------------------ graph
    nodes, edges = G.neighbourhood(evm_store.rows("normalized/transfers.jsonl"), A1, hops=1, token_key=tkey)
    check("graph: one hop from the address finds its 3 counterparties", len([n for n in nodes if n["hop"] == 1]) == 3)
    check("graph: edges never mix token identities", all(e["token_key"] == tkey for e in edges))


if __name__ == "__main__":
    sys.exit(main())
