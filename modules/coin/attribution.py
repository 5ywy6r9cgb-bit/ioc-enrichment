# -*- coding: utf-8 -*-
"""Who controls an address, and on what evidence. The chain never says.

A blockchain address is observable. Saying who controls it needs a separate record, and the
class of that record decides what may be said. Nothing is promoted automatically: a label from an
API stays UNVERIFIED no matter how many APIs repeat it (repetition is not independence).

  class                  status shown        what it proves
  OFFICIAL_ATTRIBUTION   ATTRIBUTED          a government document names the address (quote + locator required)
  COURT_RECORD           ALLEGED             a filed complaint or affidavit names it; an allegation until decided
  SIGNED_MESSAGE         KEY CONTROL SHOWN   someone produced a signature with its key, at that time; not identity
  SELF_DECLARED          CLAIMED             the entity publishes it as its own; proves the claim, not exclusive control
  PROVIDER_LABEL         UNVERIFIED          an explorer or data-API label; a lead
  DESK_HEURISTIC         HYPOTHESIS          desk clustering or change detection; can be wrong (CoinJoin, custodians)

Private people are never named in any output (desk policy): a record marked private_person prints
as "a private person (not named)" and is excluded from every export.
"""
import evidence as E

CLASSES = {
    "OFFICIAL_ATTRIBUTION": ("ATTRIBUTED", 6),
    "COURT_RECORD": ("ALLEGED", 5),
    "SIGNED_MESSAGE": ("KEY CONTROL SHOWN", 4),
    "SELF_DECLARED": ("CLAIMED", 3),
    "PROVIDER_LABEL": ("UNVERIFIED", 2),
    "DESK_HEURISTIC": ("HYPOTHESIS", 1),
}
NEEDS_QUOTE = ("OFFICIAL_ATTRIBUTION", "COURT_RECORD", "SELF_DECLARED")
TABLE = "derived/attributions.jsonl"


def norm(address):
    return address.lower() if address.startswith("0x") else address


def add(store, address, label, cls, source, locator=None, quote=None, private_person=False, network="mainnet", note=None):
    if cls not in CLASSES:
        raise ValueError("class must be one of " + ", ".join(CLASSES))
    if not source:
        raise ValueError("every attribution needs a source (document id, URL or provider name)")
    if cls in NEEDS_QUOTE and not (locator and quote):
        raise ValueError("{} needs the exact words naming the address (--quote) and where they are (--locator)".format(cls))
    if cls in NEEDS_QUOTE and norm(address) not in norm(quote).replace(" ", ""):
        raise ValueError("the quote does not contain the address — quote the line that names it")
    row = {"address": norm(address), "network": network, "label": label, "class": cls, "status": CLASSES[cls][0],
           "source": source, "locator": locator, "quote": quote, "private_person": bool(private_person), "note": note,
           "added_at": E.now_utc()}
    store.append_rows(TABLE, [row], key=lambda r: (r["address"], r["class"], r["source"], r["label"]))
    return row


def records(store, address):
    return [r for r in store.rows(TABLE) if r["address"] == norm(address)]


def shown_label(r):
    return "a private person (not named)" if r.get("private_person") else r["label"]


def status(store, address):
    rs = records(store, address)
    if not rs:
        return {"status": "Unknown", "text": "Unknown", "records": []}
    best = max(rs, key=lambda r: CLASSES[r["class"]][1])
    others = len(rs) - 1
    text = "{} — {} (per {}{})".format(best["status"], shown_label(best), best["source"], ", " + best["locator"] if best.get("locator") else "")
    if others:
        text += "; {} other record(s)".format(others)
    return {"status": best["status"], "text": text, "records": rs, "best": best}


def public_rows(store):
    """Attribution rows safe to export: never private people, never bare provider labels or heuristics."""
    return [r for r in store.rows(TABLE) if not r.get("private_person") and r["class"] in ("OFFICIAL_ATTRIBUTION", "COURT_RECORD", "SELF_DECLARED")]
