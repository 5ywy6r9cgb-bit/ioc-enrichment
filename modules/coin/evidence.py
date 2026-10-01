# -*- coding: utf-8 -*-
"""Evidence store for chain data: RAW → NORMALIZED → DERIVED.

  evidence/raw/<ab>/<sha256>.bin          the bytes exactly as received (content-addressed; never edited)
  evidence/normalized/envelopes/*.json    one envelope per retrieval: who, what, when, which bytes
  evidence/normalized/transfers.jsonl     normalized transfers, each pointing at its evidence_id
  evidence/normalized/btc_txs.jsonl       parsed Bitcoin transactions, each pointing at its evidence_id
  evidence/derived/calculations/*.json    every computed number, with its inputs
  evidence/derived/findings.jsonl         finding → calculation links
  evidence/derived/attributions.jsonl     who is said to control an address, and on what evidence

evidence_id = "sha256:" + SHA-256 of the raw bytes. The same bytes fetched twice have the same
evidence_id and two envelopes, which is itself useful: the chain said the same thing twice.
Reading a raw file re-hashes it; a mismatch raises TamperError instead of returning bad data.
"""
import datetime
import hashlib
import json
import os

import net

SCHEMA = "tsr.coin.envelope/1"
TOOL = "coin/1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))


class TamperError(Exception):
    pass


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_hex(b):
    return hashlib.sha256(b).hexdigest()


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def repo_root(start=None):
    d = os.path.abspath(start or os.getcwd())
    while True:
        if os.path.exists(os.path.join(d, "bin", "sentinel")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def default_root():
    env = os.environ.get("SENTINEL_COIN_HOME")
    if env:
        return env
    root = repo_root() or repo_root(HERE)
    if root:
        return os.path.join(root, "evidence")
    return os.path.join(os.path.expanduser("~"), ".sentinel", "evidence")


class Store(object):
    def __init__(self, root=None):
        self.root = root or default_root()
        self.raw_dir = os.path.join(self.root, "raw")
        self.norm_dir = os.path.join(self.root, "normalized")
        self.env_dir = os.path.join(self.norm_dir, "envelopes")
        self.der_dir = os.path.join(self.root, "derived")
        self.calc_dir = os.path.join(self.der_dir, "calculations")
        for d in (self.raw_dir, self.env_dir, self.calc_dir):
            os.makedirs(d, exist_ok=True)

    # ---------------------------------------------------------------- raw bytes
    def raw_path(self, sha):
        return os.path.join(self.raw_dir, sha[:2], sha + ".bin")

    def put_raw(self, data):
        sha = sha256_hex(data)
        p = self.raw_path(sha)
        if not os.path.exists(p):
            os.makedirs(os.path.dirname(p), exist_ok=True)
            tmp = p + ".tmp"
            with open(tmp, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, p)
        return sha

    def get_raw(self, evidence_id):
        sha = evidence_id.split(":", 1)[-1]
        p = self.raw_path(sha)
        if not os.path.exists(p):
            raise KeyError("raw bytes for {} are not in this store".format(evidence_id))
        data = open(p, "rb").read()
        if sha256_hex(data) != sha:
            raise TamperError("raw file for {} no longer hashes to its name — it was altered after intake".format(evidence_id))
        return data

    # ---------------------------------------------------------------- envelopes
    def seal(self, *, provider, authoritative, endpoint, method, query, raw, content_type="", http_status=None,
             chain=None, network=None, block_height=None, warnings=None, verification=None, parsed=None):
        """Store the bytes and write one envelope for this retrieval. Everything a caller passes
        that could carry a credential is redacted here, whatever the caller did."""
        sha = self.put_raw(raw)
        data_sha = sha256_hex(canonical(parsed)) if parsed is not None else None
        env = {
            "schema": SCHEMA,
            "evidence_id": "sha256:" + sha,
            "source": {"provider": provider, "authoritative": bool(authoritative), "endpoint": net.redact_url(endpoint) if endpoint and "://" in endpoint else net.redact(endpoint),
                       "method": method, "retrieved_at": now_utc(), "http_status": http_status, "content_type": content_type,
                       "chain": chain, "network": network, "block_height": block_height},
            "query": net.redact_obj(query or {}),
            "raw_sha256": sha,
            "raw_bytes": len(raw),
            "data_sha256": data_sha,
            "verification": verification or {"level": "V0_REPORTED", "checks": []},
            "warnings": [net.redact(w) for w in (warnings or [])],
            "tool": TOOL,
        }
        env["envelope_id"] = "env:" + sha256_hex(canonical(env))[:32]
        with open(os.path.join(self.env_dir, env["envelope_id"].split(":")[1] + ".json"), "w", encoding="utf-8") as fh:
            json.dump(env, fh, indent=1, sort_keys=True)
        return env

    def update_verification(self, env, verification):
        """Verification is added after the checks run; the envelope file is rewritten with the
        same envelope_id (the id covers what was retrieved, not what was later proven)."""
        env["verification"] = verification
        with open(os.path.join(self.env_dir, env["envelope_id"].split(":")[1] + ".json"), "w", encoding="utf-8") as fh:
            json.dump(env, fh, indent=1, sort_keys=True)
        return env

    def envelopes(self):
        for name in sorted(os.listdir(self.env_dir)):
            if name.endswith(".json"):
                yield json.load(open(os.path.join(self.env_dir, name), encoding="utf-8"))

    def envelopes_for(self, evidence_id):
        return [e for e in self.envelopes() if e["evidence_id"] == evidence_id]

    # ---------------------------------------------------------------- jsonl tables
    def _jsonl(self, rel):
        return os.path.join(self.root, rel)

    def append_rows(self, rel, rows, key):
        """Append rows to a JSONL table, skipping any whose key is already present."""
        path = self._jsonl(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        seen = set(key(r) for r in self.rows(rel))
        added = 0
        with open(path, "a", encoding="utf-8") as fh:
            for r in rows:
                k = key(r)
                if k in seen:
                    continue
                seen.add(k)
                fh.write(json.dumps(r, sort_keys=True) + "\n")
                added += 1
        return added

    def rows(self, rel):
        path = self._jsonl(rel)
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    # ---------------------------------------------------------------- calculations
    def put_calc(self, calc):
        with open(os.path.join(self.calc_dir, calc["calc_id"].split(":")[1] + ".json"), "w", encoding="utf-8") as fh:
            json.dump(calc, fh, indent=1, sort_keys=True)

    def get_calc(self, calc_id):
        p = os.path.join(self.calc_dir, calc_id.split(":")[-1] + ".json")
        return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None

    def calcs(self):
        for name in sorted(os.listdir(self.calc_dir)):
            if name.endswith(".json"):
                yield json.load(open(os.path.join(self.calc_dir, name), encoding="utf-8"))


def import_file(store, path, chain=None, network=None, note=None):
    """Bring a saved file into custody: its bytes become the evidence, its SHA-256 the id."""
    data = open(path, "rb").read()
    parsed = None
    try:
        parsed = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        parsed = None
    return store.seal(provider="file_import", authoritative=False, endpoint="file:" + os.path.basename(path), method="FILE",
                      query={"note": note} if note else {}, raw=data, chain=chain, network=network, parsed=parsed)
