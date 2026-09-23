#!/usr/bin/env python3
"""
follow.py — bill → who acted → who funded them → who lobbied it.

WHAT IT DOES
  Takes a bill. Pulls the sponsor, the cosponsors and the action timeline from
  the Library of Congress API. Then joins every one of those members against
  the LOCAL FEC library to show which committees paid their campaigns, and
  against the LOCAL FARA library to show whether any of them has ever filed as
  a foreign agent.

  Four registers, one chronology, no inference.

WHAT IT REFUSES TO DO
  It does not tell you why anyone voted the way they did. A contribution
  before a vote is a SEQUENCE. Sequence is not cause, it is not a quid pro
  quo, and the difference is the whole reason this tool prints dates instead
  of conclusions.

THE JOIN YOU MUST WATCH
  Congress.gov identifies members by bioguideId. The FEC identifies candidates
  by CAND_ID. Nothing links them. This tool matches on LAST NAME + FIRST NAME
  + STATE and labels every match with how it was made. A member with a common
  surname will collide. Check the district and the election year on any row
  before you use it.

SETUP
  Free key, one minute:  https://api.data.gov/signup/
  export CONGRESS_API_KEY=...........

USAGE
  python3 follow.py bill 118 hr 3076
  python3 follow.py bill 118 s 2861 --no-money
  python3 follow.py member "Royce, Edward"
  python3 follow.py lobby 118 hr 3076        # the LDA search to run yourself

EXIT  0 clean · 3 matches that need a human · 4 cannot verify
"""
import argparse, json, os, re, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import hunt

OK, REVIEW, CANNOT = 0, 3, 4
API = "https://api.congress.gov/v3"
UA = "TSR-desk/1.0 (public records research)"
KEY = os.environ.get("CONGRESS_API_KEY", "")

BILLTYPES = {"hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"}


def get(path, **params):
    if not KEY:
        raise RuntimeError("no CONGRESS_API_KEY")
    params.update(api_key=KEY, format="json")
    url = f"{API}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5 * (attempt + 1)); continue
            raise RuntimeError(f"HTTP {e.code} on {path}")
        except (urllib.error.URLError, OSError) as e:
            if attempt == 2:
                raise RuntimeError(f"{type(e).__name__}: {e}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("gave up after 3 tries")


# ── the local joins ───────────────────────────────────────────────────────
def db():
    if not hunt.DB.exists():
        return None
    return sqlite3.connect(hunt.DB)


def fec_candidates_named(last, first, state=None):
    """-> [(cand_id, name, party, year, office, st, district)] with the match
    method recorded. FEC writes candidates as 'LAST, FIRST MIDDLE'."""
    have = hunt.load(only="fec_candidates")
    if "fec_candidates" not in have:
        return [], "fec_candidates not in library"
    d = have["fec_candidates"]
    h = {c: i for i, c in enumerate(d["head"])}
    out = []
    lk, fk = hunt.norm(last), hunt.norm(first)
    for row in d["rows"]:
        nm = row[h["CAND_NAME"]] if h.get("CAND_NAME", 99) < len(row) else ""
        n = hunt.norm(nm)
        if not n or lk not in n:
            continue
        # require the first name too — surname alone is not a match
        if fk and fk.split()[0] not in n:
            continue
        st = row[h["CAND_OFFICE_ST"]] if h.get("CAND_OFFICE_ST", 99) < len(row) else ""
        if state and st and st.upper() != state.upper():
            continue
        out.append((row[h["CAND_ID"]], nm,
                    row[h.get("CAND_PTY_AFFILIATION", 2)] if len(row) > 2 else "",
                    row[h.get("CAND_ELECTION_YR", 3)] if len(row) > 3 else "",
                    row[h.get("CAND_OFFICE", 5)] if len(row) > 5 else "",
                    st,
                    row[h.get("CAND_OFFICE_DISTRICT", 6)] if len(row) > 6 else ""))
    return out, None


def pac_money_to(cand_ids, cap=25):
    """Committee-to-candidate rows from itpas2, for these CAND_IDs."""
    have = hunt.load(only="fec_pac_to_cand")
    if "fec_pac_to_cand" not in have:
        return [], 0
    d = have["fec_pac_to_cand"]
    h = {c: i for i, c in enumerate(d["head"])}
    ci, ni = h.get("CAND_ID"), h.get("NAME")
    ai, ti = h.get("TRANSACTION_AMT"), h.get("TRANSACTION_DT")
    if ci is None:
        return [], 0
    agg, n = defaultdict(lambda: [0, 0, ""]), 0
    want = set(cand_ids)
    for row in d["rows"]:
        if ci >= len(row) or row[ci] not in want:
            continue
        nm = row[ni] if ni is not None and ni < len(row) else "?"
        try:
            amt = int(row[ai]) if ai is not None and ai < len(row) and row[ai] else 0
        except ValueError:
            amt = 0
        dt = row[ti] if ti is not None and ti < len(row) else ""
        rec = agg[nm]
        rec[0] += amt; rec[1] += 1
        if dt and (not rec[2] or dt > rec[2]):
            rec[2] = dt
        n += 1
    rows = sorted(((k, v[0], v[1], v[2]) for k, v in agg.items()),
                  key=lambda r: -r[1])
    return rows[:cap], n


def fara_named(last, first):
    """Has this person ever filed a FARA short form?

    NOTE ON THE JOIN: the short-form file keeps the last name and the first
    name in SEPARATE COLUMNS ON THE SAME LINE. An earlier version of this
    looked for both names inside one value and therefore matched nothing,
    which read exactly like "this person has never filed" — the worst kind of
    wrong answer this desk can produce. It now matches per LINE."""
    con = db()
    if not con:
        return []
    lk = hunt.norm(last)
    fk = hunt.norm(first).split()[0] if first else ""
    # lines whose value contains the surname
    cand = defaultdict(list)
    for corpus, ln, col, raw in con.execute(
            "SELECT corpus, lineno, col, raw FROM ent "
            "WHERE corpus LIKE 'fara%' AND norm LIKE ? LIMIT 4000", (f"%{lk}%",)):
        cand[(corpus, ln)].append((col, raw))
    out = []
    for (corpus, ln), cols in cand.items():
        vals = {c: v for c, v in cols}
        # pull every value on that line so the first name can be checked too
        line_vals = dict(cols)
        for c2, r2 in con.execute(
                "SELECT col, raw FROM ent WHERE corpus=? AND lineno=?",
                (corpus, ln)):
            line_vals[c2] = r2
        blob = hunt.norm(" ".join(line_vals.values()))
        if lk in blob and (not fk or fk in blob):
            who = " ".join(v for k, v in line_vals.items()
                           if "name" in k.lower())[:64]
            out.append((corpus, ln, "line", who))
    con.close()
    return sorted(out)[:20]


# ── verbs ─────────────────────────────────────────────────────────────────
def show_member_money(name, state, no_money):
    m = re.match(r"\s*([^,]+),\s*(.+)", name)
    last, first = (m.group(1), m.group(2)) if m else (name.split()[-1],
                                                      " ".join(name.split()[:-1]))
    cands, err = fec_candidates_named(last, first, state)
    if err:
        print(f"      {err}")
        return
    if not cands:
        print(f"      FEC: no candidate record matched "
              f"'{last}, {first}'{' / ' + state if state else ''}")
        return
    print(f"      FEC candidate record(s) — matched on LAST+FIRST"
          f"{'+STATE' if state else ' ONLY (no state filter)'}:")
    for cid, nm, pty, yr, off, st, dist in cands[:6]:
        print(f"        {cid}  {nm[:38]:<38} {pty:<4} {off}{st}{dist} {yr}")
    if len(cands) > 6:
        print(f"        … {len(cands)-6} more — a surname collision is likely")
    if no_money:
        return
    rows, total = pac_money_to([c[0] for c in cands])
    if not rows:
        print(f"      no committee-to-candidate rows in this snapshot")
        return
    print(f"      COMMITTEE MONEY — {total:,} row(s), top payers:")
    for nm, amt, cnt, last_dt in rows[:10]:
        print(f"        ${amt:>10,}  {cnt:>3} txn  {nm[:44]:<44} last {last_dt}")


def v_bill(congress, btype, num, no_money, cap):
    btype = btype.lower()
    if btype not in BILLTYPES:
        print(f"  CANNOT — bill type must be one of {', '.join(sorted(BILLTYPES))}")
        return CANNOT
    try:
        bill = get(f"bill/{congress}/{btype}/{num}")["bill"]
    except RuntimeError as e:
        print(f"  CANNOT VERIFY — {e}")
        if "no CONGRESS_API_KEY" in str(e):
            print(f"\n  Free key, one minute: https://api.data.gov/signup/")
            print(f"  export CONGRESS_API_KEY=............")
        return CANNOT

    print(f"  {btype.upper()} {num} — {congress}th Congress")
    print(f"  {bill.get('title','(no title)')[:92]}\n")
    print(f"  INTRODUCED   {bill.get('introducedDate','?')}")
    pol = bill.get("policyArea", {}).get("name")
    if pol:
        print(f"  POLICY AREA  {pol}")
    la = bill.get("latestAction", {})
    if la:
        print(f"  LATEST       {la.get('actionDate','')}  {la.get('text','')[:70]}")
    print(f"  ON THE WEB   https://www.congress.gov/bill/{congress}th-congress/"
          f"{'house-bill' if btype=='hr' else btype}/{num}")

    sponsors = bill.get("sponsors", [])
    print(f"\n  ── SPONSOR ──")
    for s in sponsors:
        print(f"    {s.get('fullName','?')}")

    try:
        cos = get(f"bill/{congress}/{btype}/{num}/cosponsors",
                  limit=250).get("cosponsors", [])
    except RuntimeError as e:
        cos = []
        print(f"    (cosponsors unavailable: {e})")
    print(f"\n  ── COSPONSORS ── {len(cos)}")
    for c in cos[:cap]:
        print(f"    {c.get('fullName','?')[:58]:<58} "
              f"{c.get('sponsorshipDate','')}")
    if len(cos) > cap:
        print(f"    … {len(cos)-cap} more (--cap to raise)")

    try:
        acts = get(f"bill/{congress}/{btype}/{num}/actions",
                   limit=250).get("actions", [])
    except RuntimeError:
        acts = []
    if acts:
        print(f"\n  ── ACTION TIMELINE ── {len(acts)} action(s)")
        for a in acts[:cap]:
            print(f"    {a.get('actionDate','')}  {a.get('text','')[:76]}")
        if len(acts) > cap:
            print(f"    … {len(acts)-cap} more")

    # ── the local joins ───────────────────────────────────────────────
    people = [(s.get("lastName", ""), s.get("firstName", ""),
               s.get("state", ""), s.get("fullName", "")) for s in sponsors]
    print(f"\n  ══ FOLLOW THE MONEY — sponsor(s) only ══")
    print(f"  Cosponsors are not joined by default: {len(cos)} name matches "
          f"would produce more collisions than leads.\n")
    for last, first, st, full in people:
        print(f"    {full}")
        show_member_money(f"{last}, {first}", st, no_money)
        fara = fara_named(last, first)
        if fara:
            print(f"      FARA: {len(fara)} row(s) name someone matching this "
                  f"surname —")
            for corpus, ln, col, raw in fara[:4]:
                print(f"        {corpus} line {ln} [{col}] {raw[:52]}")
            print(f"      LEVEL 0 until you open the short form and confirm "
                  f"it is the same person.")
        print()

    print(f"  ══ WHAT THIS DOES NOT ESTABLISH ══")
    print(f"    · that any contribution influenced any action on this bill")
    print(f"    · that the sequence of dates above is causal in any direction")
    print(f"    · that an FEC or FARA name match is the same human being")
    print(f"    A contribution before a vote is a SEQUENCE. Publishing it as a")
    print(f"    reason is the single most common way this kind of work is")
    print(f"    discredited, and it is discredited permanently.")
    print(f"\n  ══ NEXT ══")
    print(f"    python3 follow.py lobby {congress} {btype} {num}")
    print(f"    sentinel-hunt hunt \"<any committee name above>\"")
    return REVIEW if people else OK


def v_member(name, state, no_money):
    print(f"  MEMBER  {name}\n")
    show_member_money(name, state, no_money)
    m = re.match(r"\s*([^,]+),\s*(.+)", name)
    last, first = (m.group(1), m.group(2)) if m else (name.split()[-1],
                                                      " ".join(name.split()[:-1]))
    fara = fara_named(last, first)
    print()
    if fara:
        print(f"    FARA — {len(fara)} row(s) matching this surname:")
        for corpus, ln, col, raw in fara[:10]:
            print(f"      {corpus} line {ln} [{col}] {raw[:56]}")
        print(f"    LEVEL 0. Open the short form and confirm the person.")
    else:
        print(f"    FARA — no row in this snapshot matches that name.")
    return OK


def v_lobby(congress, btype, num):
    """The LDA search is a browser step. This prints exactly what to run and
    what to look for, rather than pretending to an endpoint I have not
    verified against live responses."""
    bill = f"{btype.upper()}.{num}"
    print(f"  LOBBYING ON {bill} — {congress}th Congress\n")
    print(f"  The Senate LDA database is the register. Its API needs a key and")
    print(f"  its parameters change between versions, so this prints the search")
    print(f"  rather than guessing at an endpoint.\n")
    print(f"  1. SEARCH THE FILINGS")
    print(f"     https://lda.senate.gov/filings/public/filing/search/")
    print(f"     Filing year: the year(s) the bill was live")
    print(f"     Specific issue text: {bill}")
    print(f"     Also try: '{btype.upper()} {num}' and the bill's short title —")
    print(f"     filers write bill numbers inconsistently and a single spelling")
    print(f"     will miss most of them.\n")
    print(f"  2. THE API, IF YOU WANT IT AUTOMATED")
    print(f"     Register:  https://lda.gov/api/register/")
    print(f"     Docs:      https://lda.gov/api/redoc/v1/")
    print(f"     Read the parameter list from redoc and DRY-RUN one query")
    print(f"     before you build anything on it.\n")
    print(f"  3. WHAT TO PULL FROM EACH FILING")
    print(f"     · registrant and client")
    print(f"     · the specific issue text naming the bill")
    print(f"     · the lobbyists listed, by name")
    print(f"     · the houses/agencies contacted")
    print(f"     · the reported income or expenses for the period\n")
    print(f"  4. THEN BRING THE NAMES BACK HERE")
    print(f"     sentinel-hunt hunt \"<registrant>\"")
    print(f"     sentinel-hunt chain \"<registrant>\"")
    print(f"     python3 follow.py member \"<lobbyist last, first>\"")
    print(f"     A lobbyist who is also a former member is the revolving door,")
    print(f"     documented on both ends.\n")
    print(f"  WHAT KILLS A LOBBYING FINDING")
    print(f"     LDA reports are QUARTERLY and cover an issue area, not a")
    print(f"     meeting. A filing naming this bill establishes that the")
    print(f"     registrant reported lobbying ON it in that quarter. It does")
    print(f"     not establish who was contacted, when, or what was said.")
    return OK


def main():
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="verb", required=True)
    b = sub.add_parser("bill")
    b.add_argument("congress"); b.add_argument("type"); b.add_argument("number")
    b.add_argument("--no-money", action="store_true")
    b.add_argument("--cap", type=int, default=20)
    m = sub.add_parser("member")
    m.add_argument("name"); m.add_argument("--state", default=None)
    m.add_argument("--no-money", action="store_true")
    l = sub.add_parser("lobby")
    l.add_argument("congress"); l.add_argument("type"); l.add_argument("number")
    a = p.parse_args()
    if a.verb == "bill":
        return v_bill(a.congress, a.type, a.number, a.no_money, a.cap)
    if a.verb == "member":
        return v_member(a.name, a.state, a.no_money)
    if a.verb == "lobby":
        return v_lobby(a.congress, a.type, a.number)


if __name__ == "__main__":
    sys.exit(main())
