#!/usr/bin/env python3
"""
shots.py — THE ASSIGNMENT SHEET.

─────────────────────────────────────────────────────────────────────────────
WHAT THIS IS FOR

An episode spec is a list of scenes. Some of them need a picture, and the
renderer will refuse to build until that picture is on disk with a stated
origin and a credit. Finding out WHICH pictures, one `SpecError` at a time,
is the slowest possible way to learn it.

This reads the spec and hands back the whole assignment at once: every image
the build will demand, the exact filename to save it as, what kind of image it
is allowed to be, and — for the generated ones — two or three prompts to
choose between. The pictures get made somewhere else, by whatever tool is
cheapest, and dropped into `assets/`. Then the build runs.

─────────────────────────────────────────────────────────────────────────────
THE PART THAT MATTERS MORE THAN THE PROMPTS

Most of what a documentary episode about public records needs IS NOT A
GENERATED IMAGE. It is a screenshot of the document, or of the terminal that
pulled the document. Those are:

  * documentary — `own_screenshot` under VISUAL_POLICY.md, so they may stand
    as a record of a real thing, which a generated image may never do
  * free — no model, no credits, no queue
  * already in hand — the bytes are in evidence/captures/, hashed, in the
    ledger

So this classifies before it prompts. A scene that quotes a Federal Register
notice gets a SCREENSHOT assignment with the command that produces it, not an
art prompt. Only the scenes with nothing documentary behind them get sent to a
model, and those come back labelled ILLUSTRATION with a negative prompt
attached, because VISUAL_POLICY.md says a generated image is never a record
and the cheapest place to enforce that is in the prompt itself.

─────────────────────────────────────────────────────────────────────────────
AND THE SOURCE BEATS

A run of eight claim-bearing scenes with no scene explaining where any of it
came from is a montage, not journalism. This counts the claims, counts the
scenes that carry a source, and says plainly when the ratio is wrong — with
drafted source scenes built from the `source_note` fields already in the spec.

Nothing here writes to the spec. It prints what to paste, the way
`desk_bootstrap.sh` prints `claim add` lines instead of running them: a script
that edits your episode for you is a script that takes authorship of it.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Imported, NOT copied. A planner that carries its own idea of what the
# renderer requires is a planner that drifts, and the first you hear of it is
# a SpecError on an asset you already paid to generate.
from openmontage import REQUIRED, PHOTO_ORIGINS   # noqa: E402


# ───────────────────────────────────────────────────────────── the categories
#
# What KIND of visual a scene needs. This is the whole decision — the prompts
# are downstream of it, and three of these four need no prompt at all.
SCREENSHOT = "SCREENSHOT"      # documentary, free, already in hand
CAMERA = "CAMERA"              # a still you have to go and shoot
HOST = "HOST"                  # YOU, on camera — a performance, not an asset
ILLUSTRATION = "ILLUSTRATION"  # generated; labelled on frame; never a record
NONE = "NONE"                  # the scene draws itself from type and text

NEED_ORIGIN = {
    SCREENSHOT: "camera",      # own_screenshot is documentary; the renderer's
                               # vocabulary for "you made it" is `camera`
    CAMERA: "camera",
    HOST: None,                # nothing is saved to assets/ for a host scene
    ILLUSTRATION: "generated",
    NONE: None,
}

# A `question` scene is the one place the episode stops being a montage and
# becomes a person answering. The renderer draws the question card and leaves
# room; there is no image key on the schema and never was. The first version
# of this file handed out filenames for them and printed a `doc` key that a
# question scene does not accept — an assignment to produce an asset the
# renderer would have refused. What these need is a shooting note.
HOST_TYPES = {"question"}

# Scenes that assert something — a number, a quotation, a chart. These are the
# ones that need a source on screen, and the ones a source beat is counted
# against.
CLAIM_TYPES = {"bignum", "quote", "chart", "vchart", "hash"}

# Scenes the renderer draws entirely from the spec. Asking for art here adds a
# picture nobody needs and a credit nobody can write.
SELF_DRAWING = {"title", "bignum", "vchart", "hash", "question"}


# ──────────────────────────────────────────────── is there a document behind it
#
# The test is deliberately textual and deliberately generous. A false
# SCREENSHOT costs a look at the evidence directory; a false ILLUSTRATION
# costs a generated picture standing in for a document that was on disk the
# whole time. Those are not symmetric.
DOC_MARKERS = [
    (r"\b(19|20)\d{2}-\d{3,6}\b", "a Federal Register document number"),
    (r"\b\d:\d{2}-[a-z]{2}-\d{3,5}\b", "a court docket number"),
    (r"\bC00\d{6}\b", "an FEC committee id"),
    (r"\b[0-9a-f]{64}\b", "a sha256"),
    (r"federal register|fed\.? reg\.?", "the Federal Register"),
    (r"\bdocket\b|\bindictment\b|\bcomplaint\b", "a court record"),
    (r"\bsenate lda\b|lobbying disclosure|\bregistrant\b|\bLD-[12]\b", "a lobbying filing"),
    (r"\bschedule [ab]\b|\bFEC\b|independent expenditure", "an FEC filing"),
    (r"\busaspending\b|award id|\bcontract\b|\bsolicitation\b", "a federal award record"),
    (r"\bopencorporates\b|incorporat|registered agent", "a corporate registration"),
    (r"\bexhibit\b|\bfiling\b|\bstatute\b|\bR\.C\.\s*\d", "a filed document or statute"),
]

TERMINAL_MARKERS = [
    (r"bin/sentinel|sentinel connect|sentinel sdesk", "a sentinel run"),
    (r"\bcapture\b|\bledger\b|provenance", "the capture ledger"),
]


def evidence_for(scene: dict) -> tuple[str | None, str]:
    """
    (kind, why) — is there a primary record behind this scene?

    Reads every text field on the scene, because the document number that
    identifies the record is as likely to be in `source` or `source_note` as
    in the quote itself.
    """
    blob = " ".join(
        str(scene.get(k, ""))
        for k in ("title", "sub", "kick", "caption", "quote", "label",
                  "source", "source_note", "vo", "question", "cta")
    ).lower()
    for pat, why in TERMINAL_MARKERS:
        if re.search(pat, blob, re.I):
            return "terminal", why
    for pat, why in DOC_MARKERS:
        if re.search(pat, blob, re.I):
            return "document", why
    return None, ""


def identifier_in(scene: dict) -> str | None:
    """The first document/docket/committee id anywhere on the scene."""
    blob = " ".join(str(v) for v in scene.values() if isinstance(v, str))
    for pat in (r"\b(19|20)\d{2}-\d{3,6}\b", r"\b\d:\d{2}-[a-z]{2}-\d{3,5}\b",
                r"\bC00\d{6}\b"):
        m = re.search(pat, blob, re.I)
        if m:
            return m.group(0)
    return None


def command_for(scene: dict, kind: str) -> str | None:
    """
    The command that PRODUCES the screenshot, so the assignment is a thing to
    run rather than a thing to go and find.
    """
    ident = identifier_in(scene)
    if kind == "terminal":
        return "bin/sentinel connect nexus --asserted     # then screenshot the terminal"
    if not ident:
        return None
    if re.fullmatch(r"(19|20)\d{2}-\d{3,6}", ident):
        return f'bin/sentinel connect fedreg {ident} --text     # then screenshot the passage'
    if re.fullmatch(r"\d:\d{2}-[a-z]{2}-\d{3,5}", ident, re.I):
        return f'bin/sentinel connect docket "{ident}"     # then screenshot the party table'
    if re.fullmatch(r"C00\d{6}", ident):
        return f'bin/sentinel connect fecpac --committee {ident}     # then screenshot the totals'
    return None


# ────────────────────────────────────────────────────────────── the look
#
# Prompts that match the rendered frame rather than fighting it. The theme is
# `sentinel_light`: paper (233,235,238), ink (18,22,28), one accent red
# (163,34,34). A saturated cinematic image dropped into that palette looks
# like a different programme.
LOOK = (
    "restrained editorial documentary still; desaturated near-monochrome with "
    "a single muted red accent; paper-grey and ink-black palette; soft even "
    "daylight; shallow depth of field; 35mm; fine grain; no text, no logos, "
    "no watermarks"
)

# THE NEGATIVE PROMPT IS THE EDITORIAL POLICY, WRITTEN WHERE IT BINDS.
#
# VISUAL_POLICY.md: a generated image may never stand as a record of a real
# place or event. The renderer labels it on the frame, which is the last line
# of defence. This is the first: an image that never contained a real face, a
# real seal or a plausible document cannot be mistaken for one later, however
# it gets reused.
NEGATIVE = (
    "no recognisable real people, no real faces, no politicians, no celebrity "
    "likeness; no government seals, crests, flags or letterhead; no readable "
    "or plausible official document; no fabricated records, receipts or "
    "screenshots; no identifiable real building presented as itself; no "
    "hooded figures, no red-string boards, no shadowy silhouettes, no "
    "surveillance-thriller imagery; no text of any kind"
)

# Three angles on the same beat, so the choice is between framings rather than
# between rolls of the same dice.
ANGLES = [
    ("A", "wide establishing", "the setting, empty of people, held at a distance"),
    ("B", "close detail", "one object or surface that carries the whole idea"),
    ("C", "abstract texture", "form, light and material only — no subject at all"),
]

# What variant C is a texture OF. The first version simply prefixed the same
# sentence with "Abstract texture:", producing "Abstract texture: an unmarked
# low industrial building behind a chain-link fence at dusk" — which is not an
# instruction, it is two instructions arguing. A texture variant has to drop
# the subject and name the material.
TEXTURES = [
    (r"fence|industrial|building|warehouse",
     "galvanised chain-link mesh in shallow focus, concrete beyond"),
    (r"transmission|lines|pylon|farmland",
     "weathered steel lattice and insulator glass against flat sky"),
    (r"field|stakes|tape|graded",
     "turned earth and surveyor's tape, close, raking light"),
    (r"corridor|doors|marble|office",
     "polished stone floor and the base of a closed door, low angle"),
    (r"cabinet|drawer|filing",
     "the edges of paper files in an open drawer, one lit edge"),
    (r"bench|courtroom|gallery|gymnasium|booth",
     "worn varnished wood grain, empty, side-lit"),
    (r"phone|screen|table|formica",
     "a dark matte glass surface with one soft reflected highlight"),
    (r"volume|spine|library|book|paper",
     "stacked paper edges and cloth binding, macro, no lettering"),
    (r"microphone|dais|hearing|chairs",
     "brushed metal and felt, shallow focus, no room visible"),
]


def texture_for(subj: str) -> str:
    for pat, tex in TEXTURES:
        if re.search(pat, subj, re.I):
            return tex
    return "plain institutional surfaces — painted cinderblock and worn linoleum, close"


def subject_for(scene: dict) -> str:
    """
    A plain-language subject drawn from the scene's own words.

    Not a paraphrase of the claim — an OBJECT. "$45.7 million in independent
    expenditures" is not a photograph; a filing cabinet, a printer, an empty
    hearing room are. Keeping the prompt on objects is most of what stops a
    generated image from drifting into illustrating an allegation.
    """
    text = " ".join(
        str(scene.get(k, "")) for k in ("caption", "kick", "label", "title", "sub")
    ).lower()
    table = [
        (r"data ?cent|server|rack|cloud|hyperscale",
         "an unmarked low industrial building behind a chain-link fence at dusk"),
        (r"power|energy|grid|megawatt|utility|tariff|transmission",
         "high-voltage transmission lines crossing farmland under flat grey sky"),
        (r"land|parcel|acre|farm|county|zoning|deed",
         "surveyor's stakes and orange tape in an empty graded field"),
        (r"lobby|registrant|filing|disclosure|firm",
         "a row of closed office doors along an empty marble corridor"),
        (r"money|contribut|expenditure|donor|payment|vendor|\$",
         "a bank of grey filing cabinets, one drawer open, lit from one side"),
        (r"court|docket|indict|defendant|judge|prosecut",
         "empty wooden gallery benches in a courtroom, morning light"),
        (r"vote|ballot|election|precinct|poll",
         "a folded cardboard voting booth in an empty school gymnasium"),
        (r"platform|social|feed|post|bot|account|algorithm",
         "a phone face-down on a formica table, screen dark"),
        (r"record|document|archive|register|file",
         "stacked bound paper volumes on a library table, spines unlabelled"),
        (r"hearing|commission|board|agency|regulat",
         "an empty public hearing room, microphones on the dais, chairs unoccupied"),
    ]
    for pat, subj in table:
        if re.search(pat, text):
            return subj
    return "an empty municipal office interior, blinds half-drawn, no people"


def prompts_for(scene: dict, n: int) -> list[dict]:
    subj = subject_for(scene)
    out = []
    for tag, framing, note in ANGLES[:max(1, min(n, len(ANGLES)))]:
        # C drops the subject entirely. A texture is not a wide shot with a
        # different adjective in front of it.
        body = texture_for(subj) if tag == "C" else subj
        out.append({
            "variant": tag,
            "framing": framing,
            "note": note,
            "prompt": f"{framing.capitalize()}: {body}. {LOOK}.",
            "negative": NEGATIVE,
        })
    return out


# ──────────────────────────────────────────────────────────── the assignment
def slug(s: str, n: int = 28) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")[:n] or "scene"


def assign(scene: dict, i: int, variants: int) -> dict:
    st = str(scene.get("type", "")).strip()
    label = slug(scene.get("kick") or scene.get("label") or scene.get("title")
                 or scene.get("caption") or scene.get("question") or st)
    stem = f"s{i:02d}_{slug(st, 10)}_{label}"

    # A scene that already names its image is not an assignment. It is either
    # done or it is a missing file, and `--check` is where that belongs.
    have = scene.get("image") or scene.get("doc")

    if st in HOST_TYPES:
        need, why = HOST, "you, on camera — the schema takes no image here"
    elif st == "photo":
        need, why = None, ""     # decided below; a photo scene always needs one
    elif st in SELF_DRAWING and not have:
        need, why = NONE, f"the renderer draws a '{st}' scene from the spec alone"
    else:
        need, why = None, ""

    kind, ev = evidence_for(scene)

    # A DECLARED ORIGIN IS THE OPERATOR'S CALL, NOT A GUESS TO OVERRIDE.
    #
    # The first version read "independent expenditure" in a caption, decided a
    # record must exist, and reclassified a scene the operator had explicitly
    # marked `origin: generated` — handing back a camera credit for a picture
    # that was going to be generated. The keyword test is a suggestion engine;
    # the spec is a statement of intent. When they disagree the spec wins and
    # the suggestion is printed beside it.
    declared = str(scene.get("origin", "")).strip()
    upgrade = ""
    if need is None:
        if declared == "generated":
            need = ILLUSTRATION
            why = "declared generated in the spec"
            if kind:
                upgrade = (f"there is {ev} behind this — a SCREENSHOT of it would be "
                           "documentary, where a generated picture can never be")
        elif declared in ("camera", "licensed") and not kind:
            # `camera` and `licensed` both mean "documentary", which is what a
            # screenshot is too — so these do NOT conflict with the evidence
            # test and must not short-circuit it. Only `generated` is a claim
            # the evidence test could contradict. Over-correcting here made
            # every document-backed scene CAMERA and dropped the command that
            # produces it.
            need = CAMERA if declared == "camera" else SCREENSHOT
            why = f"declared '{declared}' in the spec"
        elif kind:
            need = SCREENSHOT
            why = f"there is a primary record behind this — {ev}"
        elif st == "photo":
            need = ILLUSTRATION
            why = "a photo scene with no record behind it"
        else:
            need = NONE
            why = f"the renderer draws a '{st}' scene from the spec alone"

    # A `quote` scene may carry an optional `doc` image of the document. That
    # is the strongest card this engine draws and it is almost never filled in.
    optional = (st == "quote" and not scene.get("doc") and kind == "document")

    a = {
        "index": i,
        "type": st,
        "need": need,
        "why": why,
        "upgrade": upgrade,
        "required": need in (SCREENSHOT, CAMERA, ILLUSTRATION) and (st == "photo" or optional),
        "optional_upgrade": optional,
        "have": str(have) if have else None,
        "origin": NEED_ORIGIN[need],
        "filename": None,
        "command": None,
        "prompts": [],
        "credit": None,
        "headline": (scene.get("kick") or scene.get("label") or scene.get("title")
                     or scene.get("caption") or scene.get("question") or f"scene {i}"),
        "source_note": scene.get("source_note") or "",
    }

    if need == HOST:
        a["dur"] = scene.get("dur")
        a["question"] = scene.get("question", "")
        a["answer_cue"] = scene.get("answer_cue", "")
        a["delivery"] = scene.get("delivery", "")
        return a
    if declared in PHOTO_ORIGINS:
        a["origin"] = declared

    if need == NONE:
        return a

    ext = "png" if need == SCREENSHOT else "jpg"
    a["filename"] = f"assets/{stem}.{ext}"

    if need == SCREENSHOT:
        a["command"] = command_for(scene, kind)
        a["credit"] = "Screenshot: M. Griswold, YYYY-MM-DD — REGISTER, IDENTIFIER"
    elif need == CAMERA:
        a["credit"] = "Photo: M. Griswold, YYYY-MM-DD"
    else:
        a["prompts"] = prompts_for(scene, variants)
        a["credit"] = ("Illustration (generated). Not a photograph of any real "
                       "place, person or document.")
    return a


def paste_for(a: dict) -> str | None:
    """
    The JSON the operator drops into the spec. Every key the renderer demands.

    NO ANGLE BRACKETS ANYWHERE IN THIS FILE'S OUTPUT. zsh reads `<` as input
    redirection, and a pasted block containing one dies on a parse error that
    takes the real commands above it down too. It has happened twice in this
    project, the second time inside the file written to warn about the first.
    Placeholders are SHOUTED WORDS instead.
    """
    if a["need"] == NONE or not a["filename"]:
        return None
    if a["type"] == "photo":
        obj = {
            "image": a["filename"], "origin": a["origin"],
            "caption": "ONE LINE — what the picture is",
            "source": a["credit"],
        }
    else:
        obj = {"doc": a["filename"]}
    return json.dumps(obj, indent=2, ensure_ascii=False)


# ──────────────────────────────────────────────────────── the source beats
def source_audit(scenes: list[dict], want: int) -> dict:
    """
    Claims on screen, against scenes that say where any of it came from.

    `source_note` is a production note — it does not render. A spec can
    therefore be scrupulously annotated and still put eight unattributed
    numbers in front of a viewer, which is the failure this counts.
    """
    claims = [i for i, s in enumerate(scenes)
              if str(s.get("type")) in CLAIM_TYPES]
    # A scene that shows a source is one whose rendered text names one: a
    # `quote` (whose `source` is drawn), or any scene whose caption/sub cites.
    shown = []
    for i, s in enumerate(scenes):
        if str(s.get("type")) == "quote" and str(s.get("source", "")).strip():
            shown.append(i)
            continue
        txt = " ".join(str(s.get(k, "")) for k in ("caption", "sub", "cta", "title"))
        if re.search(r"source|filed|docket|register|per |according to|sha256", txt, re.I):
            shown.append(i)
    drafts = []
    if len(shown) < want:
        for i in claims:
            if i in shown:
                continue
            note = str(scenes[i].get("source_note", "")).strip()
            if not note:
                continue
            drafts.append({
                "after_scene": i,
                "scene": {
                    "type": "quote",
                    "dur": 7.0,
                    "label": "THE RECORD",
                    "label_color": "muted",
                    "quote": note[:180],
                    "source": "Source: REGISTER, IDENTIFIER, DATE",
                    "vo": "ONE SENTENCE — where this came from, and what it does not say",
                    "delivery": "Flat. This is the receipt, not the reveal.",
                    "source_note": f"Source beat for scene {i}.",
                },
            })
            if len(shown) + len(drafts) >= want:
                break
    return {"claims": claims, "shown": shown, "want": want, "drafts": drafts}


# ──────────────────────────────────────────────────────────────────── report
def plan(spec_path: Path, variants: int, want_sources: int) -> dict:
    spec = json.loads(spec_path.read_text())
    scenes = spec.get("scenes") or []
    base = spec_path.parent
    rows = [assign(s, i, variants) for i, s in enumerate(scenes)]
    for a in rows:
        target = a["have"] or (a["filename"] if a["need"] != NONE else None)
        a["on_disk"] = bool(target and (base / target).is_file())
        a["path"] = str(target) if target else None
    return {
        "spec": str(spec_path),
        "title": spec.get("title", ""),
        "preset": spec.get("preset", ""),
        "scenes": len(scenes),
        "assignments": rows,
        "sources": source_audit(scenes, want_sources),
    }


def render(p: dict, show_prompts: bool = True) -> str:
    L: list[str] = []
    A = L.append
    rows = p["assignments"]
    by = {k: [a for a in rows if a["need"] == k]
          for k in (SCREENSHOT, CAMERA, HOST, ILLUSTRATION, NONE)}
    missing = [a for a in rows if a["filename"] and not a["on_disk"]]

    A("")
    A(f"  SHOT ASSIGNMENT — {p['title'] or p['spec']}")
    A(f"  {p['scenes']} scene(s) · preset {p['preset'] or '?'}")
    A("")
    A(f"  {len(by[SCREENSHOT]):>3}  SCREENSHOT    documentary, free, the bytes are already yours")
    A(f"  {len(by[CAMERA]):>3}  CAMERA        a still you have to go and shoot")
    A(f"  {len(by[HOST]):>3}  HOST          you, on camera — no asset, a performance")
    A(f"  {len(by[ILLUSTRATION]):>3}  ILLUSTRATION  generated · labelled on frame · NEVER a record")
    A(f"  {len(by[NONE]):>3}  —             the renderer draws these from the spec")
    A("")
    A(f"  {len(missing)} asset(s) the build will demand and cannot find.")
    A("")
    A("  DO THE SCREENSHOTS FIRST. A screenshot of the filing is documentary")
    A("  under VISUAL_POLICY.md and a generated picture of a filing is not —")
    A("  and the screenshot costs nothing, because the record is already on")
    A("  disk, hashed, in the ledger.")

    if by[HOST]:
        A("")
        A(f"  {'─' * 70}")
        A("  HOST — nothing to save, everything to say")
        A("")
        A("  These render as a question card with room left for you. There is no")
        A("  image key on the schema, so no asset is assigned and none is missing.")
        A("")
        for a in by[HOST]:
            A(f"  [{a['index']:02d}] {a.get('question') or a['headline']}")
            if a.get("answer_cue"):
                A(f"       LENGTH    {a.get('answer_cue')}"
                  + (f"  (card runs {a['dur']}s)" if a.get("dur") else ""))
            if a.get("delivery"):
                A(f"       DELIVERY  {a['delivery']}")
            A("")

    for kind, head in ((SCREENSHOT, "SCREENSHOTS — run, then capture"),
                       (CAMERA, "CAMERA — yours to shoot"),
                       (ILLUSTRATION, "ILLUSTRATION — generated elsewhere, dropped in assets/")):
        items = [a for a in by[kind] if not a["on_disk"]]
        if not items:
            continue
        A("")
        A(f"  {'─' * 70}")
        A(f"  {head}")
        A("")
        for a in items:
            flag = "" if a["required"] else "  (optional — strengthens the scene)"
            A(f"  [{a['index']:02d}] {a['headline']}{flag}")
            A(f"       {a['why']}")
            if a.get("upgrade"):
                A(f"       UPGRADE   {a['upgrade']}")
            A(f"       SAVE AS   {a['filename']}")
            A(f"       ORIGIN    {a['origin']}")
            A(f"       CREDIT    {a['credit']}")
            if a["command"]:
                A(f"       RUN       {a['command']}")
            if show_prompts and a["prompts"]:
                for v in a["prompts"]:
                    A(f"       {v['variant']}  {v['note']}")
                    A(f"          PROMPT    {v['prompt']}")
                    A(f"          NEGATIVE  {v['negative']}")
            paste = paste_for(a)
            if paste:
                A("       PASTE INTO THE SCENE:")
                for ln in paste.splitlines():
                    A(f"         {ln}")
            A("")

    s = p["sources"]
    A(f"  {'─' * 70}")
    A("  SOURCE BEATS")
    A("")
    A(f"  {len(s['claims'])} scene(s) assert something. {len(s['shown'])} name a source ON SCREEN.")
    if len(s["shown"]) >= s["want"]:
        A("  That clears the floor.")
    else:
        A(f"  The floor is {s['want']}. `source_note` is a PRODUCTION note — it does")
        A("  not render, so a scrupulously annotated spec can still put numbers in")
        A("  front of a viewer with nothing attached to them.")
        for d in s["drafts"]:
            A("")
            A(f"  INSERT AFTER SCENE {d['after_scene']}:")
            for ln in json.dumps(d["scene"], indent=2).splitlines():
                A(f"    {ln}")
    A("")
    A(f"  {'─' * 70}")
    A("  NOTHING HERE HAS BEEN WRITTEN TO YOUR SPEC.")
    A("  A script that edits your episode takes authorship of it. Read each")
    A("  block, change what is wrong, and paste the ones you agree with.")
    A("")
    A("  Then:")
    A("    python3 openmontage.py --spec episode.json --check-safe")
    A("    python3 openmontage.py --spec episode.json --contact-sheet builds/sheet.png")
    A("")
    return "\n".join(L)


def render_check(p: dict) -> str:
    rows = [a for a in p["assignments"] if a["filename"]]
    missing = [a for a in rows if not a["on_disk"]]
    held = [a for a in rows if a["on_disk"]]
    L = ["", f"  ASSETS — {p['title'] or p['spec']}", ""]
    for a in held:
        L.append(f"   ok   [{a['index']:02d}] {a['path']}")
    for a in missing:
        req = "REQUIRED" if a["required"] else "optional"
        L.append(f"   --   [{a['index']:02d}] {a['path'] or a['filename']}  ({a['need']}, {req})")
    blocking = [a for a in missing if a["required"]]
    L += ["", f"  {len(held)} held · {len(missing)} missing · {len(blocking)} will FAIL the build", ""]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="sentinel shots",
        description="Every picture an episode spec will demand, as one assignment.")
    ap.add_argument("--spec", required=True, help="path to episode.json")
    ap.add_argument("--check", action="store_true",
                    help="just say which assets are present and which are missing")
    ap.add_argument("--json", action="store_true", help="machine-readable plan")
    ap.add_argument("--out", help="write the sheet to a file as well as printing it")
    ap.add_argument("--variants", type=int, default=3,
                    help="prompts per generated image (default 3)")
    ap.add_argument("--sources", type=int, default=3,
                    help="how many on-screen source beats an episode must carry (default 3)")
    a = ap.parse_args()

    sp = Path(a.spec).expanduser().resolve()
    if not sp.is_file():
        print(f"\n  no spec at {sp}\n", file=sys.stderr)
        return 2
    try:
        p = plan(sp, a.variants, a.sources)
    except json.JSONDecodeError as e:
        print(f"\n  {sp} is not valid JSON: {e}\n", file=sys.stderr)
        return 2

    if a.json:
        print(json.dumps(p, indent=2))
        return 0
    text = render_check(p) if a.check else render(p)
    print(text)
    if a.out:
        Path(a.out).expanduser().write_text(text)
        print(f"  written  {a.out}\n")
    blocking = [x for x in p["assignments"]
                if x["need"] != NONE and x["required"] and not x["on_disk"]]
    return 3 if (a.check and blocking) else 0


if __name__ == "__main__":
    sys.exit(main())
