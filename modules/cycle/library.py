"""library.py - the desk's source library.

What each source holds, what it cannot show, whether you have adopted it,
and whether its public page still answers. Decisions and checks are
append-only JSONL under evidence/cycle/, hashed into every cycle record.

`check` is a dry run unless --go is given. With --go it makes exactly one
GET per source page, plus robots.txt once per host (RFC 9309: a 4xx
robots file means no rules; a 5xx or unreachable one fails closed unless
--robots-unreachable-ok). TLS verification is always on. Standard library only.
"""
import datetime
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from urllib import robotparser

UA = "sentinel-cycle/1.0 (library check)"
MAX_BYTES = 2 * 1024 * 1024
DECISIONS = ("APPROVED", "REJECTED")


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def load(module_dir):
    with open(os.path.join(module_dir, "library.json"), "r", encoding="utf-8") as fh:
        lib = json.load(fh)
    ids = [s["id"] for s in lib["sources"]]
    if len(ids) != len(set(ids)):
        raise ValueError("library.json has duplicate ids")
    return lib


def cycle_dir(root):
    return os.path.join(root, "evidence", "cycle")


def decisions_path(root):
    return os.path.join(cycle_dir(root), "library_decisions.jsonl")


def checks_path(root):
    return os.path.join(cycle_dir(root), "library_checks.jsonl")


def read_jsonl(path):
    rows = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return rows


def append_jsonl(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = (json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def effective(lib, root):
    """[(source, effective_status, last_decision, last_check, previous_check)]"""
    last_dec = {}
    for d in read_jsonl(decisions_path(root)):
        last_dec[d.get("id")] = d
    last_chk, prev_chk = {}, {}
    for c in read_jsonl(checks_path(root)):
        sid = c.get("id")
        if sid in last_chk:
            prev_chk[sid] = last_chk[sid]
        last_chk[sid] = c
    rows = []
    for s in lib["sources"]:
        st = s["status"]
        d = last_dec.get(s["id"])
        if d and st != "ACTIVE":
            st = d.get("decision", st)
        rows.append((s, st, d, last_chk.get(s["id"]), prev_chk.get(s["id"])))
    return rows


def find(lib, sid):
    want = (sid or "").strip().upper()
    for s in lib["sources"]:
        if s["id"].upper() == want:
            return s
    return None


def _yn(v):
    if v is True:
        return "yes"
    if v is False:
        return "no"
    return "?"


def cmd_list(lib, root, status=None, topic=None, out=sys.stdout):
    rows = effective(lib, root)
    w = out.write
    w("SENTINEL LIBRARY  %d sources  (as of %s)\n\n" % (len(rows), lib.get("as_of", "?")))
    w("  %-18s %-9s %-5s %-5s %-28s %s\n" % ("ID", "STATUS", "AUTH", "KEY", "TOPICS", "LAST CHECK"))
    shown = 0
    for s, st, _d, chk, _p in rows:
        if status and st.upper() != status.upper():
            continue
        topics = s.get("topics", [])
        if topic and topic.lower() not in [t.lower() for t in topics]:
            continue
        key = s.get("key", {}).get("needed")
        last = "-"
        if chk:
            last = "%s %s" % (chk.get("status", "?"), (chk.get("at") or "")[:10])
        w("  %-18s %-9s %-5s %-5s %-28s %s\n" % (s["id"], st, _yn(s.get("authoritative")), _yn(key),
                                                ",".join(topics)[:28], last))
        shown += 1
    w("\n  %d shown. AUTH=no means an aggregator or index: its rows are leads.\n" % shown)
    w("  bin/sentinel-cycle library show ID   for what a source holds and cannot show\n")
    return 0


def cmd_show(lib, root, sid, out=sys.stdout):
    s = find(lib, sid)
    if not s:
        out.write("unknown source: %s\n  bin/sentinel-cycle library list\n" % sid)
        return 2
    row = [r for r in effective(lib, root) if r[0] is s][0]
    _s, st, dec, chk, _p = row
    w = out.write
    w("%s  %s\n" % (s["id"], s["name"]))
    w("  status        %s%s\n" % (st, "  (outside source, brought in 2026-09-30 on request)" if s.get("outside") else ""))
    w("  publisher     %s\n" % s.get("publisher", "?"))
    w("  kind          %s   authoritative: %s\n" % (s.get("kind", "?"), _yn(s.get("authoritative"))))
    if s.get("connector"):
        w("  connector     %s\n" % s["connector"])
    key = s.get("key", {})
    w("  key           %s%s\n" % (_yn(key.get("needed")) if not isinstance(key.get("needed"), str) else key.get("needed"),
                                  ("  " + key["how"]) if key.get("how") else ("  " + key["where"]) if key.get("where") else ""))
    for label, field in (("base", "base"), ("docs", "docs"), ("probe", "probe"), ("limits", "limits"),
                         ("holds", "holds"), ("cannot show", "cannot_show"), ("use when", "use_when"),
                         ("note", "note"), ("kit check", "kit_check")):
        if s.get(field):
            w("  %-13s %s\n" % (label, s[field]))
    for p in s.get("paths", []):
        w("  path          %s\n" % p)
    v = s.get("verified")
    if v:
        w("  verified      %s via %s\n                %s\n" % (v.get("on"), v.get("via"), v.get("found")))
    if dec:
        w("  decision      %s by %s at %s%s\n" % (dec.get("decision"), dec.get("by"), dec.get("at"),
                                                  (" - " + dec["note"]) if dec.get("note") else ""))
    if chk:
        w("  last check    %s (HTTP %s) %s%s\n" % (chk.get("status"), chk.get("http"), chk.get("at"),
                                                   "  page changed since the check before" if chk.get("changed") else ""))
    if s.get("first_use"):
        w("\n  first use     %s\n" % s["first_use"])
        if s.get("first_use_why"):
            w("                %s\n" % s["first_use_why"])
    if st == "PROPOSED":
        w("\n  adopt it      bin/sentinel-cycle library approve %s --by \"your initials\"\n" % s["id"])
    return 0


def cmd_decide(lib, root, sid, decision, by, note="", out=sys.stdout):
    s = find(lib, sid)
    if not s:
        out.write("unknown source: %s\n" % sid)
        return 2
    if decision not in DECISIONS:
        out.write("decision must be one of %s\n" % ", ".join(DECISIONS))
        return 2
    by = (by or "").strip()
    if not by or len(by) > 40 or "\n" in by:
        out.write("--by is required: who is making this decision (1-40 characters)\n")
        return 2
    if s["status"] == "ACTIVE":
        out.write("%s is already one of the desk's connectors; there is nothing to %s.\n"
                  % (s["id"], "approve" if decision == "APPROVED" else "reject"))
        return 0
    row = {"at": iso(utcnow()), "id": s["id"], "decision": decision, "by": by}
    if note:
        row["note"] = note.strip()[:300]
    append_jsonl(decisions_path(root), row)
    out.write("%s  %s by %s  (recorded in evidence/cycle/library_decisions.jsonl)\n" % (s["id"], decision, by))
    if decision == "APPROVED" and s.get("first_use"):
        out.write("  first use: %s\n" % s["first_use"])
    return 0


# ---- network ---------------------------------------------------------------

def ssl_context(cafile=None):
    cafile = cafile or os.environ.get("SENTINEL_CAFILE") or None
    ctx = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def http_get(url, cafile=None, timeout=20):
    """-> (http_status or None, final_url, body_bytes, content_type, error_text)"""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context(cafile)) as resp:
            body = resp.read(MAX_BYTES + 1)[:MAX_BYTES]
            return resp.status, resp.geturl(), body, resp.headers.get("Content-Type", ""), None
    except urllib.error.HTTPError as e:
        try:
            body = e.read(MAX_BYTES)
        except Exception:
            body = b""
        return e.code, e.geturl() if hasattr(e, "geturl") else url, body, "", None
    except Exception as e:  # DNS, TLS, timeout, refused
        return None, url, b"", "", "%s: %s" % (type(e).__name__, str(e)[:200])


def robots_verdict(url, fetch, cafile, cache):
    """-> 'ALLOW' | 'DISALLOW' | 'UNREACHABLE'  (RFC 9309 semantics)"""
    parts = urllib.parse.urlsplit(url)
    host = "%s://%s" % (parts.scheme, parts.netloc)
    if host not in cache:
        code, _final, body, _ct, err = fetch(host + "/robots.txt", cafile)
        if code is not None and 200 <= code < 300:
            rp = robotparser.RobotFileParser()
            rp.parse(body.decode("utf-8", "replace").splitlines())
            cache[host] = ("PARSED", rp)
        elif code is not None and 400 <= code < 500:
            cache[host] = ("NONE", None)
        else:
            cache[host] = ("UNREACHABLE", None)
    kind, rp = cache[host]
    if kind == "NONE":
        return "ALLOW"
    if kind == "UNREACHABLE":
        return "UNREACHABLE"
    return "ALLOW" if rp.can_fetch(UA, url) else "DISALLOW"


def classify(code, err):
    if err or code is None:
        return "ERROR"
    if 200 <= code < 400:
        return "OK"
    if code in (401, 403, 429):
        return "BLOCKED"
    if code in (404, 410):
        return "GONE"
    return "ERROR"


def cmd_check(lib, root, go=False, only=None, delay=2.0, robots_unreachable_ok=False,
              cafile=None, fetch=None, out=sys.stdout, sleep=time.sleep):
    fetch = fetch or http_get
    rows = effective(lib, root)
    targets = []
    for s, st, _d, _c, _p in rows:
        if only and s["id"].upper() not in [o.upper() for o in only]:
            continue
        if st == "REJECTED":
            continue
        if s.get("probe"):
            targets.append(s)
    hosts = sorted({urllib.parse.urlsplit(s["probe"]).netloc for s in targets})
    w = out.write
    if not go:
        w("LIBRARY CHECK - dry run (add --go to make these calls)\n")
        w("calls     %d GET (one per source page) + robots.txt once per host (%d hosts)\n" % (len(targets), len(hosts)))
        w("boundary  a page that answers is not a source that is right; this checks the door, not the room\n\n")
        for s in targets:
            w("  %-18s GET %s\n" % (s["id"], s["probe"]))
        return 0
    last = {}
    for s, _st, _d, c, _p in rows:
        if c:
            last[s["id"]] = c
    w("LIBRARY CHECK - authorized run\n")
    w("calls     %d GET + robots.txt for %d hosts, %.1fs apart, TLS verification on\n\n" % (len(targets), len(hosts), delay))
    cache, bad = {}, 0
    for i, s in enumerate(targets):
        if i:
            sleep(delay)
        url = s["probe"]
        t0 = time.time()
        verdict = robots_verdict(url, fetch, cafile, cache)
        row = {"at": iso(utcnow()), "id": s["id"], "url": url}
        if verdict == "DISALLOW":
            row.update({"status": "ROBOTS", "http": None})
        elif verdict == "UNREACHABLE" and not robots_unreachable_ok:
            row.update({"status": "ROBOTS_UNREACHABLE", "http": None})
        else:
            code, final, body, ctype, err = fetch(url, cafile)
            if err and code is None:
                # one polite retry for a dropped connection; never for an HTTP answer
                sleep(3)
                code, final, body, ctype, err = fetch(url, cafile)
                row["retried"] = True
            status = classify(code, err)
            sha = hashlib.sha256(body).hexdigest() if body else None
            prev = last.get(s["id"])
            changed = None
            if prev and prev.get("sha256") and sha:
                changed = prev.get("sha256") != sha
            row.update({"status": status, "http": code, "final_url": final, "bytes": len(body),
                        "sha256": sha, "content_type": (ctype or "")[:80], "changed": changed})
            if err:
                row["error"] = err
        row["seconds"] = round(time.time() - t0, 2)
        append_jsonl(checks_path(root), row)
        if row["status"] in ("GONE", "ERROR", "ROBOTS_UNREACHABLE"):
            bad += 1
        note = ""
        if row.get("changed") is True:
            note = "  page changed since last check"
        elif row.get("changed") is False:
            note = "  unchanged"
        if row["status"] == "BLOCKED":
            note += "  (answers people, not scripts: open it in a browser)"
        w("  %-18s %-18s %-4s %s%s\n" % (s["id"], row["status"], row.get("http") or "-", url, note))
    w("\n  recorded in evidence/cycle/library_checks.jsonl\n")
    if bad:
        w("  %d source(s) GONE or unreachable: read them with bin/sentinel-cycle library show ID\n" % bad)
    return 1 if bad else 0
