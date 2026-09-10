#!/usr/bin/env node
'use strict';
/**
 * filings.js — the documents themselves, not the numbers derived from them.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────
 * Every other FEC command here reads the API's *parsed* schedules — useful,
 * fast, and one step removed from the thing a reader can check. Two open
 * questions in the findings file cannot be answered from parsed schedules
 * at all:
 *
 *   WHO ARE THE PARTICIPANTS in a joint fundraising committee?
 *     That is on FORM 1, which names them. No schedule carries it.
 *
 *   WHAT WAS THE MEDIA SPENDING FOR?
 *     A disbursement's `purpose` field says "MEDIA". The FORM 3X page it
 *     came from carries the full description.
 *
 * The obvious URL — docquery.fec.gov/cgi-bin/forms/<id>/ — answers 403.
 * It is a browser path, not a document path. The API publishes a direct
 * `pdf_url` for every filing, and that is what this reads.
 *
 * ─────────────────────────────────────────────────────────────────────
 * A FILING IS A PRIMARY SOURCE. A DERIVED TOTAL IS NOT.
 * ─────────────────────────────────────────────────────────────────────
 * Everything else in this repo produces figures that must be checked
 * against a document before publication. This produces the document. It is
 * the end of the chain, not another link in it.
 *
 * AMENDMENTS MATTER AND ARE MARKED. A committee that files, then amends,
 * has two documents saying different things, and quoting the superseded one
 * is a way to be wrong while holding a real filing in your hand.
 */

const API = 'https://api.open.fec.gov/v1';

/** Every filing a committee has made, newest first. */
function filingsUrl(committeeId, key, { cycle, formType, page = 1 } = {}) {
  let u = `${API}/committee/${encodeURIComponent(committeeId)}/filings/`
        + `?api_key=${encodeURIComponent(key)}`
        + `&per_page=100&page=${page}&sort=-receipt_date`;
  if (cycle) u += `&cycle=${encodeURIComponent(cycle)}`;
  // form_type accepts F1, F3X, F99 … The API matches on the prefix, so
  // 'F3' would also return F3X and F3P; be explicit.
  if (formType) u += `&form_type=${encodeURIComponent(formType)}`;
  return u;
}

function parseFilings(json) {
  return (json.results || []).map((r) => ({
    form: r.form_type || '',
    form_full: r.document_type_full || r.document_type || '',
    // The whole point. Empty means the FEC has no PDF for this row, which
    // happens for some very old or electronically-superseded filings.
    pdf: r.pdf_url || '',
    receipt_date: (r.receipt_date || '').slice(0, 10),
    from: (r.coverage_start_date || '').slice(0, 10),
    to: (r.coverage_end_date || '').slice(0, 10),
    // 'N' new, 'A' amendment, 'T' termination. An amendment supersedes an
    // earlier document and quoting the superseded one is how you are wrong
    // while holding a real filing.
    amendment: (r.amendment_indicator || '').toUpperCase(),
    amends: r.amends_file_number || null,
    file_number: r.file_number || null,
    receipts: Number(r.total_receipts) || 0,
    disbursements: Number(r.total_disbursements) || 0,
    pages: Number(r.document_type === 'Form 1' ? 0 : r.beginning_image_number ? 0 : 0) || 0,
  })).filter((r) => r.form);
}

/** What each form is FOR, so a reader can pick without guessing. */
const FORMS = {
  F1: 'registration — names the treasurer, the connected organisation, and '
    + 'for a joint fundraiser, THE PARTICIPANTS',
  F1M: 'notification of multicandidate status',
  F2: 'candidate statement of candidacy',
  F3: 'House/Senate campaign report',
  F3P: 'presidential campaign report',
  F3X: 'PAC and party report — the schedules, with full disbursement '
    + 'descriptions rather than the API\'s summary field',
  F24: '24/48-hour report of independent expenditures',
  F5: 'independent expenditures by a person or committee',
  F99: 'miscellaneous text — often the explanation of something odd',
};

function purposeOf(form) {
  return FORMS[String(form || '').toUpperCase().replace(/\s+/g, '')] || '';
}

/**
 * Amendments supersede. Group so the CURRENT document is obvious.
 *
 * Returns { current, superseded } — a filing that another filing amends is
 * superseded, and is kept rather than dropped because knowing a figure
 * CHANGED is often the finding.
 */
function supersession(rows) {
  const amended = new Set(rows.map((r) => r.amends).filter(Boolean).map(String));
  const current = [];
  const superseded = [];
  for (const r of rows) {
    if (r.file_number && amended.has(String(r.file_number))) superseded.push(r);
    else current.push(r);
  }
  return { current, superseded };
}

/** Group by form type, newest first inside each. */
function byForm(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.form || '(unknown)';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  for (const list of m.values()) {
    list.sort((a, b) => String(b.receipt_date).localeCompare(String(a.receipt_date)));
  }
  return [...m.entries()]
    .map(([form, list]) => ({ form, purpose: purposeOf(form), rows: list }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

/** Page through, same contract as the other modules. */
async function collect(fetchJson, urlFor, maxPages = 10) {
  const rows = [];
  let page = 1, truncated = false;
  for (;;) {
    const json = await fetchJson(urlFor(page));
    const batch = parseFilings(json);
    rows.push(...batch);
    const pg = json.pagination || {};
    const pages = pg.pages || 1;
    if (page >= pages || !batch.length) break;
    if (page >= maxPages) { truncated = true; break; }
    page += 1;
  }
  return { rows, pages: page, truncated };
}

module.exports = {
  API, filingsUrl, parseFilings, FORMS, purposeOf, supersession, byForm, collect,
};
