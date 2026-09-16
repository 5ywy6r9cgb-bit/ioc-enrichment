#!/usr/bin/env python3
"""Tests for the screenshot queue.

The bugs these exist to stop are all the same bug in different clothes: the
QUEUE telling you something the EVIDENCE does not say. A name that matched the
wrong side, a name that matched a longer word, a 'captured' mark that landed on
whichever row happened to be fourth today.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import exhibits  # noqa: E402

COLS = ('entity_a,relationship,label,entity_b,assertion_type,confidence,amount,'
        'jurisdiction,authority,register,effective_date,record_date,source_date,'
        'source,document_id,source_url,subject,status')

FAILED = []


def check(name, got, want):
    if got == want:
        print(f'  ok   {name}')
    else:
        print(f'  FAIL {name}\n         got  {got!r}\n         want {want!r}')
        FAILED.append(name)


def row(a, rel, b, grade='ASSERTED', url='https://example.gov/x', amount=''):
    return (f'{a},{rel},retained,{b},{grade},high,{amount},US,,senatelda,,,,'
            f'senatelda,DOC1,{url},sub,active')


def csvfile(lines, tmp):
    p = Path(tmp) / 'edges.csv'
    p.write_text('\n'.join([COLS, *lines]) + '\n', encoding='utf-8')
    return p


def run(args, tmp):
    return subprocess.run(
        [sys.executable, str(HERE / 'exhibits.py'), *args],
        capture_output=True, text=True, cwd=tmp)


# ── name matching ────────────────────────────────────────────────────────────
def test_whole_word():
    r = {'entity_a': 'BLACKSTONE INC', 'entity_b': 'X CORP'}
    check('BLACK does not match BLACKSTONE', exhibits.side_of(r, 'BLACK'), '')
    check('BLACKSTONE matches at the front', exhibits.side_of(r, 'BLACKSTONE'), 'L')


def test_sides():
    r = {'entity_a': 'AKIN GUMP STRAUSS HAUER & FELD LLP',
         'entity_b': 'DEPARTMENT OF THE INTERIOR'}
    check('subject side is L', exhibits.side_of(r, 'AKIN GUMP'), 'L')
    r2 = {'entity_a': '1-800 CONTACTS', 'entity_b': 'AKIN GUMP STRAUSS HAUER'}
    check('counterparty side is R', exhibits.side_of(r2, 'AKIN GUMP'), 'R')
    r3 = {'entity_a': 'AKIN GUMP LLP', 'entity_b': 'AKIN GUMP FOUNDATION'}
    check('both sides is LR', exhibits.side_of(r3, 'AKIN GUMP'), 'LR')
    check('absent is empty', exhibits.side_of(r3, 'COVINGTON'), '')


def test_contains_is_lowercase():
    # The real namesake from the register: Hotel Blackstone is a 1980 hotel,
    # The Blackstone Group was founded in 1985. Both contain the word.
    r = {'entity_a': 'HOTEL BLACKSTONE, INC.', 'entity_b': 'TAX COMMISSION'}
    check('name not at the front is flagged lowercase',
          exhibits.side_of(r, 'BLACKSTONE'), 'l')
    # An article and a corporate suffix are a filing clerk's habit, not a
    # different company — these still count as filed under the name.
    r2 = {'entity_a': 'THE BLACKSTONE GROUP INC.', 'entity_b': 'X'}
    check('article and suffix do not demote it',
          exhibits.side_of(r2, 'BLACKSTONE'), 'L')


def test_clean():
    check('BOM stripped', exhibits.clean('﻿C3.AI, INC.'), 'C3.AI, INC.')
    check('zero-width stripped', exhibits.clean('AKIN​GUMP'), 'AKINGUMP')
    check('replacement char kept — it is lost data, not noise',
          exhibits.clean('C3�AI'), 'C3�AI')


# ── the queue ────────────────────────────────────────────────────────────────
def test_entity_filter_is_direction_aware():
    with tempfile.TemporaryDirectory() as tmp:
        p = csvfile([row('AKIN GUMP LLP', 'represented_by', 'INTERIOR'),
                     row('1-800 CONTACTS', 'represented_by', 'AKIN GUMP LLP'),
                     row('COVINGTON', 'represented_by', 'NAVY')], tmp)
        left = exhibits.load(p, 'AKIN GUMP', side='left')
        right = exhibits.load(p, 'AKIN GUMP', side='right')
        both = exhibits.load(p, 'AKIN GUMP', side='any')
        check('--side left takes only the subject rows', len(left), 1)
        check('--side left row', left[0]['entity_a'], 'AKIN GUMP LLP')
        check('--side right takes only the counterparty rows', len(right), 1)
        check('--side right row', right[0]['entity_a'], '1-800 CONTACTS')
        check('any takes both, excludes the unrelated firm', len(both), 2)


def test_no_url_never_queued():
    with tempfile.TemporaryDirectory() as tmp:
        p = csvfile([row('A CORP', 'represented_by', 'B CORP', url='')], tmp)
        check('an edge with no URL is refused', exhibits.load(p), [])


def test_done_survives_a_different_filter():
    with tempfile.TemporaryDirectory() as tmp:
        p = csvfile([row('AKIN GUMP LLP', 'represented_by', 'INTERIOR'),
                     row('ZZZ CORP', 'represented_by', 'NAVY'),
                     row('1-800 CONTACTS', 'represented_by', 'AKIN GUMP LLP')], tmp)
        # Mark exhibit 1 of the FILTERED queue.
        r1 = run(['--entity', 'AKIN GUMP', '--side', 'left', '--done', '1'], tmp)
        check('filtered --done exits 0', r1.returncode, 0)
        st = json.loads((Path(tmp) / 'edges.exhibits.json').read_text())
        check('state records the edge, not the index',
              st['done'], ['AKIN GUMP LLP|REPRESENTED BY|INTERIOR'])
        # Same document must read as captured in the UNFILTERED queue.
        r2 = run([], tmp)
        line = [l for l in r2.stdout.splitlines() if 'AKIN GUMP LLP' in l
                and 'INTERIOR' in l]
        check('one matching line in the unfiltered queue', len(line), 1)
        check('it is marked captured', 'ok' in line[0], True)
        other = [l for l in r2.stdout.splitlines() if 'ZZZ CORP' in l]
        check('a different row is NOT marked captured', 'ok' in other[0], False)


def test_done_out_of_range_refused():
    with tempfile.TemporaryDirectory() as tmp:
        csvfile([row('A CORP', 'represented_by', 'B CORP')], tmp)
        r = run(['--done', '9'], tmp)
        check('--done past the end exits 2', r.returncode, 2)
        check('and says so', 'no exhibit 9' in r.stderr, True)


def test_old_state_positions_are_dropped():
    with tempfile.TemporaryDirectory() as tmp:
        csvfile([row('A CORP', 'represented_by', 'B CORP')], tmp)
        (Path(tmp) / 'edges.exhibits.json').write_text('{"done": [1, 2, 3]}')
        r = run([], tmp)
        check('v1 positions are not honoured', ' ok ' in r.stdout, False)
        check('and the drop is announced', 'POSITION' in r.stdout, True)


def test_side_without_entity_refused():
    with tempfile.TemporaryDirectory() as tmp:
        csvfile([row('A CORP', 'represented_by', 'B CORP')], tmp)
        r = run(['--side', 'left'], tmp)
        check('--side alone exits 2', r.returncode, 2)


def test_hint_carries_the_filters():
    with tempfile.TemporaryDirectory() as tmp:
        csvfile([row('AKIN GUMP LLP', 'represented_by', 'INTERIOR')], tmp)
        r = run(['--entity', 'AKIN GUMP', '--side', 'left'], tmp)
        check('the repeat command carries --entity',
              '--entity "AKIN GUMP"' in r.stdout, True)
        check('and --side', '--side left' in r.stdout, True)
        check('no backticks in pasteable output', '`' in r.stdout, False)
        check('no angle brackets — zsh reads them as redirection',
              '<' in r.stdout.replace('<- your name', '')
              .replace('<- contains it', ''), False)


def test_bom_does_not_corrupt_the_display():
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / 'edges.csv'
        # A comma inside a name must be quoted — it is in the real writer, and
        # a fixture that skips it tests column-shifting, not BOM handling.
        p.write_text('﻿' + COLS + '\n'
                     + row('"﻿C3.AI, INC."', 'represented_by', 'ZERO MILE')
                     + '\n', encoding='utf-8')
        r = run(['--next'], tmp)
        check('the name prints clean', 'C3.AI, INC.' in r.stdout, True)
        check('no stray BOM in the output', '﻿' in r.stdout, False)


def test_cards_and_exhibits_agree():
    """The deck and the queue must not disagree about who is in the deck.
    They had two separate matchers; this is the test that keeps them one."""
    sys.path.insert(0, str(HERE.parent / 'modules' / 'openmontage' / 'engine'))
    import cards  # noqa: E402
    cases = [({'entity_a': 'AKIN GUMP LLP', 'entity_b': 'INTERIOR'}, 'AKIN GUMP'),
             ({'entity_a': 'DAWSON INC', 'entity_b': 'X'}, 'AWS'),
             ({'entity_a': 'ECOLOGIX', 'entity_b': 'X'}, 'COLOGIX'),
             ({'entity_a': 'HOTEL BLACKSTONE', 'entity_b': 'X'}, 'BLACKSTONE')]
    for row, q in cases:
        check(f'same verdict for {q!r} in {row["entity_a"]!r}',
              cards.side_of(row, q), exhibits.side_of(row, q))
    check('AWS does not match DAWSON',
          exhibits.side_of({'entity_a': 'DAWSON INC', 'entity_b': 'X'}, 'AWS'), '')
    check('COLOGIX does not match ECOLOGIX',
          exhibits.side_of({'entity_a': 'ECOLOGIX', 'entity_b': 'X'}, 'COLOGIX'), '')


def test_no_match_across_the_join():
    """cards.py joined the two names with NO separator, so a string spanning
    the seam existed in the joined text and in neither field."""
    r = {'entity_a': 'AKIN GUMP', 'entity_b': 'CONTACTS INC'}
    seam = 'GUMPCONTACTS'
    # What the old test did, kept so the regression is visible rather than
    # asserted: the string IS present in the naive join.
    check('the seam string exists in the naive join',
          seam.lower() in (r['entity_a'] + r['entity_b']).lower(), True)
    check('and in neither actual field',
          seam.lower() in r['entity_a'].lower()
          or seam.lower() in r['entity_b'].lower(), False)
    check('so it must match nothing', exhibits.side_of(r, seam), '')


def test_mixed_sides_are_warned_about():
    with tempfile.TemporaryDirectory() as tmp:
        csvfile([row('AKIN GUMP LLP', 'represented_by', 'INTERIOR'),
                 row('1-800 CONTACTS', 'represented_by', 'AKIN GUMP LLP')], tmp)
        r = run(['--entity', 'AKIN GUMP'], tmp)
        check('a queue mixing directions says so',
              'DIFFERENT CLAIMS' in r.stdout, True)


if __name__ == '__main__':
    print('\n  exhibits\n')
    for fn in [v for k, v in sorted(globals().items()) if k.startswith('test_')]:
        fn()
    total = len(FAILED)
    print(f'\n  {"FAILED: " + ", ".join(FAILED) if total else "all green"}\n')
    sys.exit(1 if total else 0)
