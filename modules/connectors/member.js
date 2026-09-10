#!/usr/bin/env node
'use strict';
/**
 * member.js — one politician, and EVERY direction outside money moves.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE VIEW NOBODY BUILDS
 * ─────────────────────────────────────────────────────────────────────
 * Campaign finance is reported one direction at a time. "Who gave to this
 * member" is one screen. "Who spent for them" is another. "Who spent against
 * them" is a third, and it is usually not shown at all because it does not
 * fit the word *donation*.
 *
 * They are three different flows aimed at ONE PERSON, and the interesting
 * facts live in the relationships BETWEEN them:
 *
 *   1. TO THEM        committee contributions into their campaign account
 *   2. FOR THEM       independent expenditures supporting them
 *   3. AGAINST THEM   independent expenditures attacking them
 *
 * A member can be simultaneously the beneficiary of one organisation's
 * network and the sole target of another's. That is not an anomaly — it is
 * the ordinary condition of a contested seat, and no standard tool shows it
 * on one page.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE FOUR NUMBERS THAT ONLY EXIST HERE
 * ─────────────────────────────────────────────────────────────────────
 *   CONTESTED RATIO   for-spending vs against-spending on this candidate.
 *                     Near 1.0 means a genuinely fought seat. Far from it
 *                     means one side is uncontested.
 *
 *   OUTSIDE PRESSURE  independent spending as a multiple of what the
 *                     campaign itself received from committees. Above 1
 *                     means more money moved AROUND them than THROUGH them
 *                     — and none of it under their control.
 *
 *   TWO-COLUMN        organisations appearing in more than one direction.
 *                     A committee that gives to a member AND spends against
 *                     them is a documented fact worth an explanation.
 *
 *   SOLE TARGET       a committee whose entire expenditure names one
 *                     candidate. Single-purpose money, and the purpose is
 *                     on the filing.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IS STILL REFUSED
 * ─────────────────────────────────────────────────────────────────────
 * The three flows are never summed. Money spent against someone is not
 * money they received, and adding it to what they raised produces a figure
 * describing nothing. Conduit rows are separated from a committee's own
 * giving, as everywhere else. And a single-purpose committee is a fact
 * about a filing, not evidence of what prompted it.
 */

const API = 'https://api.open.fec.gov/v1';

function cycleWindow(cycle) {
  return [`${Number(cycle) - 1}-01-01`, `${Number(cycle)}-12-31`];
}

/** Find the person. Names are ambiguous; the id is not. */
function candidateSearchUrl(name, key) {
  return `${API}/candidates/search/?api_key=${encodeURIComponent(key)}`
       + `&q=${encodeURIComponent(name)}&per_page=20&sort=-first_file_date`;
}

/**
 * The same lookup, BY ID.
 *
 * `--candidate S6OH00163` used to skip the register entirely and synthesise
 * a record with an empty committee id. The command then printed
 *
 *     no principal committee on file — money IN cannot be read.
 *
 * which is a statement about the FEC's register and was not true. It was a
 * statement about having used the flag. Worse, the disambiguation guard
 * RECOMMENDS the flag, so following the tool's own advice silently disabled
 * one of the three directions the command exists to reconcile — and the
 * header printed the id twice because there was no name to print either.
 *
 * /candidates/search/ carries principal_committees; the plain /candidates/
 * does not. Same trap as the delegation sweep.
 */
function candidateByIdUrl(candidateId, key) {
  return `${API}/candidates/search/?api_key=${encodeURIComponent(key)}`
       + `&candidate_id=${encodeURIComponent(candidateId)}&per_page=1`;
}

/**
 * Fallback when the candidate record carries no committee.
 *
 * /candidate/{id}/committees/ does not exist and answers 404 — the link is
 * a FILTER on /committees/. designation=P is the principal campaign
 * committee, as opposed to a leadership PAC or a joint fundraiser.
 */
function candidateCommitteesUrl(candidateId, cycle, key) {
  return `${API}/committees/?api_key=${encodeURIComponent(key)}`
       + `&candidate_id=${encodeURIComponent(candidateId)}`
       + `&cycle=${encodeURIComponent(cycle)}`
       + '&designation=P&per_page=10&sort=-last_file_date';
}

function parseCandidateCommittees(json) {
  return (json.results || [])
    .map((r) => ({
      committee_id: r.committee_id || '',
      name: r.name || '',
      last_file_date: r.last_file_date || '',
    }))
    .filter((c) => c.committee_id)
    .sort((a, b) => String(b.last_file_date).localeCompare(String(a.last_file_date)));
}

function parseCandidateMatches(json) {
  return (json.results || []).map((r) => {
    const pcs = Array.isArray(r.principal_committees) ? r.principal_committees : [];
    const live = [...pcs].sort(
      (a, b) => String(b.last_file_date || '').localeCompare(String(a.last_file_date || '')));
    return {
      candidate_id: r.candidate_id || '',
      name: r.name || '',
      party: r.party || '',
      office: r.office_full || r.office || '',
      state: r.state || '',
      district: r.district || '',
      incumbent: r.incumbent_challenge_full || '',
      committee_id: live.length ? live[0].committee_id || '' : '',
      committee_name: live.length ? live[0].name || '' : '',
      cycles: Array.isArray(r.election_years) ? r.election_years : [],
    };
  }).filter((c) => c.candidate_id);
}

// ---------------------------------------------------------------- direction 1
/** Schedule A — committee money INTO their campaign account. */
function contributionsInUrl(committeeId, cycle, key, lastIndex, lastDate) {
  let u = `${API}/schedules/schedule_a/?api_key=${encodeURIComponent(key)}`
        + `&committee_id=${encodeURIComponent(committeeId)}`
        + `&two_year_transaction_period=${encodeURIComponent(cycle)}`
        + '&is_individual=false&per_page=100&sort=-contribution_receipt_date';
  if (lastIndex) u += `&last_index=${encodeURIComponent(lastIndex)}`;
  if (lastDate) u += `&last_contribution_receipt_date=${encodeURIComponent(lastDate)}`;
  return u;
}

function parseContributionsIn(json) {
  return (json.results || []).map((r) => ({
    from: r.contributor_name || '',
    from_committee_id: r.contributor_id || '',
    amount: Number(r.contribution_receipt_amount) || 0,
    date: (r.contribution_receipt_date || '').slice(0, 10),
    memo_code: r.memo_code || '',
    memo_text: r.memo_text || '',
  }));
}

// -------------------------------------------------------------- directions 2+3
/** Schedule E — money spent FOR or AGAINST this candidate, by anyone. */
function independentUrl(candidateId, cycle, key, lastIndex, lastDate) {
  const [lo, hi] = cycleWindow(cycle);
  let u = `${API}/schedules/schedule_e/?api_key=${encodeURIComponent(key)}`
        + `&candidate_id=${encodeURIComponent(candidateId)}`
        + `&min_date=${lo}&max_date=${hi}`
        + '&per_page=100&sort=-expenditure_date';
  if (lastIndex) u += `&last_index=${encodeURIComponent(lastIndex)}`;
  if (lastDate) u += `&last_expenditure_date=${encodeURIComponent(lastDate)}`;
  return u;
}

function parseIndependent(json) {
  return (json.results || []).map((r) => ({
    by: r.committee_name || (r.committee && r.committee.name) || '',
    by_committee_id: r.committee_id || '',
    amount: Number(r.expenditure_amount) || 0,
    date: (r.expenditure_date || '').slice(0, 10),
    stance: (r.support_oppose_indicator || '').toUpperCase(),
    purpose: r.expenditure_description || '',
  }));
}

function isEarmarked(row) {
  if (String(row.memo_code || '').trim()) return true;
  return /earmark/i.test(String(row.memo_text || ''));
}

function clampToCycle(rows, cycle) {
  const [lo, hi] = cycleWindow(cycle);
  const kept = [], dropped = [];
  for (const r of rows) {
    if (r.date && (r.date < lo || r.date > hi)) dropped.push(r);
    else kept.push(r);
  }
  return { kept, dropped };
}

/**
 * Every organisation touching this member, with each direction kept apart.
 *
 * The map is keyed by committee id where one exists and by name otherwise,
 * because a name is not an identity — two committees can share a name and
 * one committee can file under several spellings.
 */
function byOrganisation(contribsIn, independents) {
  const out = new Map();
  const key = (id, name) => (id ? `id:${id}` : `name:${String(name).toUpperCase().trim()}`);
  const get = (id, name) => {
    const k = key(id, name);
    if (!out.has(k)) {
      out.set(k, { key: k, committee_id: id || '', name: name || '(unnamed)',
        gave: 0, gave_rows: 0, forwarded: 0, forwarded_rows: 0,
        spent_for: 0, spent_for_rows: 0, spent_against: 0, spent_against_rows: 0 });
    }
    return out.get(k);
  };
  for (const c of contribsIn) {
    const o = get(c.from_committee_id, c.from);
    if (isEarmarked(c)) { o.forwarded += c.amount; o.forwarded_rows += 1; }
    else { o.gave += c.amount; o.gave_rows += 1; }
  }
  for (const e of independents) {
    const o = get(e.by_committee_id, e.by);
    if (e.stance === 'O') { o.spent_against += e.amount; o.spent_against_rows += 1; }
    else { o.spent_for += e.amount; o.spent_for_rows += 1; }
  }
  return [...out.values()].sort(
    (a, b) => (b.gave + b.forwarded + b.spent_for + b.spent_against)
            - (a.gave + a.forwarded + a.spent_for + a.spent_against));
}

/** Organisations appearing in more than one direction. */
function twoColumn(orgs) {
  return orgs.filter((o) => {
    const dirs = [o.gave + o.forwarded, o.spent_for, o.spent_against]
      .filter((v) => v > 0).length;
    return dirs > 1;
  });
}

const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 100) / 100 : null);

function summarise(contribsIn, independents, orgs) {
  const sum = (rows) => rows.reduce((a, r) => a + r.amount, 0);
  const own = contribsIn.filter((c) => !isEarmarked(c));
  const fwd = contribsIn.filter(isEarmarked);
  const forRows = independents.filter((e) => e.stance !== 'O');
  const againstRows = independents.filter((e) => e.stance === 'O');
  const to = sum(own) + sum(fwd);
  const outside = sum(forRows) + sum(againstRows);
  return {
    to_them_own: sum(own), to_them_own_rows: own.length,
    to_them_forwarded: sum(fwd), to_them_forwarded_rows: fwd.length,
    for_them: sum(forRows), for_them_rows: forRows.length,
    against_them: sum(againstRows), against_them_rows: againstRows.length,
    // Near 1.0 is a fought seat. Far from it means one side is uncontested.
    contested_ratio: ratio(sum(forRows), sum(againstRows)),
    // Above 1 means more money moved AROUND them than THROUGH them.
    outside_pressure: ratio(outside, to),
    organisations: orgs.length,
    two_column: twoColumn(orgs).length,
    _no_grand_total: 'Money spent against someone is not money they received. '
      + 'These four figures are never summed.',
  };
}

/**
 * A committee whose entire independent spending in this window names this
 * one candidate. Single-purpose money — a fact about the filing, and not
 * evidence of what prompted it.
 */
function soleTargets(independents, allByCommittee) {
  const here = new Map();
  for (const e of independents) {
    const k = e.by_committee_id || e.by;
    here.set(k, (here.get(k) || 0) + e.amount);
  }
  const out = [];
  for (const [k, spentHere] of here) {
    const total = allByCommittee ? allByCommittee.get(k) : null;
    if (total && Math.abs(total - spentHere) < 0.01) {
      out.push({ committee: k, amount: spentHere });
    }
  }
  return out;
}

async function collect(fetchJson, buildUrl, parse, cap = 25, pace = 0, onPage = null) {
  const rows = [];
  let lastIndex = null, lastDate = null, pages = 0, truncated = false;
  for (; pages < cap; pages++) {
    const json = await fetchJson(buildUrl(lastIndex, lastDate));
    const batch = parse(json);
    rows.push(...batch);
    if (onPage) onPage(pages + 1, batch.length, rows.length, cap);
    const li = (json.pagination || {}).last_indexes || {};
    const nextIndex = li.last_index || null;
    const nextDate = li.last_contribution_receipt_date || li.last_expenditure_date || null;
    if (!batch.length || !nextIndex || nextIndex === lastIndex) break;
    lastIndex = nextIndex; lastDate = nextDate;
    if (pace) await new Promise((r) => setTimeout(r, pace));
  }
  if (pages >= cap) truncated = true;
  return { rows, pages: pages + 1, truncated };
}

module.exports = {
  API, cycleWindow, candidateSearchUrl, parseCandidateMatches,
  candidateByIdUrl, candidateCommitteesUrl, parseCandidateCommittees,
  contributionsInUrl, parseContributionsIn,
  independentUrl, parseIndependent,
  isEarmarked, clampToCycle, byOrganisation, twoColumn, soleTargets,
  summarise, ratio, collect,
};
