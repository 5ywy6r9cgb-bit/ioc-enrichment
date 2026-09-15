#!/usr/bin/env python3
"""
redact.py — NOTHING ABOUT THE MACHINE LEAVES THE MACHINE.

─────────────────────────────────────────────────────────────────────────────
THE RULE THIS ENFORCES

A published artifact — a card, a page, a script, a video manifest — describes
the WORLD. It must never describe the DESK. The moment a frame carries
`/Users/Mark/sentinel/evidence/captures/live_capture_senatelda_...json`, the
audience learns your username, your directory layout, what you searched, and
when. None of that is journalism and all of it is permanent once posted.

This is a GATE, not advice. `--check` exits 3 when anything leaks, so it can
sit in front of a publish step and stop it.

─────────────────────────────────────────────────────────────────────────────
WHAT ACTUALLY LEAKS, FOUND BY READING THE WRITERS

  builds/*.script.md    openmontage renders `source_note` and `delivery` into
                        the shooting script. Those are PRODUCTION notes —
                        "GREEN — verbatim from docs/GLASSMARK.md" names an
                        internal file — and the script is the single most
                        likely artifact to be sent to a collaborator.
  builds/*.manifest.json  carries the spec path and every asset path, absolute.
  episode.json          `_production` blocks hold internal commands, and
                        `source_note` holds method.
  box.html / sheet.md   written with whatever path the operator passed.
  *.png                 PIL writes no EXIF by default, but an image that came
                        from a phone or a screenshot carries device, software
                        and sometimes GPS.

─────────────────────────────────────────────────────────────────────────────
WHAT IT DELIBERATELY DOES NOT DO

It does not decide that a public URL is a secret. `lda.gov/filings/...` and
`federalregister.gov/documents/...` are the POINT of the work — a redactor
that strips the citation has destroyed the artifact to protect nothing. Only
LOCAL and CREDENTIAL patterns are touched.

And it never edits in place without saying so. `--check` reports, `--fix`
writes a cleaned copy beside the original, and the original is left alone.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# ── what counts as a leak ────────────────────────────────────────────────
#
# Each rule: (name, pattern, why it matters, replacement).
# Ordered most-serious first, because that is the order a person reads.
RULES = [
    ('credential',
     re.compile(r'(?i)\b(api[_-]?key|apikey|access[_-]?token|secret|password|'
                r'authorization|bearer)\b\s*[=:]\s*\S+'),
     'A key or token. Rotate it if this ever left the machine.',
     'REDACTED'),

    ('long-token',
     re.compile(r'\b[A-Za-z0-9_\-]{32,}\b'),
     'A 32+ character token. Often an API key. Sometimes a sha256, which is '
     'fine to publish — read it before you strip it.',
     'REDACTED'),

    ('home-path',
     # THE WHOLE PATH, not just the username. The first version matched
     # `/Users/Mark` and stopped at the next slash, so redacting
     # "/Users/Mark/sentinel/evidence" left "REDACTED/sentinel/evidence" —
     # the account name gone and the entire directory layout still on the
     # page. A half-redacted path is a redaction that reports success.
     re.compile(r'(?:/Users/|/home/|[A-Z]:\\\\Users\\\\)'
                r'[^\s"\'`,;)\]]*'),
     'An absolute home directory. Names the account and the layout.',
     'REDACTED'),

    ('evidence-path',
     re.compile(r'(?:\.\./)*(?:evidence|captures|manifests)/[^\s"\',)]+'),
     'A path inside the evidence store. Reveals the library layout.',
     'REDACTED'),

    # THE GAP THE FIRST RUN FOUND.
    #
    # `builds/ep00.script.md` came back CLEAN while carrying eight references
    # to `docs/GLASSMARK.md`. None of the rules above matched, because the
    # patterns looked for /Users and evidence/ and this is neither — it is the
    # repository's own file layout, rendered into the one artifact most likely
    # to be sent to a collaborator. A backend filename is backend information
    # whether or not it is absolute.
    ('repo-path',
     re.compile(r'\b(?:docs|modules|scripts|bin|core|config)/'
                r'[A-Za-z0-9_\-]+(?:/[A-Za-z0-9_\-]+)*'
                r'(?:\.[A-Za-z0-9]{1,5})?'),
     'A path inside the repository. Names your file layout and your tooling.',
     'REDACTED'),

    ('capture-file',
     re.compile(r'live_capture_[A-Za-z0-9_\-]+\.json'),
     'A capture filename. Says WHAT you searched and WHEN.',
     'REDACTED'),

    ('env-file',
     re.compile(r'(?:^|[\s"\'/])\.env(?:\.[A-Za-z0-9]+)?\b'),
     'A reference to an environment file.',
     ' REDACTED'),

    ('email',
     re.compile(r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b'),
     'An email address. Yours, a source\'s, or a colleague\'s.',
     'REDACTED'),

    ('private-host',
     re.compile(r'\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|'
                r'10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)\b(?::\d+)?'),
     'A local or private address.',
     'REDACTED'),
]

# PUBLIC REGISTERS ARE THE POINT OF THE WORK.
#
# A redactor that strips the citation has destroyed the artifact to protect
# nothing. Any match sitting inside one of these URLs is left alone.
PUBLIC = re.compile(
    r'https?://(?:www\.)?(?:'
    r'lda\.gov|federalregister\.gov|regulations\.gov|courtlistener\.com|'
    r'usaspending\.gov|fec\.gov|opencorporates\.com|sec\.gov|congress\.gov|'
    r'justice\.gov|govinfo\.gov|cftc\.gov|opensanctions\.org|bls\.gov'
    r')/\S*')

# Fields in a spec that are PRODUCTION notes and must never reach a viewer.
PRODUCTION_KEYS = {'source_note', 'delivery', '_production', 'answer_cue'}

TEXT_SUFFIXES = {'.md', '.json', '.html', '.txt', '.srt', '.csv', '.vtt'}


def public_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in PUBLIC.finditer(text)]


def inside(spans, a: int, b: int) -> bool:
    return any(s <= a and b <= e for s, e in spans)


def scan_text(text: str) -> list[dict]:
    """Every leak in a string, with the rule that caught it."""
    spans = public_spans(text)
    out = []
    for name, pat, why, _rep in RULES:
        for m in pat.finditer(text):
            if inside(spans, m.start(), m.end()):
                continue
            line = text.count('\n', 0, m.start()) + 1
            out.append({'rule': name, 'why': why, 'line': line,
                        'match': m.group(0)[:90]})
    return out


def clean_text(text: str) -> str:
    spans = public_spans(text)

    def repl_for(pat, rep):
        def f(m):
            return m.group(0) if inside(spans, m.start(), m.end()) else rep
        return f

    for _name, pat, _why, rep in RULES:
        text = pat.sub(repl_for(pat, rep), text)
        spans = public_spans(text)
    return text


def strip_production(obj):
    """Drop production-only keys from a spec, recursively."""
    if isinstance(obj, dict):
        return {k: strip_production(v) for k, v in obj.items()
                if k not in PRODUCTION_KEYS}
    if isinstance(obj, list):
        return [strip_production(v) for v in obj]
    return obj


def png_metadata(p: Path) -> list[dict]:
    """EXIF and text chunks on an image. A screenshot or phone photo carries
    device, software and sometimes GPS, and none of it belongs in a frame."""
    try:
        from PIL import Image
    except ImportError:
        return []
    out = []
    try:
        with Image.open(p) as im:
            info = {k: v for k, v in (im.info or {}).items()
                    if k not in ('dpi', 'transparency', 'gamma', 'srgb',
                                 'icc_profile', 'aspect')}
            exif = getattr(im, 'getexif', lambda: {})()
            if exif:
                gps = 34853 in exif
                out.append({'rule': 'image-exif', 'line': 0,
                            'why': 'EXIF on an image' + (
                                ' INCLUDING GPS COORDINATES' if gps else ''),
                            'match': f'{len(exif)} exif tag(s)'
                                     + (' + GPS' if gps else '')})
            for k, v in info.items():
                out.append({'rule': 'image-text', 'line': 0,
                            'why': f'A text chunk named {k!r} embedded in the image.',
                            'match': str(v)[:90]})
    except Exception:
        pass
    return out


def scan_file(p: Path) -> list[dict]:
    if p.suffix.lower() in {'.png', '.jpg', '.jpeg', '.tif', '.tiff'}:
        return png_metadata(p)
    if p.suffix.lower() not in TEXT_SUFFIXES:
        return []
    try:
        text = p.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return []
    found = scan_text(text)
    # A spec that still carries production keys is a separate finding: those
    # do not "leak" as a pattern, they leak as a FIELD that gets rendered.
    if p.suffix.lower() == '.json':
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = None
        if data is not None:
            def walk(o, path='$'):
                if isinstance(o, dict):
                    for k, v in o.items():
                        if k in PRODUCTION_KEYS:
                            found.append({
                                'rule': 'production-note', 'line': 0,
                                'why': f'{k!r} is a PRODUCTION note. openmontage '
                                       f'renders source_note and delivery into '
                                       f'builds/*.script.md.',
                                'match': f'{path}.{k}'})
                        walk(v, f'{path}.{k}')
                elif isinstance(o, list):
                    for i, v in enumerate(o):
                        walk(v, f'{path}[{i}]')
            walk(data)
    return found


def targets(paths: list[str]) -> list[Path]:
    out = []
    for raw in paths:
        p = Path(raw).expanduser()
        if p.is_dir():
            out += [q for q in sorted(p.rglob('*')) if q.is_file()]
        elif p.is_file():
            out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        prog='sentinel redact',
        description='Nothing about the machine leaves the machine. '
                    'A gate, not advice.')
    ap.add_argument('paths', nargs='+', help='files or directories to check')
    ap.add_argument('--check', action='store_true',
                    help='report only; exit 3 if anything leaks')
    ap.add_argument('--fix', action='store_true',
                    help='write a cleaned copy beside each file (.clean.EXT). '
                         'The original is never touched.')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()

    files = targets(a.paths)
    if not files:
        print('\n  nothing to check at those paths\n', file=sys.stderr)
        return 2

    total = 0
    dirty = []
    for p in files:
        found = scan_file(p)
        if not found:
            continue
        dirty.append(p)
        total += len(found)
        if a.quiet:
            continue
        print(f'\n  {p}')
        by_rule = {}
        for f in found:
            by_rule.setdefault(f['rule'], []).append(f)
        for rule, items in by_rule.items():
            print(f'    {rule}  ({len(items)})')
            print(f'      {items[0]["why"]}')
            for it in items[:3]:
                loc = f'line {it["line"]}' if it['line'] else 'metadata'
                print(f'      {loc}:  {it["match"]}')
            if len(items) > 3:
                print(f'      …and {len(items) - 3} more')

    print(f'\n  {len(files)} file(s) checked · {len(dirty)} carrying '
          f'{total} leak(s)')

    if a.fix and dirty:
        print('')
        for p in dirty:
            if p.suffix.lower() == '.json':
                try:
                    data = json.loads(p.read_text(encoding='utf-8'))
                    body = json.dumps(strip_production(data), indent=2)
                except json.JSONDecodeError:
                    body = p.read_text(encoding='utf-8', errors='replace')
                out = p.with_suffix('.clean.json')
                out.write_text(clean_text(body) + '\n', encoding='utf-8')
            elif p.suffix.lower() in TEXT_SUFFIXES:
                out = p.with_suffix(f'.clean{p.suffix}')
                out.write_text(
                    clean_text(p.read_text(encoding='utf-8', errors='replace')),
                    encoding='utf-8')
            else:
                # An image is re-saved WITHOUT metadata rather than patched.
                try:
                    from PIL import Image
                    with Image.open(p) as im:
                        clean = Image.new(im.mode, im.size)
                        clean.putdata(list(im.getdata()))
                        out = p.with_suffix(f'.clean{p.suffix}')
                        clean.save(out)
                except Exception as e:
                    print(f'    could not clean {p}: {e}')
                    continue
            print(f'    wrote  {out}')
        print('\n  THE ORIGINALS ARE UNTOUCHED. Publish the .clean copies, or '
              'diff them\n  first — a redactor you have not read is a redactor '
              'you are trusting blind.')

    if not total:
        print('  Clean. Nothing here describes the machine.\n')
        return 0

    print('\n  A PUBLISHED ARTIFACT DESCRIBES THE WORLD, NOT THE DESK.')
    print('  Public register URLs are left alone on purpose — lda.gov,')
    print('  federalregister.gov, courtlistener.com and the rest ARE the work.')
    print('  Only local paths and credentials are touched.\n')
    return 3 if a.check else 0


if __name__ == '__main__':
    sys.exit(main())
