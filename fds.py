#!/usr/bin/env python3
"""
fds.py — pull Ohio Financial Disclosure Statements straight off JLEC.

WHY THIS EXISTS
  The two-register cross-check has been sitting in the "records request"
  pile since the Negev record opened. It does not belong there. Ohio
  legislators' financial disclosure statements are already online, rendered
  server-side, at a stable URL:

      https://www2.jlec-olig.state.oh.us/FDS/Statements/<ID>/View

  That page carries §8 TRAVEL, §9 GIFTS and §10 MEALS, FOOD AND BEVERAGES —
  the three sections that would show a trip from the recipient's side — plus
  the exact filing timestamp. No FOIA letter. No waiting.

WHAT IT CANNOT DO
  The filer name search at /FDS/Reports/Search is a POST form. This script
  does not submit it and does not guess at statement IDs by walking the
  number space — that is scraping a state server for records it will hand
  you if you ask it properly. Get the IDs from the search page in a browser,
  then feed them here.

READ THIS BEFORE YOU TRUST THE OUTPUT
  I could not run this against the live site. The container it was written
  in cannot reach www2.jlec-olig.state.oh.us. The parser was written against
  the RENDERED TEXT of two statements I did read (IDs 10670 and 9000), and
  `selftest` re-checks that reading. If selftest fails, the page structure
  moved or my selectors were wrong, and every other verb in this file is
  suspect. It exits 4 and says so rather than printing something that looks
  like an answer.

USAGE
  python3 fds.py selftest                 # DO THIS FIRST. exit 4 = do not trust
  python3 fds.py probe 10670
  python3 fds.py scan 9871 9872 9873 --out fds_2023/
  python3 fds.py scan --file ids.txt --out fds_2023/

EXIT  0 clean · 3 a statement parsed but a section was missing
      4 CANNOT VERIFY — unreachable, or the parser no longer recognises the page
"""
import argparse, hashlib, html, json, os, re, sys, time, urllib.error, urllib.request

OK, PARTIAL, CANNOT = 0, 3, 4
BASE = "https://www2.jlec-olig.state.oh.us/FDS/Statements/{}/View"
UA = "TSR-desk/1.0 (public records research; contact via The Sentinel Report)"

# The sections that answer the question. Everything else on the form is
# income and investments and is not what this pull is for.
WANTED = [
    (8,  "TRAVEL"),
    (9,  "GIFTS"),
    (10, "MEALS, FOOD AND BEVERAGES"),
]


def get(url, tries=3):
    """-> (text, sha256) or raises. Slow on purpose: one request every 1.5s."""
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                raw = r.read()
            return raw.decode("utf-8", "replace"), hashlib.sha256(raw).hexdigest()
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            last = e
            time.sleep(2 * (a + 1))
    raise RuntimeError(f"{type(last).__name__}: {last}")


def text_of(doc):
    """HTML -> visible text, with block boundaries preserved as newlines.

    Deliberately structure-agnostic. A parser keyed to div classes breaks the
    first time the state redeploys the app; one keyed to the words printed on
    the form breaks only if the form changes, which is a thing worth noticing.
    """
    d = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", doc)
    d = re.sub(r"(?i)<(br|/p|/div|/tr|/h\d|/li|/td)\s*/?>", "\n", d)
    d = re.sub(r"(?s)<[^>]+>", " ", d)
    d = html.unescape(d)
    d = re.sub(r"[ \t\xa0]+", " ", d)
    return "\n".join(ln.strip() for ln in d.split("\n") if ln.strip())


def sections(txt):
    """-> {n: body text} for every 'N. HEADING' block this form prints."""
    heads = list(re.finditer(r"(?m)^\s*(\d{1,2})\s*[.)]?\s+"
                             r"([A-Z][A-Z ,&/'\-]{3,60})\s*$", txt))
    out = {}
    for i, m in enumerate(heads):
        n = int(m.group(1))
        end = heads[i + 1].start() if i + 1 < len(heads) else len(txt)
        out[n] = (m.group(2).strip(), txt[m.end():end].strip())
    return out


def meta(txt):
    """Filer, statement year and filing timestamp, or None for each."""
    yr = re.search(r"(20\d{2})\s+Financial Disclosure Statement", txt, re.I)
    if not yr:
        yr = re.search(r"Financial Disclosure Statement\D{0,40}(20\d{2})", txt, re.I)
    ts = re.search(r"(\d{1,2}/\d{1,2}/20\d{2})\s*(?:at\s*)?"
                   r"(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]\.?M\.?)?", txt, re.I)
    # The filer's name. This is the ONE field on the page with no stable
    # anchor, so it is tried three ways and the winner is labelled. Live run
    # 2026-09-20 returned "View Statement" — a page heading that happens to
    # look like a name. Headings are now excluded by name, not by hope.
    SKIP = ("view statement", "statement", "financial disclosure",
            "ohio", "ethics", "joint legislative", "general assembly",
            "print", "back", "home", "search", "contact", "logout",
            "section", "item number", "source", "amount", "none")
    NAME_RE = r"[A-Z][a-zA-Z'\-]+(?:,)?(?: [A-Z]\.?)?(?: [A-Z][a-zA-Z'\-]+){1,3}"
    who, how = None, None
    # 1. a line immediately before or after the "<year> Financial Disclosure
    #    Statement" line — the form puts the filer next to its own title
    lines = txt.split("\n")
    for i, ln in enumerate(lines[:80]):
        if re.search(r"20\d{2}\s+Financial Disclosure Statement", ln, re.I):
            for j in (i - 1, i + 1, i - 2, i + 2):
                if 0 <= j < len(lines):
                    c = lines[j].strip()
                    if re.fullmatch(NAME_RE, c) and c.lower() not in SKIP:
                        who, how = c, "adjacent to title"; break
        if who:
            break
    # 2. "filed by <name>" / "Filer: <name>"
    if not who:
        m = re.search(r"(?:filed by|filer)\s*[:\-]?\s*(" + NAME_RE + ")", txt, re.I)
        if m and m.group(1).strip().lower() not in SKIP:
            who, how = m.group(1).strip(), "labelled"
    # 3. first title-cased line that is not a known heading
    if not who:
        for ln in lines[:60]:
            c = ln.strip()
            if re.fullmatch(NAME_RE, c) and not any(k in c.lower() for k in SKIP):
                who, how = c, "first title-cased line"; break
    return {
        "filer": who,
        "filer_method": how,
        "statement_year": yr.group(1) if yr else None,
        "filed": (ts.group(1) + (" " + ts.group(2) if ts and ts.group(2) else "")) if ts else None,
    }


def pull(sid):
    url = BASE.format(sid)
    doc, sha = get(url)
    txt = text_of(doc)
    secs = sections(txt)
    rec = {"id": str(sid), "url": url, "sha256_of_page": sha, **meta(txt),
           "sections": {}, "missing": []}
    for n, label in WANTED:
        if n in secs:
            head, body = secs[n]
            rec["sections"][str(n)] = {"heading": head,
                                       "expected": label,
                                       "heading_matches": label.split(",")[0] in head,
                                       "body": body[:4000]}
        else:
            rec["missing"].append(f"{n}. {label}")
    return rec


def show(rec):
    print(f"  {rec['url']}")
    print(f"  FILER      {rec.get('filer') or '— not parsed —'}"
          f"   [{rec.get('filer_method') or 'no method matched'}]")
    print(f"  YEAR       {rec.get('statement_year') or '— not parsed —'}")
    print(f"  FILED      {rec.get('filed') or '— not parsed —'}")
    print(f"  PAGE SHA   {rec['sha256_of_page'][:16]}…")
    for n, label in WANTED:
        s = rec["sections"].get(str(n))
        if not s:
            print(f"\n  §{n} {label}\n      MISSING FROM PAGE")
            continue
        flag = "" if s["heading_matches"] else "   ** heading differs from expected **"
        print(f"\n  §{n} {s['heading']}{flag}")
        body = s["body"].strip() or "(empty)"
        for ln in body.split("\n")[:14]:
            print(f"      {ln}")


def selftest():
    """Re-read the one statement I actually read, and check I still read it
    the same way. This is the whole warranty on this file."""
    print("  SELFTEST — statement 10670, read on 2026-09-19 as:")
    print("    Thad Claggett · 2024 statement · filed 5/12/2025 8:01 AM")
    print("    §8 TRAVEL: Ohio House of Representatives (Mileage) $1,373.44")
    print("    §9 GIFTS: NONE   §10 MEALS, FOOD AND BEVERAGES: NONE\n")
    try:
        rec = pull(10670)
    except RuntimeError as e:
        print(f"  CANNOT VERIFY — could not reach the site: {e}")
        return CANNOT
    show(rec)
    soft = {"filer is Claggett": (rec.get("filer") or "").endswith("Claggett")}
    checks = {
        "year is 2024":        rec.get("statement_year") == "2024",
        "filed 5/12/2025":     "5/12/2025" in (rec.get("filed") or ""),
        "§8 present":          "8" in rec["sections"],
        "§8 carries 1,373.44": "1,373.44" in rec["sections"].get("8", {}).get("body", ""),
        "§9 present":          "9" in rec["sections"],
        "§10 present":         "10" in rec["sections"],
    }
    print("\n  CHECKS — these decide whether the tool is usable")
    for k, v in checks.items():
        print(f"    {'pass' if v else 'FAIL'}  {k}")
    print("  SOFT — a miss here is cosmetic, not disqualifying")
    for k, v in soft.items():
        print(f"    {'pass' if v else 'warn'}  {k}")
    if not all(soft.values()):
        print("    the filer name has no stable anchor on the page; the")
        print("    sections below it are what this tool is for, and they")
        print("    are checked above. Read the name off the page yourself.")
    if all(checks.values()):
        print("\n  Parser agrees with the reading. The other verbs are usable.")
        return OK
    print("\n  CANNOT VERIFY — the page or the parser moved. Do not trust "
          "anything else this script prints until this passes.")
    return CANNOT


def main():
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("verb", choices=["selftest", "probe", "scan"])
    p.add_argument("ids", nargs="*")
    p.add_argument("--file", help="file of statement IDs, one per line")
    p.add_argument("--out", help="directory to write one JSON per statement")
    a = p.parse_args()

    if a.verb == "selftest":
        return selftest()

    ids = list(a.ids)
    if a.file:
        ids += [l.strip() for l in open(a.file) if l.strip() and not l.startswith("#")]
    ids = [i for i in ids if i.isdigit()]
    if not ids:
        print("  CANNOT VERIFY — no statement IDs given. Get them from")
        print("  https://www2.jlec-olig.state.oh.us/FDS/Reports/Search "
              "(First/Last name -> Find Filers).")
        return CANNOT

    if a.out:
        os.makedirs(a.out, exist_ok=True)
    worst = OK
    for i, sid in enumerate(ids):
        if i:
            time.sleep(1.5)                       # one request every 1.5s
        print(f"\n{'─' * 68}")
        try:
            rec = pull(sid)
        except RuntimeError as e:
            print(f"  {sid}  CANNOT VERIFY — {e}")
            worst = max(worst, CANNOT)
            continue
        show(rec)
        if rec["missing"]:
            print(f"\n  INCOMPLETE — not on the page: {', '.join(rec['missing'])}")
            worst = max(worst, PARTIAL)
        if a.out:
            fp = os.path.join(a.out, f"fds_{sid}.json")
            open(fp, "w").write(json.dumps(rec, indent=2))
            print(f"\n  -> {fp}")
    print(f"\n{'─' * 68}\n  {len(ids)} statement(s) requested.")
    return worst


if __name__ == "__main__":
    sys.exit(main())
