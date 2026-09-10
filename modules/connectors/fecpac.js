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
    // A CONDUIT is not a donor. Some committees collect contributions
    // EARMARKED by individuals for a named candidate and forward them; the
    // money is the individual's and the FEC attributes it to the individual.
    // On the conduit's own Schedule B those pass-throughs sit beside its
    // treasury spending, and summing the column reports someone else's giving
    // as the organisation's. memo_code marks entries that are not additive.
    memo_code: r.memo_code || '',
    memo_text: r.memo_text || '',
    image: r.image_number || '',
  }));
}

/**
 * Money the committee gave from its OWN funds, as distinct from money it
 * passed through on behalf of named individuals.
 *
 * A memo code, or memo text saying EARMARK, means the row is not the
 * committee's own contribution. Read `earmarked` before quoting a total.
 */
function isEarmarked(row) {
  if (String(row.memo_code || '').trim()) return true;
  return /earmark/i.test(String(row.memo_text || ''));
}

// Federal caps, for sanity only — never for arithmetic. A multicandidate PAC
// may give $5,000 per candidate per election, so a cycle with a primary and a
// general tops out near $10,000. A committee showing far more than that to one
// campaign is not breaking the law; it is almost certainly a conduit, and the
// column has been read as its own giving when it is not.
const PAC_PER_ELECTION_CAP_USD = 5000;
const IMPLAUSIBLE_PER_RECIPIENT_USD = PAC_PER_ELECTION_CAP_USD * 4;

/**
 * Does this total describe what its label says?
 *
 * Returns findings, not a boolean, because "this looks like a conduit" is a
 * thing to say out loud rather than a thing to silently correct.
 */
function auditContributions(contribs) {
  const findings = [];
  const byName = new Map();
  for (const c of contribs) {
    byName.set(c.recipient, (byName.get(c.recipient) || 0) + c.amount);
  }
  const over = [...byName.entries()]
    .filter(([, v]) => v > IMPLAUSIBLE_PER_RECIPIENT_USD)
    .sort((a, b) => b[1] - a[1]);
  if (over.length) {
    findings.push({
      kind: 'over_cap',
      count: over.length,
      worst: over[0],
      note: `${over.length} recipient(s) show more than $${IMPLAUSIBLE_PER_RECIPIENT_USD.toLocaleString('en-US')} `
          + `— above what a PAC may give from its own funds in a cycle. `
          + `That is the signature of a CONDUIT forwarding contributions `
          + `earmarked by individuals. The money is theirs, not the committee's.`,
    });
  }
  const marked = contribs.filter(isEarmarked).length;
  if (marked) {
    findings.push({
      kind: 'memo_rows',
      count: marked,
      note: `${marked} row(s) carry a memo code or earmark text and are not `
          + `additive with the rest.`,
    });
  }
  const avg = contribs.length
    ? contribs.reduce((a, c) => a + c.amount, 0) / contribs.length : 0;
  if (contribs.length > 200 && avg < PAC_PER_ELECTION_CAP_USD / 4) {
    findings.push({
      kind: 'small_average',
      count: contribs.length,
      note: `average payment $${Math.round(avg).toLocaleString('en-US')} across `
          + `${contribs.length} rows — the size of individual giving, not of a `
          + `PAC writing cheques from its treasury.`,
    });
  }
  return findings;
}

/**
 * Did the filter you asked for actually apply?
 *
 * An API that ignores a parameter it does not support returns everything,
 * successfully, and the caller cannot tell. `two_year_transaction_period`
 * covers the odd year and the even year, so any row outside that window means
 * the cycle filter did not take and the totals cover more than you asked for.
 */
function auditCycle(rows, cycle) {
  const lo = `${Number(cycle) - 1}-01-01`;
  const hi = `${Number(cycle)}-12-31`;
  const outside = rows.filter((r) => r.date && (r.date < lo || r.date > hi));
  if (!outside.length) return null;
  const dates = outside.map((r) => r.date).sort();
  return {
    kind: 'cycle_filter_ignored',
    count: outside.length,
    range: [dates[0], dates[dates.length - 1]],
    note: `${outside.length} of ${rows.length} row(s) fall outside cycle ${cycle} `
        + `(${dates[0]} to ${dates[dates.length - 1]}). The cycle filter did not `
        + `apply, so these totals cover more than the cycle asked for.`,
  };
}

/** Payments a committee coded as a contribution to another committee. */
const CONTRIBUTION_TYPES = new Set(['24K', '24E', '24C', '24F', '24Z']);

function isContribution(row) {
  if (CONTRIBUTION_TYPES.has(String(row.type).toUpperCase())) return true;
  // No type coded: fall back to having a recipient COMMITTEE, which rent and
  // payroll do not have. Reported as inferred, never as filed.
  return !row.type && Boolean(row.recipient_committee_id);
}

/**
 * EVERYTHING THE CONTRIBUTION FILTER DROPPED, ACCOUNTED FOR BY TYPE.
 *
 * A live run on a JOINT FUNDRAISING COMMITTEE read 390 Schedule B rows and
 * printed:
 *
 *     $0  in 0 DIRECT CONTRIBUTION(S) to other committees
 *
 * Which is true of contributions and false about the committee. A joint
 * fundraiser's whole purpose is to collect money and TRANSFER it to its
 * participants, and transfers are not coded as contributions — so the one
 * question worth asking of a JFC ("who are the participants?") was answered
 * with a zero, and 390 rows of real money vanished without a line of
 * explanation.
 *
 * A tool may filter. It may not read rows and then not say what they were.
 * This returns the residue grouped by the FEC's own disbursement type, so
 * whatever the money is, it is on screen and the operator can see the codes
 * rather than trusting mine.
 */
function residual(rows) {
  const byType = new Map();
  const byRecipient = new Map();
  let total = 0;
  for (const r of rows) {
    if (isEarmarked(r) || isContribution(r)) continue;
    const t = String(r.type || '').toUpperCase() || '(no type coded)';
    const cur = byType.get(t) || { type: t, amount: 0, rows: 0, example: '' };
    cur.amount += r.amount; cur.rows += 1;
    if (!cur.example && r.purpose) cur.example = r.purpose;
    byType.set(t, cur);
    total += r.amount;
    // A payment to another COMMITTEE is the row that names a participant,
    // an affiliate, or a vendor that is itself a committee. Payroll and rent
    // have no committee id, so this separates structure from housekeeping.
    if (r.recipient_committee_id) {
      // parseDisbursements emits `recipient`, not `recipient_name`. Reading
      // the raw API field here made every row fall back to its committee id,
      // so the participant list printed ids where names belong.
      const k = r.recipient || r.recipient_committee_id;
      const c = byRecipient.get(k)
        || { name: k, committee_id: r.recipient_committee_id, amount: 0, rows: 0 };
      c.amount += r.amount; c.rows += 1;
      byRecipient.set(k, c);
    }
  }
  return {
    total: Math.round(total * 100) / 100,
    rows: [...byType.values()].reduce((a, t) => a + t.rows, 0),
    by_type: [...byType.values()].sort((a, b) => b.amount - a.amount),
    to_committees: [...byRecipient.values()].sort((a, b) => b.amount - a.amount),
  };
}

/** Schedule E — independent expenditures. Not donations. */
function cycleWindow(cycle) {
  return [`${Number(cycle) - 1}-01-01`, `${Number(cycle)}-12-31`];
}

/**
 * Schedule E — independent expenditures. Not donations.
 *
 * two_year_transaction_period is a Schedule A/B field. Schedule E ignores it,
 * and an ignored filter is not an error: the request succeeds and returns
 * EVERY cycle. Asking for 2024 returned rows from 2022-04-22 to 2026-08-11 —
 * three cycles of spending under a heading that named one. min_date/max_date
 * are the fields this endpoint actually has.
 */
function independentUrl(committeeId, cycle, key, lastIndex, lastDate) {
  const [lo, hi] = cycleWindow(cycle);
  let u = `${API}/schedules/schedule_e/?api_key=${encodeURIComponent(key)}`
        + `&committee_id=${encodeURIComponent(committeeId)}`
        + `&min_date=${lo}&max_date=${hi}`
        + '&per_page=100&sort=-expenditure_date';
  if (lastIndex) u += `&last_index=${encodeURIComponent(lastIndex)}`;
  if (lastDate) u += `&last_expenditure_date=${encodeURIComponent(lastDate)}`;
  return u;
}

/**
 * Keep only rows inside the cycle, whatever the API did.
 *
 * A filter sent is not a filter applied, and the caller cannot tell the
 * difference from a successful response. So the window is enforced here too,
 * and what it removed is returned rather than quietly dropped — a total that
 * silently shrank is its own kind of wrong.
 */
function clampToCycle(rows, cycle) {
  const [lo, hi] = cycleWindow(cycle);
  const kept = [], dropped = [];
  for (const r of rows) {
    if (r.date && (r.date < lo || r.date > hi)) dropped.push(r);
    else kept.push(r);
  }
  return { kept, dropped };
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
/**
 * The committee's OWN giving, separated from what it merely forwarded.
 *
 * This is the number the earlier version could not produce. AIPAC PAC's 2022
 * Schedule B is 2,418 memo rows out of 2,482 — 97% of the money is
 * individuals' earmarked giving passing through, and a headline built on the
 * column total would have been describing other people's donations.
 */
function splitConduit(contribs) {
  const own = contribs.filter((c) => !isEarmarked(c));
  const forwarded = contribs.filter(isEarmarked);
  const sum = (rows) => rows.reduce((a, r) => a + r.amount, 0);
  return {
    own, forwarded,
    own_usd: sum(own), own_rows: own.length,
    forwarded_usd: sum(forwarded), forwarded_rows: forwarded.length,
    forwarded_share: contribs.length
      ? Math.round((forwarded.length / contribs.length) * 1000) / 10 : 0,
  };
}

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
async function collect(fetchJson, buildUrl, parse, cap = 25, pace = 0, onPage = null) {
  const rows = [];
  let lastIndex = null, lastDate = null, pages = 0, truncated = false;
  for (; pages < cap; pages++) {
    const json = await fetchJson(buildUrl(lastIndex, lastDate));
    const batch = parse(json);
    rows.push(...batch);
    // Twenty-five paced pages against a slow API is over a minute of silence,
    // and silence is indistinguishable from a hang. Say where it is.
    if (onPage) onPage(pages + 1, batch.length, rows.length, cap);
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
  isEarmarked, auditContributions, auditCycle,
  splitConduit, clampToCycle, cycleWindow,
  PAC_PER_ELECTION_CAP_USD, IMPLAUSIBLE_PER_RECIPIENT_USD,
  disbursementsUrl, parseDisbursements, isContribution, CONTRIBUTION_TYPES,
  independentUrl, parseIndependent,
  byRecipient, totals, collect, residual,
};
