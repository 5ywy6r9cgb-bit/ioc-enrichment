#!/usr/bin/env node
'use strict';
/** test_asymmetry.js — concentration, and the floor that keeps it honest. */

const A = require('./asymmetry.js');

let ran = 0, fails = 0;
function check(label, ok) {
  ran += 1; if (!ok) fails += 1;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
function eq(label, got, want) {
  check(`${label}${got === want ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
    got === want);
}

const rows = (n, target, each = 1000) =>
  Array.from({ length: n }, () => ({ amount: each, t: target }));
const T = (r) => r.t;

async function run() {
  console.log('\n  asymmetry — concentration, measured against its own base\n');

  // --- THE FLOOR. This is the whole file.
  // One expenditure is 100% concentrated by arithmetic. Reporting that the
  // same way as forty-four expenditures manufactures findings out of small
  // numbers.
  const one = A.concentrate([{ amount: 200, t: 'X' }], T);
  eq('a single row is NOT called concentrated', one.verdict, 'too_small');
  eq('its top share is still 100%, and still reported', one.top_share, 100);
  check('and the reason is stated, not implied',
    /arithmetic decides the answer/.test(one._caution));

  const smallDollars = A.concentrate(rows(8, 'X', 10), T);
  eq('enough rows but trivial money is still too small',
    smallDollars.verdict, 'too_small');

  const real = A.concentrate(rows(44, 'WASSERMAN SCHULTZ', 1242), T);
  eq('forty-four rows and real money IS a finding', real.verdict, 'single_target');
  eq('with every dollar on one target', real.top_share, 100);
  eq('and one distinct target', real.targets, 1);

  // --- the floor can be raised, and is reported so the reader knows it
  const strict = A.concentrate(rows(10, 'X'), T, { minRows: 50 });
  eq('a caller can demand more rows', strict.verdict, 'too_small');
  eq('and the floor used is on the result', strict.min_rows, 50);

  // --- two measures, because one hides things
  const even = A.concentrate(
    Array.from({ length: 50 }, (_, i) => ({ amount: 1000, t: `T${i}` })), T);
  eq('fifty even targets read as spread', even.verdict, 'spread');
  eq('with an HHI near zero', even.hhi, 0.02);
  eq('and fifty effective targets', even.effective_targets, 50);

  const three = A.concentrate([
    ...rows(10, 'A', 1000), ...rows(10, 'B', 1000), ...rows(10, 'C', 1000)], T);
  eq('three even targets is NARROW, not spread', three.verdict, 'narrow');
  eq('even though the top share is only a third', three.top_share, 33.3);
  check('which is exactly what a top share alone would miss',
    three.top_share < 40 && three.hhi >= 0.25);
  eq('and it reads as three effective targets', three.effective_targets, 3);

  const dominant = A.concentrate([
    ...rows(20, 'BIG', 5000), ...rows(5, 'small', 100)], T);
  eq('one target taking 95% is concentrated', dominant.verdict, 'concentrated');
  check('while still showing the others exist', dominant.targets === 2);

  // --- absence is not zero
  eq('no rows returns null, not an empty distribution',
    A.concentrate([], T), null);
  const free = A.concentrate([{ amount: 0, t: 'X' }, { amount: 0, t: 'Y' }], T);
  eq('rows carrying no dollars are reported as such', free.verdict, 'no_money');
  check('rather than dividing by zero', !('top_share' in free) || free.top_share === undefined);

  // --- ranking many actors
  const groups = new Map([
    ['SPREAD FUND', Array.from({ length: 40 }, (_, i) => ({ amount: 1000, t: `T${i}` }))],
    ['SINGLE FUND', rows(44, 'ONE TARGET', 1242)],
    ['TINY FUND', [{ amount: 50, t: 'ONE TARGET' }]],
    ['NARROW FUND', [...rows(10, 'A', 1000), ...rows(10, 'B', 1000), ...rows(10, 'C', 1000)]],
  ]);
  const ranked = A.rank(groups, { key: T });
  eq('the single-target committee ranks first', ranked[0].actor, 'SINGLE FUND');
  eq('then the narrow one', ranked[1].actor, 'NARROW FUND');
  eq('then the spread one', ranked[2].actor, 'SPREAD FUND');
  eq('and the one too small to judge sorts LAST, not first',
    ranked[3].actor, 'TINY FUND');
  check('which is the opposite of what sorting by percentage would do',
    ranked[3].top_share === 100 && ranked[3].verdict === 'too_small');

  // --- grouping
  const g = A.groupBy([
    { by: 'A', amount: 1 }, { by: 'A', amount: 2 }, { by: 'B', amount: 3 },
  ], (r) => r.by);
  eq('rows group by actor', g.size, 2);
  eq('and keep every row', g.get('A').length, 2);

  // --- the dimensions read the fields the FEC actually returns
  const D = A.DIMENSIONS;
  eq('the candidate dimension targets the candidate named',
    D.candidate.target({ candidate: 'DOE, JANE' }), 'DOE, JANE');
  eq('the committee dimension targets the committee spending',
    D.committee.target({ by: 'ATTACK FUND' }), 'ATTACK FUND');
  eq('the vendor dimension targets the payee',
    D.vendor.target({ recipient: 'MEDIA BUYER LLC' }), 'MEDIA BUYER LLC');
  check('an unnamed target does not vanish into one bucket with the rest',
    D.candidate.target({}) === '(unnamed candidate)');

  // --- what the verdicts say in words
  check('every verdict has a plain-language reading',
    Object.keys(A.VERDICTS).length >= 6
    && ['single_target', 'concentrated', 'narrow', 'spread', 'too_small', 'no_money']
      .every((v) => typeof A.VERDICTS[v] === 'string'));
  check('and a real finding carries the innocent explanations with it',
    /formed late|single-issue|lost early/.test(real._caution));

  // ── WHICH WAY THE MONEY POINTED ──────────────────────────────────────
  // The live run that forced this: AFP ACTION and WINSENATE both showed
  // HUSTED, JON high in their breakdowns. Read as "both spent at Husted"
  // they look like a pair. AFP spent $7.8m FOR him; WinSenate spent $3.2m
  // AGAINST him. They are opponents, and the merged view made them allies.
  // fecpac.byRecipient already refused to merge sides. asymmetry did not.
  const S = (r) => r.stance;
  const husted = [
    { amount: 7802141, t: 'HUSTED, JON', stance: 'S' },
    { amount: 3237241, t: 'HUSTED, JON', stance: 'O' },
    { amount: 2503666, t: 'HUSTED, JON', stance: 'O' },
    { amount: 1000000, t: 'ROGERS, MICHAEL J', stance: 'O' },
    { amount: 500000, t: 'ROGERS, MICHAEL J', stance: 'S' },
  ];
  const sided = A.concentrate(husted, T, { side: S });
  eq('the two directions are totalled apart', sided.sides.for, 8302141);
  eq('and not merged into one number', sided.sides.against, 6740907);
  eq('the total still reconciles to both',
    sided.sides.for + sided.sides.against, sided.total);
  const h = sided.breakdown.find((b) => b.name === 'HUSTED, JON');
  eq('each target carries its own split — for', h.for, 7802141);
  eq('and against', h.against, 5740907);
  check('so one candidate cannot read as a coalition',
    h.for > 0 && h.against > 0);

  // posture — what kind of instrument this committee is
  eq('a committee that only attacks says so',
    A.concentrate(rows(10, 'X').map((r) => ({ ...r, stance: 'O' })), T, { side: S })
      .sides.posture, 'opposition_only');
  eq('a committee that only defends says so',
    A.concentrate(rows(10, 'X').map((r) => ({ ...r, stance: 'S' })), T, { side: S })
      .sides.posture, 'support_only');
  eq('and a mixed one is named by its majority',
    sided.sides.posture, 'mostly_support');

  // NOT MEASURED is not the same as zero.
  const unsided = A.concentrate(rows(10, 'X'), T);
  eq('without a side accessor the split is absent, not zero',
    unsided.sides, undefined);
  check('which is what Schedule B rows get, because they carry no stance',
    unsided.sides === undefined && unsided.total > 0);

  // A missing indicator must not silently become "against".
  const blank = A.concentrate(
    rows(10, 'X').map((r) => ({ ...r, stance: '' })), T, { side: S });
  eq('a blank indicator counts as support, never as opposition',
    blank.sides.against, 0);

  // ── A NAME IS NOT AN IDENTITY ────────────────────────────────────────
  // Two views of the same money disagreed by $121,461:
  //   SLF PAC against BROWN, SHERROD
  //     from the CANDIDATE side (keyed on S6OH00163)  $4,508,418
  //     from the COMMITTEE side (keyed on the NAME)   $4,629,879
  // Neither run was truncated. The register holds TWO Sherrod Browns, and
  // grouping by the name string added them together — inventing a person
  // who is both. `member` refuses to choose between them; this module was
  // quietly merging them.
  const T2 = A.DIMENSIONS.candidate.target;
  const twoBrowns = [
    { candidate: 'BROWN, SHERROD', candidate_id: 'S6OH00163', amount: 4508418 },
    { candidate: 'BROWN, SHERROD', candidate_id: 'H2OH13033', amount: 121461 },
  ];
  const split = A.concentrate(twoBrowns, T2, { minRows: 1, minTotal: 1 });
  eq('two candidates sharing a name stay two targets', split.targets, 2);
  eq('and the larger keeps its own figure', split.breakdown[0].amount, 4508418);
  eq('rather than the sum of both', split.total, 4629879);

  eq('the reader still sees a name, not a key',
    A.displayName(split.breakdown[0].name), 'BROWN, SHERROD');
  eq('with the id available beside it',
    A.keyId(split.breakdown[0].name), 'S6OH00163');

  // One person filing under one id must still be ONE target.
  const oneBrown = A.concentrate([
    { candidate: 'BROWN, SHERROD', candidate_id: 'S6OH00163', amount: 100 },
    { candidate: 'BROWN, SHERROD', candidate_id: 'S6OH00163', amount: 200 },
  ], T2, { minRows: 1, minTotal: 1 });
  eq('the same candidate twice is one target', oneBrown.targets, 1);
  eq('with the amounts summed', oneBrown.total, 300);

  // No id at all: fall back to the name rather than dropping the row.
  const noId = A.concentrate([{ candidate: 'DOE, JANE', amount: 500 }],
    T2, { minRows: 1, minTotal: 1 });
  eq('a row with no candidate id still groups by name',
    A.displayName(noId.breakdown[0].name), 'DOE, JANE');
  eq('and carries no id to display', A.keyId(noId.breakdown[0].name), '');
  eq('an unidentified row is labelled, not blank',
    A.displayName(A.concentrate([{ amount: 1 }], T2,
      { minRows: 1, minTotal: 1 }).breakdown[0].name), '(unnamed candidate)');

  // The committee dimension has the same trap in reverse.
  const CT = A.DIMENSIONS.committee.target;
  const twoPacs = A.concentrate([
    { by: 'AMERICA PAC', by_committee_id: 'C00111111', amount: 1000 },
    { by: 'AMERICA PAC', by_committee_id: 'C00222222', amount: 2000 },
  ], CT, { minRows: 1, minTotal: 1 });
  eq('two committees sharing a name stay two targets', twoPacs.targets, 2);

  // displayName must be safe on anything.
  eq('displayName passes an ordinary string through', A.displayName('PLAIN'), 'PLAIN');
  eq('and keyId returns empty for one', A.keyId('PLAIN'), '');


  // ── WHAT THE COMMITTEE SAID IT WAS BUYING ────────────────────────────
  // SOCKO STRATEGIES, QUINTUS LLC and IRONCLAD CONSULTING were paid by
  // three and four Husted-adjacent committees and this desk called them
  // "unidentified". OpenCorporates could not fix that — a registry records
  // INCORPORATION, not what a firm does. The committees had already told
  // the FEC in the disbursement description, and this module was throwing
  // it away.
  const VT = A.DIMENSIONS.vendor.target;
  const withWhy = A.concentrate([
    { recipient: 'SOCKO STRATEGIES', amount: 200000, purpose: 'DIGITAL ADVERTISING' },
    { recipient: 'SOCKO STRATEGIES', amount: 73043, purpose: 'CONSULTING' },
    { recipient: 'SOCKO STRATEGIES', amount: 5, purpose: 'POSTAGE' },
    { recipient: 'BROGHAMER COMPLIANCE', amount: 13639, purpose: 'COMPLIANCE SERVICES' },
  ], VT, { minRows: 1, minTotal: 1 });

  const socko = withWhy.breakdown.find((b) => b.name === 'SOCKO STRATEGIES');
  eq('a vendor carries what it was paid FOR', socko.purposes[0].text, 'DIGITAL ADVERTISING');
  eq('with the money behind that description', socko.purposes[0].amount, 200000);
  eq('and the second purpose too', socko.purposes[1].text, 'CONSULTING');

  // RANKED BY MONEY, not by row order. A $5 postage line must not become
  // the label on a six-figure relationship.
  check('a trivial line does not label a large relationship',
    socko.purposes[0].amount > socko.purposes[2].amount * 1000);
  eq('at most three purposes are kept', socko.purposes.length, 3);

  // Repeat descriptions are summed, not listed twice.
  const repeated = A.concentrate([
    { recipient: 'V', amount: 100, purpose: 'MEDIA' },
    { recipient: 'V', amount: 900, purpose: 'MEDIA' },
  ], VT, { minRows: 1, minTotal: 1 }).breakdown[0];
  eq('one description across two rows is one entry', repeated.purposes.length, 1);
  eq('with the amounts added', repeated.purposes[0].amount, 1000);

  // A row with no purpose must not create a blank entry.
  const noWhy = A.concentrate([
    { recipient: 'V', amount: 500 },
    { recipient: 'V', amount: 500, purpose: '   ' },
  ], VT, { minRows: 1, minTotal: 1 }).breakdown[0];
  eq('an empty purpose creates no entry', noWhy.purposes.length, 0);
  eq('and the amount is still counted', noWhy.amount, 1000);


  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${ran - fails}/${ran} checks\n`);
  return fails ? 1 : 0;
}

if (require.main === module) run().then((c) => process.exit(c));
module.exports = { run };
