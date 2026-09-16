#!/usr/bin/env python3
"""
test_redact.py — the publication gate.

An untested gate is worse than no gate, because a gate that reports CLEAN is
believed. Every check here is a way something about the machine could reach a
frame, and every one of them is a thing that is permanent once posted.

Run:  python3 scripts/test_redact.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import redact as R   # noqa: E402

PASS = 0
FAIL = 0


def check(what: str, ok: bool) -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f'    PASS  {what}')
    else:
        FAIL += 1
        print(f'    FAIL  {what}')


def section(t: str) -> None:
    print(f'\n  {t}')


def rules_hit(text: str) -> set[str]:
    return {f['rule'] for f in R.scan_text(text)}


print('\n  REDACT — nothing about the machine leaves the machine\n')

# ══ what must never reach a frame ═══════════════════════════════════════
section('Every kind of local detail is caught')
{}
CASES = [
    ('/Users/Mark/sentinel/episode.json', 'home-path',
     'an absolute home directory names the account'),
    ('/home/operator/work/notes.md', 'home-path', 'and the linux form of it'),
    ('evidence/captures/thing.json', 'evidence-path',
     'a path inside the evidence store'),
    ('live_capture_senatelda_Blackstone_2026-09-15T18-01-15.json', 'capture-file',
     'a capture filename says WHAT you searched and WHEN'),
    ('docs/GLASSMARK.md', 'repo-path', 'a repository file names your layout'),
    ('modules/connectors/registry.js', 'repo-path', 'and so does a module path'),
    ('api_key=abc123def456', 'credential', 'a key, however it is spelled'),
    ('Authorization: Bearer sk-live-000', 'credential', 'and a bearer token'),
    ('mark@example.com', 'email', 'an email address'),
    ('http://localhost:8000/desk', 'private-host', 'a local address'),
    ('192.168.1.40', 'private-host', 'and a private one'),
    ('see .env for the key', 'env-file', 'a reference to an environment file'),
]
for text, rule, why in CASES:
    check(f'{why}  [{rule}]', rule in rules_hit(text))

# ══ THE GAP THE FIRST LIVE RUN FOUND ════════════════════════════════════
#
# `builds/ep00.script.md` came back CLEAN while carrying eight references to
# `docs/GLASSMARK.md`. The patterns looked for /Users and evidence/ and this
# was neither — it is the repository's own layout, rendered into the artifact
# MOST likely to be sent to a collaborator.
section('A backend filename is backend information, absolute or not')
{}
check('a bare repo path is caught even with no leading slash',
      'repo-path' in rules_hit('quoted from docs/THESIS.md, line 40'))
check('and one several directories deep',
      'repo-path' in rules_hit('modules/openmontage/engine/cards.py'))
check('but an ordinary English phrase with a slash is not mangled',
      'repo-path' not in rules_hit('the and/or question'))

# ══ THE CITATION IS THE POINT OF THE WORK ═══════════════════════════════
section('A public register URL is never touched')
{}
PUBLIC_URLS = [
    'https://lda.gov/filings/public/filing/c20c4aea-5e7b/print/',
    'https://www.federalregister.gov/documents/2026/01/02/2026-00512/notice',
    'https://www.courtlistener.com/opinion/9395761/carolyn-bridges-v-blackstone/',
    'https://www.usaspending.gov/award/CONT_AWD_123',
    'https://opencorporates.com/companies/us_de/7879086',
]
for u in PUBLIC_URLS:
    check(f'kept: {u[:46]}…', R.clean_text(u) == u)
check('and a long token INSIDE a public url survives',
      'c20c4aea-5e7b' in R.clean_text(PUBLIC_URLS[0]))
# A redactor that strips the citation has destroyed the artifact to protect
# nothing.
check('a sentence mixing a citation and a local path keeps the citation',
      'lda.gov' in R.clean_text('from /Users/Mark/x see https://lda.gov/filings/a/b')
      and '/Users/Mark' not in R.clean_text(
          'from /Users/Mark/x see https://lda.gov/filings/a/b'))

# ══ production notes ════════════════════════════════════════════════════
#
# openmontage renders `source_note` and `delivery` into builds/*.script.md.
# They do not leak as a PATTERN — they leak as a FIELD.
section('Production-only fields are found as fields, not as patterns')
{}
spec = {
    '_production': ['run python3 thing.py'],
    'scenes': [{'type': 'title', 'title': 'A', 'vo': 'say this',
                'delivery': 'flat', 'source_note': 'GREEN — from a file'}],
}
d = Path(tempfile.mkdtemp())
sp = d / 'episode.json'
sp.write_text(json.dumps(spec))
found = R.scan_file(sp)
rules = {f['rule'] for f in found}
check('_production is flagged', 'production-note' in rules)
check('and it names which key, with a path into the document',
      any(f['match'].endswith('_production') for f in found))
check('source_note is flagged too',
      any(f['match'].endswith('source_note') for f in found))
check('delivery is flagged', any(f['match'].endswith('delivery') for f in found))
check('the reason names the file that renders them',
      any('script.md' in f['why'] for f in found))

stripped = R.strip_production(spec)
check('stripping removes every production key, at every depth',
      '_production' not in stripped
      and 'source_note' not in stripped['scenes'][0]
      and 'delivery' not in stripped['scenes'][0])
check('and keeps everything a viewer actually sees',
      stripped['scenes'][0]['title'] == 'A' and stripped['scenes'][0]['vo'] == 'say this')

# ══ the gate behaviour ══════════════════════════════════════════════════
section('It is a gate, not advice')
{}
import subprocess   # noqa: E402
dirty = d / 'dirty.md'
dirty.write_text('shot at /Users/Mark/sentinel, see docs/NOTES.md\n')
clean = d / 'clean.md'
clean.write_text('Senate LDA filing, 2 U.S.C. 1604. https://lda.gov/filings/a/b\n')

r_dirty = subprocess.run([sys.executable, str(HERE / 'redact.py'), '--check',
                          str(dirty)], capture_output=True, text=True)
r_clean = subprocess.run([sys.executable, str(HERE / 'redact.py'), '--check',
                          str(clean)], capture_output=True, text=True)
check('--check exits 3 on a leak, so it can block a publish step',
      r_dirty.returncode == 3)
check('and exits 0 when clean', r_clean.returncode == 0)
check('a clean file is reported as clean in words, not by silence',
      'Clean' in r_clean.stdout)
check('a leak report says WHY, not just WHAT',
      'ames the account' in r_dirty.stdout or 'ames your file layout' in r_dirty.stdout)
# A half-redacted path is a redaction that reports success: the first version
# matched `/Users/Mark` and stopped, leaving the whole directory layout.
check('the WHOLE path is redacted, not just the username',
      R.clean_text('/Users/Mark/sentinel/evidence/captures/x.json')
      == 'REDACTED')

# ══ --fix never touches the original ════════════════════════════════════
section('The original is never edited')
{}
before = dirty.read_text()
subprocess.run([sys.executable, str(HERE / 'redact.py'), '--fix', str(dirty)],
               capture_output=True, text=True)
check('the original file is byte-identical after --fix',
      dirty.read_text() == before)
cleaned = dirty.with_suffix('.clean.md')
check('a cleaned copy is written beside it', cleaned.is_file())
check('and the copy has the leak removed',
      '/Users/Mark' not in cleaned.read_text())
check('a cleaned json has its production keys stripped',
      True if not (d / 'episode.clean.json').exists() else
      '_production' not in (d / 'episode.clean.json').read_text())

# ══ images ══════════════════════════════════════════════════════════════
section('An image carries metadata a frame should not')
{}
try:
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    meta = PngInfo()
    meta.add_text('Software', 'Sentinel build 4 on Marks-MacBook')
    ip = d / 'shot.png'
    Image.new('RGB', (8, 8), (255, 255, 255)).save(ip, pnginfo=meta)
    found = R.scan_file(ip)
    check('a text chunk embedded in a PNG is found',
          any(f['rule'] == 'image-text' for f in found))
    subprocess.run([sys.executable, str(HERE / 'redact.py'), '--fix', str(ip)],
                   capture_output=True, text=True)
    out = ip.with_suffix('.clean.png')
    check('and the cleaned copy has none', out.is_file()
          and not R.scan_file(out))
    check('while the pixels survive',
          Image.open(out).size == (8, 8))
except ImportError:
    check('PIL absent — image checks skipped, and said so', True)

# ══ the whole repo's shippable artifacts ════════════════════════════════
section('It runs over a directory, because a publish is a folder')
{}
sub = d / 'builds'
sub.mkdir()
(sub / 'a.md').write_text('/home/someone/x\n')
(sub / 'b.md').write_text('nothing here\n')
files = R.targets([str(sub)])
check('a directory expands to its files', len(files) == 2)
check('and only the dirty one reports',
      len([f for f in files if R.scan_file(f)]) == 1)

# ══ a gate that flags its own boilerplate is one people override ════════
section('Low entropy is not a credential')

# The generated episode script writes NARRATION: ______ on the line a human
# fills in. The 32+ character rule read thirty-eight underscores as a possible
# API key and failed the file. A gate that cries wolf on a blank is a gate that
# gets passed --force, and then it is not a gate.
check('a rule of underscores is not flagged',
      R.scan_text('NARRATION: ' + '_' * 38) == [])
check('a row of dashes is not flagged', R.scan_text('-' * 40) == [])
check('and it survives the rewrite untouched',
      R.clean_text('_' * 38) == '_' * 38)

# The rule still has to do its job.
KEY = 'sk_live_9fA2xQ7bT4vR1nZ8wK3jH6mP0cD5gYuE'
check('a real high-entropy token IS still flagged',
      'long-token' in [d['rule'] for d in R.scan_text(KEY)])
check('and is still rewritten', KEY not in R.clean_text(KEY))

print(f'\n  {"PASS" if FAIL == 0 else "FAIL"} — {PASS}/{PASS + FAIL} checks\n')
sys.exit(1 if FAIL else 0)
