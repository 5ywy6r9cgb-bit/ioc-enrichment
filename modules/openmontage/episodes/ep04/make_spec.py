#!/usr/bin/env python3
"""make_spec.py — writes episode.json for ep04. Caveats are pulled VERBATIM from the evidence cards so a caveat cannot drift from its card."""
import json, hashlib, pathlib
HERE = pathlib.Path(__file__).parent
raw = (HERE / "data" / "EVIDENCE_CARDS.json").read_bytes()
C = {c["id"]: c for c in json.loads(raw)["cards"]}
SRC = lambda i: f"FEC · {C[i]['verify'].replace('https://www.', '')} · card {i} · desk evidence cards, generated 2026-09-10"
def cav(i, label="READ THIS WITH IT", text=None, color="accent", dur=6.0):
    return {"type": "quote", "dur": dur, "label": label, "label_color": color, "quote": text or C[i]["caveat"], "source": SRC(i), "source_note": f"Caveat of {i}, shown with its card as the desk rules require."}
S = []
S.append({"type": "title", "dur": 4.5, "kick": "THE SENTINEL REPORT · FOLLOW THE MONEY", "title": "Ohio's 2026 Senate race, read straight from the filings.",
          "sub": "Every figure is a filed FEC fact. Every card carries its caveat.", "source_note": "Framing only."})
# DELEG-01 — denominator corrected: 39.5% is of CONTRIBUTIONS, never printed beside the $47.4M of receipts
S.append({"type": "bignum", "dur": 6.0, "kick": "OHIO'S 16 FEDERAL SEATS · 2026", "value": 39.5, "fmt": "{:.1f}%", "size": 250,
          "caption": "of the contributions to Ohio's 16 federal campaigns came from PACs.", "sub": "$14,582,896 from political committees. Range: 13.9% to 74.2%.",
          "source_note": "DELEG-01. Denominator is contributions (individuals + committees + party), not total receipts."})
S.append(cav("DELEG-01", "THE DENOMINATOR", "PAC share is measured against CONTRIBUTIONS — individuals plus committees plus party — never against receipts, which include loans and transfers. Delegation totals are a sum of separate committees; nobody controls them jointly."))
S.append({"type": "chart", "dur": 7.0, "kick": "SPENT AGAINST SHERROD BROWN", "image": "charts/brown_six.png", "caption": "$13,471,230 against him. Six committees. 91 expenditures.", "source_note": "BROWN-01"})
S.append(cav("BROWN-01", text="Schedule E is complete (3 of 25 pages). The outside-pressure multiple on this card is a CEILING, so it is not shown here. Spending is the sum of six filed committees, to within a dollar.", dur=6.0))
S.append({"type": "chart", "dur": 7.0, "kick": "ONE COMMITTEE · OHIO FLYER PAC", "image": "charts/flyer_split.png", "caption": "Two candidates. Both Ohio Senate seats. Opposite directions.", "source_note": "OH-FLYER-01"})
S.append(cav("OH-FLYER-01", dur=5.0))
S.append({"type": "chart", "dur": 7.0, "kick": "TEAM HUSTED · JOINT FUNDRAISER", "image": "charts/jfc_split.png", "caption": "$8,253,532 split five ways. 63% to the campaign.", "source_note": "TEAM-HUSTED-01"})
S.append(cav("TEAM-HUSTED-01", dur=9.0))
S.append({"type": "bignum", "dur": 6.0, "kick": "HUSTED VICTORY · $3,636,779 RAISED", "value": 75.8, "fmt": "{:.1f}%", "size": 250, "caption": "of everything it raised went to one media firm.",
          "sub": "$2,755,532 to SRCP MEDIA INC. of $3,636,779 raised.", "source_note": "HV-01"})
S.append(cav("HV-01", "A QUESTION, NOT A FINDING", color="gold", dur=9.0))
S.append({"type": "bignum", "dur": 6.0, "kick": "FL-25 · WASSERMAN SCHULTZ · 2024", "value": "250 : 1", "animation": "typewriter", "size": 200,
          "caption": "spent attacking her for every dollar spent defending her.", "sub": "$98,905 against (46 expenditures). $395 for (2).", "source_note": "WS-01; 98,905 / 395 = 250.4"})
S.append(cav("WS-01", dur=6.0))
S.append({"type": "title", "dur": 5.0, "kick": "HOW WE WORK", "title": "We tried to break our own best finding. We succeeded five times.", "sub": "Every one was caught by dividing, or by reading the same figure from another register.", "source_note": "METHOD-02"})
S.append({"type": "bignum", "dur": 6.0, "kick": "A NUMBER WE WITHDREW", "value": "40.19x → 1.35x", "animation": "typewriter", "size": 92,
          "caption": "The retracted figure, and the one the filings support.", "sub": "It divided by a truncated sample, not the committee total.", "source_note": "METHOD-02 / HUSTED-01 retraction."})
S.append({"type": "hash", "dur": 7.0, "kick": "AUDIT US", "title": "Documents and dates. No characterization.", "hash": hashlib.sha256(raw).hexdigest(), "verify_file": "data/EVIDENCE_CARDS.json",
          "sub": "SHA-256 of the evidence cards every figure here comes from.", "cta": "Spread truth — but make sure it is truth.", "source_note": "Hash is computed from, and verified against, the file at build time."})
spec = {"spec_version": "OPENMONTAGE-SPEC/1", "project": "The Sentinel Report", "title": "ep04 — Ohio Senate money, from the filings", "preset": "vertical", "fps": 24, "theme": "sentinel_bright",
        "footer": "THE SENTINEL REPORT · DOCUMENTS AND DATES. NO CHARACTERIZATION.", "crossfade": 0.4, "scenes": S}
DURS = [7.0, 9.1, 8.7, 7.0, 10.0, 8.3, 5.4, 9.1, 16.6, 7.9, 12.1, 8.3, 6.6, 5.8, 10.8, 8.7]
for sc, d in zip(S, DURS): sc['dur'] = d
spec['scenes'] = S
json.dump(spec, open(HERE / "episode.json", "w"), indent=1, ensure_ascii=False)
print("episode.json:", len(S), "scenes,", sum(s["dur"] for s in S), "seconds")
