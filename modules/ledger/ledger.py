#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TSR ledger — the publication station's command line. Standard library only.

  ledger summary                         what the ledger holds and how much of it is machine-verified
  ledger check                           integrity gate (structure, references, rules, verification)
  ledger gate DRAFT.md                   every number traces to the ledger, and no verb outruns its evidence
  ledger card F-ID | --publishable       approved wording, attribution, limits — or a refusal
  ledger chain append|verify|log|anchor  tamper-evident history of ledger versions
  ledger seal keygen|sign|verify         your personal seal on the chain head (key never leaves this machine)
  ledger diff OLD.json NEW.json          what changed between two versions
  ledger verify-sources [--go]           re-fetch cited URLs politely and compare hashes (plan by default)
  ledger trace ENTITY [--up] [--kind K]  follow the money hop by hop; kinds never added together
  ledger why F-ID                        the investigation screen: before/after, actors, flows, causal rung, rivals
  ledger onchain EXPORT.csv              blockchain transfers → rows + signals (never findings)
  ledger install-data LEDGER.json        file a new ledger version under evidence/ledger and chain it
  ledger selftest                        prove the module works on this machine
"""
import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_ledger as L  # noqa: E402


def summary(args):
    path = L.find_ledger(args.ledger)
    lg = L.load(path)
    m = lg.get("metrics", {})
    v = m.get("verification", {})
    c = m.get("counts", {})
    print("{} — as of {} (built {})".format(lg["meta"].get("title"), lg["meta"].get("as_of"), lg["meta"].get("built")))
    print("  " + " · ".join("{} {}".format(val, k.replace("_", " ")) for k, val in c.items()))
    print("  numbers verified at their locators: {}/{}".format(v.get("numbers_machine_verified"), v.get("numbers_total")))
    print("  quotes: {}   arithmetic: {}   workbook cells: {}".format(v.get("quotes"), v.get("arithmetic"), v.get("workbook_verbatim")))
    print("  publication: {}".format(m.get("findings_by_publication")))
    print("  file: {}  sha256 {}".format(path, L.sha256_file(path)))
    return 0


def install_data(args):
    src = args.file
    if not os.path.isfile(src):
        L.die("no such file: " + src)
    lg = L.load(src)
    import check
    errs, _ = check.run(lg)
    if errs and not args.force:
        L.die("that ledger fails its integrity check ({} problem(s)); fix it or pass --force".format(len(errs)))
    d = L.ledger_dir()
    os.makedirs(d, exist_ok=True)
    name = "ledger-{}-{}.json".format(lg.get("meta", {}).get("built", "undated"), L.sha256_file(src)[:12])
    dst = os.path.join(d, name)
    if not os.path.exists(dst):
        shutil.copyfile(src, dst)
    shutil.copyfile(dst, os.path.join(d, "current.json"))
    print("filed " + dst)
    import chain
    ns = argparse.Namespace(ledger=dst, note=args.note or ("installed " + name), force=False, dir=None)
    return chain.append(ns)


def build_parser():
    p = argparse.ArgumentParser(prog="ledger", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version", version=L.VERSION)
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("summary"); s.add_argument("--ledger")
    s = sub.add_parser("check"); s.add_argument("--ledger")
    s = sub.add_parser("gate"); s.add_argument("draft"); s.add_argument("--ledger"); s.add_argument("--json", action="store_true")
    s.add_argument("--numbers-only", action="store_true")
    s = sub.add_parser("trace"); s.add_argument("entity"); s.add_argument("--up", action="store_true"); s.add_argument("--kind")
    s.add_argument("--hops", type=int, default=3); s.add_argument("--json", action="store_true"); s.add_argument("--ledger")
    s = sub.add_parser("why"); s.add_argument("finding"); s.add_argument("--window", type=int, default=180); s.add_argument("--ledger")
    s = sub.add_parser("card"); s.add_argument("finding", nargs="?"); s.add_argument("--publishable", action="store_true")
    s.add_argument("--format", choices=["text", "json"], default="text"); s.add_argument("--ledger")
    s = sub.add_parser("chain"); s.add_argument("action", choices=["append", "verify", "log", "anchor"]); s.add_argument("--ledger")
    s.add_argument("--note"); s.add_argument("--force", action="store_true"); s.add_argument("--anchor"); s.add_argument("--dir")
    s = sub.add_parser("seal"); s.add_argument("action", choices=["keygen", "sign", "verify"]); s.add_argument("--dir")
    s = sub.add_parser("diff"); s.add_argument("old"); s.add_argument("new"); s.add_argument("--json", action="store_true")
    s = sub.add_parser("verify-sources"); s.add_argument("--ledger"); s.add_argument("--go", action="store_true")
    s.add_argument("--only"); s.add_argument("--delay", type=float, default=4.0); s.add_argument("--cafile")
    s.add_argument("--robots-unreachable-ok", action="store_true")
    s = sub.add_parser("onchain"); s.add_argument("csv"); s.add_argument("--chain", default="ethereum"); s.add_argument("--labels")
    s.add_argument("--flagged"); s.add_argument("--out"); s.add_argument("--window", type=float, default=24.0)
    s.add_argument("--fanout", type=int, default=20)
    s = sub.add_parser("install-data"); s.add_argument("file"); s.add_argument("--note"); s.add_argument("--force", action="store_true")
    sub.add_parser("selftest")
    return p


def main(argv=None):
    p = build_parser()
    a = p.parse_args(argv)
    if not a.cmd:
        p.print_help()
        return 0
    if a.cmd == "summary":
        return summary(a)
    if a.cmd == "check":
        import check
        return check.main(a)
    if a.cmd == "gate":
        import gate
        return gate.main(a)
    if a.cmd == "trace":
        import moneytrace as trace
        return trace.main(a)
    if a.cmd == "why":
        import why
        return why.main(a)
    if a.cmd == "card":
        import card
        return card.main(a)
    if a.cmd == "chain":
        import chain
        return {"append": chain.append, "verify": chain.verify, "log": chain.log, "anchor": chain.anchor}[a.action](a)
    if a.cmd == "seal":
        import chain
        return {"keygen": chain.keygen, "sign": chain.sign, "verify": chain.seal_verify}[a.action](a)
    if a.cmd == "diff":
        import diff
        return diff.main(a)
    if a.cmd == "verify-sources":
        import verify_sources
        return verify_sources.main(a)
    if a.cmd == "onchain":
        import onchain
        return onchain.main(a)
    if a.cmd == "install-data":
        return install_data(a)
    if a.cmd == "selftest":
        import selftest
        return selftest.main()
    return 2


if __name__ == "__main__":
    sys.exit(main())
