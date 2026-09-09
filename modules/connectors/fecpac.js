#!/usr/bin/env node
'use strict';
/**
 * fecpac.js — what a political committee actually gave, and to whom.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE THREE THINGS PEOPLE ADD TOGETHER THAT ARE NOT THE SAME THING
 * ─────────────────────────────────────────────────────────────────────
 * Ask "how much did organisation X give to Senator Y" and three different
 * numbers are available, all public, all real, and all measuring different
 * events. Coverage of this beat routinely reports their sum as one figure.
 *
 *   1. DIRECT CONTRIBUTIONS  (FEC Schedule B, disbursements)
 *      X's connected PAC wrote a cheque to Y's campaign committee. Capped by
 *      law, itemised, dated, and attributable to X. This is the strong
 *      material — it is the closest thing to "X gave Y money" that exists.
 *
 *   2. INDEPENDENT EXPENDITURES  (FEC Schedule E)
 *      A super PAC spent money on advertising FOR or AGAINST a candidate.
 *      This is NOT a donation to anyone. It is uncapped, it may not legally
 *      be coordinated with the candidate, and a large share of it is spent
 *      AGAINST people — money that helps an opponent is not a gift to the
 *      target. Schedule E carries a support_oppose_indicator saying which,
 *      and any total that ignores that field is wrong in both directions.
 *
 *   3. BUNDLED OR AFFILIATED INDIVIDUAL GIVING
 *      Individuals who are members of, employed by, or identified with X,
 *      each giving in their own name. Aggregators publish these as an
 *      organisation total; the FEC does not, because the FEC records the
 *      individual. Attributing it to X is an INFERENCE about affiliation,
 *      not a filing. This tool does not compute it, and says so rather than
 *      leaving a gap you might fill from a worse source.
 *
 * So sums are refused across categories, the same way `connect graph`
 * refuses to add lobbying income to lobbying expenses. One number that is
 * bigger and false is worth less than three that are smaller and true.
 *
 * ─────────────────────────────────────────────────────────────────────
 * FARA IS A DIFFERENT REGISTER AND USUALLY THE WRONG ONE
 * ─────────────────────────────────────────────────────────────────────
 * FARA covers agents acting at the order, request or under the direction of
 * a FOREIGN PRINCIPAL. Domestic advocacy organisations — including ones
 * whose subject matter is another country's affairs — generally register
 * under the Lobbying Disclosure Act instead, and appear nowhere in FARA.
 *
 * That means a FARA search for a domestic advocacy group returns nothing,
 * and the nothing is a FACT, not a failed search. Whether a given
 * organisation ought to be a FARA registrant is a live public argument in
 * several cases and is not something a database resolves. Report the
 * absence as an absence.
 *
 * Use `sentinel connect senatelda` for LDA registrations, this for money,
 * and justice.gov/nsd-fara for the FARA register itself.
 *
 * ─────────────────────────────────────────────────────────────────────
 * COMMITTEE IDS ARE LOOKED UP, NEVER REMEMBERED
 * ─────────────────────────────────────────────────────────────────────
 * No committee ID is hardcoded anywhere in this file. An ID typed from
 * memory that happens to be wrong produces a complete, confident, entirely
 * false answer — filings for some other committee, correctly formatted.
 * Every run resolves the name against /v1/committees/ first and prints what
 * it found, so a wrong committee is visible before any money is counted.
 *
 * Organisations frequently run SEVERAL committees — a connected PAC and a
 * super PAC with different names and different rules. The lookup lists all
 * of them rather than picking one.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TESTABILITY
 * ─────────────────────────────────────────────────────────────────────
 * Every function here is pure except `collect`, which takes the fetcher as
 * an argument. The suite runs with a fake one and touches no network.
 */

const API = 'https://api.open.fec.gov/v1';

/** Committees are cheap to get wrong and expensive to get wrong quietly. */
function committeeSearchUrl(name, key) {
  return `${API}/committees/?api_key=${encodeURIComponent(key)}`
       + `&q=${encodeURIComponent(name)}&per_page=50&sort=-last_file_date`;
}

function parseCommittees(json) {
  return (json.results || []).map((r) => ({
    committee_id: r.committee_id || '',
    name: r.name || '',
    type: r.committee_type_full || r.committee_type || '',
    designation: r.designation_full || r.designation || '',
    party: r.party_full || r.party || '',
    first_file_date: r.first_file_date || '',
    last_file_date: r.last_file_date || '',
    url: r.committee_id ? `https://www.fec.gov/data/committee/${r.committee_id}/` : '',
  })).filter((r) => r.committee_id);
}

/**
 * Schedule B — money OUT of a committee.
 *
 * two_year_transaction_period is the FEC's own cycle field. Filtering by
 * date range instead is how you silently drop the amended filings that were
 * re-reported under a different date.
 */
function disbursementsUrl(committeeId, cycle, key, lastIndex, lastDate) {
  let u = `${API}/schedules/schedule_b/?api_key=${encodeURIComponent(key)}`
        + `&committee_id=${encodeURIComponent(committeeId)}`
        + `&two_year_transaction_period=${encodeURIComponent(cycle)}`
        + '&per_page=100&sort=-disbursement_date';
  // The FEC paginates schedules by keyset, not page number. Page numbers
  // silently repeat and drop rows past a few thousand records.
  if (lastIndex) u += `&last_index=${encodeURIComponent(lastIndex)}`;
  if (lastDate) u += `&last_disbursement_date=${encodeURIComponent(lastDate)}`;
  return u;
}

function parseDisbursements(json) {
  return (json.results || []).map((r) => ({
    recipient: r.recipient_name || '',
    recipient_committee_id: r.recipient_committee_id || '',
    amount: Number(r.disbursement_amount) || 0,
    date: (r.disbursement_date || '').slice(0, 10),
    purpose: r.disbursement_description || '',
    // The FEC's own coding of what the payment was. '24K' and similar
    // contribution codes are the ones that mean "gave to a candidate";
    // payroll and rent share this schedule and must not be counted as gifts.
    type: r.disbursement_type || '',
    image: r.image_number || '',
  }));
}

/** Payments a committee coded as a contribution to another committee. */
const CONTRIBUTION_TYPES = new Set(['24K', '24E', '24C', '24F', '24Z']);

function isContribution(row) {
  if (CONTRIBUTION_TYPES.has(String(row.type).toUpperCase())) return true;
  // No type coded: fall back to having a recipient COMMITTEE, which rent and
  // payroll do not have. Reported as inferred, never as filed.
  return !row.type && Boolean(row.recipient_committee_id);
}

/** Schedule E — independent expenditures. Not donations. */
function independentUrl(committeeId, cycle, key, lastIndex, lastDate) {
  let u = `${API}/schedules/schedule_e/?api_key=${encodeURIComponent(key)}`
        + `&committee_id=${encodeURIComponent(committeeId)}`
        + `&two_year_transaction_period=${encodeURIComponent(cycle)}`
        + '&per_page=100&sort=-expenditure_date';
  if (lastIndex) u += `&last_index=${encodeURIComponent(lastIndex)}`;
  if (lastDate) u += `&last_expenditure_date=${encodeURIComponent(lastDate)}`;
  return u;
}

function parseIndependent(json) {
  return (json.results || []).map((r) => ({
    candidate: r.candidate_name || '',
    candidate_id: r.candidate_id || '',
    office: r.candidate_office_full || r.candidate_office || '',
    state: r.candidate_office_state || '',
    amount: Number(r.expenditure_amount) || 0,
    date: (r.expenditure_date || '').slice(0, 10),
    // S = for the candidate, O = against. The whole meaning of the row.
    stance: (r.support_oppose_indicator || '').toUpperCase(),
    purpose: r.expenditure_description || '',
    image: r.image_number || '',
  }));
}

/**
 * Group by recipient WITHOUT merging the categories.
 *
 * Returns support and oppose separately for independent expenditures,
 * because a single "spent on this race" number hides which way it was
 * pointed, and that is the only thing the row actually establishes.
 */
function byRecipient(contribs, independents) {
  const out = new Map();
  const get = (name) => {
    if (!out.has(name)) {
      out.set(name, {
        name, contributed: 0, contributions: 0,
        ie_support: 0, ie_oppose: 0, ie_rows: 0,
      });
    }
    return out.get(name);
  };
  for (const c of contribs) {
    const r = get(c.recipient || '(unnamed recipient)');
    r.contributed += c.amount;
    r.contributions += 1;
  }
  for (const e of independents) {
    const r = get(e.candidate || '(unnamed candidate)');
    if (e.stance === 'O') r.ie_oppose += e.amount;
    else r.ie_support += e.amount;
    r.ie_rows += 1;
  }
  return [...out.values()].sort(
    (a, b) => (b.contributed + b.ie_support + b.ie_oppose)
            - (a.contributed + a.ie_support + a.ie_oppose));
}

/** Totals, kept apart on purpose. There is no grand total and there should not be. */
function totals(contribs, independents) {
  const sum = (rows, f = (r) => r.amount) => rows.reduce((a, r) => a + f(r), 0);
  const support = independents.filter((e) => e.stance !== 'O');
  const oppose = independents.filter((e) => e.stance === 'O');
  return {
    contributions_usd: sum(contribs),
    contributions_rows: contribs.length,
    ie_support_usd: sum(support),
    ie_support_rows: support.length,
    ie_oppose_usd: sum(oppose),
    ie_oppose_rows: oppose.length,
    _no_grand_total: 'A contribution and an independent expenditure are '
      + 'different events. They are not added here, and adding them '
      + 'downstream produces a number that describes nothing.',
  };
}

/**
 * Walk a schedule with keyset pagination.
 *
 * `fetchJson(url)` is injected so the suite runs offline. `cap` bounds the
 * number of requests: an unbounded loop against a keyset API that stops
 * returning a cursor is an infinite loop against somebody else's server.
 */
async function collect(fetchJson, buildUrl, parse, cap = 25, pace = 0) {
  const rows = [];
  let lastIndex = null, lastDate = null, pages = 0, truncated = false;
  for (; pages < cap; pages++) {
    const json = await fetchJson(buildUrl(lastIndex, lastDate));
    const batch = parse(json);
    rows.push(...batch);
    const pg = json.pagination || {};
    const li = pg.last_indexes || {};
    const nextIndex = li.last_index || null;
    const nextDate = li.last_disbursement_date || li.last_expenditure_date || null;
    if (!batch.length || !nextIndex || nextIndex === lastIndex) break;
    lastIndex = nextIndex;
    lastDate = nextDate;
    if (pace) await new Promise((r) => setTimeout(r, pace));
  }
  if (pages >= cap) truncated = true;
  return { rows, pages: pages + 1, truncated };
}

module.exports = {
  API, committeeSearchUrl, parseCommittees,
  disbursementsUrl, parseDisbursements, isContribution, CONTRIBUTION_TYPES,
  independentUrl, parseIndependent,
  byRecipient, totals, collect,
};
