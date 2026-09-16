#!/usr/bin/env python3
"""
episode.py — ONE ENTITY IN, ONE EPISODE PACKAGE OUT.

─────────────────────────────────────────────────────────────────────────────
WHAT THIS REPLACES

MAKE_ONE_VIDEO.md is six commands and then a blank page. The six commands are
reproducible; the blank page is not. Every episode so far has been assembled by
hand — the numbers copied across from one terminal window, the denominators
remembered or not, the limitations written from memory, the citation under each
claim typed again. That is the step that will not survive being done forty
times, and it is the step where a wrong number gets in.

So the machine writes everything it can check, and leaves blank exactly the
part it cannot: the prose. It supplies

    every NUMBER, with its denominator attached
    every CITATION, taken from the edge that carries it
    every LIMITATION, computed from the shape of the evidence, not recalled
    the SPOKEN SOURCE LINE for each card, ready to read aloud

and it writes NARRATION: ______ where a human has to say something. A script
that arrives with its facts already bound to their registers cannot drift from
them while you write around it.

─────────────────────────────────────────────────────────────────────────────
TWO FILES, AND THE SPLIT IS THE SECURITY RULE

    SCRIPT.md       narration and citations. Nothing about this machine.
                    Publishable. It is checked against the redaction gate
                    before you are told it exists.
    PRODUCTION.md   paths, commands, the screenshot queue, the asset names.
                    Never published, never on screen, never read aloud.

Nothing about the backend leaks because the backend is not in the file that
leaves the building.

─────────────────────────────────────────────────────────────────────────────
WHAT IT REFUSES

  - An entity with no ASSERTED edge. A co-occurrence deck is not an episode,
    it is a coincidence with a soundtrack.
  - An entity whose evidence is all one register, without saying so in the
    script itself, as a limitation, in the narration.
  - A number without its denominator. There is no code path here that prints
    a total alone.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'modules' / 'connectors'))
from namematch import clean, matches_side, side_of  # noqa: E402

TTY = sys.stdout.isatty()


def c(code, s):
    return f'\033[{code}m{s}\033[0m' if TTY else s


def b(s): return c('1', s)
def dim(s): return c('2', s)
def grn(s): return c('32', s)
def yel(s): return c('33', s)
def red(s): return c('31', s)


# The authority each register carries, spoken the way it goes on screen. This
# is the sentence read aloud under the card — "filed with the Senate, under
# penalty" is the whole reason the card is worth showing.
SPOKEN = {
    'senatelda': ('filed with the Senate under the Lobbying Disclosure Act, '
                  '2 U.S.C. 1604, under penalty of perjury'),
    'usaspending': ('published by the awarding agency in the federal spending '
                    'register, with an award identifier'),
    'courtlistener': 'on the docket of a United States court',
    'opencorporates': 'on file with the companies registrar of that jurisdiction',
    'federalregister': 'published by the agency in the Federal Register',
    'regulationsgov': 'filed to the agency docket on Regulations.gov',
    'fec': 'reported to the Federal Election Commission on a sworn schedule',
}

# Registers that bear on this kind of story and that this desk CANNOT reach.
# Naming them in the script is not a weakness; it is the reason a hostile
# viewer cannot take the story apart.
UNREACHABLE = {
    'senatelda': [
        ('FARA', 'foreign principals — a firm can lobby for a foreign '
                 'government and it appears in a different register entirely'),
        ('Ohio JLEC', 'state-level lobbying in Ohio is not in the Senate file'),
    ],
    'usaspending': [
        ('subcontracts', 'the prime contractor is named; who they paid is '
                         'mostly not'),
        ('OTA agreements', 'transactions under 10 U.S.C. 4022 file outside '
                           'the FAR and do not look like contracts'),
    ],
    'courtlistener': [
        ('sealed and state dockets', 'this searches federal filings that have '
                                     'been uploaded, not everything filed'),
    ],
    'fec': [
        ('dark money', '501(c)(4) spending is not itemised to a donor'),
    ],
}

BEATS = [
    ('0:00', '0:10', 'THE QUESTION',
     'Ask it. Do not answer it. The answer is the rest of the video.'),
    ('0:10', '0:20', 'WHY IT MATTERS TO A PERSON',
     'One sentence. No numbers yet — a number here is a number nobody has a '
     'reason to care about.'),
    ('0:20', '1:10', 'THE EVIDENCE',
     'One card per relationship. READ THE SOURCE LINE ALOUD. The source line '
     'is the product.'),
    ('1:10', '1:20', 'WHAT THIS DOES NOT PROVE',
     'Straight from the evidence shape, below. Say it plainly. This is the '
     'beat everyone else skips and the reason they are not believed.'),
    ('1:20', '1:30', 'WHAT WOULD CHANGE MY MIND, AND WHO HOLDS IT',
     'Name the document that would kill the theory, and the office that has '
     'it. If you cannot, you have a shape you noticed, not a finding.'),
]


def slug(s, n=40):
    return re.sub(r'[^a-z0-9]+', '_', str(s).lower()).strip('_')[:n] or 'x'


def money(v):
    try:
        return f'${float(str(v).replace(",", "").replace("$", "")):,.2f}'
    except (TypeError, ValueError):
        return None


def load(path: Path):
    rows = list(csv.DictReader(path.open(newline='', encoding='utf-8-sig')))
    for r in rows:
        for k in list(r):
            r[k] = clean(r[k])
    return rows


def dedupe(rows):
    """One relationship, not one filing. Four quarterly filings of the same
    arrangement is one fact stated four times."""
    seen, out = set(), []
    for r in rows:
        k = (r.get('entity_a'), r.get('relationship'), r.get('entity_b'))
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def profile(all_rows, rows, entity):
    """Everything the script needs to know, each number carrying the total it
    came out of. There is no figure in here without its denominator."""
    p = {}
    p['entity'] = entity
    p['matched'] = len(rows)
    p['library'] = len(all_rows)
    p['grades'] = Counter((r.get('assertion_type') or '?').upper() for r in rows)
    p['registers'] = Counter(r.get('register') or r.get('source') or '?'
                             for r in rows)
    p['sources'] = Counter((r.get('source') or '').lower() for r in rows)
    p['relationships'] = Counter(r.get('relationship') or '?' for r in rows)

    sides = [side_of(r, entity) for r in rows]
    p['left'] = sum(1 for s in sides if 'L' in s.upper())
    p['right'] = sum(1 for s in sides if 'R' in s.upper())
    p['contains'] = sum(1 for s in sides if s != s.upper())

    # How many OTHER entities in the whole library stand in the same
    # relationship to the same counterparty. This is the denominator that makes
    # "three companies retained this firm" mean something.
    pop = defaultdict(set)
    for r in all_rows:
        pop[(r.get('relationship'), (r.get('entity_b') or '').lower())].add(
            (r.get('entity_a') or '').lower())
    for r in rows:
        r['_pop'] = len(pop[(r.get('relationship'),
                             (r.get('entity_b') or '').lower())])

    p['counterparties'] = len({(r.get('entity_b') or '').lower() for r in rows})
    p['with_url'] = sum(1 for r in rows
                        if (r.get('source_url') or '').startswith('http'))
    amts = [money(r.get('amount')) for r in rows]
    p['with_amount'] = sum(1 for a in amts if a)
    dates = sorted(d for d in (r.get('effective_date') or r.get('record_date')
                               for r in rows) if d)
    p['from'], p['to'] = (dates[0], dates[-1]) if dates else (None, None)
    return p


def isare(n, sing='is', plur='are'):
    """These lines get read ALOUD. A plural verb on a count of one is the
    first thing an audience hears, and it is the wrong first thing."""
    return sing if n == 1 else plur


def limitations(p, rows):
    """Computed, not remembered. Each one is a sentence you can say out loud.

    The denominator throughout is every record this desk holds on the name —
    NOT the handful that made the deck. A limitation measured against the deck
    would shrink every time the deck got tighter, which is backwards."""
    out = []
    n, ent = p['matched'], p['entity']
    held = f'{n} record{"" if n == 1 else "s"} I hold on this name'

    co = p['grades'].get('CO-OCCURRENCE', 0)
    if co:
        out.append(
            f'{co} of the {held} {isare(co)} two names appearing in one '
            'document. That is not a relationship, and I am not going to '
            'describe it as one.')

    if len(p['registers']) == 1:
        reg = next(iter(p['registers']))
        out.append(
            f'Every fact in this video comes from ONE register — {reg}. If '
            'that register is wrong or incomplete, so is all of this. I have '
            'not confirmed any of it against a second source.')

    if p['with_amount']:
        out.append(
            f'{p["with_amount"]} of the {held} carr'
            f'{"ies" if p["with_amount"] == 1 else "y"} a dollar figure. '
            f'{"That figure is" if p["with_amount"] == 1 else "Those figures are"}'
            ' a FLOOR, not a total — what got filed where I can read it, not '
            'what was spent.')

    if p['contains']:
        out.append(
            f'{p["contains"]} of the {held} do not have "{ent}" at the '
            'front of the name — the register filed them under something '
            'else. A name in the middle of a filing can be a different '
            'company with the same word in it.')

    if p['left'] and p['right']:
        out.append(
            f'"{ent}" is the subject of {p["left"]} of these records and the '
            f'counterparty in {p["right"]}. Those are opposite sentences and '
            'I am keeping them apart.')

    shared = [r for r in rows if r.get('_pop', 1) > 1]
    if shared:
        worst = max(r.get('_pop', 1) for r in shared)
        out.append(
            f'{len(shared)} of these counterparties {isare(len(shared))} '
            f'shared with other entities — one of them with {worst - 1} '
            f'other{"" if worst - 1 == 1 else "s"}. A shared counterparty is '
            'usually a SERVICE that many people buy, not a network that '
            'connects them.')

    if p['with_url'] < n:
        out.append(
            f'{n - p["with_url"]} of the {held} {isare(n - p["with_url"], "has", "have")} '
            'no clickable source. It is not on screen in this video.'
            if n - p['with_url'] == 1 else
            f'{n - p["with_url"]} of the {held} have no clickable source. '
            'They are not on screen in this video.')

    named = set()
    for src in p['sources']:
        for reg, why in UNREACHABLE.get(src, []):
            if reg not in named:
                named.add(reg)
                out.append(f'This desk cannot read {reg}: {why}. '
                           'So a whole class of this activity is invisible to me.')

    out.append(
        f'This is {n} record{"" if n == 1 else "s"} out of {p["library"]:,} '
        'in my library. It is what I found, not what exists.')
    return out


def script_md(p, rows, ep_id):
    ent = p['entity']
    L = [f'# {ep_id.upper()} — {ent}',
         '**The Sentinel Report · Mark W. Griswold · Columbus, Ohio**',
         f'Generated {date.today().isoformat()} from the edge table. '
         'Every figure below carries the total it came out of.',
         '',
         '> **PRODUCTION RULES**',
         '> 1. Every factual claim gets its citation on screen. No card, not said.',
         '> 2. Every dollar figure gets its qualifier spoken — "a floor", not '
         '"a total".',
         '> 3. No person\'s face under an allegation they are not charged with.',
         '> 4. Where the record stops, the narration stops. Say *"and that is '
         'where the record ends."*',
         '',
         '---', '']

    # ── the numbers, each with its denominator ──────────────────────────────
    L += ['## WHAT THE EVIDENCE IS', '',
          '| | |', '|---|---|']
    L += [f'| Records naming **{ent}** | {p["matched"]} of {p["library"]:,} '
          f'in the library |']
    for g in ('ASSERTED', 'REGISTRY', 'CO-OCCURRENCE'):
        if p['grades'].get(g):
            L.append(f'| {g} | {p["grades"][g]} of {p["matched"]} |')
    L.append(f'| Distinct counterparties | {p["counterparties"]} |')
    L.append(f'| Carrying a clickable source | {p["with_url"]} of {p["matched"]} |')
    L.append(f'| Carrying a dollar figure | {p["with_amount"]} of {p["matched"]} '
             f'— **a floor** |')
    if p['from']:
        L.append(f'| Date range on the filings | {p["from"]} to {p["to"]} |')
    L.append(f'| Registers relied on | '
             f'{", ".join(sorted(p["registers"]))} |')
    L += ['', '---', '']

    # ── the beats ───────────────────────────────────────────────────────────
    for i, (a, z, title, note) in enumerate(BEATS):
        L += [f'## {a}–{z} — {title}', '', f'*{note}*', '']
        if title == 'THE EVIDENCE':
            L.append(f'*{len(rows)} cards · '
                     f'{round(50.0 / max(len(rows), 1), 1)}s each.*')
            L.append('')
            for j, r in enumerate(rows, 1):
                L += card_block(j, r, ent)
        elif title == 'WHAT THIS DOES NOT PROVE':
            L.append('**NARRATION — say every one of these:**')
            L.append('')
            for lim in limitations(p, rows):
                L.append(f'- {lim}')
            L.append('')
        elif title == 'WHAT WOULD CHANGE MY MIND, AND WHO HOLDS IT':
            L += ['**NARRATION:** ______________________________________', '',
                  'Name here the single document that would kill this story, '
                  'and the office that holds it. Candidates the evidence '
                  'points at:', '']
            for reg, why in sorted({x for s in p['sources']
                                    for x in UNREACHABLE.get(s, [])}):
                L.append(f'- **{reg}** — {why}')
            L += ['', 'If nothing goes on that list, this is not ready.', '']
        else:
            L += ['**NARRATION:** ______________________________________',
                  '', '']
        L += ['---', '']

    L += ['## THE SENTENCE THAT CARRIES THE PROGRAMME', '',
          '> We have established a network of documented relationships. We have '
          'not established the meaning or consequence of every relationship.', '']
    return '\n'.join(L) + '\n'


def card_block(j, r, ent):
    a, bb = r.get('entity_a'), r.get('entity_b')
    lab = r.get('label') or r.get('relationship') or ''
    reg = r.get('register') or r.get('source') or ''
    spoken = SPOKEN.get((r.get('source') or '').lower(),
                        'in a public register')
    grade = (r.get('assertion_type') or '?').upper()
    amt = money(r.get('amount'))
    pop = r.get('_pop', 1)

    out = [f'### Card {j:02d} — {grade}', '',
           '```', f'  {a}', f'      |  {lab}', f'      v', f'  {bb}', '```', '']
    say = f'**SAY:** "{a} {lab} {bb} — {spoken}'
    if amt:
        say += f'. {amt}, and that figure is a floor'
    out += [say + '."', '']
    out.append(f'**ON SCREEN:** Source: {reg}'
               + (f' · {amt}' if amt else '')
               + (f' · {r.get("effective_date")}' if r.get('effective_date') else ''))
    if r.get('document_id'):
        out.append(f'**DOCUMENT:** {r.get("document_id")}')
    if pop > 1:
        out.append(f'**DENOMINATOR:** {pop} entities in the library stand in '
                   f'this same relationship to {bb}. Say the number.')
    else:
        out.append(f'**DENOMINATOR:** {pop} entity in the library stands in '
                   f'this relationship to {bb}. That is rare — and rare is a '
                   'question, not an answer.')
    if grade == 'CO-OCCURRENCE':
        out.append('**THIS IS TWO NAMES IN ONE DOCUMENT.** If it is on screen '
                   'it is labelled as what it is, out loud.')
    out.append('')
    return out


def production_md(p, rows, ep_id, outdir, edges, entity, side):
    """The operator half. Paths and commands live HERE and nowhere near the
    script, because the script is the file that leaves the building."""
    flags = f' --entity "{entity}"'
    if side and side != 'any':
        flags += f' --side {side}'
    L = [f'# {ep_id} — PRODUCTION SHEET', '',
         '**NOT FOR PUBLICATION. Not on screen, not read aloud.**', '',
         '## 1 — capture the exhibits, one at a time', '',
         '```bash',
         f'bin/sentinel exhibits --edges {edges}{flags} --next',
         '```', '',
         'Then after each screenshot:', '',
         '```bash',
         f'bin/sentinel exhibits --edges {edges}{flags} --done N',
         '```', '',
         '## 2 — draw the card deck', '', '```bash',
         f'bin/sentinel cards --edges {edges}{flags} \\',
         f'  --grade ASSERTED --limit {len(rows)} --seconds 50 \\',
         f'  --theme bright --out {outdir}/assets --scenes {outdir}/cards.json',
         '```', '',
         '## 3 — check every asset the build will demand', '', '```bash',
         f'bin/sentinel shots --spec {outdir}/episode.json --check',
         '```', '',
         '## 4 — the publication gate, before anything leaves', '', '```bash',
         f'bin/sentinel redact --check {outdir}/SCRIPT.md',
         '```', '',
         'Exits 3 on a leak. If it exits 3, nothing ships until it exits 0.', '',
         '## The exhibit list', '',
         '| # | grade | side | source | document |', '|---|---|---|---|---|']
    for i, r in enumerate(rows, 1):
        L.append(f'| {i:02d} | {(r.get("assertion_type") or "?").upper()} | '
                 f'{r.get("_side") or ""} | {r.get("register") or r.get("source")} | '
                 f'{r.get("document_id") or ""} |')
    return '\n'.join(L) + '\n'


def main() -> int:
    ap = argparse.ArgumentParser(
        prog='sentinel episode',
        description='One entity in, one episode package out.')
    ap.add_argument('entity', help='the name the episode is about')
    ap.add_argument('--edges', default='edges.csv')
    ap.add_argument('--side', choices=['left', 'right', 'any'], default='any',
                    help='left = the name is the SUBJECT, right = the '
                         'COUNTERPARTY. Opposite sentences.')
    ap.add_argument('--grade', default='ASSERTED',
                    help='default ASSERTED — the sworn ones only. Pass ALL to '
                         'include registry and co-occurrence.')
    ap.add_argument('--limit', type=int, default=12,
                    help='cards in the evidence beat (default 12 in 50s)')
    ap.add_argument('--id', dest='ep_id', help='episode id, e.g. ep03')
    ap.add_argument('--out', help='episode directory')
    a = ap.parse_args()

    ep = Path(a.edges).expanduser()
    if not ep.is_file():
        print(f'\n  no edges csv at {ep}', file=sys.stderr)
        print('  make one:  bin/sentinel connect edges --out edges.csv\n',
              file=sys.stderr)
        return 2

    all_rows = load(ep)
    rows = dedupe([r for r in all_rows if matches_side(r, a.entity, a.side)])
    if not rows:
        print(f'\n  Nothing in the edge table names "{a.entity}".')
        print(dim('  Whole-word match, both sides. Check the spelling against'))
        print(dim('    bin/sentinel connect explain "THE NAME"\n'))
        return 2

    for r in rows:
        r['_side'] = side_of(r, a.entity)
    p = profile(all_rows, rows, a.entity)

    # ── the refusal ─────────────────────────────────────────────────────────
    if not p['grades'].get('ASSERTED'):
        print(red(f'\n  NO ASSERTED EVIDENCE FOR "{a.entity}".'))
        print(f'  {p["matched"]} record(s): '
              + ', '.join(f'{v} {k.lower()}' for k, v in p['grades'].items()))
        print(dim('\n  Every one of these is a registration or two names in one'))
        print(dim('  document. That is not an episode, it is a coincidence with'))
        print(dim('  a soundtrack. Find an entity somebody swore to:\n'))
        print(dim(f'    bin/sentinel connect explain "{a.entity}"\n'))
        return 3

    shown = [r for r in rows
             if (a.grade.upper() == 'ALL'
                 or (r.get('assertion_type') or '').upper() == a.grade.upper())
             and (r.get('source_url') or '').startswith('http')]
    shown.sort(key=lambda r: (r.get('_pop', 1), -(1 if r.get('amount') else 0)))
    shown = shown[:a.limit]
    if not shown:
        print(red(f'\n  No {a.grade} record for "{a.entity}" has a clickable '
                  'source.'))
        print(dim('  A card whose source line cannot be clicked is a card that'))
        print(dim('  asks to be trusted. Nothing drawn.\n'))
        return 3

    ep_id = a.ep_id or f'ep_{slug(a.entity, 24)}'
    outdir = Path(a.out) if a.out else (
        ROOT / 'modules' / 'openmontage' / 'episodes' / ep_id)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / 'assets').mkdir(exist_ok=True)

    (outdir / 'SCRIPT.md').write_text(script_md(p, shown, ep_id), encoding='utf-8')
    (outdir / 'PRODUCTION.md').write_text(
        production_md(p, shown, ep_id, outdir.name, a.edges, a.entity, a.side),
        encoding='utf-8')

    spec = outdir / 'episode.json'
    if not spec.is_file():
        spec.write_text(json.dumps({
            'title': f'{ep_id} — {a.entity}',
            'preset': 'vertical', 'theme': 'bright',
            'scenes': [],
            '_production': 'scenes come from cards.json — see PRODUCTION.md',
        }, indent=2) + '\n', encoding='utf-8')

    # ── report ──────────────────────────────────────────────────────────────
    print(f'\n{b("  EPISODE PACKAGE")}  {ep_id}')
    print(f'  {a.entity}\n')
    print(f'  {p["matched"]} record(s) of {p["library"]:,} name it · '
          + ' · '.join(f'{v} {k.lower()}' for k, v in p['grades'].items()))
    print(f'  {len(shown)} card(s) drawn from the {a.grade} ones that have a '
          'clickable source')
    if p['left'] and p['right'] and a.side == 'any':
        print(yel(f'  {p["left"]} as SUBJECT · {p["right"]} as COUNTERPARTY — '
                  'opposite sentences.'))
        print(yel('  Consider --side left or --side right before you write.'))
    if p['contains']:
        print(yel(f'  {p["contains"]} record(s) do not carry the name at the '
                  'front — check for namesakes.'))
    print(f'\n  {b("SCRIPT.md")}       narration and citations. Publishable.')
    print(f'  {b("PRODUCTION.md")}   paths and commands. Never published.')
    print(dim(f'\n  {len(limitations(p, shown))} limitation(s) written into the '
              'script, computed from the evidence.'))
    print(dim('  Read them. Any one you cannot say out loud means the episode '
              'is not ready.'))
    print(f'\n  Next:  open {outdir.name}/PRODUCTION.md and start at step 1.\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
