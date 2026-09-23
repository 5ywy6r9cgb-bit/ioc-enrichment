#!/usr/bin/env python3
"""
obligations.py — who is required to file what, with whom, under what law.

THE IDEA
  Every register this desk searches exists because a statute obliges somebody
  to file. Reverse that and it becomes a research instrument: given an actor,
  what MUST already exist? A missing filing is then not a dead end — it is
  either a document you have not found or an obligation somebody did not meet,
  and those are different findings that look identical from a search box.

  This is the "who are their obligations" layer. It answers three questions
  no connector can:
     what should exist for this actor
     who holds it
     what the filing is required to contain

WHAT IT IS NOT
  Not legal advice, and not a compliance determination. An obligation that
  appears unmet is a QUESTION for the filer and the regulator, never a
  finding. Thresholds and exemptions are real and this file does not model
  them. Read the cited statute before you write a sentence about it.

USAGE
  python3 obligations.py actors                     # every actor type
  python3 obligations.py who "foreign agent"        # one actor's duties
  python3 obligations.py checklist "nonprofit" "state lobbying employer"
  python3 obligations.py gaps CASE.json             # what is missing for a case
  python3 obligations.py --json actors

EXIT  0 · 4 unknown actor / unreadable case
"""
import argparse, json, sys
from pathlib import Path

OK, CANNOT = 0, 4

# Citations verified 2026-09-17 against the DOJ NSD FARA FAQ and the JLEC
# Ohio Lobbying Handbook (issued October 2025). Entries marked VERIFY were not
# confirmed against primary text in that pass and must be checked before use.
REGISTER = {
  "foreign agent": {
    "law": "Foreign Agents Registration Act, 22 U.S.C. 611 et seq.; 28 C.F.R. pt. 5",
    "holder": "DOJ National Security Division, FARA Unit",
    "where": "efile.fara.gov  ·  justice.gov/nsd-fara",
    "duties": [
      ("Initial registration", "Within 10 days of agreeing to act as an agent, "
       "and before acting", "22 U.S.C. 612(a)"),
      ("Supplemental statement", "Every 6 months, due 30 days after the period "
       "ends", "22 U.S.C. 612(b); 28 C.F.R. 5.203"),
      ("Informational materials", "Filed within 48 hours of transmittal",
       "22 U.S.C. 614(a)"),
      ("Conspicuous statement", "Material must say it is distributed on behalf "
       "of the named foreign principal", "22 U.S.C. 614(b)"),
    ],
    "contains": ["foreign principal identity", "the agreement itself",
                 "receipts and disbursements", "political activity described",
                 "the materials distributed"],
    "asks": ["Who is the foreign principal, and is it a government?",
             "Does the registration date precede the activity?",
             "Are supplementals continuous, or is there a gap?"],
  },
  "federal lobbyist": {
    "law": "Lobbying Disclosure Act, 2 U.S.C. 1601 et seq.",
    "holder": "Secretary of the Senate; Clerk of the House",
    "where": "lda.senate.gov  ·  disclosurespreview.house.gov",
    "duties": [
      ("LD-1 registration", "Within 45 days of being retained or first contact",
       "2 U.S.C. 1603  [VERIFY]"),
      ("LD-2 quarterly activity", "20 days after each quarter ends",
       "2 U.S.C. 1604  [VERIFY]"),
      ("LD-203 contributions", "Semiannual, covering certain political "
       "contributions", "2 U.S.C. 1604(d)  [VERIFY]"),
    ],
    "contains": ["client", "registrant", "income or expenses",
                 "specific lobbying issues", "chambers and agencies contacted"],
    "asks": ["Does the issue text name a bill, or only a subject area?",
             "Which chamber and which agency — the LD-2 says.",
             "Do LD-203 contributions line up with FEC filings?"],
  },
  "ohio legislative agent": {
    "law": "R.C. 101.70-101.79; Ohio Adm.Code 101-9",
    "holder": "Joint Legislative Ethics Committee (JLEC) / OLIG",
    "where": "OLAC — Ohio Lobbying Activity Center",
    "duties": [
      ("Engagement registration", "Within 10 days of the date of engagement",
       "R.C. 101.72"),
      ("Expenditure statement — period 1", "Jan 1 to Apr 30, due May 31",
       "R.C. 101.73"),
      ("Expenditure statement — period 2", "May 1 to Aug 31, due Sep 30",
       "R.C. 101.73"),
      ("Expenditure statement — period 3", "Sep 1 to Dec 31, due Jan 31",
       "R.C. 101.73"),
    ],
    "contains": ["legislative agent and employer",
                 "gifts over $25, itemized",
                 "meals and beverages over $50 aggregate per recipient, itemized",
                 "a Legislation field, per expenditure",
                 "a section-level statement of the employer's activity"],
    "asks": ["The registration threshold is 5% of compensated time — who fell "
             "below it and therefore never appears?",
             "Was the per-row Legislation field used, or only the section-level "
             "one?",
             "Non-itemized meals under $50 are reported as a total — what does "
             "that total conceal?"],
  },
  "ohio executive agency lobbyist": {
    "law": "R.C. 121.60-121.69; Ohio Adm.Code 101-11",
    "holder": "Joint Legislative Ethics Committee / OLIG",
    "where": "OLAC — executive agency expenditure search",
    "duties": [
      ("Registration", "Threshold is 25% of compensated time, not the 5% that "
       "applies to legislative agents", "R.C. 121.60  [VERIFY exact %]"),
      ("Expenditure statements", "Same three-period calendar as legislative",
       "R.C. 121.63  [VERIFY]"),
    ],
    "contains": ["executive agency decision targeted", "expenditures on "
                 "executive officials"],
    "asks": ["Most desks only ever search the LEGISLATIVE register. Who "
             "appears here and nowhere else?"],
  },
  "ohio legislator": {
    "law": "R.C. 102.02 financial disclosure",
    "holder": "JLEC / Office of the Legislative Inspector General",
    "where": "jlec-olig.state.oh.us — statements are public and posted",
    "duties": [
      ("Financial disclosure statement", "Filed by May 15 for the prior "
       "calendar year", "R.C. 102.02"),
      ("Section 8 — travel", "Travel and reimbursements tied to official "
       "duties, not in a state vehicle", "FDS form, Section 8"),
      ("Section 9 — gifts", "$75 aggregate; $25 if from a legislative agent",
       "FDS form, Section 9"),
      ("Section 10 — meals and beverages", "Received from employers of "
       "lobbyists in connection with official duties", "FDS form, Section 10"),
    ],
    "contains": ["sources of income", "gifts", "travel", "meals",
                 "creditors and debtors", "fiduciary positions"],
    "asks": ["THE CROSS-CHECK: the payer files an OLAC expenditure statement "
             "and the recipient files this. Two mandatory records of one "
             "transaction. Do they agree?",
             "A match is a story about a system working. A mismatch is a "
             "different story. Both are publishable."],
  },
  "nonprofit": {
    "law": "26 U.S.C. 6033; Form 990 and schedules",
    "holder": "IRS; mirrored publicly",
    "where": "projects.propublica.org/nonprofits  ·  apps.irs.gov/app/eos",
    "duties": [
      ("Form 990 annual return", "Due the 15th day of the 5th month after the "
       "fiscal year ends", "26 U.S.C. 6033  [VERIFY]"),
      ("Schedule C", "Political campaign and LOBBYING activities, including "
       "any 501(h) election", "Form 990 Sch. C"),
      ("Schedule F", "Activities OUTSIDE the United States, by region",
       "Form 990 Sch. F"),
      ("Schedule I", "Grants made to other organizations", "Form 990 Sch. I"),
      ("Part VII", "Officers, directors, key employees and compensation",
       "Form 990 Part VII"),
    ],
    "contains": ["revenue and expenses", "officers and pay", "lobbying spend",
                 "foreign activity by region", "grants out"],
    "asks": ["Schedule C is a FEDERAL disclosure of lobbying. Put it beside "
             "the state register and see whether they describe the same year "
             "the same way.",
             "Schedule F names regions, not partners — what is missing is as "
             "informative as what is there."],
  },
  "federal contractor": {
    "law": "FAR; 31 U.S.C. 6101 et seq. (USAspending reporting)",
    "holder": "Awarding agency; SAM.gov; USAspending",
    "where": "usaspending.gov  ·  sam.gov  ·  fpds.gov",
    "duties": [
      ("Entity registration", "Active SAM registration before award",
       "FAR 4.1102  [VERIFY]"),
      ("Award reporting", "The AGENCY reports the award; the contractor does "
       "not file it", "FFATA"),
    ],
    "contains": ["instrument family (contract / grant / direct payment / loan)",
                 "obligated-plus-potential value, NOT cash paid",
                 "place of performance", "the awarding office"],
    "asks": ["Which instrument family? Filtering to A/B/C/D hides grants and "
             "direct payments entirely.",
             "Subsidiaries file under their own names — whose name is on it?"],
  },
  "political committee": {
    "law": "52 U.S.C. 30101 et seq.",
    "holder": "Federal Election Commission",
    "where": "fec.gov  ·  api.open.fec.gov",
    "duties": [
      ("Statement of organization", "Within 10 days of becoming a committee",
       "52 U.S.C. 30103  [VERIFY]"),
      ("Periodic reports", "Quarterly or monthly, plus pre- and post-election",
       "52 U.S.C. 30104  [VERIFY]"),
    ],
    "contains": ["Schedule A receipts — money in", "Schedule B disbursements",
                 "treasurer", "committee address"],
    "asks": ["Shared treasurer or shared address across committees is a "
             "documented structural link, not an inference."],
  },
}

ALIASES = {
  "fara": "foreign agent", "foreign principal": "foreign agent",
  "lobbyist": "federal lobbyist", "lda": "federal lobbyist",
  "state lobbyist": "ohio legislative agent",
  "state lobbying employer": "ohio legislative agent",
  "olac": "ohio legislative agent", "jlec": "ohio legislative agent",
  "legislator": "ohio legislator", "member": "ohio legislator",
  "501c3": "nonprofit", "charity": "nonprofit", "foundation": "nonprofit",
  "contractor": "federal contractor", "vendor": "federal contractor",
  "pac": "political committee", "committee": "political committee",
  "executive lobbyist": "ohio executive agency lobbyist",
}


def resolve(name):
    k = name.strip().lower()
    return REGISTER.get(k) and k or ALIASES.get(k)


def show(key):
    o = REGISTER[key]
    print(f"\n  ══ {key.upper()} ══")
    print(f"  law      {o['law']}")
    print(f"  holder   {o['holder']}")
    print(f"  where    {o['where']}")
    print("\n  MUST FILE")
    for what, when, cite in o["duties"]:
        print(f"    {what}")
        print(f"      {when}")
        print(f"      [{cite}]")
    print("\n  THE FILING CONTAINS")
    for c in o["contains"]:
        print(f"    · {c}")
    print("\n  WHAT TO ASK OF IT")
    for q in o["asks"]:
        print(f"    ? {q}")


def main():
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--json", action="store_true")
    s = p.add_subparsers(dest="v", required=True)
    s.add_parser("actors")
    w = s.add_parser("who");       w.add_argument("actor")
    c = s.add_parser("checklist"); c.add_argument("actors", nargs="+")
    g = s.add_parser("gaps");      g.add_argument("case")
    a = p.parse_args()

    if a.json:
        print(json.dumps(REGISTER, indent=2)); return OK

    if a.v == "actors":
        print(f"  {len(REGISTER)} actor type(s). Each one is a set of documents")
        print("  that MUST exist. Absence is a question, not an answer.\n")
        for k, o in REGISTER.items():
            print(f"    {k:<32} {o['holder']}")
        print("\n  aliases: " + ", ".join(sorted(ALIASES)))
        return OK

    if a.v == "who":
        k = resolve(a.actor)
        if not k:
            print(f"  CANNOT VERIFY — unknown actor {a.actor!r}. "
                  f"Try: obligations.py actors"); return CANNOT
        show(k); return OK

    if a.v == "checklist":
        keys = []
        for name in a.actors:
            k = resolve(name)
            if not k:
                print(f"  CANNOT VERIFY — unknown actor {name!r}"); return CANNOT
            keys.append(k)
        print(f"  DOCUMENTS THAT MUST EXIST — {len(keys)} actor role(s)\n")
        i = 0
        for k in keys:
            for what, when, cite in REGISTER[k]["duties"]:
                i += 1
                print(f"  [ ] {i:>2}. {what}  ({k})")
                print(f"          {when}   [{cite}]")
                print(f"          holder: {REGISTER[k]['holder']}")
        print("\n  Each unchecked box is a records request or a portal search,")
        print("  not a conclusion. An unmet obligation is a question for the")
        print("  filer and the regulator before it is ever a story.")
        return OK

    if a.v == "gaps":
        try:
            case = json.loads(Path(a.case).read_text())
        except Exception as e:
            print(f"  CANNOT VERIFY — {a.case}: {type(e).__name__}"); return CANNOT
        blob = json.dumps(case).lower()
        hits = [k for k in REGISTER
                if any(t in blob for t in k.split()) or
                   any(al in blob for al, v in ALIASES.items() if v == k)]
        print(f"  {a.case}")
        if not hits:
            print("\n  No actor role inferred from this case file. Name the "
                  "roles explicitly:\n    obligations.py checklist "
                  "\"nonprofit\" \"ohio legislative agent\"")
            return OK
        print(f"  roles suggested by the case text: {', '.join(hits)}")
        print("  (a keyword match, not a determination — confirm each one)")
        for k in hits:
            show(k)
        return OK


if __name__ == "__main__":
    sys.exit(main())
