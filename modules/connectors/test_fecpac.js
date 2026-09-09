#!/usr/bin/env node
'use strict';
/** test_fecpac.js — the distinctions, held in place by tests. */

const F = require('./fecpac.js');

let ran = 0, fails = 0;
function check(label, ok) {
  ran += 1;
  if (!ok) fails += 1;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
function eq(label, got, want) {
  check(`${label}${got === want ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
    got === want);
}

async function run() {
  console.log('\n  fecpac — money out of a committee, by category\n');

  // --- no committee id is ever hardcoded
  const src = require('fs').readFileSync(require.resolve('./fecpac.js'), 'utf8');
  check('no FEC committee id is hardcoded anywhere in the module',
    !/\bC0\d{7}\b/.test(src));

  // --- urls carry the cycle field, not a date range
  const du = F.disbursementsUrl('C00000001', 2024, 'KEY');
  check('disbursements filter by the FEC cycle field',
    du.includes('two_year_transaction_period=2024'));
  check('the key is sent, and url-encoded',
    F.committeeSearchUrl('A & B PAC', 'k/1').includes('api_key=k%2F1'));
  check('a name with an ampersand survives encoding',
    F.committeeSearchUrl('A & B PAC', 'k').includes('A%20%26%20B%20PAC')
    || F.committeeSearchUrl('A & B PAC', 'k').includes('A+%26+B+PAC'));

  // --- keyset pagination, not page numbers
  check('paging uses last_index, not page numbers',
    F.disbursementsUrl('C1', 2024, 'k', 'IDX', '2024-01-01').includes('last_index=IDX')
    && !du.includes('&page='));

  // --- the contribution/overhead distinction
  eq('a 24K payment is a contribution',
    F.isContribution({ type: '24K', recipient_committee_id: 'C2' }), true);
  eq('rent to a landlord is not a contribution',
    F.isContribution({ type: 'SALARY', recipient_committee_id: '' }), false);
  eq('an untyped payment to a COMMITTEE is inferred as one',
    F.isContribution({ type: '', recipient_committee_id: 'C2' }), true);
  eq('an untyped payment to a person is not',
    F.isContribution({ type: '', recipient_committee_id: '' }), false);

  // --- support and oppose are never merged
  const ie = F.parseIndependent({
    results: [
      { candidate_name: 'DOE, JANE', expenditure_amount: 100000,
        support_oppose_indicator: 'S', expenditure_date: '2024-05-01' },
      { candidate_name: 'DOE, JANE', expenditure_amount: 400000,
        support_oppose_indicator: 'O', expenditure_date: '2024-06-01' },
    ],
  });
  const t = F.totals([], ie);
  eq('money spent FOR is counted as support', t.ie_support_usd, 100000);
  eq('money spent AGAINST is counted separately', t.ie_oppose_usd, 400000);
  check('there is no grand total, and the reason is stated',
    !('total_usd' in t) && typeof t._no_grand_total === 'string');

  const contribs = F.parseDisbursements({
    results: [{ recipient_name: 'DOE FOR SENATE', disbursement_amount: 5000,
                disbursement_date: '2024-03-01', disbursement_type: '24K',
                recipient_committee_id: 'C9' }],
  });
  const t2 = F.totals(contribs, ie);
  eq('a contribution is counted as a contribution', t2.contributions_usd, 5000);
  check('a contribution is NOT folded into the independent-expenditure totals',
    t2.ie_support_usd === 100000 && t2.ie_oppose_usd === 400000);

  // --- grouping keeps the categories visible per recipient
  const rows = F.byRecipient(contribs, ie);
  const jane = rows.find((r) => r.name === 'DOE, JANE');
  const cmte = rows.find((r) => r.name === 'DOE FOR SENATE');
  check('a candidate targeted by opposition spending appears', Boolean(jane));
  eq('and their oppose column carries it', jane.ie_oppose, 400000);
  eq('with nothing invented in their contribution column', jane.contributed, 0);
  eq('a committee that received a cheque shows the cheque', cmte.contributed, 5000);
  eq('and no independent expenditure it did not receive', cmte.ie_support, 0);

  // --- committee lookup lists every committee, not the first
  const cs = F.parseCommittees({
    results: [
      { committee_id: 'C11111111', name: 'X PAC', committee_type_full: 'PAC' },
      { committee_id: 'C22222222', name: 'X ACTION FUND',
        committee_type_full: 'Super PAC' },
      { name: 'NO ID HERE' },
    ],
  });
  eq('every committee matching the name is listed', cs.length, 2);
  check('a result with no committee id is dropped rather than half-used',
    cs.every((c) => c.committee_id));

  // --- paging stops, and says when it stopped early
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return {
      results: [{ recipient_name: `R${calls}`, disbursement_amount: 1,
                  disbursement_type: '24K' }],
      pagination: { last_indexes: { last_index: `idx${calls}` } },
    };
  };
  const walked = await F.collect(fake, () => 'u', F.parseDisbursements, 4);
  eq('paging stops at the cap rather than running forever', calls, 4);
  eq('and every row from every page is kept', walked.rows.length, 4);
  check('hitting the cap is reported as truncation, not silence', walked.truncated);

  calls = 0;
  const short = async () => {
    calls += 1;
    return { results: [{ recipient_name: 'only', disbursement_amount: 2,
                         disbursement_type: '24K' }], pagination: {} };
  };
  const one = await F.collect(short, () => 'u', F.parseDisbursements, 10);
  eq('a single page stops after one request', calls, 1);
  check('and is not reported as truncated', !one.truncated);

  // --- an empty result is empty, not zero-filled
  eq('no results means no rows', F.parseDisbursements({}).length, 0);
  eq('and no totals invented',
    F.totals([], []).contributions_usd, 0);

  // --- the flag-value bug, held down by a test.
  // `--committee C00879080` was filtered out of args as a FLAG and its VALUE
  // left behind, so the id joined the organisation name and the FEC was asked
  // for a committee called "AIPAC C00879080 2024". It answered, correctly,
  // that no such committee exists — a clean, confident, wrong result.
  const { flagVal, flagNum, subjectFrom } = require('./cli.js');
  if (typeof subjectFrom === 'function') {
    const argv = ['fecpac', 'AIPAC', '--committee', 'C00879080', '--cycle', '2024'];
    const positional = argv.filter((a) => !a.startsWith('--'));
    eq('a flag value does not survive into the subject',
      subjectFrom(positional.slice(1), argv, ['--cycle', '--committee']), 'AIPAC');
    eq('the committee id is read from its flag', flagVal(argv, '--committee'), 'C00879080');
    eq('the cycle is read as a number', flagNum(argv, '--cycle'), 2024);
    eq('a multi-word organisation still joins',
      subjectFrom(['UNITED', 'DEMOCRACY', 'PROJECT'],
        ['--cycle', '2024'], ['--cycle']), 'UNITED DEMOCRACY PROJECT');
    eq('a flag with no value does not eat the next flag',
      flagVal(['--committee', '--cycle', '2024'], '--committee'), null);
    eq('an absent flag is absent, not empty', flagVal(['x'], '--cycle'), null);
  } else {
    check('cli exports its flag helpers so they can be tested', false);
  }

  // --- `connect fec "Ohio Senate"` returned zero, because q matches a NAME.
  // An office and a state is a filter, not a person, and a name field asked
  // for one answers honestly with nothing.
  const R = require('./registry.js');
  const fecUrl = (q) => R.CONNECTORS.fec.run(q, 'K').url;
  check('a state/office query becomes structured filters',
    /state=OH/.test(fecUrl('OH/S')) && /office=S/.test(fecUrl('OH/S')));
  check('a district is zero-padded the way the FEC stores it',
    /district=15/.test(fecUrl('OH/H/15')));
  check('lower case and spaces still resolve', /state=OH/.test(fecUrl('oh / h')));
  check('a person is still searched by name',
    /q=Sherrod/.test(fecUrl('Sherrod Brown')) && !/state=/.test(fecUrl('Sherrod Brown')));
  check('an office phrase is NOT silently treated as a filter',
    /q=Ohio/.test(fecUrl('Ohio Senate')));
  // OH/S returned forty years of write-ins sorted by who filed most recently,
  // with the incumbent nowhere near the top. A year is what separates "who has
  // ever run" from "who is running".
  check('a four-digit part is an election year, not a district',
    /election_year=2026/.test(fecUrl('OH/S/2026'))
    && !/district=2026/.test(fecUrl('OH/S/2026')));
  check('a district and a year can both be given',
    /district=15/.test(fecUrl('OH/H/15/2026'))
    && /election_year=2026/.test(fecUrl('OH/H/15/2026')));
  check('with no year, at least the retired candidates are dropped',
    /is_active_candidate=true/.test(fecUrl('OH/S')));
  check('with a year, active-only is not also applied',
    !/is_active_candidate/.test(fecUrl('OH/S/2026')));

  // --- the conduit problem, found in live data an hour after shipping.
  // AIPAC PAC's 2022 Schedule B showed $248,936 to one campaign committee —
  // fifty times what a PAC may give from its own funds — across 2,482 rows
  // averaging $842. Those are individuals' earmarked contributions being
  // forwarded, not the committee's giving, and the column was labelled
  // "capped, itemised, attributable — the strong material".
  const conduitRows = [
    { recipient: 'ELAINE FOR CONGRESS', amount: 248936, date: '2022-05-01' },
    { recipient: 'SMALL FOR SENATE', amount: 900, date: '2022-05-02' },
  ];
  const found = F.auditContributions(conduitRows);
  check('a recipient above the cap is flagged as a conduit signature',
    found.some((f) => f.kind === 'over_cap'));
  eq('and the worst offender is named', found[0].worst[0], 'ELAINE FOR CONGRESS');
  check('a committee giving within the cap raises nothing',
    F.auditContributions([{ recipient: 'A', amount: 5000, date: '2022-01-01' },
                          { recipient: 'B', amount: 2500, date: '2022-01-01' }])
      .length === 0);

  const many = Array.from({ length: 300 }, (_, i) => (
    { recipient: `R${i % 40}`, amount: 800, date: '2022-03-01' }));
  check('an average the size of individual giving is flagged',
    F.auditContributions(many).some((f) => f.kind === 'small_average'));

  eq('a memo-coded row is not the committee\'s own money',
    F.isEarmarked({ memo_code: 'X' }), true);
  eq('memo text naming an earmark counts too',
    F.isEarmarked({ memo_text: 'EARMARKED FOR CANDIDATE' }), true);
  eq('an ordinary row is the committee\'s own',
    F.isEarmarked({ memo_code: '', memo_text: '' }), false);
  check('memo fields are parsed off the wire at all',
    'memo_code' in F.parseDisbursements({ results: [{}] })[0]);

  // --- an ignored filter returns everything, successfully.
  // UDP's 2024 total came back at $236m across for and against, and a row
  // dated 2025 for a 2026 Senate race sat inside a query for cycle 2024.
  check('rows outside the requested cycle are reported',
    F.auditCycle([{ date: '2025-06-01' }, { date: '2024-02-01' }], 2024).count === 1);
  check('and the offending range is named',
    F.auditCycle([{ date: '2025-06-01' }], 2024).range[0] === '2025-06-01');
  eq('a cycle covers its odd year too',
    F.auditCycle([{ date: '2023-11-01' }, { date: '2024-02-01' }], 2024), null);
  eq('rows with no date do not raise a false alarm',
    F.auditCycle([{ date: '' }], 2024), null);

  // --- the number the flag alone could not give.
  // 2,418 of AIPAC PAC's 2,482 rows carried a memo code. Flagging that told
  // you the total was wrong without telling you what was right.
  const mixed = [
    { recipient: 'A', amount: 5000, memo_code: '', date: '2022-05-01' },
    { recipient: 'B', amount: 800, memo_code: 'X', date: '2022-05-01' },
    { recipient: 'B', amount: 900, memo_text: 'EARMARKED', date: '2022-05-01' },
  ];
  const sp = F.splitConduit(mixed);
  eq('own funds are counted alone', sp.own_usd, 5000);
  eq('forwarded money is counted alone', sp.forwarded_usd, 1700);
  eq('and the share forwarded is reported', sp.forwarded_share, 66.7);
  check('the two never add up to one headline',
    sp.own_usd + sp.forwarded_usd === 6700 && !('total_usd' in sp));
  const clean = F.splitConduit([{ recipient: 'A', amount: 5000, date: '2022-01-01' }]);
  eq('a committee with no conduit rows forwards nothing', clean.forwarded_rows, 0);

  // --- schedule E ignored two_year_transaction_period entirely
  const eu = F.independentUrl('C1', 2024, 'K');
  check('schedule E filters by date, which it supports',
    /min_date=2023-01-01/.test(eu) && /max_date=2024-12-31/.test(eu));
  check('and no longer sends the field it ignores',
    !/two_year_transaction_period/.test(eu));
  check('schedule B still uses the cycle field, which it does support',
    /two_year_transaction_period=2024/.test(F.disbursementsUrl('C1', 2024, 'K')));

  // --- and the window is enforced locally regardless
  const cl = F.clampToCycle(
    [{ date: '2026-08-11' }, { date: '2024-02-01' }, { date: '2023-06-01' }], 2024);
  eq('rows outside the cycle are removed', cl.kept.length, 2);
  eq('and handed back rather than silently dropped', cl.dropped.length, 1);
  eq('a row with no date is kept rather than guessed at',
    F.clampToCycle([{ date: '' }], 2024).kept.length, 1);

  // --- a long pull must say where it is. Twenty-five paced pages against a
  // slow API is over a minute of nothing, and nothing looks like a hang.
  let seen = [];
  let n = 0;
  const paged = async () => ({
    results: [{ recipient_name: 'R', disbursement_amount: 1, disbursement_type: '24K' }],
    pagination: { last_indexes: { last_index: `i${++n}` } },
  });
  await F.collect(paged, () => 'u', F.parseDisbursements, 3, 0,
    (pg, got, total, cap) => seen.push([pg, got, total, cap]));
  eq('every page reports itself', seen.length, 3);
  eq('with a running row count', seen[2][2], 3);
  eq('and the cap, so the end is in sight', seen[0][3], 3);
  check('progress reporting is optional, not required',
    (await F.collect(paged, () => 'u', F.parseDisbursements, 1)).rows.length === 1);

  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${ran - fails}/${ran} checks\n`);
  return fails ? 1 : 0;
}

if (require.main === module) run().then((c) => process.exit(c));
module.exports = { run };
