#!/usr/bin/env python3
"""Tests for the outside-model contract.

The outbound brief is a convenience. The VERIFIER is the load-bearing part: it
is the only thing standing between a model's prose and a script that claims
more than the evidence does. So most of these tests are about the return leg,
and specifically about the ways a plausible sentence can be wrong.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import handoff  # noqa: E402

FAILED = []

EVIDENCE = """# EP03 — FIRSTENERGY

| Records naming **FIRSTENERGY** | 174 of 160,777 in the library |
| ASSERTED | 8 of 174 |

**SAY:** "FIRSTENERGY CORP retained this firm to lobby AKIN GUMP STRAUSS HAUER
& FELD LLP — filed with the Senate under the Lobbying Disclosure Act,
2 U.S.C. 1604, under penalty of perjury. $670,000.00, and that figure is a
floor."

**ON SCREEN:** Source: Senate LDA - $670,000.00 - 2026-04-20
"""


def check(name, got, want):
    if got == want:
        print(f'  ok   {name}')
    else:
        print(f'  FAIL {name}\n         got  {got!r}\n         want {want!r}')
        FAILED.append(name)


def v(text):
    return handoff.verify(text, EVIDENCE)


# ── the figures ──────────────────────────────────────────────────────────────
def test_a_figure_from_the_evidence_passes():
    r = v('FirstEnergy paid $670,000.00 to lobby.')
    check('a figure that is in the evidence is not flagged', r['numbers'], [])


def test_the_same_figure_written_differently_passes():
    r = v('The filing shows 670000 dollars.')
    check('$670,000.00 and 670000 are one claim', r['numbers'], [])


def test_a_rounded_figure_is_caught():
    """This is THE case. A model rounds because prose rounds, and the rounded
    number cannot be sourced to the filing."""
    r = v('FirstEnergy spent nearly $700,000 on lobbying.')
    check('a rounded figure is flagged', '$700,000' in r['numbers'], True)


def test_an_inflated_count_is_caught():
    r = v('Dozens of records — 47 of them — name the company.')
    check('an invented count is flagged', '47' in r['numbers'], True)


def test_an_invented_percentage_is_caught():
    r = v('That is 92% of all filings.')
    check('an invented percentage is flagged', '92%' in r['numbers'], True)


def test_a_timecode_is_not_a_claim():
    r = v('## 0:20-1:10 - THE EVIDENCE')
    check('beat headings are not claims', r['numbers'], [])


def test_a_small_invented_count_is_still_caught():
    """The first exemption skipped any one- or two-digit integer as list
    numbering. That let '47 of them' and '92%' through — both in the exact
    shape a model produces them."""
    check('a bare small count in prose is flagged',
          '47' in v('47 records name the company.')['numbers'], True)
    check('even at the start of a sentence',
          '31' in v('31 filings were sworn.')['numbers'], True)


def test_list_numbering_is_not_a_claim():
    r = v('1. First point\n2. Second point\n3. Third point')
    check('small bare integers are not treated as claims', r['numbers'], [])


def test_a_real_figure_in_the_evidence_is_not_flagged_by_size():
    r = v('174 of 160,777 records carry the name. 8 are sworn.')
    check('every figure here is in the evidence', r['numbers'], [])


# ── the names ────────────────────────────────────────────────────────────────
def test_a_name_from_the_evidence_passes():
    r = v('AKIN GUMP STRAUSS HAUER & FELD LLP was retained.')
    check('a name in the evidence is not flagged', r['names'], [])


def test_an_invented_company_is_caught():
    r = v('The money moved through Bellwether Capital Partners.')
    check('a company not in the evidence is flagged',
          any('Bellwether' in n for n in r['names']), True)


def test_an_invented_person_is_caught():
    r = v('This was arranged by Larry Householder.')
    check('a person not in the evidence is flagged',
          any('Householder' in n for n in r['names']), True)


def test_ordinary_capitalised_prose_is_not_a_name():
    r = v('The Senate filing says so. That Is What It Means.')
    check('grammar capitals do not read as entities', r['names'], [])


# ── exit codes, because a gate nobody can script is not a gate ───────────────
def run(args, cwd):
    return subprocess.run([sys.executable, str(HERE / 'handoff.py'), *args],
                          capture_output=True, text=True, cwd=cwd)


def setup(tmp):
    d = Path(tmp) / 'ep03'
    d.mkdir()
    (d / 'SCRIPT.md').write_text(EVIDENCE, encoding='utf-8')
    return d


def test_clean_prose_exits_zero():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp)
        (Path(tmp) / 'r.md').write_text('They paid $670,000.00. That is a floor.')
        r = run(['ep03', '--verify', 'r.md'], tmp)
        check('clean prose exits 0', r.returncode, 0)
        check('and does not claim the text is true',
              'not the same as it being TRUE' in r.stdout, True)


def test_invented_prose_exits_three():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp)
        (Path(tmp) / 'r.md').write_text('They paid nearly $2,000,000 through '
                                        'Bellwether Capital Partners.')
        r = run(['ep03', '--verify', 'r.md'], tmp)
        check('invented prose exits 3', r.returncode, 3)
        check('the figure is named', '$2,000,000' in r.stdout, True)
        check('the company is named', 'Bellwether' in r.stdout, True)


# ── the outbound brief ───────────────────────────────────────────────────────
def test_text_brief_carries_the_refusals():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp)
        r = run(['ep03', '--tool', 'text'], tmp)
        check('the brief forbids new numbers',
              'not already in the FACTS' in r.stdout, True)
        check('and forbids softening the limitations',
              'Do not soften' in r.stdout, True)
        check('and tells the model it will be checked',
              'run through a verifier' in r.stdout, True)


def test_image_brief_carries_the_absolute_refusals():
    with tempfile.TemporaryDirectory() as tmp:
        setup(tmp)
        r = run(['ep03', '--tool', 'image'], tmp)
        for must in ('NEVER any real building', 'NEVER any person',
                     'ILLUSTRATION · GENERATED IMAGE · NOT A PHOTOGRAPH'):
            check(f'image brief carries: {must[:34]}', must in r.stdout, True)
        check('and says the evidence beats are not its job',
              'They are screenshots' in r.stdout, True)


def test_a_leaking_script_is_never_sent():
    """The brief goes to an outside service. The gate runs BEFORE it is
    written, not after."""
    with tempfile.TemporaryDirectory() as tmp:
        d = setup(tmp)
        (d / 'SCRIPT.md').write_text(EVIDENCE + '\nsee /home/someone/evidence\n')
        r = run(['ep03', '--tool', 'text', '--out', 'b.md'], tmp)
        check('a leaking script is refused', r.returncode, 3)
        check('and says so', 'REFUSED' in r.stdout, True)
        check('and writes nothing', (Path(tmp) / 'b.md').exists(), False)


def test_missing_script_is_not_invented():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / 'ep99').mkdir()
        r = run(['ep99'], tmp)
        check('no script means exit 2', r.returncode, 2)


if __name__ == '__main__':
    print('\n  handoff\n')
    for fn in [val for k, val in sorted(globals().items())
               if k.startswith('test_')]:
        fn()
    print(f'\n  {"FAILED: " + ", ".join(FAILED) if FAILED else "all green"}\n')
    sys.exit(1 if FAILED else 0)
