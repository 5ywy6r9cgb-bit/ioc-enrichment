#!/usr/bin/env python3
"""
hunt.py — the collision engine. Five verbs, one idea.

THE IDEA
  Searching one register at a time finds what that register was built to
  show you. The things nobody meant to publish show up where two registers
  that were never meant to be read together happen to name the same party.

  So: pull whole corpora down once, normalise them, and look for the same
  entity standing in two places it has no obvious reason to stand in.

  A collision is a LEAD. It is not a finding, it is not a relationship, and
  it is certainly not control. Every row this prints carries the level it
  earned and the file and line it came from, and `why` will read them back.

THE LEVEL LADDER  (never skip a rung)
  0  coincidence          same string, nothing more
  1  association          named together in one document
  2  recurring            named together in 3+ independent documents
  3  financial            a disclosed payment exists
  4  contractual          a filed agreement exists
  5  direction            a document shows one instructing the other
  6  authority            a document shows one with authority over the other
  Only 5 and 6 are anywhere near the word "control". This file will never
  print 5 or 6 on its own — those come from reading a document, not from a
  join, and the code says so where it would be tempting to guess.

VERBS
  build                      what the library has, what it is missing, how to get it
  hunt   "<name>"            every corpus that names it + the collisions
  why    <collision id>      provenance: file, line, field, level, what it is NOT
  falsify "<claim>"          the searches that would kill the claim
  expected <kind> "<subj>"   what record SHOULD exist, and the narrowest request for it
  chain  "<name>"            walk it: principal -> registrant -> the people -> elsewhere
  country "<country>"        every foreign principal from one country, and who files for it
  cols                       every corpus's real column headers
  index [--rebuild]          build the query index. once per download.
  snapshot [--json]          the manifest: sha256 + row count per corpus
  conflicts                  rows where the principal's NAME and the country COLUMN disagree

THE ANOMALY SHELF — a separate folder, on purpose
  flag  "<title>" --from-last   open a record from the last hunt
  check <id> --to OPEN          the gate. fail-closed. no override.
  score <id> duty=2 scale=3 …   severity, COMPUTED. drama scores zero.
  docket [--json]               everything on the shelf
  brief <id>                    read one

EXIT  0 clean · 3 collisions found that need a human · 4 library not built
"""
import argparse, csv, hashlib, json, os, re, sqlite3, sys, time, unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Bumped whenever a verb is added or a gate changes. `build` prints it, so
# "which version is actually installed" is never a guess again.
VERSION = "hunt/0.9.0  (indexed · multi-file corpora · manifest)"

OK, REVIEW, CANNOT = 0, 3, 4
LIB = Path(os.environ.get("HUNT_LIB", os.path.expanduser("~/sentinel/library")))

# ── the corpora, and the ONE question each answers ────────────────────────
# Every URL here was checked on 2026-09-20. If one 404s, say so and stop;
# do not substitute a mirror.
CORPORA = {
    "fara_registrants": dict(
        q="who is registered as a foreign agent, and since when",
        url="https://efile.fara.gov/bulk/zip/FARA_All_Registrants.csv.zip",
        level=4),
    "fara_principals": dict(
        q="which foreign government or party is being represented",
        url="https://efile.fara.gov/bulk/zip/FARA_All_ForeignPrincipals.csv.zip",
        level=4),
    "fara_shortforms": dict(
        q="which INDIVIDUAL people did the work — the names that never make news",
        url="https://efile.fara.gov/bulk/zip/FARA_All_ShortForms.csv.zip",
        level=4),
    "fara_docs": dict(
        q="the PDF of every filing, by URL — the primary documents themselves",
        url="https://efile.fara.gov/bulk/zip/FARA_All_RegistrantDocs.csv.zip",
        level=4),
    "fec_committees": dict(
        q="every registered committee and who its treasurer is",
        url="https://www.fec.gov/files/bulk-downloads/2024/cm24.zip",
        level=1),
    "fec_candidates": dict(
        q="every federal candidate and their committee",
        url="https://www.fec.gov/files/bulk-downloads/2024/cn24.zip",
        level=1),
    "fec_pac_to_cand": dict(
        q="committee-to-candidate money — who paid whom",
        url="https://www.fec.gov/files/bulk-downloads/2024/pas224.zip",
        level=3),
    "fec_expenditures": dict(
        q="what committees SPENT money on — the vendor layer",
        url="https://www.fec.gov/files/bulk-downloads/2024/oppexp24.zip",
        level=3),
}

# FEC bulk files ship with NO header row and pipe delimiters, and unzip to
# names that say nothing. Guessing "is row 0 a header?" from its contents
# gets this wrong often enough to matter, so the filename decides. Column
# names below are from the FEC's own published layouts.
HEADERLESS = {
    "cm":     ("fec_committees",   ["CMTE_ID", "CMTE_NM", "TRES_NM", "CMTE_ST1",
                                    "CMTE_ST2", "CMTE_CITY", "CMTE_ST", "CMTE_ZIP",
                                    "CMTE_DSGN", "CMTE_TP", "CMTE_PTY_AFFILIATION",
                                    "CMTE_FILING_FREQ", "ORG_TP", "CONNECTED_ORG_NM",
                                    "CAND_ID"]),
    "cn":     ("fec_candidates",   ["CAND_ID", "CAND_NAME", "CAND_PTY_AFFILIATION",
                                    "CAND_ELECTION_YR", "CAND_OFFICE_ST",
                                    "CAND_OFFICE", "CAND_OFFICE_DISTRICT",
                                    "CAND_ICI", "CAND_STATUS", "CAND_PCC",
                                    "CAND_ST1", "CAND_ST2", "CAND_CITY",
                                    "CAND_ST", "CAND_ZIP"]),
    "pas2":   ("fec_pac_to_cand",  ["CMTE_ID", "AMNDT_IND", "RPT_TP",
                                    "TRANSACTION_PGI", "IMAGE_NUM", "TRANSACTION_TP",
                                    "ENTITY_TP", "NAME", "CITY", "STATE", "ZIP_CODE",
                                    "EMPLOYER", "OCCUPATION", "TRANSACTION_DT",
                                    "TRANSACTION_AMT", "OTHER_ID", "CAND_ID",
                                    "TRAN_ID", "FILE_NUM", "MEMO_CD", "MEMO_TEXT",
                                    "SUB_ID"]),
    "oppexp": ("fec_expenditures", ["CMTE_ID", "AMNDT_IND", "RPT_YR", "RPT_TP",
                                    "IMAGE_NUM", "LINE_NUM", "FORM_TP_CD",
                                    "SCHED_TP_CD", "NAME", "CITY", "STATE",
                                    "ZIP_CODE", "TRANSACTION_DT",
                                    "TRANSACTION_AMT", "TRANSACTION_PGI",
                                    "PURPOSE", "CATEGORY", "CATEGORY_DESC",
                                    "MEMO_CD", "MEMO_TEXT", "ENTITY_TP",
                                    "SUB_ID", "FILE_NUM", "TRAN_ID", "BACK_REF_TRAN_ID"]),
    # The zip is named pas224 but it unzips to itpas2.txt, and oppexp24 to
    # oppexp.txt. The prefix has to match the UNZIPPED name, not the zip.
    "itpas2": ("fec_pac_to_cand",  ["CMTE_ID", "AMNDT_IND", "RPT_TP",
                                    "TRANSACTION_PGI", "IMAGE_NUM", "TRANSACTION_TP",
                                    "ENTITY_TP", "NAME", "CITY", "STATE", "ZIP_CODE",
                                    "EMPLOYER", "OCCUPATION", "TRANSACTION_DT",
                                    "TRANSACTION_AMT", "OTHER_ID", "CAND_ID",
                                    "TRAN_ID", "FILE_NUM", "MEMO_CD", "MEMO_TEXT",
                                    "SUB_ID"]),
    "itoth":  ("fec_cmte_to_cmte", ["CMTE_ID", "AMNDT_IND", "RPT_TP",
                                    "TRANSACTION_PGI", "IMAGE_NUM", "TRANSACTION_TP",
                                    "ENTITY_TP", "NAME", "CITY", "STATE", "ZIP_CODE",
                                    "EMPLOYER", "OCCUPATION", "TRANSACTION_DT",
                                    "TRANSACTION_AMT", "OTHER_ID", "TRAN_ID",
                                    "FILE_NUM", "MEMO_CD", "MEMO_TEXT", "SUB_ID"]),
    "itcont": ("fec_individuals",  ["CMTE_ID", "AMNDT_IND", "RPT_TP",
                                    "TRANSACTION_PGI", "IMAGE_NUM", "TRANSACTION_TP",
                                    "ENTITY_TP", "NAME", "CITY", "STATE", "ZIP_CODE",
                                    "EMPLOYER", "OCCUPATION", "TRANSACTION_DT",
                                    "TRANSACTION_AMT", "OTHER_ID", "TRAN_ID",
                                    "FILE_NUM", "MEMO_CD", "MEMO_TEXT", "SUB_ID"]),
    "indiv":  ("fec_individuals",  None),     # same layout as itcont
}
# FARA bulk files DO carry a header row; the filename still names the corpus.
NAMED = {
    "fara_all_registrants":      "fara_registrants",
    "fara_all_foreignprincipals": "fara_principals",
    "fara_all_shortforms":       "fara_shortforms",
    "fara_all_registrantdocs":   "fara_docs",
}

# Noise that makes two unrelated records look like the same party.
STOP = {"llc", "inc", "incorporated", "corp", "corporation", "co", "company",
        "ltd", "limited", "lp", "llp", "plc", "the", "and", "of", "group",
        "holdings", "partners", "associates", "pc", "pa", "trust", "fund"}


def norm(s):
    """Aggressive normalisation for MATCHING ONLY. The original string is
    always kept beside it — a normalised name is a key, never a fact."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    toks = [t for t in s.split() if t and t not in STOP]
    return " ".join(toks)


# Words that make a column a DATE or an IDENTIFIER no matter what else is in
# its name. "Foreign Principal Termination Date" contains "principal" and is
# not a name column; matching on it searched a date field for a government.
NOT_A_NAME = ("date", "year", "termination", "number", "zip", "phone",
              "amount", "_dt", "code", "country", "state", "city", "address")

def looks_like_name(col):
    c = col.lower()
    if any(k in c for k in NOT_A_NAME):
        return False
    return any(k in c for k in ("name", "registrant", "principal", "client",
                                "lobbyist", "committee", "candidate", "payee",
                                "recipient", "employer", "organization"))


def looks_like_date(col):
    c = col.lower()
    return any(k in c for k in ("date", "dt", "year", "period"))


def classify(path):
    """Filename -> (corpus key, published header or None if the file has one).

    The filename decides, not the contents. A contents heuristic gets FEC's
    headerless files wrong roughly whenever row 1 happens to look wordy,
    and a loader that silently eats its first data row or treats a header
    as data is worse than one that refuses to load."""
    stem = re.sub(r"[^a-z0-9]", "", path.stem.lower())
    for k, v in NAMED.items():
        if re.sub(r"[^a-z0-9]", "", k) in stem:
            return v, None                       # header row present in file
    for pre, (key, cols) in HEADERLESS.items():
        if stem.startswith(pre):
            if cols is None:                     # alias to another layout
                cols = HEADERLESS["itcont"][1]
            return key, cols
    return path.stem.lower(), None


def read_corpus(path, published_header):
    for enc in ("utf-8", "latin-1"):
        try:
            with open(path, newline="", encoding=enc, errors="strict") as f:
                sample = f.read(8192); f.seek(0)
                delim = "|" if sample.count("|") > sample.count(",") else ","
                rows = list(csv.reader(f, delimiter=delim))
            break
        except (UnicodeDecodeError, OSError):
            rows = None
    if not rows:
        return [], []
    if published_header is not None:
        n = max(len(r) for r in rows[:200])
        head = (published_header + [f"col{i}" for i in
                range(len(published_header), n)])[:n]
        return head, rows                        # every row is data
    return rows[0], rows[1:]


def load(only=None):
    """-> {corpus: {"file":…, "head":[…], "name_cols":[…], "rows":[…]}}"""
    out = {}
    if not LIB.is_dir():
        return out
    for f in sorted(list(LIB.rglob("*.csv")) + list(LIB.rglob("*.txt"))):
        key, published = classify(f)
        if only and key != only:
            continue
        head, rows = read_corpus(f, published)
        if not head:
            continue
        ncols = [i for i, c in enumerate(head) if looks_like_name(c)] or \
                list(range(min(4, len(head))))
        if key in out:                           # e.g. cn14 + cn16 + cn.txt
            out[key]["rows"] += rows
            out[key]["files"].append(f)
            continue
        # `files` is the list the manifest hashes. `file` stays for display.
        # Recording only the first one made the snapshot under-report every
        # multi-cycle corpus — and the snapshot is the thing findings cite.
        out[key] = dict(file=f, files=[f], head=head, name_cols=ncols, rows=rows)
    return out


def cid(corpus, lineno, value):
    return hashlib.sha256(f"{corpus}|{lineno}|{value}".encode()).hexdigest()[:12]


# ── build ─────────────────────────────────────────────────────────────────
def v_build():
    print(f"  {VERSION}")
    print(f"  LIBRARY  {LIB}")
    print(f"  ANOMALIES {ANOM}\n")
    have = load()
    if have:
        for k, d in sorted(have.items()):
            print(f"    {len(d['rows']):>9,} rows  {k}")
            fl = d.get("files", [d["file"]])
            print(f"{'':>16}  {' + '.join(sorted(x.name for x in fl))}")
            print(f"{'':>16}  matching on: "
                  f"{', '.join(d['head'][i] for i in d['name_cols'][:4])}")
            # A headerless file gets its column names from a layout I wrote
            # down, not from the file. If the FEC changes a layout, every
            # label silently shifts one column and nothing errors. So show
            # the first row against the labels and let a human see it.
            if k in {v[0] for v in HEADERLESS.values()} and d["rows"]:
                print(f"{'':>16}  LABELS COME FROM A STORED LAYOUT — check "
                      f"these line up:")
                for h, val in list(zip(d["head"], d["rows"][0]))[:5]:
                    print(f"{'':>18}  {h[:22]:<22} {str(val)[:40]}")
        print()
    unknown = [k for k in have if k not in CORPORA]
    if unknown:
        print(f"  UNRECOGNISED FILES — loaded, but I do not know their layout:")
        for k in unknown:
            print(f"    {k}  ({have[k]['file'].name})")
        print(f"  Column labels for these came from the file's own first row.")
        print(f"  If that row was DATA, one row is missing and every label is")
        print(f"  wrong. Send me the name and I will add the published layout.\n")
    missing = [k for k in CORPORA if k not in have]
    if not missing:
        print("  Library is complete.")
        return OK
    print(f"  MISSING {len(missing)} of {len(CORPORA)} corpora. Run this once:\n")
    print(f"    mkdir -p {LIB} && cd {LIB}")
    for k in missing:
        print(f"\n    # {k} — {CORPORA[k]['q']}")
        print(f"    curl -fL -O '{CORPORA[k]['url']}'")
    print(f"\n    for z in *.zip; do unzip -o \"$z\"; done && rm -f *.zip")
    print(f"\n  curl -f makes a 404 an ERROR instead of a 9-byte file named")
    print(f"  like a dataset. Check every download printed a size.")
    print(f"\n  Then:  python3 hunt.py build     # confirms what landed")
    return CANNOT


# ── hunt ──────────────────────────────────────────────────────────────────
def v_hunt(target, minlevel, top):
    # Do NOT load the library when an index exists. Loading is the expensive
    # part — parsing 3.2M rows to answer a question the index already holds
    # is most of the wall-clock in every command that felt slow.
    have = {} if DB.exists() else load()
    if not have and not DB.exists():
        print("  CANNOT — library empty. python3 hunt.py build")
        return CANNOT
    key = norm(target)
    if len(key) < 4:
        print(f"  CANNOT — '{target}' normalises to '{key}', too short to match "
              f"on. A 3-letter key collides with everything.")
        return CANNOT

    seen_ids = []                     # written out so `why` needs no placeholder
    # The index answers in milliseconds; the scan answers in tens of seconds.
    # Same rows, same ids — `cid` is derived from corpus+line+value either way,
    # so an id from an indexed run still resolves under `why` on a scan.
    idx = idx_lookup(key)
    if idx is not None:
        hits = defaultdict(list)
        for cname, rows_ in idx.items():
            for ln, raw, col, kind in rows_:
                hits[cname].append((ln, raw, None, kind))
    else:
        print("  NOTE  no index — scanning. sentinel-hunt index makes this "
              "instant.\n")
        hits = defaultdict(list)      # corpus -> [(lineno, value, row)]
        for cname, d in have.items():
            for ln, row in enumerate(d["rows"], 1):
                for i in d["name_cols"]:
                    if i >= len(row):
                        continue
                    v = row[i]
                    n = norm(v)
                    if not n:
                        continue
                    if n == key:
                        hits[cname].append((ln, v, row, "NAME"))
                    elif key in n:
                        hits[cname].append((ln, v, row, "CONTAINS"))

    print(f"  HUNT  {target}\n  key   '{key}'\n")
    LAST = LIB / ".last_hunt.json"
    if not hits:
        print("  No corpus names it. That is a result: it is not a registered")
        print("  foreign agent, not a foreign principal, not a federal")
        print("  committee. It narrows the question; it does not answer it.")
        return OK

    exact = {c: [h for h in v if h[3] == "NAME"] for c, v in hits.items()}
    exact = {c: v for c, v in exact.items() if v}

    for c, rows in sorted(hits.items()):
        e = len(exact.get(c, []))
        lvl = CORPORA.get(c, {}).get("level", 0)
        print(f"    {c:<20} {len(rows):>6} row(s)   {e} exact   "
              f"max level {lvl}")
        print(f"{'':>6}{CORPORA.get(c, {}).get('q', 'local corpus')}")
        for ln, v, row, kind in rows[:12]:
            i = cid(c, ln, v)
            seen_ids.append(dict(id=i, corpus=c, line=ln, value=v, kind=kind))
            print(f"{'':>6}[{i}] line {ln} {kind}: {v[:64]}")
        if len(rows) > 12:
            print(f"{'':>6}… {len(rows)-12} more")
        print()

    try:
        LAST.write_text(json.dumps(dict(target=target, key=key,
                                        ids=seen_ids), indent=1))
    except OSError:
        pass
    print(f"  ── COLLISION ──")
    if len(exact) < 2:
        print(f"  Named exactly in {len(exact)} corpus. No collision.")
        print(f"  One register saying something is one register saying")
        print(f"  something. Level 1 at most.")
        return OK

    lvl = max(CORPORA.get(c, {}).get("level", 0) for c in exact)
    print(f"  Named EXACTLY in {len(exact)} independent corpora:")
    for c in sorted(exact):
        print(f"    · {c}  ({len(exact[c])} exact row(s))")
    print(f"\n  Highest level any single corpus can support: {lvl}")
    print(f"  Level from the collision ITSELF: 2 (recurring), and only if")
    print(f"  entity resolution holds. Two registers naming the same string")
    print(f"  is not two registers naming the same party.")
    print(f"\n  BEFORE THIS BECOMES A LEAD, KILL IT:")
    print(f"    · is it a common name? run the same hunt on 2 similar names")
    print(f"    · same address / same officers / same EIN across the corpora?")
    print(f"    · do the DATE ranges even overlap?")
    print(f"    · is one of them the parent, subsidiary or successor of the")
    print(f"      other — in which case this is one party, not a collision?")
    print(f"\n  python3 hunt.py why        lists every id from this run")
    return REVIEW


# ── why ───────────────────────────────────────────────────────────────────
def v_why(wanted):
    if not wanted:
        f = LIB / ".last_hunt.json"
        if not f.is_file():
            print("  No hunt has been run yet. python3 hunt.py hunt \"<name>\"")
            return CANNOT
        d = json.loads(f.read_text())
        print(f"  ids from the last hunt — {d['target']}\n")
        for r in d["ids"]:
            print(f"    {r['id']}  {r['corpus']:<20} {r['kind']:<8} "
                  f"{r['value'][:44]}")
        print(f"\n  python3 hunt.py why <id>")
        return OK
    have = load()
    if not have:
        print("  CANNOT — library empty."); return CANNOT
    for cname, d in have.items():
        for ln, row in enumerate(d["rows"], 1):
            for i in d["name_cols"]:
                if i >= len(row):
                    continue
                if cid(cname, ln, row[i]) == wanted:
                    meta = CORPORA.get(cname, {})
                    print(f"  WHY DOES THE DESK BELIEVE THIS\n")
                    print(f"  id             {wanted}")
                    print(f"  corpus         {cname}")
                    print(f"  answers        {meta.get('q','(local corpus)')}")
                    print(f"  file           {d['file']}")
                    print(f"  line           {ln}")
                    print(f"  field          {d['head'][i]}")
                    print(f"  value          {row[i]}")
                    print(f"  retrieved      {datetime.fromtimestamp(d['file'].stat().st_mtime, timezone.utc).date()}")
                    print(f"  max level      {meta.get('level', 0)}")
                    print(f"\n  FULL ROW")
                    for h, v in zip(d["head"], row):
                        if str(v).strip():
                            print(f"    {h[:34]:<34} {str(v)[:70]}")
                    print(f"\n  WHAT THIS DOES NOT ESTABLISH")
                    print(f"    · that this is the same party as any similarly")
                    print(f"      named entity in another corpus")
                    print(f"    · any payment to, agreement with, or direction")
                    print(f"      of any person named nearby in the same row")
                    print(f"    · anything about a party not named in THIS row")
                    print(f"    · that the filing is accurate — it establishes")
                    print(f"      only that it was filed, and on what date")
                    return OK
    print(f"  CANNOT — no row with id {wanted}. Ids are derived from the file")
    print(f"  on disk; if the corpus was re-downloaded they changed.")
    return CANNOT


# ── falsify ───────────────────────────────────────────────────────────────
def v_falsify(claim):
    print(f'  FALSIFY  "{claim}"\n')
    print(f"  You do not get to keep this claim by finding more support for")
    print(f"  it. You keep it by trying to kill it and failing.\n")
    checks = [
        ("WRONG PARTY",
         "Is every entity in the claim the one you think it is?",
         "Pull the registration/EIN/CIK for each. Two entities with the same "
         "name in different states is the most common way a good claim dies."),
        ("NO OVERLAP",
         "Do the dates actually overlap?",
         "Put every event on one chronology with its source date. A "
         "relationship that ended before the act is not a relationship to it."),
        ("ALREADY DISCLOSED",
         "Is the thing you think is hidden sitting in a filing?",
         "Search the subject's own disclosures first. A disclosed relationship "
         "is not a concealed one, and finding it there ends the story early — "
         "which is cheap now and expensive after publication."),
        ("ORDINARY EXPLANATION",
         "What is the most boring reason this looks the way it does?",
         "Agency practice, a shared vendor, a standard contract vehicle, a "
         "reporting convention, a filing-system artifact. Write the boring "
         "version out in full. If you cannot, you do not understand it yet."),
        ("BASE RATE",
         "How often does this pattern occur among comparable entities?",
         "Run the identical query against 5 comparable subjects. If they all "
         "look like this, the pattern is the norm and there is no story."),
        ("CORRECTION TRAIL",
         "Was it amended, corrected or superseded?",
         "Check for later filings by the same party covering the same period. "
         "You may be reading a draft someone already fixed."),
        ("SOURCE OF THE SOURCE",
         "If two sources agree, are they independent?",
         "Two outlets citing one filing is one source. Trace each back to the "
         "document."),
    ]
    for i, (t, q, how) in enumerate(checks, 1):
        print(f"  {i}. {t}\n     {q}\n     {how}\n")
    print(f"  If the claim survives all seven, say so — and say which one came")
    print(f"  closest to killing it. That sentence is worth more to a reader")
    print(f"  than any amount of corroboration.")
    return OK


# ── expected_record ───────────────────────────────────────────────────────
EXPECTED = {
    "foreign-payment": dict(
        observed="money moved from a foreign principal toward US activity",
        should=["FARA registration within 10 days of the engagement "
                "(22 U.S.C. 612(a))",
                "supplemental statement every 6 months (612(b))",
                "informational materials filed within 48 hours of "
                "transmission (614(a))",
                "conspicuous statement on the material itself (614(b))",
                "the underlying contract or exhibit, filed as Exhibit B"],
        where=["https://efile.fara.gov/ords/fara/f?p=1381:1 — search by name",
               "the bulk corpora, if built: python3 hunt.py hunt \"<name>\"",
               "https://www.opensanctions.org/datasets/us_fara_filings/"],
        discriminator="The Exhibit B contract. It states the scope and the "
                      "consideration, and it is filed. Everything else is a "
                      "summary of it."),
    "contract": dict(
        observed="an agency awarded money to a company",
        should=["the solicitation that preceded it",
                "the justification if it was sole-source",
                "modifications and the amount each added",
                "the subcontract reporting if it crossed the threshold",
                "an inventory or delivery record on the receiving end"],
        where=["https://www.usaspending.gov/search — by recipient",
               "https://sam.gov/opp/ — the solicitation",
               "https://www.fpds.gov/ — the contract action detail"],
        discriminator="The solicitation. A contract with no findable "
                      "solicitation is either sole-source with a written "
                      "justification, or the justification is the missing "
                      "record."),
    "oig": dict(
        observed="a watchdog found a deficiency and made a recommendation",
        should=["the agency's written response",
                "a promised corrective action with a date",
                "evidence the action was taken",
                "a later audit testing the same condition"],
        where=["https://www.oversight.gov/reports/federal",
               "https://www.oversight.gov/recommendations — OPEN recommendations",
               "https://oig.justice.gov/reports — DOJ: FBI, ATF, DEA, USMS, BOP",
               "https://www.oig.dhs.gov/reports/audits-inspections-and-evaluations",
               "https://www.gao.gov/reports-testimonies"],
        discriminator="The follow-up audit. A recommendation still open years "
                      "after the agency said it was fixed is the finding — and "
                      "it is already published, which is why it is the best "
                      "value on this whole list."),
    "custody": dict(
        observed="an item entered government custody and later left it",
        should=["the intake/property entry with an identifier",
                "the chain-of-custody log",
                "the disposition order (release, transfer, destruction)",
                "the destruction certificate if destroyed",
                "the periodic inventory that should have counted it",
                "a loss/theft report if it went missing"],
        where=["the agency's own property-room audit",
               "https://www.oversight.gov/reports/federal — 'evidence room', "
               "'property room', 'firearms inventory', 'weapons accountability'",
               "state auditor's office for a local agency",
               "the criminal docket, if anyone was charged"],
        discriminator="The destruction certificate against the inventory. "
                      "Those two records are produced by different people for "
                      "different reasons, and when they disagree the "
                      "disagreement is documentary."),
    "disclosure": dict(
        observed="an official received something reportable",
        should=["the giver's disclosure of giving it",
                "the recipient's disclosure of receiving it",
                "the same period covered on both",
                "an amendment if either was corrected"],
        where=["https://www2.jlec-olig.state.oh.us/OLAC/Reports/Home — giver side",
               "https://www2.jlec-olig.state.oh.us/FDS/Reports/Search — recipient side",
               "https://disclosures-clerk.house.gov/ — federal House",
               "https://efdsearch.senate.gov/ — federal Senate"],
        discriminator="Both sides of the same transaction, same period. One "
                      "side reporting what the other does not is the cleanest "
                      "anomaly in this entire field, because both filers swore "
                      "to their version."),
}


def v_expected(kind, subject):
    if kind not in EXPECTED:
        print(f"  kinds: {', '.join(EXPECTED)}")
        return CANNOT
    e = EXPECTED[kind]
    print(f"  EXPECTED RECORD — {kind}\n  subject: {subject}\n")
    print(f"  OBSERVED\n    {e['observed']}\n")
    print(f"  WHAT MUST THEREFORE EXIST")
    for s in e["should"]:
        print(f"    [ ] {s}")
    print(f"\n  WHERE TO LOOK")
    for w in e["where"]:
        print(f"    {w}")
    print(f"\n  THE DISCRIMINATOR\n    {e['discriminator']}\n")
    print(f"  THE ONLY RULE THAT MATTERS HERE")
    print(f"    A record you could not find is a gap in YOUR collection.")
    print(f"    It is not evidence that anyone hid anything. Write it down as")
    print(f"    'not located as of {datetime.now(timezone.utc).date()}' and")
    print(f"    name the office that would hold it.")
    print(f"\n    If it truly should exist and does not, you have TWO possible")
    print(f"    findings and they are different: an undiscovered document, or")
    print(f"    an unmet obligation. Only a records response distinguishes them.")
    return OK




# ── chain ─────────────────────────────────────────────────────────────────
def pick(head, exact=(), frags=()):
    """Choose a column, exact header first.

    "First header containing these words" is how this file ended up searching
    *Foreign Principal Termination Date* for the name of a government. Exact
    match wins; then containment, but never a column NOT_A_NAME rules out."""
    low = [h.strip().lower() for h in head]
    for want in exact:
        if want in low:
            return low.index(want)
    for i, h in enumerate(low):
        if all(f in h for f in frags) and not any(k in h for k in NOT_A_NAME):
            return i
    return None


def vals(d, i):
    """Yield (lineno, raw, normalised) for column i."""
    for ln, row in enumerate(d["rows"], 1):
        if i is not None and i < len(row):
            raw = row[i]
            n = norm(raw)
            if n:
                yield ln, raw, n


def docs_cols(d):
    """The four join columns of FARA_All_RegistrantDocs, by exact header."""
    h = d["head"]
    return dict(
        reg  = pick(h, exact=("registrant name",), frags=("registrant",)),
        sf   = pick(h, exact=("short form name",), frags=("short", "form")),
        fp   = pick(h, exact=("foreign principal name", "foreign principal"),
                       frags=("foreign", "principal")),
        ctry = next((k for k, c in enumerate(h)
                     if "country" in c.lower()), None),
        url  = next((k for k, c in enumerate(h)
                     if "url" in c.lower() or "link" in c.lower()), None),
        dt   = next((k for k, c in enumerate(h)
                     if "date" in c.lower()), None),
    )


def cell(row, i):
    return row[i].strip() if (i is not None and i < len(row)) else ""


def canon_map(D, C):
    """FARA registration number -> registrant name.

    The registrant-name column sometimes carries the registration NUMBER
    instead of the name, so one filer splits into two apparent organisations:
    "Racepoint Global, Inc." and "6650". Same for 6840 (Ruder Finn), 6694
    (RM Broadcasting), 6490 (Reston Translator), 7649 (Clock Tower X).

    Apparent network diversity that is really identity fragmentation is the
    most flattering kind of error a graph can make, so it gets fixed here
    rather than in the eye of whoever reads the output.
    """
    num_i = next((k for k, h in enumerate(D["head"])
                  if "number" in h.lower() and "regist" in h.lower()), None)
    if num_i is None or C["reg"] is None:
        return {}
    m = {}
    for row in D["rows"]:
        num, name = cell(row, num_i), cell(row, C["reg"])
        # only learn from rows where the name is a NAME, not the number again
        if num and name and not name.isdigit():
            m.setdefault(num, name)
    return m


def canon(name, cmap):
    """-> (display name, True if it was an identifier we resolved)."""
    n = name.strip()
    if n.isdigit() and n in cmap:
        return cmap[n], True
    return n, False


def v_cols():
    """Print every corpus's real headers. When a walk finds nothing, this is
    the first thing to look at — a wrong column is indistinguishable from an
    empty register."""
    have = load()
    if not have:
        print("  CANNOT — library empty."); return CANNOT
    for k in sorted(have):
        d = have[k]
        print(f"\n  {k}   ({d['file'].name}, {len(d['rows']):,} rows)")
        for i, h in enumerate(d["head"]):
            mark = " <- matching on this" if i in d["name_cols"] else ""
            print(f"    {i:>2}  {h}{mark}")
    return OK


def v_country(name, cap):
    """Every foreign principal from one country, and who registered for it.

    This is the widest legitimate net in the whole FARA corpus: it starts
    from a country instead of from a name you already suspected, which means
    it can show you parties you had no reason to look up."""
    have = load()
    if "fara_docs" not in have:
        print("  CANNOT — needs fara_docs (FARA_All_RegistrantDocs.csv).")
        return CANNOT
    D = have["fara_docs"]; C = docs_cols(D)
    if C["ctry"] is None or C["fp"] is None:
        print("  CANNOT — no country / foreign-principal column. sentinel-hunt cols")
        return CANNOT
    key = norm(name)
    pairs, docs = defaultdict(set), defaultdict(int)
    for row in D["rows"]:
        if key and key not in norm(cell(row, C["ctry"])):
            continue
        fp, reg = cell(row, C["fp"]), cell(row, C["reg"])
        if fp:
            pairs[fp].add(reg)
            docs[fp] += 1
    if not pairs:
        ctys = sorted({cell(r, C["ctry"]) for r in D["rows"] if cell(r, C["ctry"])})
        near = [c for c in ctys if key[:4] and key[:4] in norm(c)]
        print(f"  No foreign principal filed under country '{name}'.")
        print(f"  {len(ctys)} countries appear in the corpus.")
        if near:
            print(f"  Closest spellings:")
            for c in near:
                print(f"    {c}")
        else:
            print(f"  Nothing close. The full list, so you can see the spelling")
            print(f"  FARA actually uses:")
            for c in ctys[:120]:
                print(f"    {c}")
            if len(ctys) > 120:
                print(f"    … {len(ctys)-120} more")
        return OK
    print(f"  COUNTRY  {name}\n")
    print(f"  {len(pairs)} foreign principal(s), {sum(docs.values()):,} filed document(s)\n")
    for fp, regs in sorted(pairs.items(), key=lambda kv: -docs[kv[0]])[:cap]:
        print(f"    {docs[fp]:>5} docs   {fp[:64]}")
        print(f"{'':>18}via {', '.join(sorted(r for r in regs if r))[:80]}")
    if len(pairs) > cap:
        print(f"\n    … {len(pairs)-cap} more (--cap to raise)")
    print(f"\n  Level 4 — each row is a filed document. A registrant appearing")
    print(f"  here declared it acts for that principal. It says nothing about")
    print(f"  anyone who did not file.")
    print(f"\n  sentinel-hunt chain \"<any principal above>\"")
    return OK


def v_chain(target, cap, no_fec=False):
    """Walk the disclosed chain, one documented hop at a time.

    FOREIGN PRINCIPAL -> REGISTRANT -> THE INDIVIDUALS WHO DID THE WORK

    FARA_All_RegistrantDocs carries all three on ONE row with the document
    that joins them, so the walk is a read rather than a guess. Every hop is
    an edge somebody FILED: that is why it is worth doing and also the whole
    limit of it. A filing establishes that a relationship was declared, on a
    date, in a form. It does not establish that the declaration was complete,
    and it says nothing about anyone who chose not to file.
    """
    have = load()
    if "fara_docs" not in have:
        print("  CANNOT — chain needs fara_docs. sentinel-hunt build")
        return CANNOT
    D = have["fara_docs"]; C = docs_cols(D)
    if C["fp"] is None or C["reg"] is None:
        print("  CANNOT — could not identify the join columns.")
        print("  sentinel-hunt cols   and send me what it prints.")
        return CANNOT

    key = norm(target)
    if len(key) < 4:
        print(f"  CANNOT — '{target}' normalises to '{key}'. Too short.")
        return CANNOT

    print(f"  CHAIN  {target}\n  key    '{key}'\n")

    # ROLE DETECTION — weight, not order.
    #
    # This used to take the FIRST role in a fixed list that matched at all.
    # That meant "Mercury Public Affairs, LLC" — a registrant with hundreds of
    # filings — was reported as a FOREIGN PRINCIPAL on the strength of ONE row
    # where its name appeared inside a principal's description string. The
    # walk then went the wrong direction and returned almost nothing, which
    # reads exactly like an entity with no footprint. Same for Edelman,
    # Brownstein, Qorvis and Arnold & Porter.
    #
    # Now: an EXACT match always beats a substring, and within a tier the role
    # with the most rows wins. When two roles both match exactly, the walk
    # says so instead of silently picking one.
    cand = []
    for label, ci in (("FOREIGN PRINCIPAL", C["fp"]),
                      ("REGISTRANT", C["reg"]),
                      ("INDIVIDUAL AGENT", C["sf"])):
        if ci is None:
            continue
        ex = [r for r in D["rows"] if norm(cell(r, ci)) == key]
        co = [r for r in D["rows"] if key in norm(cell(r, ci))]
        if ex:
            cand.append((2, len(ex), label, ex, "exact"))
        elif co:
            cand.append((1, len(co), label, co, "contains"))
    role, rows, how, others = None, [], None, []
    if cand:
        cand.sort(key=lambda t: (-t[0], -t[1]))
        _, _, role, rows, how = cand[0]
        others = [(l, len(r), h) for _, _, l, r, h in cand[1:]]
    if not role:
        print("  Not named in any filed FARA document as a foreign principal,")
        print("  a registrant, or an individual agent.")
        print("  That is a result. It is NOT evidence of an unfiled relationship.")
        print(f"\n  Foreign principals are filed under long official names —")
        print(f"  'Ministry of Foreign Affairs' alone will not match Israel's.")
        print(f"  Start from the country instead:")
        print(f"      sentinel-hunt country Israel")
        return OK

    print(f"  STANDS AS   {role}   ({how} match, {len(rows):,} filed document(s))")
    for l, n, h in others:
        print(f"  ALSO AS     {l}   ({h} match, {n:,} document(s)) — not walked")
    if others and others[0][2] == how:
        print(f"  AMBIGUOUS   it matches more than one role at the same")
        print(f"              strength. Decide which party you mean before")
        print(f"              you use anything below.")
    if how == "contains":
        print(f"  NOTE        substring match. Confirm the full name below is")
        print(f"              the party you meant before going further.")
    print()

    names = sorted({cell(r, C["fp"] if role == "FOREIGN PRINCIPAL"
                         else C["reg"]) for r in rows})
    names = [n for n in names if n]
    if how == "contains" and len(names) > 1:
        print(f"  MATCHED {len(names)} DISTINCT NAME(S):")
        for n in names[:cap]:
            print(f"    · {n}")
        print()

    step = 0
    cmap = canon_map(D, C)
    if role == "FOREIGN PRINCIPAL":
        step += 1
        regs, merged = defaultdict(int), []
        for r in rows:
            v = cell(r, C["reg"])
            if v:
                name, was_id = canon(v, cmap)
                regs[name] += 1
                if was_id:
                    merged.append((v, name))
        print(f"  ── HOP {step}: WHO REGISTERED TO ACT FOR IT ──   level 4 (filed)")
        for v, n in sorted(regs.items(), key=lambda kv: -kv[1])[:cap]:
            print(f"    {n:>5} docs   {v}")
        if len(regs) > cap:
            print(f"    … {len(regs)-cap} more")
        if merged:
            seen = sorted({m for m in merged})
            print(f"  MERGED — these rows carried a registration NUMBER in the")
            print(f"  name column and are the SAME filer, not extra ones:")
            for num, name in seen[:8]:
                print(f"    {num}  ->  {name}")
        print()
    else:
        step += 1
        prins = defaultdict(int)
        for r in rows:
            v = cell(r, C["fp"])
            if v:
                prins[v] += 1
        print(f"  ── HOP {step}: WHO IT ACTS FOR ──   level 4 (filed)")
        if not prins:
            print("    (no foreign principal named on these rows)")
        for v, n in sorted(prins.items(), key=lambda kv: -kv[1])[:cap]:
            ct = next((cell(r, C["ctry"]) for r in rows if cell(r, C["fp"]) == v), "")
            print(f"    {n:>5} docs   {v[:56]}  [{ct}]")
        if len(prins) > cap:
            print(f"    … {len(prins)-cap} more")
        print()

    # the humans
    if C["sf"] is not None:
        step += 1
        people = defaultdict(int)
        for r in rows:
            v = cell(r, C["sf"])
            if v:
                people[v] += 1
        print(f"  ── HOP {step}: THE INDIVIDUALS NAMED ON THE FILINGS ──   level 4 (filed)")
        if not people:
            print("    No short-form individual named on any of these documents.")
            print("    That is common for registration-level filings and does")
            print("    NOT mean no person was involved.")
        for v, n in sorted(people.items(), key=lambda kv: -kv[1])[:cap]:
            print(f"    {n:>5} docs   {v}")
        if len(people) > cap:
            print(f"    … {len(people)-cap} more")
        print(f"  Coverage names firms. Short forms name people, and people")
        print(f"  carry relationships from job to job in a way a firm cannot.\n")

        # people -> FEC, clearly marked as the weakest hop in the file
        fec = {} if no_fec else {k: v for k, v in have.items()
                                 if k.startswith("fec_")}
        if no_fec:
            print(f"  (hop 3 skipped — --no-fec. It is the weakest hop in this")
            print(f"   file anyway: a personal-name string match, level 0.)")
        if people and fec:
            step += 1
            print(f"  ── HOP {step}: WHERE ELSE THOSE PEOPLE APPEAR ──   level 0 UNTIL RESOLVED")
            # ONE PASS PER CORPUS, not one per person.
            #
            # This used to loop people x corpora x rows x columns. With 25
            # people and 703,597 rows in itpas2 that is tens of millions of
            # norm() calls and it looks exactly like a hang. Now: collect the
            # keys we care about, then sweep each corpus once and count hits
            # against a set. Same answer, two orders of magnitude less work.
            want = {norm(w): w for w in sorted(people, key=lambda w: -people[w])[:cap]
                    if len(norm(w)) >= 6}
            if not want:
                print(f"    No individual name long enough to match on safely.")
            hits = defaultdict(lambda: defaultdict(int))
            for cname, d in fec.items():
                n_rows = len(d["rows"])
                print(f"    scanning {cname} ({n_rows:,} rows)…", flush=True)
                cols = d["name_cols"]
                for row in d["rows"]:
                    for i in cols:
                        if i < len(row):
                            k = norm(row[i])
                            if k in want:
                                hits[want[k]][cname] += 1
            for who in sorted(hits, key=lambda w: -sum(hits[w].values())):
                where = ", ".join(f"{c}({n})" for c, n in sorted(hits[who].items()))
                print(f"    · {who[:36]:<36} {where}")
            if not hits:
                print(f"    No exact name match in the FEC corpora.")
            print(f"\n  READ THIS BEFORE YOU BELIEVE ANY LINE ABOVE.")
            print(f"  This hop is a STRING MATCH ON A PERSON'S NAME and it is")
            print(f"  level 0 until you resolve it. Personal names collide far")
            print(f"  worse than company names, which at least carry a state and")
            print(f"  a registration number. Check city, employer and occupation")
            print(f"  on the FEC row against the short form, and run a common")
            print(f"  name as a control, before any of this becomes a lead.")

    print(f"\n  WHAT THE NUMBER ABOVE IS, AND IS NOT")
    print(f"    DOCUMENT COUNT  is what this counted.")
    print(f"    It is NOT money, NOT contacts with officials, NOT audience")
    print(f"    reach, and NOT wrongdoing. Those are four separate measures")
    print(f"    and three of them are not in this corpus at all. A filer that")
    print(f"    files often looks large here; a filer paid ten times as much")
    print(f"    on one contract looks small. Read the supplementals for money")
    print(f"    and the Exhibit AB for scope before you call anything big.")

    if C["url"] is not None:
        u = [cell(r, C["url"]) for r in rows if cell(r, C["url"])]
        if u:
            print(f"\n  ── THE DOCUMENTS THEMSELVES ── {len(u):,} URL(s). First 5:")
            for x in u[:5]:
                print(f"    {x}")
            print(f"  Read the filings. Everything above is an index to them.")
    print(f"\n  sentinel-hunt hunt \"<any name above>\"   for provenance")
    return REVIEW if step > 1 else OK



# ── anomalies ─────────────────────────────────────────────────────────────
# A separate shelf, on purpose. The library is what everyone can see. The
# anomaly shelf is what somebody has to answer for. Mixing them lets a
# curiosity drift into a finding without anyone deciding that it should.

ANOM = Path(os.environ.get("HUNT_ANOM",
                           os.path.expanduser("~/sentinel/anomalies")))
SCHEMA = "tsr.anomaly/1"

# The ladder a record climbs. It cannot skip a rung and `check` enforces it.
STATUSES = ["DRAFT", "OPEN", "CORROBORATED",
            "RESOLVED_ORDINARY", "REFERRED", "PUBLISHED", "WITHDRAWN"]

# The five public-interest questions. These are the whole point of the shelf.
# They are phrased so that a vague answer is visibly vague — "the American
# people" is not an answer to "who bears the cost", and the record will say so.
PI_QUESTIONS = {
    "who_bears_the_cost":
        "WHO is worse off, specifically? Name them — ratepayers in one "
        "county, a class of applicants, taxpayers funding one line item. "
        "If the only answer is 'the public', you do not yet have a "
        "public-interest finding. You have a curiosity.",
    "duty_owed":
        "What DUTY existed, owed by whom, to whom? Cite the statute, rule "
        "or disclosure obligation. No duty means no violation — which does "
        "NOT mean no story, but it is a different story and must be told "
        "as one.",
    "was_it_visible":
        "Could the public already see this? Disclosed-and-lawful, "
        "disclosed-but-unread, and concealed are three different findings. "
        "Most of what you will find is the middle one, and that is still "
        "worth publishing — but never as if it were the third.",
    "structural_or_one_off":
        "One instance, or something the system permits every time? A "
        "structural finding outranks a lurid single case, because it is "
        "the one that can be fixed.",
    "what_changes_if_known":
        "If every citizen learned this tomorrow, what could they DO? A "
        "vote, a comment on a rule, a records request, a question at a "
        "hearing. If the honest answer is 'nothing', it may be true and "
        "still not be news.",
}

# Severity is COMPUTED, not felt. Nothing here scores for how shocking it is.
SEV = {
    "duty":          "0 no duty · 1 a norm · 2 a rule · 3 a statute",
    "concealment":   "0 fully disclosed · 1 disclosed obscurely · "
                     "2 omitted where required · 3 affirmatively misstated",
    "scale":         "0 trivial · 1 local · 2 statewide or many people · "
                     "3 national or systemic",
    "repeatability": "0 one-off · 1 twice · 2 a pattern · "
                     "3 the system produces it by design",
    "corroboration": "0 single source · 1 two, same origin · "
                     "2 two independent · 3 primary documents from both sides",
}


def anom_id(slug):
    ANOM.mkdir(parents=True, exist_ok=True)
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    n = 1 + sum(1 for p in ANOM.iterdir()
                if p.is_dir() and p.name.startswith(f"ANOM-{day}"))
    return f"ANOM-{day}-{n:03d}"


def slugify(t):
    s = re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")
    return s[:52] or "untitled"


def anom_dirs():
    if not ANOM.is_dir():
        return []
    return sorted(p for p in ANOM.iterdir()
                  if p.is_dir() and (p / "record.json").is_file())


def load_rec(which):
    """Accept the id, the folder name, or a unique prefix."""
    for p in anom_dirs():
        if which in (p.name, p.name.split("-_")[0]) or p.name.startswith(which):
            return p, json.loads((p / "record.json").read_text())
    return None, None


def save_rec(p, rec):
    rec["updated_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (p / "record.json").write_text(json.dumps(rec, indent=2))
    (p / "RECORD.md").write_text(render_md(rec))


def blank(rid, slug, title, level, tags):
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {
        "schema": SCHEMA, "id": rid, "slug": slug, "title": title,
        "created_utc": now, "updated_utc": now,
        "status": "DRAFT", "level": level, "tags": tags,
        "subjects": [],
        "warrant": "",
        "qualifiers": [],
        "evidence": [],
        "explanations": {"ordinary": "", "adverse": ""},
        "discriminator": "",
        "missing_records": [],
        "public_interest": {k: "" for k in PI_QUESTIONS},
        "strongest_case_that_this_is_fine": "",
        "severity": {k: None for k in SEV},
        "referral": {"appropriate": None, "to": "", "why": ""},
    }


def sev_score(rec):
    v = [rec["severity"].get(k) for k in SEV]
    if any(x is None for x in v):
        return None
    return sum(int(x) for x in v)


# ── the gate ──────────────────────────────────────────────────────────────
def gate(rec, want):
    """-> list of blocking reasons for moving this record to `want`.

    Fail-closed, same as every other gate on this desk. A record does not get
    to be CORROBORATED because you feel corroborated."""
    b, pi = [], rec.get("public_interest", {})

    if want in ("OPEN", "CORROBORATED", "RESOLVED_ORDINARY", "REFERRED", "PUBLISHED"):
        if not rec.get("warrant", "").strip():
            b.append("warrant is empty — say in one sentence what is anomalous")
        if len(rec.get("evidence", [])) < 1:
            b.append("no evidence rows")
        if not rec["explanations"].get("ordinary", "").strip():
            b.append("no ORDINARY explanation written — write the boring "
                     "version in full before the interesting one")
        if not rec["explanations"].get("adverse", "").strip():
            b.append("no ADVERSE explanation written")
        if not rec.get("discriminator", "").strip():
            b.append("no discriminator — name the record that would settle it")

    if want in ("CORROBORATED", "REFERRED", "PUBLISHED"):
        srcs = {e.get("source", "") for e in rec.get("evidence", []) if e.get("source")}
        if len(srcs) < 2:
            b.append(f"only {len(srcs)} distinct source(s) — corroboration "
                     f"means two records that do not come from each other")
        if not any(e.get("url") or e.get("locator") for e in rec.get("evidence", [])):
            b.append("no evidence row carries a locator or URL")

    if want in ("REFERRED", "PUBLISHED"):
        for k in PI_QUESTIONS:
            if not pi.get(k, "").strip():
                b.append(f"public_interest.{k} is unanswered")
        if pi.get("who_bears_the_cost", "").strip().lower() in (
                "the public", "the american people", "everyone", "americans",
                "the country", "us"):
            b.append("who_bears_the_cost is a slogan, not an answer — name "
                     "the specific people who are worse off")
        if not rec.get("strongest_case_that_this_is_fine", "").strip():
            b.append("strongest_case_that_this_is_fine is empty — if you "
                     "cannot argue the other side you do not understand it")
        if sev_score(rec) is None:
            b.append("severity is not scored (sentinel-hunt score <id> ...)")

    if want == "PUBLISHED":
        if rec.get("level", 0) >= 5:
            b.append("level 5+ asserts documented direction or authority. "
                     "That comes from reading a document, never from a join. "
                     "Name the document in evidence or drop the level.")
    return b


# ── render ────────────────────────────────────────────────────────────────
def render_md(rec):
    L = []
    a = L.append
    a(f"# {rec['id']} — {rec['title']}\n")
    s = sev_score(rec)
    a(f"**Status** `{rec['status']}` · **Level** {rec['level']} · "
      f"**Severity** {s if s is not None else '— not scored —'}/15 · "
      f"updated {rec['updated_utc']}\n")
    if rec.get("tags"):
        a(f"Tags: {', '.join(rec['tags'])}\n")
    a("## The warrant\n")
    a((rec.get("warrant") or "_empty — this record asserts nothing yet._") + "\n")
    if rec.get("subjects"):
        a("## Subjects\n")
        for s_ in rec["subjects"]:
            ids = " · ".join(f"{k}={v}" for k, v in (s_.get("identifiers") or {}).items())
            a(f"- **{s_.get('name','?')}** — {s_.get('role','')} {ids}")
        a("")
    a("## Evidence\n")
    if not rec.get("evidence"):
        a("_none_\n")
    else:
        a("| # | source | locator | retrieved | exact text / field |")
        a("|---|---|---|---|---|")
        for i, e in enumerate(rec["evidence"], 1):
            a(f"| {i} | {e.get('source','')} | {e.get('locator','')} "
              f"| {e.get('retrieved_utc','')} | {str(e.get('exact',''))[:90]} |")
        a("")
        for i, e in enumerate(rec["evidence"], 1):
            if e.get("url"):
                a(f"{i}. {e['url']}")
        a("")
    a("## Competing explanations\n")
    a(f"**Ordinary** — {rec['explanations'].get('ordinary') or '_unwritten_'}\n")
    a(f"**Adverse** — {rec['explanations'].get('adverse') or '_unwritten_'}\n")
    a(f"**Discriminator** — the record that would settle it: "
      f"{rec.get('discriminator') or '_unnamed_'}\n")
    if rec.get("missing_records"):
        a("## Not located\n")
        for m in rec["missing_records"]:
            a(f"- {m}")
        a("\n_Not located is a gap in this collection. It is not evidence "
          "that anyone concealed anything._\n")
    a("## Public-interest test\n")
    for k, q in PI_QUESTIONS.items():
        a(f"**{k.replace('_',' ')}**  \n{rec['public_interest'].get(k) or '_unanswered_'}\n")
    a(f"**The strongest case that this is fine**  \n"
      f"{rec.get('strongest_case_that_this_is_fine') or '_unwritten_'}\n")
    a("## Severity\n")
    a("| factor | score | scale |")
    a("|---|---|---|")
    for k, scale in SEV.items():
        a(f"| {k} | {rec['severity'].get(k) if rec['severity'].get(k) is not None else '—'} | {scale} |")
    a(f"\n**Total {s if s is not None else '—'}/15.** Nothing here scores for "
      f"how shocking it is. A dull structural finding outranks a lurid "
      f"one-off, every time.\n")
    if rec.get("qualifiers"):
        a("## What this record does NOT establish\n")
        for q in rec["qualifiers"]:
            a(f"- {q}")
        a("")
    r = rec.get("referral", {})
    if r.get("appropriate"):
        a(f"## Referral\n\nTo: {r.get('to','')}\n\n{r.get('why','')}\n")
    b = gate(rec, "PUBLISHED")
    a("## Publication gate\n")
    if b:
        a("**BLOCKED.** Not publishable as it stands:\n")
        for x in b:
            a(f"- {x}")
    else:
        a("**CLEAR.** Every required field is filled and every claim carries "
          "a locator. That is not the same as being right — it means the "
          "record can now be argued with.")
    a("")
    return "\n".join(L)


# ── verbs ─────────────────────────────────────────────────────────────────
def v_flag(title, level, tags, from_last):
    rid = anom_id(title)
    slug = slugify(title)
    d = ANOM / f"{rid}__{slug}"
    (d / "evidence").mkdir(parents=True, exist_ok=True)
    rec = blank(rid, slug, title, level, [t for t in tags.split(",") if t])

    if from_last:
        f = LIB / ".last_hunt.json"
        if f.is_file():
            h = json.loads(f.read_text())
            rec["subjects"].append(dict(name=h.get("target", ""), role="hunted",
                                        identifiers={"key": h.get("key", "")}))
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            for r in h.get("ids", [])[:20]:
                rec["evidence"].append(dict(
                    source=r["corpus"], locator=f"line {r['line']}",
                    url="", retrieved_utc=now, exact=r["value"],
                    collision_id=r["id"]))
            print(f"  seeded {len(rec['evidence'])} evidence row(s) from the "
                  f"last hunt — these are LOCATORS, not corroboration")
    save_rec(d, rec)
    print(f"\n  {rid}   {d}")
    print(f"\n  Status DRAFT. It asserts nothing and it is not publishable.")
    print(f"  Open record.json and fill, in this order:")
    print(f"    1. warrant     one sentence: what is anomalous here")
    print(f"    2. explanations.ordinary    THE BORING VERSION, IN FULL,")
    print(f"       before you write the other one. If you cannot write it,")
    print(f"       you do not understand the thing yet.")
    print(f"    3. explanations.adverse")
    print(f"    4. discriminator   the one record that would settle it")
    print(f"\n  Then:  sentinel-hunt check {rid}")
    return OK


def v_check(which, want):
    p, rec = load_rec(which)
    if not rec:
        print(f"  CANNOT — no anomaly matching '{which}'. sentinel-hunt docket")
        return CANNOT
    want = want or rec["status"]
    if want not in STATUSES:
        print(f"  status must be one of: {', '.join(STATUSES)}")
        return CANNOT
    b = gate(rec, want)
    print(f"  {rec['id']} — {rec['title']}")
    print(f"  now {rec['status']}  ->  {want}\n")
    if not b:
        if want != rec["status"]:
            rec["status"] = want
            save_rec(p, rec)
            print(f"  CLEAR. status is now {want}.")
        else:
            print(f"  CLEAR at {want}.")
        s = sev_score(rec)
        if s is not None:
            print(f"  severity {s}/15")
        return OK
    print(f"  BLOCKED — {len(b)} thing(s) stand between this and {want}:\n")
    for x in b:
        print(f"    · {x}")
    print(f"\n  Nothing was changed. There is no override flag.")
    return REVIEW


def v_score(which, vals):
    p, rec = load_rec(which)
    if not rec:
        print(f"  CANNOT — no anomaly matching '{which}'"); return CANNOT
    if not vals:
        print(f"  {rec['id']} — score each 0-3:\n")
        for k, scale in SEV.items():
            cur = rec["severity"].get(k)
            print(f"    {k:<15} {cur if cur is not None else '—'}   {scale}")
        print(f"\n  sentinel-hunt score {rec['id']} duty=2 concealment=1 "
              f"scale=2 repeatability=3 corroboration=2")
        print(f"\n  Nothing here scores for how shocking it is. That is")
        print(f"  deliberate — a scale that rewards drama will find drama.")
        return OK
    for kv in vals:
        if "=" not in kv:
            print(f"  CANNOT — '{kv}' is not key=value"); return CANNOT
        k, v = kv.split("=", 1)
        if k not in SEV:
            print(f"  CANNOT — '{k}' not a factor. {', '.join(SEV)}"); return CANNOT
        if not v.isdigit() or not 0 <= int(v) <= 3:
            print(f"  CANNOT — {k}={v}; must be 0-3"); return CANNOT
        rec["severity"][k] = int(v)
    save_rec(p, rec)
    s = sev_score(rec)
    print(f"  {rec['id']}  severity {s if s is not None else '—'}/15")
    if s is not None and s >= 10:
        print(f"\n  10+ is high. Before it goes anywhere: re-read")
        print(f"  explanations.ordinary and ask whether you wrote it as")
        print(f"  well as you wrote the adverse one.")
    return OK


def v_docket(as_json):
    ds = anom_dirs()
    if not ds:
        print(f"  No anomalies yet. {ANOM}")
        print(f"  sentinel-hunt flag \"<one-line title>\" --from-last")
        return OK
    recs = [json.loads((d / "record.json").read_text()) for d in ds]
    if as_json:
        print(json.dumps(recs, indent=2))
        return OK
    print(f"  ANOMALY DOCKET — {ANOM}\n")
    print(f"  {'ID':<20} {'STATUS':<18} {'SEV':>4}  {'LVL':>3}  TITLE")
    order = {s: i for i, s in enumerate(STATUSES)}
    for r in sorted(recs, key=lambda x: (-(sev_score(x) or -1),
                                         order.get(x["status"], 9))):
        s = sev_score(r)
        print(f"  {r['id']:<20} {r['status']:<18} "
              f"{(str(s)+'/15') if s is not None else '—':>4}  "
              f"{r.get('level',0):>3}  {r['title'][:44]}")
    stuck = [r for r in recs if r["status"] == "DRAFT"]
    if stuck:
        print(f"\n  {len(stuck)} still DRAFT — they assert nothing until the")
        print(f"  warrant and both explanations are written.")
    print(f"\n  sentinel-hunt brief <id>     read one")
    print(f"  sentinel-hunt check <id> --to OPEN")
    return OK


def v_brief(which):
    p, rec = load_rec(which)
    if not rec:
        print(f"  CANNOT — no anomaly matching '{which}'"); return CANNOT
    # Render from record.json, never from the RECORD.md on disk. The JSON is
    # the source of truth; the markdown is a view of it. Reading the stale
    # view is how you end up briefing yourself on fields you already changed.
    md = render_md(rec)
    try:
        (p / "RECORD.md").write_text(md)
    except OSError:
        pass
    print(md)
    return OK



# ── conflicts ─────────────────────────────────────────────────────────────
# Country words that appear in principal names. Not exhaustive — this is a
# detector, and a detector that only fires on obvious cases is still better
# than an eye that skims 154,038 rows.
COUNTRY_WORDS = {
    "brazil": "BRAZIL", "brasil": "BRAZIL", "israel": "ISRAEL",
    "qatar": "QATAR", "saudi": "SAUDI ARABIA", "china": "CHINA",
    "chinese": "CHINA", "russia": "RUSSIA", "russian": "RUSSIA",
    "japan": "JAPAN", "korea": "SOUTH KOREA", "india": "INDIA",
    "turkey": "TURKEY", "egypt": "EGYPT", "ukraine": "UKRAINE",
    "mexico": "MEXICO", "canada": "CANADA", "germany": "GERMANY",
    "france": "FRANCE", "nigeria": "NIGERIA", "kenya": "KENYA",
    "morocco": "MOROCCO", "taiwan": "TAIWAN", "vietnam": "VIETNAM",
    "colombia": "COLOMBIA", "venezuela": "VENEZUELA", "congo": "CONGO",
}


def v_conflicts(cap):
    """Rows where the principal's NAME names one country and the country
    COLUMN says another.

    Observed in this library: "United Nations Development Program on behalf of
    COP30 Presidency" — COP30 was hosted by Brazil — carried [ISRAEL].

    A conflict is NOT evidence of concealment. The likeliest explanations are
    dull: the country field may record the contracting entity's address rather
    than the principal's nationality, or a filer picked the wrong item from a
    dropdown, or the row is a coding error at the agency. But it means a count
    by country is wrong by an unknown amount, and that is worth knowing before
    you publish one.
    """
    have = load()
    if "fara_docs" not in have:
        print("  CANNOT — needs fara_docs."); return CANNOT
    D = have["fara_docs"]; C = docs_cols(D)
    if C["fp"] is None or C["ctry"] is None:
        print("  CANNOT — no principal / country column. sentinel-hunt cols")
        return CANNOT

    found = defaultdict(int)
    example = {}
    for row in D["rows"]:
        fp, ct = cell(row, C["fp"]), cell(row, C["ctry"]).strip().upper()
        if not fp or not ct:
            continue
        low = " " + norm(fp) + " "
        named = {v for k, v in COUNTRY_WORDS.items() if f" {k} " in low}
        if named and ct not in named:
            key = (fp[:70], ct, " / ".join(sorted(named)))
            found[key] += 1
            example.setdefault(key, cell(row, C["reg"]))

    print(f"  COUNTRY METADATA CONFLICTS\n")
    if not found:
        print("  None detected. That does not mean none exist — this only")
        print("  fires when a country word appears in the principal's name.")
        return OK
    print(f"  {len(found)} distinct principal/country pair(s) disagree.\n")
    for (fp, ct, named), n in sorted(found.items(), key=lambda kv: -kv[1])[:cap]:
        print(f"    {n:>5} docs   column says [{ct}], name says [{named}]")
        print(f"{'':>18}{fp}")
        print(f"{'':>18}filed by {example[(fp, ct, named)][:56]}")
    if len(found) > cap:
        print(f"\n    … {len(found)-cap} more (--cap to raise)")
    print(f"\n  WHAT TO DO WITH THIS")
    print(f"    Do NOT correct it silently in your own notes. Pull the")
    print(f"    Exhibit AB for the registration and find out what the country")
    print(f"    field is actually recording. Then write down which reading is")
    print(f"    right and why — that note is the finding, not the conflict.")
    print(f"\n    And until it is resolved: any count you publish BY COUNTRY")
    print(f"    is wrong by at least the number above.")
    return REVIEW



# ── the index ─────────────────────────────────────────────────────────────
# Why this exists: at 3.2M rows, re-reading and re-normalising every corpus on
# every command is the difference between a script and a tool somebody else
# can use. The index is built once and queried instantly.
#
# It also carries the SNAPSHOT MANIFEST — for each corpus file, its sha256,
# byte size, row count and the moment it was indexed. That is not
# bookkeeping. It is what lets a published number say WHICH VERSION of a
# public dataset it came from. Bulk files change without notice; a finding
# that cannot name its snapshot cannot be rechecked by a reader, and a
# finding a reader cannot recheck is an assertion.

DB = LIB / "index.db"
SCHEMA = """
CREATE TABLE IF NOT EXISTS corpus (
  name TEXT PRIMARY KEY, file TEXT, sha256 TEXT, bytes INTEGER,
  rows INTEGER, cols TEXT, indexed_utc TEXT, tool TEXT);
CREATE TABLE IF NOT EXISTS ent (
  corpus TEXT, lineno INTEGER, col TEXT, raw TEXT, norm TEXT);
CREATE INDEX IF NOT EXISTS ent_norm ON ent(norm);
CREATE INDEX IF NOT EXISTS ent_corpus ON ent(corpus);
"""


def sha_of(p, cap=64 << 20):
    """sha256 of the file. Capped read for very large files — the cap is
    recorded so nobody mistakes a partial digest for a whole-file one."""
    h, n = hashlib.sha256(), 0
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk); n += len(chunk)
            if n >= cap:
                return h.hexdigest(), n, True
    return h.hexdigest(), n, False


def v_index(rebuild):
    have = load()
    if not have:
        print("  CANNOT — library empty. sentinel-hunt build"); return CANNOT
    if rebuild and DB.exists():
        DB.unlink()
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    t0 = time.time()
    done = 0
    for name, d in sorted(have.items()):
        cur = con.execute("SELECT sha256, rows FROM corpus WHERE name=?", (name,))
        prev = cur.fetchone()
        files = d.get("files", [d["file"]])
        parts = [sha_of(f) for f in sorted(files)]
        if len(parts) == 1:
            digest, nbytes, capped = parts[0]
        else:
            # A corpus assembled from several files gets a digest OF THE
            # DIGESTS, so adding a cycle changes it and the index rebuilds.
            roll = hashlib.sha256()
            for dg, _, _ in parts:
                roll.update(dg.encode())
            digest = roll.hexdigest()
            nbytes = sum(b for _, b, _ in parts)
            capped = any(c for _, _, c in parts)
        if prev and prev[0] == digest and not rebuild:
            print(f"    unchanged  {name}  ({prev[1]:,} rows)")
            continue
        con.execute("DELETE FROM ent WHERE corpus=?", (name,))
        cols = [(i, d["head"][i]) for i in d["name_cols"]]
        rows = []
        for ln, row in enumerate(d["rows"], 1):
            for i, cname in cols:
                if i < len(row):
                    raw = row[i]
                    n = norm(raw)
                    if n:
                        rows.append((name, ln, cname, raw, n))
            if len(rows) >= 50000:
                con.executemany("INSERT INTO ent VALUES (?,?,?,?,?)", rows)
                rows = []
        if rows:
            con.executemany("INSERT INTO ent VALUES (?,?,?,?,?)", rows)
        con.execute("INSERT OR REPLACE INTO corpus VALUES (?,?,?,?,?,?,?,?)",
                    (name, " + ".join(f.name for f in sorted(files)),
                     digest + ("~partial" if capped else ""),
                     nbytes, len(d["rows"]),
                     json.dumps([c for _, c in cols]), now, VERSION))
        con.commit()
        done += 1
        print(f"    indexed    {name}  ({len(d['rows']):,} rows)")
    n_ent = con.execute("SELECT COUNT(*) FROM ent").fetchone()[0]
    con.commit(); con.close()
    print(f"\n  {n_ent:,} searchable values · {time.time()-t0:.1f}s · {DB}")
    print(f"\n  Every command now answers from the index instead of re-reading")
    print(f"  {sum(len(d['rows']) for d in have.values()):,} rows. Re-run this")
    print(f"  after any download — an unchanged file is skipped by hash.")
    print(f"\n  sentinel-hunt snapshot     what the index was built from")
    return OK


def v_snapshot(as_json):
    """The manifest. What a published number cites."""
    if not DB.exists():
        print("  CANNOT — no index. sentinel-hunt index"); return CANNOT
    con = sqlite3.connect(DB)
    rows = con.execute("SELECT name, file, sha256, bytes, rows, indexed_utc, "
                       "tool FROM corpus ORDER BY name").fetchall()
    stale = []
    live = load()
    for name, f, digest, nbytes, nrows, when, tool in rows:
        d = live.get(name)
        if not d:
            stale.append((name, "corpus is no longer in the library")); continue
        files = sorted(d.get("files", [d["file"]]))
        missing = [x for x in files if not x.exists()]
        if missing:
            stale.append((name, f"{len(missing)} file(s) gone")); continue
        parts = [sha_of(x) for x in files]
        if len(parts) == 1:
            cur = parts[0][0]
        else:
            roll = hashlib.sha256()
            for dg, _, _ in parts:
                roll.update(dg.encode())
            cur = roll.hexdigest()
        if not digest.startswith(cur[:16]):
            stale.append((name, "file(s) changed since indexing"))
    con.close()
    if as_json:
        print(json.dumps([{"corpus": r[0], "sha256": r[2], "bytes": r[3],
                           "rows": r[4], "indexed_utc": r[5], "tool": r[6]}
                          for r in rows], indent=2))
        return REVIEW if stale else OK
    print(f"  SNAPSHOT MANIFEST\n")
    print(f"  {'corpus':<20} {'rows':>12}  {'indexed':<20} sha256")
    for name, f, digest, nbytes, nrows, when, tool in rows:
        print(f"  {name:<20} {nrows:>12,}  {when[:19]:<20} {digest[:16]}…")
    print(f"\n  Cite this. A finding that cannot name the snapshot it came")
    print(f"  from cannot be rechecked by a reader, and a finding a reader")
    print(f"  cannot recheck is an assertion.")
    if stale:
        print(f"\n  STALE — the index no longer matches what is on disk:")
        for n, why in stale:
            print(f"    {n}: {why}")
        print(f"  sentinel-hunt index")
        return REVIEW
    return OK


def idx_lookup(key):
    """-> {corpus: [(lineno, raw, col, kind)]} from the index, or None."""
    if not DB.exists():
        return None
    con = sqlite3.connect(DB)
    out = defaultdict(list)
    for corpus, ln, col, raw, n in con.execute(
            "SELECT corpus, lineno, col, raw, norm FROM ent WHERE norm = ?",
            (key,)):
        out[corpus].append((ln, raw, col, "NAME"))
    for corpus, ln, col, raw, n in con.execute(
            "SELECT corpus, lineno, col, raw, norm FROM ent "
            "WHERE norm LIKE ? AND norm <> ?", (f"%{key}%", key)):
        out[corpus].append((ln, raw, col, "CONTAINS"))
    con.close()
    return dict(out)


def main():
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="verb", required=True)
    sub.add_parser("build")
    h = sub.add_parser("hunt");   h.add_argument("target"); h.add_argument("--top", type=int, default=3); h.add_argument("--minlevel", type=int, default=0)
    w = sub.add_parser("why");    w.add_argument("id", nargs="?")
    f = sub.add_parser("falsify");f.add_argument("claim")
    x = sub.add_parser("expected");x.add_argument("kind"); x.add_argument("subject")
    ch = sub.add_parser("chain"); ch.add_argument("target"); ch.add_argument("--cap", type=int, default=25)
    ch.add_argument("--no-fec", action="store_true",
                    help="skip hop 3 (the name-match hop) and finish fast")
    co = sub.add_parser("country"); co.add_argument("name"); co.add_argument("--cap", type=int, default=40)
    sub.add_parser("cols")
    ix = sub.add_parser("index"); ix.add_argument("--rebuild", action="store_true")
    sn = sub.add_parser("snapshot"); sn.add_argument("--json", action="store_true")
    cf = sub.add_parser("conflicts"); cf.add_argument("--cap", type=int, default=30)
    p.add_argument("--version", action="version", version=VERSION)
    fl = sub.add_parser("flag"); fl.add_argument("title")
    fl.add_argument("--level", type=int, default=0)
    fl.add_argument("--tags", default="")
    fl.add_argument("--from-last", action="store_true")
    ck = sub.add_parser("check"); ck.add_argument("id"); ck.add_argument("--to", default=None)
    sc = sub.add_parser("score"); sc.add_argument("id"); sc.add_argument("vals", nargs="*")
    dk = sub.add_parser("docket"); dk.add_argument("--json", action="store_true")
    br = sub.add_parser("brief"); br.add_argument("id")
    a = p.parse_args()

    if a.verb == "build":    return v_build()
    if a.verb == "hunt":     return v_hunt(a.target, a.minlevel, a.top)
    if a.verb == "why":      return v_why(a.id)
    if a.verb == "falsify":  return v_falsify(a.claim)
    if a.verb == "expected": return v_expected(a.kind, a.subject)
    if a.verb == "chain":    return v_chain(a.target, a.cap, a.no_fec)
    if a.verb == "country":  return v_country(a.name, a.cap)
    if a.verb == "cols":     return v_cols()
    if a.verb == "index":    return v_index(a.rebuild)
    if a.verb == "snapshot": return v_snapshot(a.json)
    if a.verb == "conflicts": return v_conflicts(a.cap)
    if a.verb == "flag":     return v_flag(a.title, a.level, a.tags, a.from_last)
    if a.verb == "check":    return v_check(a.id, a.to)
    if a.verb == "score":    return v_score(a.id, a.vals)
    if a.verb == "docket":   return v_docket(a.json)
    if a.verb == "brief":    return v_brief(a.id)


if __name__ == "__main__":
    sys.exit(main())
