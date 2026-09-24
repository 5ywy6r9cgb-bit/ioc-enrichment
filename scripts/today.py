#!/usr/bin/env python3
"""
today.py — ONE SCREEN. WHAT NEEDS YOU, IN ORDER, WITH NO AI IN THE LOOP.

─────────────────────────────────────────────────────────────────────────────
THE THING THIS FIXES

The desk is not actually fragmented. `bin/sentinel` already reaches every
module, the connectors already write one ledger, and every piece of analysis
already runs offline. What is missing is not integration — it is a ROUTINE.

Six separate modules each know one thing about what needs doing, and none of
them knows what the others know, so the operator has to hold the whole state
in their head and decide where to start. That is the job this takes over, and
it is the only job the AI was ever doing that mattered day to day.

EVERYTHING BELOW IS DETERMINISTIC. It reads files, a SQLite database and a
JSONL ledger, applies rules that are written down here in the open, and
prints. No model, no network, no key. It works on a plane, it works in ten
years, and it works after you stop paying anyone for anything.

─────────────────────────────────────────────────────────────────────────────
THE ORDER IS THE OPINION

Sections are printed in the order a one-person newsroom actually loses things:

  1  BACKUP        evidence you no longer have is not evidence
  2  CLOCKS        a records-request deadline is the only thing here with a
                   date the law cares about
  3  SECURITY      a key in cleartext, and anything about to be published
                   that describes the machine
  4  PUBLISH       what is blocked, and what is ready
  5  GAPS          what has never been asked
  6  NEXT          one command

A dashboard that sorts by what is INTERESTING will show you the graph every
morning and let the FOIA clock run out. This sorts by what is LOSABLE.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ANSI, but only when a terminal is actually attached — piping this into a
# file should give you plain text.
TTY = sys.stdout.isatty()


def c(code: str, s: str) -> str:
    return f'\033[{code}m{s}\033[0m' if TTY else s


def b(s): return c('1', s)
def dim(s): return c('2', s)
def red(s): return c('31', s)
def yel(s): return c('33', s)
def grn(s): return c('32', s)


def head(n: int, title: str, why: str) -> None:
    print(f'\n{b(f"  {n}. {title}")}')
    print(dim(f'     {why}'))


def days_since(p: Path) -> float | None:
    try:
        return (time.time() - p.stat().st_mtime) / 86400
    except OSError:
        return None


def evidence_dir() -> Path:
    return Path(os.environ.get('SENTINEL_EVIDENCE_DIR', ROOT / 'evidence'))


# ── 1. BACKUP ────────────────────────────────────────────────────────────
#
# EVIDENCE YOU NO LONGER HAVE IS NOT EVIDENCE. For a one-person operation
# this is the single largest risk and nothing in the toolkit was tracking it.
# A drive fails, a laptop is stolen, a directory is deleted by a script — and
# every hashed capture, every ledger line and every claim goes with it.
def backup(state: dict) -> list[str]:
    head(1, 'BACKUP', 'evidence you no longer have is not evidence')
    ev = evidence_dir()
    caps = ev / 'captures'
    n = len(list(caps.glob('*.json'))) if caps.is_dir() else 0
    marker = ev / '.last_backup'
    age = days_since(marker)
    todo = []

    print(f'     {n} capture(s) in the evidence store')
    if age is None:
        print(red('     NO BACKUP HAS EVER BEEN RECORDED.'))
        print(dim('     Copy the evidence store to a second physical device, then:'))
        print(dim('       touch "$SENTINEL_EVIDENCE_DIR/.last_backup"'))
        todo.append('back up the evidence store — it has never been done')
    elif age > 7:
        print(red(f'     Last backup {age:.0f} days ago.'))
        todo.append(f'back up the evidence store — {age:.0f} days since the last one')
    else:
        print(grn(f'     Last backup {age:.1f} days ago.'))

    # Two copies on one machine is one copy.
    print(dim('     THE RULE: two copies on one machine is ONE copy. One of them'))
    print(dim('     has to be a device that is not plugged in right now.'))
    return todo


# ── 2. CLOCKS ────────────────────────────────────────────────────────────
#
# A records-request deadline is the only thing on this desk with a date the
# law cares about. Everything else can wait a week.
def clocks(state: dict) -> list[str]:
    head(2, 'CLOCKS', 'the only deadlines here that a statute cares about')
    todo = []
    # ASK THE RECORDS DESK, DO NOT GUESS FROM A CONFIG FILE.
    #
    # This used to check for modules/pra/.env and, finding none, report that
    # no clock was running. But `sentinel pra foia` keeps requests in
    # evidence/foia_requests.json and needs no database at all — so this
    # screen could say "nothing is being tracked" over a store full of
    # overdue requests. The rules that decide what is overdue live in
    # foia_tracker.js; this runs them rather than restating them.
    store = Path(os.environ.get('PRA_FOIA_STORE', evidence_dir() / 'foia_requests.json'))
    if not store.is_file():
        print(yel('     No records requests are recorded, so no clock is running.'))
        print(dim('     Nothing is overdue because nothing is being tracked — which'))
        print(dim('     is NOT the same as nothing being owed to you.'))
        print(dim('       bin/sentinel pra foia add REQ-ID "Agency" --on YYYY-MM-DD'))
        todo.append('record your open records requests so their clocks run')
        return todo
    import subprocess
    try:
        r = subprocess.run(['node', str(ROOT / 'modules' / 'pra' / 'scripts' / 'foia.js'), '--json'],
                           capture_output=True, text=True, timeout=30,
                           env=dict(os.environ, PRA_FOIA_STORE=str(store)))
        report = json.loads(r.stdout)
    except FileNotFoundError:
        print(yel('     Node is not installed, so the records clock cannot be read.'))
        todo.append('install Node so the records clock can be read')
        return todo
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        print(red(f'     The records desk did not answer ({type(e).__name__}).'))
        print(dim('       bin/sentinel pra foia'))
        todo.append('the records desk would not report — run `sentinel pra foia`')
        return todo

    total, need = report.get('total', 0), report.get('needs_attention', 0)
    print(f'     {total} request(s) tracked, {need} need you')
    for item in (report.get('items') or [])[:5]:
        days = item.get('business_days_elapsed')
        print((red if item.get('priority', 9) <= 3 else yel)(
            f"     {item.get('request_id')}  {item.get('agency') or ''}  —  "
            f"{item.get('label')}" + (f'  ({days} business days)' if days is not None else '')))
    if need:
        top = report['items'][0]
        todo.append(f"{top.get('request_id')}: {top.get('label')}")
    elif total:
        print(grn('     Every request is inside its cadence.'))
    print(dim(f"     {report.get('clock_note', '')}"))
    print(dim('     Ohio R.C. 149.43(C)(2): only hand delivery, electronic'))
    print(dim('     submission or certified mail preserves statutory damages.'))
    return todo


# ── 3. SECURITY ──────────────────────────────────────────────────────────
def security(state: dict) -> list[str]:
    head(3, 'SECURITY', 'a credential in the open, and anything about to be published')
    todo = []
    ledger = evidence_dir() / 'manifests' / 'provenance.jsonl'
    if ledger.is_file():
        try:
            txt = ledger.read_text(errors='replace')
        except OSError:
            txt = ''
        import re
        # The ledger is the file most likely to be handed to a lawyer or a
        # collaborator, and a key in a query string rides along with it.
        hits = re.findall(r'(?i)(api[_-]?key|apikey|token|secret)=([A-Za-z0-9_\-]{8,})', txt)
        if hits:
            print(red(f'     {len(hits)} CREDENTIAL(S) IN CLEARTEXT IN THE LEDGER.'))
            print(dim('     The ledger is the file you would hand to a lawyer.'))
            print(dim('     ROTATE THE KEY FIRST, then verify the chain:'))
            print(dim('       bin/sentinel prov verify "$SENTINEL_EVIDENCE_DIR/manifests/provenance.jsonl"'))
            todo.append(f'ROTATE {len(hits)} exposed key(s) in the provenance ledger')
        else:
            print(grn('     No credential pattern found in the ledger.'))
    else:
        print(dim('     No provenance ledger yet.'))

    eps = ROOT / 'modules' / 'openmontage' / 'episodes'
    if eps.is_dir():
        print(dim('     Before anything ships:'))
        print(dim('       bin/sentinel redact --check modules/openmontage/episodes'))
        print(dim('     It exits 3 on a leak, so it can block a publish step.'))
    return todo


# ── 4. PUBLISH ───────────────────────────────────────────────────────────
def publish(state: dict) -> list[str]:
    head(4, 'PUBLISH', 'what is blocked, and what is ready')
    todo = []
    db = Path.home() / 'SentinelDesk' / 'sentinel.db'
    if not db.is_file():
        print(yel('     The claim layer has never been stood up.'))
        print(dim('     Nothing can be cleared for publication until it exists.'))
        print(dim('       bin/sentinel sdesk doctor'))
        print(dim('       ./scripts/desk_bootstrap.sh'))
        todo.append('stand up the claim layer — nothing is publishable without it')
        return todo
    try:
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        tables = {r[0] for r in con.execute(
            "select name from sqlite_master where type='table'")}
        if 'claims' in tables:
            total = con.execute('select count(*) from claims').fetchone()[0]
            print(f'     {total} claim(s) on the desk')
            if 'citations' in tables:
                uncited = con.execute(
                    'select count(*) from claims c where not exists '
                    '(select 1 from citations x where x.claim_id = c.id)').fetchone()[0]
                if uncited:
                    print(yel(f'     {uncited} claim(s) with NO citation — blocked by design.'))
                    todo.append(f'cite or retire {uncited} uncited claim(s)')
                else:
                    print(grn('     Every claim carries a citation.'))
        else:
            print(dim('     The desk exists but holds no claims table yet.'))
        con.close()
    except sqlite3.Error as e:
        print(dim(f'     Could not read the desk ({e}). Not fatal.'))
    print(dim('     bin/sentinel sdesk claim list     every claim AND what blocks it'))
    print(dim('     Run `sdesk ready` BEFORE you record, not before you publish.'))
    return todo


# ── 5. GAPS ──────────────────────────────────────────────────────────────
def gaps(state: dict) -> list[str]:
    head(5, 'GAPS', 'what has never been asked — not what was not found')
    todo = []
    subs = ROOT / 'modules' / 'connectors' / 'subjects.json'
    caps = evidence_dir() / 'captures'
    if not subs.is_file():
        print(dim('     No subject sets.'))
        return todo
    try:
        sets = json.loads(subs.read_text())
    except json.JSONDecodeError:
        print(dim('     subjects.json will not parse.'))
        return todo

    import re
    asked = set()
    if caps.is_dir():
        for f in caps.glob('live_capture_*.json'):
            stem = f.name[len('live_capture_'):]
            stem = re.sub(r'_\d{4}-\d{2}-\d{2}T.*$', '', stem)
            asked.add(re.sub(r'[^a-z0-9]+', ' ', stem.lower()).strip())

    def fold(s):
        return re.sub(r'[^a-z0-9]+', ' ', str(s).lower()).strip()

    never, partial = [], []
    for name, d in sets.items():
        if name.startswith('/') or not isinstance(d, dict):
            continue
        ss = d.get('subjects') or []
        if not ss:
            continue
        hit = sum(1 for s in ss if any(fold(s) in a or a in fold(s) for a in asked))
        if hit == 0:
            never.append(name)
        elif hit < len(ss):
            partial.append((name, hit, len(ss)))

    if never:
        print(yel(f'     {len(never)} set(s) NEVER asked:'))
        print(dim(f'       {", ".join(sorted(never))}'))
        print(dim('     Those are unasked questions, NOT empty findings. Nothing can'))
        print(dim('     bridge to a domain with nothing in it.'))
        todo.append(f'sweep one of the {len(never)} never-asked sets')
    if partial:
        print(f'     {len(partial)} set(s) partly asked:')
        for n, h, t in sorted(partial, key=lambda x: x[1] / x[2])[:5]:
            print(dim(f'       {h}/{t}  {n}'))
    if not never and not partial and asked:
        print(grn('     Every defined subject has been asked at least once.'))
    print(dim('     bin/sentinel connect coverage     the full denominator'))
    return todo


# ── JSON, for the command center ─────────────────────────────────────────
#
# The web view shows these same sections. It does NOT re-implement them: the
# rules above (a backup older than 7 days, a key in the ledger, an uncited
# claim) exist once, here. This runs each section exactly as the terminal
# does and returns what it printed and what it asked for. Two copies of "what
# is losable" would drift, and the one that drifted would be the one on screen.
SECTIONS = [
    ('backup', 1, 'BACKUP', backup),
    ('clocks', 2, 'CLOCKS', clocks),
    ('security', 3, 'SECURITY', security),
    ('publish', 4, 'PUBLISH', publish),
    ('gaps', 5, 'GAPS', gaps),
]


def emit_json() -> int:
    import contextlib
    import io
    out, todo, state = [], [], {}
    for key, n, title, fn in SECTIONS:
        buf = io.StringIO()
        items, error = [], None
        try:
            with contextlib.redirect_stdout(buf):
                items = fn(state) or []
        except Exception as e:      # a broken section must not hide the rest
            error = str(e)
        lines = buf.getvalue().splitlines()
        # Drop the heading the terminal prints; the page renders its own.
        body = [l[5:] if l.startswith('     ') else l.strip()
                for l in lines[3:]] if len(lines) > 3 else []
        out.append({'key': key, 'n': n, 'title': title,
                    'text': '\n'.join(body).strip(), 'todo': items, 'error': error})
        todo += items
    print(json.dumps({
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'sections': out,
        'next': todo[:1],
        'then': todo[1:6],
        'rule': 'This sorts by what is LOSABLE, not by what is interesting.',
    }, indent=2))
    return 0


# ── 6. NEXT ──────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(
        prog='sentinel today',
        description='What needs you, in order. Deterministic. No model, no network.')
    ap.add_argument('--plain', action='store_true', help='no colour')
    ap.add_argument('--json', action='store_true',
                    help='the same sections, as JSON, for the command center')
    a = ap.parse_args()
    if a.plain or a.json:
        global TTY
        TTY = False
    if a.json:
        return emit_json()

    now = datetime.now(timezone.utc).astimezone()
    print(b(f'\n  SENTINEL — {now:%A %d %B %Y, %H:%M}'))
    print(dim('  Deterministic. No model, no network, no key. This screen works'))
    print(dim('  on a plane, and it works after you stop paying anyone.'))

    todo = []
    state: dict = {}
    for fn in (backup, clocks, security, publish, gaps):
        try:
            todo += fn(state)
        except Exception as e:      # a broken section must not hide the rest
            print(red(f'     section failed: {e}'))

    print(f'\n{b("  6. NEXT")}')
    print(dim('     One thing. Not the list.'))
    if todo:
        print(f'\n     {b("→ " + todo[0])}')
        if len(todo) > 1:
            print(dim('\n     then, in order:'))
            for t in todo[1:6]:
                print(dim(f'       · {t}'))
    else:
        print(grn('\n     Nothing is losable today. Do the work you wanted to do:'))
        print(dim('       bin/sentinel connect coverage'))
        print(dim('       bin/sentinel connect explain "AN ENTITY"'))
        print(dim('       bin/sentinel connect challenge "THAT SAME ENTITY"'))

    print(dim('\n  This sorts by what is LOSABLE, not by what is interesting.'))
    print(dim('  A dashboard that shows you the graph every morning will let the'))
    print(dim('  records clock run out.\n'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
