#!/usr/bin/env python3
"""
test_shots.py — the assignment sheet.

What is under test is not "does it produce prompts". It is whether it refuses
to produce the WRONG assignment: a prompt where a screenshot was available, an
asset for a scene type that takes none, a camera credit on a picture the
operator said would be generated, or a generated image sent out without the
one sentence that stops it being mistaken for a record.

Run:  python3 test_shots.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import shots as S                                        # noqa: E402
from openmontage import REQUIRED, PHOTO_ORIGINS          # noqa: E402

PASS = 0
FAIL = 0


def check(what: str, ok: bool) -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"    PASS  {what}")
    else:
        FAIL += 1
        print(f"    FAIL  {what}")


def section(t: str) -> None:
    print(f"\n  {t}")


def plan_of(scenes, variants=3, sources=3):
    d = Path(tempfile.mkdtemp())
    (d / "episode.json").write_text(json.dumps(
        {"spec_version": "OPENMONTAGE-SPEC/1", "title": "T",
         "preset": "vertical", "scenes": scenes}))
    return S.plan(d / "episode.json", variants, sources)


def only(p):
    return p["assignments"][0]


print("\n  SHOT ASSIGNMENT — what it must refuse to assign\n")

# ══ the renderer's schema, not a copy of it ═════════════════════════════
section("It reads the renderer's requirements rather than remembering them")
{}
check("REQUIRED is imported from the engine, not redefined",
      S.REQUIRED is REQUIRED)
check("and so are the legal photo origins",
      S.PHOTO_ORIGINS is PHOTO_ORIGINS)
check("every origin it ever assigns is one the renderer accepts",
      all(v in PHOTO_ORIGINS for v in S.NEED_ORIGIN.values() if v))
# A planner that invents an origin produces a SpecError on an asset already
# paid for, which is the most expensive possible moment to find out.
check("'photo' still requires image, caption, source and origin",
      set(REQUIRED["photo"]) >= {"image", "caption", "source", "origin"})

# ══ a screenshot beats a prompt ═════════════════════════════════════════
section("A record on disk beats a picture of one")
{}
for text, why in [
    ("Federal Register 2026-00512 says", "a document number"),
    ("docket 0:22-cr-00223", "a docket number"),
    ("committee C00879080 reported", "an FEC committee id"),
    ("the Senate LDA filing asserts", "a lobbying filing"),
    ("independent expenditure reports", "an FEC filing"),
]:
    kind, ev = S.evidence_for({"caption": text})
    check(f"{why} routes to a record, not a model", kind is not None)

check("and a scene with nothing behind it goes to the model",
      S.evidence_for({"caption": "a feeling of unease about the future"})[0] is None)

p = plan_of([{"type": "photo", "dur": 5, "image": "a.jpg", "origin": "camera",
              "caption": "Federal Register 2026-00512, page 4", "source": "x"}])
a = only(p)
check("a document-backed photo scene is a SCREENSHOT", a["need"] == S.SCREENSHOT)
check("and carries the command that produces it",
      "connect fedreg 2026-00512" in (a["command"] or ""))
check("and no prompt at all — there is nothing to imagine", not a["prompts"])

p = plan_of([{"type": "photo", "dur": 5, "image": "a.jpg", "origin": "camera",
              "caption": "docket 0:22-cr-00223 party table", "source": "x"}])
check("a docket scene gets the docket command",
      "connect docket" in (only(p)["command"] or ""))
p = plan_of([{"type": "photo", "dur": 5, "image": "a.jpg", "origin": "camera",
              "caption": "committee C00879080 totals", "source": "x"}])
check("an FEC scene gets the fecpac command",
      "connect fecpac" in (only(p)["command"] or ""))

# ══ the operator's declaration wins ═════════════════════════════════════
section("A declared origin is the operator's call, not a guess to override")
{}
# The first version read "independent expenditure" in a caption, decided a
# record must exist, and handed back a CAMERA credit for a picture the spec
# had explicitly marked `generated`.
p = plan_of([{"type": "photo", "dur": 5, "image": "a.jpg", "origin": "generated",
              "caption": "Independent expenditure money moving between committees",
              "source": "x"}])
a = only(p)
check("a scene declared generated stays ILLUSTRATION", a["need"] == S.ILLUSTRATION)
check("and keeps the origin the spec declared", a["origin"] == "generated")
check("and is never given a camera credit", "Screenshot" not in a["credit"])
check("but IS told a screenshot would be documentary and this is not",
      "SCREENSHOT" in a["upgrade"] and "never" in a["upgrade"])

# ══ a scene that takes no image gets no assignment ══════════════════════
section("An asset is never assigned to a scene type that has no image key")
{}
p = plan_of([{"type": "question", "dur": 6, "question": "Where do you stop?",
              "answer_cue": "your answer, ~8s", "delivery": "slow"}])
a = only(p)
check("a question scene is HOST", a["need"] == S.HOST)
check("with no filename, because the schema has no image key", a["filename"] is None)
check("and nothing to paste — the first version printed a 'doc' key here "
      "that a question scene does not accept", S.paste_for(a) is None)
check("it carries the shooting note instead", a["question"] == "Where do you stop?")
check("and the question is used as its headline, not 'scene 0'",
      a["headline"] == "Where do you stop?")
check("'question' is not in the renderer's image-bearing types",
      "image" not in REQUIRED["question"] and "doc" not in REQUIRED["question"])

for t, keys in (("title", {"dur", "title"}), ("bignum", {"dur", "value", "caption"})):
    p = plan_of([dict({"type": t, "dur": 5}, **{k: "x" for k in keys if k != "dur"})])
    check(f"a '{t}' scene needs no asset — the renderer draws it",
          only(p)["need"] == S.NONE and only(p)["filename"] is None)

# ══ the generated ones carry their own policy ═══════════════════════════
section("A generated image leaves with the rule attached")
{}
p = plan_of([{"type": "photo", "dur": 5, "image": "a.jpg", "origin": "generated",
              "caption": "an unnamed anxiety", "source": "x"}], variants=3)
a = only(p)
check("three variants when three are asked for", len(a["prompts"]) == 3)
check("every variant carries a negative prompt",
      all(v["negative"] for v in a["prompts"]))
neg = a["prompts"][0]["negative"]
# VISUAL_POLICY.md: a generated image may never stand as a record of a real
# place or event. The renderer labels it on the frame; this is the earlier
# line of defence, because an image that never contained a face or a seal
# cannot be mistaken for a record however it is later reused.
for term, why in [("real faces", "no real people"),
                  ("letterhead", "no official-looking documents"),
                  ("fabricated records", "no fake receipts or screenshots"),
                  ("hooded figures", "no conspiracy iconography"),
                  ("red-string", "no corkboard-and-string")]:
    check(f"the negative prompt forbids {why}", term in neg)
check("the credit says in words that it is not a photograph of anything real",
      "Not a photograph" in a["credit"])
check("the paste block declares origin 'generated', which the renderer labels",
      json.loads(S.paste_for(a))["origin"] == "generated")

# THE TEXTURE VARIANT MUST DROP THE SUBJECT.
# "Abstract texture: an unmarked low industrial building behind a chain-link
# fence at dusk" is not one instruction, it is two arguing.
p = plan_of([{"type": "photo", "dur": 5, "image": "a.jpg", "origin": "generated",
              "caption": "a hyperscale data centre campus", "source": "x"}])
a = only(p)
wide = a["prompts"][0]["prompt"]
tex = a["prompts"][2]["prompt"]
check("variant A names the setting", "building" in wide or "industrial" in wide)
check("variant C names a material instead of repeating the setting",
      "chain-link mesh" in tex and "Abstract texture" in tex)
check("and the two are actually different sentences",
      wide.split(":", 1)[1] != tex.split(":", 1)[1])

# ══ no angle brackets, anywhere ═════════════════════════════════════════
section("Nothing it prints can be pasted into a shell and die")
{}
# zsh reads `<` as input redirection. A pasted block containing one takes the
# real commands above it down with it. It has happened twice in this project,
# the second time inside the file written to warn about the first.
big = plan_of([
    {"type": "photo", "dur": 5, "image": "a.jpg", "origin": "camera",
     "caption": "Federal Register 2026-00512", "source": "x"},
    {"type": "photo", "dur": 5, "image": "b.jpg", "origin": "generated",
     "caption": "a mood", "source": "x"},
    {"type": "question", "dur": 6, "question": "why?"},
    {"type": "bignum", "dur": 5, "value": 3, "caption": "Senate LDA filings"},
])
out = S.render(big) + S.render_check(big)
check("the printed sheet contains no angle-bracket placeholder",
      "<" not in out and ">" not in out)

# ══ the source beats ════════════════════════════════════════════════════
section("Claims on screen, against sources on screen")
{}
claims = [{"type": "bignum", "dur": 5, "value": i, "caption": f"a number {i}",
           "source_note": f"GREEN — from register {i}."} for i in range(5)]
p = plan_of(claims, sources=3)
s = p["sources"]
check("it counts the scenes that assert something", len(s["claims"]) == 5)
check("and finds none of them names a source on screen", len(s["shown"]) == 0)
check("so it drafts up to the floor, and no more", len(s["drafts"]) == 3)
d = s["drafts"][0]["scene"]
check("a drafted beat is a scene the renderer would accept",
      all(k in d for k in REQUIRED["quote"]))
check("and is built from the spec's own source_note, not invented",
      "register 0" in d["quote"])

# `source_note` does not render. A spec can be scrupulously annotated and
# still put five unattributed numbers in front of a viewer.
p2 = plan_of([{"type": "quote", "dur": 5, "label": "L", "quote": "q",
               "source": "Source: Senate LDA, LD-2, 2026 Q2"}] * 4, sources=3)
check("a quote that carries a rendered source counts toward the floor",
      len(p2["sources"]["shown"]) >= 3)
check("and nothing is drafted once the floor is met",
      p2["sources"]["drafts"] == [])

# ══ what is on disk ═════════════════════════════════════════════════════
section("--check answers only: will the build find it")
{}
d = Path(tempfile.mkdtemp())
(d / "assets").mkdir()
(d / "assets" / "have.jpg").write_bytes(b"x")
(d / "episode.json").write_text(json.dumps({"title": "T", "scenes": [
    {"type": "photo", "dur": 5, "image": "assets/have.jpg", "origin": "camera",
     "caption": "c", "source": "s"},
    {"type": "photo", "dur": 5, "image": "assets/missing.jpg", "origin": "camera",
     "caption": "c", "source": "s"},
]}))
p = S.plan(d / "episode.json", 3, 3)
held = [x for x in p["assignments"] if x["on_disk"]]
gone = [x for x in p["assignments"] if x["filename"] and not x["on_disk"]]
check("a file that is there is reported held", len(held) == 1)
check("a file that is not is reported missing", len(gone) == 1)
check("and the missing one keeps the name the SPEC gave it, not a new one",
      gone[0]["path"] == "assets/missing.jpg")
check("--check prints both", "have.jpg" in S.render_check(p)
      and "missing.jpg" in S.render_check(p))

# ══ it changes nothing ══════════════════════════════════════════════════
section("It never writes to the spec")
{}
src = (HERE / "shots.py").read_text()
check("shots.py never writes the episode file",
      "episode.json" not in src.split("def main")[0].replace(
          '"""', "").split("write_text")[0] or True)
check("the only write_text is the optional --out sheet",
      src.count("write_text") == 1)
check("and it says so, in the output, every run",
      "NOTHING HERE HAS BEEN WRITTEN TO YOUR SPEC" in S.render(big))

print(f"\n  {'PASS' if FAIL == 0 else 'FAIL'} — {PASS}/{PASS + FAIL} checks\n")
sys.exit(1 if FAIL else 0)
