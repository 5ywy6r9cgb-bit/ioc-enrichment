# -*- coding: utf-8 -*-
"""Where chain data can come from, and which token is which.

SOURCES: one registry instead of API URLs scattered through code. Endpoints are read from the
environment at call time (names below); nothing here contains a URL or a credential. Whether a
source is `authoritative` describes the kind of source (your own node is; a third-party index
is not). Authority is not proof: the checks in btc.py / evm.py are what move data from REPORTED
to VERIFIED.

TOKENS: a token is identified by (chain, network, contract), never by its symbol. USDC on
Ethereum and USDC on Base are two different assets with two different contracts; this module
refuses to add them together.
"""
import json
import os
from collections import namedtuple

import primitives as P

Source = namedtuple("Source", "key name category authoritative requires_key url_env key_env key_header key_prefix shape notes")

SOURCES = {
    "bitcoin_node": Source(
        "bitcoin_node", "Bitcoin node (your own), JSON-RPC", "blockchain", True, False,
        "SENTINEL_BTC_RPC_URL", None, None, None, "bitcoin-core-rpc",
        "Credentials: SENTINEL_BTC_RPC_USER + SENTINEL_BTC_RPC_PASS, or SENTINEL_BTC_RPC_COOKIE (path to the node's .cookie file). "
        "Needs txindex=1 for arbitrary transactions. A node has no address index; use bitcoin_rest for address history."),
    "bitcoin_rest": Source(
        "bitcoin_rest", "Bitcoin REST index (the /tx/<txid> shape in your coin-api design)", "blockchain_api", False, False,
        "SENTINEL_BTC_REST_URL", "BITCOIN_API_KEY", "X-API-Key", None, "rest-tx-path",
        "Paths used: /tx/<txid>, /tx/<txid>/hex, /tx/<txid>/merkle-proof, /block/<hash>/header, /blocks/tip/height, "
        "/address/<addr>/txs[/chain/<last_txid>]. The key is sent only if BITCOIN_API_KEY is set."),
    "bitcoin_rest_2": Source(
        "bitcoin_rest_2", "Second, independent Bitcoin REST index (for corroboration)", "blockchain_api", False, False,
        "SENTINEL_BTC_REST2_URL", None, None, None, "rest-tx-path", "Optional. Used only to corroborate block hashes and transactions."),
    "evm_rpc": Source(
        "evm_rpc", "EVM JSON-RPC endpoint, per chain", "blockchain", False, False,
        "SENTINEL_EVM_RPC_<CHAIN>", None, None, None, "eth-json-rpc",
        "One variable per chain, e.g. SENTINEL_EVM_RPC_ETHEREUM, SENTINEL_EVM_RPC_BASE. Your own node counts as authoritative: "
        "set SENTINEL_EVM_RPC_<CHAIN>_OWN=1."),
    "evm_rpc_2": Source(
        "evm_rpc_2", "Second, independent EVM JSON-RPC endpoint, per chain", "blockchain", False, False,
        "SENTINEL_EVM_RPC2_<CHAIN>", None, None, None, "eth-json-rpc",
        "Optional. When set, every log range is fetched twice and compared (CORROBORATED or MISMATCH)."),
    "stablecoin_provider": Source(
        "stablecoin_provider", "Stablecoin API (from your coin-api design)", "blockchain_api", False, True,
        "SENTINEL_STABLECOIN_API_URL", "STABLECOIN_API_KEY", "X-API-Key", None, "provider-specific",
        "Registered but not wired: no provider was chosen in the design. Transfers come from EVM JSON-RPC logs, which any node serves."),
    "file_import": Source(
        "file_import", "A file you saved (explorer export, API response, raw transaction hex)", "file", False, False,
        None, None, None, None, "file", "The file's own SHA-256 is its evidence id."),
}

EVM_CHAINS = {"ethereum": 1, "base": 8453, "polygon": 137, "arbitrum": 42161, "optimism": 10}


def endpoint(source_key, chain=None, second=False):
    """Resolve an endpoint URL from the environment. Returns (url or None, env var name)."""
    s = SOURCES[source_key]
    if s.url_env is None:
        return None, None
    name = s.url_env.replace("<CHAIN>", (chain or "").upper())
    return os.environ.get(name) or None, name


def is_own_node(chain):
    return os.environ.get("SENTINEL_EVM_RPC_{}_OWN".format(chain.upper())) == "1"


# ------------------------------------------------------------------------------------ tokens
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TOKENS = os.path.join(HERE, "tokens_default.json")


def token_key(chain, network, contract):
    c = (contract or "native")
    if c.startswith("0x"):
        c = c.lower()
    return "{}:{}:{}".format(chain.lower(), network.lower(), c)


class TokenRegistry(object):
    """Shipped defaults plus the desk's own file (which wins). Status values:
    VERIFIED     the desk checked the contract against the issuer's own published list (who, when, where recorded)
    UNVERIFIED   a starting value (for example from model knowledge); usable, and every report says so
    FILL         no contract recorded yet; transfers for it cannot be fetched"""

    def __init__(self, desk_path=None):
        self.desk_path = desk_path
        self.tokens = {}
        for path in (DEFAULT_TOKENS, desk_path):
            if path and os.path.isfile(path):
                for t in json.load(open(path, encoding="utf-8")):
                    self.tokens[self.key_of(t)] = t

    @staticmethod
    def key_of(t):
        c = t.get("contract_address") or ("native" if t.get("native") else "unrecorded-" + t["symbol"].lower())
        return token_key(t["chain"], t["network"], c)

    def find(self, symbol, chain, network="mainnet"):
        hits = [t for t in self.tokens.values() if t["symbol"].upper() == symbol.upper()
                and t["chain"] == chain.lower() and t["network"] == network.lower()]
        return hits

    def resolve(self, symbol, chain, network="mainnet", contract=None):
        if contract:
            k = token_key(chain, network, contract)
            if k in self.tokens:
                return self.tokens[k]
            return {"chain": chain.lower(), "network": network.lower(), "contract_address": contract, "symbol": symbol.upper(),
                    "decimals": None, "status": "UNVERIFIED", "origin": "given on the command line"}
        hits = [t for t in self.find(symbol, chain, network) if t.get("contract_address")]
        if len(hits) == 1:
            return hits[0]
        if not hits:
            raise KeyError("no {} contract recorded for {}:{} — pass --contract, or add it with `coin token add`".format(symbol, chain, network))
        raise KeyError("more than one {} contract on {}:{} — pass --contract".format(symbol, chain, network))

    def add(self, t):
        if t.get("contract_address", "").startswith("0x"):
            st = P.checksum_status(t["contract_address"])
            if st in ("INVALID", "MALFORMED"):
                raise ValueError("contract address fails its EIP-55 checksum ({}) — likely a typo".format(st))
        t["_desk"] = True
        self.tokens[self.key_of(t)] = t
        own = [v for v in self.tokens.values() if v.get("_desk")]
        if self.desk_path:
            os.makedirs(os.path.dirname(self.desk_path), exist_ok=True)
            with open(self.desk_path, "w", encoding="utf-8") as fh:
                json.dump(own, fh, indent=1, sort_keys=True)


def check_default_tokens():
    """Every shipped EVM contract must pass its EIP-55 checksum. A pass means the address was not
    mistyped; it does not prove the issuer uses it. That is what status VERIFIED records."""
    out = []
    for t in json.load(open(DEFAULT_TOKENS, encoding="utf-8")):
        a = t.get("contract_address")
        if a and a.startswith("0x"):
            out.append((t["symbol"], t["chain"], a, P.checksum_status(a)))
    return out
