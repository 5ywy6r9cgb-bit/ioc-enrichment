#!/usr/bin/env node
'use strict';
/**
 * bills.js — which bills appear in more than one filing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS THE STEP THAT MATTERS
 * ─────────────────────────────────────────────────────────────────────────
 * A shared registrant is a ROSTER. One firm files for a hyperscaler and for a
 * gas utility; that is a sworn fact about who retained whom, and it is not a
 * fact about either client's position on anything.
 *
 * The same BILL named in two clients' filings is different. Both parties told
 * Congress, under 2 U.S.C. 1603-1604, that they lobbied on that specific
 * legislation. That is not co-occurrence and not inference -- it is two sworn
 * statements about one object.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT ESTABLISH
 * ─────────────────────────────────────────────────────────────────────────
 * Two clients lobbying on one bill does NOT mean they took the same side.
 * A filing names the bill; it does not say for or against. Opposing parties
 * routinely appear on the same bill in the same quarter, and reporting a
 * shared bill as an alignment would be the single easiest way to publish
 * something false out of accurate records.
 *
 * So this reports CO-FILING and says, in the output, that a side is not in
 * the record.
 */

const fs = require('fs');
const path = require('path');

/**
 * Bill designations as they actually appear in filings.
 *
 * Deliberately strict. `S. 1` is a real bill and also matches a sentence
 * ending in an initial, so a bare single digit is not accepted -- a false
 * bill number linking two unrelated filings is worse than a missed one,
 * because it looks like a finding.
 */
// Two tiers, because the digit floor is a tradeoff and it should not be paid
// where it buys nothing.
//
//   "S. 1"      -- could be a bill, could be a signature, a section, a rule.
//   "S.Res. 9"  -- could be nothing else.
//
// So a BARE chamber prefix needs two digits, and every unambiguous form takes
// one. Resolutions are routinely numbered in single digits (S.Res. 9,
// H.J.Res. 1) and requiring two silently dropped them -- a missed bill loses
// a real correlation just as surely as a false one invents a fake.
const UNAMBIGUOUS = 'H\\.?\\s?J\\.?\\s?Res\\.?|S\\.?\\s?J\\.?\\s?Res\\.?'
  + '|H\\.?\\s?Con\\.?\\s?Res\\.?|S\\.?\\s?Con\\.?\\s?Res\\.?'
  + '|H\\.?\\s?Res\\.?|S\\.?\\s?Res\\.?|H\\.?\\s?R\\.?';

// "U.S." ENDS IN S. AND IS FOLLOWED BY NUMBERS CONSTANTLY.
//
// The two-digit floor above was the whole defence for a bare "S.", and it
// does nothing here, because a live run produced exactly this:
//
//   S. 2024  — 2 clients
//     …to influence the U.S. 2024 Presidential Election…
//   S. 82    — 2 clients
//     …disinformation targeting the U.S. 82 Artichoc io is a French…
//
// Neither is a bill. `\b` matches between the "." and the "S" of "U.S.",
// so every "U.S. <number>" in every document became a Senate bill — and
// then `correlate` reported the two documents naming it as a CORRELATION,
// which is the shape of a finding built entirely out of nothing.
//
// The fix is a lookbehind: a chamber prefix may not be preceded by another
// letter-plus-dot. That kills U.S., N.J.S., and anything else of that form
// while leaving a sentence-initial or space-preceded "S. 2024" intact.
const NOT_AN_ABBREVIATION = '(?<![A-Za-z]\\.\\s?)';

const BILL_RE = new RegExp(
  NOT_AN_ABBREVIATION
  + '\\b(?:'
  + `(${UNAMBIGUOUS})\\s?(\\d{1,5})`      // H.Res. 9 is fine
  + '|(S\\.)\\s?(\\d{2,5})'            // bare "S." needs two digits
  + ')\\b',
  'gi');

/** One spelling per bill, so H.R.9126 and "HR 9126" are the same key. */
function canon(prefix, num) {
  const p = prefix.replace(/[.\s]/g, '').toUpperCase();
  const map = {
    HJRES: 'H.J.Res.', SJRES: 'S.J.Res.',
    HCONRES: 'H.Con.Res.', SCONRES: 'S.Con.Res.',
    HRES: 'H.Res.', SRES: 'S.Res.',
    HR: 'H.R.', S: 'S.',
  };
  return `${map[p] || p} ${Number(num)}`;
}

function billsIn(text) {
  const out = new Map();
  let m;
  BILL_RE.lastIndex = 0;
  while ((m = BILL_RE.exec(text)) !== null) {
    const prefix = m[1] !== undefined ? m[1] : m[3];
    const num = m[2] !== undefined ? m[2] : m[4];
    const key = canon(prefix, num);
    if (!out.has(key)) {
      // Keep a little surrounding text: a bill number with no context cannot
      // be checked against the page, and an unverifiable citation is not one.
      const from = Math.max(0, m.index - 90);
      const ctx = text.slice(from, m.index + m[0].length + 90)
        .replace(/\s+/g, ' ').trim();
      out.set(key, ctx);
    }
  }
  return out;
}

/**
 * Pull the two parties out of an LDA filing's extracted text.
 *
 * Best-effort and honest about it: a filing whose parties cannot be read is
 * reported by filename rather than being dropped, because a document missing
 * from a correlation reads as a document that shares nothing.
 */
function partiesIn(text) {
  const grab = (label) => {
    // The label must START A LINE. Without that anchor the word "registrant"
    // anywhere in running prose became a field, and a court affidavit about
    // TRADEMARKS produced:
    //
    //   filed by A registrant is the person or entity that holds the right
    //   to use a specific
    //
    // which was then printed beside a bill number as though it named a
    // lobbying firm.
    const re = new RegExp(`^[ \\t]*${label}\\s*(?:Name)?\\s*[:\\t]\\s*([^\\n\\t]{2,90})`, 'im');
    const m = re.exec(text);
    if (!m) return '';
    const v = m[1].trim().replace(/\s+/g, ' ');
    return looksLikeProse(v) ? '' : v;
  };
  return { registrant: grab('Registrant'), client: grab('Client') };
}

/**
 * Is this a captured field value, or a sentence that happened to follow a
 * word? An organisation name does not begin "is the person or entity".
 */
function looksLikeProse(v) {
  if (/^(is|are|was|were|means|shall|may|must|can|refers|includes|does)\b/i.test(v)) return true;
  // A name is not a clause. Two or more of these little words says sentence.
  const glue = (v.match(/\b(the|of|that|which|to|for|with|and|or|a|an)\b/gi) || []).length;
  if (glue >= 3) return true;
  // Entirely lower-case is a word from prose, not a filed party name.
  if (v === v.toLowerCase() && /[a-z]/.test(v)) return true;
  return false;
}

/** Every extracted-text file sitting beside a fetched document. */
function readDocs(dir) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.txt')) continue;
    const p = path.join(dir, n);
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); }
    catch { continue; }
    out.push(Object.assign({ file: n, path: p, text }, partiesIn(text)));
  }
  return out;
}

/**
 * Group documents by the bills they name.
 *
 * A document is counted ONCE per bill however many times it names it. Filings
 * repeat a bill number in every activity block, and counting mentions would
 * report a single filing as a crowd.
 */
function correlate(docs) {
  const byBill = new Map();
  for (const d of docs) {
    d.bills = billsIn(d.text);
    for (const [bill, ctx] of d.bills) {
      if (!byBill.has(bill)) byBill.set(bill, []);
      byBill.get(bill).push({ doc: d, context: ctx });
    }
  }

  const shared = [];
  for (const [bill, hits] of byBill) {
    // Distinct CLIENTS, not distinct files. The same filing fetched twice, or
    // a filing and its amendment, is one party -- and reporting it as two
    // would manufacture a correlation out of one sworn statement.
    const clients = new Set(hits.map((h) => h.doc.client || h.doc.file));
    if (clients.size > 1) {
      shared.push({ bill, hits, clients: [...clients].sort() });
    }
  }
  shared.sort((a, b) => b.clients.length - a.clients.length
    || a.bill.localeCompare(b.bill));
  return { byBill, shared, docs };
}

/**
 * The passage a filing uses to describe what it lobbied on.
 *
 * Reported for documents that named NO bill, because "0 bills in 13,000
 * characters" is an assertion the operator cannot check. Either the filing
 * genuinely cites no legislation -- very common, many describe issues in
 * prose -- or the matcher missed a format. Showing the actual text is the
 * difference between those two, and only one of them is a bug.
 */
function issueTextIn(text) {
  const m = /(specific\s+lobbying\s+issues?|lobbying\s+issues?|general\s+issue)/i.exec(text);
  if (!m) return '';
  return text.slice(m.index, m.index + 320).replace(/\s+/g, ' ').trim();
}

module.exports = { billsIn, partiesIn, readDocs, correlate, canon, issueTextIn, BILL_RE };
