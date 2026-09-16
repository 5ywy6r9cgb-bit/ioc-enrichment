#!/usr/bin/env python3
"""
namematch.py — THE PYTHON TWIN OF namematch.js.

─────────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS

The name discipline was enforced in JavaScript and nowhere else. Every tool
downstream of the edge table — the screenshot queue, the card deck — filtered
names with its own weaker test, written separately, each wrong in its own way:

    cards.py     e in (entity_a + entity_b).lower()
    exhibits.py  e in (entity_a + ' ' + entity_b).lower()

The first one concatenates two names with NO separator, so "GUMP LLP1-800" is
a string that exists in the joined text and in neither field. Both are plain
substring tests, so BLACK matches BLACKSTONE, AWS matches DAWSON, and Cologix
matches ECOLOGIX. And neither knows which SIDE of the edge matched, which is
the difference between a firm's client book and the firm's own hires.

A rule that is enforced in one language and abandoned at the language boundary
is not a rule. This is the same rule, in Python, with the same vocabulary, so
a name filtered here and a name matched in a connector mean the same thing.

─────────────────────────────────────────────────────────────────────────────
THE FOUR VERDICTS, unchanged from the JS:

    NAME       the name BEGINS with the query. Filed under it.
    CONTAINS   the query is a whole word elsewhere in the name. Hotel
               Blackstone is a 1980 hotel; the register did not file it
               under your subject.
    SUBSTRING  the query hides inside a longer word. DAWSON for AWS.
    OTHER      the query is not in the name at all. The register matched on
               something else — document text, a docket caption. Not noise,
               not a name match: a row you must open to know anything.
    UNKNOWN    nothing to judge.
"""
from __future__ import annotations

import re

NAME = 'NAME'
CONTAINS = 'CONTAINS'
SUBSTRING = 'SUBSTRING'
OTHER = 'OTHER'
UNKNOWN = 'UNKNOWN'

# Corporate-form words carry no identifying information. "Intel Corporation"
# and "INTEL CORP" are one company; the difference is a filing clerk's habit.
SUFFIX = re.compile(
    r'\b(corporation|corp|company|co|incorporated|inc|llc|l\.l\.c|lp|llp|plc|'
    r'ltd|limited|pllc|pc|pa|sa|nv|gmbh|holdings|group)\b')

ARTICLE = re.compile(r'^(the|a|an) ')

# Characters that are not evidence: a byte-order mark carried in from a
# register export, zero-width joiners, stray control codes. They render as a
# box or a question mark and make a clean name look like a corrupt one.
JUNK = re.compile('[' + '\\u0000-\\u0008\\u000b-\\u001f\\u007f'
                  + '\\u200b-\\u200f\\u2028\\u2029\\ufeff' + ']')


def clean(s) -> str:
    """Strip unrenderable characters. Does NOT touch U+FFFD — a replacement
    character means bytes were already lost upstream, and hiding that would be
    hiding a defect in the capture, not fixing one."""
    return JUNK.sub('', str(s if s is not None else '')).strip()


def normalise(v) -> str:
    s = re.sub(r'[^a-z0-9 ]+', ' ', clean(v).lower())
    s = SUFFIX.sub(' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def drop_article(n: str) -> str:
    return ARTICLE.sub('', n)


def too_short_to_filter(query) -> bool:
    """A name with no distinguishing stem left after suffix removal. 'X Corp'
    normalises to 'x', and a one-character token matches on sight."""
    return len(normalise(query)) <= 2


def names_match(query, name) -> bool:
    """Whole-word presence of every query word inside a name.

    WORD, not substring. 'Ntrepid' is not a word in 'intrepid llc' — it is the
    tail of one, and that namesake holds $441m of Defense awards."""
    q, n = normalise(query), normalise(name)
    if not q or not n:
        return False
    if len(q) <= 2:
        return q == n
    return all(re.search(r'(^| )' + re.escape(w) + r'( |$)', n)
               for w in q.split())


def head_name(query, name) -> bool:
    """Does the name BEGIN with the query, once articles are dropped."""
    q = drop_article(normalise(query))
    n = drop_article(normalise(name))
    if not q or not n:
        return False
    return n == q or n.startswith(q + ' ')


def looks_like_substring(query, name) -> bool:
    """The literal characters landing inside a longer word. Deliberately raw,
    not normalised — the question is about what the operator typed."""
    q = clean(query).lower()
    n = clean(name).lower()
    if len(q) < 2 or q not in n:
        return False
    return not re.search(r'(^|[^a-z0-9])' + re.escape(q) + r'([^a-z0-9]|$)', n)


def has_buried_word(query, name) -> bool:
    """The normalised, per-word version: Cologix inside ECOLOGIX, even when the
    full query string appears verbatim nowhere."""
    n = normalise(name)
    if not n:
        return False
    for w in [w for w in normalise(query).split() if len(w) >= 3]:
        if w in n and not re.search(r'(^| )' + re.escape(w) + r'( |$)', n):
            return True
    return False


def verdict(query, name) -> str:
    text = clean(name)
    if not text or not clean(query):
        return UNKNOWN
    if names_match(query, text):
        return NAME if head_name(query, text) else CONTAINS
    if too_short_to_filter(query):
        return UNKNOWN
    if looks_like_substring(query, text) or has_buried_word(query, text):
        return SUBSTRING
    return OTHER


def best_verdict(query, name) -> str:
    """A compound row — 'CLIENT — REGISTRANT' — is two names, and judging the
    joined string as one answers about neither. Take the best of the parts."""
    parts = [p for p in re.split(r' [-—–] ', clean(name)) if p.strip()]
    order = [NAME, CONTAINS, SUBSTRING, OTHER, UNKNOWN]
    best = UNKNOWN
    for p in parts or [clean(name)]:
        v = verdict(query, p)
        if order.index(v) < order.index(best):
            best = v
    return best


# ─────────────────────────────────────────────────────────────────────────────
# SIDES
#
# An edge is a sentence. Which side the name is on is which word of the
# sentence it is, and a queue that loses that has merged two different claims.

def side_of(row, entity) -> str:
    """'L', 'R', 'LR', or '' for neither. A LOWERCASE letter means the name is
    present but not at the front of that field — CONTAINS, not filed under it,
    so whether it is your subject is a question you must open the document to
    answer."""
    out = ''
    for field, mark in (('entity_a', 'L'), ('entity_b', 'R')):
        v = verdict(entity, row.get(field))
        if v == NAME:
            out += mark
        elif v == CONTAINS:
            out += mark.lower()
    return out


def same_entity(a, b) -> bool:
    """Are these two fields the same company.

    A row whose two sides are one name is not a relationship between two
    parties. On a Senate LDA filing it is IN-HOUSE LOBBYING — the company
    employs its own lobbyists rather than retaining a firm — which is a real
    and reportable fact and a meaningless arrow. Drawn as a card it reads
    FIRSTENERGY CORP -> FIRSTENERGY CORP, which tells an audience nothing and
    tells a hostile one that nobody checked."""
    na, nb = normalise(a), normalise(b)
    return bool(na) and na == nb


def matches_side(row, entity, side=None) -> bool:
    """Does this edge touch the name, on the side asked for."""
    s = side_of(row, entity)
    if not s:
        return False
    if side == 'left':
        return 'L' in s.upper()
    if side == 'right':
        return 'R' in s.upper()
    return True
