# -*- coding: utf-8 -*-
"""Tamper-evident ledger history.

chain append  — record this ledger version: file hash, content digest, counts, link to the previous entry
chain verify  — recompute every link; any edited, reordered or removed middle entry breaks it
chain log     — list versions
chain anchor  — print the head hash to keep somewhere this machine does not control
                (a hash chain cannot see a deleted tail; an outside anchor can)

seal keygen   — create a personal 256-bit seal key on THIS machine (never printed, never sent)
seal sign     — HMAC-SHA256 the chain head with that key
seal verify   — check every seal against the chain

The key file lives in ~/.sentinel/keys/ledger_seal.key with owner-only permissions. Only its
fingerprint is ever shown. Keep an offline copy; a lost key cannot be recovered.
"""
import datetime
import hashlib
import hmac
import json
import os
import secrets

import lib_ledger as L

ZERO = "0" * 64


def chain_path(args=None):
    d = (getattr(args, "dir", None) if args else None) or os.environ.get("SENTINEL_LEDGER_DIR") or L.ledger_dir()
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "chain.jsonl"), os.path.join(d, "seals.jsonl"), os.path.join(d, "anchors.txt")


def key_path():
    return os.environ.get("SENTINEL_SEAL_KEY") or os.path.join(os.path.expanduser("~"), ".sentinel", "keys", "ledger_seal.key")


def now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_chain(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return [json.loads(x) for x in fh if x.strip()]


def entry_hash(e):
    body = {k: v for k, v in e.items() if k != "entry_sha256"}
    return L.sha256_bytes(L.canonical(body).encode("utf-8"))


def verify_entries(entries):
    problems, prev = [], ZERO
    for i, e in enumerate(entries):
        if e.get("n") != i + 1:
            problems.append("entry {}: sequence number {} (expected {})".format(i + 1, e.get("n"), i + 1))
        if e.get("prev") != prev:
            problems.append("entry {}: link to previous entry broken".format(i + 1))
        h = entry_hash(e)
        if h != e.get("entry_sha256"):
            problems.append("entry {}: content changed after it was written".format(i + 1))
        prev = e.get("entry_sha256")
    return problems


def append(args):
    cpath, _, _ = chain_path(args)
    lpath = L.find_ledger(args.ledger)
    ledger = L.load(lpath)
    if not args.force:
        import check
        errs = check.run(ledger)[0]
        if errs:
            L.die("the ledger fails its integrity check ({} problem(s)); run `ledger check`, or --force".format(len(errs)))
    entries = read_chain(cpath)
    probs = verify_entries(entries)
    if probs:
        L.die("existing chain is broken — not appending:\n  " + "\n  ".join(probs))
    counts = {k: len(ledger.get(k, [])) for k in ("sources", "entities", "money_flows", "figures", "findings",
                                                    "relationships", "claims", "corrections", "records_queue")}
    e = {"n": len(entries) + 1, "time_utc": now(), "ledger_file": os.path.basename(lpath),
         "ledger_file_sha256": L.sha256_file(lpath), "ledger_digest": L.ledger_digest(ledger),
         "schema": ledger.get("meta", {}).get("schema"), "as_of": ledger.get("meta", {}).get("as_of"),
         "counts": counts, "note": args.note or "", "prev": entries[-1]["entry_sha256"] if entries else ZERO,
         "tool": L.VERSION}
    if entries and entries[-1]["ledger_digest"] == e["ledger_digest"] and not args.force:
        print("unchanged — this ledger content is already entry {}".format(entries[-1]["n"]))
        return 0
    e["entry_sha256"] = entry_hash(e)
    with open(cpath, "a", encoding="utf-8") as fh:
        fh.write(L.canonical(e) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    print("appended entry {}  {}".format(e["n"], e["entry_sha256"]))
    print("anchor it outside this machine:  ledger chain anchor")
    return 0


def verify(args):
    cpath, spath, _ = chain_path(args)
    entries = read_chain(cpath)
    if not entries:
        print("no chain yet — `ledger chain append` starts one")
        return 1
    probs = verify_entries(entries)
    if args.anchor:
        if not any(e["entry_sha256"] == args.anchor for e in entries):
            probs.append("anchor {}… not found — the chain was truncated or replaced".format(args.anchor[:16]))
    for p in probs:
        print("BROKEN  " + p)
    if not probs:
        print("chain intact: {} entr{} · head {}".format(len(entries), "y" if len(entries) == 1 else "ies", entries[-1]["entry_sha256"]))
    return 1 if probs else 0


def log(args):
    cpath, spath, _ = chain_path(args)
    seals = {s["entry_sha256"] for s in read_chain(spath)}
    for e in read_chain(cpath):
        print("{:>3}  {}  {}…  findings {:>3}  flows {:>3}  {}{}".format(
            e["n"], e["time_utc"], e["entry_sha256"][:16], e["counts"].get("findings", 0), e["counts"].get("money_flows", 0),
            "sealed " if e["entry_sha256"] in seals else "", e.get("note", "")))
    return 0


def anchor(args):
    cpath, _, apath = chain_path(args)
    entries = read_chain(cpath)
    if not entries:
        L.die("no chain yet")
    head = entries[-1]
    line = "{}  entry {}  {}".format(head["entry_sha256"], head["n"], now())
    with open(apath, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    print(line)
    print("Copy that line somewhere this machine does not control (paper, a second device, an email to yourself).")
    return 0


# ------------------------------------------------------------------ seal
def keygen(args):
    p = key_path()
    if os.path.exists(p):
        L.die("a seal key already exists at {} — refusing to overwrite it".format(p))
    os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
    key = secrets.token_bytes(32)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(key.hex() + "\n")
    print("seal key created (owner-only permissions).")
    print("fingerprint " + fingerprint(key))
    print("Back it up offline. It is never printed, never uploaded, and cannot be recovered if lost.")
    return 0


def load_key():
    p = key_path()
    if not os.path.exists(p):
        L.die("no seal key — run `ledger seal keygen` on your own machine first")
    mode = os.stat(p).st_mode & 0o777
    if mode & 0o077:
        L.die("seal key permissions are {:o}; run: chmod 600 {}".format(mode, p))
    return bytes.fromhex(open(p).read().strip())


def fingerprint(key):
    return hashlib.sha256(key).hexdigest()[:16]


def sign(args):
    cpath, spath, _ = chain_path(args)
    entries = read_chain(cpath)
    if not entries or verify_entries(entries):
        L.die("chain missing or broken — verify it first")
    key = load_key()
    head = entries[-1]
    mac = hmac.new(key, head["entry_sha256"].encode("ascii"), hashlib.sha256).hexdigest()
    s = {"n": head["n"], "entry_sha256": head["entry_sha256"], "alg": "HMAC-SHA256", "key_fp": fingerprint(key),
         "mac": mac, "time_utc": now()}
    with open(spath, "a", encoding="utf-8") as fh:
        fh.write(L.canonical(s) + "\n")
    print("sealed entry {} with key {}".format(head["n"], s["key_fp"]))
    return 0


def seal_verify(args):
    cpath, spath, _ = chain_path(args)
    entries = {e["entry_sha256"]: e for e in read_chain(cpath)}
    key = load_key()
    fp = fingerprint(key)
    bad = 0
    for s in read_chain(spath):
        if s["entry_sha256"] not in entries:
            print("ORPHAN  seal for an entry that is not in the chain: {}…".format(s["entry_sha256"][:16]))
            bad += 1
            continue
        if s["key_fp"] != fp:
            print("OTHER KEY  entry {} was sealed with key {}".format(s["n"], s["key_fp"]))
            continue
        good = hmac.compare_digest(s["mac"], hmac.new(key, s["entry_sha256"].encode("ascii"), hashlib.sha256).hexdigest())
        print("{}  entry {}".format("VALID  " if good else "INVALID", s["n"]))
        bad += 0 if good else 1
    return 1 if bad else 0
