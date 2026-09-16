#!/usr/bin/env python3
"""
cards.py — EVIDENCE CARDS, DRAWN FROM SOURCED EDGES.

─────────────────────────────────────────────────────────────────────────────
WHAT THIS IS FOR

A viewer who only hears a voice has to trust the voice. A viewer who sees the
relationship drawn, with the register named under it, can check it. That is
the whole difference between a video that asserts and a video that shows, and
it is what turns a ninety-second explainer into something a hostile reader
cannot dismiss.

So: two or three cards per script beat, twenty per ninety seconds, each one a
small diagram of ONE documented relationship with its source printed on the
card.

─────────────────────────────────────────────────────────────────────────────
THE THING THAT MAKES THESE DIFFERENT FROM A GRAPHICS TEMPLATE

THE ARROWS COME FROM THE EDGE TABLE, NOT FROM THE SCRIPT.

A card generator fed by prose draws whatever the writer typed, and the arrow
label is an assertion nobody checked. This one is fed by
`sentinel connect edges --out edges.csv`, so every arrow is a relationship
this desk can evidence, the label is the relationship's real name, and the
line under it is the register that carries it:

    THE BLACKSTONE GROUP INC.
            |  retained this firm to lobby
            v
    MINDSET ADVOCACY, LLC
    Senate LDA quarterly filing (LD-2), 2 U.S.C. 1604 · $40,000.00

You cannot draw an arrow this tool has no register for. That is a feature.

─────────────────────────────────────────────────────────────────────────────
AND THE GRADE IS DRAWN, NOT WRITTEN IN A FOOTNOTE

Solid line, ASSERTED — somebody swore to it.
Dashed line, REGISTRY — the entity exists as filed.
Dotted line, CO-OCCURRENCE — two names in one document, and the card SAYS SO
on its face, because a diagram is the easiest place in the world to launder a
co-occurrence into a relationship.

Free, local, repeatable. PIL and the fonts already on the machine. No model,
no API, no per-render charge, no queue — run it a thousand times.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent / 'connectors'))

from PIL import Image, ImageDraw, ImageFont     # noqa: E402
import brand                                     # noqa: E402
from namematch import clean, matches_side, side_of   # noqa: E402

# Line style per assertion type. The grade is VISIBLE, not annotated.
STYLE = {
    'ASSERTED':      {'dash': None,     'width': 5, 'color': 'green'},
    'REGISTRY':      {'dash': (16, 9),  'width': 4, 'color': 'gold'},
    'CO-OCCURRENCE': {'dash': (4, 10),  'width': 3, 'color': 'muted'},
}

# What the card says about itself when the edge is the weakest kind. Printed
# ON the card, not in a description nobody reads.
CAVEAT = {
    'ASSERTED': '',
    'REGISTRY': 'A registration says the entity exists. It says nothing about conduct.',
    'CO-OCCURRENCE': 'TWO NAMES IN ONE DOCUMENT. This is not a relationship.',
}


def _f(role: str, size: int):
    return ImageFont.truetype(brand.font_path(role), size)


def _wrap(draw, text: str, fnt, width: int) -> list[str]:
    words, lines, cur = str(text).split(), [], ''
    for w in words:
        t = f'{cur} {w}'.strip()
        if draw.textlength(t, font=fnt) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _dashed(draw, xy, dash, width, fill):
    """PIL has no dash support. Walk the segment and draw the on-parts."""
    (x1, y1), (x2, y2) = xy
    if not dash:
        draw.line([(x1, y1), (x2, y2)], fill=fill, width=width)
        return
    on, off = dash
    dx, dy = x2 - x1, y2 - y1
    length = max(1.0, (dx * dx + dy * dy) ** 0.5)
    ux, uy = dx / length, dy / length
    pos = 0.0
    while pos < length:
        seg = min(on, length - pos)
        draw.line([(x1 + ux * pos, y1 + uy * pos),
                   (x1 + ux * (pos + seg), y1 + uy * (pos + seg))],
                  fill=fill, width=width)
        pos += on + off


def card(edge: dict, index: int, preset='vertical', theme='sentinel_light',
         total: int | None = None) -> Image.Image:
    """One relationship, one card."""
    P = brand.preset(preset)
    C = brand.theme(theme)
    W, H = P['w'], P['h']
    safe = P['safe']
    im = Image.new('RGB', (W, H), C['paper'])
    d = ImageDraw.Draw(im)

    grade = str(edge.get('assertion_type') or 'CO-OCCURRENCE').upper()
    st = STYLE.get(grade, STYLE['CO-OCCURRENCE'])
    accent = C[st['color']]

    # Roles that brand.py actually resolves. The first draft asked for
    # 'display' and 'body', which are not roles here — `brand.font_path`
    # refused by name rather than silently substituting, which is the only
    # useful way for a font lookup to fail.
    f_kick = _f('mono', 30)
    f_name = _f('serif_b', 62)
    f_rel = _f('sans_b', 38)
    f_src = _f('mono', 26)
    f_note = _f('sans_b', 30)

    x0, x1 = safe['left'], safe['right']
    inner = x1 - x0
    cx = (x0 + x1) // 2

    # CENTRE THE BLOCK IN THE SAFE AREA.
    #
    # The first draft started at safe['top'] and let the card run downward,
    # so a 1920-tall vertical frame put everything in the top third and left
    # two-thirds of the card empty. A card is a composition, not a log.
    # Measure the content first, then start where it will end up centred.
    def _h(text, fnt):
        return len(_wrap(d, text, fnt, inner)) * int(fnt.size * 1.22)

    est = (52 + 64
           + _h(str(edge.get('entity_a', '')).upper(), f_name) + 34
           + 150 + 34
           + _h(str(edge.get('entity_b', '')).upper(), f_name) + 56
           + 26 + 34 * 3
           + (90 if CAVEAT.get(grade) else 0))
    y = max(safe['top'], (safe['top'] + safe['bottom'] - est) // 2)

    # ---- the card number, so a shot list can be checked against the build --
    kick = f'EVIDENCE {index:02d}' + (f' / {total:02d}' if total else '')
    d.text((x0, y), kick, font=f_kick, fill=C['muted'])
    gw = d.textlength(grade, font=f_kick)
    d.text((x1 - gw, y), grade, font=f_kick, fill=accent)
    y += 52
    d.line([(x0, y), (x1, y)], fill=C['rule'], width=3)
    y += 64

    def block(text: str, fnt, fill):
        nonlocal y
        for ln in _wrap(d, text, fnt, inner):
            w = d.textlength(ln, font=fnt)
            d.text((cx - w / 2, y), ln, font=fnt, fill=fill)
            y += int(fnt.size * 1.22)

    block(str(edge.get('entity_a', '')).upper(), f_name, C['ink'])
    y += 34

    # ---- the arrow, in the grade's own line style -------------------------
    top = y
    bottom = y + 150
    _dashed(d, ((cx, top), (cx, bottom - 26)), st['dash'], st['width'], accent)
    d.polygon([(cx - 17, bottom - 30), (cx + 17, bottom - 30), (cx, bottom)],
              fill=accent)
    # THE LABEL HAS TO FIT ON THE CARD.
    #
    # The first draft parked the box beside the arrow and flipped it left when
    # it overran the right margin — which pushed "appears in the text or index
    # of" clean off the left edge of a 1080-wide frame. A label that does not
    # fit beside the arrow goes CENTRED, on its own line, where the only limit
    # is the full safe width.
    label = str(edge.get('label') or edge.get('relationship') or '')
    pad = 16
    lw = d.textlength(label, font=f_rel)
    box_h = f_rel.size + pad
    beside = (cx + 30 + lw + pad * 2) <= x1
    if beside:
        bx0 = cx + 30
        by = top + 44
    else:
        # Shrink until it fits the full width, then centre it on the arrow.
        while lw + pad * 2 > inner and f_rel.size > 22:
            f_rel = _f('sans_b', f_rel.size - 2)
            lw = d.textlength(label, font=f_rel)
            box_h = f_rel.size + pad
        bx0 = cx - (lw + pad * 2) / 2
        by = top + 52
    d.rectangle([bx0, by, bx0 + lw + pad * 2, by + box_h],
                fill=C['paperwhite'], outline=C['rule'], width=2)
    d.text((bx0 + pad, by + pad // 2), label, font=f_rel, fill=accent)
    y = bottom + 34

    block(str(edge.get('entity_b', '')).upper(), f_name, C['ink'])
    y += 56

    # ---- THE SOURCE LINE. The reason the card exists. ---------------------
    d.line([(x0, y), (x1, y)], fill=C['rule'], width=2)
    y += 26
    src = str(edge.get('register') or edge.get('source') or '')
    extra = ' · '.join([p for p in [edge.get('amount'), edge.get('effective_date')] if p])
    for ln in _wrap(d, f'SOURCE: {src}' + (f'  {extra}' if extra else ''), f_src, inner):
        d.text((x0, y), ln, font=f_src, fill=C['ink'])
        y += 34

    if edge.get('document_id'):
        d.text((x0, y), f"DOC: {edge['document_id']}", font=f_src, fill=C['muted'])
        y += 34
    if edge.get('source_url'):
        for ln in _wrap(d, str(edge['source_url']), f_src, inner):
            d.text((x0, y), ln, font=f_src, fill=C['muted'])
            y += 32

    # ---- the caveat, ON the card ------------------------------------------
    note = CAVEAT.get(grade, '')
    if note:
        y += 20
        d.rectangle([x0, y, x1, y + 8], fill=accent)
        y += 26
        for ln in _wrap(d, note, f_note, inner):
            d.text((x0, y), ln, font=f_note, fill=accent)
            y += 38

    return im


def read_edges(p: Path, limit: int, grade: str | None, entity: str | None,
               side: str | None = None) -> list[dict]:
    rows = list(csv.DictReader(p.open(newline='', encoding='utf-8-sig')))
    for r in rows:
        for k in ('entity_a', 'entity_b', 'label', 'relationship', 'register',
                  'source', 'amount', 'source_url', 'document_id'):
            if k in r:
                r[k] = clean(r[k])
    if grade:
        rows = [r for r in rows if (r.get('assertion_type') or '').upper() == grade.upper()]
    if entity:
        # WHOLE-WORD, PER FIELD, AND THE SIDE IS RECORDED.
        #
        # This was `entity in (entity_a + entity_b).lower()` — two names joined
        # with no separator, so a match could straddle the seam and exist in
        # neither field, and BLACK matched BLACKSTONE. It also could not tell
        # the firm's clients from the firm's own hires, which are opposite
        # sentences, and drew them into one deck.
        rows = [r for r in rows if matches_side(r, entity, side)]
        for r in rows:
            r['_side'] = side_of(r, entity)
    # Strongest first — a deck that opens on a co-occurrence teaches the
    # audience that this is what your evidence looks like.
    order = {'ASSERTED': 0, 'REGISTRY': 1, 'CO-OCCURRENCE': 2}
    rows.sort(key=lambda r: order.get((r.get('assertion_type') or '').upper(), 3))
    return rows[:limit]


def main() -> int:
    ap = argparse.ArgumentParser(
        prog='sentinel cards',
        description='Evidence cards drawn from sourced edges. Free, local, repeatable.')
    ap.add_argument('--edges', required=True,
                    help='CSV from: bin/sentinel connect edges --out edges.csv')
    ap.add_argument('--out', default='assets', help='directory to write PNGs into')
    ap.add_argument('--limit', type=int, default=20,
                    help='how many cards (default 20 — about 90 seconds)')
    ap.add_argument('--grade', help='ASSERTED | REGISTRY | CO-OCCURRENCE')
    ap.add_argument('--entity', help='only edges touching this name')
    ap.add_argument('--side', choices=['left', 'right', 'any'], default='any',
                    help='with --entity: left = the name is the SUBJECT of the '
                         'card, right = it is the COUNTERPARTY. Opposite '
                         'sentences. Default any, and the deck reports the mix.')
    ap.add_argument('--preset', default='vertical')
    ap.add_argument('--theme', default='sentinel_light')
    ap.add_argument('--seconds', type=float, default=90.0,
                    help='total runtime the cards must fill (default 90)')
    ap.add_argument('--scenes', help='also write episode.json scene snippets here')
    a = ap.parse_args()

    ep = Path(a.edges).expanduser()
    if not ep.is_file():
        print(f'\n  no edges csv at {ep}', file=sys.stderr)
        print('  make one:  bin/sentinel connect edges --out edges.csv\n', file=sys.stderr)
        return 2
    if not brand.fonts_ok():
        print('\n  ' + brand.summary(), file=sys.stderr)
        return 2

    if a.side != 'any' and not a.entity:
        print('\n  --side only means something with --entity.\n', file=sys.stderr)
        return 2

    rows = read_edges(ep, a.limit, a.grade, a.entity, a.side)
    if not rows:
        print('\n  No edges matched. Nothing drawn — an empty deck is not a deck.\n')
        return 2

    out = Path(a.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    per = round(a.seconds / len(rows), 2)

    scenes = []
    print(f'\n  EVIDENCE CARDS  {len(rows)} card(s) · {per}s each · {a.seconds}s total')
    print(f'  {out}\n')
    by_grade = {}
    for i, r in enumerate(rows, 1):
        im = card(r, i, a.preset, a.theme, total=len(rows))
        name = f'evidence_{i:02d}.png'
        im.save(out / name)
        g = (r.get('assertion_type') or '?').upper()
        by_grade[g] = by_grade.get(g, 0) + 1
        print(f'    {name}  {g:<14} {str(r.get("entity_a",""))[:24]:<24} '
              f'-> {str(r.get("entity_b",""))[:24]}')
        scenes.append({
            'type': 'chart',
            'dur': per,
            'image': f'{out.name}/{name}',
            'caption': f"{r.get('entity_a','')} {r.get('label') or r.get('relationship','')} "
                       f"{r.get('entity_b','')}",
            'source': f"Source: {r.get('register') or r.get('source','')}",
            'source_note': f"{g} — card {i} of {len(rows)}. Drawn from the edge table, "
                           f"not written by hand.",
        })

    if a.entity:
        left = sum(1 for r in rows if 'L' in (r.get('_side') or '').upper())
        right = sum(1 for r in rows if 'R' in (r.get('_side') or '').upper())
        print(f'\n  direction: {left} card(s) have "{a.entity}" as the SUBJECT · '
              f'{right} as the COUNTERPARTY')
        if left and right and a.side == 'any':
            print('  THOSE ARE OPPOSITE SENTENCES. A deck that mixes them is '
                  'arguing two\n  things at once and proving neither. '
                  '--side left or --side right.')
        buried = sum(1 for r in rows
                     if (r.get('_side') or '') != (r.get('_side') or '').upper())
        if buried:
            print(f'  {buried} card(s) carry the name but NOT at the front of it — '
                  'the register did\n  not file those under your subject. Check '
                  'them for namesakes before drawing.')

    print('\n  by grade:  ' + ' · '.join(f'{v} {k.lower()}' for k, v in by_grade.items()))
    if by_grade.get('CO-OCCURRENCE'):
        print('  ' + ('A CO-OCCURRENCE CARD SAYS SO ON ITS FACE. It is in the deck so '
                      'you can see it,\n  not so you can use it as a connection.'))

    if a.scenes:
        Path(a.scenes).expanduser().write_text(json.dumps(scenes, indent=2))
        print(f'\n  scenes written  {a.scenes}')
        print('  Paste them into episode.json "scenes", then:')
        print('    python3 openmontage.py --spec episode.json --check-safe')
    else:
        print('\n  --scenes cards.json  writes the episode.json snippets too')
    print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
