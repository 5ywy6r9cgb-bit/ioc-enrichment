"""
findings.py -- validate a desk export before it can become video.

    from sentinel_video.findings import load_deck
    deck, errors, warnings = load_deck(findings_json_dict)

`errors` is the answer to "may this be rendered." A non-empty list means no.
`warnings` are things a person should look at and may knowingly accept.

WHY THIS IS STRICTER THAN THE DESK'S OWN GATES
    The desk's gates decide whether a claim is publishable. This decides
    whether it can go on screen, which is a higher bar for one reason: video
    strips context. A dossier reader sees the citation next to the claim, can
    follow it, and can see the "Withheld" section. A viewer sees a number in
    48-point type for four seconds. So:

      - Every GREEN finding must carry a source. In the dossier a missing
        citation is visible as an absence; on screen it is invisible.
      - Every RED_APPLE must read as a question AND name what would close it.
        A question mark on screen with no closing gate is an insinuation.
      - Every DEAD_END must carry what closed it, or it is left out. A dead
        end shown without its resolution reads as an unanswered allegation.

THE THREE-TIER RULE
    The desk has six internal tiers; the screen has three. Anything else in a
    deck means the export path changed and this file did not, which is exactly
    the drift that puts an internal label in front of an audience.
"""

from __future__ import annotations

import re

SCREEN_TIERS = {"GREEN", "RED_APPLE", "DEAD_END"}
CONFIDENCE = {"high", "medium", "low"}

# Long enough to be a claim, short enough to be readable at speed. The upper
# bound is not aesthetic: past roughly this length the renderer shrinks type
# until a viewer on a phone cannot read it, and the finding is on screen
# without being legible, which is worse than omitting it.
MIN_TEXT = 8
MAX_TEXT = 240


class DeckError(ValueError):
    pass


# Each screen tier names its text differently, and the naming is the point:
# a GREEN is a `claim`, a RED_APPLE is a `question`, and a DEAD_END is a
# `thread` — a line of inquiry that was followed and closed, which is neither
# a claim nor a question. Reading them through one key would lose that.
TEXT_KEY = {"GREEN": "claim", "RED_APPLE": "question", "DEAD_END": "thread"}


def _text_of(f: dict) -> str:
    for key in ("claim", "question", "thread"):
        if f.get(key):
            return str(f[key]).strip()
    return ""


def _check_finding(f: dict, i: int, errors: list, warnings: list) -> None:
    where = f"finding {i}" + (f" ({f['id']})" if f.get("id") else "")

    tier = f.get("tier")
    if tier not in SCREEN_TIERS:
        errors.append(
            f"{where}: tier {tier!r} is not a screen tier. The desk's six "
            f"tiers collapse to {sorted(SCREEN_TIERS)} on export; anything "
            f"else means an internal label is about to face an audience.")
        return

    text = _text_of(f)
    if not text:
        want = TEXT_KEY.get(tier, "claim")
        errors.append(f"{where}: {tier} carries no {want!r} text")
        return
    if len(text) < MIN_TEXT:
        errors.append(f"{where}: text is {len(text)} characters — too short to be a finding")
    if len(text) > MAX_TEXT:
        warnings.append(
            f"{where}: text is {len(text)} characters. Past ~{MAX_TEXT} the "
            f"renderer shrinks type until a phone viewer cannot read it.")

    conf = f.get("confidence")
    if conf is not None and conf not in CONFIDENCE:
        errors.append(f"{where}: confidence {conf!r} is not one of {sorted(CONFIDENCE)}")

    if tier == "GREEN":
        if "claim" not in f:
            errors.append(f"{where}: GREEN must be a claim, not a question")
        src = f.get("source") or {}
        if not src.get("doc"):
            errors.append(
                f"{where}: GREEN with no source document. In a dossier a "
                f"missing citation is a visible absence; on screen it is "
                f"invisible, so it cannot be rendered.")

    elif tier == "RED_APPLE":
        if "claim" in f:
            errors.append(
                f"{where}: RED_APPLE carries a 'claim' key. An open question "
                f"presented as a claim is the specific failure this tier exists "
                f"to prevent.")
        if not text.endswith("?"):
            errors.append(
                f"{where}: RED_APPLE does not read as a question. On screen, a "
                f"statement in the open-question tier is an insinuation.")
        if not (f.get("gate") or "").strip():
            errors.append(
                f"{where}: RED_APPLE names nothing that would close it. A "
                f"question with no closing gate cannot be answered, only "
                f"repeated.")

    elif tier == "DEAD_END":
        if not (f.get("resolution") or f.get("gate") or "").strip():
            errors.append(
                f"{where}: DEAD_END carries no resolution. Shown without what "
                f"closed it, a dead end reads as an unanswered allegation.")


def load_deck(payload: dict) -> tuple[dict, list[str], list[str]]:
    """Validate a findings export.

    Returns (deck, errors, warnings). `deck` is the normalised payload; it is
    returned even when errors is non-empty so a caller can show what was
    rejected, but a non-empty `errors` means DO NOT RENDER.
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(payload, dict):
        return ({}, [f"deck must be an object, got {type(payload).__name__}"], [])

    project = (payload.get("project") or "").strip()
    if not project:
        errors.append("deck has no project name — the title card would be blank")

    findings = payload.get("findings")
    if not isinstance(findings, list):
        return (payload, errors + ["deck has no 'findings' list"], warnings)
    if not findings:
        errors.append(
            "deck has no findings. An empty deck renders as a title card and "
            "nothing else, which reads as a story that was pulled.")

    seen_ids = set()
    for i, f in enumerate(findings, 1):
        if not isinstance(f, dict):
            errors.append(f"finding {i} is not an object")
            continue
        fid = f.get("id")
        if fid:
            if fid in seen_ids:
                errors.append(f"finding {i}: duplicate id {fid!r}")
            seen_ids.add(fid)
        _check_finding(f, i, errors, warnings)

    # A deck that is only open questions is a deck with no findings in it.
    tiers = [f.get("tier") for f in findings if isinstance(f, dict)]
    if tiers and not any(t == "GREEN" for t in tiers):
        warnings.append(
            "no GREEN findings in this deck — it is entirely open questions "
            "and closed lines. That may be correct, and it is worth seeing "
            "before it is rendered.")

    deck = {
        "project": project,
        "standard": payload.get("standard", ""),
        "motto": payload.get("motto", ""),
        "findings": findings,
        "counts": {t: sum(1 for x in tiers if x == t) for t in sorted(SCREEN_TIERS)},
    }
    return (deck, errors, warnings)
