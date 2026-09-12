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


console.log('\n  a query that shrinks to nothing must not match everything');
{
  // THE LIVE X CORP RUN. "X Corp" normalises to "x" once the suffix comes
  // off, and usaspending returned RTX CORPORATION at $8.69bn, $7.91bn,
  // $7.50bn and $4.87bn — plus CONDUENT EDUCATION SOLUTIONS at $2.25bn,
  // which the substring guard did not even flag.
  eq('"X Corp" is flagged as too short to filter', A.tooShortToFilter('X Corp'), true);
  eq('so is a bare initial', A.tooShortToFilter('X'), true);
  eq('but a real name is not', A.tooShortToFilter('Ntrepid Corporation'), false);
  eq('nor a short real name', A.tooShortToFilter('Snap Inc'), false);

  eq('RTX CORPORATION is not X Corp', A.namesMatch('X Corp', 'RTX CORPORATION'), false);
  eq('nor is XEROX', A.namesMatch('X Corp', 'XEROX HOLDINGS CORPORATION'), false);
  eq('nor XERION', A.namesMatch('X Corp', 'XERION ADVANCED BATTERY CORP.'), false);
  // The one the substring guard missed entirely.
  eq('nor CONDUENT at $2.25bn',
    A.namesMatch('X Corp', 'CONDUENT EDUCATION SOLUTIONS, LLC'), false);
  eq('the exact name still matches', A.namesMatch('X Corp', 'X Corp.'), true);

  const { clean, substring } = A.classify('X Corp', [
    row('RTX CORPORATION', 8688654906, 'Department of Defense'),
    row('CONDUENT EDUCATION SOLUTIONS, LLC', 2245583010, 'Department of Education'),
    row('X Corp.', 190000, 'n/a'),
  ]);
  eq('only the exact stem survives', clean.length, 1);
  eq('and it is the right one', clean[0].name, 'X Corp.');
  eq('the billions are separated', substring.length, 2);
  // The whole point: a headline total must never carry $8.69bn of RTX.
  eq('and excluded from the total', A.byAgency(clean).total, 190000);

  check('the command warns before showing anything',
    /leaves almost nothing to match on/.test(
      require('fs').readFileSync(require('path').join(__dirname, 'cli.js'), 'utf8')));
}


console.log('\n  IGF:: is the government classifying its own purchase');
{
  // Ntrepid's DEA descriptions carry these. Under OFPP Policy Letter 11-01
  // the contracting officer must tag how close the work sits to an
  // inherently governmental function. This desk was rendering it as
  // gibberish in the middle of a sentence.
  eq('CL is decoded', A.igfMarkers('IGF::CL::IGF')[0].code, 'CL');
  check('with its meaning spelled out',
    /CLOSELY ASSOCIATED/.test(A.igfMarkers('IGF::CL::IGF')[0].means));
  eq('OT too', A.igfMarkers('IGF::OT::IGF SOFTWARE')[0].code, 'OT');
  eq('and CT', A.igfMarkers('IGF::CT::IGF')[0].code, 'CT');
  eq('an unknown code is not invented', A.igfMarkers('IGF::ZZ::IGF').length, 0);
  eq('no marker, nothing claimed', A.igfMarkers('SOFTWARE LICENSE').length, 0);
  eq('a repeated marker is reported once', A.igfMarkers('IGF::CL::IGF IGF::CL::IGF').length, 1);

  eq('the description reads without the marker',
    A.plainDescription('IGF::OT::IGF RENEWAL OF MAPPER LICENSES IN SUPPORT OF FOXFIRE'),
    'RENEWAL OF MAPPER LICENSES IN SUPPORT OF FOXFIRE');
  eq('a description that is ONLY a marker becomes empty',
    A.plainDescription('IGF::CL::IGF'), '');
  // The markers must not dominate a frequency count: they appear on every
  // service contract and say nothing about subject matter.
  check('marker tokens are kept out of the word count',
    !A.descriptionWords([{ description: 'IGF::CL::IGF software' },
      { description: 'IGF::OT::IGF software' }], 2)
      .some((w) => /^igf$/.test(w.word)));
}

console.log('\n  instruments — the filter that manufactured an absence');
{
  // THE LIVE DEFECT. `awards "Intel Corporation"` returned 37 awards worth
  // $2,877,287 of NASA software licence renewals and no CHIPS money, and the
  // reader's only available conclusion was that there is none. CHIPS is
  // financial assistance; the query asked for contracts and could not be
  // told otherwise.
  eq('the default is still contracts', A.instrumentsFor({})[0].key, 'contracts');
  eq('and only contracts', A.instrumentsFor({}).length, 1);
  eq('because a silent change of denominator between runs is its own lie',
    A.instrumentsFor({}).map((i) => i.codes).flat().join(','), 'A,B,C,D');

  eq('--grants asks for assistance', A.instrumentsFor({ grants: true })[0].key, 'grants');
  eq('with the codes the API wants',
    A.instrumentsFor({ grants: true })[0].codes.join(','), '02,03,04,05');
  // The one that matters for CHIPS.
  eq('--direct is where CHIPS incentives are reported',
    A.instrumentsFor({ direct: true })[0].codes.join(','), '06,10');
  check('and the command says so',
    /CHIPS/.test(A.instrument('direct').means));
  eq('--loans is face value, not money',
    A.instrumentsFor({ loans: true })[0].codes.join(','), '07,08');
  check('which the label refuses to let the reader forget',
    /FACE VALUE/.test(A.instrument('loans').means));

  // THE SAME MISTAKE, ONE COMMIT LATER. §61 shipped --all over four
  // families and a footer claiming completeness. Assistance types 09 and 11
  // were not among them, and 11 is the catch-all an agency reaches for when
  // an award fits none of the named forms — which is exactly where a large,
  // novel industrial-policy payment would land.
  eq('--all asks every family the API defines', A.instrumentsFor({ all: true }).length, 5);
  check('including the catch-all',
    A.instrumentsFor({ all: true }).some((i) => i.key === 'other'));
  eq('which is 09 and 11', A.instrument('other').codes.join(','), '09,11');
  check('and every assistance code is covered exactly once', (() => {
    const all = A.INSTRUMENTS.filter((i) => i.key !== 'contracts')
      .map((i) => i.codes).flat().sort();
    return all.join(',') === '02,03,04,05,06,07,08,09,10,11'
      && new Set(all).size === all.length;
  })());
  eq('and --all beats a single pick',
    A.instrumentsFor({ all: true, grants: true }).length, 5);
  eq('two picks are both honoured',
    A.instrumentsFor({ grants: true, direct: true }).map((i) => i.key).join(','),
    'grants,direct');

  // USAspending validates `fields` against the award types asked for, so one
  // request per family is not a style choice — a mixed list returns 400.
  check('a contract query asks for the contract type field',
    A.instrument('contracts').fields.includes('Contract Award Type'));
  check('and not the assistance one',
    !A.instrument('contracts').fields.includes('Award Type'));
  check('an assistance query asks for the other one',
    A.instrument('grants').fields.includes('Award Type'));
  check('and not the contract one',
    !A.instrument('grants').fields.includes('Contract Award Type'));
  // A loan is not a purchase and the API does not pretend it is: there is
  // no Award Amount and no Start Date in that family at all.
  check('a loan query does not ask for an Award Amount',
    !A.instrument('loans').fields.includes('Award Amount'));
  check('it asks for the face value', A.instrument('loans').fields.includes('Loan Value'));
  check('and for the expected loss', A.instrument('loans').fields.includes('Subsidy Cost'));
  check('and it does not ask for a Start Date',
    !A.instrument('loans').fields.includes('Start Date'));
  eq('so it sorts by the field it actually has',
    A.instrument('loans').sort, 'Loan Value');
  eq('while the rest sort by amount', A.instrument('grants').sort, 'Award Amount');
  check('every family asks for the description',
    A.INSTRUMENTS.every((i) => i.fields.includes('Description')));
  check('and for who bought',
    A.INSTRUMENTS.every((i) => i.fields.includes('Awarding Agency')));
  eq('an unknown family is not invented', A.instrument('bonds'), null);

  check('the command warns about what it did NOT ask for',
    /NOT ASKED FOR/.test(
      require('fs').readFileSync(require('path').join(__dirname, 'cli.js'), 'utf8')));
  check('and refuses a cross-instrument sum in so many words',
    /never summed/.test(
      require('fs').readFileSync(require('path').join(__dirname, 'cli.js'), 'utf8')));
}

console.log('\n  raw FPDS dumps are not descriptions');
{
  // The live row: SCIENTIFIC MONITORING's Description field held the
  // pipe-delimited FPDS transaction record, which was being wrapped across
  // four lines under the heading "What the money bought".
  const dump = '200505!000720!5700!FA8104!F33615-03-D-2354!0!FA810405F0037!0!'
    + '2005-05-11!25000.00!!SCIENTIFIC MONITORING INC';
  check('a pipe-delimited transaction record is detected', A.isRawFpds(dump));
  check('ordinary prose is not',
    !A.isRawFpds('RENEWAL OF MAPPER LICENSES IN SUPPORT OF FOXFIRE'));
  check('nor is a description with one emphatic mark',
    !A.isRawFpds('URGENT! SOFTWARE MAINTENANCE'));
  check('nor an empty field', !A.isRawFpds(''));

  // The reason it matters: every numeric stem in that dump was being fed to
  // a list the reader is told describes subject matter.
  const w = A.descriptionWords([{ description: dump }, { description: dump }], 2);
  eq('a dump contributes no words at all', w.length, 0);
  check('while real descriptions beside it still count',
    A.descriptionWords([{ description: dump },
      { description: 'persona management software' },
      { description: 'persona management licences' }], 2)
      .some((x) => x.word === 'persona'));
}

console.log('\n  a blank amount is not a zero');
{
  // THE LIVE ROW. DARPA cooperative agreement HR00112120015 came back with a
  // null Award Amount and a description stating in words that the value had
  // been increased to $9,413,419. It displayed as "—", contributed $0, and
  // a $23,112,150 family total was printed over a known unlisted $9.4m.
  const g = A.byAgency([
    row('INTEL FEDERAL LLC', 8353806, 'Department of Energy'),
    { name: 'INTEL FEDERAL LLC', agency: 'Department of Defense' },   // no amount at all
    { name: 'INTEL FEDERAL LLC', amount: '', agency: 'Department of Defense' },
  ]);
  eq('the blanks are counted', g.noAmount, 2);
  eq('and not invented into the total', g.total, 8353806);
  eq('a stated amount is never counted as missing',
    A.byAgency([row('N', 1, 'X')]).noAmount, 0);
  check('and the command calls the total a floor when any is blank',
    /no amount stated/.test(
      require('fs').readFileSync(require('path').join(__dirname, 'cli.js'), 'utf8')));
}

console.log('\n  a programme is not a set of decisions');
{
  // THE LIVE GOOGLE RUN. 387 FCC direct payments, every one carrying the
  // same Affordable Connectivity Program paragraph. The word list read
  // "obligation 387 · afford 386 · affordable 386 …" — a description of the
  // paragraph — and the paragraph itself was printed twelve times.
  const acp = 'THE AFFORDABLE CONNECTIVITY PROGRAM IS AN FCC BENEFIT PROGRAM '
    + 'THAT HELPS ENSURE THAT HOUSEHOLDS CAN AFFORD THE BROADBAND THEY NEED.';
  const many = [];
  for (let i = 0; i < 20; i += 1) {
    many.push(row('GOOGLE LLC', 50000 + i, 'Federal Communications Commission',
      // the obligation id differs on every otherwise identical row
      { description: `${acp} 002110528${i} ACP OBLIGATION` }));
  }
  eq('differing ids do not split the boilerplate',
    A.descriptionGroups(many).length, 1);
  eq('and the group carries the count', A.descriptionGroups(many)[0].count, 20);
  eq('and their money', A.descriptionGroups(many)[0].amount, 1000190);

  const dom = A.dominantDescription(many);
  check('it is reported as one description', dom !== null);
  eq('covering all of them', dom.count, 20);
  eq('out of all of them', dom.of, 20);

  // A real register of distinct purchases must NOT be collapsed.
  const distinct = [
    row('N', 1, 'X', { description: 'PERSONA MANAGEMENT SOFTWARE' }),
    row('N', 2, 'X', { description: 'VEHICLE LEASE FOR DEA' }),
    row('N', 3, 'X', { description: 'ANNUAL FREESTATE LICENSE' }),
    row('N', 4, 'X', { description: 'NETWORK OBFUSCATION SERVICE' }),
    row('N', 5, 'X', { description: 'MAPPER LICENSES FOR FOXFIRE' }),
    row('N', 6, 'X', { description: 'TRAINING FOR FBI PERSONNEL' }),
  ];
  eq('six different purchases stay six', A.descriptionGroups(distinct).length, 6);
  eq('and nothing is called a programme', A.dominantDescription(distinct), null);

  // The threshold is deliberately strict — a handful of repeats is a phrase,
  // not a policy.
  eq('four identical rows are not enough to call it a programme',
    A.dominantDescription([
      row('N', 1, 'X', { description: 'SOFTWARE RENEWAL' }),
      row('N', 2, 'X', { description: 'SOFTWARE RENEWAL' }),
      row('N', 3, 'X', { description: 'SOFTWARE RENEWAL' }),
      row('N', 4, 'X', { description: 'SOFTWARE RENEWAL' }),
    ]), null);
  // Half boilerplate, half real work: the boilerplate is still the finding,
  // but the real work must not be swallowed by it.
  const mixed = many.slice(0, 10).concat(distinct);
  eq('a mixed register keeps its distinct rows',
    A.descriptionGroups(mixed).length, 7);
  eq('and the dominant group is still named',
    A.dominantDescription(mixed).count, 10);

  eq('a row with no description forms no group',
    A.descriptionGroups([{ description: '' }, {}]).length, 0);
  check('the command says obligations, not decisions',
    /not\s+\$\{dom\.count\} separate decisions|separate decisions/.test(
      require('fs').readFileSync(require('path').join(__dirname, 'cli.js'), 'utf8')));
}

console.log(`\n  ${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks\n`);
process.exit(fail ? 1 : 0);
