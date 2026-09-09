#!/usr/bin/env node
'use strict';
/** test_delegation.js — a state's money, and the denominators it depends on. */

const D = require('./delegation.js');

let ran = 0, fails = 0;
function check(label, ok) {
  ran += 1; if (!ok) fails += 1;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
function eq(label, got, want) {
  check(`${label}${got === want ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
    got === want);
}

async function run() {
  console.log('\n  delegation — a whole state, and where its money comes from\n');

  // --- the roster
  const u = D.candidatesUrl('oh', 'h', 2026, 'K', 2);
  check('the state is upper-cased for the API', u.includes('state=OH'));
  check('and the office too', u.includes('office=H'));
  check('the cycle is an election year, not a date range',
    u.includes('election_year=2026'));
  check('paging is by page number, which /candidates/ uses', u.includes('page=2'));

  // --- a long-serving member has old committees; the live one is the answer
  const cands = D.parseCandidates({
    results: [{
      candidate_id: 'H0OH00001', name: 'DOE, JANE', party: 'DEM',
      office: 'H', state: 'OH', district: '03',
      incumbent_challenge_full: 'Incumbent',
      principal_committees: [
        { committee_id: 'C00000001', name: 'OLD COMMITTEE', last_file_date: '2014-01-31' },
        { committee_id: 'C00000002', name: 'JANE FOR CONGRESS', last_file_date: '2026-07-31' },
      ],
    }, { name: 'NO ID' }],
  });
  eq('a candidate with no id is dropped', cands.length, 1);
  eq('the LIVE principal committee is chosen, not the first in the array',
    cands[0].committee_id, 'C00000002');
  eq('and the superseded one is counted, not silently ignored',
    cands[0].other_committees, 1);
  eq('incumbency is carried through', cands[0].incumbent, 'Incumbent');

  const noCmte = D.parseCandidates({
    results: [{ candidate_id: 'H1', name: 'X', principal_committees: [] }],
  });
  eq('a candidate with no committee still appears', noCmte.length, 1);
  eq('with an empty committee id rather than a guess', noCmte[0].committee_id, '');

  // --- the totals
  eq('totals are requested for one cycle',
    D.totalsUrl('C1', 2026, 'K').includes('cycle=2026'), true);
  eq('an empty totals response is null, not zeroes',
    D.parseTotals({ results: [] }), null);

  const t = D.parseTotals({
    results: [{
      cycle: 2026, coverage_end_date: '2026-06-30T00:00:00',
      receipts: 1000000, disbursements: 400000,
      individual_contributions: 300000,
      individual_itemized_contributions: 250000,
      individual_unitemized_contributions: 50000,
      other_political_committee_contributions: 600000,
      political_party_committee_contributions: 100000,
      transfers_from_other_authorized_committee: 0,
      loans: 0, loans_made_by_candidate: 0,
      last_cash_on_hand_end_period: 600000,
      contributions_to_other_committees: 25000,
    }],
  });
  eq('the coverage date is trimmed to a day', t.coverage_end_date, '2026-06-30');
  eq('PAC money is read from the committee field', t.pac_contributions, 600000);

  const a = D.auditMember(t);
  eq('contributions are people plus committees plus party', a.contributed, 1000000);
  eq('PAC share is of CONTRIBUTIONS', a.pac_share_of_contributed, 60);
  eq('individual share too', a.individual_share_of_contributed, 30);
  check('and the shares add to 100 across the three sources',
    Math.round(a.pac_share_of_contributed + a.individual_share_of_contributed
      + a.party_share_of_contributed) === 100);
  eq('unitemized giving is reported as a share of individual giving',
    a.unitemized_share_of_individual, 16.7);
  eq('money passed to other members is surfaced', a.to_other_committees, 25000);
  eq('a clean committee raises no flags', a.flags.length, 0);

  // --- THE DENOMINATOR. receipts includes money nobody gave.
  const lent = D.parseTotals({
    results: [{
      receipts: 1000000, disbursements: 100000,
      individual_contributions: 100000,
      other_political_committee_contributions: 100000,
      political_party_committee_contributions: 0,
      loans_made_by_candidate: 800000,
      last_cash_on_hand_end_period: 900000,
    }],
  });
  const la = D.auditMember(lent);
  eq('a self-funder\'s loan is not counted as a contribution', la.contributed, 200000);
  eq('so the PAC share is of what was GIVEN', la.pac_share_of_contributed, 50);
  check('and the loan is flagged so the reader can see it',
    la.flags.some((f) => f.kind === 'loans' && f.amount === 800000));
  check('a share computed off receipts would have been 10%, and wrong',
    D.pct(lent.pac_contributions, lent.receipts) === 10);

  const transferred = D.auditMember(D.parseTotals({
    results: [{ receipts: 500, transfers_from_other_authorized_committee: 400,
                individual_contributions: 100 }],
  }));
  check('a transfer in is flagged too',
    transferred.flags.some((f) => f.kind === 'transfers'));

  const dormant = D.auditMember(D.parseTotals({
    results: [{ receipts: 0, disbursements: 0 }],
  }));
  eq('a committee that raised nothing reports no share, not zero',
    dormant.pac_share_of_contributed, null);
  check('and says so rather than looking clean',
    dormant.flags.some((f) => f.kind === 'no_contributions'));

  // --- ranking and delegation totals
  const rows = [
    { candidate: { name: 'CHALLENGER', incumbent: 'Challenger' },
      totals: { receipts: 1, disbursements: 0, pac_contributions: 1, cash_on_hand: 0 },
      audit: { contributed: 1, pac_share_of_contributed: 99 } },
    { candidate: { name: 'SITTING B', incumbent: 'Incumbent' },
      totals: { receipts: 10, disbursements: 5, pac_contributions: 2, cash_on_hand: 5 },
      audit: { contributed: 10, pac_share_of_contributed: 20 } },
    { candidate: { name: 'SITTING A', incumbent: 'Incumbent' },
      totals: { receipts: 10, disbursements: 5, pac_contributions: 7, cash_on_hand: 5 },
      audit: { contributed: 10, pac_share_of_contributed: 70 } },
  ];
  const ranked = D.rank(rows);
  eq('incumbents come first however they rank on money',
    ranked[0].candidate.name + '|' + ranked[1].candidate.name,
    'SITTING A|SITTING B');
  eq('and within them, highest PAC share first',
    ranked[0].audit.pac_share_of_contributed, 70);

  const s = D.summarise(rows);
  eq('the delegation total counts every member', s.members, 3);
  eq('and sums receipts across committees', s.receipts, 21);
  eq('with a PAC share of the delegation\'s contributions', s.pac_share_of_contributed, 47.6);
  check('and says the total is not a fund anyone controls',
    /not a fund/.test(s._note));

  const partial = D.summarise([
    ...rows,
    { candidate: { name: 'NO FILING', incumbent: '' }, totals: null, audit: null },
  ]);
  eq('a member with no totals is counted as missing', partial.missing_totals, 1);
  eq('and does not break the sums', partial.receipts, 21);

  // --- the whole sweep, offline
  let calls = 0;
  const fake = async (url) => {
    calls += 1;
    if (/\/candidates\//.test(url)) {
      const office = /office=S/.test(url) ? 'S' : 'H';
      return {
        results: [{
          candidate_id: `${office}0OH0000${calls}`, name: `MEMBER ${office}${calls}`,
          party: 'REP', office, state: 'OH', district: office === 'S' ? '00' : '03',
          incumbent_challenge_full: 'Incumbent',
          principal_committees: [{ committee_id: `C0000000${calls}`,
                                   name: 'CMTE', last_file_date: '2026-07-31' }],
        }],
        pagination: { pages: 1 },
      };
    }
    return { results: [{ receipts: 100, disbursements: 40,
      individual_contributions: 30, other_political_committee_contributions: 70,
      last_cash_on_hand_end_period: 60 }] };
  };
  const steps = [];
  const out = await D.sweep(fake, { state: 'OH', cycle: 2026, key: 'K',
    onStep: (...x) => steps.push(x[0]) });
  eq('both chambers are swept', out.rows.length, 2);
  check('every member got their totals', out.rows.every((r) => r.totals));
  eq('the delegation summary is computed', out.summary.members, 2);
  check('progress is reported for the roster and for each member',
    steps.includes('candidates') && steps.includes('totals'));
  // a candidate the fallback also cannot place stays empty rather than guessed.
  // incumbentsOnly is off here because this fixture has no incumbency field —
  // with the default on it would be filtered out and the row would not exist,
  // which is a different thing than having no committee.
  eq('a member no lookup can place is reported empty, not invented',
    (await D.sweep(async () => ({ results: [{ candidate_id: 'H1', name: 'X',
      principal_committees: [] }], pagination: { pages: 1 } }),
      { state: 'OH', offices: ['H'], cycle: 2026, key: 'K',
        incumbentsOnly: false })).rows[0].totals, null);

  // --- the endpoint that killed the first live run.
  // /candidates/ and /candidates/search/ look interchangeable; only the
  // second returns principal_committees. Against the first, every one of
  // 115 Ohio candidates resolved to an empty committee and the sweep
  // reported "no committee totals filed" for an entire delegation.
  check('the roster comes from the SEARCH endpoint',
    D.candidatesUrl('OH', 'H', 2026, 'K').includes('/candidates/search/'));

  // --- and when the roster still names no committee, ask
  // /candidate/{id}/committees/ does not exist — 404, mid-sweep, after the
  // roster already succeeded, so it reads as an unknown candidate.
  check('the fallback filters /committees/ rather than nesting under /candidate/',
    D.candidateCommitteesUrl('H0OH01', 2026, 'K').includes('/committees/?')
    && D.candidateCommitteesUrl('H0OH01', 2026, 'K').includes('candidate_id=H0OH01')
    && !/\/candidate\/H0OH01\//.test(D.candidateCommitteesUrl('H0OH01', 2026, 'K')));
  check('and asks only for principal ones',
    D.candidateCommitteesUrl('H0OH01', 2026, 'K').includes('designation=P'));
  const fb = D.parseCandidateCommittees({ results: [
    { committee_id: 'C1', name: 'OLD', last_file_date: '2014-01-01' },
    { committee_id: 'C2', name: 'NEW', last_file_date: '2026-07-31' },
    { name: 'NO ID' },
  ] });
  eq('the live committee wins the fallback too', fb[0].committee_id, 'C2');
  eq('and an id-less row is dropped', fb.length, 2);

  let fellBack = 0;
  const noPc = async (url) => {
    if (/\/candidates\/search\//.test(url)) {
      return { results: [{ candidate_id: 'H0OH01', name: 'SITTING MEMBER',
        office: 'H', state: 'OH', district: '03',
        incumbent_challenge_full: 'Incumbent' }], pagination: { pages: 1 } };
    }
    if (/\/committees\//.test(url)) {
      fellBack += 1;
      return { results: [{ committee_id: 'C9', name: 'CMTE', last_file_date: '2026-07-31' }] };
    }
    return { results: [{ receipts: 100, individual_contributions: 40,
      other_political_committee_contributions: 60 }] };
  };
  const rescued = await D.sweep(noPc, { state: 'OH', offices: ['H'], cycle: 2026, key: 'K' });
  eq('a member with no committee in the roster is looked up', fellBack, 1);
  check('and their money is found rather than reported missing',
    rescued.rows[0].totals !== null);
  eq('with the share computed', rescued.rows[0].audit.pac_share_of_contributed, 60);

  // --- "my legislators" is the incumbents, not the 115-name cycle roster
  const roster = async (url) => {
    if (/\/candidates\/search\//.test(url)) {
      return { results: [
        { candidate_id: 'H1', name: 'SITTING', office: 'H', state: 'OH', district: '03',
          incumbent_challenge_full: 'Incumbent',
          principal_committees: [{ committee_id: 'C1', last_file_date: '2026-07-31' }] },
        { candidate_id: 'H2', name: 'PAPER CANDIDATE', office: 'H', state: 'OH',
          district: '03', incumbent_challenge_full: 'Challenger',
          principal_committees: [{ committee_id: 'C2', last_file_date: '2026-07-31' }] },
      ], pagination: { pages: 1 } };
    }
    return { results: [{ receipts: 10, individual_contributions: 10 }] };
  };
  const inc = await D.sweep(roster, { state: 'OH', offices: ['H'], cycle: 2026, key: 'K' });
  eq('only sitting members are swept by default', inc.rows.length, 1);
  eq('and the roster size is still reported', inc.summary.roster_size, 2);
  eq('with the number left out', inc.summary.excluded_non_incumbent, 1);
  const everyone = await D.sweep(roster, { state: 'OH', offices: ['H'], cycle: 2026,
    key: 'K', incumbentsOnly: false });
  eq('--all includes challengers', everyone.rows.length, 2);
  eq('and excludes nobody', everyone.summary.excluded_non_incumbent, 0);

  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${ran - fails}/${ran} checks\n`);
  return fails ? 1 : 0;
}

if (require.main === module) run().then((c) => process.exit(c));
module.exports = { run };
