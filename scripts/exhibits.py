#!/usr/bin/env python3
"""
exhibits.py — THE SCREENSHOT QUEUE, ONE DOCUMENT AT A TIME.

─────────────────────────────────────────────────────────────────────────────
WHAT THIS IS FOR

You have 160,777 edges and a video that needs twenty pictures. The gap between
those two numbers is the whole problem, and it is not a research problem — it
is a QUEUE problem. Which document do I open, what am I looking at on it, what
do I call the file, and what goes under it on screen.

This ranks every edge that has a URL behind it, and walks you through them one
at a time. For each one:

    OPEN         the public register URL — the actual filing, not a summary
    LOOK FOR     what on that page is the evidence, in words
    SCREENSHOT   the exact filename to save as, ready for the card deck
    CAPTION      what goes under it on screen
    SOURCE       the register, the statute, the amount

A screenshot of the filing is DOCUMENTARY under VISUAL_POLICY.md. It costs
nothing, the bytes are already yours, and it is the one kind of picture a
generated image can never be.

─────────────────────────────────────────────────────────────────────────────
THE ORDER IS THE ARGUMENT

Ranked by, in order:

  1  ASSERTED before REGISTRY before CO-OCCURRENCE. A deck that opens on a
     co-occurrence has taught the audience what your evidence looks like.
  2  RAREST domain pair first. A pair crossed by one entity is a question; a
     pair crossed by ninety is what an industry looks like.
  3  Has an amount. A number on the page gives the frame something to hold.

It refuses to queue an edge with no URL. A card whose source line cannot be
clicked is a card that asks to be trusted.

─────────────────────────────────────────────────────────────────────────────
DIRECTION IS NOT A DETAIL

    AKIN GUMP  retained by  DEPARTMENT OF THE INTERIOR
    1-800 CONTACTS  retained  AKIN GUMP

Those are two different sentences about two different people. A queue that
filters on a name and hands you both without saying which side matched has
quietly merged a firm's clients with its own hires. Every row here is marked
LEFT or RIGHT, and --side lets you ask for one.

The name test is WHOLE-WORD, the same rule the connectors use: BLACK does not
match BLACKSTONE, and a run that starts at the front of the name (FILED) is
distinguished from one buried later in it (CONTAINS).

─────────────────────────────────────────────────────────────────────────────
WHAT 'DONE' MEANS

Captured exhibits are remembered by the EDGE, not by its position in the list.
Position is an artefact of whatever filter you happened to type; the fact that
you photographed a filing is not. So --done 4 under --entity "AKIN GUMP" marks
that document, and it still reads as captured tomorrow in an unfiltered queue,
or after the edge table is rebuilt and everything renumbers.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent
                       / 'modules' / 'connectors'))
from namematch import clean, side_of  # noqa: E402

GRADE_RANK = {'ASSERTED': 0, 'REGISTRY': 1, 'CO-OCCURRENCE': 2}

TTY = sys.stdout.isatty()


def c(code, s):
    return f'\033[{code}m{s}\033[0m' if TTY else s


def b(s): return c('1', s)
def dim(s): return c('2', s)
def grn(s): return c('32', s)
def yel(s): return c('33', s)
def red(s): return c('31', s)


# What to look at, per register. Generic advice produces generic screenshots;
# each of these names the FIELD on the page that is the evidence.
LOOK = {
    'senatelda':
        'The CLIENT and REGISTRANT boxes at the top, and the income or expense '
        'figure. Capture the ISSUES box too if it is filled in — that is the '
        'only place the filing says what the lobbying was ABOUT.',
    'usaspending':
        'The AWARD ID, the awarding agency, the period of performance, and '
        'THE DESCRIPTION. The description is the finding; the total is not.',
    'opencorporates':
        'The company number, the jurisdiction, the incorporation DATE and the '
        'status. The date is what disqualifies a namesake.',
    'courtlistener':
        'The caption as the COURT writes it, the court name, and the date '
        'filed. If it is a docket, capture the PARTY TABLE and its roles — '
        'defendant means charged.',
    'federalregister':
        'The document number, the agency, the publication date, and the '
        'paragraph you are quoting. Capture the paragraph, not the abstract.',
    'regulationsgov':
        'The docket number, the agency, and the comment or document type.',
    'fec':
        'The committee id, the cycle, and the line item. Capture the SCHEDULE '
        'letter — A is money in, B is money out, and they are different facts.',
}

DEFAULT_LOOK = ('The identifying number, the date, and the specific line you '
                'are going to quote. Capture the line, not the page.')


def slug(s, n=34):
    return re.sub(r'[^a-z0-9]+', '_', str(s).lower()).strip('_')[:n] or 'x'


def words(s):
    """Uppercase word tokens, for the state key only. Identity questions go to
    namematch; this just has to be stable."""
    return re.sub(r'[^A-Z0-9]+', ' ', str(s or '').upper()).split()


def load(path: Path, entity=None, grade=None, side=None, need_url=True):
    rows = list(csv.DictReader(path.open(newline='', encoding='utf-8-sig')))
    for r in rows:
        for k in ('entity_a', 'entity_b', 'label', 'relationship', 'register',
                  'source', 'amount', 'source_url', 'document_id'):
            if k in r:
                r[k] = clean(r[k])
    if grade:
        rows = [r for r in rows
                if (r.get('assertion_type') or '').upper() == grade.upper()]
    if entity:
        kept = []
        for r in rows:
            s = side_of(r, entity)
            if not s:
                continue
            if side == 'left' and 'L' not in s.upper():
                continue
            if side == 'right' and 'R' not in s.upper():
                continue
            r['_side'] = s
            kept.append(r)
        rows = kept
    if need_url:
        # A CARD WHOSE SOURCE LINE CANNOT BE CLICKED IS A CARD THAT ASKS TO BE
        # TRUSTED. No URL, no queue.
        rows = [r for r in rows if (r.get('source_url') or '').startswith('http')]
    return rows


def edge_key(r):
    """What identifies an exhibit across filters and across rebuilds: the
    relationship itself, not where it landed in today's list."""
    return '|'.join(words(r.get(f)) and ' '.join(words(r.get(f))) or ''
                    for f in ('entity_a', 'relationship', 'entity_b'))


def pair_population(rows):
    """How many entities share each (relationship, entity_b). The denominator."""
    pop = {}
    for r in rows:
        k = (r.get('relationship'), (r.get('entity_b') or '').lower())
        pop.setdefault(k, set()).add((r.get('entity_a') or '').lower())
    return {k: len(v) for k, v in pop.items()}


def rank(rows):
    pop = pair_population(rows)
    seen = set()
    out = []
    for r in rows:
        # One exhibit per relationship, not one per filing — four quarterly
        # filings of the same arrangement is one picture, not four.
        key = (r.get('entity_a'), r.get('relationship'), r.get('entity_b'))
        if key in seen:
            continue
        seen.add(key)
        r['_pop'] = pop.get((r.get('relationship'),
                             (r.get('entity_b') or '').lower()), 1)
        r['_has_amount'] = 1 if (r.get('amount') or '').strip() else 0
        out.append(r)
    out.sort(key=lambda r: (
        GRADE_RANK.get((r.get('assertion_type') or '').upper(), 3),
        r['_pop'],
        -r['_has_amount'],
        (r.get('entity_a') or ''),
    ))
    return out


def statefile(edges: Path) -> Path:
    return edges.with_suffix('.exhibits.json')


STATE_VERSION = 2


def load_state(edges: Path) -> dict:
    p = statefile(edges)
    st = {'v': STATE_VERSION, 'done': [], 'dropped': 0}
    if p.is_file():
        try:
            raw = json.loads(p.read_text())
        except json.JSONDecodeError:
            return st
        done = raw.get('done') or []
        # Version 1 stored positions. A position from a queue we can no longer
        # reconstruct names no particular document, so it is not carried over —
        # silently keeping it would mark an unrelated exhibit captured.
        keys = [d for d in done if isinstance(d, str)]
        st['done'] = keys
        st['dropped'] = len(done) - len(keys)
    return st


def save_state(edges: Path, st: dict) -> None:
    statefile(edges).write_text(json.dumps(
        {'v': STATE_VERSION, 'done': st.get('done', [])}, indent=2) + '\n')


def show(r, i, total, outdir):
    grade = (r.get('assertion_type') or '?').upper()
    badge = grn(grade) if grade == 'ASSERTED' else (
        yel(grade) if grade == 'REGISTRY' else dim(grade))
    name = f'exhibit_{i:02d}_{slug(r.get("entity_a"))}.png'

    s = r.get('_side') or ''
    ltag = yel('  <- your name') if 'L' in s else (
        dim('  <- contains it') if 'l' in s else '')
    rtag = yel('  <- your name') if 'R' in s else (
        dim('  <- contains it') if 'r' in s else '')

    print(f'\n{b(f"  EXHIBIT {i:02d} of {total}")}   {badge}')
    print(f'  {b(str(r.get("entity_a"))[:60])}{ltag}')
    print(f'    {dim(r.get("label") or r.get("relationship") or "")}')
    print(f'  {b(str(r.get("entity_b"))[:60])}{rtag}')

    pop = r.get('_pop', 1)
    print(dim(f'\n     {pop} entit{"y" if pop == 1 else "ies"} in this library '
              f'{"stands" if pop == 1 else "stand"} in the same relationship '
              'to that counterparty'))
    if pop == 1:
        print(yel('     RAREST KIND. One entity crosses this — that is a question.'))

    print(f'\n  {b("OPEN")}        {r.get("source_url")}')
    src = (r.get('source') or '').lower()
    print(f'  {b("LOOK FOR")}    ', end='')
    look = LOOK.get(src, DEFAULT_LOOK)
    first = True
    for line in wrap(look, 62):
        print(line if first else f'              {line}')
        first = False
    print(f'  {b("SCREENSHOT")}  {outdir}/{name}')

    cap = (f'{r.get("entity_a")} {r.get("label") or r.get("relationship")} '
           f'{r.get("entity_b")}')
    reg = r.get('register') or r.get('source') or ''
    extra = ' · '.join(x for x in [r.get('amount'), r.get('effective_date')] if x)
    print(f'\n  {b("CAPTION")}     {cap[:70]}')
    print(f'  {b("SOURCE")}      Source: {reg}{(" · " + extra) if extra else ""}')
    if r.get('document_id'):
        print(f'  {b("DOC")}         {r.get("document_id")}')

    if grade == 'CO-OCCURRENCE':
        print(red('\n     THIS IS TWO NAMES IN ONE DOCUMENT. Not a relationship.'))
        print(dim('     If it goes in the deck it goes in labelled as what it is.'))


def wrap(text, width):
    words, lines, cur = str(text).split(), [], ''
    for w in words:
        t = f'{cur} {w}'.strip()
        if len(t) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def filters(a) -> str:
    """Echo back the filters that produced this queue. A '--done 4' typed
    against a different filter set points at a different document, so the
    command we hand back has to carry them."""
    out = ''
    if a.edges != 'edges.csv':
        out += f' --edges {a.edges}'
    if a.entity:
        out += f' --entity "{a.entity}"'
    if a.side and a.side != 'any':
        out += f' --side {a.side}'
    if a.grade:
        out += f' --grade {a.grade}'
    if a.limit != 20:
        out += f' --limit {a.limit}'
    if a.out != 'assets':
        out += f' --out {a.out}'
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        prog='sentinel exhibits',
        description='The screenshot queue. One document at a time, ranked.')
    ap.add_argument('--edges', default='edges.csv',
                    help='CSV from: bin/sentinel connect edges --out edges.csv')
    ap.add_argument('--out', default='assets',
                    help='where the screenshots will be saved')
    ap.add_argument('--entity', help='only exhibits touching this name')
    ap.add_argument('--side', choices=['left', 'right', 'any'], default='any',
                    help='with --entity: left = the name is the SUBJECT of the '
                         'sentence, right = it is the COUNTERPARTY. Different '
                         'claims. Default any, labelled.')
    ap.add_argument('--grade', help='ASSERTED | REGISTRY | CO-OCCURRENCE')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--next', action='store_true',
                    help='show ONE — the next one not yet marked done')
    ap.add_argument('--done', type=int, metavar='N',
                    help='mark exhibit N captured and show the next')
    ap.add_argument('--reset', action='store_true', help='clear the done list')
    a = ap.parse_args()

    ep = Path(a.edges).expanduser()
    if not ep.is_file():
        print(f'\n  no edges csv at {ep}', file=sys.stderr)
        print('  make one:  bin/sentinel connect edges --out edges.csv\n',
              file=sys.stderr)
        return 2

    if a.side != 'any' and not a.entity:
        print('\n  --side only means something with --entity.\n', file=sys.stderr)
        return 2

    st = load_state(ep)
    if a.reset:
        st = {'done': []}
        save_state(ep, st)
        print('\n  done list cleared\n')
        return 0
    if st.get('dropped'):
        print(dim(f'\n  {st["dropped"]} entr(y/ies) from an older state file '
                  'recorded a POSITION, not a document.'))
        print(dim('  Positions move when you change --entity or rebuild the '
                  'edges. Not carried over.'))

    rows = rank(load(ep, a.entity, a.grade, a.side))
    if not rows:
        print('\n  Nothing in that edge table has a URL behind it.')
        print(dim('  An edge with no clickable source cannot become an exhibit —'))
        print(dim('  a card that asks to be trusted is not evidence.\n'))
        return 2
    rows = rows[:a.limit]
    total = len(rows)
    done = set(st['done'])

    if a.done is not None:
        if not 1 <= a.done <= total:
            print(f'\n  there is no exhibit {a.done} in this queue of {total}.\n',
                  file=sys.stderr)
            return 2
        k = edge_key(rows[a.done - 1])
        if k not in done:
            st['done'].append(k)
            done.add(k)
            save_state(ep, st)
        here = sum(1 for r in rows if edge_key(r) in done)
        print(grn(f'\n  exhibit {a.done:02d} marked captured ({here}/{total} '
                  'in this queue)'))
        a.next = True

    if a.next:
        for i, r in enumerate(rows, 1):
            if edge_key(r) not in done:
                show(r, i, total, a.out)
                print(dim(f'\n  When you have the screenshot:'))
                print(dim(f'    bin/sentinel exhibits{filters(a)} --done {i}'))
                print('')
                return 0
        print(grn(f'\n  All {total} captured. Build the deck:'))
        print(dim(f'    bin/sentinel cards --edges {a.edges} --out {a.out} '
                  f'--theme bright --scenes cards.json\n'))
        return 0

    # The whole queue.
    here = sum(1 for r in rows if edge_key(r) in done)
    print(f'\n{b("  EXHIBIT QUEUE")}  {total} document(s) · {here} captured')
    print(dim('  Ranked: ASSERTED first, then the RAREST domain pair, then'))
    print(dim('  whichever carries a number. The order is the argument.'))
    if a.entity:
        print(dim(f'  L / R = which side of the sentence "{a.entity}" is on.'))
    print('')
    for i, r in enumerate(rows, 1):
        mark = grn(' ok ') if edge_key(r) in done else dim(' -- ')
        g = (r.get('assertion_type') or '?').upper()[:4]
        sd = f'{(r.get("_side") or ""):<2} ' if a.entity else ''
        print(f'  {mark}{i:02d}  {g:<5} {sd}{r["_pop"]:>3}  '
              f'{str(r.get("entity_a"))[:28]:<28} {str(r.get("entity_b"))[:26]}')

    if a.entity:
        left = sum(1 for r in rows if 'L' in (r.get('_side') or '').upper())
        right = sum(1 for r in rows if 'R' in (r.get('_side') or '').upper())
        print(dim(f'\n  {left} of {total} have the name on the LEFT '
                  f'(it is the subject) · {right} on the RIGHT (it is the '
                  'counterparty).'))
        if left and right:
            print(yel('  THOSE ARE DIFFERENT CLAIMS. A deck that mixes them says'))
            print(yel('  nothing. --side left or --side right to take one.'))
        buried = sum(1 for r in rows
                     if (r.get('_side') or '') != (r.get('_side') or '').upper())
        if buried:
            print(dim(f'  {buried} carry the name but not at the front of it — '
                      'check those are not namesakes.'))

    print(dim(f'\n  One at a time:  bin/sentinel exhibits{filters(a)} --next'))
    print(dim('  The screenshot is DOCUMENTARY. A generated image never is.\n'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
