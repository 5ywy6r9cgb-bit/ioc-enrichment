/**
 * ─────────────────────────────────────────────────────────────────────────
 * IS THE NAME ON THIS ROW THE NAME YOU ASKED FOR?
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This lived inside `awards.js` and nowhere else, so exactly one of eleven
 * connectors could tell a real hit from a namesake. Every other register —
 * OpenCorporates, Senate LDA, Regulations.gov, CourtListener, the Federal
 * Register — ran a weaker test that asked only "does the query appear
 * somewhere inside this string", and counted anything that did not contain
 * the query AT ALL as a clean lead.
 *
 * That second half is the part nobody noticed. A live run of
 * `connect all "AXON ENTERPRISE, INC."` printed `senatelda 25 lead(s)`.
 * Twenty-five filings, none of them flagged, and no test anywhere asked how
 * many of the twenty-five actually name Axon. A row that does not mention
 * the subject and a row that IS the subject scored identically.
 *
 * So there are THREE answers here, not two:
 *
 *   NAME       every word of the query is a whole word in the name.
 *   SUBSTRING  the query hides inside a longer word — INTREPID for Ntrepid,
 *              DAWSON for AWS, ECOLOGIX for Cologix. Almost never it.
 *   OTHER      the query does not appear in the name at all. The source
 *              matched on something else — full document text, a docket
 *              caption, a related field. NOT NOISE, and NOT a name match
 *              either: it is a row you have to open to know anything about.
 *
 * Keeping OTHER separate is the whole point. Collapsing it into "clean"
 * inflates the lead count with rows that never mentioned the subject;
 * collapsing it into "noise" throws away the Federal Register document that
 * discusses a company in its body and not in its title. Both are wrong, and
 * the register cannot tell you which — only opening the document can.
 */

/**
 * Corporate-form words carry no identifying information. "Intel Corporation"
 * and "INTEL CORP" are one company; the difference is a filing clerk's habit.
 */
const SUFFIX = /\b(corporation|corp|company|co|incorporated|inc|llc|l\.l\.c|lp|llp|plc|ltd|limited|pllc|pc|pa|sa|nv|gmbh|holdings|group)\b/g;

function normaliseName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-word presence of every query word inside a name.
 *
 * WORD, not substring. "Ntrepid" is not a word in "intrepid llc" — it is the
 * tail of one, and that namesake holds $441m of Defense awards which sort to
 * the top of any list ordered by amount.
 */
function namesMatch(query, name) {
  const q = normaliseName(query);
  const n = normaliseName(name);
  if (!q || !n) return false;

  // A QUERY THAT SHRINKS TO ALMOST NOTHING MUST NOT MATCH ALMOST ANYTHING.
  //
  // "X Corp" normalises to "x" once the suffix comes off. A one- or
  // two-character token matches on sight, and the live X Corp run shows what
  // the register does with that name: RTX CORPORATION at $8.69bn, XEROX,
  // XERION, and CONDUENT EDUCATION SOLUTIONS at $2.25bn — the last of which
  // the substring guard did not even flag.
  if (q.length <= 2) return q === n;

  return q.split(/\s+/).every((w) => new RegExp(`(^| )${escapeRe(w)}( |$)`).test(n));
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** True when a name has no distinguishing stem left after suffix removal. */
function tooShortToFilter(query) {
  return normaliseName(query).length <= 2;
}

/**
 * The old two-valued test, kept because four call sites and a test suite name
 * it, and because "did this match only inside a longer word" is still a real
 * question. It is now ONE branch of `nameVerdict` rather than the whole
 * answer.
 *
 * Deliberately raw-string, not normalised: the question it answers is about
 * the literal characters the operator typed landing inside a longer word.
 */
function looksLikeSubstringMatch(query, name) {
  if (!query || !name) return false;
  const q = String(query).toLowerCase().trim();
  const n = String(name).toLowerCase();
  // Minimum 2, not 4. The first version skipped queries under four characters
  // on the theory that short queries match everything — which is exactly
  // backwards. A live search for "AWS" returned twenty-five DAWSON companies,
  // $248m of Department of Agriculture money among them, and flagged none of
  // them, because "aws" is three characters. The shorter the query, the more
  // substring noise it draws and the more the flag is needed.
  if (q.length < 2) return false;
  if (!n.includes(q)) return false;        // no match at all is not this problem

  const bounded = new RegExp(`(^|[^a-z0-9])${escapeRe(q)}([^a-z0-9]|$)`);
  return !bounded.test(n);
}

/**
 * Does any distinguishing word of the query hide inside a longer word of the
 * name? This is the normalised, per-word version of the test above, and it is
 * what catches `Cologix` inside `ECOLOGIX` when the full query string does
 * not appear verbatim anywhere.
 */
function hasBuriedWord(query, name) {
  const n = normaliseName(name);
  if (!n) return false;
  const words = normaliseName(query).split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) return false;
  return words.some((w) => {
    if (!n.includes(w)) return false;
    return !new RegExp(`(^| )${escapeRe(w)}( |$)`).test(n);
  });
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE FOURTH ANSWER, WHICH A LIVE RUN FORCED.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `connect all "Blackstone Inc"` reported `CourtListener 20 · 18 name it`.
 * Among the eighteen:
 *
 *     FIC Homes of Blackstone, Inc. v. Conservation Commission   1996, 1994
 *     Hotel Blackstone, Inc. v. Tax Commission                   1980
 *     CMP Complaint Issued to ZA Blackstone Inc. d/b/a ZA Food Mart
 *
 * Blackstone is a town in Massachusetts and a Conservation Commission is a
 * town body. The Hotel Blackstone case is from 1980 and The Blackstone Group
 * was founded in 1985. ZA Food Mart is a convenience store with an FDA
 * tobacco complaint against it.
 *
 * EVERY ONE OF THEM PASSES `namesMatch` LEGITIMATELY. "Blackstone" is a whole
 * word in all three. The string test is correct and the headline is still
 * misleading, because the reader came looking for an investment firm and the
 * number on screen belongs partly to a town, a 1980 hotel and a food mart.
 *
 * `awards.js` already knew this — it has `sameHead`, written after `awards
 * "Intel"` reported eighteen direct payments that turned out to be BLAC INTEL
 * LLC, PALADIN INTEL LLC and BEVERAGE INTEL collecting COVID aid. That guard
 * was never applied to any other connector.
 *
 * So NAME splits in two, and WHERE IN THE NAME THE QUERY SITS is the split:
 *
 *   NAME      the name BEGINS with the query. "Blackstone Inc.",
 *             "Blackstone Private Credit Fund", "Blackstone Inc. v. Somebody".
 *             Filed under the name you asked for.
 *   CONTAINS  the query is a whole word somewhere else in the name. "Hotel
 *             Blackstone", "FIC Homes of Blackstone", "Carolyn Bridges v.
 *             Blackstone, Inc."
 *
 * CONTAINS IS NOT NOISE, and that is why it is its own answer rather than
 * being folded into SUBSTRING. A court caption legitimately carries the party
 * in the middle — `Carolyn Bridges v. Blackstone, Inc.` is the company, as a
 * defendant. What CONTAINS means is: THE REGISTER DID NOT FILE THIS UNDER
 * YOUR SUBJECT'S NAME, so whether it is your subject is a question you have
 * to answer by opening it, not one the string has answered for you.
 */
const NAME = 'NAME';
const CONTAINS = 'CONTAINS';
const SUBSTRING = 'SUBSTRING';
const OTHER = 'OTHER';
const UNKNOWN = 'UNKNOWN';

/** Leading articles carry no identity and break a head test. */
function dropArticle(n) {
  return String(n || '').replace(/^(the|a|an) /, '');
}

/**
 * Does this name BEGIN with the query?
 *
 * "THE BLACKSTONE GROUP INC." must pass: the article and the corporate
 * suffixes come off both sides first, leaving "blackstone" against
 * "blackstone". Without the article strip it normalises to "the blackstone"
 * and the real company gets demoted below a 1980 hotel.
 */
function headName(query, name) {
  const q = dropArticle(normaliseName(query));
  const n = dropArticle(normaliseName(name));
  if (!q || !n) return false;
  return n === q || n.startsWith(`${q} `);
}

/**
 * One of NAME | SUBSTRING | OTHER | UNKNOWN.
 *
 * UNKNOWN when there is nothing to judge: no text on the row, or a query so
 * short that after suffix removal it cannot discriminate ("X Corp" → "x").
 * Saying UNKNOWN is not a hedge — it is the difference between "this row does
 * not name your subject" and "this test cannot see".
 */
function nameVerdict(query, name) {
  const text = String(name || '').trim();
  if (!text) return UNKNOWN;
  if (!String(query || '').trim()) return UNKNOWN;
  if (namesMatch(query, text)) return headName(query, text) ? NAME : CONTAINS;
  if (tooShortToFilter(query)) return UNKNOWN;
  if (looksLikeSubstringMatch(query, text) || hasBuriedWord(query, text)) return SUBSTRING;
  return OTHER;
}

/**
 * Count a page of rows by verdict. `text(row)` pulls the string to judge.
 *
 * The counts are the denominator that "25 lead(s)" never had.
 */
function tally(query, rows, text) {
  const pick = text || ((r) => r.name || r.title || '');
  const out = { NAME: 0, CONTAINS: 0, SUBSTRING: 0, OTHER: 0, UNKNOWN: 0, total: 0 };
  for (const r of rows || []) {
    out[nameVerdict(query, pick(r))] += 1;
    out.total += 1;
  }
  return out;
}

module.exports = {
  SUFFIX, normaliseName, namesMatch, tooShortToFilter,
  looksLikeSubstringMatch, hasBuriedWord, headName, dropArticle,
  nameVerdict, tally,
  NAME, CONTAINS, SUBSTRING, OTHER, UNKNOWN,
};
