# -*- coding: utf-8 -*-
"""Shared helpers for the TSR ledger module. Standard library only."""
import hashlib
import json
import os
import re
import sys
from decimal import Decimal, InvalidOperation

VERSION = "ledger/1.1.0"
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- locating things
def repo_root(start=None):
    """Walk up from `start` (default: cwd) to the directory that holds bin/sentinel."""
    d = os.path.abspath(start or os.getcwd())
    while True:
        if os.path.exists(os.path.join(d, "bin", "sentinel")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def ledger_dir():
    root = repo_root() or repo_root(HERE)
    if root:
        return os.path.join(root, "evidence", "ledger")
    return os.path.join(os.path.expanduser("~"), ".sentinel", "ledger")


def find_ledger(explicit=None):
    cands = [explicit, os.environ.get("SENTINEL_LEDGER"), os.path.join(ledger_dir(), "current.json"),
             os.path.join(HERE, "data", "ledger.json")]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    raise SystemExit("ledger: no ledger.json found. Pass --ledger PATH or set SENTINEL_LEDGER.")


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def canonical(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ledger_digest(ledger):
    """Digest of the evidentiary content: everything except the verification block, which is derived."""
    core = {k: v for k, v in ledger.items() if k not in ("verification", "metrics")}
    return sha256_bytes(canonical(core).encode("utf-8"))


# ---------------------------------------------------------------- numbers in prose
_NUM = re.compile(
    r"(?P<cur>\$)?(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?"
    r"(?P<unit>%|percent\b|per cent\b|×|x\b|times\b|million\b|billion\b|thousand\b|[mM]\b|[bB]n?\b|[kK]\b)?")


def parse_numbers(text):
    """Yield dicts for every money amount, percentage or multiple in `text`.
    Bare integers without $, %, a scale word or 4+ digits are ignored (years, counts, list numbers)."""
    out = []
    for m in _NUM.finditer(text):
        raw_num = m.group("num").replace(",", "")
        unit = (m.group("unit") or "").strip()
        cur = bool(m.group("cur"))
        try:
            v = Decimal(raw_num)
        except InvalidOperation:
            continue
        kind = None
        if unit in ("%", "percent", "per cent"):
            kind, value = "share", v / Decimal(100)
        elif unit in ("×", "x", "times"):
            kind, value = "multiple", v
        elif unit in ("million", "m", "M"):
            kind, value = "money" if cur else "number", v * Decimal(1000000)
        elif unit in ("billion", "b", "B", "bn", "Bn"):
            kind, value = "money" if cur else "number", v * Decimal(1000000000)
        elif unit in ("thousand", "k", "K"):
            kind, value = "money" if cur else "number", v * Decimal(1000)
        elif cur:
            kind, value = "money", v
        else:
            continue
        # skip 4-digit years written without $ or unit (already skipped) and tiny multiples like "1x"
        precision = _precision(m.group("num"), unit)
        out.append({"text": m.group(0).strip(), "start": m.start(), "end": m.end(), "kind": kind,
                    "value": value, "precision": precision})
    return out


def _precision(num, unit):
    """Half a unit of the last shown digit, scaled — what 'as displayed' rounding can hide."""
    if "." in num:
        dec = len(num.split(".")[1])
    else:
        dec = 0
    step = Decimal(1).scaleb(-dec)
    scale = {"million": 10 ** 6, "m": 10 ** 6, "M": 10 ** 6, "billion": 10 ** 9, "b": 10 ** 9, "B": 10 ** 9,
             "bn": 10 ** 9, "Bn": 10 ** 9, "thousand": 10 ** 3, "k": 10 ** 3, "K": 10 ** 3,
             "%": Decimal("0.01"), "percent": Decimal("0.01"), "per cent": Decimal("0.01")}.get(unit, 1)
    return step * Decimal(scale) / 2


def sentence_around(text, start, end):
    left = max(text.rfind(". ", 0, start), text.rfind("\n", 0, start))
    right_candidates = [i for i in (text.find(". ", end), text.find("\n", end)) if i != -1]
    right = min(right_candidates) if right_candidates else len(text)
    return text[left + 1:right + 1].strip()


def clause_around(text, start, end, before=25):
    """The words tied to one number: a short run-in before it, and what follows until the next clause break."""
    left = max(0, start - before)
    m = re.search(r"[;,)]|\band \$|\. ", text[end:])
    right = end + (m.start() if m else len(text) - end)
    return text[left:right]


def paragraph_around(text, start, end):
    left = text.rfind("\n\n", 0, start)
    right = text.find("\n\n", end)
    return text[(left + 2 if left != -1 else 0):(right if right != -1 else len(text))].strip()


def money(v):
    if v is None:
        return "—"
    v = float(v)
    if abs(v - round(v)) < 1e-9:
        return "${:,.0f}".format(v)
    return "${:,.2f}".format(v)


def wrap(text, width=92, indent=""):
    words, lines, cur = (text or "").split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width:
            lines.append(indent + cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(indent + cur)
    return "\n".join(lines)


def die(msg, code=2):
    sys.stderr.write("ledger: " + msg + "\n")
    raise SystemExit(code)
