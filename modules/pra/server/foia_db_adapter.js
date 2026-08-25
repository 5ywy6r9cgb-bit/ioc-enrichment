'use strict';
/**
 * server/foia_db_adapter.js — the requests table, in the shape the tracker reads.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, WRITTEN DOWN BECAUSE IT ALMOST COST SOMETHING
 *
 * `foia.js --db` shipped with a normalise() that mapped
 * `submitted_on || filed_date || filed_on`. The requests table calls that
 * column `submitted_at`. None of the three names matched, so every request
 * loaded from the database arrived with no submission date, and the tracker
 * correctly concluded there was no clock to run and returned `no_action`.
 *
 * The output was: "Nothing needs you right now. 1 request(s) tracked."
 *
 * The request in question had been submitted 22 business days earlier.
 *
 * That is the worst possible failure for this system. It did not crash, it
 * did not warn, and it produced a calm, plausible, green sentence that said
 * the opposite of the truth. A tracker that reports a quiet morning it has
 * not verified is worse than no tracker, because it is believed.
 *
 * So this adapter does not silently produce a request with no clock. If a row
 * carries a submission timestamp under ANY recognised column and this code
 * fails to map it, `map()` throws. A loud failure at 3am is recoverable; a
 * false green is not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT MAPPED
 *
 * `appeal_filed_at` is NOT `mandamus_filed_on`. An administrative appeal is
 * not a mandamus action, and R.C. 149.43(C)(2) damages accrue from the filing
 * of a mandamus action. Mapping one onto the other would reproduce, through
 * the adapter, the precise defect foia_tracker.js was written to fix: a
 * damages figure for a case nobody filed. Migration 0007 adds a real
 * `mandamus_filed_on` column; until an operator fills it in, the answer is
 * "not recorded", and the tracker says so.
 *
 * `submission_method` is free text with no vocabulary — 'certified',
 * 'certified mail', and 'USPS certified' are three values, none testable.
 * Migration 0007 adds a CHECK-constrained `delivery_method`. This adapter
 * reads the constrained column and, for the legacy free-text one, maps only
 * spellings that are unambiguous. Anything else becomes null: not recorded is
 * a true statement, and a guess about the transmission predicate is not.
 */

const clock = require('./deadline_engine.js');

class AdapterError extends Error {}

/** Column names that mean "when this request went out." */
const SUBMITTED_COLUMNS = [
  'submitted_on', 'submitted_at', 'filed_date', 'filed_on', 'sent_at',
];

/**
 * Free-text submission_method spellings safe to map. Kept short on purpose:
 * every entry here is a claim that a string definitely means a statutory
 * channel, and a wrong entry silently switches damages on.
 */
const METHOD_SYNONYMS = new Map([
  ['certified_mail', 'certified_mail'],
  ['certified mail', 'certified_mail'],
  ['certified', 'certified_mail'],
  ['usps certified', 'certified_mail'],
  ['hand_delivery', 'hand_delivery'],
  ['hand delivery', 'hand_delivery'],
  ['hand-delivered', 'hand_delivery'],
  ['in_person', 'in_person'],
  ['in person', 'in_person'],
  ['electronic', 'electronic'],
  ['email', 'electronic'],
  ['e-mail', 'electronic'],
  ['web_form', 'web_form'],
  ['web form', 'web_form'],
  ['portal', 'web_form'],
  ['phone', 'phone'],
  ['mail', 'mail'],
]);

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  // Timestamps arrive as ISO; dates as YYYY-MM-DD. Both truncate the same way.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function mapDelivery(row) {
  // The constrained column wins: it is the one the database validates.
  if (row.delivery_method) return row.delivery_method;
  const raw = row.submission_method;
  if (!raw) return null;
  const hit = METHOD_SYNONYMS.get(String(raw).trim().toLowerCase());
  // An unrecognised spelling is NOT a failure — it is an unrecorded fact.
  // Guessing here is the only way this function could do harm.
  return hit || null;
}

/**
 * One requests row -> the shape foia_tracker.evaluate() reads.
 *
 * @param {object} row       a row from the requests table
 * @param {object} extras    { agency_name, correspondence }
 * @throws {AdapterError}    if a submission timestamp is present but unmapped
 */
function map(row, extras = {}) {
  if (!row || !row.request_id) {
    throw new AdapterError('row has no request_id');
  }

  let submitted = null;
  for (const col of SUBMITTED_COLUMNS) {
    if (row[col]) { submitted = toDate(row[col]); break; }
  }

  // The guard. If any recognised submission column held a value and we still
  // have no date, the mapping is broken and must not be papered over with a
  // request that quietly has no clock.
  if (!submitted) {
    const present = SUBMITTED_COLUMNS.filter((c) => row[c]);
    if (present.length) {
      throw new AdapterError(
        `${row.request_id}: ${present.join(', ')} holds a value that did not `
        + `parse to a date. Refusing to return a request with no clock — that `
        + `reads as "nothing needs you" and is believed.`);
    }
  }

  return {
    request_id: row.request_id,
    agency_name: extras.agency_name || row.agency_name || row.agency_id || null,
    submitted_on: submitted,
    status: String(row.status || 'submitted').toLowerCase(),
    jurisdiction_scope: row.jurisdiction_scope || 'OH',

    delivery_method: mapDelivery(row),

    // Real column from migration 0007. appeal_filed_at is NOT a substitute
    // and is deliberately absent from this object.
    mandamus_filed_on: toDate(row.mandamus_filed_on),

    denial_basis: row.exemption_cited || row.denial_reason || null,
    fee_quoted_usd: row.fee_quoted == null ? null : Number(row.fee_quoted),
    agency_stated_due_on: toDate(row.agency_stated_due_on),
    description: row.subject || row.scope_text || null,

    correspondence: extras.correspondence || [],

    // Kept so `foia show` can display them; the tracker ignores them.
    _appeal_filed_at: toDate(row.appeal_filed_at),
    _investigation_id: row.investigation_id || null,
  };
}

/**
 * Load every request, with agency names and correspondence attached.
 * Two extra queries rather than a three-way join: the join returns one row per
 * followup and the de-duplication has to happen in JS anyway, so the join buys
 * nothing but a chance to get the grouping wrong.
 */
async function loadAll(db, opts = {}) {
  const reqs = await db.query(
    `SELECT r.*, a.name AS agency_name
       FROM requests r
       LEFT JOIN agencies a ON a.agency_id = r.agency_id
      ORDER BY r.submitted_at NULLS LAST`);

  const ids = reqs.rows.map((r) => r.request_id);
  const byRequest = new Map();
  if (ids.length) {
    const f = await db.query(
      `SELECT request_id, direction, occurred_at, channel, summary
         FROM followups
        WHERE request_id = ANY($1::text[])
        ORDER BY occurred_at`, [ids]);
    for (const row of f.rows) {
      if (!byRequest.has(row.request_id)) byRequest.set(row.request_id, []);
      byRequest.get(row.request_id).push({
        direction: row.direction,
        occurred_at: toDate(row.occurred_at),
        channel: row.channel,
        note: row.summary,
      });
    }
  }

  const out = [];
  const errors = [];
  for (const row of reqs.rows) {
    try {
      out.push(map(row, {
        agency_name: row.agency_name,
        correspondence: byRequest.get(row.request_id) || [],
      }));
    } catch (e) {
      // One unmappable row must not hide the other forty. Collect and report.
      errors.push(e.message);
    }
  }
  if (errors.length && !opts.tolerant) {
    throw new AdapterError(
      `${errors.length} request(s) could not be mapped:\n  - ` + errors.join('\n  - '));
  }
  return { requests: out, errors };
}

module.exports = {
  map, loadAll, mapDelivery, toDate,
  SUBMITTED_COLUMNS, METHOD_SYNONYMS, AdapterError,
};
