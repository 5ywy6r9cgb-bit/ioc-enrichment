#!/usr/bin/env node
'use strict';
/** test_member.js — three directions at one seat, never summed. */

const M = require('./member.js');

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
  console.log('\n  member — every direction outside money moves at one seat\n');

  // --- Schedule A: committee money in, individuals excluded
  const au = M.contributionsInUrl('C1', 2024, 'K');
  check('money IN filters to committees, not individuals',
    au.includes('is_individual=false'));
  check('and uses the cycle field Schedule A supports',
    au.includes('two_year_transaction_period=2024'));

  // --- Schedule E is keyed on the CANDIDATE, not their committee.
  // Money spent against someone never touches their committee, so filtering
  // by committee_id would return an empty AGAINST column on every seat.
  const eu = M.independentUrl('H0OH01', 2024, 'K');
  check('spending for and against is keyed on the candidate',
    eu.includes('candidate_id=H0OH01'));
  check('over the cycle window by date, which Schedule E supports',
    eu.includes('min_date=2023-01-01') && eu.includes('max_date=2024-12-31'));
  check('and not by the cycle field Schedule E ignores',
    !eu.includes('two_year_transaction_period'));

  // --- the three directions, kept apart
  const inRows = M.parseContributionsIn({ results: [
    { contributor_name: 'BIG PAC', contributor_id: 'C10',
      contribution_receipt_amount: 5000, contribution_receipt_date: '2024-03-01' },
    { contributor_name: 'CONDUIT PAC', contributor_id: 'C11',
      contribution_receipt_amount: 900, contribution_receipt_date: '2024-03-02',
      memo_code: 'X' },
  ] });
  const ieRows = M.parseIndependent({ results: [
    { committee_name: 'FRIENDLY FUND', committee_id: 'C20', expenditure_amount: 40000,
      support_oppose_indicator: 'S', expenditure_date: '2024-05-01' },
    { committee_name: 'ATTACK FUND', committee_id: 'C21', expenditure_amount: 90000,
      support_oppose_indicator: 'O', expenditure_date: '2024-06-01' },
    { committee_name: 'BIG PAC', committee_id: 'C10', expenditure_amount: 10000,
      support_oppose_indicator: 'O', expenditure_date: '2024-07-01' },
  ] });

  const orgs = M.byOrganisation(inRows, ieRows);
  const s = M.summarise(inRows, ieRows, orgs);
  eq('money given from a committee\'s own funds stands alone', s.to_them_own, 5000);
  eq('conduit money is separated from it', s.to_them_forwarded, 900);
  eq('support spending is its own figure', s.for_them, 40000);
  eq('opposition spending is its own figure', s.against_them, 100000);
  check('and there is no grand total', !('total' in s) && typeof s._no_grand_total === 'string');

  // --- the numbers that only exist in this view
  eq('the contested ratio is for-money over against-money',
    s.contested_ratio, 0.4);
  eq('outside pressure is independent spending over money received',
    s.outside_pressure, M.ratio(140000, 5900));
  check('outside pressure above 1 means more moved around them than through',
    s.outside_pressure > 1);

  // A ratio of 0 is a FINDING, not a missing value: zero dollars supported
  // them for every dollar spent against. null is reserved for the case where
  // the denominator does not exist — nobody spent against them at all.
  const uncontested = M.summarise([], M.parseIndependent({ results: [
    { committee_name: 'A', expenditure_amount: 50000,
      support_oppose_indicator: 'O', expenditure_date: '2024-01-01' }] }), []);
  eq('no support against real opposition is a ratio of zero, and says so',
    uncontested.contested_ratio, 0);
  eq('and the opposition figure is reported beside it', uncontested.against_them, 50000);
  const unopposed = M.summarise([], M.parseIndependent({ results: [
    { committee_name: 'A', expenditure_amount: 50000,
      support_oppose_indicator: 'S', expenditure_date: '2024-01-01' }] }), []);
  eq('nobody spending against them leaves the ratio undefined, not infinite',
    unopposed.contested_ratio, null);
  eq('while the support figure still stands', unopposed.for_them, 50000);

  // --- an organisation on both sides of one seat
  const both = M.twoColumn(orgs);
  eq('an organisation appearing in two directions is surfaced', both.length, 1);
  eq('and it is the one that both gave and attacked', both[0].name, 'BIG PAC');
  const bp = orgs.find((o) => o.name === 'BIG PAC');
  eq('its giving is intact', bp.gave, 5000);
  eq('its opposition spending is intact beside it', bp.spent_against, 10000);
  check('and the two were never merged', bp.gave !== bp.spent_against);

  // --- identity: a name is not an id
  const two = M.byOrganisation([], M.parseIndependent({ results: [
    { committee_name: 'SAME NAME', committee_id: 'C30', expenditure_amount: 1,
      support_oppose_indicator: 'S', expenditure_date: '2024-01-01' },
    { committee_name: 'SAME NAME', committee_id: 'C31', expenditure_amount: 2,
      support_oppose_indicator: 'S', expenditure_date: '2024-01-01' },
  ] }));
  eq('two committees sharing a name stay two organisations', two.length, 2);
  const noId = M.byOrganisation([], M.parseIndependent({ results: [
    { committee_name: 'no id here', expenditure_amount: 1,
      support_oppose_indicator: 'S', expenditure_date: '2024-01-01' },
    { committee_name: 'NO ID HERE', expenditure_amount: 2,
      support_oppose_indicator: 'S', expenditure_date: '2024-01-01' },
  ] }));
  eq('and without ids, one name is one organisation', noId.length, 1);

  // --- sole targets: a committee whose whole spend names one candidate
  const allSpend = new Map([['C21', 90000], ['C10', 250000]]);
  const sole = M.soleTargets(ieRows, allSpend);
  eq('a committee that spent its whole budget here is flagged', sole.length, 1);
  eq('and it is the one with nothing spent elsewhere', sole[0].committee, 'C21');

  // --- the cycle window is enforced locally, as everywhere else
  const cl = M.clampToCycle(
    [{ date: '2026-01-01' }, { date: '2024-02-01' }, { date: '2023-06-01' }], 2024);
  eq('rows outside the cycle are removed', cl.kept.length, 2);
  eq('and handed back rather than dropped in silence', cl.dropped.length, 1);

  // --- candidate resolution
  const cands = M.parseCandidateMatches({ results: [
    { candidate_id: 'H1', name: 'DOE, JANE', party: 'DEM', office: 'House',
      state: 'OH', district: '03', incumbent_challenge_full: 'Incumbent',
      principal_committees: [
        { committee_id: 'COLD', last_file_date: '2014-01-01' },
        { committee_id: 'CNEW', last_file_date: '2026-07-31' }] },
    { name: 'NO ID' },
  ] });
  eq('a candidate with no id is dropped', cands.length, 1);
  eq('and the live committee wins', cands[0].committee_id, 'CNEW');

  // --- the whole thing, offline
  let seenA = 0, seenE = 0;
  const fake = async (url) => {
    if (/schedule_a/.test(url)) {
      seenA += 1;
      return seenA > 1 ? { results: [] } : { results: [
        { contributor_name: 'P1', contributor_id: 'C1',
          contribution_receipt_amount: 2500, contribution_receipt_date: '2024-02-01' }] };
    }
    seenE += 1;
    return seenE > 1 ? { results: [] } : { results: [
      { committee_name: 'ATTACKER', committee_id: 'C9', expenditure_amount: 75000,
        support_oppose_indicator: 'O', expenditure_date: '2024-08-01' }] };
  };
  const a = await M.collect(fake, () => 'schedule_a', M.parseContributionsIn, 3, 0);
  const b = await M.collect(fake, () => 'schedule_e', M.parseIndependent, 3, 0);
  const o2 = M.byOrganisation(a.rows, b.rows);
  const s2 = M.summarise(a.rows, b.rows, o2);
  eq('both directions are read', o2.length, 2);
  eq('money in is counted', s2.to_them_own, 2500);
  eq('money against is counted', s2.against_them, 75000);
  eq('a seat with only opposition spending rates 0.00', s2.contested_ratio, 0);
  check('while outside pressure still computes', s2.outside_pressure === 30);

  // ── --candidate MUST LOOK THE PERSON UP ──────────────────────────────
  // The live failure: `member "BROWN, SHERROD" --candidate S6OH00163`
  // printed
  //     S6OH00163  S6OH00163  cycle 2026
  //     no principal committee on file — money IN cannot be read.
  // Neither line was about the FEC. The flag path synthesised a record with
  // an empty committee id and never asked the register anything, so the id
  // stood in for the name and the empty field was reported as an absence.
  //
  // The disambiguation guard RECOMMENDS this flag. Following the tool's own
  // instruction silently switched off one of the three directions the
  // command exists to reconcile.
  const cliSrc = require('fs').readFileSync(require.resolve('./cli.js'), 'utf8');

  check('--candidate resolves the id against the register',
    /candidateByIdUrl\(opts\.candidate, key\)/.test(cliSrc));
  check('and does NOT synthesise a record with an empty committee id',
    !/candidate_id: opts\.candidate, name: opts\.candidate, committee_id: ''/.test(cliSrc));
  check('an id the FEC does not know is refused, not invented',
    /is not a candidate id the FEC knows/.test(cliSrc));

  eq('the by-id lookup uses /candidates/search/, which carries committees',
    M.candidateByIdUrl('S6OH00163', 'k').includes('/candidates/search/'), true);
  check('and filters on candidate_id',
    M.candidateByIdUrl('S6OH00163', 'k').includes('candidate_id=S6OH00163'));

  // The fallback delegation already had and member did not.
  check('a missing committee is retried the other way round',
    /candidateCommitteesUrl\(picked\.candidate_id, cycle, key\)/.test(cliSrc));
  check('via a FILTER on /committees/, not the 404 path',
    M.candidateCommitteesUrl('S6OH00163', 2026, 'k').includes('/committees/?')
    && !M.candidateCommitteesUrl('S6OH00163', 2026, 'k').includes('/candidate/S6OH00163/'));
  check('asking for the principal committee specifically',
    M.candidateCommitteesUrl('S6OH00163', 2026, 'k').includes('designation=P'));
  eq('and the newest filer wins when several answer',
    M.parseCandidateCommittees({ results: [
      { committee_id: 'C1', name: 'OLD', last_file_date: '2019-01-01' },
      { committee_id: 'C2', name: 'NEW', last_file_date: '2026-06-01' },
    ] })[0].committee_id, 'C2');
  eq('committee-less rows are dropped rather than carried as blanks',
    M.parseCandidateCommittees({ results: [{ name: 'NO ID' }] }).length, 0);

  // Only after BOTH fail may the tool say so, and it must not say "zero".
  check('the absence message says UNREAD, not zero',
    /Money IN is UNREAD, not zero/.test(cliSrc));
  check('it names both lookups it tried',
    /by candidate record or by committee filter/.test(cliSrc));
  check('and states that outside pressure is uncomputable without it',
    /OUTSIDE PRESSURE cannot be computed/.test(cliSrc));
  check('the old sentence, which asserted a fact about the register, is gone',
    !/no principal committee on file — money IN cannot be read/.test(cliSrc));

  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${ran - fails}/${ran} checks\n`);
  return fails ? 1 : 0;
}

if (require.main === module) run().then((c) => process.exit(c));
module.exports = { run };
