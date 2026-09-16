#!/usr/bin/env python3
"""
exhibitcard.py — YOUR SCREENSHOT, IN A FRAME THAT SAYS WHERE IT CAME FROM.

─────────────────────────────────────────────────────────────────────────────
THE DIVISION THAT MAKES THIS SAFE

    THE SCREENSHOT IS THE CONTENT.   Never touched, never generated, never
                                     restyled. It is a photograph of a public
                                     record and that is the whole reason it is
                                     worth anything.

    THE FRAME IS THE DESIGN.         Type, rule, colour, spacing, the source
                                     line, the grade badge, the amount and its
                                     qualifier. None of it is evidence, all of
                                     it can be made beautiful, and making it
                                     beautiful costs the claim nothing.

Design tools belong on the second line and nowhere near the first. A generated
image of a filing retires the position permanently; a well-set frame around a
real one is just craft.

─────────────────────────────────────────────────────────────────────────────
WHAT IT REFUSES

  - A CONTESTED exhibit. If the document disagreed with the register, an
    unresolved contradiction does not get typeset and put on screen.
  - A MISSING screenshot. It reports the gap rather than drawing a placeholder,
    because a placeholder in an evidence deck is a frame that looks like proof
    and is not.
  - An amount without the qualifier its own register uses. The LD-2 says
    "good faith estimate" under line 12 and hands you an accounting method
    under line 13, and those are different numbers.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent / 'connectors'))

from PIL import Image, ImageDraw, ImageFont, ImageOps    # noqa: E402
import brand                                              # noqa: E402
from namematch import clean, matches_side, same_entity    # noqa: E402

GRADE_COLOR = {'ASSERTED': 'green', 'REGISTRY': 'gold',
               'CO-OCCURRENCE': 'muted'}

# The authority line, printed under the picture. This is the product.
AUTHORITY = {
    'senatelda': 'Senate LDA · Lobbying Disclosure Act of 1995, 2 U.S.C. 1604',
    'usaspending': 'USAspending · federal award record',
    'courtlistener': 'CourtListener · United States court docket',
    'opencorporates': 'OpenCorporates · companies registrar',
    'federalregister': 'Federal Register · published by the agency',
    'regulationsgov': 'Regulations.gov · agency docket',
    'fec': 'Federal Election Commission · sworn schedule',
}

INCOME_Q = 'good-faith estimate of what the firm was PAID, rounded'
EXPENSE_Q = 'what the company SPENT on itself · accounting method on line 14'
QUALIFIER = {
    'usaspending': 'obligated — not what was finally paid',
    'fec': 'as reported on that schedule, that period only',
}

# Registers whose forms carry a named person's direct contact details. The
# filing is lawfully public; a staffer's direct line on screen serves nothing.
CONTACT_RISK = {'senatelda', 'fec'}

IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.webp'}

TTY = sys.stdout.isatty()


def _c(code, s):
    return f'\033[{code}m{s}\033[0m' if TTY else s


def grn(s): return _c('32', s)
def dim(s): return _c('2', s)


def f(role, size):
    return ImageFont.truetype(brand.font_path(role), size)


def wrap(d, text, fnt, width):
    words, lines, cur = str(text).split(), [], ''
    for w in words:
        t = f'{cur} {w}'.strip()
        if d.textlength(t, font=fnt) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def money(v):
    try:
        return f'${float(str(v).replace(",", "").replace("$", "")):,.0f}'
    except (TypeError, ValueError):
        return None


def qualifier(row):
    src = (row.get('source') or '').lower()
    if src == 'senatelda':
        return (EXPENSE_Q if same_entity(row.get('entity_a'),
                                         row.get('entity_b')) else INCOME_Q)
    return QUALIFIER.get(src, 'a floor, not a total')


def slug(s, n=34):
    return re.sub(r'[^a-z0-9]+', '_', str(s).lower()).strip('_')[:n] or 'x'


def edge_key(r):
    def w(v):
        return ' '.join(re.sub(r'[^A-Z0-9]+', ' ', str(v or '').upper()).split())
    return '|'.join(w(r.get(x))
                    for x in ('entity_a', 'relationship', 'entity_b'))


def draw_quote(row, text: str, index: int, n: int, of: int,
               preset: str, theme: str) -> Image.Image:
    """THE DOCUMENT'S OWN WORDS, BIG, WITH THE REGISTER UNDERNEATH.

    Episode 01 opened on a purchase order's verbatim language — "STRATEGICALLY
    TARGETED AUDIENCES... NEEDS A CREDIT CARD TO BE ENTERED" — and that is the
    beat that landed. Everything built since draws arrows between company
    names, which is topology. A quotation is evidence, and it is the one thing
    an audience cannot be told is your interpretation.

    No screenshot is needed and none is wanted. The words are the picture."""
    P, C = brand.preset(preset), brand.theme(theme)
    safe = P['safe']
    im = Image.new('RGB', (P['w'], P['h']), C['paper'])
    d = ImageDraw.Draw(im)

    x0, x1 = safe['left'], safe['right']
    inner = x1 - x0
    accent = C[GRADE_COLOR.get(
        str(row.get('assertion_type') or '').upper(), 'muted')]

    f_kick = f('mono', 26)
    f_src = f('mono', 24)
    f_attr = f('sans_b', 28)

    # Long quotations need smaller type or they stop being readable. Step down
    # until the block fits the frame rather than letting it run off the bottom.
    body = None
    for size in (72, 62, 54, 46, 40, 34, 30):
        fnt = f('serif_b', size)
        lines = wrap(d, f'"{text}"', fnt, inner)
        if len(lines) * int(size * 1.24) <= safe['bottom'] - safe['top'] - 420:
            body, f_body, quote_lines = size, fnt, lines
            break
    if body is None:
        f_body = f('serif_b', 30)
        quote_lines = wrap(d, f'"{text}"', f_body, inner)

    attr = str(row.get('entity_a') or '').upper()
    attr_lines = wrap(d, attr, f_attr, inner)
    src = (row.get('source') or '').lower()
    foot = wrap(d, AUTHORITY.get(src, row.get('register') or src), f_src, inner)
    if row.get('document_id'):
        foot += wrap(d, str(row.get('document_id')), f_src, inner)

    qh = len(quote_lines) * int(f_body.size * 1.24)
    ah = len(attr_lines) * 36
    fh = len(foot) * 32
    total_h = 44 + 46 + qh + 40 + ah + 26 + fh
    y = max(safe['top'],
            safe['top'] + (safe['bottom'] - safe['top'] - total_h) // 2)

    kick = 'IN ITS OWN WORDS' + (f'   {n} OF {of}' if of > 1 else '')
    d.text((x0, y), kick, font=f_kick, fill=C['muted'])
    y += 44
    d.line([(x0, y), (x0 + 140, y)], fill=accent, width=5)
    y += 46

    for ln in quote_lines:
        d.text((x0, y), ln, font=f_body, fill=C['ink'])
        y += int(f_body.size * 1.24)
    y += 40

    for ln in attr_lines:
        d.text((x0, y), ln, font=f_attr, fill=accent)
        y += 36
    y += 26
    for ln in foot:
        d.text((x0, y), ln, font=f_src, fill=C['muted'])
        y += 32

    return im


def draw_card(row, shot: Path, index: int, total: int, preset: str,
              theme: str, notes=(), page: int = 1,
              pages: int = 1) -> Image.Image:
    P, C = brand.preset(preset), brand.theme(theme)
    W, H = P['w'], P['h']
    safe = P['safe']
    im = Image.new('RGB', (W, H), C['paper'])
    d = ImageDraw.Draw(im)

    grade = str(row.get('assertion_type') or 'CO-OCCURRENCE').upper()
    accent = C[GRADE_COLOR.get(grade, 'muted')]

    f_kick, f_cap = f('mono', 28), f('serif_b', 46)
    f_rel, f_src = f('sans_b', 30), f('mono', 24)
    f_note = f('sans_b', 26)

    x0, x1 = safe['left'], safe['right']
    inner = x1 - x0

    # ── MEASURE EVERYTHING, THEN PLACE IT ───────────────────────────────────
    #
    # The first draft started at safe['top'] and ran downward. A wide, short
    # screenshot then left the bottom third of a 1920-tall frame empty and the
    # whole composition sitting up in the corner. cards.py already carries this
    # same fix and the same comment; a card is a composition, not a log.
    a, bb = str(row.get('entity_a') or ''), str(row.get('entity_b') or '')
    if same_entity(a, bb):
        cap, rel = a.upper(), 'FILED FOR ITSELF · IN-HOUSE'
    else:
        cap, rel = a.upper(), f'{row.get("label") or row.get("relationship")}  {bb}'
    cap_lines = wrap(d, cap, f_cap, inner)
    rel_lines = wrap(d, rel.upper(), f_rel, inner)

    src = (row.get('source') or '').lower()
    lines = [(AUTHORITY.get(src, row.get('register') or src), C['ink'])]
    amt = money(row.get('amount'))
    if amt:
        lines.append((f'{amt} — {qualifier(row)}', C['ink']))
    if row.get('document_id'):
        lines.append((str(row.get('document_id')), C['muted']))
    if row.get('effective_date'):
        lines.append((str(row.get('effective_date')), C['muted']))

    foot = [(ln, fill) for text, fill in lines
            for ln in wrap(d, text, f_src, inner)]
    note_lines = [(ln, accent) for n in notes
                  for ln in wrap(d, n, f_note, inner)]

    head_h = 46 + 40
    cap_h = (len(cap_lines) * int(f_cap.size * 1.15) + 6
             + len(rel_lines) * int(f_rel.size * 1.25) + 30)
    foot_h = (22 + len(foot) * 34
              + (16 + len(note_lines) * 32 if note_lines else 0))

    avail = safe['bottom'] - safe['top'] - head_h - cap_h - foot_h - 28
    pic = ImageOps.contain(Image.open(shot).convert('RGB'),
                           (inner, max(80, avail)), Image.LANCZOS)

    total_h = head_h + cap_h + pic.height + 24 + foot_h
    y = max(safe['top'],
            safe['top'] + (safe['bottom'] - safe['top'] - total_h) // 2)

    # ── header ──────────────────────────────────────────────────────────────
    kick = f'EXHIBIT {index:02d} / {total:02d}'
    if pages > 1:
        kick += f'   PAGE {page} OF {pages}'
    d.text((x0, y), kick, font=f_kick, fill=C['muted'])
    gw = d.textlength(grade, font=f_kick)
    d.text((x1 - gw, y), grade, font=f_kick, fill=accent)
    y += 46
    d.line([(x0, y), (x1, y)], fill=C['rule'], width=3)
    y += 40

    # ── the caption, above the picture, so the eye reads it first ───────────
    for ln in cap_lines:
        d.text((x0, y), ln, font=f_cap, fill=C['ink'])
        y += int(f_cap.size * 1.15)
    y += 6
    for ln in rel_lines:
        d.text((x0, y), ln, font=f_rel, fill=accent)
        y += int(f_rel.size * 1.25)
    y += 30

    # ── the picture: the only part that is evidence ─────────────────────────
    px = x0 + (inner - pic.width) // 2
    im.paste(pic, (px, y))
    d.rectangle([px - 1, y - 1, px + pic.width, y + pic.height],
                outline=C['rule'], width=2)
    y += pic.height + 24

    # ── the source line: the product ────────────────────────────────────────
    d.line([(x0, y), (x1, y)], fill=accent, width=4)
    y += 22
    for ln, fill in foot:
        d.text((x0, y), ln, font=f_src, fill=fill)
        y += 34
    if note_lines:
        y += 16
        for ln, fill in note_lines:
            d.text((x0, y), ln, font=f_note, fill=fill)
            y += 32

    return im


def load(path: Path, entity=None, side=None, grade=None):
    rows = list(csv.DictReader(path.open(newline='', encoding='utf-8-sig')))
    for r in rows:
        for k in list(r):
            r[k] = clean(r[k])
    if grade:
        rows = [r for r in rows
                if (r.get('assertion_type') or '').upper() == grade.upper()]
    if entity:
        rows = [r for r in rows if matches_side(r, entity, side)]
    seen, out = set(), []
    for r in rows:
        k = edge_key(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def state(edges: Path) -> dict:
    p = edges.with_suffix('.exhibits.json')
    if not p.is_file():
        return {'done': [], 'notes': {}, 'flags': {}, 'quotes': {}}
    try:
        raw = json.loads(p.read_text())
    except json.JSONDecodeError:
        return {'done': [], 'notes': {}, 'flags': {}, 'quotes': {}}
    return {'done': raw.get('done') or [], 'notes': raw.get('notes') or {},
            'flags': raw.get('flags') or {}, 'quotes': raw.get('quotes') or {}}


def main() -> int:
    ap = argparse.ArgumentParser(
        prog='sentinel frame',
        description='Your screenshot, in a frame that says where it came from.')
    ap.add_argument('--edges', default='edges.csv')
    ap.add_argument('--shots', default='assets',
                    help='where the screenshots were saved')
    ap.add_argument('--out', default='assets/framed')
    ap.add_argument('--entity')
    ap.add_argument('--side', choices=['left', 'right', 'any'], default='any')
    ap.add_argument('--grade')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--preset', default='vertical')
    ap.add_argument('--theme', default='bright')
    a = ap.parse_args()

    ep = Path(a.edges).expanduser()
    if not ep.is_file():
        print(f'\n  no edges csv at {ep}\n', file=sys.stderr)
        return 2
    if not brand.fonts_ok():
        print('\n  ' + brand.summary(), file=sys.stderr)
        return 2
    if a.side != 'any' and not a.entity:
        print('\n  --side only means something with --entity.\n', file=sys.stderr)
        return 2

    rows = load(ep, a.entity, a.side, a.grade)[:a.limit]
    if not rows:
        print('\n  No edges matched. Nothing framed.\n')
        return 2

    st = state(ep)
    shots = Path(a.shots).expanduser()
    out = Path(a.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    made, missing, held, quoted = 0, [], [], 0
    print(f'\n  FRAMED EXHIBITS  {a.theme} · {a.preset}\n')
    for i, r in enumerate(rows, 1):
        k = edge_key(r)
        if st['flags'].get(k):
            held.append((i, r, st['flags'][k]))
            continue
        # ONE FILING IS OFTEN SEVERAL PAGES, AND THE LATER ONES ARE BETTER.
        #
        # This took the FIRST match and dropped the rest. An LD-2 cover page
        # carries the money; pages 2-n carry the LOBBYING ACTIVITY box, which
        # is the only place the filing says what the lobbying was ABOUT — the
        # issue codes, the bill numbers, the named lobbyists. Silently framing
        # page 1 and discarding four pages of substance is the wrong way round.
        pages = sorted(shots.glob(f'exhibit_{i:02d}_*'))
        pages = [q for q in pages if q.suffix.lower() in IMAGE_EXT]
        if not pages:
            missing.append((i, r, f'exhibit_{i:02d}_*'))

        quotes = st['quotes'].get(k, [])
        for qn, qtext in enumerate(quotes, 1):
            im = draw_quote(r, qtext, i, qn, len(quotes), a.preset, a.theme)
            name = f'quote_{i:02d}_{qn:02d}_{slug(r.get("entity_a"))}.png'
            im.save(out / name)
            quoted += 1
            print(grn(f'    {name}'))

        for n, shot in enumerate(pages, 1):
            im = draw_card(r, shot, i, len(rows), a.preset, a.theme,
                           st['notes'].get(k, []),
                           page=n, pages=len(pages))
            suffix = f'_p{n:02d}' if len(pages) > 1 else ''
            name = f'framed_{i:02d}{suffix}_{slug(r.get("entity_a"))}.png'
            im.save(out / name)
            made += 1
            flag = '  *' if st['notes'].get(k) else ''
            print(f'    {name}{flag}')

    print(f'\n  {made} framed · {quoted} quote card(s) · '
          f'{len(missing)} missing · {len(held)} contested')
    if quoted:
        print(grn('  A QUOTE CARD NEEDS NO SCREENSHOT. The words are the '
                  'picture, and they'))
        print(grn('  are the one thing nobody can call your interpretation.'))

    if held:
        print('\n  CONTESTED — not framed, not on screen:')
        for i, r, why in held:
            print(f'    {i:02d}  {str(r.get("entity_a"))[:34]}')
            for t in why:
                print(f'          {t}')

    if missing:
        print('\n  NO SCREENSHOT YET — nothing drawn for these. A placeholder')
        print('  in an evidence deck is a frame that looks like proof.')
        for i, r, name in missing:
            print(f'    {i:02d}  {str(r.get("entity_a"))[:34]}  needs {name}')

    risky = {(r.get('source') or '').lower() for r in rows} & CONTACT_RISK
    if made and risky:
        print('\n  BEFORE ANY OF THESE GO ON SCREEN: an LD-2 carries a named')
        print('  person\'s direct phone and email in box 4. The filing is')
        print('  lawfully public; a staffer\'s direct line on a frame is not')
        print('  evidence of anything. Crop box 4 out of the screenshot.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
