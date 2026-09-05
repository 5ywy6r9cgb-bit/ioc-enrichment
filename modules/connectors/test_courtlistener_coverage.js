#!/usr/bin/env node
'use strict';
/**
 * test_courtlistener_coverage.js
 *
 * A search that prints "20 candidate lead(s)" and nothing else is showing a
 * PAGE SIZE. On this desk that page was about to answer "was the Comerica
 * dismissal one case or a pattern?" -- a question that is entirely a
 * question about a denominator.
 */

const R = require('./registry.js');

module.exports = function run() {
  let PASS = 0;
  let FAIL = 0;
  const check = (name, ok, detail) => {
    if (ok) { PASS++; console.log(`    PASS  ${name}`); }
    else { FAIL++; console.log(`    FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  };

  console.log('\n  courtlistener — a page is not a census\n');
  const C = R.CONNECTORS.courtlistener;

  // CourtListener v4 puts a URL in `count`, not a number. Reading it as a
  // number yields NaN; NaN comparisons are false; so `got < count` is false
  // and a capped page prints as COMPLETE. That exact quirk already marked a
  // 20-entry page of a 3,472-entry MDL docket complete in crosslink.
  {
    const url = 'https://www.courtlistener.com/api/rest/v4/search/?count=on&q=x';
    const c = C.coverage({ count: url, results: new Array(20) });
    check('a URL in count is never read as a total',
      /UNKNOWN/.test(c) && !/20 of/.test(c), c);
    check('and the page is explicitly called one page of an unknown total',
      /ONE PAGE of an unknown total/.test(c));
    check('and it says not to treat it as a census',
      /Do not treat this as a census/.test(c));
    check('and hands over the URL that produces the real number',
      c.includes(url), c);
  }

  // If a future API version returns a real number, use it.
  {
    const capped = C.coverage({ count: 57, results: new Array(20) });
    check('a numeric total is reported as a denominator',
      /20 of 57/.test(capped), capped);
    const whole = C.coverage({ count: 3, results: new Array(3) });
    check('and a complete result may say complete', /COMPLETE/.test(whole), whole);
  }

  // No count at all is UNKNOWN, never complete. Silence is not agreement.
  {
    const none = C.coverage({ results: [] });
    check('a missing count reports UNKNOWN, never complete',
      /UNKNOWN/.test(none) && !/COMPLETE/.test(none), none);
    check('and forbids counting the rows as all of them',
      /must not be counted as all/.test(none));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
