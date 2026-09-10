#!/usr/bin/env node
'use strict';
/** test_donors.js — who funded it, and how much of the money we can see. */

const D = require('./donors.js');

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
  console.log('\n  donors — money IN, and the part of it Schedule A cannot see\n');

  // ── THE COVERAGE GATE. This is the file. ────────────────────────────
  // Schedule A itemises above $200. A committee funded by small donors has
  // a nearly empty Schedule A, and the top row of it is not "the top donor".
  const thin = D.coverage(50000, { receipts: 1000000 }, false);
  eq('itemised rows worth 5% of receipts read as THIN', thin.verdict, 'thin');
  eq('and the share is still reported', thin.share, 5);
  check('a share of the WHOLE may not be stated from that',
    D.canStateShareOfWhole(thin) === false);
  check('and the reason is spelled out, not implied',
    /under the \$200 reporting threshold/.test(thin.note));

  const full = D.coverage(980000, { receipts: 1000000 }, false);
  eq('near-total itemisation reads as NEAR COMPLETE', full.verdict, 'near_complete');
  check('and only THEN may a share of the whole be stated',
    D.canStateShareOfWhole(full) === true);

  eq('60-90% is partial', D.coverage(700000, { receipts: 1000000 }, false).verdict, 'partial');
  check('and partial forbids the share-of-whole claim too',
    !D.canStateShareOfWhole(D.coverage(700000, { receipts: 1000000 }, false)));

  // Truncation beats everything: a sample has no denominator at all.
  const cut = D.coverage(980000, { receipts: 1000000 }, true);
  eq('a truncated pull is TRUNCATED even at 98% coverage', cut.verdict, 'truncated');
  check('because the rows are a sample, and it says so',
    /SAMPLE, not the itemised total/.test(cut.note));
  check('and no share of anything may be stated', !D.canStateShareOfWhole(cut));

  // No totals at all is UNKNOWN, never 100%.
  const none = D.coverage(50000, null, false);
  eq('missing summary totals is unknown, not complete', none.verdict, 'unknown');
  eq('and the share is null rather than a number', none.share, null);
  check('with everything called a floor', /floor/.test(none.note));

  // ── MEMO ROWS ARE NOT THE FILER'S MONEY ─────────────────────────────
  const rows = [
    { from: 'SMITH, JANE', kind: 'IND', amount: 5000, date: '2025-08-01' },
    { from: 'SMITH, JANE', kind: 'IND', amount: 2000, date: '2025-09-15' },
    { from: 'ACTBLUE', kind: 'PAC', amount: 100000, date: '2025-08-02',
      memo_code: 'X', memo_text: 'EARMARKED' },
    { from: 'BIG HOLDINGS LLC', kind: 'ORG', amount: 250000, date: '2025-07-30' },
    { from: 'SOME PAC', kind: 'COM', amount: 5000, date: '2025-08-10' },
  ];

  check('a memo-coded row is recognised as pass-through',
    D.isEarmarked(rows[2]) === true);
  check('and a plain row is not',
    D.isEarmarked(rows[3]) === false);
  check('an earmark named only in the text is caught too',
    D.isEarmarked({ memo_text: 'Earmarked for the committee' }));

  // ── THE 119.2% BUG ──────────────────────────────────────────────────
  // The first live run on OHIO FLYER PAC printed
  //     NEAR COMPLETE  119.2% of reported receipts
  //     receipts reported  $2,834,231
  //     itemised here      $3,379,539
  // You cannot see more of the money than exists. An earmarked gift is in
  // Schedule A TWICE — the conduit's receipt and the memo row naming the
  // original giver — and summing both counted it twice. Subtracting the
  // $545,310 of memo rows gave $2,834,229, within $2 of reported receipts.
  const live = D.summarise([
    { from: 'BIG CO', kind: 'ORG', amount: 2834229, date: '2025-08-01' },
    { from: 'A PERSON', kind: 'IND', amount: 545310, date: '2025-08-02',
      memo_code: 'X' },
  ], { receipts: 2834231 }, false);
  eq('coverage is measured on DIRECT money only', live.coverage.itemised, 2834229);
  eq('which lands where the committee says it should', live.coverage.share, 100);
  eq('and reads as near complete, honestly this time',
    live.coverage.verdict, 'near_complete');
  check('the forwarded money is still reported, just not double-counted',
    live.forwarded_total === 545310);

  // The guard, for any other cause of the same impossibility.
  const impossible = D.coverage(3379539, { receipts: 2834231 }, false);
  eq('a share above 100% is never called near complete',
    impossible.verdict, 'over_reported');
  check('it is called what it is', /cannot be true/.test(impossible.note));
  check('and no share may be stated from it',
    !D.canStateShareOfWhole(impossible));
  eq('101% is tolerated as rounding, not flagged',
    D.coverage(101000, { receipts: 100000 }, false).verdict, 'near_complete');

  const s = D.summarise(rows, { receipts: 400000 }, false);
  eq('direct money is totalled apart from forwarded', s.direct_total, 262000);
  eq('and forwarded money is kept separate', s.forwarded_total, 100000);
  eq('with the forwarding rows counted', s.forwarded_rows, 1);
  check('so a conduit is never reported as the donor',
    s.direct_total === 262000 && !String(s.direct_total).includes('362000'));

  // ── DONORS ──────────────────────────────────────────────────────────
  eq('repeat gifts from one person become one donor', s.distinct_donors, 4);
  const jane = s.donors.find((d) => d.name === 'SMITH, JANE');
  eq('with their gifts summed', jane.direct, 7000);
  eq('and their row count kept', jane.rows, 2);
  eq('and the span of their giving', jane.first, '2025-08-01');
  eq('through to the last', jane.last, '2025-09-15');
  eq('the largest donor sorts first', s.donors[0].name, 'BIG HOLDINGS LLC');

  const ab = s.donors.find((d) => d.name === 'ACTBLUE');
  eq('a conduit\'s money sits in forwarded, not direct', ab.direct, 0);
  eq('with the amount still visible', ab.forwarded, 100000);

  // ── ENTITY KINDS ────────────────────────────────────────────────────
  eq('an individual is called an individual', D.kindOf({ kind: 'IND' }), 'individuals');
  eq('a company is an organisation', D.kindOf({ kind: 'ORG' }), 'organisations');
  eq('a PAC is a committee', D.kindOf({ kind: 'PAC' }), 'committees');
  eq('and COM is the same thing', D.kindOf({ kind: 'COM' }), 'committees');
  eq('an unknown code is not silently made an individual',
    D.kindOf({ kind: 'ZZZ' }), 'unclassified');
  eq('and neither is a missing one', D.kindOf({}), 'unclassified');

  const kinds = D.byKind(rows);
  eq('organisations lead this committee', kinds[0].kind, 'organisations');
  eq('at the right amount', kinds[0].amount, 250000);
  check('and forwarded money is excluded from the kind totals',
    !kinds.some((k) => k.amount === 100000));

  // ── THE URL ─────────────────────────────────────────────────────────
  const u = D.receiptsUrl('C00912865', 2026, 'k', null, null);
  check('reads schedule_a', u.includes('/schedules/schedule_a/'));
  check('for the committee named', u.includes('committee_id=C00912865'));
  check('inside the cycle', u.includes('two_year_transaction_period=2026'));
  check('and does NOT exclude individuals — they are the question here',
    !u.includes('is_individual'));
  const paged = D.receiptsUrl('C1', 2026, 'k', 'IDX', '2025-01-01');
  check('keyset pagination carries both cursors',
    paged.includes('last_index=IDX')
    && paged.includes('last_contribution_receipt_date=2025-01-01'));

  // ── PARSING ─────────────────────────────────────────────────────────
  const p = D.parseReceipts({ results: [{
    contributor_name: 'DOE, JOHN', entity_type: 'ind',
    contribution_receipt_amount: '2500.50',
    contribution_receipt_date: '2025-06-01T00:00:00',
    contributor_employer: 'ACME', contributor_occupation: 'ENGINEER',
    contributor_city: 'COLUMBUS', contributor_state: 'OH',
  }] });
  eq('the amount becomes a number', p[0].amount, 2500.5);
  eq('the date is trimmed to a day', p[0].date, '2025-06-01');
  eq('the entity type is upper-cased so kindOf can read it', p[0].kind, 'IND');
  eq('employer is kept — it is how a company shows up as people', p[0].employer, 'ACME');
  eq('and occupation, for the same reason', p[0].occupation, 'ENGINEER');
  // City and state are carried on the row and assembled per donor.
  eq('the city survives parsing', p[0].city, 'COLUMBUS');
  eq('and the state', p[0].state, 'OH');
  eq('and byDonor turns them into one readable place',
    D.byDonor(p)[0].where, 'COLUMBUS, OH');
  eq('a donor with no city is not given a stray comma',
    D.byDonor([{ from: 'X', amount: 1, state: 'OH' }])[0].where, 'OH');

  const empty = D.parseReceipts({});
  eq('a response with no results is an empty list, not a crash', empty.length, 0);

  // ── PAGINATION ──────────────────────────────────────────────────────
  let call = 0;
  const fakeFetch = async () => {
    call += 1;
    if (call > 3) return { results: [], pagination: {} };
    return {
      results: [{ contributor_name: `D${call}`, contribution_receipt_amount: 100 }],
      pagination: { last_indexes: { last_index: `i${call}`,
        last_contribution_receipt_date: '2025-01-01' } },
    };
  };
  const got = await D.collect(fakeFetch, () => 'u', D.parseReceipts, 25, 400);
  eq('every page is collected', got.rows.length, 3);
  check('and an exhausted feed is not called truncated', got.truncated === false);

  call = 0;
  const endless = async () => ({
    results: [{ contributor_name: 'X', contribution_receipt_amount: 1 }],
    pagination: { last_indexes: { last_index: 'i', last_contribution_receipt_date: '2025-01-01' } },
  });
  const capped = await D.collect(endless, () => 'u', D.parseReceipts, 3, 400);
  eq('a page cap stops the pull', capped.pages, 3);
  check('and says so, so coverage can refuse to divide', capped.truncated === true);

  // ── A NEGATIVE ROW IS A REFUND, NOT A CATEGORY OF GIVING ────────────
  // A live run printed:
  //     -0.4%   $-4,351   candidate committees
  // Schedule A carries returned and redesignated contributions as negative
  // amounts. Netting them makes money that came in and went back out
  // disappear — and a donor whose gift was refunded can net to zero and
  // drop off the top-donor list, which is the quietest way to hide a name.
  const withRefund = [
    { from: 'GAVE PAC', kind: 'PAC', amount: 10000, date: '2025-03-01' },
    { from: 'REFUNDED PAC', kind: 'CCM', amount: 4351, date: '2025-04-01' },
    { from: 'REFUNDED PAC', kind: 'CCM', amount: -4351, date: '2025-09-01' },
  ];
  const rk = D.byKind(withRefund);
  const ccm = rk.find((k) => k.kind === 'candidate committees');
  eq('the positive side of a refunded gift is still counted', ccm.amount, 4351);
  eq('and the refund is reported apart from it', ccm.refunded, 4351);
  check('so no category shows a negative total',
    rk.every((k) => k.amount >= 0));

  const rf = D.refunds(withRefund);
  eq('every negative row is collected', rf.rows, 1);
  eq('as a positive amount, because it is a fact not a subtraction', rf.total, 4351);
  eq('and the name it went back to is kept', rf.to[0].name, 'REFUNDED PAC');

  const sr = D.summarise(withRefund, { receipts: 10000 }, false);
  check('a refunded donor still appears in the donor list',
    sr.donors.some((d) => d.name === 'REFUNDED PAC'));
  check('and the summary carries the refunds',
    sr.refunds.rows === 1 && sr.refunds.total === 4351);
  eq('a committee with no refunds reports none',
    D.refunds([{ from: 'X', amount: 100 }]).rows, 0);

  // An earmarked negative is still someone else's money, not a refund here.
  eq('a memo-coded negative is not counted as this committee\'s refund',
    D.refunds([{ from: 'CONDUIT', amount: -50, memo_code: 'X' }]).rows, 0);


  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${ran - fails}/${ran} checks\n`);
  return fails ? 1 : 0;
}

if (require.main === module) run().then((c) => process.exit(c));
module.exports = { run };
