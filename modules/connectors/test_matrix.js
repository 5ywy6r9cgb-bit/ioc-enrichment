'use strict';

/** test_matrix — the library as a spreadsheet, and the spreadsheet as a worklist. */

const M = require('./matrix.js');

let pass = 0; let fail = 0;
function check(what, ok) {
  if (ok) { pass += 1; console.log(`    PASS  ${what}`); }
  else { fail += 1; console.log(`    FAIL  ${what}`); }
}
function eq(what, got, want) {
  check(`${what}${got === want ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
    got === want);
}

console.log('\n  CSV cells cannot break the row, or the sheet');
{
  eq('a plain value passes through', M.csvCell('ACME'), 'ACME');
  eq('a comma is quoted', M.csvCell('ACME, INC.'), '"ACME, INC."');
  eq('a quote is doubled', M.csvCell('THE "BIG" CO'), '"THE ""BIG"" CO"');
  eq('a newline is quoted', M.csvCell('A\nB'), '"A\nB"');
  eq('null is empty, not the string null', M.csvCell(null), '');
  eq('zero is zero, not empty', M.csvCell(0), '0');
  // A cell opening with = + - or @ is EXECUTED by spreadsheet software. A
  // client named "-Acme" is not a subtraction, and a file meant to be shared
  // must not run anything when it is opened.
  eq('a formula lead-in is defused', M.csvCell('=SUM(A1)'), "'=SUM(A1)");
  eq('so is a minus', M.csvCell('-Acme'), "'-Acme");
  eq('so is an at-sign', M.csvCell('@foo'), "'@foo");
  eq('and a defused cell that also needs quoting gets both',
    M.csvCell('=A,B'), '"\'=A,B"');
  check('a header row and a data row',
    M.toCsv(['a', 'b'], [{ a: 1, b: 'x,y' }]) === 'a,b\n1,"x,y"\n');
  check('a missing field is empty, not undefined',
    M.toCsv(['a', 'b'], [{ a: 1 }]) === 'a,b\n1,\n');
}

const edge = (client, registrant, extra = {}) => ({
  client, registrant,
  client_key: client.toLowerCase(), registrant_key: registrant.toLowerCase(),
  ...extra,
});

console.log('\n  relationships: what the filings assert');
{
  const rows = M.relationships([
    edge('AEP SERVICE CORP', 'BROWNSTEIN', { subject: 'energy', amount: '$120,000', issues: 'ENG' }),
    edge('AEP SERVICE CORP', 'BROWNSTEIN', { subject: 'ohio', amount: '$90,000', issues: 'TAX' }),
    edge('AEP COMPANY INC', 'CASSIDY', { subject: 'energy', amount: '$50,000' }),
  ]);
  eq('the same pair twice is ONE relationship', rows.length, 2);
  eq('with the filings counted', rows[0].filings, 2);
  eq('and every subject it turned up under', rows[0].subjects, 'energy | ohio');
  eq('subject_count is the thing worth sorting on', rows[0].subject_count, 2);
  eq('issues collected from both filings', rows[0].issues, 'ENG | TAX');
  // LDA income recurs per period. Summing a retainer reported four times
  // reports it four times, and this desk does not publish invented totals.
  eq('the LARGEST reported figure, never a sum', rows[0].largest_reported, 120000);
  eq('and how many figures it saw, so the reader can judge', rows[0].amounts_seen, 2);
  eq('an edge missing a key is dropped, not half-recorded',
    M.relationships([{ client: 'X', registrant: 'Y' }]).length, 0);
}
{
  // Issue TEXT is prose, and a trademark affidavit already taught this desk
  // what prose does to a parser.
  const rows = M.relationships([edge('C', 'R', {
    issues: 'ENG, and the company stated that this is a matter of policy.',
  })]);
  eq('a code survives', rows[0].issues, 'ENG');
}

console.log('\n  overlap, computed by inversion');
{
  const edges = [
    edge('SHARED CO', 'FIRM A'), edge('SHARED CO', 'FIRM B'),
    edge('ALSO SHARED', 'FIRM A'), edge('ALSO SHARED', 'FIRM B'),
    edge('SOLO CO', 'FIRM C'),
  ];
  // overlap() pairs the KEYS of what it is given, so the direction is the
  // opposite of the first reading — and it WAS wired backwards, producing
  // true rows under a false heading.
  const byClient = M.group(edges, 'client_key', 'client', 'registrant_key', 'registrant');
  const byReg = M.group(edges, 'registrant_key', 'registrant', 'client_key', 'client');

  const firms = M.overlap(byReg);
  eq('grouping by REGISTRANT pairs the firms', firms.length, 1);
  eq('two firms with two clients in common', firms[0].shared_count, 2);
  eq('and the CLIENTS are what is listed as shared',
    firms[0].shared, 'ALSO SHARED | SHARED CO');

  const clients = M.overlap(byClient);
  eq('grouping by CLIENT pairs the organisations', clients.length, 1);
  eq('and the FIRMS are what is listed as shared',
    clients[0].shared, 'FIRM A | FIRM B');

  eq('a firm with one client creates no pair',
    M.overlap(M.group([edge('SOLO', 'ONE')], 'registrant_key', 'registrant', 'client_key', 'client')).length, 0);
  eq('a minimum can be demanded', M.overlap(byReg, 3).length, 0);
}
{
  // Pair identity must not depend on iteration order, or the same pair is
  // emitted twice under two keys and every count doubles.
  const one = M.overlap(M.group([edge('C1', 'B FIRM'), edge('C1', 'A FIRM')],
    'registrant_key', 'registrant', 'client_key', 'client'));
  const other = M.overlap(M.group([edge('C1', 'A FIRM'), edge('C1', 'B FIRM')],
    'registrant_key', 'registrant', 'client_key', 'client'));
  eq('input order does not change the pair count', one.length, other.length);
  eq('nor which name is first', one[0].a, other[0].a);
}

console.log('\n  fanout: the denominator for every overlap');
{
  const byClient = M.group([edge('AEP', 'BROWNSTEIN'), edge('AEP', 'CASSIDY'),
    edge('OTHER', 'CASSIDY')], 'client_key', 'client', 'registrant_key', 'registrant');
  const rows = M.fanout(byClient, 'client', 'registrants');
  eq('the organisation with most firms leads', rows[0].client, 'AEP');
  eq('counted', rows[0].registrants_count, 2);
  eq('and named', rows[0].registrants, 'BROWNSTEIN | CASSIDY');
}

console.log('\n  entities: presence, not relationship');
{
  const byName = new Map([
    ['a', { key: 'a', display: 'AXON', seen: [
      { connector: 'senatelda', subject: 'surveillance' },
      { connector: 'usaspending', subject: 'surveillance' },
      { connector: 'opencorporates', subject: 'policing' }] }],
    ['b', { key: 'b', display: 'SOLO', seen: [{ connector: 'senatelda', subject: 'x' }] }],
  ]);
  const rows = M.entities(byName);
  eq('the name in most registers leads', rows[0].name, 'AXON');
  eq('registers are counted distinctly', rows[0].register_count, 3);
  eq('subjects too', rows[0].subject_count, 2);
  eq('and the raw mention count is kept, because it is not the same thing',
    rows[0].mentions, 3);
}

console.log('\n  the pattern map is a worklist, not a feeling');
{
  const leads = M.patternMap({
    relationshipRows: [{ client: 'C', registrant: 'R', filings: 2, subject_count: 2, subjects: 'a | b' }],
    clientFanout: [{ client: 'AEP', registrants_count: 2, registrants: 'BROWNSTEIN | CASSIDY' }],
    registrantOverlap: [{ a: 'FIRM A', b: 'FIRM B', shared_count: 2, shared: 'X | Y' }],
    entityRows: [{ name: 'AXON', register_count: 3, registers: 'a | b | c', subject_count: 2 }],
  });
  check('every lead carries a command that runs',
    leads.length > 0 && leads.every((l) => /^bin\/sentinel connect /.test(l.next)));
  check('and the reason it was raised', leads.every((l) => l.why && l.why.length > 20));
  eq('the AEP shape ranks first', leads[0].shape, 'client retains multiple firms');
  check('a client with ONE firm raises no lead',
    !M.patternMap({ relationshipRows: [], clientFanout: [{ client: 'X', registrants_count: 1, registrants: 'A' }], registrantOverlap: [], entityRows: [] }).length);
  check('a name in two registers is not yet a lead',
    !M.patternMap({ relationshipRows: [], clientFanout: [], registrantOverlap: [],
      entityRows: [{ name: 'X', register_count: 2, registers: 'a | b', subject_count: 1 }] }).length);
  // A quoted name in the generated command must survive being pasted.
  const q = M.patternMap({ relationshipRows: [], clientFanout: [], registrantOverlap: [],
    entityRows: [{ name: 'ACME, INC.', register_count: 3, registers: 'a|b|c', subject_count: 1 }] });
  check('a name with a comma is quoted in the command it hands you',
    /"ACME, INC\."/.test(q[0].next));
}


console.log('\n  anomalies: rarity, not size');
{
  const g = (edges, a, b, c, d) => M.group(edges, a, b, c, d);
  const build = (edges) => {
    const byClient = g(edges, 'client_key', 'client', 'registrant_key', 'registrant');
    const byRegistrant = g(edges, 'registrant_key', 'registrant', 'client_key', 'client');
    return M.anomalies({ byClient, byRegistrant, entityRows: [], relationshipRows: [] });
  };

  {
    // THE PROPERTY THAT MATTERS. Two small firms sharing their only client —
    // a client nobody else carries — must outrank two large practices
    // sharing three clients that ten firms each carry. Otherwise the score
    // is measuring SIZE, which is the failure every correction on this desk
    // traces back to.
    const edges = [];
    // RARE: one client, carried by these two firms and nobody else.
    edges.push(edge('RARE CLIENT', 'SMALL A'), edge('RARE CLIENT', 'SMALL B'));
    // COMMON: two big books, overlapping only on clients that everyone has.
    for (let i = 0; i < 3; i += 1) {
      for (let f = 0; f < 10; f += 1) edges.push(edge(`POPULAR ${i}`, `BIG ${f}`));
    }
    for (let i = 0; i < 30; i += 1) {
      edges.push(edge(`ONLY BIG0 ${i}`, 'BIG 0'), edge(`ONLY BIG1 ${i}`, 'BIG 1'));
    }

    const rows = build(edges).filter((r) => r.kind === 'firms share clients');
    const rare = rows.find((r) => /SMALL A/.test(r.subject) && /SMALL B/.test(r.subject));
    const common = rows.find((r) => /BIG 0 /.test(r.subject) && /BIG 1$/.test(r.subject));
    check('both pairs are found', !!rare && !!common);
    check('the RARE pair outranks the pair sharing THREE times as many clients',
      rare.score > common.score);
    check('even though the common pair shares more', common.shared_count > rare.shared_count);
    eq('the rare pair shares its whole book', rare.overlap_of_smaller_book, 1);
    check('and the common pair shares almost none of its own',
      common.overlap_of_smaller_book < 0.15);
  }
  {
    // The other direction, and it is intended: a pair sharing MANY rare
    // clients should score very high. Rarity accumulates, so twenty
    // exclusive clients is a stronger relationship than one, not a weaker
    // one. This is the case that made the first version of the test above
    // wrong, and it is worth pinning down so it is not "fixed" later.
    const edges = [edge('SOLE', 'X'), edge('SOLE', 'Y')];
    for (let i = 0; i < 20; i += 1) edges.push(edge(`EXCLUSIVE ${i}`, 'P'), edge(`EXCLUSIVE ${i}`, 'Q'));
    const rows = build(edges).filter((r) => r.kind === 'firms share clients');
    const many = rows.find((r) => /P /.test(r.subject));
    const one = rows.find((r) => /X /.test(r.subject));
    check('twenty exclusive shared clients beats one', many.score > one.score);
  }
  {
    // A client carried by many firms contributes less rarity than one
    // carried by two — that is the whole weighting.
    const two = build([edge('C', 'A'), edge('C', 'B')])
      .find((r) => r.kind === 'firms share clients');
    const many = build([edge('C', 'A'), edge('C', 'B'), edge('C', 'D'),
      edge('C', 'E'), edge('C', 'F'), edge('C', 'G')])
      .find((r) => r.kind === 'firms share clients');
    check('a client carried by two firms is rarer than one carried by six',
      two.rarity > many.rarity);
  }
  {
    const rows = build([edge('SOLO', 'ONLY FIRM')]);
    eq('one firm, one client raises nothing', rows.length, 0);
  }
  {
    // Pairing is by inversion, so a pair must appear exactly once however
    // many clients it shares.
    const rows = build([edge('C1', 'A'), edge('C1', 'B'), edge('C2', 'A'), edge('C2', 'B')])
      .filter((r) => r.kind === 'firms share clients');
    eq('a pair sharing two clients is ONE row', rows.length, 1);
    eq('with both clients counted', rows[0].shared_count, 2);
  }
  {
    const rows = M.anomalies({
      byClient: new Map(), byRegistrant: new Map(),
      entityRows: [{ name: 'AXON', register_count: 4, registers: 'a|b|c|d', subject_count: 3 },
        { name: 'QUIET', register_count: 2, registers: 'a|b', subject_count: 1 }],
      relationshipRows: [],
    });
    eq('a name in 4 registers is scored', rows.length, 1);
    eq('and it is the one in four, not the one in two', rows[0].subject, 'AXON');
  }
  {
    const rows = build([edge('C1', 'A'), edge('C1', 'B')]);
    check('every anomaly carries a command that runs',
      rows.every((r) => /^bin\/sentinel connect /.test(r.next)));
    check('and the reason it scored', rows.every((r) => r.why && r.why.length > 20));
    check('scores are finite numbers, never NaN',
      rows.every((r) => Number.isFinite(r.score)));
  }
}

console.log(`\n  ${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks\n`);
process.exit(fail ? 1 : 0);
