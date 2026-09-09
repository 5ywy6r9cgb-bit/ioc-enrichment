#!/usr/bin/env node
'use strict';
/**
 * delegation.js — every federal member from one state, and their money.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THIS ANSWERS
 * ─────────────────────────────────────────────────────────────────────
 * Not "did organisation X give to member Y" — that question starts from the
 * organisation and finds one number, which is always small and always
 * ambiguous. This starts from the OFFICE and asks, for every member of a
 * state's federal delegation at once:
 *
 *     how much came in, how much went out, what share of it came from
 *     political committees rather than from people, and how much is left
 *
 * The share is the interesting number and it is the one nobody publishes,
 * because it requires having the whole delegation side by side. A member
 * taking 60% of receipts from PACs and one taking 6% are running different
 * operations, and neither figure means anything alone.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE COMMITTEE IS NOT THE CANDIDATE
 * ─────────────────────────────────────────────────────────────────────
 * Money is raised and spent by an authorised COMMITTEE, and a candidate may
 * have several — a principal campaign committee, a leadership PAC, a joint
 * fundraising committee. They file separately and mean different things.
 * A leadership PAC in particular is not a campaign account: it is money the
 * member raises to give to OTHER members, and folding it into "what they
 * raised" describes something else entirely.
 *
 * So only the PRINCIPAL CAMPAIGN COMMITTEE is totalled here, it is named in
 * the output, and other committees are counted and reported as not included.
 *
 * ─────────────────────────────────────────────────────────────────────
 * RECEIPTS ARE NOT DONATIONS
 * ─────────────────────────────────────────────────────────────────────
 * `receipts` includes transfers from other committees the candidate
 * controls, loans (including the candidate's own money), and refunds
 * received. Dividing PAC money by receipts and calling it "the share of
 * their donations from PACs" is wrong whenever a member has lent their
 * campaign money — which is most self-funders.
 *
 * The denominator here is therefore stated every time, and where the FEC
 * reports loans or transfers they are shown beside the share so the reader
 * can see what is inflating it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TESTABILITY
 * ─────────────────────────────────────────────────────────────────────
 * Every function is pure. The runner takes its fetcher as an argument.
 */

const API = 'https://api.open.fec.gov/v1';

/** Offices the FEC recognises. P is president; a state sweep wants H and S. */
const OFFICES = { H: 'House', S: 'Senate', P: 'President' };

/**
 * /candidates/SEARCH/, not /candidates/.
 *
 * They look interchangeable and are not: only the search endpoint returns
 * `principal_committees`. Against the plain one the field is simply absent,
 * every candidate resolves to an empty committee id, no totals are ever
 * fetched, and the sweep reports "no committee totals filed" for an entire
 * delegation — 115 members of one, all wrong, with nothing in the output
 * distinguishing that from a state where nobody has filed.
 */
function candidatesUrl(state, office, cycle, key, page = 1) {
  return `${API}/candidates/search/?api_key=${encodeURIComponent(key)}`
       + `&state=${encodeURIComponent(String(state).toUpperCase())}`
       + `&office=${encodeURIComponent(String(office).toUpperCase())}`
       + `&election_year=${encodeURIComponent(cycle)}`
       + `&per_page=100&page=${page}&sort=district`;
}

/** Fallback when the roster carries no committee: ask for the candidate's own. */
function candidateCommitteesUrl(candidateId, cycle, key) {
  return `${API}/candidate/${encodeURIComponent(candidateId)}/committees/`
       + `?api_key=${encodeURIComponent(key)}&cycle=${encodeURIComponent(cycle)}`
       + '&designation=P&per_page=10';
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

/** Is this row a sitting member rather than someone who filed to run? */
function isIncumbent(c) {
  return /incumbent/i.test(String(c.incumbent || ''));
}

/**
 * A candidate, and the one committee whose totals mean "their campaign".
 *
 * principal_committees is an array because a candidate can change committees
 * across cycles. The one that matters is the most recently active, so they
 * are sorted rather than taking [0] — which on a long-serving member returns
 * a committee that stopped filing in 2014.
 */
function parseCandidates(json) {
  return (json.results || []).map((r) => {
    const pcs = Array.isArray(r.principal_committees) ? r.principal_committees : [];
    const sorted = [...pcs].sort(
      (a, b) => String(b.last_file_date || '').localeCompare(String(a.last_file_date || '')));
    return {
      candidate_id: r.candidate_id || '',
      name: r.name || '',
      party: r.party || '',
      party_full: r.party_full || '',
      office: r.office || '',
      state: r.state || '',
      district: r.district || '',
      incumbent: (r.incumbent_challenge_full || r.incumbent_challenge || '') || '',
      committee_id: sorted.length ? (sorted[0].committee_id || '') : '',
      committee_name: sorted.length ? (sorted[0].name || '') : '',
      other_committees: Math.max(0, pcs.length - 1),
      url: r.candidate_id ? `https://www.fec.gov/data/candidate/${r.candidate_id}/` : '',
    };
  }).filter((c) => c.candidate_id);
}

function totalsUrl(committeeId, cycle, key) {
  return `${API}/committee/${encodeURIComponent(committeeId)}/totals/`
       + `?api_key=${encodeURIComponent(key)}&cycle=${encodeURIComponent(cycle)}&per_page=1`;
}

/** The money, as the committee itself reported it. No arithmetic yet. */
function parseTotals(json) {
  const r = (json.results || [])[0];
  if (!r) return null;
  const n = (v) => (Number(v) || 0);
  return {
    cycle: r.cycle || null,
    coverage_end_date: (r.coverage_end_date || '').slice(0, 10),
    receipts: n(r.receipts),
    disbursements: n(r.disbursements),
    // people
    individual_contributions: n(r.individual_contributions),
    individual_itemized: n(r.individual_itemized_contributions),
    individual_unitemized: n(r.individual_unitemized_contributions),
    // committees — this is the PAC money
    pac_contributions: n(r.other_political_committee_contributions),
    party_contributions: n(r.political_party_committee_contributions),
    // the things that make `receipts` a bad denominator
    transfers_in: n(r.transfers_from_other_authorized_committee),
    loans: n(r.loans) + n(r.loans_made_by_candidate),
    // what is left
    cash_on_hand: n(r.last_cash_on_hand_end_period),
    debts: n(r.last_debts_owed_by_committee),
    operating_expenditures: n(r.operating_expenditures),
    contributions_to_other_committees: n(r.contributions_to_other_committees),
  };
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/**
 * Derived shares, each with its denominator named.
 *
 * `contributed` — individuals plus committees plus party — is the honest
 * denominator for "where their money came from". `receipts` is the honest
 * denominator for "what came in", and the two differ by exactly the loans
 * and transfers that make the first question ambiguous.
 */
function auditMember(t) {
  if (!t) return null;
  const contributed = t.individual_contributions + t.pac_contributions
                    + t.party_contributions;
  const flags = [];
  if (t.loans > 0) {
    flags.push({ kind: 'loans', amount: t.loans,
      note: 'carries loans — receipts include money lent, not given' });
  }
  if (t.transfers_in > 0) {
    flags.push({ kind: 'transfers', amount: t.transfers_in,
      note: 'received transfers from another authorised committee' });
  }
  if (contributed <= 0) {
    flags.push({ kind: 'no_contributions',
      note: 'reported no contributions this cycle — a committee can exist and not raise' });
  }
  return {
    contributed,
    pac_share_of_contributed: pct(t.pac_contributions, contributed),
    individual_share_of_contributed: pct(t.individual_contributions, contributed),
    party_share_of_contributed: pct(t.party_contributions, contributed),
    unitemized_share_of_individual: pct(t.individual_unitemized, t.individual_contributions),
    spent_share_of_raised: pct(t.disbursements, t.receipts),
    to_other_committees: t.contributions_to_other_committees,
    flags,
  };
}

/** Sort for reading: incumbents first, then by PAC share, then by name. */
function rank(rows) {
  return [...rows].sort((a, b) => {
    const ai = /incumbent/i.test(a.candidate.incumbent) ? 0 : 1;
    const bi = /incumbent/i.test(b.candidate.incumbent) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    const ap = a.audit && a.audit.pac_share_of_contributed;
    const bp = b.audit && b.audit.pac_share_of_contributed;
    if (ap === null || ap === undefined) return 1;
    if (bp === null || bp === undefined) return -1;
    if (bp !== ap) return bp - ap;
    return a.candidate.name.localeCompare(b.candidate.name);
  });
}

/** Delegation-wide figures. Sums only what is the same kind of thing. */
function summarise(rows) {
  const withTotals = rows.filter((r) => r.totals);
  const sum = (f) => withTotals.reduce((a, r) => a + f(r), 0);
  const contributed = sum((r) => r.audit.contributed);
  return {
    members: rows.length,
    with_totals: withTotals.length,
    missing_totals: rows.length - withTotals.length,
    receipts: sum((r) => r.totals.receipts),
    disbursements: sum((r) => r.totals.disbursements),
    contributed,
    pac_contributions: sum((r) => r.totals.pac_contributions),
    pac_share_of_contributed: pct(sum((r) => r.totals.pac_contributions), contributed),
    cash_on_hand: sum((r) => r.totals.cash_on_hand),
    _note: 'Delegation totals are the sum of individual committees. They are '
         + 'not a fund and nobody controls them jointly.',
  };
}

/**
 * Sweep a state: every candidate for the named offices, with their money.
 *
 * `fetchJson` is injected. `onStep` reports progress because seventeen
 * members at two calls each is a minute of silence otherwise.
 */
async function sweep(fetchJson, { state, offices = ['S', 'H'], cycle, key,
                                  pace = 0, onStep = null,
                                  incumbentsOnly = true }) {
  const candidates = [];
  for (const office of offices) {
    for (let page = 1; page <= 5; page++) {
      const json = await fetchJson(candidatesUrl(state, office, cycle, key, page));
      const batch = parseCandidates(json);
      candidates.push(...batch);
      if (onStep) onStep('candidates', office, candidates.length);
      const pg = json.pagination || {};
      if (!batch.length || page >= (pg.pages || 1)) break;
      if (pace) await new Promise((r) => setTimeout(r, pace));
    }
  }

  // "My legislators" means the people holding the seats. A cycle roster is
  // everyone who filed — 115 for one state, most of them paper candidates —
  // and burying seventeen members in that is the same failure as sorting a
  // state's Senate history by who filed most recently.
  const all = candidates.length;
  const filtered = incumbentsOnly ? candidates.filter(isIncumbent) : candidates;
  const excluded = all - filtered.length;

  const rows = [];
  for (let i = 0; i < filtered.length; i++) {
    const c = filtered[i];
    let totals = null;
    // The roster usually names the committee. When it does not, ask — rather
    // than reporting a sitting member as having filed nothing.
    if (!c.committee_id) {
      try {
        const cj = await fetchJson(candidateCommitteesUrl(c.candidate_id, cycle, key));
        const found = parseCandidateCommittees(cj);
        if (found.length) {
          c.committee_id = found[0].committee_id;
          c.committee_name = found[0].name;
          c.committee_source = 'candidate lookup';
        }
      } catch { /* leave it empty and report it as empty */ }
      if (pace) await new Promise((r) => setTimeout(r, pace));
    }
    if (c.committee_id) {
      const json = await fetchJson(totalsUrl(c.committee_id, cycle, key));
      totals = parseTotals(json);
    }
    rows.push({ candidate: c, totals, audit: auditMember(totals) });
    if (onStep) onStep('totals', c.name, i + 1, filtered.length);
    if (pace) await new Promise((r) => setTimeout(r, pace));
  }
  const summary = summarise(rows);
  summary.roster_size = all;
  summary.excluded_non_incumbent = excluded;
  return { rows: rank(rows), summary };
}

module.exports = {
  API, OFFICES, candidatesUrl, parseCandidates, totalsUrl, parseTotals,
  candidateCommitteesUrl, parseCandidateCommittees, isIncumbent,
  auditMember, rank, summarise, sweep, pct,
};
