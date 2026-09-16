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
from namematch import clean, normalise, same_entity, side_of  # noqa: E402

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


INCOME_Q = 'a good-faith estimate of what the firm was PAID, rounded'
EXPENSE_Q = 'what the company SPENT on itself — accounting method on line 14'
AMOUNT_Q = {
    'usaspending': 'obligated — not what was finally paid',
    'fec': 'as reported on that schedule, that period only',
}


def money(v):
    try:
        return f'${float(str(v).replace(",", "").replace("$", "")):,.2f}'
    except (TypeError, ValueError):
        return None


def qualifier(r):
    src = (r.get('source') or '').lower()
    if src == 'senatelda':
        return (EXPENSE_Q if same_entity(r.get('entity_a'), r.get('entity_b'))
                else INCOME_Q)
    return AMOUNT_Q.get(src, 'a floor, not a total')


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
    st = {'v': STATE_VERSION, 'done': [], 'dropped': 0,
          'notes': {}, 'flags': {}}
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
        st['notes'] = raw.get('notes') or {}
        st['flags'] = raw.get('flags') or {}
    return st


def save_state(edges: Path, st: dict) -> None:
    statefile(edges).write_text(json.dumps(
        {'v': STATE_VERSION, 'done': st.get('done', []),
         'notes': st.get('notes', {}), 'flags': st.get('flags', {})},
        indent=2) + '\n')


def show(r, i, total, outdir, notes=(), flags=()):
    grade = (r.get('assertion_type') or '?').upper()
    badge = grn(grade) if grade == 'ASSERTED' else (
        yel(grade) if grade == 'REGISTRY' else dim(grade))
    name = f'exhibit_{i:02d}_{slug(r.get("entity_a"))}.png'

    s = r.get('_side') or ''
    ltag = yel('  <- your name') if 'L' in s else (
        dim('  <- contains it') if 'l' in s else '')
    rtag = yel('  <- your name') if 'R' in s else (
        dim('  <- contains it') if 'r' in s else '')

    # SAME COMPANY ON BOTH SIDES IS ONE BOX, NOT TWO.
    #
    # The self-edge was handled in the episode script and on the frame, and
    # missed HERE — the one an operator actually reads. It printed
    # FIRSTENERGY CORP / retained this firm to lobby / FIRSTENERGY CORP and
    # handed over a ready-to-use caption saying a company retained itself,
    # which is not what the filing says. Line 7 "Self" is ticked: the company
    # employs its own lobbyists.
    selfedge = same_entity(r.get('entity_a'), r.get('entity_b'))

    print(f'\n{b(f"  EXHIBIT {i:02d} of {total}")}   {badge}')
    if selfedge:
        print(f'  {b(str(r.get("entity_a"))[:60])}{ltag}')
        print(f'    {yel("LOBBIED ON ITS OWN BEHALF — in-house, line 7 Self")}')
    else:
        print(f'  {b(str(r.get("entity_a"))[:60])}{ltag}')
        print(f'    {dim(r.get("label") or r.get("relationship") or "")}')
        print(f'  {b(str(r.get("entity_b"))[:60])}{rtag}')

    pop = r.get('_pop', 1)
    if selfedge:
        # "One entity stands in this relationship to itself" is arithmetic,
        # not rarity, and calling it RAREST KIND invites a claim.
        print(dim('\n     Both sides of this record are the same company, so '
                  'there is no'))
        print(dim('     counterparty to count and nothing here is rare.'))
    else:
        print(dim(f'\n     {pop} entit{"y" if pop == 1 else "ies"} in this '
                  f'library {"stands" if pop == 1 else "stand"} in the same '
                  'relationship to that counterparty'))
        if pop == 1:
            print(yel('     RAREST KIND. One entity crosses this — that is a '
                      'question.'))

    print(f'\n  {b("OPEN")}        {r.get("source_url")}')
    src = (r.get('source') or '').lower()
    print(f'  {b("LOOK FOR")}    ', end='')
    look = LOOK.get(src, DEFAULT_LOOK)
    first = True
    for line in wrap(look, 62):
        print(line if first else f'              {line}')
        first = False
    print(f'  {b("SCREENSHOT")}  {outdir}/{name}')

    if selfedge:
        cap = f'{r.get("entity_a")} lobbied on its own behalf'
    else:
        cap = (f'{r.get("entity_a")} {r.get("label") or r.get("relationship")} '
               f'{r.get("entity_b")}')
    reg = r.get('register') or r.get('source') or ''

    # A BARE FIGURE IS NOT A FACT YOU CAN READ OUT.
    #
    # This printed "290000.00" — unformatted, and with no statement of what
    # KIND of number it is. An LD-2 line 12 is income the firm was paid and
    # line 13 is what the organisation spent on itself, and the form makes you
    # pick one. Handing over a caption with a bare figure on it is handing
    # over the error.
    bits = []
    amt = money(r.get('amount'))
    if amt:
        bits.append(f'{amt} — {qualifier(r)}')
    if r.get('effective_date'):
        bits.append(str(r.get('effective_date')))
    print(f'\n  {b("CAPTION")}     {cap[:70]}')
    print(f'  {b("SOURCE")}      Source: {reg}')
    for x in bits:
        print(f'              {x}')
    if r.get('document_id'):
        print(f'  {b("DOC")}         {r.get("document_id")}')

    if notes:
        print(dim('\n  ALREADY RECORDED OFF THIS DOCUMENT'))
        for t in notes:
            print(f'     · {t}')
    if flags:
        print(red('\n  CONTESTED'))
        for t in flags:
            print(red(f'     {t}'))

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
    ap.add_argument('--note', metavar='TEXT',
                    help='what the DOCUMENT said that the register did not — '
                         'a termination date, an amendment, an id number. '
                         'Use with --done or --flag.')
    ap.add_argument('--flag', type=int, metavar='N',
                    help='exhibit N contradicts the record. It will not become '
                         'a card until you clear it. Needs --note.')
    ap.add_argument('--clear', type=int, metavar='N',
                    help='the discrepancy on exhibit N is resolved')
    ap.add_argument('--notes', action='store_true',
                    help='everything recorded off the documents so far')
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
    def key_at(n):
        """Resolve a queue position to the edge it names, so a note survives
        the filter it was typed under."""
        if not 1 <= n <= len(ranked):
            print(f'\n  there is no exhibit {n} in this queue of '
                  f'{len(ranked)}.\n', file=sys.stderr)
            raise SystemExit(2)
        return edge_key(ranked[n - 1]), ranked[n - 1]

    if st.get('dropped'):
        print(dim(f'\n  {st["dropped"]} entr(y/ies) from an older state file '
                  'recorded a POSITION, not a document.'))
        print(dim('  Positions move when you change --entity or rebuild the '
                  'edges. Not carried over.'))

    ranked = rank(load(ep, a.entity, a.grade, a.side))
    rows = ranked
    if not rows:
        print('\n  Nothing in that edge table has a URL behind it.')
        print(dim('  An edge with no clickable source cannot become an exhibit —'))
        print(dim('  a card that asks to be trusted is not evidence.\n'))
        return 2
    rows = rows[:a.limit]
    ranked = rows
    total = len(rows)
    done = set(st['done'])

    # ── WHAT THE DOCUMENT SAID ──────────────────────────────────────────────
    #
    # A filing carries facts the register's row does not. Exhibit 01 of the
    # FirstEnergy queue was a TERMINATION report dated 6/30/2025, an AMENDMENT
    # to an earlier version, with a Senate id and a House id on it — none of
    # which is in the edge table, and all of which is gone the moment the
    # screenshot is filed. Capturing without recording is write-only work.
    if a.notes:
        if not st['notes'] and not st['flags']:
            print(dim('\n  Nothing recorded off a document yet.'))
            print(dim('  When a filing says something the register did not:'))
            print(dim(f'    bin/sentinel exhibits{filters(a)} --done N '
                      '--note "what it said"\n'))
            return 0
        print(f'\n{b("  OFF THE DOCUMENTS")}\n')
        for i, r in enumerate(rows, 1):
            k = edge_key(r)
            ns, fs = st['notes'].get(k, []), st['flags'].get(k, [])
            if not ns and not fs:
                continue
            print(f'  {i:02d}  {str(r.get("entity_a"))[:30]} -> '
                  f'{str(r.get("entity_b"))[:30]}')
            for t in ns:
                print(f'        · {t}')
            for t in fs:
                print(red(f'        CONTESTED  {t}'))
            print('')
        return 0

    if a.clear is not None:
        k, _ = key_at(a.clear)
        if st['flags'].pop(k, None):
            save_state(ep, st)
            print(grn(f'\n  exhibit {a.clear:02d} no longer contested\n'))
        else:
            print(dim(f'\n  exhibit {a.clear:02d} was not contested\n'))
        return 0

    if a.flag is not None:
        if not a.note:
            print('\n  --flag needs --note. A contested exhibit with no reason '
                  'recorded\n  is just a missing exhibit.\n', file=sys.stderr)
            return 2
        k, r = key_at(a.flag)
        st['flags'].setdefault(k, []).append(a.note)
        save_state(ep, st)
        print(red(f'\n  exhibit {a.flag:02d} CONTESTED'))
        print(f'  {r.get("entity_a")} -> {r.get("entity_b")}')
        print(f'    {a.note}')
        print(dim('\n  It stays out of the card deck until this is resolved:'))
        print(dim(f'    bin/sentinel exhibits{filters(a)} --clear {a.flag}\n'))
        return 0

    if a.note and a.done is None:
        print('\n  --note attaches to an exhibit. Use --done N --note "..." '
              'or\n  --flag N --note "..."\n', file=sys.stderr)
        return 2


    if a.done is not None:
        if not 1 <= a.done <= total:
            print(f'\n  there is no exhibit {a.done} in this queue of {total}.\n',
                  file=sys.stderr)
            return 2
        k = edge_key(rows[a.done - 1])
        if k not in done:
            st['done'].append(k)
            done.add(k)
        if a.note:
            st['notes'].setdefault(k, []).append(a.note)
        save_state(ep, st)
        here = sum(1 for r in rows if edge_key(r) in done)
        print(grn(f'\n  exhibit {a.done:02d} marked captured ({here}/{total} '
                  'in this queue)'))
        a.next = True

    if a.next:
        for i, r in enumerate(rows, 1):
            if edge_key(r) not in done:
                k = edge_key(r)
                show(r, i, total, a.out,
                     st['notes'].get(k, []), st['flags'].get(k, []))
                print(dim(f'\n  When you have the screenshot:'))
                print(dim(f'    bin/sentinel exhibits{filters(a)} --done {i}'))
                print(dim('  If the document says something the register did '
                          'not, record it:'))
                print(dim(f'    bin/sentinel exhibits{filters(a)} --done {i} '
                          '--note "termination date 6/30/2025"'))
                print(dim('  If it CONTRADICTS the record, flag it instead:'))
                print(dim(f'    bin/sentinel exhibits{filters(a)} --flag {i} '
                          '--note "name order differs from the register"'))
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
    contested = 0
    for i, r in enumerate(rows, 1):
        k = edge_key(r)
        if st['flags'].get(k):
            mark, contested = red(' !! '), contested + 1
        elif k in done:
            mark = grn(' ok ')
        else:
            mark = dim(' -- ')
        g = (r.get('assertion_type') or '?').upper()[:4]
        sd = f'{(r.get("_side") or ""):<2} ' if a.entity else ''
        note = dim('  *') if st['notes'].get(k) else ''
        print(f'  {mark}{i:02d}  {g:<5} {sd}{r["_pop"]:>3}  '
              f'{str(r.get("entity_a"))[:28]:<28} '
              f'{str(r.get("entity_b"))[:24]}{note}')
    if contested:
        print(red(f'\n  {contested} CONTESTED — something on the document does '
                  'not match the record.'))
        print(dim('  These do not become cards. See why:  '
                  f'bin/sentinel exhibits{filters(a)} --notes'))

    if a.entity:
        # BOTH is its own bucket, not a tick in each column. Counting a
        # both-sides row as one LEFT and one RIGHT printed "20 of 20 on the
        # LEFT, 1 on the RIGHT" — twenty-one out of twenty — and then advised
        # --side left to an operator who had already passed --side left.
        both = [r for r in rows if len(set((r.get('_side') or '').upper())) > 1]
        left = sum(1 for r in rows
                   if (r.get('_side') or '').upper() == 'L')
        right = sum(1 for r in rows
                    if (r.get('_side') or '').upper() == 'R')
        print(dim(f'\n  {left} of {total} have the name ONLY on the left '
                  f'(it is the subject) · {right} only on the right '
                  f'(it is the counterparty) · {len(both)} on both.'))
        if left and right and a.side == 'any':
            print(yel('  THOSE ARE DIFFERENT CLAIMS. A deck that mixes them says'))
            print(yel('  nothing. --side left or --side right to take one.'))

        selves = [r for r in rows if same_entity(r.get('entity_a'),
                                                 r.get('entity_b'))]
        if selves:
            print(yel(f'  {len(selves)} row(s) have the SAME company on both '
                      'sides. On a lobbying'))
            print(yel('  filing that is IN-HOUSE work, not a relationship — a '
                      'real fact and'))
            print(yel('  a meaningless arrow. Do not draw it as a card.'))

        buried = sum(1 for r in rows
                     if (r.get('_side') or '') != (r.get('_side') or '').upper())
        if buried:
            print(dim(f'  {buried} carry the name but not at the front of it — '
                      'check those are not namesakes.'))

        # THE HEAD TEST CANNOT CATCH THIS ONE.
        #
        # FIRSTENERGY CAPITAL CORP. is a Calgary investment bank. FIRSTENERGY
        # CHAINS & TECHNOLOGIES files in India. FIRSTENERGY SRL files in
        # Romania. Every one of them is filed under a name that BEGINS with
        # the query, so every one passes the name rule correctly — and they
        # are different companies. What separates them is jurisdiction and
        # incorporation date, which is a question only the document answers.
        names = {normalise(r.get('entity_a')) for r in rows}
        if len(names) > 1:
            print(dim(f'\n  {total} row(s), {len(names)} distinct name(s) on '
                      'the subject side.'))
            print(yel('  A REGISTER FILING UNDER SEVERAL NAMES MAY BE FILING '
                      'FOR SEVERAL COMPANIES.'))
            print(dim('  These all pass the name test — the query is at the '
                      'front of each. Only'))
            print(dim('  the jurisdiction and the incorporation date on the '
                      'document can separate'))
            print(dim('  a subsidiary from a stranger that picked the same '
                      'word.'))

    print(dim(f'\n  One at a time:  bin/sentinel exhibits{filters(a)} --next'))
    print(dim('  The screenshot is DOCUMENTARY. A generated image never is.\n'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
