#!/usr/bin/env node
'use strict';
/**
 * abatements.js — what a government gave away, out of its own audit.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * GASB Statement No. 77 (effective for fiscal years beginning after
 * 15 December 2015) requires every state and local government in the United
 * States to disclose, in its audited annual financial report, the DOLLAR
 * AMOUNT OF TAX REVENUE IT DID NOT COLLECT because of abatement agreements.
 *
 * It is mandatory. It is audited. It is published every year by every city,
 * county and school district in the country. And almost nobody reads it.
 *
 * That is the same shape as 22 U.S.C. 613(h) and FEC Schedule E on this
 * desk: the number people assume is hidden is on a form, and the reason it
 * feels unobtainable is that the form is boring rather than secret.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT GASB 77 DOES NOT COVER — READ THIS BEFORE PUBLISHING A NUMBER
 * ─────────────────────────────────────────────────────────────────────────
 * The disclosure is narrower than "what the deal cost the public", in four
 * specific ways, and each one makes the reported figure an UNDERSTATEMENT:
 *
 *   1. TAX INCREMENT FINANCING IS USUALLY NOT AN ABATEMENT. A TIF does not
 *      forgive the tax; it DIVERTS the tax to pay for the development. GASB
 *      has said TIFs generally fall outside Statement 77. So a district can
 *      report a small abatement figure while a large slice of its base is
 *      being redirected, and both statements are true.
 *   2. ONLY AGREEMENTS. A blanket exemption written into state law -- an
 *      entire class of property exempted by statute -- is not an
 *      "agreement" and is not disclosed here.
 *   3. NO COST SIDE. The figure is revenue forgone. It says nothing about
 *      the services the development requires: roads, water, sewer, and the
 *      classrooms the new rooftops fill.
 *   4. PASSIVE LOSSES ARE OFTEN THINNER. When a CITY abates and a SCHOOL
 *      DISTRICT loses the revenue, the district must disclose the loss --
 *      but reporting practice varies, and some districts disclose far less
 *      detail about another government's agreement than about their own.
 *
 * So: this module reports what the document SAYS. Every figure it returns
 * is a floor. It is not "the cost of the deal" and must never be labelled
 * that way.
 */

/** Dollar figures, with the magnitude words that so often follow them. */
const MONEY = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(million|billion|thousand)?/gi;

/**
 * Headings that open a GASB 77 note.
 *
 * Deliberately several: governments do not agree on a name. "Tax Abatement
 * Disclosures", "Tax Abatements", "Note X - Tax Abatement", and in Ohio
 * frequently the program names themselves -- Community Reinvestment Area,
 * Enterprise Zone -- appear as the heading with no mention of "abatement".
 */
const NOTE_HEADING = /(?:^|\n)[^\n]{0,80}?\b(TAX ABATEMENTS?(?:\s+DISCLOSURES?)?|ABATED TAXES|TAX ABATEMENT DISCLOSURE)\b[^\n]{0,60}/gi;

/**
 * Ohio's abatement instruments, by name.
 *
 * Named explicitly because the word "abatement" frequently never appears:
 * an Ohio ACFR will say "Community Reinvestment Area" and expect you to
 * know that is the abatement. A search for the generic word misses it.
 */
const PROGRAMS = [
  ['Community Reinvestment Area', /\bcommunity reinvestment areas?\b|\bCRA\b(?!\w)/gi],
  ['Enterprise Zone', /\benterprise zones?\b/gi],
  ['Tax Increment Financing', /\btax increment financing\b|\bTIF\b(?!\w)/gi],
  ['Job Creation / Retention Credit', /\bjob (?:creation|retention) (?:tax )?credits?\b/gi],
  ['Municipal Utility / JEDD', /\bjoint economic development (?:district|zone)\b|\bJEDD\b/gi],
  ['Abatement (generic)', /\babatements?\b/gi],
  ['PILOT payment', /\bpayments? in lieu of tax(?:es)?\b|\bPILOT\b(?!\w)/gi],
];

/** Collapse wrapped lines so a figure split across a line break survives. */
function flatten(text) {
  return String(text || '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every dollar figure in a string, normalised to a number of dollars. */
function amounts(text) {
  const out = [];
  const t = String(text || '');
  MONEY.lastIndex = 0;
  let m;
  while ((m = MONEY.exec(t)) !== null) {
    const raw = m[0].trim();
    let n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const scale = (m[2] || '').toLowerCase();
    if (scale === 'thousand') n *= 1e3;
    else if (scale === 'million') n *= 1e6;
    else if (scale === 'billion') n *= 1e9;
    out.push({ raw, dollars: n, index: m.index });
  }
  return out;
}

/**
 * The passage around each abatement heading.
 *
 * A fixed window, not "to the next heading": an ACFR's note structure is
 * not reliably detectable from extracted text, and guessing a boundary that
 * runs long silently attributes the NEXT note's dollar figures to this one.
 * A window that is too short misses figures and says so; a boundary that is
 * wrong invents them. Missing is recoverable, inventing is not.
 */
function passages(text, opts = {}) {
  const t = String(text || '');
  const window = opts.window || 2600;
  const out = [];
  NOTE_HEADING.lastIndex = 0;
  let m;
  while ((m = NOTE_HEADING.exec(t)) !== null) {
    const start = m.index;
    out.push({
      heading: flatten(m[0]).slice(0, 120),
      line: t.slice(0, start).split('\n').length,
      body: t.slice(start, start + window),
      truncated: start + window < t.length,
    });
    if (out.length >= (opts.max || 40)) break;
  }
  return out;
}

/** Which named programs a passage mentions. */
function programsIn(text) {
  const flat = flatten(text);
  const hits = [];
  for (const [name, re] of PROGRAMS) {
    re.lastIndex = 0;
    const n = (flat.match(re) || []).length;
    if (n) hits.push({ program: name, mentions: n });
  }
  return hits;
}

/**
 * Read a document for its tax-abatement disclosure.
 *
 * Returns everything needed to judge the result, including the two things
 * that make it interpretable: whether the phrase appears AT ALL, and
 * whether a TIF is named in the same breath.
 */
function analyse(text, opts = {}) {
  const t = String(text || '');
  const found = passages(t, opts);
  const notes = found.map((p) => ({
    heading: p.heading,
    line: p.line,
    programs: programsIn(p.body),
    // FLATTEN FIRST. The raw body carries the PDF's line breaks, and a
    // figure hyphenated across one ("$4,312,-\n905") is then read as
    // "$4,312" -- an understatement of three orders of magnitude, printed
    // with a dollar sign and no warning.
    //
    // A number split across lines with NO hyphen ("$4,312,\n905") is NOT
    // recovered, deliberately: joining on whitespace alone would also weld
    // two adjacent figures in a table into one invented number, and an
    // invented figure is worse than a missing one.
    amounts: amounts(flatten(p.body)).sort((a, b) => b.dollars - a.dollars).slice(0, 12),
    excerpt: flatten(p.body).slice(0, 400),
  }));

  const flat = flatten(t);
  return {
    notes,
    // A document with no abatement heading has not been shown to have no
    // abatements: the note may be titled by PROGRAM NAME instead, which is
    // ordinary in Ohio. Reported separately so the two never merge.
    headingFound: notes.length > 0,
    programsAnywhere: programsIn(flat),
    // TIF is the single most consequential caveat: it is generally OUTSIDE
    // GASB 77, so a document that names one is a document whose abatement
    // figure understates what left the tax base.
    tifNamed: /\btax increment financing\b|\bTIF\b(?!\w)/i.test(flat),
    chars: t.length,
  };
}

module.exports = {
  MONEY, NOTE_HEADING, PROGRAMS,
  flatten, amounts, passages, programsIn, analyse,
};
