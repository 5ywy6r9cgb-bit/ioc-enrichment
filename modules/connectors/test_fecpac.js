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

  // --- the whole path, offline. Every piece above passed while the command
  // that calls them died on `Assignment to constant variable` — the parts
  // were tested and the wiring was not.
  require('./cli.js');   // throws on a syntax error before anything runs
  let served = 0;
  const wired = async (url) => {
    if (/schedule_b/.test(url)) {
      served += 1;
      return { results: served > 1 ? [] : [
        { recipient_name: 'A FOR CONGRESS', disbursement_amount: 5000,
          disbursement_date: '2022-03-01', disbursement_type: '24K',
          recipient_committee_id: 'C9' },
        { recipient_name: 'B FOR CONGRESS', disbursement_amount: 900,
          disbursement_date: '2022-04-01', disbursement_type: '24K',
          recipient_committee_id: 'C8', memo_code: 'X' },
        { recipient_name: 'C OUT OF CYCLE', disbursement_amount: 700,
          disbursement_date: '2026-04-01', disbursement_type: '24K',
          recipient_committee_id: 'C7' },
      ], pagination: {} };
    }
    return { results: [], pagination: {} };
  };
  const walk = await F.collect(wired, () => 'schedule_b', F.parseDisbursements, 3, 0);
  const kept = F.clampToCycle(walk.rows.filter(F.isContribution), 2022);
  const s2 = F.splitConduit(kept.kept);
  eq('collect → filter → clamp → split runs end to end', kept.dropped.length, 1);
  eq('and own funds come out alone', s2.own_usd, 5000);
  eq('with forwarded money beside it, not inside it', s2.forwarded_usd, 900);

  // ══ 390 ROWS AND A ZERO ═══════════════════════════════════════════════
  // TEAM HUSTED (C00896928) is a JOINT FUNDRAISING COMMITTEE. A live run
  // read 390 Schedule B rows and printed:
  //
  //     $0  in 0 DIRECT CONTRIBUTION(S) to other committees
  //
  // True of contributions, false about the committee, and silent about 390
  // rows of real money. A JFC exists to transfer to its PARTICIPANTS, and a
  // transfer is not coded as a contribution — so the only question worth
  // asking of a JFC was answered with a zero.
  //
  // A tool may filter. It may not read rows and then not say what they were.
  {
    const jfc = [
      { recipient: 'FRIENDS OF SOMEONE', recipient_committee_id: 'C00111111',
        amount: 250000, type: '18J', purpose: 'TRANSFER TO PARTICIPANT' },
      { recipient: 'A SUPER PAC', recipient_committee_id: 'C00222222',
        amount: 513230, type: '18J', purpose: 'TRANSFER TO PARTICIPANT' },
      { recipient: 'PRINTER LLC', recipient_committee_id: '',
        amount: 4000, type: '001', purpose: 'PRINTING' },
      { recipient: 'A DONOR', recipient_committee_id: '',
        amount: 1000, type: '20Y', purpose: 'REFUND' },
      // Must be excluded — already reported as a contribution.
      { recipient: 'A CAMPAIGN', recipient_committee_id: 'C00333333',
        amount: 5000, type: '24K', purpose: '' },
      // Must be excluded — someone else's money passing through.
      { recipient: 'A CAMPAIGN', recipient_committee_id: 'C00333333',
        amount: 9000, type: '18J', memo_code: 'X', purpose: 'EARMARK' },
    ];
    const r = F.residual(jfc);

    eq('rows the contribution filter dropped are counted, not lost', r.rows, 4);
    eq('and their money is totalled', r.total, 768230);
    check('a contribution is NOT double-counted into the residue',
      !r.by_type.some((t) => t.type === '24K'));
    check('nor is an earmarked pass-through',
      r.total === 768230 && !JSON.stringify(r.by_type).includes('9000'));

    eq('the largest residual type leads', r.by_type[0].type, '18J');
    eq('with both of its rows', r.by_type[0].rows, 2);
    eq('and an example of what the code meant',
      r.by_type[0].example, 'TRANSFER TO PARTICIPANT');
    check('the housekeeping codes are present too, not swept up',
      r.by_type.some((t) => t.type === '001') && r.by_type.some((t) => t.type === '20Y'));

    // The rows that answer "who are the participants".
    eq('payments to COMMITTEES are separated out', r.to_committees.length, 2);
    eq('largest first', r.to_committees[0].name, 'A SUPER PAC');
    eq('at the filed amount', r.to_committees[0].amount, 513230);
    eq('carrying the committee id so it can be looked up',
      r.to_committees[0].committee_id, 'C00222222');
    check('and rent/payroll, which have no committee id, are not in that list',
      !r.to_committees.some((c) => c.name === 'PRINTER LLC'));

    // An uncoded row must not vanish into a blank key.
    const untyped = F.residual([{ recipient: 'X', amount: 100, type: '' }]);
    eq('a row with no type is labelled, not blank',
      untyped.by_type[0].type, '(no type coded)');

    eq('a committee with nothing left over reports nothing left over',
      F.residual([{ recipient: 'Y', recipient_committee_id: 'C1',
        amount: 5000, type: '24K' }]).rows, 0);
  }


  // ══ "LEADERSHIP PAC" NAMES A CATEGORY, NOT A PERSON ═══════════════════
  // A live lookup returned:
  //   JOBS OPPORTUNITY NOW POLITICAL ACTION COMMITTEE
  //     PAC - Qualified · Leadership PAC · first filed 2025-01-27
  // A leadership PAC is established BY a candidate or officeholder, so that
  // designation says a politician stands behind it without saying which —
  // and the obvious guess from the surrounding context is exactly the
  // inference refused everywhere else in this repo. The FEC discloses the
  // sponsor. It simply was not being read.
  {
    const withSponsor = F.parseCommittees({ results: [{
      committee_id: 'C00000009', name: 'SOME LEADERSHIP PAC',
      designation_full: 'Leadership PAC',
      sponsor_candidate_list: [{ candidate_id: 'S6XX00001', name: 'DOE, JANE' }],
    }] })[0];
    eq('a sponsor is read from the register', withSponsor.sponsors[0], 'DOE, JANE');
    check('and reported in words', /sponsor: DOE, JANE/.test(F.affiliationOf(withSponsor)));

    const idsOnly = F.parseCommittees({ results: [{
      committee_id: 'C00000010', name: 'X', sponsor_candidate_ids: ['S6XX00002'],
    }] })[0];
    check('a sponsor given only as an id is still surfaced',
      /S6XX00002/.test(F.affiliationOf(idsOnly)));

    const conn = F.parseCommittees({ results: [{
      committee_id: 'C00000011', name: 'Y',
      connected_organization_name: 'SOME CORPORATION',
    }] })[0];
    check('a connected PAC names its corporation',
      /connected to: SOME CORPORATION/.test(F.affiliationOf(conn)));

    const auth = F.parseCommittees({ results: [{
      committee_id: 'C00000012', name: 'Z', candidate_ids: ['S6OH00999'],
    }] })[0];
    check('an authorised committee names its candidate',
      /candidate: S6OH00999/.test(F.affiliationOf(auth)));

    // SILENCE IS SILENCE. An unstated sponsor must produce no line at all,
    // never an empty "sponsor:" that reads as "nobody".
    const bare = F.parseCommittees({ results: [{ committee_id: 'C00000013', name: 'Q' }] })[0];
    eq('a committee with no stated affiliation yields no claim',
      F.affiliationOf(bare), '');
    eq('and its sponsor list is empty rather than undefined',
      bare.sponsors.length, 0);

    // Malformed shapes must not throw mid-lookup.
    const junk = F.parseCommittees({ results: [{
      committee_id: 'C00000014', name: 'R',
      sponsor_candidate_list: 'not an array', candidate_ids: null,
    }] })[0];
    eq('a non-array sponsor field is ignored, not crashed on',
      junk.sponsors.length, 0);
    eq('and so is a null candidate list', junk.candidate_ids.length, 0);
  }


  // ══ AN ID IS NOT A NAME ═══════════════════════════════════════════════
  // A live run printed `sponsor: S6OH00304` — correct, disclosed, and
  // useless. An id sitting four rows below a named committee invites the
  // reader to assume whose it is, which is the one inference this desk
  // never makes. Resolving costs one call.
  {
    const asked = [];
    const fake = async (url) => {
      asked.push(url);
      return { results: [{ candidate_id: 'S6OH00304', name: 'PUBLIC, JOHN Q' }] };
    };
    const c = F.parseCommittees({ results: [{
      committee_id: 'C00000021', name: 'A LEADERSHIP PAC',
      sponsor_candidate_ids: ['S6OH00304'],
    }] })[0];

    const r = await F.resolveSponsors(c, 'KEY', fake);
    check('a sponsor id is resolved to a name', /PUBLIC, JOHN Q/.test(F.affiliationOf(r)));
    check('and the id is kept beside it, so the row stays checkable',
      /S6OH00304/.test(F.affiliationOf(r)));
    check('the lookup asks the candidate register', /candidates\/search/.test(asked[0]));
    check('for that id specifically', /candidate_id=S6OH00304/.test(asked[0]));

    // A failure must leave the truth in place, not blank it.
    const boom = async () => { throw new Error('network'); };
    const failed = await F.resolveSponsors(c, 'KEY', boom);
    eq('an unresolvable id stays an id rather than vanishing',
      failed.sponsors[0], 'S6OH00304');

    // Nothing to resolve must cost nothing.
    let calls = 0;
    const counted = async () => { calls += 1; return { results: [] }; };
    await F.resolveSponsors(
      F.parseCommittees({ results: [{ committee_id: 'C00000022', name: 'X' }] })[0],
      'KEY', counted);
    eq('a committee with no sponsor makes no call', calls, 0);

    // A name already present is not re-fetched or mangled.
    const named = F.parseCommittees({ results: [{
      committee_id: 'C00000023', name: 'Y',
      sponsor_candidate_list: [{ name: 'ALREADY, NAMED' }],
    }] })[0];
    calls = 0;
    const kept = await F.resolveSponsors(named, 'KEY', counted);
    eq('a sponsor already named is left alone', kept.sponsors[0], 'ALREADY, NAMED');
    eq('and costs no call either', calls, 0);
  }


  const cliSrc2 = require('fs').readFileSync(require.resolve('./cli.js'), 'utf8');
  // ══ AN ID ALONE IS ENOUGH ═════════════════════════════════════════════
  // `asymmetry` and `donors` were fixed to take a name OR --committee, and
  // fecpac was left behind. So
  //     connect fecpac --committee C00896688 --cycle 2026
  // printed the usage block — immediately after two other commands had
  // handed the operator that exact id. The name only exists to FIND the
  // committee; with the id there is nothing left to search for.
  {
    const parseFec = (argv) => {
      const a = argv.filter((x) => !x.startsWith('--'));
      const committee = flagVal(argv, '--committee');
      const q = subjectFrom(a.slice(1), argv, ['--cycle', '--committee']);
      return { q, committee, refused: !q && !committee };
    };

    const idOnly = parseFec(['fecpac', '--committee', 'C00896688', '--cycle', '2026']);
    check('an id with no name is accepted', !idOnly.refused);
    eq('and is what gets looked up', idOnly.committee, 'C00896688');
    eq('with no name invented for it', idOnly.q, '');

    const nameOnly = parseFec(['fecpac', 'Team Husted']);
    check('a name with no id is still accepted', !nameOnly.refused);
    eq('and survives intact', nameOnly.q, 'Team Husted');

    const both = parseFec(['fecpac', 'Team Husted', '--committee', 'C00896928']);
    eq('given both, the name is kept', both.q, 'Team Husted');
    eq('and so is the id', both.committee, 'C00896928');

    check('neither one is refused, because nothing could be looked up',
      parseFec(['fecpac', '--cycle', '2026']).refused);

    // The id-only path must not ask the NAME endpoint for an id.
    check('an id-only run queries committee_id, not the name search',
      /byIdOnly[\s\S]{0,400}committee_id=\$\{encodeURIComponent\(opts\.committee\)\}/
        .test(cliSrc2));
    check('and does not announce "Committees matching <id>"',
      /if \(!byIdOnly\) console\.log\(`\\n  \$\{C\.b\('Committees matching'\)/.test(cliSrc2));
    check('the designation and sponsor still print on an id-only run',
      /const affP = F\.affiliationOf\(await F\.resolveSponsors\(picked/.test(cliSrc2));
  }


  // ══ OVER THE CAP HAS TWO OPPOSITE EXPLANATIONS ════════════════════════
  // The audit fired on a leadership PAC sending $105,000 to a JOINT
  // FUNDRAISING COMMITTEE and announced:
  //   "That is the signature of a CONDUIT forwarding contributions
  //    earmarked by individuals. The money is theirs, not the committee's."
  // Backwards. A transfer to an affiliated or joint fundraising committee is
  // uncapped and IS the committee's own money. The evidence to tell them
  // apart was already in hand and ignored: forwarded money carries MEMO
  // CODES, and that run had none.
  {
    const asTransfer = F.auditContributions([
      { recipient: 'A JOINT FUNDRAISER', amount: 105000 },
      { recipient: 'A CANDIDATE', amount: 10000 },
    ]).find((f) => f.kind === 'over_cap');
    eq('over-cap rows with no memo code read as a TRANSFER',
      asTransfer.reading, 'transfer');
    eq('and the memo count is shown, not just the verdict',
      asTransfer.memo_rows, 0);
    check('the note offers BOTH explanations rather than asserting one',
      /CONDUIT/.test(asTransfer.note) && /TRANSFER/.test(asTransfer.note));
    check('and tells the reader to check what the recipient is registered as',
      /registered as/.test(asTransfer.note));
    check('the old unconditional assertion is gone from the module',
      !/That is the signature of a CONDUIT forwarding contributions\s*\`?\s*\+?\s*\`?earmarked by individuals\. The money is theirs/.test(src));

    const asConduit = F.auditContributions([
      { recipient: 'A CANDIDATE', amount: 60000, memo_code: 'X' },
      { recipient: 'A CANDIDATE', amount: 50000, memo_code: 'X' },
    ]).find((f) => f.kind === 'over_cap');
    eq('over-cap rows that ARE memo-coded still read as a conduit',
      asConduit.reading, 'conduit');
    check('and say so in words', /conduit signature/.test(asConduit.note));

    // The cap language must name what it is a cap ON.
    check('the note says the cap applies to giving a CANDIDATE',
      /give a CANDIDATE/.test(asTransfer.note));

    // Below the threshold nothing fires at all.
    check('an ordinary $10,000 contribution raises no flag',
      !F.auditContributions([{ recipient: 'A CANDIDATE', amount: 10000 }])
        .some((f) => f.kind === 'over_cap'));
  }


  // ══ A TRIVIAL EXAMPLE UNDER A SEVEN-FIGURE TOTAL ══════════════════════
  // A live run on a joint fundraising committee printed:
  //     $2,909,506  57 row(s)  (no type coded)  e.g. CREDIT CARD MERCHANT FEE
  // True of one small row and wildly untrue of the bucket. The example was
  // whichever row happened to come first, so a $2.9m total was labelled by
  // sort order — and a merchant fee under seven figures reads as an
  // explanation of them.
  {
    const r = F.residual([
      { recipient: 'A BANK', amount: 85, purpose: 'CREDIT CARD MERCHANT FEE', type: '' },
      { recipient: 'BIG VENDOR LLC', amount: 2909421, purpose: 'MEDIA PLACEMENT', type: '' },
    ]);
    const bucket = r.by_type[0];
    eq('the example comes from the LARGEST row', bucket.example, 'MEDIA PLACEMENT');
    eq('and its amount is carried so the label can be judged',
      bucket.example_usd, 2909421);
    check('not from whichever row was first',
      bucket.example !== 'CREDIT CARD MERCHANT FEE');

    // Where a bucket's money went, since a code alone says nothing.
    eq('the bucket names its payees', bucket.top.length, 2);
    eq('largest first', bucket.top[0].name, 'BIG VENDOR LLC');
    eq('at the summed amount', bucket.top[0].amount, 2909421);
    check('and the small one is still there rather than swept away',
      bucket.top.some((t) => t.name === 'A BANK' && t.amount === 85));

    // Repeat payees inside one bucket are summed, not listed twice.
    const rep = F.residual([
      { recipient: 'SAME VENDOR', amount: 1000, purpose: 'A', type: 'X' },
      { recipient: 'SAME VENDOR', amount: 2000, purpose: 'B', type: 'X' },
    ]).by_type[0];
    eq('one payee across two rows is one entry', rep.top.length, 1);
    eq('with the amounts added', rep.top[0].amount, 3000);
    eq('and the example still from the larger row', rep.example, 'B');

    // A row with no purpose must not blank an example already found.
    const noPurpose = F.residual([
      { recipient: 'V', amount: 10, purpose: 'SMALL THING', type: 'X' },
      { recipient: 'W', amount: 5000, purpose: '', type: 'X' },
    ]).by_type[0];
    eq('a larger row with no purpose does not erase the example',
      noPurpose.example, 'SMALL THING');
  }


  // ══ A SUPER PAC'S REAL VENDOR IS ON SCHEDULE E ════════════════════════
  // `asymmetry --dimension vendor` reads Schedule B, so OHIO FLYER PAC
  // showed $185,773 of vendors while spending $4,459,869 on advertising.
  // The firm that placed the ads was never on screen, because a super
  // PAC's spending is Schedule E and Schedule E names a PAYEE that this
  // module was throwing away.
  {
    const ie = F.parseIndependent({ results: [
      { payee_name: 'BIG MEDIA LLC', expenditure_amount: 3000000,
        support_oppose_indicator: 'O', candidate_name: 'BROWN' },
      { payee_name: 'BIG MEDIA LLC', expenditure_amount: 1000000,
        support_oppose_indicator: 'S', candidate_name: 'HUSTED' },
      { payee_name: 'SMALL SHOP', expenditure_amount: 50000,
        support_oppose_indicator: 'O', candidate_name: 'BROWN' },
      { expenditure_amount: 500, support_oppose_indicator: 'O' },
    ] });

    eq('the payee is read off Schedule E', ie[0].payee, 'BIG MEDIA LLC');
    const p = F.byPayee(ie);
    eq('payees are grouped', p.length, 3);
    eq('largest first', p[0].name, 'BIG MEDIA LLC');
    eq('with its rows summed', p[0].total, 4000000);

    // SIDES STAY APART. A firm paid to attack is doing different work from
    // one paid to support, and one total describes neither.
    eq('money it was paid to spend AGAINST', p[0].against, 3000000);
    eq('and FOR, separately', p[0].for, 1000000);
    check('so a payee cannot read as one-sided when it is not',
      p[0].for > 0 && p[0].against > 0);

    // A missing payee is labelled, never merged into the largest one.
    check('a row with no payee is labelled, not silently attached to another',
      p.some((x) => x.name === '(payee not stated)' && x.total === 500));

    // The caveat has to be in the output, not just in a commit message.
    check('the output says a vendor link is a CONTRACT, stronger than a bill',
      /vendor relationship is a CONTRACT/.test(cliSrc2));
    check('and that common vendors are ordinary, with the FEC rule named',
      /109\.21\(h\)/.test(cliSrc2) && /not evidence of coordination/.test(cliSrc2));
  }


  // ══ WHAT SEVERAL COMMITTEES SHARE ═════════════════════════════════════
  // The honest answer to "who is behind this". No register contains motive.
  // They contain a TREASURER — a named legal officer personally responsible
  // for the filings — plus a custodian and an address. Committees
  // independent on paper that share those are administered from one place.
  {
    const cs = F.parseCommittees({ results: [
      { committee_id: 'C00000031', name: 'ALPHA PAC', treasurer_name: 'DOE, JANE',
        street_1: '1 Main St', city: 'Columbus', state: 'OH', zip: '43215' },
      { committee_id: 'C00000032', name: 'BETA PAC', treasurer_name: 'DOE, JANE',
        street_1: '1 Main St', city: 'Columbus', state: 'OH', zip: '43215' },
      { committee_id: 'C00000033', name: 'GAMMA PAC', treasurer_name: 'ROE, RICHARD',
        street_1: '9 Other Rd', city: 'Cleveland', state: 'OH' },
    ] });

    eq('the treasurer is read from the register', cs[0].treasurer, 'DOE, JANE');
    eq('and the address is assembled', cs[0].address, '1 Main St, Columbus, OH, 43215');

    const sh = F.sharedControl(cs);
    const t = sh.find((x) => x.field === 'treasurer');
    check('a treasurer on two committees is reported', Boolean(t));
    eq('naming both', t.committees.length, 2);
    check('and not the third', !t.committees.some((c) => c.name === 'GAMMA PAC'));

    const a = sh.find((x) => x.field === 'address');
    check('a shared address is reported too', Boolean(a));

    // A STATE IS NOT AN ADDRESS.
    // A live run printed "street address  OH" and named two Ohio
    // committees as sharing it — because street_1 and city were absent and
    // the join collapsed to the state code. That is a link manufactured out
    // of a gap in the register, which is precisely what the empty-field
    // guard exists to prevent; it just did not cover NEARLY empty.
    const stateOnly = F.parseCommittees({ results: [
      { committee_id: 'C00000041', name: 'OH ONE', state: 'OH' },
      { committee_id: 'C00000042', name: 'OH TWO', state: 'OH' },
    ] });
    eq('a state with no street or city is not an address', stateOnly[0].address, '');
    eq('it is kept separately, because it is still worth seeing',
      stateOnly[0].state_only, 'OH');
    eq('and two committees in one state share NO address',
      F.sharedControl(stateOnly).length, 0);

    // A real street address still counts.
    const realAddr = F.parseCommittees({ results: [
      { committee_id: 'C00000043', name: 'X', street_1: '1 Main St', city: 'Columbus', state: 'OH' },
      { committee_id: 'C00000044', name: 'Y', street_1: '1 Main St', city: 'Columbus', state: 'OH' },
    ] });
    eq('a street address is still an address',
      realAddr[0].address, '1 Main St, Columbus, OH');
    eq('and a shared one is still reported', F.sharedControl(realAddr).length, 1);
    eq('with no state_only set when there is a real address',
      realAddr[0].state_only, '');

    // A city with no street is enough — it names a place.
    eq('a city without a street still counts as an address',
      F.parseCommittees({ results: [{ committee_id: 'C00000045', name: 'Z',
        city: 'Newport', state: 'KY' }] })[0].address, 'Newport, KY');

    // A field only one committee has is NOT a shared thing.
    check('a unique treasurer creates no overlap row',
      !sh.some((x) => String(x.value).includes('ROE, RICHARD')));

    // EMPTY IS NOT SHARED. Two committees with no treasurer stated must not
    // be reported as sharing one — that would manufacture a link out of a
    // gap in the register, which is the worst version of this command.
    const blank = F.sharedControl(F.parseCommittees({ results: [
      { committee_id: 'C00000034', name: 'X' },
      { committee_id: 'C00000035', name: 'Y' },
    ] }));
    eq('two committees with nothing stated share NOTHING', blank.length, 0);

    // Case must not split one person into two.
    const cased = F.sharedControl(F.parseCommittees({ results: [
      { committee_id: 'C00000036', name: 'X', treasurer_name: 'doe, jane' },
      { committee_id: 'C00000037', name: 'Y', treasurer_name: 'DOE, JANE' },
    ] }));
    eq('the same name in different case is one treasurer', cased.length, 1);

    // Nothing shared is a real answer, not an empty one.
    eq('unrelated committees produce no overlap',
      F.sharedControl([cs[2]]).length, 0);

    // The caveat has to be in the OUTPUT.
    check('the command says a shared treasurer is routinely innocent',
      /routinely innocent/i.test(cliSrc2));
    check('and names the reason — compliance firms supply them',
      /Compliance firms supply/i.test(cliSrc2));
    check('and states plainly that control is not motive',
      /Control is not motive/.test(cliSrc2));
    check('and that no register contains motive',
      /no register contains motive/.test(cliSrc2));
  }


  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${ran - fails}/${ran} checks\n`);
  return fails ? 1 : 0;
}

if (require.main === module) run().then((c) => process.exit(c));
module.exports = { run };
