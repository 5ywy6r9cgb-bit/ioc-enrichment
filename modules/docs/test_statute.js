#!/usr/bin/env node
'use strict';
/**
 * test_statute.js — the section finder.
 *
 * Every fixture below is real text from Public Law 118-159, and every check
 * names the wrong answer a hand-rolled grep actually produced on it.
 */

const fs = require('fs');
const S = require('./statute.js');

module.exports = function run() {
  let PASS = 0;
  let FAIL = 0;
  const check = (name, ok, detail) => {
    if (ok) { PASS++; console.log(`    PASS  ${name}`); }
    else { FAIL++; console.log(`    FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  };

  console.log('\n  statute.js — which sections of a law say a thing\n');

  // ══ 1. THE WRAPPED HEADING (grep attempt 1 read 90 chars of one line) ══
  //
  //   SEC. 1214. STRATEGIC PARTNERSHIP ON DEFENSE INDUSTRIAL PRIOR-
  //              ITIES BETWEEN THE UNITED STATES AND ISRAEL.
  //
  // "ISRAEL" is on the second line. The section was invisible and the
  // reported count was 4 when the real answer was larger.
  {
    const t = [
      'SEC. 1214. STRATEGIC PARTNERSHIP ON DEFENSE INDUSTRIAL PRIOR-',
      '           ITIES BETWEEN THE UNITED STATES AND ISRAEL.',
      '   The Secretary of Defense shall seek to establish a partnership.',
    ].join('\n');
    const r = S.mentions(t, 'Israel');
    check('a heading that wraps mid-word is still found',
      r.matched.length === 1 && r.matched[0].number === '1214', JSON.stringify(r.matched));
    check('and the hyphenated word is rejoined, not left broken',
      /INDUSTRIAL PRIORITIES/.test(r.matched[0].heading), r.matched[0].heading);
  }

  // ══ 2. THE MARGINAL NOTE COLUMN (grep attempt 2 lost 1214 and 1215) ════
  //
  // This document interleaves a margin column into the text stream. Joining
  // the hyphen first produced "PRIORnote." and the heading terminated at
  // that stray period, so a heading search for Israel found nothing.
  {
    const t = [
      '22 USC 8606            SEC. 1214. STRATEGIC PARTNERSHIP ON DEFENSE INDUSTRIAL PRIOR-',
      'note.                               ITIES BETWEEN THE UNITED STATES AND ISRAEL.',
      '   The Secretary of Defense shall seek to establish a partnership.',
    ].join('\n');
    const r = S.mentions(t, 'Israel');
    check('a section behind a margin-note column is found',
      r.matched.length === 1 && r.matched[0].number === '1214', JSON.stringify(r.matched));
    check('the note does not terminate the heading at a stray period',
      !/PRIORnote/.test(r.matched[0].heading), r.matched[0].heading);
    check('and the heading reads through to the end',
      /UNITED STATES AND ISRAEL/.test(r.matched[0].heading), r.matched[0].heading);
    check('the real text on the note line is NOT thrown away with it',
      /ITIES BETWEEN/.test(S.flatten(t)));
    check('the USC citation is stripped from the heading too',
      !/8606/.test(r.matched[0].heading), r.matched[0].heading);
  }

  // ══ 3. THE SECTION WITH THE COUNTRY ONLY IN ITS BODY ═══════════════════
  //
  // Sec. 1213 REQUIRES annual joint military exercises and invitations to
  // the armed forces of Israel. Its heading says "SUBTERRANEAN WARFARE
  // MILITARY EXERCISES" and never names a country. Every heading-based
  // search on this desk missed it; it is arguably the most consequential
  // section of the six.
  {
    const t = [
      'SEC. 1213. REQUIREMENT TO CONDUCT SUBTERRANEAN WARFARE',
      '            MILITARY EXERCISES.',
      '   (2) shall include invitations for the armed forces of Israel,',
      'provided that the Government of Israel consents.',
    ].join('\n');
    const r = S.mentions(t, 'Israel');
    check('a section that names the term only in its body is found',
      r.matched.length === 1 && r.matched[0].number === '1213');
    check('and it is flagged as body-only, not silently mixed in',
      r.bodyOnly.includes('1213') && r.matched[0].inHeading === false);
    check('the mention count is the body count, not one per section',
      r.matched[0].hits === 2, String(r.matched[0].hits));
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the command explains what body-only means',
      /a search of headings cannot see/.test(cli));
  }

  // ══ 4. THE TABLE OF CONTENTS IS NOT THE LAW ════════════════════════════
  //
  // This Act prints its contents list twice. Counting it triples every
  // section and inflates every mention count with pointers, not provisions.
  {
    const t = [
      'Sec. 1211. Statement of policy ensuring Israel’s defense.',
      'Sec. 1212. Modification of United States-Israel anti-tunnel cooperation.',
      'SEC. 1211. STATEMENT OF POLICY ENSURING ISRAEL’S DEFENSE.',
      '   It is the policy of the United States to work with Israel.',
    ].join('\n');
    const r = S.mentions(t, 'Israel');
    check('the Title-Case contents list is not counted as sections',
      r.total === 1, `total ${r.total}`);
    check('and the ALL-CAPS body heading is',
      r.matched.length === 1 && r.matched[0].number === '1211');
  }

  // ══ 5. A DENOMINATOR, AND A PARSE FAILURE THAT SAYS SO ═════════════════
  //
  // "0 sections mention Israel" from a parse that found 0 sections is a
  // statement about the extraction, not the law. The two must never print
  // the same way.
  {
    const r = S.mentions('this document has no section headings at all', 'Israel');
    check('a document with no sections reports total 0, not a false absence',
      r.total === 0 && r.matched.length === 0);
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('and the command calls that a parser problem in red',
      /NO SECTIONS WERE PARSED/.test(cli));
    check('and says nothing can be concluded from it',
      /Nothing below can be concluded from it/.test(cli));
    check('the match count is always printed over the total',
      /section\(s\) mention/.test(cli) && /\$\{r\.matched\.length\} of \$\{r\.total\}/.test(cli));
    check('and a mention is not claimed to be a provision',
      /A MENTION IS NOT A PROVISION/.test(cli));
  }

  // ══ 6. THE BOUNDARY IS THE NEXT SECTION, NOT A FIXED WINDOW ════════════
  //
  // A term deep inside a long section belongs to that section. A fixed
  // character window would attribute it to whichever heading was nearest.
  {
    const t = [
      'SEC. 100. FIRST SECTION.',
      ...new Array(60).fill('   padding text that mentions nothing of interest here.'),
      '   buried deep in section 100, the word Israel appears.',
      'SEC. 101. SECOND SECTION.',
      '   nothing relevant.',
    ].join('\n');
    const r = S.mentions(t, 'Israel');
    check('a term far below its heading is attributed to the right section',
      r.matched.length === 1 && r.matched[0].number === '100', JSON.stringify(r.matched));
    check('and the following section is not credited with it',
      !r.matched.some((m) => m.number === '101'));
    check('both sections are still counted in the denominator', r.total === 2);
  }

  // ══ 7. SEARCH IS LITERAL BY DEFAULT ════════════════════════════════════
  //
  // A term with regex metacharacters must match itself. "U.S." searched as a
  // pattern matches "UXSY" and inflates every count silently.
  {
    const t = 'SEC. 1. A HEADING.\n   the U.S. and UXSY are different things.';
    const r = S.mentions(t, 'U.S.');
    check('a term with a dot matches the dot, not any character',
      r.matched.length === 1 && r.matched[0].hits === 1, JSON.stringify(r.matched));
    const re = S.mentions(t, /U\.S\./g);
    check('and an explicit RegExp is honoured as given',
      re.matched.length === 1 && re.matched[0].hits === 1);
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
