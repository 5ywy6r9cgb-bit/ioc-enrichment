#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TSR coin desk: chain data as evidence. Standard library only.

  coin sources                                   which data sources are configured (names only, never values)
  coin addr check ADDRESS                        checksum-test an address before anything is queried
  coin connect bitcoin tx TXID                   fetch, seal, and prove a transaction (hash → merkle → proof of work)
  coin connect bitcoin address ADDR              address history from a REST index (rows REPORTED until proven)
  coin connect stablecoin SYMBOL address ADDR    token transfers from EVM logs  [--chain ethereum|base ...]
  coin connect stablecoin SYMBOL tx HASH         the token transfers inside one transaction
  coin verify rawtx HEX|FILE [--header --proof]  prove a transaction offline, trusting no one
  coin report address ADDR --symbol S            OBSERVED / DERIVED / ATTRIBUTION / SOURCE / VERIFICATION
  coin provenance ID                             finding → calculation → transfers → response, re-proved
  coin graph address ADDR [--dot FILE]           neighbourhood from stored rows
  coin signals                                   rug-pull and cash-out shapes (leads, never findings)
  coin attribute add|show ...                    who is said to control an address, and on what evidence
  coin token list|add|verify ...                 token identities (chain, network, contract)
  coin link FINDING CALC... --statement TEXT     tie a published sentence to its calculations
  coin import FILE                               bring a saved file into custody
  coin export-ledger [--out FILE]                linked calculations as ledger rows (ON_CHAIN_TRANSFER)
  coin selftest                                  prove the module on this machine, offline

Credentials are read from the environment at call time and never printed, logged, stored or
committed. An address is not a person.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import attribution as A  # noqa: E402
import btc  # noqa: E402
import evidence as E  # noqa: E402
import evm  # noqa: E402
import graph as G  # noqa: E402
import lineage as LN  # noqa: E402
import models as M  # noqa: E402
import net  # noqa: E402
import registry as R  # noqa: E402

VERSION = "coin/1.0.0"


def _desk(args):
    import connect
    store = E.Store(args.home) if getattr(args, "home", None) else E.Store()
    return connect.Desk(store=store)


def cmd_sources(args):
    print("SOURCES (values are never printed; 'set' means the variable exists in this shell)")
    for s in R.SOURCES.values():
        envs = []
        if s.url_env:
            if "<CHAIN>" in s.url_env:
                for ch in R.EVM_CHAINS:
                    n = s.url_env.replace("<CHAIN>", ch.upper())
                    if os.environ.get(n):
                        envs.append(n + " set")
                if not envs:
                    envs.append(s.url_env + " (none set)")
            else:
                envs.append("{} {}".format(s.url_env, "set" if os.environ.get(s.url_env) else "not set"))
        if s.key_env:
            envs.append("{} {}".format(s.key_env, "set" if os.environ.get(s.key_env) else "not set"))
        print("  {:<20} {:<16} authoritative={:<5} {}".format(s.key, s.category, str(s.authoritative), "; ".join(envs) or "-"))
    print("\nEvidence store: " + E.default_root())
    return 0


def cmd_addr(args):
    a = args.address.strip()
    if a.lower().startswith("0x"):
        v = evm.validate_address(a)
        print("EVM address: {} — {}".format("VALID" if v["valid"] else "INVALID", v["reason"]))
        if v.get("checksummed"):
            print("checksummed form: " + v["checksummed"])
    else:
        v = btc.validate_address(a)
        print("Bitcoin address: {} — {} {}".format("VALID" if v["valid"] else "INVALID", v["reason"], "({} {})".format(v["type"], v["network"]) if v["valid"] else ""))
    return 0 if v["valid"] else 1


def cmd_connect(args):
    import connect
    d = _desk(args)
    try:
        if args.what == "bitcoin" and args.mode == "tx":
            row = d.bitcoin_tx(args.ident, network=args.network, source=args.source)
            print_btc_tx(row)
            return 0 if row["verification"]["level"] != "MISMATCH" else 1
        if args.what == "bitcoin" and args.mode == "address":
            r = d.bitcoin_address(args.ident, network=args.network, max_pages=args.pages)
            print("fetched {} transaction(s) in {} page(s); {} new row(s) stored{}".format(
                r["transactions"], r["pages"], r["rows_added"], "" if r["complete"] else " — page limit reached; raise --pages for more"))
            print("Rows are REPORTED. Prove any one with: coin connect bitcoin tx <txid>")
            tok = d.tokens.tokens["bitcoin:mainnet:native"]
            import report
            text, _ = report.address_report(d.store, tok, "bitcoin:mainnet:native", args.ident)
            print("\n" + text)
            return 0
        if args.what == "stablecoin":
            symbol = args.symbol
            if args.mode == "address":
                r = d.token_transfers(symbol, args.chain, args.ident, network=args.network, direction=args.direction,
                                      from_block=args.from_block, to_block=args.to_block, chunk=args.chunk, contract=args.contract)
                print("{} {}:{} blocks {:,}–{:,}: {} transfer(s), {} new; {} response(s) sealed{}".format(
                    symbol, args.chain, args.network, r["from_block"], r["to_block"], len(r["transfers"]), r["rows_added"], len(r["envelopes"]),
                    "; corroborated on a second endpoint" if r["corroborated"] else "; one endpoint (REPORTED) — set the RPC2 variable to corroborate"))
                import report
                text, _ = report.address_report(d.store, r["token"], r["token_key"], args.ident, r["from_block"], r["to_block"])
                print("\n" + text)
                return 0
            r = d.token_tx(symbol, args.chain, args.ident, network=args.network, contract=args.contract)
            print("{} transfer(s) of {} in {} (receipt status {})".format(len(r["transfers"]), symbol, args.ident, r["receipt_status"]))
            for t in r["transfers"]:
                print("  {} → {}  {}".format(t["from_address"], t["to_address"], M.fmt_units(M.amount(t), 2, t["asset_symbol"])))
            for c in r["verification"]["checks"]:
                print("  {:<8} {}: {}".format(c["result"], c["check"], c["detail"]))
            print("evidence " + r["evidence_id"])
            return 0
    except (connect.ConfigError, net.NetError, ValueError, KeyError) as e:
        print("coin: " + net.redact(str(e)), file=sys.stderr)
        return 2
    return 2


def print_btc_tx(row):
    p = row["parsed"]
    b = row.get("block") or {}
    print("SENTINEL BLOCKCHAIN — Bitcoin transaction\n")
    print("Txid          " + p["txid"])
    print("Block         {} (height {})".format(b.get("hash") or "unconfirmed", b.get("height", "?")))
    print("\nOBSERVED      (decoded from the raw bytes, not from the provider's JSON)")
    print("Inputs        {}{}".format(len(p["vin"]), " (coinbase)" if p["coinbase"] else ""))
    for o in p["vout"]:
        where = o["address"] or (o.get("detail") or {}).get("text") or o["type"]
        print("  out {:<3} {:>18} BTC  {:<8} {}".format(o["n"], btc.btc(o["value_sats"]), o["type"], where))
        if o["type"] == "p2pk":
            print("           (pay-to-pubkey: no address on chain; DERIVED P2PKH form {})".format(o["detail"]["p2pkh_form_DERIVED"]))
    print("Size          {} bytes, weight {}, vsize {}".format(p["size"], p["weight"], p["vsize"]))
    print("\nVERIFICATION  " + row["verification"]["level"])
    for c in row["verification"]["checks"]:
        print("  {:<8} {}: {}".format(c["result"], c["check"], c["detail"]))
    print("\nEvidence      " + ", ".join(row["evidence_ids"]))
    print("Attribution   Unknown (an address is not a person)")


def cmd_verify(args):
    raw_in = args.raw
    if os.path.isfile(raw_in):
        raw_in = open(raw_in, encoding="utf-8").read().strip()
    raw = bytes.fromhex(raw_in)
    p = btc.parse_tx(raw)
    row = {"parsed": p, "block": {}, "evidence_ids": ["sha256:" + E.sha256_hex(raw)], "verification": {"level": "V0_REPORTED", "checks": []}}
    ch = row["verification"]["checks"]
    if args.txid:
        ok = p["txid"] == args.txid.lower()
        ch.append({"check": "raw bytes → txid", "result": "PASS" if ok else "FAIL", "detail": "computed {}".format(p["txid"])})
        if ok:
            row["verification"]["level"] = "V1_HASH_BOUND"
    else:
        ch.append({"check": "raw bytes → txid", "result": "NOTE", "detail": "computed txid {} (pass --txid to compare)".format(p["txid"])})
    if args.header:
        hx = open(args.header).read().strip() if os.path.isfile(args.header) else args.header
        hdr = btc.parse_header(bytes.fromhex(hx))
        row["block"] = {"hash": hdr["hash"]}
        if args.proof:
            pj = json.load(open(args.proof)) if os.path.isfile(args.proof) else json.loads(args.proof)
            inc = btc.verify_branch(p["txid"], pj["merkle"], pj["pos"], hdr["merkle_root"])
        elif hdr["merkle_root"] == p["txid"]:
            inc = True  # a block with a single transaction
        else:
            inc = False
        ok = inc and hdr["pow_ok"]
        ch.append({"check": "inclusion in block", "result": "PASS" if ok else "FAIL",
                   "detail": "root {}; proof of work {} ({} leading zero bits)".format("matches" if inc else "does NOT match", "valid" if hdr["pow_ok"] else "INVALID", hdr["work_leading_zero_bits"])})
        if ok and row["verification"]["level"] == "V1_HASH_BOUND":
            row["verification"]["level"] = "V2_INCLUDED"
    print_btc_tx(row)
    return 0 if all(c["result"] in ("PASS", "NOTE") for c in ch) else 1


def cmd_report(args):
    d = _desk(args)
    if args.symbol.upper() == "BTC":
        tok, tkey = d.tokens.tokens["bitcoin:mainnet:native"], "bitcoin:mainnet:native"
    else:
        tok = d.tokens.resolve(args.symbol, args.chain, args.network, args.contract)
        tkey = R.TokenRegistry.key_of(tok)
    import report
    text, calcs = report.address_report(d.store, tok, tkey, args.address, args.from_block, args.to_block)
    print(text)
    return 0


def cmd_provenance(args):
    store = E.Store(args.home) if args.home else E.Store()
    tree = LN.provenance(store, args.ident, check=not args.no_check)
    if args.json:
        print(json.dumps(tree, indent=1, default=str))
    else:
        print(LN.render_tree(tree))
    bad = [c for c in tree["checks"] if c["result"] in ("FAIL", "MISSING")]
    return 1 if bad or tree["kind"] is None else 0


def cmd_graph(args):
    store = E.Store(args.home) if args.home else E.Store()
    tkey = None
    if args.symbol:
        tkey = "bitcoin:mainnet:native" if args.symbol.upper() == "BTC" else R.TokenRegistry.key_of(R.TokenRegistry().resolve(args.symbol, args.chain, args.network))
    nodes, edges = G.neighbourhood(store.rows("normalized/transfers.jsonl"), args.address, hops=args.hops, token_key=tkey)
    print(G.render(nodes, edges, args.address))
    if args.dot:
        with open(args.dot, "w", encoding="utf-8") as fh:
            fh.write(G.to_dot(nodes, edges, args.address))
        print("wrote " + args.dot)
    return 0


def cmd_signals(args):
    import signals
    store = E.Store(args.home) if args.home else E.Store()
    rows = store.rows("normalized/transfers.jsonl")
    if args.symbol:
        rows = [t for t in rows if t["asset_symbol"].upper() == args.symbol.upper() and (not args.chain or t["chain"] == args.chain)]
    labels, flagged = {}, {}
    if args.labels or args.flagged:
        sys.path.append(os.path.join(os.path.dirname(HERE), "ledger"))
        import onchain
        labels, flagged = onchain.load_list(args.labels), onchain.load_list(args.flagged)
    out = signals.run(rows, labels, flagged, window_h=args.window, fanout_min=args.fanout)
    if args.json:
        print(json.dumps(out, indent=1, default=str))
    else:
        print("{} signal(s) over {} row(s). Signals are leads, never findings.".format(len(out), len(rows)))
        for s in out:
            print("\n{}  [{}]  {}".format(s["signal"], s.get("token_key") or s.get("asset"), s["note"]))
            print("  metrics: " + json.dumps(s["metrics"], default=str))
            print("  ordinary: " + " / ".join(s["ordinary_explanations"]))
            print("  settles it: " + s["what_would_settle_it"])
    return 0


def cmd_attribute(args):
    store = E.Store(args.home) if args.home else E.Store()
    if args.action == "add":
        try:
            r = A.add(store, args.address, args.label, args.cls, args.source, args.locator, args.quote, args.private_person, args.network, args.note)
        except ValueError as e:
            print("coin: " + str(e), file=sys.stderr)
            return 2
        print("recorded: {} {} ({})".format(r["status"], A.shown_label(r), r["class"]))
        return 0
    st = A.status(store, args.address)
    print("ATTRIBUTION  " + st["text"])
    for r in st["records"]:
        print("  {:<21} {:<18} {}  source {}{}".format(r["class"], r["status"], A.shown_label(r), r["source"], "  " + r["locator"] if r.get("locator") else ""))
    print("An address is not a person; a label is only as strong as the record behind it.")
    return 0


def cmd_token(args):
    store = E.Store(args.home) if args.home else E.Store()
    reg = R.TokenRegistry(os.path.join(store.norm_dir, "tokens.json"))
    if args.action == "list":
        for k, t in sorted(reg.tokens.items()):
            print("{:<62} {:<5} dec={:<3} {:<10} {}".format(k, t["symbol"], t.get("decimals"), t.get("status"), (t.get("verified_by") and "by " + t["verified_by"]) or ""))
        return 0
    if args.action == "add":
        t = {"chain": args.chain.lower(), "network": args.network.lower(), "contract_address": args.contract, "symbol": args.symbol.upper(),
             "decimals": args.decimals, "status": "UNVERIFIED", "origin": args.origin or "added by the desk"}
        try:
            reg.add(t)
        except ValueError as e:
            print("coin: " + str(e), file=sys.stderr)
            return 2
        print("added " + R.TokenRegistry.key_of(t))
        return 0
    if args.action == "verify":
        t = reg.tokens.get(args.key)
        if not t:
            print("coin: no token " + args.key, file=sys.stderr)
            return 2
        if not (args.by and args.where):
            print("coin: say who checked (--by) and where the issuer publishes it (--where URL or document)", file=sys.stderr)
            return 2
        t = dict(t)
        t.update({"status": "VERIFIED", "verified_by": args.by, "verified_where": args.where, "verified_at": E.now_utc()})
        reg.add(t)
        print("VERIFIED {} (by {}, per {})".format(args.key, args.by, args.where))
        return 0
    return 2


def cmd_link(args):
    store = E.Store(args.home) if args.home else E.Store()
    try:
        r = LN.link_finding(store, args.finding, args.calc, args.statement)
    except KeyError as e:
        print("coin: " + str(e), file=sys.stderr)
        return 2
    print("linked {} → {}".format(r["finding_id"], ", ".join(r["calc_ids"])))
    return 0


def cmd_import(args):
    store = E.Store(args.home) if args.home else E.Store()
    env = E.import_file(store, args.file, args.chain, args.network, args.note)
    print("in custody: {}  ({} bytes)  envelope {}".format(env["evidence_id"], env["raw_bytes"], env["envelope_id"]))
    return 0


def cmd_export(args):
    """Linked calculations only, as ledger rows. Amounts stay in token units (amount_usd is null)."""
    store = E.Store(args.home) if args.home else E.Store()
    rows = []
    for link in store.rows("derived/findings.jsonl"):
        for cid in link["calc_ids"]:
            c = store.get_calc(cid)
            if not c or c["kind"] not in ("RECEIVED", "SENT"):
                continue
            addr = "ADDR:" + c["address"]
            other = "ADDR:(counterparties)"
            sym = c.get("unit") or ""
            rows.append({"id": "MF-CHAIN-" + cid.split(":")[1][:10], "from": other if c["kind"] == "RECEIVED" else addr,
                         "to": addr if c["kind"] == "RECEIVED" else other, "amount_usd": None,
                         "amount_text": "{} {} (token units, not dollars)".format(c["result"].get("units", c["result"]["raw"]), sym),
                         "kind": "ON_CHAIN_TRANSFER", "period": "blocks {}–{}".format(*c["block_range"]), "snapshot": c["computed_at"][:10],
                         "sources": c["input_evidence"][:5], "locator": cid, "evidence_class": "OFFICIAL_RECORD" if c.get("input_verification", {}).keys() <= {"V2_INCLUDED", "V3_CORROBORATED"} else "REGISTER_ROW",
                         "is_floor": True, "purpose_as_filed": None,
                         "caveat": "Sum of the rows fetched ({}); floor, not a balance. Attribution: {}.".format(c["token_key"], A.status(store, c["address"])["status"]),
                         "quote": None, "findings": [link["finding_id"]]})
    doc = {"schema": "tsr.onchain/1", "exported_at": E.now_utc(), "rows": rows, "attributions": A.public_rows(store)}
    s = json.dumps(doc, indent=1)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(s)
        print("wrote {} row(s) to {}".format(len(rows), args.out))
    else:
        print(s)
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="coin", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version", version=VERSION)
    p.add_argument("--home", help="evidence folder (default: <repo>/evidence or $SENTINEL_COIN_HOME)")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("sources")
    s = sub.add_parser("addr"); s.add_argument("action", choices=["check"]); s.add_argument("address")
    s = sub.add_parser("connect")
    s.add_argument("what", choices=["bitcoin", "stablecoin", "token"])
    s.add_argument("rest", nargs="+", help="bitcoin: tx TXID | address ADDR ; stablecoin: SYMBOL address ADDR | SYMBOL tx HASH")
    s.add_argument("--network", default="mainnet"); s.add_argument("--chain", default="ethereum"); s.add_argument("--source", default="auto", choices=["auto", "node", "rest"])
    s.add_argument("--pages", type=int, default=8); s.add_argument("--direction", default="both", choices=["in", "out", "both"])
    s.add_argument("--from-block", type=int); s.add_argument("--to-block", type=int); s.add_argument("--chunk", type=int, default=5000)
    s.add_argument("--contract")
    s = sub.add_parser("verify"); s.add_argument("kind", choices=["rawtx"]); s.add_argument("raw"); s.add_argument("--txid")
    s.add_argument("--header"); s.add_argument("--proof")
    s = sub.add_parser("report"); s.add_argument("kind", choices=["address"]); s.add_argument("address"); s.add_argument("--symbol", required=True)
    s.add_argument("--chain", default="ethereum"); s.add_argument("--network", default="mainnet"); s.add_argument("--contract")
    s.add_argument("--from-block", type=int); s.add_argument("--to-block", type=int)
    s = sub.add_parser("provenance"); s.add_argument("ident"); s.add_argument("--no-check", action="store_true"); s.add_argument("--json", action="store_true")
    s = sub.add_parser("graph"); s.add_argument("kind", choices=["address"]); s.add_argument("address"); s.add_argument("--hops", type=int, default=2)
    s.add_argument("--symbol"); s.add_argument("--chain", default="ethereum"); s.add_argument("--network", default="mainnet"); s.add_argument("--dot")
    s = sub.add_parser("signals"); s.add_argument("--symbol"); s.add_argument("--chain"); s.add_argument("--labels"); s.add_argument("--flagged")
    s.add_argument("--window", type=float, default=24.0); s.add_argument("--fanout", type=int, default=20); s.add_argument("--json", action="store_true")
    s = sub.add_parser("attribute"); s.add_argument("action", choices=["add", "show"]); s.add_argument("address")
    s.add_argument("--label"); s.add_argument("--class", dest="cls"); s.add_argument("--source"); s.add_argument("--locator"); s.add_argument("--quote")
    s.add_argument("--private-person", action="store_true"); s.add_argument("--network", default="mainnet"); s.add_argument("--note")
    s = sub.add_parser("token"); s.add_argument("action", choices=["list", "add", "verify"]); s.add_argument("key", nargs="?")
    s.add_argument("--chain"); s.add_argument("--network", default="mainnet"); s.add_argument("--contract"); s.add_argument("--symbol")
    s.add_argument("--decimals", type=int); s.add_argument("--origin"); s.add_argument("--by"); s.add_argument("--where")
    s = sub.add_parser("link"); s.add_argument("finding"); s.add_argument("calc", nargs="+"); s.add_argument("--statement", required=True)
    s = sub.add_parser("import"); s.add_argument("file"); s.add_argument("--chain"); s.add_argument("--network"); s.add_argument("--note")
    s = sub.add_parser("export-ledger"); s.add_argument("--out")
    sub.add_parser("selftest")
    return p


def main(argv=None):
    p = build_parser()
    a = p.parse_args(argv)
    if not a.cmd:
        p.print_help()
        return 0
    if a.cmd == "connect":
        r = a.rest
        if a.what == "bitcoin":
            if len(r) != 2 or r[0] not in ("tx", "address"):
                p.error("connect bitcoin tx TXID | connect bitcoin address ADDRESS")
            a.mode, a.ident = r
        else:
            if len(r) != 3 or r[1] not in ("tx", "address"):
                p.error("connect stablecoin SYMBOL address ADDRESS | connect stablecoin SYMBOL tx HASH")
            a.what, a.symbol, a.mode, a.ident = "stablecoin", r[0], r[1], r[2]
        return cmd_connect(a)
    if a.cmd == "selftest":
        import coin_selftest
        return coin_selftest.main()
    return {"sources": cmd_sources, "addr": cmd_addr, "verify": cmd_verify, "report": cmd_report, "provenance": cmd_provenance,
            "graph": cmd_graph, "signals": cmd_signals, "attribute": cmd_attribute, "token": cmd_token, "link": cmd_link,
            "import": cmd_import, "export-ledger": cmd_export}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
