#!/usr/bin/env python3
"""
clverify.py — CourtListener resolver that fails closed.

WHY THIS EXISTS
---------------
CourtListener has two different ID number-spaces that look identical:

  https://www.courtlistener.com/opinion/10358236/granville-.../   <- CLUSTER id
  https://www.courtlistener.com/api/rest/v4/opinions/10358236/    <- OPINION id

They are NOT the same key. The public web URL says "/opinion/" but the number
in it is the *cluster* id. Passing a cluster id to /opinions/{id}/ does not
error — it silently returns whatever unrelated opinion happens to hold that
opinion id. That is how thirteen Ohio appellate lookups came back as SDNY
federal cases.

A resolver that returns the wrong document without erroring is worse than one
that crashes. This one refuses to return anything it has not proven.

USAGE
  export COURTLISTENER_TOKEN=...            # never paste this into a chat window
  python3 clverify.py docket "2024 CA 0075" --court ohioctapp5 --expect "Licking"
  python3 clverify.py cluster 10358236      --expect "Granville"

EXIT CODES
  0  verified   — one match, caption contains --expect
  3  MISMATCH   — resolved, but caption does not contain --expect  (FAIL CLOSED)
  4  CANNOT VERIFY — no token / network error / zero or ambiguous results
"""
import argparse, json, os, sys, urllib.parse, urllib.request

API = "https://www.courtlistener.com/api/rest/v4"
EXIT_OK, EXIT_MISMATCH, EXIT_CANNOT = 0, 3, 4


def get(path, params=None):
    tok = os.environ.get("COURTLISTENER_TOKEN")
    if not tok:
        print("CANNOT VERIFY — COURTLISTENER_TOKEN not set in environment.")
        sys.exit(EXIT_CANNOT)
    url = f"{API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Token {tok}",
        "User-Agent": "TSR-clverify/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f"CANNOT VERIFY — request failed: {type(e).__name__}: {e}")
        sys.exit(EXIT_CANNOT)


def show(rec):
    """Print only the fields that let a human confirm identity. No full text."""
    print(f"  caption   : {rec.get('caseName') or rec.get('case_name')}")
    print(f"  court     : {rec.get('court') or rec.get('court_id')}")
    print(f"  docket    : {rec.get('docketNumber') or rec.get('docket_number')}")
    print(f"  filed     : {rec.get('dateFiled') or rec.get('date_filed')}")
    print(f"  citation  : {rec.get('citation')}")
    print(f"  cluster_id: {rec.get('cluster_id') or rec.get('id')}")
    print(f"  url       : https://www.courtlistener.com"
          f"{rec.get('absolute_url','')}")
    ops = rec.get("opinions") or []
    if ops:
        print(f"  opinion ids (for /opinions/{{id}}/): "
              f"{[o.get('id') for o in ops]}")


def verdict(caption, expect):
    if expect is None:
        print("\nCANNOT VERIFY — no --expect string given. A resolver with no "
              "expectation cannot tell a hit from a wrong document.")
        return EXIT_CANNOT
    if expect.lower() in (caption or "").lower():
        print(f"\nVERIFIED — caption contains {expect!r}.")
        return EXIT_OK
    print(f"\nMISMATCH — caption does not contain {expect!r}. "
          f"DO NOT use this as an exhibit.")
    return EXIT_MISMATCH


def cmd_docket(a):
    q = f'docketNumber:"{a.docket}"'
    params = {"q": q, "type": "o"}
    if a.court:
        params["court"] = a.court
    data = get("search/", params)
    hits = data.get("results", [])
    print(f"query: {q}  court={a.court or '(any)'}  -> {len(hits)} result(s)")
    if not hits:
        print("CANNOT VERIFY — zero results. Docket number format may differ "
              "(try '2024 CA 00075', '24CA0075').")
        return EXIT_CANNOT
    for h in hits:
        print("-" * 60)
        show(h)
    if len(hits) > 1:
        print("\nCANNOT VERIFY — more than one result. Narrow by --court or "
              "date before citing.")
        return EXIT_CANNOT
    return verdict(hits[0].get("caseName"), a.expect)


def cmd_cluster(a):
    rec = get(f"clusters/{a.cluster_id}/")
    print(f"clusters/{a.cluster_id}/")
    show(rec)
    sub = rec.get("sub_opinions") or []
    print(f"  sub_opinions (THESE are /opinions/{{id}}/ keys): {sub}")
    return verdict(rec.get("case_name"), a.expect)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--expect", help="substring the caption MUST contain")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("docket"); d.add_argument("docket")
    d.add_argument("--court", default=None)
    d.add_argument("--expect")
    d.set_defaults(fn=cmd_docket)

    c = sub.add_parser("cluster"); c.add_argument("cluster_id")
    c.add_argument("--expect")
    c.set_defaults(fn=cmd_cluster)

    a = p.parse_args()
    sys.exit(a.fn(a))


if __name__ == "__main__":
    main()
