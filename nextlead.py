#!/usr/bin/env python3
"""
nextlead.py — what to do next, why, and what would prove it wrong.

THIS IS THE PART THAT IS NOT A SEARCH TOOL
  Every OSINT product can run a query. The hard problem is the one an
  investigator actually has at 11pm: I have forty captures, six open
  questions and a contradiction I have not resolved — what do I do NEXT,
  and how do I know it was worth doing?

  This reasons over the SHAPE of the evidence, not its content:
    - which registers were never asked about this subject
    - which claims rest on one source when two exist
    - which entities appear in a registry but have never been tested in court
    - which questions have gone stale
    - which contradiction is blocking everything behind it

  It is deterministic. Same case in, same proposals out, and every proposal
  carries the specific absence that produced it. That is on purpose: a
  reasoning layer whose output you cannot audit is worth less here than one
  that is merely correct, because the whole desk runs on being able to say
  WHY.

THE RULE IT WILL NOT BREAK
  It proposes. It never concludes. Every proposal names a FALSIFIER — the
  record that would kill the theory — because your own `challenge` command
  asks for one and nothing in the desk generates it.

USAGE
  python3 nextlead.py CASE.json
  python3 nextlead.py CASE.json --edges edges.csv --top 12
  python3 nextlead.py CASE.json --json

EXIT  0 proposals emitted · 3 blocked (resolve the contradiction first)
      4 the case could not be read
"""
import argparse, csv, json, re, sys
from datetime import datetime, timezone
from pathlib import Path

OK, BLOCKED, CANNOT = 0, 3, 4

# Every register the desk can reach, and the ONE question it answers.
# "Never asked" is only computable against a list like this.
REGISTERS = {
    "opencorporates": ("does this entity exist as filed, and since when",
                       'bin/sentinel connect opencorporates "{e}"'),
    "courtlistener":  ("has it been a party to a published opinion",
                       'python3 cl.py find "\\"{e}\\"" - 2005-01-01'),
    "senatelda":      ("does it lobby federally, and who for",
                       'bin/sentinel connect senatelda "{e}"'),
    "usaspending":    ("has it taken federal money, in any instrument family",
                       'bin/sentinel connect awards "{e}" --all --pages 5'),
    "fec":            ("has it given or received political money",
                       'bin/sentinel connect fec "{e}"'),
    "federalregister":("does it appear in a rulemaking",
                       'bin/sentinel connect federalregister "{e}"'),
    "regulationsgov": ("has it commented on a rule",
                       'bin/sentinel connect regulationsgov "{e}"'),
    "opensanctions":  ("is it, or does it share a name with, a sanctioned party",
                       'bin/sentinel connect opensanctions "{e}"'),
    "propublica990":  ("if it is a nonprofit: revenue, officers, Schedule C lobbying",
                       'curl -s "https://projects.propublica.org/nonprofits/'
                       'api/v2/search.json?q={e}"'),
}

# Registers that answer a question no API here can. Naming them is the point:
# an absence in the graph is an absence of a CONNECTOR, not of a fact.
UNREACHABLE = {
    "county auditor": "who owns the parcel, and what it was valued at",
    "secretary of state": "officers and registered agent, per jurisdiction",
    "FARA": "foreign principals — the highest-value edge, still unbuilt",
    "state ethics": "the recipient's own disclosure of the same transaction",
}

STALE_DAYS = 21


def days_since(s):
    if not s:
        return None
    for f in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            d = datetime.strptime(str(s)[:len(f) + 6], f)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            return (datetime.now(timezone.utc) - d).days
        except ValueError:
            continue
    return None


def as_list(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return list(v.values())
    return [v] if v else []


def text_of(x):
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        for k in ("text", "question", "q", "title", "note", "subject", "name"):
            if x.get(k):
                return str(x[k])
        return json.dumps(x)[:160]
    return str(x)


def entities_from_edges(path, limit=40):
    """Subjects the library already holds, with how many registers named each."""
    seen = {}
    try:
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                for key in ("subject", "source", "from", "entity", "name", "a"):
                    v = (row.get(key) or "").strip()
                    if len(v) > 4:
                        src = (row.get("source_name") or row.get("register")
                               or row.get("connector") or "?")
                        seen.setdefault(v, set()).add(src)
                        break
    except (OSError, csv.Error):
        return {}
    return dict(sorted(seen.items(), key=lambda kv: -len(kv[1]))[:limit])


def propose(case, edges, top):
    P = []          # (priority, action, why, falsifier)
    subj = case.get("subject") or case.get("case_id") or "this case"
    contra = as_list(case.get("contradictions"))
    openq = as_list(case.get("questions_open"))
    exhibits = as_list(case.get("exhibits"))
    log = as_list(case.get("log"))

    # ── 1. a contradiction outranks everything ───────────────────────────
    for c in contra:
        P.append((0,
            f'bin/sentinel connect challenge "{subj}"',
            f"An unresolved contradiction is on file: {text_of(c)[:110]}",
            "Either the two records describe different periods or scopes — in "
            "which case write that down and close it — or one of them is wrong "
            "and the claim resting on it comes down."))

    # ── 2. exhibits with no claim behind them ────────────────────────────
    if exhibits and not case.get("claims"):
        P.append((1,
            f'bin/sentinel sdesk claim add {case.get("case_id","CASE")} "..."',
            f"{len(exhibits)} exhibit(s) are shelved and no claim references "
            f"them. Evidence with no claim is a folder, not an argument.",
            "If no claim can be written from these exhibits, the exhibits do "
            "not support the story you think they do."))

    # ── 3. stale open questions ──────────────────────────────────────────
    age = days_since(case.get("created_at"))
    if openq and age and age > STALE_DAYS:
        P.append((1,
            "python3 foia_compose.py  # then send it",
            f"{len(openq)} question(s) open on a case created {age} days ago. "
            f"Questions that sit are usually waiting on a record nobody "
            f"requested.",
            "If the record does not exist, a no-records response is itself "
            "publishable and closes the question."))

    # ── 4. registers never asked, per entity ─────────────────────────────
    for ent, asked in edges.items():
        low = {a.lower() for a in asked}
        missing = [k for k in REGISTERS
                   if not any(k in a or a in k for a in low)]
        if not missing:
            continue
        if len(asked) == 1:
            P.append((1,
                f'bin/sentinel connect all "{ent}"',
                f'"{ent}" is known to exactly one register '
                f'({", ".join(sorted(asked))}). One register is not a '
                f'footprint; it is one source saying something.',
                "If the other registers stay empty, that is a documented "
                "single-register entity — which is itself a finding about "
                "scale, not a dead end."))
        for k in missing[:2]:
            q, cmd = REGISTERS[k]
            P.append((2,
                cmd.format(e=ent),
                f'"{ent}" has never been put to {k} — {q}.',
                f"A clean result here is one register saying nothing. It "
                f"narrows the question; it does not answer it."))

    # ── 5. the comparison universe ───────────────────────────────────────
    if edges:
        P.append((2,
            "bin/sentinel connect coverage",
            f"{len(edges)} subject(s) in the library. Until comparable "
            f"entities have been run through the same registers, 'unusual' "
            f"has nothing to be unusual against.",
            "If comparable entities show the same pattern, the pattern is "
            "the norm and there is no story — which is worth knowing before "
            "you write one."))

    # ── 6. what no connector can reach ───────────────────────────────────
    for name, q in UNREACHABLE.items():
        P.append((3,
            f"# records request / manual pull — {name}",
            f"No connector answers: {q}. An absence in the graph here is an "
            f"absence of a CONNECTOR.",
            "This is the class of record that most often overturns a "
            "graph-derived theory, because the graph never saw it."))

    # ── 7. nothing has happened ──────────────────────────────────────────
    if not log and not exhibits:
        P.append((1,
            f'bin/sentinel connect all "{subj}"',
            "The case file is empty — no log, no exhibits.",
            "Nothing yet to falsify. Start by establishing the subject "
            "exists as filed."))

    P.sort(key=lambda x: x[0])
    return P[:top], bool(contra)


def main():
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("case")
    p.add_argument("--edges", default="edges.csv")
    p.add_argument("--top", type=int, default=12)
    p.add_argument("--json", action="store_true")
    a = p.parse_args()

    try:
        case = json.loads(Path(a.case).read_text())
    except Exception as e:
        print(f"CANNOT VERIFY — {a.case}: {type(e).__name__}: {e}")
        return CANNOT

    edges = entities_from_edges(a.edges) if Path(a.edges).is_file() else {}
    props, blocked = propose(case, edges, a.top)

    if a.json:
        print(json.dumps([{"priority": p, "action": c, "why": w,
                           "falsifier": f} for p, c, w, f in props], indent=2))
        return BLOCKED if blocked else OK

    subj = case.get("subject") or case.get("case_id")
    print(f"  NEXT LEADS — {subj}")
    print(f"  {len(as_list(case.get('exhibits')))} exhibit(s) · "
          f"{len(as_list(case.get('questions_open')))} open · "
          f"{len(as_list(case.get('contradictions')))} contradiction(s) · "
          f"{len(edges)} subject(s) in the library")
    if not edges:
        print(f"  NOTE  no {a.edges} — register-coverage rules did not run")

    band = {0: "BLOCKING", 1: "DO NEXT", 2: "WIDENS THE NET", 3: "OFF-GRAPH"}
    last = None
    for pri, cmd, why, fals in props:
        if pri != last:
            print(f"\n  ══ {band[pri]} ══")
            last = pri
        print(f"\n  $ {cmd}")
        print(f"    WHY   {why}")
        print(f"    KILLS IT   {fals}")

    print("\n  Every line above is a PROPOSAL. None of it is a finding, and")
    print("  nothing here can mark a claim, pass a gate, or publish.")
    if blocked:
        print("\n  BLOCKED — resolve the contradiction before new collection.")
        return BLOCKED
    return OK


if __name__ == "__main__":
    sys.exit(main())
