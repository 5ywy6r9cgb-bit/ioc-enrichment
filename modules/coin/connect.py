# -*- coding: utf-8 -*-
"""Connectors. Deliberately boring: fetch, seal the bytes as evidence, normalize, verify.

Every response is sealed (evidence.Store.seal) before it is parsed, so a parsing bug can never
lose what the source actually said. Normalized rows carry the evidence_id of the bytes they came
from. Verification levels are earned by checks in btc.py / evm.py, never assumed.
"""
import base64
import json
import os

import btc
import evidence as E
import evm
import models as M
import net
import registry as R


class ConfigError(Exception):
    pass


class JsonRpc(object):
    def __init__(self, transport, url, headers=None):
        self.t, self.url, self.headers, self.n = transport, url, headers or {}, 0

    def call(self, method, params):
        self.n += 1
        body = {"jsonrpc": "1.0", "id": self.n, "method": method, "params": params}
        status, ctype, raw = self.t.request("POST", self.url, body=body, headers=self.headers)
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise net.NetError("{} returned something that is not JSON".format(method))
        if isinstance(doc, dict) and doc.get("error"):
            raise net.NetError("{}: {}".format(method, net.redact(json.dumps(doc["error"])[:300])))
        return status, ctype, raw, (doc.get("result") if isinstance(doc, dict) else None)


def btc_rpc_headers():
    user, pw = os.environ.get("SENTINEL_BTC_RPC_USER"), os.environ.get("SENTINEL_BTC_RPC_PASS")
    cookie = os.environ.get("SENTINEL_BTC_RPC_COOKIE")
    if cookie and os.path.isfile(cookie):
        cred = open(cookie, encoding="utf-8").read().strip()
    elif user and pw:
        cred = "{}:{}".format(user, pw)
    else:
        return {}
    return {"Authorization": "Basic " + base64.b64encode(cred.encode()).decode()}


class Desk(object):
    def __init__(self, store=None, transport=None, tokens=None, second_transport=None):
        self.store = store or E.Store()
        self.t = transport or net.HttpTransport()
        self.t2 = second_transport or self.t
        self.tokens = tokens or R.TokenRegistry(os.path.join(self.store.norm_dir, "tokens.json"))

    # ------------------------------------------------------------------ helpers
    def _get(self, provider, url, query, chain=None, network=None, expect="json"):
        s = R.SOURCES[provider]
        headers = {}
        if s.key_env and os.environ.get(s.key_env) and s.key_header:
            headers = net.auth_headers(s)
        status, ctype, raw = (self.t2 if provider.endswith("_2") else self.t).request("GET", url, headers=headers)
        parsed = None
        if expect == "json":
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                parsed = None
        env = self.store.seal(provider=provider, authoritative=s.authoritative, endpoint=url, method="GET", query=query,
                              raw=raw, content_type=ctype, http_status=status, chain=chain, network=network, parsed=parsed)
        if status and status >= 400:
            raise net.NetError("HTTP {} from {} (response kept as {})".format(status, net.redact_url(url), env["evidence_id"][:19]))
        return env, raw, parsed

    def _rpc(self, provider, rpc, method, params, chain, network, authoritative=None):
        status, ctype, raw, result = rpc.call(method, params)
        s = R.SOURCES[provider]
        env = self.store.seal(provider=provider, authoritative=s.authoritative if authoritative is None else authoritative,
                              endpoint=rpc.url, method="POST", query={"method": method, "params": params}, raw=raw,
                              content_type=ctype, http_status=status, chain=chain, network=network, parsed=result)
        return env, result

    # ------------------------------------------------------------------ bitcoin: one transaction
    def bitcoin_tx(self, txid, network="mainnet", source="auto"):
        txid = txid.strip().lower()
        if len(txid) != 64 or any(c not in "0123456789abcdef" for c in txid):
            raise ValueError("a txid is 64 hex characters")
        rpc_url, rpc_env = R.endpoint("bitcoin_node")
        rest_url, rest_env = R.endpoint("bitcoin_rest")
        if source == "auto":
            source = "node" if rpc_url else ("rest" if rest_url else None)
        if source is None:
            raise ConfigError("no Bitcoin source configured: set {} (your node) or {} (a REST index)".format(rpc_env, rest_env))
        checks, envs, api_json, block = [], [], None, {}
        if source == "node":
            if not rpc_url:
                raise ConfigError(rpc_env + " is not set")
            rpc = JsonRpc(self.t, rpc_url, btc_rpc_headers())
            env, res = self._rpc("bitcoin_node", rpc, "getrawtransaction", [txid, True], "bitcoin", network)
            envs.append(env)
            api_json, raw_hex = res, res.get("hex")
            block = {"hash": res.get("blockhash"), "confirmations_REPORTED": res.get("confirmations"), "time": res.get("blocktime")}
        else:
            if not rest_url:
                raise ConfigError(rest_env + " is not set")
            base = rest_url.rstrip("/")
            env, _, api_json = self._get("bitcoin_rest", "{}/tx/{}".format(base, txid), {"txid": txid}, "bitcoin", network)
            envs.append(env)
            env_hex, raw_hex_b, _ = self._get("bitcoin_rest", "{}/tx/{}/hex".format(base, txid), {"txid": txid, "want": "hex"},
                                              "bitcoin", network, expect="text")
            envs.append(env_hex)
            raw_hex = raw_hex_b.decode("ascii", "replace").strip()
            st = (api_json or {}).get("status") or {}
            block = {"hash": st.get("block_hash"), "height": st.get("block_height"), "time": st.get("block_time"),
                     "confirmed_REPORTED": st.get("confirmed")}
        parsed = btc.parse_tx(bytes.fromhex(raw_hex), network)
        level = "V0_REPORTED"
        if parsed["txid"] == txid:
            level = "V1_HASH_BOUND"
            checks.append({"check": "raw bytes → txid", "result": "PASS", "detail": "double SHA-256 of the transaction (witness stripped) = {}".format(txid)})
        else:
            checks.append({"check": "raw bytes → txid", "result": "FAIL", "detail": "bytes hash to {} — the source served a different transaction".format(parsed["txid"])})
        diffs = btc.compare_with_json(parsed, api_json)
        checks.append({"check": "provider JSON vs raw bytes", "result": "PASS" if not diffs else "FAIL", "detail": "; ".join(diffs) or "outputs, values and addresses agree"})
        # inclusion
        if level == "V1_HASH_BOUND" and block.get("hash"):
            try:
                if source == "node":
                    env_p, proof_hex = self._rpc("bitcoin_node", rpc, "gettxoutproof", [[txid], block["hash"]], "bitcoin", network)
                    envs.append(env_p)
                    mb = btc.parse_merkleblock(bytes.fromhex(proof_hex))
                    hdr = mb["header"]
                    ok = mb["root_ok"] and txid in mb["matched_txids"] and hdr["hash"] == block["hash"] and hdr["pow_ok"]
                    detail = "partial merkle tree → root {}; header hash {}; proof of work {} at its stated difficulty ({} leading zero bits)".format(
                        "matches" if mb["root_ok"] else "DOES NOT match", "matches" if hdr["hash"] == block["hash"] else "DIFFERS",
                        "valid" if hdr["pow_ok"] else "INVALID", hdr["work_leading_zero_bits"])
                else:
                    base = rest_url.rstrip("/")
                    env_p, _, proof = self._get("bitcoin_rest", "{}/tx/{}/merkle-proof".format(base, txid), {"txid": txid, "want": "merkle-proof"}, "bitcoin", network)
                    env_h, hdr_raw, _ = self._get("bitcoin_rest", "{}/block/{}/header".format(base, block["hash"]), {"block": block["hash"], "want": "header"}, "bitcoin", network, expect="text")
                    envs += [env_p, env_h]
                    hdr = btc.parse_header(bytes.fromhex(hdr_raw.decode("ascii").strip()))
                    in_tree = btc.verify_branch(txid, proof["merkle"], proof["pos"], hdr["merkle_root"])
                    ok = in_tree and hdr["hash"] == block["hash"] and hdr["pow_ok"]
                    detail = "merkle branch ({} hashes) → root {}; header hash {}; proof of work {} at its stated difficulty ({} leading zero bits)".format(
                        len(proof["merkle"]), "matches" if in_tree else "DOES NOT match", "matches" if hdr["hash"] == block["hash"] else "DIFFERS",
                        "valid" if hdr["pow_ok"] else "INVALID", hdr["work_leading_zero_bits"])
                    block["height"] = proof.get("block_height", block.get("height"))
                checks.append({"check": "inclusion in block", "result": "PASS" if ok else "FAIL", "detail": detail})
                if ok:
                    level = "V2_INCLUDED"
                    block["header_verified"] = hdr
            except (net.NetError, KeyError, ValueError, TypeError) as e:
                checks.append({"check": "inclusion in block", "result": "NOT RUN", "detail": net.redact(str(e))})
        elif not block.get("hash"):
            checks.append({"check": "inclusion in block", "result": "NOT RUN", "detail": "unconfirmed, or the source gave no block hash"})
        # corroboration of the block hash at that height by a second, independent index
        rest2, rest2_env = R.endpoint("bitcoin_rest_2")
        if level == "V2_INCLUDED" and rest2 and block.get("height") is not None:
            try:
                env2, h2raw, _ = self._get("bitcoin_rest_2", "{}/block-height/{}".format(rest2.rstrip("/"), block["height"]),
                                           {"height": block["height"]}, "bitcoin", network, expect="text")
                envs.append(env2)
                same = h2raw.decode("ascii").strip() == block["hash"]
                checks.append({"check": "block hash at height, second source", "result": "PASS" if same else "FAIL",
                               "detail": "independent index {} the same block at height {}".format("reports" if same else "DOES NOT report", block["height"])})
                level = "V3_CORROBORATED" if same else "MISMATCH"
            except net.NetError as e:
                checks.append({"check": "block hash at height, second source", "result": "NOT RUN", "detail": str(e)})
        verification = {"level": level, "checks": checks}
        for env in envs:
            self.store.update_verification(env, verification)
        row = {"txid": parsed["txid"], "network": network, "source": source, "evidence_ids": sorted(set(e["evidence_id"] for e in envs)),
               "block": {k: v for k, v in block.items() if k != "header_verified"}, "parsed": parsed, "verification": verification,
               "prevouts_REPORTED": _prevouts(api_json)}
        self.store.append_rows("normalized/btc_txs.jsonl", [row], key=lambda r: (r["txid"], tuple(r["evidence_ids"])))
        rows = btc_transfer_rows(row, self.tokens.tokens["bitcoin:mainnet:native"], envs[0]["evidence_id"])
        self.store.append_rows("normalized/transfers.jsonl", rows, key=M.transfer_key)
        return row

    # ------------------------------------------------------------------ bitcoin: address history (index needed)
    def bitcoin_address(self, address, network="mainnet", max_pages=8):
        v = btc.validate_address(address, network)
        if not v["valid"]:
            raise ValueError("{} — refusing to query a mistyped address".format(v["reason"]))
        rest_url, rest_env = R.endpoint("bitcoin_rest")
        if not rest_url:
            raise ConfigError("address history needs an index: set {} (a node alone has no address index)".format(rest_env))
        base = rest_url.rstrip("/")
        url = "{}/address/{}/txs".format(base, address)
        txs, envs, last = [], [], None
        for page in range(max_pages):
            env, _, data = self._get("bitcoin_rest", url, {"address": address, "page": page, "after": last}, "bitcoin", network)
            envs.append(env)
            if not isinstance(data, list) or not data:
                break
            for tx in data:
                txs.append((tx, env["evidence_id"]))
            confirmed = [t for t in data if (t.get("status") or {}).get("confirmed")]
            if len(confirmed) < 25:
                break
            last = confirmed[-1]["txid"]
            url = "{}/address/{}/txs/chain/{}".format(base, address, last)
        token = self.tokens.tokens["bitcoin:mainnet:native"]
        rows = []
        for tx, eid in txs:
            rows += btc_rows_from_json(tx, token, eid)
        added = self.store.append_rows("normalized/transfers.jsonl", rows, key=M.transfer_key)
        return {"address": address, "transactions": len(txs), "rows": rows, "rows_added": added, "envelopes": envs,
                "pages": len(envs), "complete": len(envs) < max_pages}

    # ------------------------------------------------------------------ EVM tokens (stablecoins and others)
    def evm_rpc(self, chain, second=False):
        url, env_name = R.endpoint("evm_rpc_2" if second else "evm_rpc", chain)
        if not url:
            if second:
                return None
            raise ConfigError("no endpoint for {}: set {}".format(chain, env_name))
        return evm.Rpc(self.t2 if second else self.t, url)

    def token_transfers(self, symbol, chain, address, network="mainnet", direction="both", from_block=None, to_block=None,
                        chunk=5000, contract=None, timestamps=True, max_blocks_for_time=400):
        v = evm.validate_address(address)
        if not v["valid"]:
            raise ValueError("{} — refusing to query a mistyped address".format(v["reason"]))
        tok = self.tokens.resolve(symbol, chain, network, contract)
        if not tok.get("contract_address"):
            raise ConfigError("{} on {}:{} has no contract recorded (status {})".format(symbol, chain, network, tok.get("status")))
        rpc = self.evm_rpc(chain)
        rpc2 = self.evm_rpc(chain, second=True)
        own = R.is_own_node(chain)
        if to_block is None:
            env_tip, tip = self._rpc("evm_rpc", rpc, "eth_blockNumber", [], chain, network, authoritative=own)
            to_block = evm.hex_int(tip)
        if from_block is None:
            from_block = max(0, to_block - 10000)
        tkey = R.TokenRegistry.key_of(tok)
        transfers, envs, checks = [], [], []
        start = from_block
        while start <= to_block:
            end = min(to_block, start + chunk - 1)
            for label, flt in evm.log_filter(tok["contract_address"], address, direction, start, end):
                env, logs = self._rpc("evm_rpc", rpc, "eth_getLogs", [flt], chain, network, authoritative=own)
                envs.append(env)
                got = []
                for lg in logs or []:
                    d, why = evm.decode_transfer(lg)
                    if d is None:
                        continue
                    if d["contract_address"] != tok["contract_address"].lower():
                        continue
                    got.append(M.make_transfer(tok, token_key=tkey, tx_hash=d["tx_hash"], block_number=d["block_number"],
                                               log_index=d["log_index"], from_address=d["from_address"], to_address=d["to_address"],
                                               amount_raw=d["amount_raw"], evidence_id=env["evidence_id"],
                                               timestamp_hex=d.get("timestamp_hex")))
                level = "V0_REPORTED"
                if rpc2 is not None:
                    env2, logs2 = self._rpc("evm_rpc_2", rpc2, "eth_getLogs", [flt], chain, network)
                    envs.append(env2)
                    got2 = [d2 for d2, _ in (evm.decode_transfer(x) for x in (logs2 or [])) if d2 and d2["contract_address"] == tok["contract_address"].lower()]
                    same = evm.transfer_set(got) == evm.transfer_set([dict(t) for t in got2])
                    level = "V3_CORROBORATED" if same else "MISMATCH"
                    checks.append({"check": "blocks {}–{} ({}) second endpoint".format(start, end, label), "result": "PASS" if same else "FAIL",
                                   "detail": "{} transfers from each; sets {}".format(len(got), "identical" if same else "DIFFER")})
                    self.store.update_verification(env2, {"level": level, "checks": checks[-1:]})
                for t in got:
                    t["verification"] = level
                self.store.update_verification(env, {"level": level, "checks": checks[-1:] if rpc2 is not None else []})
                transfers += got
            start = end + 1
        # timestamps: REPORTED unless corroborated; one small request per distinct block (bounded)
        blocks = sorted(set(t["block_number"] for t in transfers if t.get("timestamp") is None))
        if timestamps and blocks and len(blocks) <= max_blocks_for_time:
            ts = {}
            for bn in blocks:
                if any(t.get("timestamp_hex") for t in transfers if t["block_number"] == bn):
                    th = next(t["timestamp_hex"] for t in transfers if t["block_number"] == bn and t.get("timestamp_hex"))
                    ts[bn] = evm.hex_int(th)
                    continue
                env_b, blk = self._rpc("evm_rpc", rpc, "eth_getBlockByNumber", [hex(bn), False], chain, network, authoritative=own)
                ts[bn] = evm.hex_int((blk or {}).get("timestamp"))
            for t in transfers:
                if ts.get(t["block_number"]) is not None:
                    t["timestamp"] = E.datetime.datetime.fromtimestamp(ts[t["block_number"]], E.datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        for t in transfers:
            t.pop("timestamp_hex", None)
        added = self.store.append_rows("normalized/transfers.jsonl", transfers, key=M.transfer_key)
        return {"token": tok, "token_key": tkey, "address": address.lower(), "from_block": from_block, "to_block": to_block,
                "transfers": transfers, "rows_added": added, "envelopes": envs, "checks": checks,
                "corroborated": rpc2 is not None}

    def token_tx(self, symbol, chain, tx_hash, network="mainnet", contract=None):
        tok = self.tokens.resolve(symbol, chain, network, contract)
        rpc = self.evm_rpc(chain)
        own = R.is_own_node(chain)
        env, rec = self._rpc("evm_rpc", rpc, "eth_getTransactionReceipt", [tx_hash], chain, network, authoritative=own)
        if not rec:
            raise net.NetError("no receipt for {} (unknown or pending)".format(tx_hash))
        checks, level = [], "V0_REPORTED"
        try:
            env_raw, raw_hex = self._rpc("evm_rpc", rpc, "eth_getRawTransactionByHash", [tx_hash], chain, network, authoritative=own)
            ok = bool(raw_hex) and evm.verify_raw_tx(raw_hex, tx_hash)
            checks.append({"check": "raw signed transaction → hash", "result": "PASS" if ok else "FAIL",
                           "detail": "Keccak-256 of the raw transaction {} the hash asked for".format("equals" if ok else "does NOT equal")})
            if ok:
                level = "V1_HASH_BOUND"
        except net.NetError as e:
            checks.append({"check": "raw signed transaction → hash", "result": "NOT RUN", "detail": "endpoint does not serve raw transactions ({})".format(str(e)[:80])})
        if str(rec.get("status")) in ("0x0", "0"):
            checks.append({"check": "execution status", "result": "NOTE", "detail": "transaction REVERTED — its logs moved nothing"})
        tkey = R.TokenRegistry.key_of(tok)
        rows = []
        for lg in rec.get("logs") or []:
            d, _ = evm.decode_transfer(lg)
            if d and d["contract_address"] == (tok.get("contract_address") or "").lower():
                rows.append(M.make_transfer(tok, token_key=tkey, tx_hash=d["tx_hash"], block_number=d["block_number"], log_index=d["log_index"],
                                            from_address=d["from_address"], to_address=d["to_address"], amount_raw=d["amount_raw"],
                                            evidence_id=env["evidence_id"]))
        verification = {"level": level, "checks": checks,
                        "note": "the transaction is hash-bound; its logs are the node's execution result (REPORTED)" if level == "V1_HASH_BOUND" else None}
        self.store.update_verification(env, verification)
        self.store.append_rows("normalized/transfers.jsonl", rows, key=M.transfer_key)
        return {"token": tok, "tx_hash": tx_hash, "receipt_status": rec.get("status"), "transfers": rows, "verification": verification,
                "evidence_id": env["evidence_id"]}


# ---------------------------------------------------------------------- bitcoin normalization helpers
def _prevouts(api_json):
    out = []
    for v in (api_json or {}).get("vin") or []:
        p = v.get("prevout") or {}
        out.append({"txid": v.get("txid"), "vout": v.get("vout"), "address": p.get("scriptpubkey_address"), "value_sats": p.get("value"),
                    "coinbase": v.get("is_coinbase", False)})
    return out


def btc_transfer_rows(row, token, evidence_id):
    tkey = R.TokenRegistry.key_of(token)
    p = row["parsed"]
    node = "tx:" + p["txid"]
    base = dict(block_number=(row.get("block") or {}).get("height"), evidence_id=evidence_id, token_key=tkey)
    out = []
    for o in p["vout"]:
        out.append(M.make_transfer(token, tx_hash=p["txid"], log_index=o["n"], from_address=node,
                                   to_address=o["address"] or "script:" + o["type"], amount_raw=str(o["value_sats"]), **base))
    for k, pv in enumerate(row.get("prevouts_REPORTED") or []):
        if pv.get("coinbase"):
            out.append(M.make_transfer(token, tx_hash=p["txid"], log_index=-(k + 1), from_address="coinbase", to_address=node,
                                       amount_raw="0", **base))
        elif pv.get("address") is not None and pv.get("value_sats") is not None:
            out.append(M.make_transfer(token, tx_hash=p["txid"], log_index=-(k + 1), from_address=pv["address"], to_address=node,
                                       amount_raw=str(pv["value_sats"]), **base))
    lvl = row["verification"]["level"]
    for t in out:
        t["verification"] = lvl if t["log_index"] >= 0 else "V0_REPORTED"  # input values come from the provider's prevout data
    return out


def btc_rows_from_json(tx, token, evidence_id):
    """Rows from a REST index's transaction JSON (REPORTED until `connect bitcoin tx` verifies the txid)."""
    tkey = R.TokenRegistry.key_of(token)
    node = "tx:" + tx["txid"]
    st = tx.get("status") or {}
    ts = st.get("block_time")
    stamp = E.datetime.datetime.fromtimestamp(ts, E.datetime.timezone.utc).isoformat().replace("+00:00", "Z") if ts else None
    base = dict(block_number=st.get("block_height"), evidence_id=evidence_id, token_key=tkey, timestamp=stamp)
    out = []
    for n, o in enumerate(tx.get("vout") or []):
        out.append(M.make_transfer(token, tx_hash=tx["txid"], log_index=n, from_address=node,
                                   to_address=o.get("scriptpubkey_address") or "script:" + str(o.get("scriptpubkey_type")),
                                   amount_raw=str(o.get("value", 0)), **base))
    for k, v in enumerate(tx.get("vin") or []):
        if v.get("is_coinbase"):
            continue
        p = v.get("prevout") or {}
        out.append(M.make_transfer(token, tx_hash=tx["txid"], log_index=-(k + 1), from_address=p.get("scriptpubkey_address") or "script:unknown",
                                   to_address=node, amount_raw=str(p.get("value", 0)), **base))
    return out
