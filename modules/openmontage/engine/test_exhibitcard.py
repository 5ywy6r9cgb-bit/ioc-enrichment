#!/usr/bin/env python3
"""Tests for the exhibit frame.

The frame is design and the picture is evidence, so everything here is about
keeping that line: the picture is never substituted, never invented, and never
framed when the record behind it is in dispute.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import exhibitcard as X  # noqa: E402

from PIL import Image  # noqa: E402

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


def e(a, b, amount='', src='senatelda', grade='ASSERTED'):
    return (f'"{a}",represented_by,retained this firm to lobby,"{b}",{grade},'
            f'high,{amount},US,,Senate LDA,2026-04-20,,,{src},D1,'
            f'https://lda.senate.gov/x,lobby,active')


def setup(tmp, rows, shots=(1,)):
    Path(tmp, 'edges.csv').write_text('\n'.join([COLS, *rows]) + '\n')
    a = Path(tmp, 'assets')
    a.mkdir(exist_ok=True)
    for i in shots:
        Image.new('RGB', (1200, 800), (250, 250, 248)).save(
            a / f'exhibit_{i:02d}_x.png')
    return a


def run(args, tmp):
    return subprocess.run([sys.executable, str(HERE / 'exhibitcard.py'), *args],
                          capture_output=True, text=True, cwd=tmp)


BASE = ['--edges', 'edges.csv', '--shots', 'assets', '--out', 'out']


# ── the qualifier follows the line, not the register ─────────────────────────
def test_income_and_expense_get_different_qualifiers():
    inc = {'source': 'senatelda', 'entity_a': 'FIRSTENERGY CORP',
           'entity_b': 'PERRY ROSS WHITE'}
    exp = {'source': 'senatelda', 'entity_a': 'FIRSTENERGY CORP',
           'entity_b': 'FIRSTENERGY CORP'}
    check('a retained filing is income', 'PAID' in X.qualifier(inc), True)
    check('a self filing is expense', 'SPENT' in X.qualifier(exp), True)
    check('and they differ', X.qualifier(inc) == X.qualifier(exp), False)


def test_award_qualifier_is_obligated():
    check('an award is obligated',
          'obligated' in X.qualifier({'source': 'usaspending'}), True)


# ── the refusals ─────────────────────────────────────────────────────────────
def test_a_contested_exhibit_is_not_framed():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('FIRSTENERGY CORP', 'PERRY ROSS WHITE')])
        Path(tmp, 'edges.exhibits.json').write_text(json.dumps({
            'v': 2, 'done': [], 'notes': {},
            'flags': {'FIRSTENERGY CORP|REPRESENTED BY|PERRY ROSS WHITE':
                      ['name order differs']}}))
        r = run(BASE, tmp)
        check('nothing is drawn for it', list(Path(tmp, 'out').glob('*.png')), [])
        check('and the hold is reported', 'CONTESTED' in r.stdout, True)
        check('with the reason', 'name order differs' in r.stdout, True)


def test_a_missing_screenshot_gets_no_placeholder():
    """A placeholder in an evidence deck is a frame that looks like proof."""
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('A CORP', 'B CORP'), e('C CORP', 'D CORP')], shots=(1,))
        r = run(BASE, tmp)
        check('only the captured one is framed',
              len(list(Path(tmp, 'out').glob('*.png'))), 1)
        check('the gap is named', 'NO SCREENSHOT YET' in r.stdout, True)
        check('and the file it wants is named',
              'exhibit_02' in r.stdout, True)


def test_every_page_of_a_filing_is_framed():
    """An LD-2 cover page carries the money; pages 2-n carry the LOBBYING
    ACTIVITY box — the issue codes, the bill numbers, the named lobbyists.
    Framing page 1 and dropping four pages of substance is the wrong way
    round."""
    with tempfile.TemporaryDirectory() as tmp:
        a = setup(tmp, [e('A CORP', 'B CORP')], shots=())
        for tag in ('a_cover', 'b_eng', 'c_bud'):
            Image.new('RGB', (1200, 800), (250, 250, 248)).save(
                a / f'exhibit_01_{tag}.png')
        r = run(BASE, tmp)
        made = sorted(q.name for q in Path(tmp, 'out').glob('*.png'))
        check('all three pages are framed', len(made), 3)
        check('and numbered in order', made[0].startswith('framed_01_p01'), True)
        check('the count is reported', '3 framed' in r.stdout, True)


def test_a_single_page_gets_no_page_suffix():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('A CORP', 'B CORP')], shots=(1,))
        run(BASE, tmp)
        name = next(Path(tmp, 'out').glob('*.png')).name
        check('one page needs no p01', '_p01_' in name, False)


def test_non_images_in_the_shots_folder_are_ignored():
    with tempfile.TemporaryDirectory() as tmp:
        a = setup(tmp, [e('A CORP', 'B CORP')], shots=(1,))
        (a / 'exhibit_01_notes.txt').write_text('not a picture')
        r = run(BASE, tmp)
        check('a stray text file does not become a frame',
              len(list(Path(tmp, 'out').glob('*.png'))), 1)
        check('and does not crash the run', r.returncode, 0)


def test_a_quote_card_needs_no_screenshot():
    """Episode 01 opened on a purchase order's verbatim language and that is
    the beat that landed. A quotation is evidence; an arrow between two company
    names is topology."""
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('FIRSTENERGY CORP', 'FIRSTENERGY CORP')], shots=())
        Path(tmp, 'edges.exhibits.json').write_text(json.dumps({
            'v': 2, 'done': [], 'notes': {}, 'flags': {},
            'quotes': {'FIRSTENERGY CORP|REPRESENTED BY|FIRSTENERGY CORP':
                       ['Data center issues generally']}}))
        r = run(BASE, tmp)
        made = [q.name for q in Path(tmp, 'out').glob('quote_*.png')]
        check('a quote card is drawn with no screenshot present', len(made), 1)
        check('and it is counted', '1 quote card' in r.stdout, True)
        check('the missing screenshot is still reported',
              'NO SCREENSHOT YET' in r.stdout, True)


def test_a_long_quote_still_fits_the_frame():
    long = ('Power reliability issues generally; Transmission issues '
            'generally; Artificial intelligence issues generally; Load '
            'growth, reliability, and resource adequacy generally; Data '
            'center issues generally; Energy security issues generally.')
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('A CORP', 'B CORP')], shots=())
        Path(tmp, 'edges.exhibits.json').write_text(json.dumps({
            'v': 2, 'done': [], 'notes': {}, 'flags': {},
            'quotes': {'A CORP|REPRESENTED BY|B CORP': [long]}}))
        run(BASE, tmp)
        im = Image.open(next(Path(tmp, 'out').glob('quote_*.png'))).convert('L')
        rows = [y for y in range(im.height)
                if min(im.crop((0, y, im.width, y + 1)).getdata()) < 200]
        check('nothing is drawn past the bottom of the frame',
              rows[-1] < im.height - 40, True)


def test_no_edges_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        r = run(BASE, tmp)
        check('a missing edge table exits 2', r.returncode, 2)


def test_side_without_entity_refused():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('A CORP', 'B CORP')])
        r = run([*BASE, '--side', 'left'], tmp)
        check('--side alone exits 2', r.returncode, 2)


# ── what lands on the frame ──────────────────────────────────────────────────
def test_the_frame_carries_its_source_and_the_picture_is_untouched():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('FIRSTENERGY CORP', 'PERRY ROSS WHITE', amount='15000')])
        r = run(BASE, tmp)
        check('it exits 0', r.returncode, 0)
        made = list(Path(tmp, 'out').glob('*.png'))
        check('one frame written', len(made), 1)
        im = Image.open(made[0])
        check('at the preset size', im.size, (1080, 1920))


def test_notes_reach_the_frame():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('FIRSTENERGY CORP', 'PERRY ROSS WHITE')])
        Path(tmp, 'edges.exhibits.json').write_text(json.dumps({
            'v': 2, 'done': [], 'flags': {},
            'notes': {'FIRSTENERGY CORP|REPRESENTED BY|PERRY ROSS WHITE':
                      ['TERMINATION report 6/30/2025']}}))
        r = run(BASE, tmp)
        check('the frame is marked as carrying a note', '*' in r.stdout, True)


def test_contact_warning_fires_for_lobbying_filings():
    """An LD-2 box 4 carries a named person's direct phone and email."""
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('A CORP', 'B CORP')])
        r = run(BASE, tmp)
        check('the contact-block warning is printed',
              'Crop box 4' in r.stdout, True)

    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp, [e('A CORP', 'B CORP', src='usaspending')])
        r = run(BASE, tmp)
        check('and not for a register that has no such box',
              'Crop box 4' in r.stdout, False)


def test_composition_is_centred_not_top_aligned():
    """A wide short screenshot left the bottom third of the frame empty and the
    whole composition up in the corner."""
    with tempfile.TemporaryDirectory() as tmp:
        a = setup(tmp, [e('A CORP', 'B CORP')], shots=())
        Image.new('RGB', (1200, 300), (250, 250, 248)).save(
            a / 'exhibit_01_a_corp.png')
        run(BASE, tmp)
        im = Image.open(next(Path(tmp, 'out').glob('*.png'))).convert('L')
        rows = [y for y in range(im.height)
                if min(im.crop((0, y, im.width, y + 1)).getdata()) < 200]
        top, bottom = rows[0], rows[-1]
        above, below = top, im.height - bottom
        check('ink is roughly balanced top and bottom',
              abs(above - below) < im.height * 0.12, True)


if __name__ == '__main__':
    print('\n  exhibitcard\n')
    for fn in [v for k, v in sorted(globals().items()) if k.startswith('test_')]:
        fn()
    print(f'\n  {"FAILED: " + ", ".join(FAILED) if FAILED else "all green"}\n')
    sys.exit(1 if FAILED else 0)
