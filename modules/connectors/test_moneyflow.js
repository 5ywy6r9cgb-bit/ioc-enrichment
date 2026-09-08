'use strict';
/**
 * modules/connectors/test_moneyflow.js
 *
 * Three tests in here are load-bearing and the rest is bookkeeping.
 *
 *   1. THE SAME FILING READ FROM 500 CAPTURES IS COUNTED ONCE. The live
 *      capture directory holds ~500 identical senatelda captures for one
 *      registrant, written by a pagination run. A reader without row identity
 *      reports 500x the real money and looks completely plausible doing it.
 *
 *   2. TWO KINDS OF MONEY ARE NEVER ADDED. summarise() must expose no field
 *      that sums a contract ceiling into a lobbying fee -- not "total", not
 *      anything shaped like one.
 *
 *   3. A WIDENED NAME MATCH IS NEVER SILENT. Substring matching is how two
 *      separate corporations get their money merged. It must announce itself
 *      and name every legal entity it folded together.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('./moneyflow.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

const STAMP = '2026-09-08T12-00-00-000Z';
let n = 0;
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moneyflow-'));
  const cap = path.join(dir, 'captures');
  fs.mkdirSync(cap);
  for (const [name, body] of files) {
    fs.writeFileSync(path.join(cap, name), JSON.stringify(body));
  }
  return cap;
}
// Distinct stamps come out of the MILLISECONDS field. Rolling the hour
// instead ran past 23 at i=12, recency.parseStamp rejected those files, and
// three tests failed against perfectly correct code -- the fixture was the
// bug. A stamp generator that can emit an invalid stamp will do it again.
const capName = (connector, slug, i) =>
  `live_capture_${connector}_${slug}_${
    STAMP.replace('-000Z', '-' + String(i || 0).padStart(3, '0') + 'Z')}.json`;

// ---- source-shaped fixtures ---------------------------------------------

const lda = (rows, count) => ({
  count: count === undefined ? rows.length : count,
  results: rows.map((r, i) => ({
    filing_uuid: `f${i}-${n++}`,
    client: { name: r.client },
    registrant: { name: r.registrant },
    income: r.income === undefined ? '' : r.income,
    expenses: r.expenses === undefined ? '' : r.expenses,
    filing_year: r.year || 2025,
    filing_period: r.period || '1st Quarter',
    filing_type: r.type || 'Q1',
    dt_posted: r.posted || '2025-04-20T00:00:00',
    filing_document_url: r.url || 'https://lda.senate.gov/x',
    lobbying_activities: [{ general_issue_code_display: r.issue || 'Energy' }],
  })),
});

const fec = (rows, count) => ({
  pagination: { count: count === undefined ? rows.length : count, page: 1, pages: 1 },
  results: rows.map((r, i) => ({
    transaction_id: r.id || `T${i}`,
    spender_name: r.spender,
    payee_name: r.payee,
    expenditure_amount: r.amount,
    expenditure_date: r.date || '2024-10-01',
    support_oppose_indicator: r.so || 'S',
    candidate_name: r.candidate || 'DOE, JANE',
    candidate_office_full: 'Senate',
    candidate_office_state: 'OH',
    pdf_url: 'https://docquery.fec.gov/x.pdf',
  })),
});

const award = (rows, hasNext) => ({
  page_metadata: { page: 1, hasNext: !!hasNext },
  results: rows.map((r, i) => ({
    generated_internal_id: r.id || `A${i}`,
    'Award ID': r.awardId || `ID${i}`,
    'Recipient Name': r.recipient,
    'Award Amount': r.amount,
    'Awarding Agency': r.agency || 'Department of Energy',
    'Start Date': r.start || '2024-01-01',
    'End Date': r.end || '2027-12-31',
    Description: r.desc || 'DATA CENTER SERVICES',
  })),
});

module.exports = function run() {
  console.log('\n  moneyflow: the money already on disk, with the kind never lost\n');

  // ═══════════════════════════════════════════════════════════════════════
  // 1. THE 500-CAPTURE PROBLEM
  //
  // The single defect this module was built to prevent. Same registrant,
  // same quarter, same $50,000, written to disk 40 times by a pagination
  // run. Answer must be $50,000, not $2,000,000.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const files = [];
    for (let i = 0; i < 40; i++) {
      files.push([capName('senatelda', 'ALPINE_GROUP_PARTNERS_LLC', i),
        lda([{ client: 'Vantage Data Centers LLC', registrant: 'Alpine Group Partners LLC', income: '50000' }])]);
    }
    const dir = fixture(files);
    const r = M.readFlows(dir);
    check('40 identical captures were all read', r.capturesRead === 40);
    check('but the same filing is ONE flow, not 40', r.flows.length === 1,
      `got ${r.flows.length} flows`);
    check('and the duplicates dropped are counted out loud', r.duplicatesDropped === 39,
      `got ${r.duplicatesDropped}`);

    const f = M.flowsFor(r.flows, 'Vantage Data Centers LLC');
    const s = M.summarise(f.hits);
    check('the money is $50,000 and not $2,000,000',
      s.length === 1 && s[0].reported === 50000, JSON.stringify(s));
  }

  // An AMENDMENT restates a quarter rather than adding to it. Q1 filed at
  // $50,000 then amended to $60,000 is $60,000 for that quarter, once.
  {
    const dir = fixture([
      [capName('senatelda', 'A', 0), lda([
        { client: 'C Corp', registrant: 'R LLP', income: '50000', period: '1st Quarter', type: 'Q1', posted: '2025-04-20T00:00:00' },
        { client: 'C Corp', registrant: 'R LLP', income: '60000', period: '1st Quarter', type: 'Q1A', posted: '2025-06-01T00:00:00' },
      ])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'C Corp');
    const s = M.summarise(f.hits);
    check('an amendment restates its quarter and is not added to it',
      f.hits.length === 1, `got ${f.hits.length} flow(s)`);
    check('and one quarter yields one figure, whichever survived',
      s[0].reported === 50000 || s[0].reported === 60000, JSON.stringify(s));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2. KINDS ARE NEVER ADDED
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dir = fixture([
      [capName('senatelda', 'VANTAGE', 0),
        lda([{ client: 'Vantage', registrant: 'Alpine Group', income: '50000' }])],
      [capName('usaspending', 'VANTAGE', 1),
        award([{ recipient: 'Vantage', amount: 9000000 }])],
      [capName('fecspend', 'VANTAGE', 2),
        fec([{ spender: 'Vantage', payee: 'Media Buyer LLC', amount: 250000 }])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'Vantage');
    const s = M.summarise(f.hits);

    check('three sources produce three kinds', s.length === 3,
      s.map((x) => x.kind).join(', '));
    const byKind = Object.fromEntries(s.map((x) => [x.kind, x.reported]));
    check('the lobbying fee stays $50,000', byKind.lobbying_fee === 50000);
    check('the contract stays $9,000,000', byKind.federal_contract === 9000000);
    check('the expenditure stays $250,000', byKind.independent_expenditure === 250000);

    // THE ONE THAT MATTERS. $9,300,000 must not exist anywhere.
    const combined = 50000 + 9000000 + 250000;
    const anyGrandTotal = s.some((x) => Object.values(x).includes(combined));
    check('NO field anywhere holds the cross-kind sum', !anyGrandTotal,
      JSON.stringify(s));
    check('and summarise() exposes no field named like a grand total',
      !s.some((x) => Object.keys(x).some((k) => /^(total|grand|sum|all)$/i.test(k))),
      Object.keys(s[0]).join(', '));

    // A contract award must be labelled a ceiling, because a reader who sees
    // $9M beside $50K will otherwise treat both as money that moved.
    const contract = s.find((x) => x.kind === 'federal_contract');
    check('a contract award announces itself as a ceiling, not a payment',
      /ceiling|not money moved/i.test(contract.unit), contract.unit);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3. A WIDENED MATCH IS NEVER SILENT
  //
  // "Vantage Data Centers LLC" and "Vantage Data Centers OH-E, LLC" are
  // separate corporations. Ohio SOS lists the second as its own registration
  // with its own status. Merging their money is an assertion about corporate
  // structure that no filing here supports.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dir = fixture([
      [capName('senatelda', 'V', 0), lda([
        { client: 'Vantage Data Centers LLC', registrant: 'Alpine Group', income: '50000' },
        { client: 'Vantage Data Centers OH-E, LLC', registrant: 'Alpine Group', income: '70000', period: '2nd Quarter' },
      ])],
    ]);
    const r = M.readFlows(dir);

    const wide = M.flowsFor(r.flows, 'Vantage');
    check('a partial name widens the match rather than returning nothing',
      wide.hits.length === 2, `got ${wide.hits.length}`);
    check('and the widening is declared, not silent', wide.widened === true);
    check('and every distinct legal name folded in is named',
      wide.names.length === 2
      && wide.names.some((x) => /OH-E/.test(x))
      && wide.names.some((x) => !/OH-E/.test(x)),
      JSON.stringify(wide.names));

    const exact = M.flowsFor(r.flows, 'Vantage Data Centers LLC');
    check('an exact name does NOT reach the sibling entity',
      exact.hits.length === 1 && exact.widened === false,
      JSON.stringify({ hits: exact.hits.length, widened: exact.widened }));
    check('and the exact match totals only its own filings',
      M.summarise(exact.hits)[0].reported === 50000);

    // --exact must be honoured even when it means returning nothing: a
    // fallback that fires anyway turns "no filings under this exact name"
    // into a number belonging to a different company.
    const strict = M.flowsFor(r.flows, 'Vantage', { exact: true });
    check('--exact returns nothing rather than quietly widening',
      strict.hits.length === 0 && strict.widened === false);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DIRECTION
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dir = fixture([
      [capName('senatelda', 'X', 0),
        lda([{ client: 'Acme Power', registrant: 'K Street LLP', income: '80000' }])],
      [capName('usaspending', 'X', 1),
        award([{ recipient: 'Acme Power', amount: 4000000, agency: 'Department of Energy' }])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'Acme Power');
    const d = M.directions(f.hits, f.key, f.widened);
    check('money the entity PAID is separated from money it RECEIVED',
      d.paid.length === 1 && d.received.length === 1,
      JSON.stringify({ paid: d.paid.length, received: d.received.length }));
    check('the lobbying fee is money out', d.paid[0].kind === 'lobbying_fee');
    check('the federal award is money in', d.received[0].kind === 'federal_contract');
    check('and the award names the agency as the payer',
      d.received[0].payer === 'Department of Energy');
  }

  // In-house lobbying spend names the SAME body on both sides. It is not a
  // transfer and must never be counted as money paid to a counterparty.
  {
    const dir = fixture([
      [capName('senatelda', 'Y', 0),
        lda([{ client: 'Utility Holdings', registrant: 'Utility Holdings', expenses: '120000' }])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'Utility Holdings');
    const d = M.directions(f.hits, f.key, f.widened);
    check('in-house spend lands in `self`, not paid or received',
      d.self.length === 1 && d.paid.length === 0 && d.received.length === 0,
      JSON.stringify({ self: d.self.length, paid: d.paid.length, received: d.received.length }));
    check('and it is its own kind, never folded into lobbying fees',
      d.self[0].kind === 'lobbying_self_spend');
    check('income and expenses are never the same total',
      M.summarise(f.hits).every((s) => s.kind !== 'lobbying_fee' || s.reported === null));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCHEDULE E: THE DIRECTION FIELD THAT REVERSES THE MEANING
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dir = fixture([
      [capName('fecspend', 'Z', 0), fec([
        { spender: 'Growth PAC', payee: 'Ad Shop LLC', amount: 400000, so: 'O', candidate: 'DOE, JANE', id: 'T1' },
        { spender: 'Growth PAC', payee: 'Ad Shop LLC', amount: 100000, so: 'S', candidate: 'ROE, JOHN', id: 'T2' },
      ])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'Growth PAC');
    check('an expenditure AGAINST a candidate says OPPOSING in full',
      f.hits.some((x) => /^OPPOSING /.test(x.about)),
      f.hits.map((x) => x.about).join(' | '));
    check('and one FOR says SUPPORTING in full',
      f.hits.some((x) => /^SUPPORTING /.test(x.about)));
    check('the payee is the vendor, not the candidate',
      f.hits.every((x) => x.payee === 'Ad Shop LLC'));

    // Searching the CANDIDATE finds the money spent about them, and it lands
    // in `mentioned` -- they are neither payer nor payee. Putting a candidate
    // in `received` would read as the committee paying them, which is the
    // exact thing an independent expenditure is not.
    const cand = M.flowsFor(r.flows, 'DOE, JANE');
    const cd = M.directions(cand.hits, cand.key, cand.widened);
    check('a candidate targeted by an expenditure is `mentioned`, not paid',
      cd.mentioned.length >= 1 && cd.received.length === 0,
      JSON.stringify({ mentioned: cd.mentioned.length, received: cd.received.length }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COVERAGE: A CAP IS NOT A COUNT
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dir = fixture([
      // 2 rows kept, API says 7,346 exist.
      [capName('senatelda', 'ALPINE_GROUP_PARTNERS_LLC', 0),
        lda([{ client: 'A', registrant: 'Alpine Group' }, { client: 'B', registrant: 'Alpine Group' }], 7346)],
      [capName('usaspending', 'BIG', 1),
        award([{ recipient: 'Big Co', amount: 1 }], true)],
    ]);
    const r = M.readFlows(dir);
    const cov = M.coverage(r.sources);
    const lda1 = cov.find((c) => c.connector === 'senatelda');
    check('a truncated LDA capture is flagged with its real denominator',
      lda1.truncated === 1 && lda1.worstTotal === 7346 && lda1.worstKept === 2,
      JSON.stringify(lda1));
    const us = cov.find((c) => c.connector === 'usaspending');
    check('USAspending hasNext is truncation even with no count',
      us.truncated === 1 && us.totalUnknown === 1, JSON.stringify(us));
    check('and "how many exist" stays UNKNOWN rather than defaulting to kept',
      us.worstTotal === null);
  }

  // Coverage folds per SUBJECT: 500 captures of one registrant is one line.
  {
    const files = [];
    for (let i = 0; i < 30; i++) {
      files.push([capName('senatelda', 'ALPINE_GROUP_PARTNERS_LLC', i),
        lda([{ client: 'A', registrant: 'Alpine' }], 7346)]);
    }
    const cov = M.coverage(M.readFlows(fixture(files)).sources);
    check('30 truncated captures of one subject print as ONE coverage line',
      cov.length === 1 && cov[0].captures === 30, JSON.stringify(cov));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A MISSING FIGURE IS NOT ZERO
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dir = fixture([
      [capName('senatelda', 'Q', 0), lda([
        { client: 'Quiet Corp', registrant: 'Firm A', income: '' },
        { client: 'Quiet Corp', registrant: 'Firm B', income: '0', period: '2nd Quarter' },
      ])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'Quiet Corp');
    const s = M.summarise(f.hits)[0];
    check('a filing with NO figure is counted apart from one reporting $0',
      s.rows === 2 && s.rowsWithNoAmount === 1 && s.rowsWithAmount === 1,
      JSON.stringify(s));
    check('and the reported total is $0 from the one filing that said $0',
      s.reported === 0);
    check('the relationship survives even with no money on it',
      f.hits.some((x) => x.amount === null && x.payee === 'Firm A'));
  }

  // A year with rows but no figures returns null, so a disclosure gap never
  // draws as a dip in spending.
  {
    const dir = fixture([
      [capName('senatelda', 'S', 0), lda([
        { client: 'Ser Corp', registrant: 'F', income: '10000', year: 2023 },
        { client: 'Ser Corp', registrant: 'F', income: '', year: 2024 },
      ])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'Ser Corp');
    const ser = M.series(f.hits);
    const y24 = ser.find((x) => x.year === '2024');
    check('a year with filings but no reported money is null, not zero',
      y24 && y24.rows === 1 && y24.reported === null, JSON.stringify(ser));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COUNTERPARTIES
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dir = fixture([
      [capName('senatelda', 'CP', 0), lda([
        { client: 'Client Co', registrant: 'Alpine Group Partners, LLC', income: '50000', period: '1st Quarter' },
        { client: 'Client Co', registrant: 'Alpine Group Partners LLC', income: '60000', period: '2nd Quarter' },
      ])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'Client Co');
    const cp = M.byCounterparty(f.hits, f.key, f.widened);
    check('two spellings of one firm collapse to one counterparty row',
      cp.length === 1, JSON.stringify(cp.map((c) => c.counterparty)));
    check('and BOTH quarters are counted -- neither overwrites the other',
      cp[0].reported === 110000 && cp[0].rows === 2, JSON.stringify(cp[0]));
    check('and the row lists both raw spellings it folded together',
      cp[0].names.length === 2, JSON.stringify(cp[0].names));
    check('kind is part of the counterparty key, not just a label',
      cp[0].kind === 'lobbying_fee');
  }

  // The same counterparty in two roles must not share a total.
  {
    const dir = fixture([
      [capName('senatelda', 'DOE', 0),
        lda([{ client: 'Mixed Co', registrant: 'Department of Energy', income: '5000' }])],
      [capName('usaspending', 'DOE', 1),
        award([{ recipient: 'Mixed Co', amount: 900000, agency: 'Department of Energy' }])],
    ]);
    const r = M.readFlows(dir);
    const f = M.flowsFor(r.flows, 'Mixed Co');
    const cp = M.byCounterparty(f.hits, f.key, f.widened);
    check('one counterparty in two roles produces two rows, not one merged total',
      cp.length === 2 && !cp.some((c) => c.reported === 905000),
      JSON.stringify(cp.map((c) => [c.kind, c.direction, c.reported])));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BOOKKEEPING
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dir = fixture([
      [capName('senatelda', 'B', 0), lda([{ client: 'Book Co', registrant: 'F' }])],
      ['live_capture_courtlistener_Book_Co_' + STAMP + '.json', { results: [] }],
      ['not-a-capture.json', { results: [] }],
    ]);
    const r = M.readFlows(dir);
    check('captures from non-money connectors are skipped entirely',
      r.capturesRead === 1 && r.sources.every((s) => s.connector === 'senatelda'));

    const bad = fixture([]);
    fs.writeFileSync(path.join(bad, capName('senatelda', 'BROKEN', 0)), '{ not json');
    const r2 = M.readFlows(bad);
    check('a corrupt capture is reported, not thrown',
      r2.unparsed.length === 1 && r2.flows.length === 0);

    check('a missing capture directory is an empty library, not a crash',
      M.readFlows(path.join(os.tmpdir(), 'moneyflow-does-not-exist')).flows.length === 0);
  }

  {
    // Every kind must declare what it is and where it comes from: an
    // unlabelled figure is the thing this desk publishes against.
    const bad = Object.entries(M.KINDS).filter(([, v]) =>
      !v.label || !v.unit || !v.authority || !v.payerRole || !v.payeeRole);
    check('every kind of money declares its unit, roles and legal authority',
      bad.length === 0, bad.map(([k]) => k).join(', '));
    check('every reader has a kind and every kind is reachable',
      M.MONEY_CONNECTORS.length === 4, M.MONEY_CONNECTORS.join(', '));
  }

  console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'}: ${PASS} passed, ${FAIL} failed\n`);
  return FAIL === 0;
};

if (require.main === module) process.exit(module.exports() ? 0 : 1);
