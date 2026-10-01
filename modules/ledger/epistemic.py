# -*- coding: utf-8 -*-
"""The Sentinel Epistemic Rule, applied to a draft.

The system may discover patterns, propose relationships and generate hypotheses. It must never
silently promote:

  sequence → causation          co-occurrence → relationship    relationship → coordination
  payment → direction           access → influence              incentive → motive
  secrecy → wrongdoing          absence from search → nonexistence
  rarity in corpus → rarity in reality                          allegation → fact

The number gate checks every figure. This checks the verbs. For each sentence it finds the words
that promote, finds the named parties the ledger knows, looks up the typed relationships between
them (class and causal rung C0–C7), and asks whether the evidence reaches the claim.

  FAIL  the sentence claims more than the ledger's evidence reaches, or states an allegation as fact
  WARN  a promotion word with no two known parties to check against; attribute it or cut it
"""
import re

ATTRIB_CUE = re.compile(r"\b(alleg\w*|according to|per the|per its|the (affidavit|indictment|complaint|filing|report|record|order|designation|"
                        r"solicitation|statement|registration)|charg\w*|said|says|claims?|claimed|asserts?|asserted|stated|wrote|described|"
                        r"called|lists?|listed|labell?ed|designat\w*|filed|reported)\b", re.I)
SCOPE_CUE = re.compile(r"\b(we found|we reviewed|we searched|searched|as of|in (the|our|these|this|its) (records?|data|filings?|register|registers|"
                       r"database|index|ledger|capture|corpus|documents|sample|rows)|among (the )?\w+|of the \d[\d,]*|reviewed|examined|captured|"
                       r"in (the )?[A-Z][A-Za-z]+ (register|database|index|filings?))\b", re.I)

PROMOTIONS = [
    {"id": "SEQUENCE_TO_CAUSATION", "rule": "sequence → causation",
     "re": r"\b(caused|causes|causing|led to|leads to|leading to|resulted in|results in|as a result of|because of|triggered|prompted|"
           r"in response to|in return for|in exchange for|quid pro quo|payback|paid off)\b",
     "need": {"rung": 6},
     "fix": "Say what happened and in what order ('after', 'weeks later'). Causation needs a document showing the effect (C6 or higher)."},
    {"id": "COOCCURRENCE_TO_RELATIONSHIP", "rule": "co-occurrence → relationship",
     "re": r"\b(linked to|tied to|ties to|connected to|connections? to|associated with|in league with|part of (a|the|his|her|their) network)\b",
     "need": {"rung": 2, "edge": True},
     "fix": "Name the record that links them ('both appear on the same filing'), or drop the link."},
    {"id": "RELATIONSHIP_TO_COORDINATION", "rule": "relationship → coordination",
     "re": r"\b(coordinat\w+|collud\w+|collusion|in concert|orchestrat\w+|conspir\w+|worked together|working together|jointly|in tandem|"
           r"in lockstep|teamed up)\b",
     "need": {"rung": 4, "classes": ["COORDINATION"]},
     "fix": "A shared vendor, treasurer or filing is a relationship, not coordination. Say what the record shows."},
    {"id": "PAYMENT_TO_DIRECTION", "rule": "payment → direction",
     "re": r"\b(at the direction of|directed by|on (the )?orders? of|instructed|controlled by|bankroll\w*|bought and paid for|puppets?|"
           r"pulls? the strings|marching orders|doing the bidding)\b",
     "need": {"rung": 4, "classes": ["DIRECTION", "AUTHORITY", "ORGANIZATIONAL"]},
     "fix": "Payment shows money moved. Direction needs a document showing one party instructing the other."},
    {"id": "ACCESS_TO_INFLUENCE", "rule": "access → influence",
     "re": r"\b(influenced|swayed|shaped (the )?(policy|law|vote|bill|decision)|won over|secured (the |his |her |their )?votes?|"
           r"delivered (the )?votes?|in (the )?pocket of|bought (the |his |her |their )?votes?)\b",
     "need": {"rung": 6},
     "fix": "A meeting, a donation or a registration shows access. Influence needs a document showing the decision changed (C6 or higher)."},
    {"id": "INCENTIVE_TO_MOTIVE", "rule": "incentive → motive",
     "re": r"\b(in order to|so (that )?(he|she|they|it) could|motivated by|wanted to|sought to|aimed to|in a bid to|to curry favou?r)\b",
     "need": {"quote": True},
     "fix": "Motive needs the actor's own words in a quoted document. Otherwise state the incentive as a question."},
    {"id": "SECRECY_TO_WRONGDOING", "rule": "secrecy → wrongdoing",
     "re": r"\b(secretly|secretive|hidden|hid|conceal(ed|ing|ment)?|shadowy|dark money|cover[- ]?up|behind closed doors|under the radar|covertly)\b",
     "need": {"attrib": True},
     "fix": "Say what is not disclosed and where you looked ('not itemized in the filing'). If an official record calls it covert, attribute it."},
    {"id": "ABSENCE_TO_NONEXISTENCE", "rule": "absence from search → nonexistence",
     "re": r"\b(no records? exists?|does not exist|doesn't exist|never (filed|disclosed|reported|registered)|nothing on file|no such (record|filing))\b",
     "need": {"scope": True},
     "fix": "Say where you searched and when: 'We found no … in the [register] as of [date].'"},
    {"id": "RARITY_TO_REALITY", "rule": "rarity in corpus → rarity in reality",
     "re": r"\b(unprecedented|never before|first[- ]ever|the only one|uniquely|record[- ]breaking|(largest|biggest|most|first)\b[^.;]{0,60}\bever)\b",
     "need": {"scope": True},
     "fix": "Bound it to what you examined: 'the largest in the filings we reviewed'."},
]
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"“'(\[])|\n{2,}|\n(?=#)")
QUOTED = re.compile(r"“[^”]*”|\"[^\"]*\"")


def _variants(e):
    out = set()
    names = [e.get("name") or ""] + list(e.get("aliases") or [])
    for n in names:
        n = n.strip()
        if not n:
            continue
        out.add(n)
        base = re.sub(r"\s*\([^)]*\)", "", n).strip()
        out.add(base)
        m = re.search(r"\(([^)]+)\)", n)
        if m:
            out.add(m.group(1).strip())
        out.add(re.sub(r",?\s+(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Corporation|Company|Co\.|Ltd\.?|GmbH|PLLC|LP|LLP)$", "", base).strip())
    return [v for v in out if len(v) >= 3]


class Matcher(object):
    def __init__(self, ledger):
        pats = []
        for e in ledger.get("entities", []):
            if e["id"].startswith("E:unknown"):
                continue
            for v in _variants(e):
                if v.isupper() and len(v) <= 6:
                    pats.append((re.compile(r"\b" + re.escape(v) + r"\b"), e["id"], len(v)))
                elif len(v) >= 5:
                    pats.append((re.compile(r"\b" + re.escape(v) + r"\b", re.I), e["id"], len(v)))
        pats.sort(key=lambda p: -p[2])
        self.pats = pats
        self.names = {e["id"]: e.get("name") for e in ledger.get("entities", [])}

    def find(self, text):
        found, taken = [], []
        for rx, eid, _ in self.pats:
            for m in rx.finditer(text):
                if any(a < m.end() and m.start() < b for a, b in taken):
                    continue
                taken.append((m.start(), m.end()))
                if eid not in found:
                    found.append(eid)
        return found


ABBREV = {"v", "vs", "no", "nos", "inc", "co", "corp", "ltd", "llc", "mr", "mrs", "ms", "dr", "st", "jr", "sr", "gov", "sen", "rep",
          "sec", "art", "p", "pp", "para", "fig", "e.g", "i.e", "etc", "approx", "est", "dept", "gen", "col", "lt", "u.s", "u.k", "d.c"}


def sentences(text):
    """Split into sentences without breaking on 'U.S.', 'v.', 'No.', initials or section numbers."""
    for block in re.split(r"\n{2,}|\n(?=#)", text):
        start = 0
        for m in re.finditer(r"[.!?]['\"”’)]*\s+(?=[A-Z\"“'(\[])", block):
            before = block[start:m.start() + 1]
            tok = re.search(r"([A-Za-z.]+)\.$", before)
            word = tok.group(1).lower() if tok else ""
            if word in ABBREV or re.fullmatch(r"[a-z]", word) or re.fullmatch(r"([a-z]\.)+[a-z]?", word):
                continue
            s = block[start:m.end()].strip()
            if s:
                yield s
            start = m.end()
        s = block[start:].strip()
        if s:
            yield s


MONEY_SAY = {
    "IE_SUPPORT": "spent supporting (independent expenditures, as reported)", "IE_OPPOSE": "spent opposing (independent expenditures, as reported)",
    "CONTRACT_SCHEDULE": "scheduled payments to (per the filing; payment not shown)", "CONTRACT_TERMS": "agreed terms with (per the agreement)",
    "AWARD_VALUE": "received awards valued at (per the award record)", "AWARD_AGGREGATE": "received awards valued at (per the award records)",
    "LOBBYING_INCOME": "was paid to lobby for (per the LDA filings)", "ALLEGED_TRANSFER": "allegedly transferred (per the charging document)",
}
MONEY_CLASS = {
    "CONTRACT_SCHEDULE": "CONTRACTUAL", "CONTRACT_TERMS": "CONTRACTUAL", "AWARD_VALUE": "CONTRACTUAL", "AWARD_AGGREGATE": "CONTRACTUAL",
    "IE_SUPPORT": "ADVOCACY", "IE_OPPOSE": "ADVOCACY", "LOBBYING_INCOME": "REPRESENTATION",
}


def _edges(ledger, ents):
    """Typed relationships between the named parties, plus money rows read as documented interactions
    (a payment record shows money moved: FINANCIAL at C4, never DIRECTION)."""
    es = set(ents)
    out = [r for r in ledger.get("relationships", []) if r["from"] in es and r["to"] in es and r["from"] != r["to"]]
    for m in ledger.get("money_flows", []):
        if m["from"] in es and m["to"] in es and m["from"] != m["to"]:
            out.append({"id": m["id"], "from": m["from"], "to": m["to"], "rel_class": MONEY_CLASS.get(m["kind"], "FINANCIAL"),
                        "rung": 4, "alleged": m.get("evidence_class") == "SWORN_ALLEGATION" or m["kind"] == "ALLEGED_TRANSFER",
                        "money_kind": m["kind"]})
    return out


def check(text, ledger):
    """Returns a list of issues; each has status FAIL or WARN."""
    say = ledger.get("vocabularies", {}).get("say", {})
    ladder = ledger.get("vocabularies", {}).get("causal_ladder") or []
    rung_name = {i: (x[1] if isinstance(x, (list, tuple)) else x) for i, x in enumerate(ladder)}
    mt = Matcher(ledger)
    issues = []
    for s in sentences(text):
        if s.startswith(">") or s.startswith("```"):
            continue
        bare = QUOTED.sub(" ", s)
        ents = mt.find(s)
        edges = _edges(ledger, ents)
        best = max(edges, key=lambda r: r.get("rung", 0)) if edges else None
        attrib = bool(ATTRIB_CUE.search(s))
        scoped = bool(SCOPE_CUE.search(s))
        for p in PROMOTIONS:
            m = re.search(p["re"], bare, re.I)
            if not m:
                continue
            need = p["need"]
            base = {"sentence": s, "rule": p["rule"], "code": p["id"], "word": m.group(0), "parties": [mt.names.get(e, e) for e in ents],
                    "fix": p["fix"], "basis": None}
            if "scope" in need:
                if not scoped:
                    issues.append(dict(base, status="FAIL", message="'{}' generalizes from what was searched to what exists.".format(m.group(0))))
                continue
            if "attrib" in need:
                if not attrib:
                    issues.append(dict(base, status="FAIL", message="'{}' turns a gap in disclosure into wrongdoing.".format(m.group(0))))
                continue
            if "quote" in need:
                if not QUOTED.search(s) or not attrib:
                    issues.append(dict(base, status="FAIL", message="'{}' states a motive. Motive needs the actor's own words.".format(m.group(0))))
                continue
            if len(ents) < 2:
                issues.append(dict(base, status="WARN", message="'{}' promotes {}, and the sentence names no two parties the ledger "
                                   "knows, so it cannot be checked.".format(m.group(0), p["rule"])))
                continue
            if need.get("edge") and not edges:
                issues.append(dict(base, status="FAIL", message="The ledger holds no relationship between {}.".format(" and ".join(base["parties"][:3]))))
                continue
            ok_edges = [r for r in edges if r.get("rung", 0) >= need.get("rung", 0) and
                        (not need.get("classes") or r.get("rel_class") in need["classes"])]
            if ok_edges:
                if any(r.get("alleged") for r in ok_edges) and not attrib:
                    issues.append(dict(base, status="FAIL", code="ALLEGATION_TO_FACT", rule="allegation → fact",
                                       basis=[r["id"] for r in ok_edges][:4],
                                       message="The ledger supports this only as an allegation ({}); say whose.".format(", ".join(r["id"] for r in ok_edges[:3])),
                                       fix="Attribute it: 'according to the affidavit', 'the indictment alleges'."))
                continue
            if best is None:
                msg = "The ledger holds no relationship between these parties."
            else:
                msg = "The strongest record between them is {} {} at C{} ({}). '{}' needs {}{}.".format(
                    best["id"], best.get("rel_class"), best.get("rung", 0), rung_name.get(best.get("rung", 0), ""), m.group(0),
                    "C{}".format(need.get("rung", 0)), " and class " + "/".join(need["classes"]) if need.get("classes") else "")
                phrase = MONEY_SAY.get(best.get("money_kind")) or say.get(best.get("rel_class"))
                if phrase:
                    base["fix"] = "What the record supports: '{}'. ".format(phrase) + p["fix"]
            issues.append(dict(base, status="WARN" if attrib and best is None else "FAIL", basis=[best["id"]] if best else None, message=msg))
        # allegation → fact through a relationship verb, even without a promotion word
        alleged = [r for r in edges if r.get("alleged")]
        if alleged and not attrib and not any(i["sentence"] == s for i in issues):
            words = {"DIRECTION": r"\b(direct\w*|instruct\w*|order\w*)\b", "DEPENDENCY": r"\bus(ed|es|ing)\b",
                     "ORGANIZATIONAL": r"\b(operat\w+|ran|runs|develop\w+|manag\w+|own\w*)\b", "FINANCIAL": r"\b(paid|fund\w*|financ\w+)\b"}
            for r in alleged:
                w = words.get(r.get("rel_class"))
                if w and re.search(w, bare, re.I):
                    issues.append({"sentence": s, "rule": "allegation → fact", "code": "ALLEGATION_TO_FACT", "word": re.search(w, bare, re.I).group(0),
                                   "parties": [mt.names.get(e, e) for e in ents], "basis": [r["id"]], "status": "FAIL",
                                   "message": "{} rests on a sworn allegation ({}), stated here as fact.".format(r.get("rel_class"), r["id"]),
                                   "fix": "Attribute it: 'according to the affidavit', 'the indictment alleges'."})
                    break
    return issues


def render(issues):
    out = ["EPISTEMIC RULE  (verbs checked against typed relationships and the causal ladder)"]
    if not issues:
        out.append("  clean: no sentence promotes past its evidence")
        return "\n".join(out)
    for i in issues:
        out.append("  {:<4} {}  '{}'".format(i["status"], i["rule"], i["word"]))
        out.append("       " + i["message"])
        out.append("       fix: " + i["fix"])
        out.append("       “" + (i["sentence"][:220] + ("…" if len(i["sentence"]) > 220 else "")) + "”")
    f = sum(1 for i in issues if i["status"] == "FAIL")
    w = sum(1 for i in issues if i["status"] == "WARN")
    out.append("  {} fail · {} warn".format(f, w))
    return "\n".join(out)
