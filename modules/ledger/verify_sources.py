# -*- coding: utf-8 -*-
"""Re-verify the ledger's cited URLs from your own machine, politely.

    ledger verify-sources                    # plan only: what would be fetched
    ledger verify-sources --go               # fetch, hash, record
    ledger verify-sources --go --only S01,S04 --delay 5

One GET per source, one host at a time, a pause between requests, robots.txt honoured, TLS
verification always on (pass --cafile for a portal that serves an incomplete chain). If a host's
robots.txt cannot be reached at all, its sources are skipped unless you pass --robots-unreachable-ok. Each body
is saved under evidence/ledger/sources/<sha256>, and every result is appended to
verify_sources.jsonl with the HTTP status, final URL, size, type and hash. Where the ledger
already holds a hash, the result says MATCH or CHANGED. Nothing is ever posted or submitted."""
import datetime
import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

import lib_ledger as L

UA = "SentinelLedger/1.0 (source re-verification; one request per source)"
MAX_BYTES = 60 * 1024 * 1024


def targets(ledger, only=None):
    out = []
    for s in ledger["sources"]:
        u = s.get("url")
        if not u or not u.startswith(("http://", "https://")):
            continue
        if only and s["id"] not in only:
            continue
        out.append(s)
    return out


def robots_decision(status=None, error=None):
    """What an answer about robots.txt means. 200 → parse it; 401/403 → disallow all; other 4xx → no rules
    (allow); 5xx or no answer at all → UNKNOWN, which is treated as 'do not fetch' unless the operator says otherwise."""
    if error is not None:
        return "UNKNOWN"
    if status == 200:
        return "PARSE"
    if status in (401, 403):
        return "DISALLOW"
    if status is not None and 400 <= status < 500:
        return "ALLOW"
    return "UNKNOWN"


def robots_ok(url, cache, ctx, unreachable_ok=False):
    """Returns (allowed, note)."""
    p = urllib.parse.urlsplit(url)
    base = "{}://{}".format(p.scheme, p.netloc)
    if base not in cache:
        rp, verdict = None, None
        try:
            req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
                verdict = robots_decision(r.status)
                if verdict == "PARSE":
                    rp = urllib.robotparser.RobotFileParser()
                    rp.parse(r.read(200000).decode("utf-8", "ignore").splitlines())
        except urllib.error.HTTPError as e:
            verdict = robots_decision(e.code)
        except Exception as e:
            verdict = robots_decision(error=e)
        cache[base] = (verdict, rp)
    verdict, rp = cache[base]
    if verdict == "PARSE":
        return rp.can_fetch(UA, url), "robots.txt read"
    if verdict == "ALLOW":
        return True, "no robots.txt rules"
    if verdict == "DISALLOW":
        return False, "robots.txt refused (401/403)"
    return (True, "robots.txt unreachable — fetched because you passed --robots-unreachable-ok") if unreachable_ok else \
           (False, "robots.txt unreachable — skipped (pass --robots-unreachable-ok to fetch anyway)")


def fetch(s, outdir, ctx):
    rec = {"source": s["id"], "url": s["url"], "time_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    req = urllib.request.Request(s["url"], headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=45, context=ctx) as r:
            body = r.read(MAX_BYTES + 1)
            rec.update(status=r.status, final_url=r.geturl(), content_type=r.headers.get("Content-Type"))
    except urllib.error.HTTPError as e:
        body = e.read(MAX_BYTES + 1) if hasattr(e, "read") else b""
        rec.update(status=e.code, final_url=s["url"], content_type=e.headers.get("Content-Type") if e.headers else None)
    except Exception as e:
        rec.update(status=None, error="{}: {}".format(type(e).__name__, e))
        return rec
    rec["truncated"] = len(body) > MAX_BYTES
    body = body[:MAX_BYTES]
    h = hashlib.sha256(body).hexdigest()
    rec.update(size=len(body), sha256=h)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, h), "wb") as fh:          # content-addressed: the name is the hash
        fh.write(body)
    if s.get("sha256"):
        rec["ledger_sha256"] = s["sha256"]
        rec["compare"] = "MATCH" if s["sha256"] == h else "CHANGED"
    else:
        rec["compare"] = "NEW"
    if rec.get("status") and rec["status"] >= 400:
        rec["note"] = "An error page is a dated fact about the URL, not about the record."
    return rec


def main(args):
    ledger = L.load(L.find_ledger(args.ledger))
    only = set(args.only.split(",")) if args.only else None
    ts = targets(ledger, only)
    if not args.go:
        print("PLAN — {} source URL(s); nothing fetched. Add --go to run.".format(len(ts)))
        for s in ts:
            print("  {:<18} {}".format(s["id"], s["url"]))
        return 0
    ctx = ssl.create_default_context(cafile=args.cafile) if args.cafile else ssl.create_default_context()
    outdir = os.path.join(L.ledger_dir(), "sources")
    log = os.path.join(L.ledger_dir(), "verify_sources.jsonl")
    cache, last_host = {}, {}
    for s in ts:
        host = urllib.parse.urlsplit(s["url"]).netloc
        wait = args.delay - (time.time() - last_host.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        allowed, why = robots_ok(s["url"], cache, ctx, getattr(args, "robots_unreachable_ok", False))
        if not allowed:
            rec = {"source": s["id"], "url": s["url"], "status": None, "compare": "SKIPPED", "note": why}
        else:
            rec = fetch(s, outdir, ctx)
            rec["robots"] = why
        last_host[host] = time.time()
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print("{:<18} {:>4}  {:<8} {}".format(s["id"], rec.get("status") or "—", rec.get("compare", ""), rec.get("error") or rec.get("final_url", "")))
    print("results appended to " + log)
    return 0
