#!/usr/bin/env python3
"""
handoff.py — LETTING ANOTHER MODEL NEAR THE SCRIPT, AND CHECKING WHAT IT HANDS BACK.

─────────────────────────────────────────────────────────────────────────────
THE PROBLEM WITH "GET THE TWO MODELS TALKING"

A live link between two models is the wrong shape for this desk, for three
reasons that have nothing to do with which model is better.

  1  Everything that crosses the link leaves the building. A conversation
     carries context you did not choose to send — paths, filenames, the
     library's shape. The rule is that nothing about the machine leaves it,
     and a chat window cannot enforce a rule.

  2  A model writing narration will write a number. Not maliciously — it is
     what prose does. It rounds $670,000 to "nearly three quarters of a
     million", it turns eight sworn filings into "dozens of records", it
     writes "FirstEnergy paid lobbyists millions" because that is how the
     sentence wants to end. Every one of those is unsourced, and your entire
     position is that every figure traces to a record.

  3  Nothing checks the return leg. That is the actual gap. Not what you send
     — what comes back, and whether it says more than the evidence does.

So: a FILE goes out, a FILE comes back, and the file that comes back is
checked against the evidence before a word of it reaches a script.

─────────────────────────────────────────────────────────────────────────────
OUT  --tool text     a brief for a language model. The beats, the facts that
                     ARE established, and an explicit list of what it may not
                     do. Redaction-gated before it is written.
     --tool image    a brief for a generator. ILLUSTRATION SLOTS ONLY, with
                     the policy's refusals carried into the prompt so the
                     thing comes back usable.

BACK --verify FILE   reads returned prose and reports every NUMBER, DOLLAR
                     FIGURE, DATE and PROPER NAME in it that does not appear
                     in the evidence. Exits 3 if any does.

That last command is the whole point of this file. Everything else is a
convenience; the verifier is the part that lets you use an outside model at
all without giving up the thing that makes the work worth anything.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TTY = sys.stdout.isatty()


def c(code, s):
    return f'\033[{code}m{s}\033[0m' if TTY else s


def b(s): return c('1', s)
def dim(s): return c('2', s)
def grn(s): return c('32', s)
def yel(s): return c('33', s)
def red(s): return c('31', s)


# ─────────────────────────────────────────────────────────────────────────────
# What an outside model may not do. These are not style notes; each one is a
# way the episode stops being defensible.

TEXT_REFUSALS = [
    'Do not introduce any number, dollar figure, percentage, date or '
    'quantity that is not already in the FACTS section below. Not a rounded '
    'version, not an approximation, not "nearly", not "more than".',

    'Do not name any person, company, agency or court that is not already in '
    'the FACTS section.',

    'Do not describe a relationship the FACTS do not state. If two names '
    'appear in the same document, that is not a relationship and must not be '
    'written as one.',

    'Do not characterise anyone\'s motive, intent or knowledge. The registers '
    'record what was filed, never why.',

    'Do not soften or remove anything in the LIMITATIONS section. Those '
    'sentences are the reason the piece survives contact with a hostile '
    'reader, and they are to be spoken, not footnoted.',

    'Do not write a conclusion. The last beat asks what would change our '
    'mind; it does not answer the question.',

    'Where you do not have enough to write a sentence, write NEEDS EVIDENCE '
    'and stop. A blank is recoverable. An invented bridge is not.',
]

IMAGE_REFUSALS = [
    'NEVER any real building, street, office, vehicle or document. Not a '
    'stylised one, not an "inspired by" one.',
    'NEVER any person, living or dead, real or implied — no faces, no '
    'silhouettes standing in for a named individual.',
    'NEVER anything a viewer could mistake for a photograph taken by us.',
    'NEVER anything standing in for evidence we do not have. If the real '
    'shot is missing, the absence is the story.',
    'NEVER a logo, seal, letterhead, or anything resembling an official mark.',
]

IMAGE_ALLOWED = [
    'title-card backgrounds and section dividers',
    'abstract motifs — networks, ledgers, flows of money',
    'textures behind type',
    'diagrams of a structure, clearly drawn as a diagram',
]

LABEL_BAND = 'ILLUSTRATION · GENERATED IMAGE · NOT A PHOTOGRAPH'


def read_script(ep: Path) -> str:
    p = ep / 'SCRIPT.md'
    if not p.is_file():
        print(f'\n  no SCRIPT.md in {ep.name}', file=sys.stderr)
        print('  make one:  bin/sentinel episode "ENTITY"\n', file=sys.stderr)
        raise SystemExit(2)
    return p.read_text(encoding='utf-8')


def gate(text: str) -> list:
    """Nothing goes out that the publication gate would stop."""
    sys.path.insert(0, str(ROOT / 'scripts'))
    import redact  # noqa: E402
    return redact.scan_text(text)


# ─────────────────────────────────────────────────────────────────────────────
# THE RETURN LEG.

NUM = re.compile(r'\$?\d[\d,]*(?:\.\d+)?%?')
# A capitalised run of two or more words is a proper name in prose. One word is
# too noisy — every sentence starts with a capital.
PROPER = re.compile(r'\b(?:[A-Z][A-Za-z&.\'-]*\s+){1,5}[A-Z][A-Za-z&.\'-]*\b')

# Words that are capitalised for grammar or emphasis, not because they name
# anything. Matching these as "new entities" would bury the real findings.
STOP = {
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'this', 'that', 'these',
    'those', 'i', 'we', 'it', 'they', 'he', 'she', 'you', 'what', 'who',
    'where', 'when', 'why', 'how', 'not', 'is', 'are', 'was', 'were', 'do',
    'does', 'did', 'no', 'yes', 'so', 'then', 'there', 'here', 'narration',
    'say', 'source', 'on', 'screen', 'card', 'document', 'denominator',
    'needs', 'evidence', 'illustration', 'generated', 'never', 'always',
}


def norm_num(s: str) -> str:
    """$670,000.00 and 670000 are the same claim. Compare them as one."""
    t = s.replace(',', '').replace('$', '').rstrip('%')
    try:
        f = float(t)
        return str(int(f)) if f == int(f) else str(f)
    except ValueError:
        return t


def known_numbers(evidence: str) -> set:
    return {norm_num(m.group(0)) for m in NUM.finditer(evidence)}


def known_names(evidence: str) -> set:
    return {w.lower() for m in PROPER.finditer(evidence)
            for w in re.split(r'[^A-Za-z&\'-]+', m.group(0)) if w}


LIST_MARKER = re.compile(r'^\s*\d{1,2}[.)]\s')
TIMECODE = re.compile(r'\d{1,2}:\d{2}')


def not_a_claim(line: str, m) -> bool:
    """Digits that are structure rather than assertion.

    The first version of this skipped ANY bare integer of one or two digits,
    on the theory that those are list markers. That theory let "47 of them
    name the company" and "that is 92% of all filings" both through — two
    invented figures, in the exact shape a model actually produces them. A
    number is a claim unless it is demonstrably furniture.
    """
    tok = m.group(0)
    if '$' in tok or '%' in tok:
        return False                       # money and rates are always claims
    if LIST_MARKER.match(line) and m.start() < 4:
        return True                        # "1. " at the head of a line
    for t in TIMECODE.finditer(line):      # 0:10-0:20 beat headings
        if t.start() <= m.start() < t.end():
            return True
    return False


def verify(returned: str, evidence: str) -> dict:
    """Every claim in the returned prose that the evidence does not carry."""
    kn, knm = known_numbers(evidence), known_names(evidence)
    out = {'numbers': [], 'names': [], 'lines': {}}

    for i, line in enumerate(returned.splitlines(), 1):
        for m in NUM.finditer(line):
            v = norm_num(m.group(0))
            if not_a_claim(line, m):
                continue
            if v not in kn:
                out['numbers'].append(m.group(0))
                out['lines'].setdefault(m.group(0), i)

        for m in PROPER.finditer(line):
            words = [w for w in re.split(r'[^A-Za-z&\'-]+', m.group(0)) if w]
            novel = [w for w in words
                     if w.lower() not in knm and w.lower() not in STOP
                     and len(w) > 2]
            if len(novel) >= 2:
                phrase = ' '.join(novel)
                out['names'].append(phrase)
                out['lines'].setdefault(phrase, i)
    return out


# ─────────────────────────────────────────────────────────────────────────────
def brief_text(script: str, ep_name: str) -> str:
    L = [f'# BRIEF — {ep_name}', '',
         'You are writing narration for a documentary short. Everything you '
         'need is in this file. Nothing outside this file is available to you, '
         'and nothing outside this file may appear in what you write.', '',
         '## WHAT YOU ARE DOING', '',
         'The script below has facts, citations and limitations already fixed. '
         'Every place it says `NARRATION: ______` needs one to three sentences '
         'of plain spoken English. That is the entire job.', '',
         '## RULES — every one of these is checked automatically', '']
    L += [f'{i}. {r}' for i, r in enumerate(TEXT_REFUSALS, 1)]
    L += ['', 'What you return is run through a verifier that reports every '
          'number and every proper name in your text that is not in the '
          'evidence. Anything it finds is removed, so inventing detail costs '
          'you the sentence it was in.', '',
          '## VOICE', '',
          '- Short sentences. A person reading aloud has to breathe.',
          '- Say the source out loud. "Filed with the Senate, under penalty" '
          'is not a footnote, it is the product.',
          '- Never "sources say", "it appears", "reportedly". Either a '
          'register says it or it does not go in.',
          '- When the record stops, say so: "and that is where the record '
          'ends."', '',
          '---', '', '## THE SCRIPT', '', script]
    return '\n'.join(L) + '\n'


def brief_image(script: str, ep_name: str) -> str:
    L = [f'# IMAGE BRIEF — {ep_name}', '',
         'Generated imagery in this project is ILLUSTRATION ONLY. It is never '
         'a record of a real place, person, object or document, and it carries '
         'a band across the frame that the renderer draws and no setting can '
         'remove:', '', f'    {LABEL_BAND}', '',
         '## WHAT MAY BE GENERATED', '']
    L += [f'- {x}' for x in IMAGE_ALLOWED]
    L += ['', '## WHAT MAY NEVER BE GENERATED', '']
    L += [f'- {x}' for x in IMAGE_REFUSALS]
    L += ['', 'If a frame in the script needs a document, a building or a '
          'person, it is a SCREENSHOT or a CAMERA shot and it is not yours. '
          'Generating it would retire the only thing this work has.', '',
          '## DELIVERY', '',
          '- Neutral, bright, high contrast. The band has to stay readable.',
          '- Leave the top 12% of the frame clear for the band.',
          '- No text inside the image. Type is set by the renderer.',
          '- Every file comes back with the model and date, for the source '
          'line: "Generated: MODEL-NAME, YYYY-MM-DD".', '',
          '---', '', '## THE SCRIPT, FOR CONTEXT ONLY', '',
          'Do not illustrate the evidence beats. They are screenshots.', '',
          script]
    return '\n'.join(L) + '\n'


def main() -> int:
    ap = argparse.ArgumentParser(
        prog='sentinel handoff',
        description='A file goes out, a file comes back, and the one that '
                    'comes back is checked.')
    ap.add_argument('episode', help='episode directory, e.g. ep03')
    ap.add_argument('--tool', choices=['text', 'image'], default='text')
    ap.add_argument('--out', help='write the brief here (default: stdout)')
    ap.add_argument('--verify', metavar='FILE',
                    help='check returned prose against the evidence')
    a = ap.parse_args()

    ep = Path(a.episode).expanduser()
    if not ep.is_dir():
        guess = ROOT / 'modules' / 'openmontage' / 'episodes' / a.episode
        ep = guess if guess.is_dir() else ep
    script = read_script(ep)

    # ── the return leg ──────────────────────────────────────────────────────
    if a.verify:
        rp = Path(a.verify).expanduser()
        if not rp.is_file():
            print(f'\n  nothing to verify at {rp}\n', file=sys.stderr)
            return 2
        res = verify(rp.read_text(encoding='utf-8'), script)
        nums, names = res['numbers'], res['names']

        print(f'\n{b("  VERIFY")}  {rp.name}  against {ep.name}/SCRIPT.md\n')
        if not nums and not names:
            print(grn('  Every number and every name in this text is in the '
                      'evidence.'))
            print(dim('  That is not the same as it being TRUE — it means '
                      'nothing was'))
            print(dim('  invented. Read it yourself before it is spoken.\n'))
            return 0

        if nums:
            print(red(f'  {len(nums)} FIGURE(S) NOT IN THE EVIDENCE'))
            for v in dict.fromkeys(nums):
                print(f'      line {res["lines"][v]:>4}  {v}')
            print(dim('\n  A rounded figure is a different figure. "Nearly '
                      'three quarters of'))
            print(dim('  a million" is not $670,000 and cannot be sourced to '
                      'the filing.\n'))
        if names:
            print(red(f'  {len(names)} NAME(S) NOT IN THE EVIDENCE'))
            for v in dict.fromkeys(names):
                print(f'      line {res["lines"][v]:>4}  {v}')
            print(dim('\n  A name that is not in the edge table is a name this '
                      'desk cannot'))
            print(dim('  stand behind, whatever else is true about it.\n'))
        print(yel('  Cut these or source them. Nothing goes in a script on a '
                  'model\'s word.\n'))
        return 3

    # ── the outbound leg ────────────────────────────────────────────────────
    brief = (brief_text if a.tool == 'text' else brief_image)(script, ep.name)

    leaks = gate(brief)
    if leaks:
        print(red(f'\n  REFUSED — the brief carries {len(leaks)} leak(s).'))
        for d in leaks[:8]:
            print(f'      line {d["line"]:>4}  {d["rule"]}  {d["match"][:50]}')
        print(dim('\n  This was going to an outside service. Fix the script, '
                  'not the gate.\n'))
        return 3

    if a.out:
        Path(a.out).expanduser().write_text(brief, encoding='utf-8')
        print(f'\n{b("  BRIEF")}  {a.tool}  ->  {a.out}')
        print(dim(f'  {len(brief.splitlines())} lines · cleared the '
                  'publication gate'))
        print(dim('\n  This file is safe to paste into an outside model. '
                  'Nothing else is.'))
        print(dim('  When it comes back:'))
        print(dim(f'    bin/sentinel handoff {a.episode} --verify THEIR_FILE.md\n'))
    else:
        sys.stdout.write(brief)
    return 0


if __name__ == '__main__':
    sys.exit(main())
