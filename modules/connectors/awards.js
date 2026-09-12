'use strict';

/**
 * awards — federal contracts, past the first page, with what they bought.
 *
 * The `usaspending` connector fetches ONE page of 25, sorted by amount. For
 * NTREPID CORPORATION that returned 25 rows and the run reported 25, which
 * is the page size and not a count. Nobody knows how many awards there are,
 * and nobody can total them, because the first page is a ceiling on what was
 * asked rather than a floor on what exists.
 *
 * This pages. It also keeps the DESCRIPTION, which is the field that says
 * what the money bought, and which the sweep display had been dropping.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE TOTAL IS NOT A TOTAL
 * ─────────────────────────────────────────────────────────────────────
 * `Award Amount` on a contract is the CURRENT obligated-plus-potential
 * value of that award as USAspending reports it. Summing a page of awards
 * gives the value of those awards, which is NOT:
 *
 *   - what was actually paid (obligations change, options go unexercised)
 *   - what one company received (subsidiaries file under their own names)
 *   - a career total (this queries one recipient string)
 *
 * So the sum is reported as "the value of the awards listed", and every
 * other reading is refused in the output rather than left to the reader.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE SUBSTRING PROBLEM IS WORSE HERE THAN ANYWHERE
 * ─────────────────────────────────────────────────────────────────────
 * `recipient_search_text` is fuzzy. "Ring LLC" returned LEIDOS ENGINEERING
 * ($107m), and "Ntrepid" returned INTREPID LLC ($441m) — a figure four
 * hundred times the subject's own largest award, sitting at the top of a
 * list sorted by amount. A reader who trusts the sort reads the noise first.
 *
 * Substring hits are separated, never dropped, and never summed.
 */

/**
 * A CORPORATE SUFFIX IS NOT PART OF THE NAME.
 *
 * The first version of `namesMatch` required every query word to appear, and
 * a test caught what that does: asking for "Ntrepid Corporation" classified
 * the real NTREPID, LLC rows as SUBSTRING NOISE and excluded them from every
 * total — because "corporation" is not in "NTREPID, LLC".
 *
 * The operator would have run the command, seen zero clean awards, and had
 * no way to tell that from a company with no contracts. A filter that
 * silently deletes the answer is worse than no filter.
 *
 * Suffixes come off both sides. They carry no identity: the same operation
 * files as Corporation in one state and LLC in another, which is exactly
 * what the OpenCorporates run showed for Ntrepid across fifteen states.
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
 * Whole-word presence of the query inside a recipient name.
 *
 * WORD, not substring. "Ntrepid" is not a word in "intrepid llc" — it is
 * the tail of one, and that namesake holds $441m of Defense awards which
 * sort to the top of a list ordered by amount.
 */
function namesMatch(query, name) {
  const q = normaliseName(query);
  const n = normaliseName(name);
  if (!q || !n) return false;
  return q.split(/\s+/).every((w) => new RegExp(`(^| )${w}( |$)`).test(n));
}

function classify(query, rows) {
  const clean = [];
  const substring = [];
  for (const r of rows) {
    (namesMatch(query, r.name) ? clean : substring).push(r);
  }
  return { clean, substring };
}

/** Dollars back out of "$6,919,191". */
function amountOf(row) {
  const n = Number(String(row.amount == null ? '' : row.amount).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Group by awarding agency — the question "who is buying this" is usually
 * more useful than "how much", and it is the one the sweep could not answer.
 */
function byAgency(rows) {
  const m = new Map();
  let total = 0;
  for (const r of rows) {
    const a = (r.agency || '(agency not stated)').trim();
    const amt = amountOf(r);
    total += amt;
    const cur = m.get(a) || { agency: a, amount: 0, count: 0, largest: 0 };
    cur.amount += amt;
    cur.count += 1;
    if (amt > cur.largest) cur.largest = amt;
    m.set(a, cur);
  }
  return {
    agencies: [...m.values()].sort((x, y) => y.amount - x.amount),
    total,
  };
}

/**
 * Recipient names as filed, because a fuzzy search returns several and they
 * are not necessarily one company. NTREPID CORPORATION was asked for and
 * NTREPID, LLC came back — plausibly the same operation, and not the same
 * string, and this desk does not merge names on plausibility.
 */
function byRecipient(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = (r.name || '(unnamed)').trim();
    const cur = m.get(k) || { name: k, amount: 0, count: 0 };
    cur.amount += amountOf(r);
    cur.count += 1;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * Words that recur across award descriptions.
 *
 * NOT a topic model and not an inference — a frequency count over a field
 * the government wrote. It exists because reading forty descriptions by eye
 * is how a subject gets missed, and because the interesting word in a
 * persona-management contract would be in this list or nowhere.
 */
const STOP = new Set(('the and for of to a in on with by from at or as is are be this that '
  + 'services service support system systems inc llc corp corporation company contract '
  + 'task order idiq option year base new all any per each other equipment supplies '
  + 'shall will providing provide provided including include included requirement '
  + 'requirements program project work performance date amount total not applicable na')
  .split(/\s+/));

function descriptionWords(rows, min = 2) {
  const counts = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const w of String(r.description || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
      if (seen.has(w)) continue;   // count DOCUMENTS, not repetitions
      seen.add(w);
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .map(([word, awards]) => ({ word, awards }))
    .sort((a, b) => b.awards - a.awards || a.word.localeCompare(b.word));
}

/** Earliest and latest dates seen, from the "start → end" period string. */
function span(rows) {
  let first = ''; let last = '';
  for (const r of rows) {
    for (const d of String(r.period || '').split('→')) {
      const t = d.trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) continue;
      if (!first || t < first) first = t;
      if (!last || t > last) last = t;
    }
  }
  return { first, last };
}

module.exports = {
  namesMatch, normaliseName, classify, amountOf, byAgency, byRecipient,
  descriptionWords, span, STOP, SUFFIX,
};
