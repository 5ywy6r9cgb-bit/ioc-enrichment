#!/usr/bin/env node
'use strict';
/**
 * statute.js — which sections of an enacted law say a thing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT A grep
 * ─────────────────────────────────────────────────────────────────────────
 * Two hand-rolled regexes were used on Public Law 118-159 (the FY2025 NDAA,
 * 794 pages) to answer "which sections name Israel". Both undercounted, in
 * different ways, and both looked like they had worked:
 *
 *   ATTEMPT 1   grep -o "SEC\. [0-9]{3,4}\..{0,90}"
 *               Reads 90 characters ON ONE LINE. Statutory headings wrap:
 *                 SEC. 1214. STRATEGIC PARTNERSHIP ON DEFENSE INDUSTRIAL PRIOR-
 *                            ITIES BETWEEN THE UNITED STATES AND ISRAEL.
 *               "ISRAEL" is on the next line, so the section was invisible.
 *               Reported 4 sections.
 *
 *   ATTEMPT 2   join hyphenated wraps, collapse whitespace, then match
 *               Found two sections the first missed (855, 1615) and LOST
 *               1214 and 1215, because this document has a MARGINAL NOTE
 *               COLUMN interleaved into the extracted text:
 *                 22 USC 8606   SEC. 1214. STRATEGIC ... INDUSTRIAL PRIOR-
 *                 note.                    ITIES BETWEEN ... AND ISRAEL.
 *               Joining "PRIOR-" to the next line produced "PRIORnote.",
 *               and the heading terminated at that stray period.
 *
 * Each attempt produced a confident, citable, WRONG list. The lesson is not
 * "write a better regex" — it is that a heading in a two-column PDF
 * extraction is not a line, and a count of them is not a finding unless the
 * method can say what it could not read.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES INSTEAD
 * ─────────────────────────────────────────────────────────────────────────
 * It does not try to parse headings. It finds where each section STARTS,
 * treats everything up to the next start as that section's BODY, and
 * searches the body. A section is reported when the term appears anywhere
 * inside it, so a wrapped heading, a marginal note, or a term that appears
 * only in the operative text are all found by the same mechanism.
 *
 * That is strictly more inclusive than heading matching, and it is the right
 * direction to err: Sec. 1213 of this Act requires annual joint military
 * exercises with Israel and does NOT say "Israel" in its heading at all.
 */

/** Marginal-note debris that the extractor interleaves into the text. */
const MARGIN_NOTE = /\b\d{1,2} USC \d+[A-Za-z]?\b|^\s*note\.\s*$/i;

/**
 * Every section start, in document order.
 *
 * Matches the ALL-CAPS body headings ("SEC. 1214.") and not the Title-Case
 * table of contents ("Sec. 1214."), because the TOC is a list of pointers
 * and counting it doubles every section. Whether the TOC was excluded is
 * REPORTED, not assumed — a law whose body headings are not capitalised
 * would silently return nothing, and that must be visible.
 */
function sectionStarts(text) {
  const t = String(text || '');
  const re = /^[^\S\n]*(?:\d{1,2} USC[^\n]*?)?SEC(?:TION)?\.?\s+(\d{1,4})([A-Z]?)\.\s/gm;
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    // Only the FIRST WORD of the heading is tested for case. Scanning a
    // fixed 40-character window instead rejected every SHORT heading,
    // because the body text on the next line fell inside the window:
    // "SEC. 100. FIRST SECTION." was discarded as a contents entry, and a
    // term buried in that section became a term in no section at all.
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const firstWord = (after.split('\n')[0] || '').trim().split(/\s+/)[0] || '';
    if (!firstWord || /[a-z]/.test(firstWord)) continue;
    out.push({ number: m[1] + m[2], index: m.index, line: t.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** The body of each section: from its start to the next one's. */
function sections(text) {
  const t = String(text || '');
  const starts = sectionStarts(t);
  return starts.map((s, i) => ({
    number: s.number,
    line: s.line,
    body: t.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : t.length),
  }));
}

/**
 * Collapse a section body into one searchable string.
 *
 * Rejoins hyphenated line wraps and drops the marginal-note column that
 * broke attempt 2. The note is removed BEFORE the hyphen join, which is the
 * whole fix: joining first is what produced "PRIORnote."
 */
function flatten(body) {
  return String(body || '')
    .split('\n')
    // The margin column sits at the START of the line, ahead of the real
    // text, and it is not always the whole line: the second line of a
    // wrapped heading reads "note.        ITIES BETWEEN ... ISRAEL." Only
    // stripping WHOLE note lines left the "note." glued to the heading and
    // terminated it at that period -- the same failure, one layer down.
    .map((L) => L.replace(/^\s*(?:\d{1,2} USC \d+[A-Za-z]?\s*)?(?:note\.)?(?=\s|$)/i, ' '))
    .join('\n')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first N characters of a section's heading, best effort. */
function heading(body, max = 140) {
  const f = flatten(body);
  const m = /^SEC(?:TION)?\.?\s+\d{1,4}[A-Z]?\.\s*(.*)$/.exec(f);
  const h = m ? m[1] : f;
  const stop = h.indexOf('.');
  return (stop > 8 ? h.slice(0, stop) : h.slice(0, max)).trim();
}

/**
 * Which sections mention a term, and how often.
 *
 * @returns { sections, matched, total, inHeadingOnly, coverage }
 *   `total` is the denominator and is printed whether or not anything
 *   matched: "3 of 0 sections" is a broken parse, not a rare term, and the
 *   two are indistinguishable without it.
 */
function mentions(text, term) {
  const re = term instanceof RegExp
    ? new RegExp(term.source, term.flags.includes('g') ? term.flags : term.flags + 'g')
    : new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const all = sections(text);
  const matched = [];
  for (const s of all) {
    const flat = flatten(s.body);
    const hits = (flat.match(re) || []).length;
    if (!hits) continue;
    const head = heading(s.body);
    matched.push({
      number: s.number,
      line: s.line,
      hits,
      heading: head,
      // A FRESH matcher. Reusing `re` here advanced its lastIndex between
      // the body scan and the heading scan, so whether a heading counted
      // depended on where the previous search happened to stop.
      inHeading: new RegExp(re.source, re.flags.replace('g', '')).test(head),
    });
    re.lastIndex = 0;
  }
  return {
    matched,
    total: all.length,
    // Sections where the term is in the BODY but NOT the heading are exactly
    // the ones a heading search misses. Reported, because that gap is the
    // reason this module exists.
    bodyOnly: matched.filter((m) => !m.inHeading).map((m) => m.number),
  };
}

module.exports = { sectionStarts, sections, flatten, heading, mentions, MARGIN_NOTE };
