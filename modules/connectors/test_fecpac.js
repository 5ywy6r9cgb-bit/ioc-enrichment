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

  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${ran - fails}/${ran} checks\n`);
  return fails ? 1 : 0;
}

if (require.main === module) run().then((c) => process.exit(c));
module.exports = { run };
