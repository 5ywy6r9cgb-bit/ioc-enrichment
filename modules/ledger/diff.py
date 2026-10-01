# -*- coding: utf-8 -*-
"""What changed between two ledger versions — the desk's memory across runs.

    ledger diff old.json new.json              # markdown to stdout
    ledger diff old.json new.json --json
"""
import json

import lib_ledger as L

TRACK = {
    "findings": ("glassmark", "publication", "status", "level", "evidence_class", "headline"),
    "figures": ("value", "kind", "evidence_class", "locator"),
    "money_flows": ("amount_usd", "kind", "evidence_class", "locator", "from", "to"),
    "relationships": ("type", "level", "evidence_class"),
    "records_queue": ("status", "priority", "action_type"),
    "corrections": ("status",),
    "claims": ("assessment",),
    "sources": ("status", "sha256", "url"),
    "entities": ("name", "type"),
}


def compare(a, b):
    out = {}
    for sec, fields in TRACK.items():
        A = {x["id"]: x for x in a.get(sec, [])}
        B = {x["id"]: x for x in b.get(sec, [])}
        added = sorted(set(B) - set(A))
        removed = sorted(set(A) - set(B))
        changed = []
        for k in sorted(set(A) & set(B)):
            d = [(f, A[k].get(f), B[k].get(f)) for f in fields if A[k].get(f) != B[k].get(f)]
            if d:
                changed.append((k, d))
        if added or removed or changed:
            out[sec] = {"added": added, "removed": removed, "changed": changed}
    va = a.get("verification", {}).get("locators", {})
    vb = b.get("verification", {}).get("locators", {})
    vchg = [(k, va[k].get("status"), vb[k].get("status")) for k in sorted(set(va) & set(vb)) if va[k].get("status") != vb[k].get("status")]
    if vchg:
        out["verification"] = vchg
    return out


def render(d, a, b):
    lines = ["# Ledger diff", "",
             "from `{}` (as of {}) → `{}` (as of {})".format(a.get("meta", {}).get("built"), a.get("meta", {}).get("as_of"),
                                                            b.get("meta", {}).get("built"), b.get("meta", {}).get("as_of")), ""]
    if not d:
        lines.append("No differences in tracked fields.")
    for sec, v in d.items():
        if sec == "verification":
            lines += ["## verification status", ""] + ["- {}: {} → {}".format(k, x, y) for k, x, y in v] + [""]
            continue
        lines += ["## " + sec, ""]
        lines += ["- **added** " + x for x in v["added"]]
        lines += ["- **removed** " + x for x in v["removed"]]
        for k, ch in v["changed"]:
            for f, x, y in ch:
                lines.append("- {} · {}: `{}` → `{}`".format(k, f, str(x)[:80], str(y)[:80]))
        lines.append("")
    return "\n".join(lines)


def main(args):
    a, b = L.load(args.old), L.load(args.new)
    d = compare(a, b)
    if args.json:
        print(json.dumps(d, ensure_ascii=False, indent=1, default=str))
    else:
        print(render(d, a, b))
    return 0
