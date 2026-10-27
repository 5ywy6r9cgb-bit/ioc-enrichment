#!/usr/bin/env python3
"""foia_data -- FOIA annual-report numbers from the agencies' own bulk files.

Stdlib only. Reads the "all agencies" CSV sets downloaded from FOIA.gov
(one folder per fiscal year: <root>/y2008, <root>/y2024, <root>/y2025) and
reports volumes, backlog and median response days.

RULES THIS CODE ENFORCES
  * The "All agencies" row in each CSV is a TOTAL. It is dropped before any
    sum, because adding it to the agency rows exactly doubles the figure.
  * Only "Agency Overall" rows are summed (never components + overall).
  * Non-numeric cells ("<1", "N/A") are kept as text and never summed.
  * Every report prints the sha256 of each source file it read.
  * Agency counts differ by year; every total prints its agency count.
  * The API check never prints the key.
"""
import argparse, csv, glob, hashlib, json, os, sys, urllib.request, urllib.error

RECV = "Number of Requests Received in Fiscal Year"
PROC = "Number of Requests Processed in Fiscal Year"
PEND_S = "Number of Requests Pending as of Start of Fiscal Year"
PEND_E = "Number of Requests Pending as of End of Fiscal Year"
RT_SIMPLE = "Simple - Median Number of Days"
RT_COMPLEX = "Complex - Median Number of Days"
F_RECV = "foia-received-processed-and-pending-foia-requests*.csv"
F_RT = "foia-processed-requests-response-time-for-all-processed-perfected-requests*.csv"


def num(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def find_file(root, year, pattern):
    hits = sorted(glob.glob(os.path.join(root, "y%s" % year, "**", pattern), recursive=True))
    return hits[0] if hits else None


def load(root, year, pattern):
    """Return (rows, path, sha256). Empty rows and None when the file is absent."""
    p = find_file(root, year, pattern)
    if not p:
        return [], None, None
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f)), p, sha256_file(p)


def agency_rows(rows):
    """Agency Overall rows only, with the 'All agencies' total row removed."""
    return [r for r in rows
            if (r.get("Component") or "").strip().lower() == "agency overall"
            and not (r.get("Agency") or "").lower().startswith("all agenc")]


def totals(root, year):
    rows, path, digest = load(root, year, F_RECV)
    ag = agency_rows(rows)
    t = {c: int(sum(num(r.get(c)) or 0 for r in ag)) for c in (PEND_S, RECV, PROC, PEND_E)}
    return {"year": str(year), "agencies": len(ag), "received": t[RECV], "processed": t[PROC],
            "pending_start": t[PEND_S], "pending_end": t[PEND_E], "source": path, "sha256": digest}


def scoreboard(root, year):
    rows, _, _ = load(root, year, F_RECV)
    rt_rows, _, _ = load(root, year, F_RT)
    rt = {r["Agency"]: r for r in agency_rows(rt_rows)}
    out = []
    for r in agency_rows(rows):
        rec, pro, pen = num(r.get(RECV)) or 0, num(r.get(PROC)) or 0, num(r.get(PEND_E)) or 0
        t = rt.get(r["Agency"], {})
        out.append({"agency": r["Agency"], "received": int(rec), "processed": int(pro),
                    "pending_end": int(pen),
                    "processed_pct": round(100.0 * pro / rec, 1) if rec else None,
                    "simple_median_days": t.get(RT_SIMPLE, ""),
                    "complex_median_days": t.get(RT_COMPLEX, "")})
    out.sort(key=lambda x: -x["received"])
    return out


def api_check(base="https://api.foia.gov", opener=urllib.request.urlopen, env=os.environ):
    """One authenticated call. Reports the raw HTTP status; never prints the key."""
    key = env.get("FOIA_API_KEY", "")
    if not key:
        return {"ok": False, "status": None, "error": "FOIA_API_KEY is not set", "key_length": 0}
    req = urllib.request.Request(base + "/api/agency_components?page[limit]=1",
                                 headers={"X-API-Key": key, "Accept": "application/json"})
    try:
        with opener(req, timeout=30) as resp:
            body = resp.read(200000)
            status = resp.status
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "error": "HTTP %d" % e.code, "key_length": len(key)}
    except Exception as e:  # network failure is not a result
        return {"ok": False, "status": None, "error": type(e).__name__, "key_length": len(key)}
    try:
        data = json.loads(body.decode("utf-8", "replace"))
        has_data = isinstance(data, dict) and isinstance(data.get("data"), list)
    except ValueError:
        has_data = False
    return {"ok": status == 200 and has_data, "status": status,
            "error": None if has_data else "200 but body is not the expected JSON:API shape",
            "key_length": len(key)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["totals", "scoreboard", "api-check"])
    ap.add_argument("--root", default=os.path.join("missions", "foia", "data"))
    ap.add_argument("--year", default="2025")
    ap.add_argument("--years", default="2008,2024,2025")
    ap.add_argument("--min-received", type=int, default=0)
    ap.add_argument("--out", help="write the scoreboard as CSV")
    a = ap.parse_args(argv)
    if a.cmd == "api-check":
        r = api_check()
        print("FOIA API: status=%s ok=%s key_length=%s %s" % (r["status"], r["ok"], r["key_length"], r["error"] or ""))
        return 0 if r["ok"] else 1
    if a.cmd == "totals":
        for y in a.years.split(","):
            t = totals(a.root, y.strip())
            if not t["source"]:
                print("%s: no file found under %s/y%s" % (y, a.root, y)); continue
            print("%s agencies=%d received=%s processed=%s pending_end=%s  [sha256 %s]" % (
                t["year"], t["agencies"], format(t["received"], ","), format(t["processed"], ","),
                format(t["pending_end"], ","), t["sha256"][:12]))
        print("Agency counts differ by year; the 'All agencies' row is excluded. Reported, not audited.")
        return 0
    rows = [r for r in scoreboard(a.root, a.year) if r["received"] >= a.min_received]
    if a.out:
        with open(a.out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["agency"])
            w.writeheader(); w.writerows(rows)
        print("wrote %s (%d rows)" % (a.out, len(rows)))
    for r in rows[:15]:
        print(r["agency"], r["received"], r["processed"], r["pending_end"], r["processed_pct"],
              r["simple_median_days"], r["complex_median_days"], sep=" | ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
