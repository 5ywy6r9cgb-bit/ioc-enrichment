# -*- coding: utf-8 -*-
"""The address report: what the chain says, kept apart from what Sentinel infers.

Amounts are printed in token units with the symbol (4,728,122.00 USDC), never with a dollar sign.
A stablecoin unit is a claim on an issuer, not a dollar; converting it is a separate, sourced step.
"""
import attribution as A
import lineage as LN
import models as M

VERDICT = {
    "V3_CORROBORATED": "VERIFIED (a second, independent source returned identical data)",
    "V2_INCLUDED": "VERIFIED (committed in a block with valid proof of work)",
    "V1_HASH_BOUND": "VERIFIED (raw bytes hash to the transaction id)",
    "V0_REPORTED": "REPORTED (one source; not independently checked)",
    "MISMATCH": "DISPUTED (sources disagree; do not use)",
}


def weakest(levels):
    order = M.LEVELS
    present = [l for l in order if l in levels]
    return present[0] if present else "V0_REPORTED"


def address_report(store, token, token_key, address, block_from=None, block_to=None, save_calcs=True):
    rows_all = store.rows("normalized/transfers.jsonl")
    rows = LN.select(rows_all, token_key, address, block_from, block_to)
    a = address.lower() if address.startswith("0x") else address
    calcs = {}
    for kind in ("RECEIVED", "SENT", "COUNT_IN", "COUNT_OUT", "TX_COUNT", "COUNTERPARTIES"):
        calcs[kind] = LN.calculate(store, kind, token_key, address, rows, block_from, block_to) if save_calcs else None
    sym = token["symbol"]
    dec = token.get("decimals")
    blocks = [t["block_number"] for t in rows if t.get("block_number") is not None]
    times = sorted(t["timestamp"] for t in rows if t.get("timestamp"))
    eids = sorted(set(t["evidence_id"] for t in rows))
    envs = [e for eid in eids for e in store.envelopes_for(eid)]
    providers = sorted(set("{}{}".format(e["source"]["provider"], "" if e["source"]["authoritative"] else " (not authoritative)") for e in envs))
    retrieved = sorted(e["source"]["retrieved_at"] for e in envs)
    levels = [t.get("verification", "V0_REPORTED") for t in rows]
    att = A.status(store, address)

    def units(kind):
        c = calcs[kind]
        if not c:
            return "—"
        if "units" in c["result"]:
            return "{}  {}".format(M.fmt_units(M.Decimal(c["result"]["units"]), 8 if sym == "BTC" else 2, sym), c["calc_id"])
        return "{} (raw units; decimals unknown)  {}".format(c["result"]["raw"], c["calc_id"])

    L = ["SENTINEL BLOCKCHAIN", ""]
    L.append("Network       {} ({})".format(token["chain"], token["network"]))
    L.append("Asset         {}{}  [token record: {}]".format(sym, "  contract " + token["contract_address"] if token.get("contract_address") else "",
                                                           token.get("status", "UNVERIFIED")))
    L.append("Address       {}".format(address))
    L.append("")
    L.append("OBSERVED      (rows read from chain data, as fetched)")
    L.append("Transfer rows        {:,}".format(len(rows)))
    L.append("Incoming             {:,}".format(int(calcs["COUNT_IN"]["result"]["raw"])))
    L.append("Outgoing             {:,}".format(int(calcs["COUNT_OUT"]["result"]["raw"])))
    L.append("Transactions         {:,}".format(int(calcs["TX_COUNT"]["result"]["raw"])))
    if blocks:
        L.append("Blocks seen          {:,} → {:,}".format(min(blocks), max(blocks)))
    if times:
        L.append("Time seen            {} → {}  (block times as reported)".format(times[0], times[-1]))
    L.append("")
    L.append("DERIVED       (computed by Sentinel from the rows above; every figure has a calc id)")
    L.append("Received             " + units("RECEIVED"))
    L.append("Sent                 " + units("SENT"))
    L.append("Counterparties       {:,}  {}".format(int(calcs["COUNTERPARTIES"]["result"]["raw"]), calcs["COUNTERPARTIES"]["calc_id"]))
    if token["chain"] == "bitcoin":
        L.append("                     (Bitcoin: 'sent' is gross inputs spent, including change that came back)")
    L.append("")
    L.append("ATTRIBUTION")
    L.append(att["text"] + ("" if att["status"] != "Unknown" else "   (an address is not a person)"))
    L.append("")
    L.append("SOURCE")
    L.append("Provider            " + ("; ".join(providers) or "—"))
    if retrieved:
        L.append("Retrieved           {}{}".format(retrieved[0], " → " + retrieved[-1] if retrieved[-1] != retrieved[0] else ""))
    L.append("Evidence            {} response(s){}".format(len(eids), "; e.g. " + eids[0] if eids else ""))
    if block_from is not None or block_to is not None:
        L.append("Block range         {} → {}".format("{:,}".format(block_from) if block_from is not None else "start", "{:,}".format(block_to) if block_to is not None else "tip"))
    L.append("")
    L.append("VERIFICATION")
    lvl = weakest(levels) if rows else "V0_REPORTED"
    L.append("Chain data          {}".format(VERDICT[lvl] if rows else "no rows"))
    if rows and len(set(levels)) > 1:
        L.append("                    (levels across rows: {})".format(", ".join("{} {}".format(levels.count(l), l) for l in sorted(set(levels)))))
    L.append("Token identity      {}".format(token.get("status", "UNVERIFIED") + ("" if token.get("status") == "VERIFIED" else " — " + (token.get("origin") or "confirm the contract against the issuer"))))
    L.append("Address attribution {}".format("UNVERIFIED" if att["status"] in ("Unknown", "UNVERIFIED", "HYPOTHESIS") else att["status"]))
    L.append("")
    L.append("WHAT THIS DOES NOT SHOW")
    L.append("- who controls this address")
    if sym in ("USDC", "USDT"):
        L.append("- that {} units equal dollars (a stablecoin unit is a claim on its issuer)".format(sym))
    L.append("- transfers outside the blocks fetched, or the address's balance")
    L.append("- why any transfer was made")
    return "\n".join(L), calcs
