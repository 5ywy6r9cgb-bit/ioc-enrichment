'use strict';

/** test_awards — federal contracts, past the first page, with what they bought. */

const A = require('./awards.js');

let pass = 0; let fail = 0;
function check(what, ok) {
  if (ok) { pass += 1; console.log(`    PASS  ${what}`); }
  else { fail += 1; console.log(`    FAIL  ${what}`); }
}
function eq(what, got, want) {
  check(`${what}${got === want ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
    got === want);
}

const row = (name, amount, agency, extra = {}) => ({
  name, amount: `$${Number(amount).toLocaleString()}`, agency, ...extra,
});

console.log('\n  the substring problem, which is worst in this register');
{
  // THE LIVE FAILURES. recipient_search_text is fuzzy, and the list is
  // sorted by amount, so the noise sits at the TOP.
  eq('"Ntrepid" is not a word in INTREPID LLC',
    A.namesMatch('Ntrepid', 'INTREPID LLC'), false);
  eq('and "Ring LLC" is not a word in LEIDOS ENGINEERING LLC',
    A.namesMatch('Ring LLC', 'LEIDOS ENGINEERING LLC'), false);
  eq('nor in CONTRACTING, CONSULTING, ENGINEERING LLC',
    A.namesMatch('Ring LLC', 'CONTRACTING, CONSULTING, ENGINEERING LLC'), false);
  // THE FLAW THIS TEST CAUGHT. Requiring every query word to appear meant
  // "Ntrepid Corporation" classified the REAL NTREPID, LLC rows as noise and
  // excluded them from every total — the operator would have seen zero clean
  // awards and no way to tell that from a company with no contracts.
  // A corporate suffix carries no identity; it comes off both sides.
  eq('the real recipient survives the suffix mismatch',
    A.namesMatch('Ntrepid Corporation', 'NTREPID, LLC'), true);
  eq('and the bare name still matches', A.namesMatch('Ntrepid', 'NTREPID, LLC'), true);
  eq('suffixes are stripped, not matched', A.normaliseName('NTREPID, LLC'), 'ntrepid');
  eq('from the query too', A.normaliseName('Ntrepid Corporation'), 'ntrepid');
  eq('and from a multi-word name', A.normaliseName('LEIDOS ENGINEERING LLC'), 'leidos engineering');
  // Stripping suffixes must not resurrect the namesake.
  eq('INTREPID is still not NTREPID after stripping',
    A.namesMatch('Ntrepid Corporation', 'INTREPID LLC'), false);
  eq('nor is ENGINEERING still RING',
    A.namesMatch('Ring LLC', 'VERACITY ENGINEERING LLC'), false);
  // A name that is ONLY a suffix must not match everything.
  eq('a query that is nothing but a suffix matches nothing',
    A.namesMatch('LLC', 'ANY COMPANY LLC'), false);
  eq('and an exact name matches', A.namesMatch('Meta Platforms', 'META PLATFORMS, INC.'), true);
  eq('case and punctuation do not matter',
    A.namesMatch('ntrepid', 'Ntrepid  Corporation.'), true);
  eq('an empty query matches nothing', A.namesMatch('', 'ANYTHING'), false);

  const { clean, substring } = A.classify('Ntrepid', [
    row('INTREPID LLC', 441453959, 'Department of Defense'),
    row('NTREPID, LLC', 6919191, 'Department of Defense'),
    row('DELTA SOLUTIONS & STRATEGIES LLC', 121171513, 'Department of Defense'),
  ]);
  eq('the $441m namesake is separated', substring.length, 2);
  eq('and the real one is kept', clean.length, 1);
  eq('which is the one actually asked for', clean[0].name, 'NTREPID, LLC');
  // The whole point: a total must never include the namesake.
  eq('the total excludes the noise', A.byAgency(clean).total, 6919191);
}

console.log('\n  who bought it');
{
  const { agencies, total } = A.byAgency([
    row('N', 6919191, 'Department of Defense'),
    row('N', 3409008, 'Department of Defense'),
    row('N', 2499724, 'Department of Justice'),
  ]);
  eq('grouped by awarding agency', agencies.length, 2);
  eq('largest buyer first', agencies[0].agency, 'Department of Defense');
  eq('amounts summed per agency', agencies[0].amount, 10328199);
  eq('awards counted', agencies[0].count, 2);
  eq('the largest single award is kept', agencies[0].largest, 6919191);
  eq('and the total is the sum of what was listed', total, 12827923);
  eq('a missing agency is labelled, not blank',
    A.byAgency([row('N', 1, '')]).agencies[0].agency, '(agency not stated)');
}

console.log('\n  names as filed, never merged on plausibility');
{
  const rows = A.byRecipient([
    row('NTREPID, LLC', 100, 'DoD'), row('NTREPID, LLC', 50, 'DoD'),
    row('NTREPID CORPORATION', 25, 'DOJ'),
  ]);
  eq('two filed names stay two', rows.length, 2);
  eq('ranked by money', rows[0].name, 'NTREPID, LLC');
  eq('with their own totals', rows[0].amount, 150);
  eq('and their own counts', rows[0].count, 2);
}

console.log('\n  the description, which the sweep was dropping');
{
  const rows = [
    { description: 'ONLINE PERSONA MANAGEMENT SERVICE for the Government' },
    { description: 'persona management software licences' },
    { description: 'Janitorial services' },
  ];
  const w = A.descriptionWords(rows, 2);
  const words = w.map((x) => x.word);
  check('a word in two descriptions is reported', words.includes('persona'));
  check('and so is the second half of the phrase', words.includes('management'));
  check('a word in one description is not', !words.includes('janitorial'));
  eq('counted in DOCUMENTS, not repetitions',
    A.descriptionWords([{ description: 'persona persona persona' },
      { description: 'persona' }], 2)[0].awards, 2);
  check('stop words are dropped',
    !A.descriptionWords([{ description: 'the services and the contract' },
      { description: 'the services and the contract' }], 2)
      .some((x) => ['the', 'and', 'services', 'contract'].includes(x.word)));
  check('short words are dropped',
    !A.descriptionWords([{ description: 'ai ai' }, { description: 'ai' }], 1)
      .some((x) => x.word === 'ai'));
  check('bare numbers are dropped',
    !A.descriptionWords([{ description: '2011 2011' }, { description: '2011' }], 2)
      .some((x) => /^\d+$/.test(x.word)));
  eq('no descriptions, no words', A.descriptionWords([{}, {}]).length, 0);
}

console.log('\n  the period covered');
{
  const s = A.span([
    { period: '2010-10-27 → 2014-03-01' },
    { period: '2008-01-15 → 2009-06-30' },
    { period: '' },
  ]);
  eq('earliest start', s.first, '2008-01-15');
  eq('latest end', s.last, '2014-03-01');
  eq('no dates, no span', A.span([{ period: 'n/a' }]).first, '');
}

console.log('\n  amounts');
{
  eq('a formatted amount parses back', A.amountOf({ amount: '$6,919,191' }), 6919191);
  eq('decimals survive', A.amountOf({ amount: '$3,409,008.23' }), 3409008.23);
  eq('a missing amount is zero, not NaN', A.amountOf({}), 0);
  eq('so is unparseable text', A.amountOf({ amount: 'n/a' }), 0);
}

console.log(`\n  ${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks\n`);
process.exit(fail ? 1 : 0);
