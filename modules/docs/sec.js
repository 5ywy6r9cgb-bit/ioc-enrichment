/**
 * sec.js -- an entity's complete SEC filing history, as data.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT A ONE-LINER
 *
 * The one-liner that produced this module's first output was pasted into a
 * terminal and it worked. It also did this:
 *
 *     if not doc:
 *         continue
 *
 * -- silently dropping any filing with no primary document, and printing the
 * rest as though that were the history. On the entity it was written for,
 * nothing was dropped and the bug was invisible. On the next one it would
 * have removed rows with no line saying rows had been removed.
 *
 * That is the failure this desk exists to refuse, so the rule here is:
 * NOTHING IS DROPPED WITHOUT SAYING SO. A filing with no primary document
 * gets the accession index URL instead of being skipped.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CAP THAT LOOKS LIKE A COUNT
 *
 * `data.sec.gov/submissions/CIK##########.json` holds the entity's recent
 * filings in `filings.recent` -- and for a large filer, ONLY the recent ones.
 * The rest live in separate JSON files named in `filings.files[]`.
 *
 * A small issuer fits entirely in `recent`, so a reader who tests on one
 * concludes the endpoint returns everything. Point the same code at Ohio
 * Power Company or FirstEnergy and it returns the most recent page, in the
 * same shape, with no error -- and "34 filings, 2013 to 2019" becomes "1000
 * filings, 2009 to 2026" for a company that has filed since the 1940s.
 *
 * A cap is not a count. `truncated` is set, the additional files are named
 * with their date ranges and URLs, and the caller is expected to say so.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DOES NOT DO
 *
 * It does not conclude. `summarize()` reports how often a form was filed and
 * how long it has been since the last one; it does not decide that a series
 * "stopped", because a company that files annually is not overdue in month
 * eleven and a dead entity is not newsworthy on its own. Deregistration
 * forms are surfaced by name and date for the same reason: a Form 15
 * suspends a duty to file. It is not a statement that anything was paid,
 * settled, or closed, and reading it as one is how a routine filing becomes
 * a false claim.
 */

'use strict';

// Forms that END a reporting obligation. Surfaced by name because "the
// filings just stop" and "the issuer filed to stop" are different facts, and
// only one of them is interesting.
const DEREGISTRATION_FORMS = new Set([
  '15', '15-12B', '15-12G', '15-15D',
  '15F-12B', '15F-12G', '15F-15D',
]);

/**
 * A CIK, or a refusal that says what to do instead.
 *
 * Accepts 1577459, 0001577459, CIK0001577459, CIK0001577459.json -- every
 * shape these numbers actually appear in, including copied straight out of a
 * URL or a saved capture's filename.
 *
 * REFUSES A COMPANY NAME. Stripping the letters out of "Ohio Power Company"
 * leaves nothing, and padding nothing to ten digits is CIK0000000000, which
 * is a real request for a real URL that answers 404 -- a lookup that failed
 * silently and reads as "this company does not file".
 */
function normalizeCik(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) {
    return { error: 'no CIK given', suggestion: 'sentinel sec history 1577459' };
  }
  const stripped = raw
    .replace(/\.json$/i, '')
    .replace(/^cik[-_ ]?/i, '')
    .trim();
  if (!/^\d+$/.test(stripped)) {
    return {
      error: `"${raw}" is not a CIK`,
      isName: /[A-Za-z]/.test(stripped),
      suggestion: 'A CIK is a number, e.g. 1577459. To find one by name, '
        + 'search the filings themselves:  sentinel connect sec "Ohio Power Company"',
    };
  }
  if (stripped.length > 10) {
    return { error: `"${raw}" has ${stripped.length} digits; a CIK has at most 10` };
  }
  return { cik: stripped.padStart(10, '0') };
}

function submissionsUrl(cik) {
  return `https://data.sec.gov/submissions/CIK${cik}.json`;
}

/**
 * The URL of one filing.
 *
 * Two things here are easy to get wrong and both fail quietly:
 *   - the accession number loses its dashes in the DIRECTORY name and keeps
 *     them in the index FILENAME;
 *   - the /Archives/ path uses the CIK with its leading zeros stripped.
 * Get either wrong and every URL 404s, which reads as a removed document.
 *
 * With no primary document named, this returns the accession INDEX -- the
 * page listing every document in that filing. That is a real, fetchable
 * address, and it is the honest answer to "which document is this filing?"
 * when the answer is "several".
 */
function filingUrl(cik, accession, primaryDocument) {
  const bare = String(cik || '').replace(/^0+/, '') || '0';
  const acc = String(accession || '');
  const dir = acc.replace(/-/g, '');
  const base = `https://www.sec.gov/Archives/edgar/data/${bare}/${dir}`;
  return primaryDocument
    ? `${base}/${primaryDocument}`
    : `${base}/${acc}-index.htm`;
}

function pick(o, k) {
  const v = o && o[k];
  return v == null ? '' : String(v);
}

/**
 * The submissions JSON, read.
 *
 * Returns { ok: false, error } rather than an empty history when the shape is
 * not what it should be. An entity that files nothing and an endpoint that
 * answered with something else are different facts; printing an empty list
 * for both turns the second into the first.
 */
function parseSubmissions(obj, cikHint) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'not a JSON object' };
  }
  const cik = (pick(obj, 'cik') || String(cikHint || '')).padStart(10, '0');
  const filingsBlock = obj.filings;
  if (!filingsBlock || typeof filingsBlock !== 'object') {
    return {
      ok: false,
      error: 'this JSON has no `filings` block — it is not an EDGAR submissions record',
      cik,
    };
  }
  const recent = filingsBlock.recent;
  if (!recent || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) {
    return {
      ok: false,
      error: 'the `filings.recent` block is missing or malformed — '
        + 'this is UNKNOWN, not an entity with no filings',
      cik,
    };
  }

  const n = recent.form.length;
  const col = (name) => (Array.isArray(recent[name]) ? recent[name] : []);
  const form = col('form');
  const filingDate = col('filingDate');
  const accessionNumber = col('accessionNumber');
  const primaryDocument = col('primaryDocument');
  const reportDate = col('reportDate');
  const primaryDocDescription = col('primaryDocDescription');

  // The parallel arrays are supposed to be the same length. If they are not,
  // say so rather than reading past the end and printing empty strings as
  // though the data were there.
  const ragged = [
    ['filingDate', filingDate.length], ['accessionNumber', accessionNumber.length],
  ].filter(([, len]) => len !== n).map(([name]) => name);

  const filings = [];
  for (let i = 0; i < n; i += 1) {
    const acc = String(accessionNumber[i] || '');
    const doc = String(primaryDocument[i] || '');
    filings.push({
      date: String(filingDate[i] || ''),
      form: String(form[i] || ''),
      accession: acc,
      primaryDocument: doc,
      // NOT skipped when the document is missing. See the header.
      hasPrimaryDocument: !!doc,
      reportDate: String(reportDate[i] || ''),
      description: String(primaryDocDescription[i] || ''),
      url: filingUrl(cik, acc, doc),
      indexUrl: filingUrl(cik, acc, ''),
    });
  }
  filings.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // THE CAP. See the header.
  const files = Array.isArray(filingsBlock.files) ? filingsBlock.files : [];
  const moreFiles = files.map((f) => ({
    name: pick(f, 'name'),
    from: pick(f, 'filingFrom'),
    to: pick(f, 'filingTo'),
    count: Number(f && f.filingCount) || 0,
    url: `https://data.sec.gov/submissions/${pick(f, 'name')}`,
  }));

  const formerNames = (Array.isArray(obj.formerNames) ? obj.formerNames : [])
    .map((f) => ({ name: pick(f, 'name'), from: pick(f, 'from'), to: pick(f, 'to') }))
    .filter((f) => f.name);

  return {
    ok: true,
    cik,
    name: pick(obj, 'name'),
    sic: pick(obj, 'sic'),
    sicDescription: pick(obj, 'sicDescription'),
    entityType: pick(obj, 'entityType'),
    stateOfIncorporation: pick(obj, 'stateOfIncorporation'),
    tickers: Array.isArray(obj.tickers) ? obj.tickers.filter(Boolean) : [],
    formerNames,
    filings,
    shown: filings.length,
    ragged,
    truncated: moreFiles.length > 0,
    moreFiles,
    // Only ever a floor when truncated. Named so a caller cannot print it as
    // a total by accident.
    countIsFloor: moreFiles.length > 0,
  };
}

function daysBetween(a, b) {
  const t1 = Date.parse(`${a}T00:00:00Z`);
  const t2 = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return Math.round((t2 - t1) / 86400000);
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * How often each form was filed, and how long since the last one.
 *
 * `sinceLast` is the plain elapsed time. `typicalGap` is the median interval
 * between filings of that form, and it is null below three filings, because
 * one interval is not a pattern and calling it one is how a coincidence
 * becomes a schedule.
 *
 * There is deliberately no `stopped` flag. A form filed annually is not
 * missing eleven months later, an entity may have wound up for reasons that
 * are nobody's business, and a boolean invites the reader to skip the dates.
 */
function summarize(filings, asOf) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  const byForm = new Map();
  for (const f of filings) {
    if (!byForm.has(f.form)) byForm.set(f.form, []);
    byForm.get(f.form).push(f);
  }
  const rows = [];
  for (const [form, list] of byForm) {
    const dates = list.map((f) => f.date).filter(Boolean).sort();
    const gaps = [];
    for (let i = 1; i < dates.length; i += 1) {
      const d = daysBetween(dates[i - 1], dates[i]);
      if (d != null) gaps.push(d);
    }
    const last = dates[dates.length - 1] || '';
    rows.push({
      form,
      count: list.length,
      first: dates[0] || '',
      last,
      typicalGap: dates.length >= 3 ? median(gaps) : null,
      sinceLast: last ? daysBetween(last, today) : null,
    });
  }
  rows.sort((a, b) => b.count - a.count || (a.form < b.form ? -1 : 1));
  return rows;
}

/**
 * Filings that ended a reporting obligation, newest last.
 *
 * Surfaced separately because of what it is NOT. A Form 15 suspends the duty
 * to file under Section 15(d) or deregisters a class under 12(b)/12(g). It
 * says nothing about whether securities were repaid, a case settled, or a
 * business closed. For bonds held in book-entry there is typically one holder
 * of record -- the depository's nominee -- so the eligibility that makes
 * deregistration possible can exist from the first year, and the date a
 * company chooses to use it is a decision, not an event.
 */
function deregistrations(filings) {
  return filings.filter((f) => DEREGISTRATION_FORMS.has(String(f.form).toUpperCase()));
}

module.exports = {
  DEREGISTRATION_FORMS,
  normalizeCik,
  submissionsUrl,
  filingUrl,
  parseSubmissions,
  summarize,
  deregistrations,
  daysBetween,
  median,
};
