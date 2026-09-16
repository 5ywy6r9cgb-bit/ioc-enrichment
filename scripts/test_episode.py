#!/usr/bin/env python3
"""Tests for the episode package builder.

The failure this exists to prevent is a script that says something the edge
table does not. Every check below is some version of: did a number arrive on
the page without the total it came out of, did a claim arrive without the
document that carries it, or did the machine's own filesystem end up in the
file that leaves the building.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import episode  # noqa: E402

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


def e(a, b, grade='ASSERTED', amount='', reg='Senate LDA', src='senatelda',
      rel='represented_by', doc='D1', url='https://lda.senate.gov/filings/x'):
    return (f'"{a}",{rel},retained this firm to lobby,"{b}",{grade},high,'
            f'{amount},US,2 U.S.C. 1604,{reg},2026-04-20,,,{src},{doc},{url},'
            f'lobby,active')


def build(lines, tmp):
    (Path(tmp) / 'edges.csv').write_text('\n'.join([COLS, *lines]) + '\n',
                                         encoding='utf-8')
    return Path(tmp) / 'edges.csv'


def run(args, tmp):
    return subprocess.run(
        [sys.executable, str(HERE / 'episode.py'), *args],
        capture_output=True, text=True, cwd=tmp)


def make(tmp, lines, extra=()):
    build(lines, tmp)
    r = run(['FIRSTENERGY', '--id', 'ept', '--out', f'{tmp}/ept', *extra], tmp)
    d = Path(tmp) / 'ept'
    return r, (d / 'SCRIPT.md'), (d / 'PRODUCTION.md')


# ── the refusals ─────────────────────────────────────────────────────────────
def test_refuses_without_asserted_evidence():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'FR-1', 'CO-OCCURRENCE'),
                             e('FIRSTENERGY CORP', 'OHIO', 'REGISTRY')])
        check('a co-occurrence-only entity is refused', r.returncode, 3)
        check('and says why', 'NO ASSERTED EVIDENCE' in r.stdout, True)
        check('and writes no script', s.exists(), False)


def test_refuses_when_nothing_has_a_source():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP', url='')])
        check('an unsourceable deck is refused', r.returncode, 3)
        check('and writes no script', s.exists(), False)


def test_unknown_name_is_not_guessed_at():
    with tempfile.TemporaryDirectory() as tmp:
        build([e('AEP ENERGY INC', 'AKIN GUMP')], tmp)
        r = run(['FIRSTENERGY', '--out', f'{tmp}/x'], tmp)
        check('a name the table does not carry exits 2', r.returncode, 2)


# ── the name discipline reaches this far ─────────────────────────────────────
def test_namesake_is_excluded():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP', amount='670000'),
                             e('AEP ENERGY INC', 'AKIN GUMP', amount='999999')])
        txt = s.read_text()
        check('the subject is in the script', 'FIRSTENERGY CORP' in txt, True)
        check('a different company is NOT', 'AEP ENERGY' in txt, False)
        check('nor is its money', '999,999' in txt, False)


# ── the numbers ──────────────────────────────────────────────────────────────
def test_every_count_carries_its_denominator():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [
            e('FIRSTENERGY CORP', 'AKIN GUMP', amount='670000'),
            e('FIRSTENERGY CORP', 'VALIANT STRATEGIES', amount='290000'),
            e('FIRSTENERGY CORP', 'OHIO', 'REGISTRY', src='opencorporates',
              reg='OpenCorporates', rel='registered_in'),
            e('AEP ENERGY INC', 'AKIN GUMP')])
        txt = s.read_text()
        check('the match is stated out of the library', '3 of 4' in txt, True)
        check('the grade is stated out of the match', '2 of 3' in txt, True)
        check('amounts are called a floor', 'a floor' in txt.lower(), True)


def test_amount_never_appears_without_its_qualifier():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP', amount='670000')])
        for line in s.read_text().splitlines():
            if '$670,000' in line and line.startswith('**SAY:**'):
                check('the spoken line qualifies the figure',
                      'floor' in line, True)


def test_singular_counts_use_singular_verbs():
    """These lines are READ ALOUD. '1 records are' is the first thing the
    audience hears."""
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [
            e('FIRSTENERGY CORP', 'AKIN GUMP', amount='670000'),
            e('FIRSTENERGY CORP', 'FR-1', 'CO-OCCURRENCE',
              src='federalregister', reg='Federal Register', rel='mentioned_in')])
        txt = s.read_text()
        check('no "1 record ... are"', '1 record I hold on this name are' in txt,
              False)
        check('singular reads correctly',
              '1 of the 2 records I hold on this name is two names' in txt, True)


def test_rare_pair_is_called_a_question():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'VALIANT STRATEGIES')])
        check('a lone crossing is not presented as an answer',
              'rare is a question, not an answer' in s.read_text(), True)


def test_shared_counterparty_is_called_a_service():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP'),
                             e('AMAZON WEB SERVICES', 'AKIN GUMP'),
                             e('ENERGY HARBOR LLC', 'AKIN GUMP')])
        txt = s.read_text()
        check('the denominator is on the card', '3 entities' in txt, True)
        check('and a shared counterparty is called a service',
              'SERVICE that many people buy' in txt, True)


# ── the limitations beat ─────────────────────────────────────────────────────
def test_single_register_is_declared():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP'),
                             e('FIRSTENERGY CORP', 'VALIANT STRATEGIES')])
        check('relying on one register is said out loud',
              'ONE register' in s.read_text(), True)


def test_unreachable_registers_are_named():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP')])
        txt = s.read_text()
        check('FARA is named as unreachable', 'cannot read FARA' in txt, True)
        check('Ohio JLEC is named', 'Ohio JLEC' in txt, True)


def test_co_occurrence_card_labels_itself():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP'),
                             e('FIRSTENERGY CORP', 'FR-1', 'CO-OCCURRENCE',
                               src='federalregister', rel='mentioned_in')],
                       extra=['--grade', 'ALL'])
        check('a co-occurrence card says what it is',
              'TWO NAMES IN ONE DOCUMENT' in s.read_text(), True)


# ── the security split ───────────────────────────────────────────────────────
def test_script_carries_no_machine_detail():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, prod = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP')])
        txt = s.read_text()
        check('no edges path in the script', 'edges.csv' in txt, False)
        check('no bin/sentinel in the script', 'bin/sentinel' in txt, False)
        check('no tmp path in the script', tmp in txt, False)
        check('the commands live in the production sheet',
              'bin/sentinel' in prod.read_text(), True)
        check('and it is marked not for publication',
              'NOT FOR PUBLICATION' in prod.read_text(), True)


def test_script_passes_the_redaction_gate():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP', amount='670000')])
        g = subprocess.run([sys.executable, str(HERE / 'redact.py'),
                            '--check', str(s)], capture_output=True, text=True)
        check('the generated script clears the publication gate',
              g.returncode, 0)


# ── direction ────────────────────────────────────────────────────────────────
def test_direction_split_is_reported():
    with tempfile.TemporaryDirectory() as tmp:
        r, s, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP'),
                             e('SOME CLIENT LLC', 'FIRSTENERGY CORP')])
        check('a mixed-direction entity is flagged',
              'opposite sentences' in r.stdout, True)


def test_side_filter_narrows_the_package():
    with tempfile.TemporaryDirectory() as tmp:
        build([e('FIRSTENERGY CORP', 'AKIN GUMP'),
               e('SOME CLIENT LLC', 'FIRSTENERGY CORP')], tmp)
        run(['FIRSTENERGY', '--id', 'ept', '--out', f'{tmp}/ept',
             '--side', 'left'], tmp)
        txt = (Path(tmp) / 'ept' / 'SCRIPT.md').read_text()
        check('--side left drops the counterparty rows',
              'SOME CLIENT' in txt, False)


def test_no_angle_brackets_or_backticks_in_terminal_output():
    with tempfile.TemporaryDirectory() as tmp:
        r, _, _ = make(tmp, [e('FIRSTENERGY CORP', 'AKIN GUMP')])
        check('no backticks in pasteable output', '`' in r.stdout, False)
        check('no angle brackets — zsh reads them as redirection',
              '<' in r.stdout or '>' in r.stdout, False)


if __name__ == '__main__':
    print('\n  episode\n')
    for fn in [v for k, v in sorted(globals().items()) if k.startswith('test_')]:
        fn()
    print(f'\n  {"FAILED: " + ", ".join(FAILED) if FAILED else "all green"}\n')
    sys.exit(1 if FAILED else 0)
