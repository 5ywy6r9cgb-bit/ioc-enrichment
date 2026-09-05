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

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
