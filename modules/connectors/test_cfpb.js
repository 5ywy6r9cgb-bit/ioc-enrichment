#!/usr/bin/env node
'use strict';
/**
 * test_cfpb.js — the consumer complaint connector.
 *
 * This dataset is the easiest one in the repo to publish a false claim
 * from, because the number it hands you is a COUNT and the sentence people
 * write from it is a RATE. Every check names the wrong sentence.
 */

const fs = require('fs');
const R = require('./registry.js');

module.exports = function run() {
  let PASS = 0;
  let FAIL = 0;
  const check = (name, ok, detail) => {
    if (ok) { PASS++; console.log(`    PASS  ${name}`); }
    else { FAIL++; console.log(`    FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  };

  console.log('\n  cfpb — complaints, and the denominator this data does not have\n');

  const C = R.CONNECTORS.cfpb;
  check('the connector is registered', !!C);
  check('and needs no key', !C.keyRequired);

  // ══ 1. WHICH FIELD WAS SEARCHED ═══════════════════════════════════════
  //
  // The default reads complaint NARRATIVES. A search for "Wells Fargo"
  // then returns complaints about OTHER banks that merely mention Wells
  // Fargo -- and a reader totalling the result counts them against Wells
  // Fargo. --company restricts it to the company-name field.
  {
    const narr = C.run('Wells Fargo', null, {});
    check('the default searches narratives, not company names',
      /field=complaint_what_happened/.test(narr.url), narr.url);
    const co = C.run('Wells Fargo', null, { company: true });
    check('--company searches the company field instead',
      /field=company/.test(co.url), co.url);
    check('and the announcement says which field was used',
      /matched on COMPANY only/.test(C.describe('Wells Fargo', { company: true }))
        && !/matched on COMPANY only/.test(C.describe('Wells Fargo', {})));

    check('a state filter is upper-cased and clipped to two letters',
      /state=OH/.test(C.run('x', null, { state: 'ohio' }).url),
      C.run('x', null, { state: 'ohio' }).url);
    check('a since date is clipped to a date',
      /date_received_min=2024-01-01/.test(
        C.run('x', null, { since: '2024-01-01T00:00:00Z' }).url));
    check('aggregations are switched off so the capture is the rows',
      /no_aggs=true/.test(narr.url));

    // format=json 404s. Bisected against the live API: every other
    // parameter returns 200, and this one returns 404 even on the bare
    // endpoint. It cost two wrong endpoint guesses to find, because a 404
    // reads as "wrong path" and this was a wrong PARAMETER on a right one.
    check('no format parameter is sent — it 404s the live API',
      !/format=/.test(narr.url), narr.url);
    check('and the probe does not send it either',
      !/format=/.test(C.probe(null).url), C.probe(null).url);
    const src = fs.readFileSync(require.resolve('./registry.js'), 'utf8');
    check('and the reason is recorded where someone would add it back',
      /alone returns 404/.test(src));
  }

  // ══ 2. A COUNT IS NOT A RATE ══════════════════════════════════════════
  //
  // Complaint volume tracks CUSTOMER COUNT. A bank with 60 million
  // accounts out-complains one with 600,000 by a hundred to one while
  // behaving identically. "Bank X leads the nation in complaints" is a
  // sentence about market share.
  {
    const partial = C.coverage({ hits: { total: { value: 5000 }, hits: new Array(100).fill({}) } });
    check('a capped page says how much of the total it holds',
      /100 of 5000/.test(partial), partial);
    check('and every coverage line carries the rate warning',
      /NOT A MISCONDUCT RATE/.test(partial));
    check('and says the fixing denominator is not in this dataset',
      /NOT in this dataset/.test(partial));

    const whole = C.coverage({ hits: { total: { value: 3 }, hits: [{}, {}, {}] } });
    check('a complete result may say complete', /COMPLETE/.test(whole));
    check('but still carries the warning', /NOT A MISCONDUCT RATE/.test(whole));

    // ES returns total as a bare number on some versions and an object on
    // others. Reading the object as a number silently yields NaN, and a
    // NaN comparison is false, so a capped page would print as complete.
    const bare = C.coverage({ hits: { total: 42, hits: [{}] } });
    check('a bare numeric total is read, not mistaken for unknown',
      /1 of 42/.test(bare), bare);
    const none = C.coverage({ hits: { hits: [{}] } });
    check('a missing total reports UNKNOWN, never complete',
      /UNKNOWN/.test(none) && !/COMPLETE/.test(none), none);
  }

  // ══ 3. THE COMPANY'S OWN DISPOSITION IS THE STRONGEST FIELD ═══════════
  //
  // "Closed with monetary relief" is the FIRM recording that it paid. That
  // is a fact about the company, from the company -- a different order of
  // evidence from the complainant's narrative.
  {
    const [row] = C.parse({ hits: { hits: [{ _source: {
      complaint_id: 12345, company: 'BIG BANK, N.A.', state: 'OH',
      product: 'Checking or savings account', sub_product: 'Checking account',
      issue: 'Problem with a fee', sub_issue: 'Overdraft fee',
      date_received: '2025-03-04T12:00:00Z',
      company_response: 'Closed with monetary relief',
      complaint_what_happened: 'They   charged   me\n\n five  times.',
      submitted_via: 'Web',
    } }] } });
    check('the company disposition survives the parse',
      row.outcome === 'Closed with monetary relief');
    check('product and sub-product are kept together',
      row.product === 'Checking or savings account — Checking account');
    check('issue and sub-issue too, so the fee type is visible',
      /Overdraft fee/.test(row.issue));
    check('the date is trimmed to a date', row.received === '2025-03-04');
    check('the narrative whitespace is collapsed, not left ragged',
      /They charged me five times\./.test(row.narrative), row.narrative);
    check('and the row links to the public complaint record',
      /search\/detail\/12345$/.test(row.url), row.url);

    // A complaint with no published narrative is the NORM, not an empty
    // one. Printing an empty field is fine; concluding from it is not.
    const [quiet] = C.parse({ hits: { hits: [{ _source: {
      complaint_id: 7, company: 'X', company_response: 'Closed with explanation' } }] } });
    check('a complaint with no published narrative still parses',
      quiet.narrative === '' && quiet.name === 'X');
  }

  // ══ 4. THE FOUR THINGS A ZERO DOES NOT MEAN ═══════════════════════════
  {
    const z = C.diagnose({ hits: { hits: [] } });
    check('a zero is not reported as "nobody complained"',
      /does not mean nobody complained/i.test(z));
    check('and explains that most narratives are never published',
      /consented/.test(z));
    check('and says the database is consumer finance only',
      /no landlords, no utilities/.test(z));
    check('and warns the CFPB name is often the parent, not the brand',
      /normalised spelling/.test(z));
    check('and that zero complaints is not a clean record',
      /not a clean record/.test(z));
    const shape = C.diagnose({ results: [] });
    check('a schema mismatch is named as one and lists the keys it got',
      /schema/.test(shape) && /results/.test(shape));
  }

  // ══ 5. AN ALLEGATION IS NOT A FINDING ═════════════════════════════════
  {
    const src = fs.readFileSync(require.resolve('./registry.js'), 'utf8');
    // Matched on fragments that sit on ONE comment line. A phrase that
    // wraps across "//" lines never matches the file, and the check then
    // fails for a reason that has nothing to do with the behaviour.
    check('the source records that the CFPB does not verify the facts',
      /not verify the facts before publishing/.test(src));
    check('and that a complaint count measures market share',
      /companies by raw complaints measures market share/.test(src));
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('--company is plumbed through the CLI',
      /company: argv\.includes\('--company'\)/.test(cli));
    check('and --state, --product and --since take values, not the query',
      /\|state\|product\|since\)\$\/\.test\(a\)/.test(cli));
  }

  // ══ 6. AN ANNOUNCED FILTER THAT DID NOT APPLY ════════════════════════
  //
  // The first live run asked for --state OH and returned AZ, CA, ND, FL,
  // MA, SC, VA, NJ, CO and TX. Not one Ohio row. The request carried
  // state=OH, the service answered 200, and the header printed "state OH"
  // over a nationwide result set.
  //
  // That is worse than the 404 it replaced. A 404 stops you; a filter
  // silently ignored hands you plausible rows and lets you write "in Ohio"
  // over data from ten other states.
  {
    const rows = [
      { state: 'AZ', received: '2026-07-29', product: 'Checking or savings account' },
      { state: 'CA', received: '2026-07-29', product: 'Checking or savings account' },
      { state: 'OH', received: '2026-07-28', product: 'Checking or savings account' },
    ];
    const [w] = C.checkFilters(rows, { state: 'OH' });
    check('a state filter that did not apply is caught',
      !!w && w.filter === 'state' && w.applied === false, JSON.stringify(w));
    check('and it reports the states that actually came back',
      Array.isArray(w.observed) && w.observed.join(',') === 'AZ,CA,OH',
      JSON.stringify(w.observed));
    // WIDER IS NOT WRONG. A nationwide capture connects more dots than an
    // Ohio one; the fault would be FILING it as Ohio. So the note says keep
    // it and says what it must not be cited as.
    check('the note says keep it, and says what it is not',
      /keep it/.test(w.note) && /must not\s+be cited as one/.test(w.note), w.note);
    check('a filter that DID apply raises nothing',
      C.checkFilters([{ state: 'OH' }, { state: 'OH' }], { state: 'OH' }).length === 0);
    check('and no filter asked for raises nothing',
      C.checkFilters(rows, {}).length === 0);
    // Rows with no state at all are UNKNOWN, not violations. Counting a
    // blank as a mismatch would cry wolf on every capture that has them.
    check('rows with a blank state are not counted as mismatches',
      C.checkFilters([{ state: '' }, { state: 'OH' }], { state: 'OH' }).length === 0);

    const since = C.checkFilters(
      [{ received: '2023-05-01' }, { received: '2026-01-01' }], { since: '2024-01-01' });
    check('a date filter that did not apply is caught',
      since.length === 1 && since[0].observed === '2023-05-01', JSON.stringify(since));
    check('and one that did applies cleanly',
      C.checkFilters([{ received: '2025-01-01' }], { since: '2024-01-01' }).length === 0);

    // A PRODUCT filter only fires when NOT ONE row matches. A partial miss
    // is normal -- CFPB product strings are hierarchical -- and warning on
    // it would train the operator to ignore the warning.
    const prod = C.checkFilters([{ product: 'Mortgage' }, { product: 'Mortgage' }],
      { product: 'Checking or savings account' });
    check('a product filter that matched nothing is caught',
      prod.length === 1 && prod[0].filter === 'product'
        && /not one the CFPB uses/.test(prod[0].note), JSON.stringify(prod));
    check('but a partial match is not treated as a failure',
      C.checkFilters([{ product: 'Mortgage' }, { product: 'Checking or savings account' }],
        { product: 'Checking or savings account' }).length === 0);
  }

  // ══ 7. THE WARNING IS PRINTED WHERE IT CANNOT BE MISSED ══════════════
  {
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the CLI calls checkFilters on every connector that has it',
      /connFor\.checkFilters/.test(cli));
    check('and calls it a wider scope rather than a failure',
      /SCOPE IS WIDER THAN REQUESTED/.test(cli));
    check('and tells the operator to KEEP the wider capture',
      /KEEP IT — wider data connects more dots/.test(cli));
    check('and says the ledger records what actually came back',
      /records the scope actually returned/.test(cli));
    // Only when there are rows: checkFilters on an empty result would
    // report "no row matches" for every filtered search that found nothing,
    // which is the zero-result case and is already explained by diagnose().
    check('and only when rows came back',
      /checkFilters === 'function' && out\.results\.length/.test(cli));
  }

  // ══ 8. THE CAPTURE MUST CARRY THE TRUTH ABOUT ITSELF ═════════════════
  //
  // A capture outlives the session that made it. If the request asked for
  // one state and the service returned the country, the row that survives
  // is the ledger entry -- and a year from now it is the only thing that
  // can say what the file holds.
  {
    const src = fs.readFileSync(require.resolve('./registry.js'), 'utf8');
    check('runConnector records the scope beside the result',
      /scope: scopeNote/.test(src));
    check('and records the filters that were REQUESTED',
      /const requested = \{\};/.test(src) && /FILTER_KEYS/.test(src));
    // Recorded on success too. If only failures were written, a capture
    // with no scope note would be ambiguous between "filters worked" and
    // "nobody checked", and silence would get read as agreement.
    check('and records success as a positive fact, not as silence',
      /all_filters_applied: flags\.length === 0/.test(src));
    check('and marks the case where nothing was checked at all',
      /checked: false/.test(src));
    check('the reason a capture must describe itself is in the source',
      /a year from now it is the only thing/.test(src));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
