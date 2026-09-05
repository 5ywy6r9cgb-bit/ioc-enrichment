#!/usr/bin/env node
'use strict';
/**
 * test_abatements.js — the GASB 77 reader.
 *
 * Every check names the false sentence it prevents. The dangerous output
 * here is not a missed figure; it is a figure published as "what the deal
 * cost taxpayers", which GASB 77 never claims to be.
 */

const fs = require('fs');
const A = require('./abatements.js');

module.exports = function run() {
  let PASS = 0;
  let FAIL = 0;
  const check = (name, ok, detail) => {
    if (ok) { PASS++; console.log(`    PASS  ${name}`); }
    else { FAIL++; console.log(`    FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  };

  console.log('\n  abatements.js — what a government gave away, from its own audit\n');

  // ══ 1. THE FIGURE, IN THE SHAPES ACFRs ACTUALLY WRITE IT ══════════════
  {
    const a = A.amounts('abated $4,312,905 in property taxes and $1.2 million more, '
      + 'plus $850 thousand and $2.5 billion overall, and 4312905 with no sign');
    const got = a.map((x) => x.dollars);
    check('a comma-grouped figure is read as dollars',
      got.includes(4312905), JSON.stringify(got));
    check('and "million" is applied, not ignored',
      got.includes(1200000), JSON.stringify(got));
    check('and "thousand"', got.includes(850000));
    check('and "billion"', got.includes(2500000000));
    // A bare number with no dollar sign is a page number, a parcel count, a
    // year. Treating it as money is how "$4,312,905 abated" becomes
    // "$4,312,905 abated in 2024 across 2024 parcels".
    check('a number with no dollar sign is not money',
      a.filter((x) => x.dollars === 4312905).length === 1, JSON.stringify(got));
    check('the raw text is kept beside the number, so it can be quoted',
      a.some((x) => x.raw === '$4,312,905'));
  }

  // ══ 2. THE NOTE IS FOUND UNDER THE NAMES GOVERNMENTS USE ══════════════
  {
    for (const h of ['NOTE 18 - TAX ABATEMENT DISCLOSURES',
      'Tax Abatements', 'NOTE 12 — TAX ABATEMENT DISCLOSURE', 'Abated Taxes']) {
      const r = A.analyse(`${h}\nThe City abated $1,000 under agreements.`);
      check(`the note is found under "${h.slice(0, 34)}"`, r.headingFound, h);
    }
  }

  // ══ 3. OHIO NAMES THE PROGRAM, NOT THE ABATEMENT ══════════════════════
  //
  // An Ohio ACFR will say "Community Reinvestment Area" and never use the
  // word "abatement". A search for the generic word reports nothing and
  // reads as "this city abates nothing" -- the exact opposite of the truth.
  {
    const ohio = 'The City has entered into Community Reinvestment Area agreements '
      + 'under Ohio Revised Code Chapter 3735 and Enterprise Zone agreements.';
    const r = A.analyse(ohio);
    check('a document with no abatement heading reports headingFound false',
      r.headingFound === false);
    check('but the Ohio program names are still surfaced',
      r.programsAnywhere.some((p) => /Community Reinvestment/.test(p.program))
        && r.programsAnywhere.some((p) => /Enterprise Zone/.test(p.program)),
      JSON.stringify(r.programsAnywhere));
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('and the command refuses to call that "abates nothing"',
      /NOT a finding that this government abates nothing/.test(cli));
    check('and names an empty extraction as the other explanation',
      /no text layer looks/.test(cli));
  }

  // ══ 4. TIF IS THE CAVEAT THAT CHANGES THE ANSWER ══════════════════════
  //
  // A TIF does not forgive the tax, it DIVERTS it, and GASB has said TIFs
  // generally fall outside Statement 77. So a district can report a small
  // abatement figure while a large slice of its base is redirected, and
  // both statements are true. Publishing the abated figure alone as "the
  // cost" is wrong in the direction that flatters the deal.
  {
    const r = A.analyse('TAX ABATEMENTS\nAbated $1,000. The City maintains tax increment financing districts.');
    check('a document naming TIF is flagged', r.tifNamed === true);
    const clean = A.analyse('TAX ABATEMENTS\nAbated $1,000 under CRA agreements.');
    check('and one that does not is not flagged', clean.tifNamed === false);
    check('the abbreviation alone is enough to flag it',
      A.analyse('TAX ABATEMENTS\n$1 abated. See the TIF note.').tifNamed === true);
    // ...but not inside another word. "TIFFANY" is not a TIF.
    check('and TIF inside a longer word is not a TIF',
      A.analyse('TAX ABATEMENTS\n$1 abated by TIFFANY CORPORATION.').tifNamed === false);

    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the output says every figure is a floor, not the cost of the deal',
      /IS A FLOOR, NOT THE COST OF THE DEAL/.test(cli));
    check('and lists TIF as the first exclusion',
      /TIF is generally OUTSIDE Statement 77/.test(cli));
    check('and that a statutory exemption is not an agreement',
      /exempted by statute is not/.test(cli));
    check('and that the passive school-district loss is disclosed thinner',
      /in far less detail/.test(cli));
  }

  // ══ 5. A WINDOW THAT MISSES BEATS A BOUNDARY THAT INVENTS ═════════════
  //
  // Running the passage "to the next heading" would attribute the NEXT
  // note's dollar figures to this one. Missing a figure is recoverable;
  // inventing one is not.
  {
    const t = 'TAX ABATEMENTS\nAbated $500 this year.\n'
      + 'X'.repeat(4000) + '\nNOTE 19 - PENSIONS\nNet pension liability $99,000,000.';
    const [note] = A.analyse(t).notes;
    check('a figure far outside the window is not attributed to the note',
      !note.amounts.some((x) => x.dollars === 99000000),
      JSON.stringify(note.amounts.map((x) => x.raw)));
    check('and the note keeps its own figure', note.amounts.some((x) => x.dollars === 500));
    const src = fs.readFileSync(require.resolve('./abatements.js'), 'utf8');
    check('the reason for a fixed window is recorded in the source',
      /Missing is recoverable, inventing is not/.test(src));
  }

  // ══ 6. WRAPPED LINES AND EMPTY INPUT ══════════════════════════════════
  {
    const wrapped = A.analyse('TAX ABATEMENTS\nThe City abated $4,312,-\n905 in taxes.');
    check('a figure broken across a line break is rejoined',
      wrapped.notes[0].amounts.some((x) => x.dollars === 4312905),
      JSON.stringify(wrapped.notes[0].amounts.map((x) => x.raw)));
    // NOT recovered, on purpose: joining on whitespace alone would also
    // weld two adjacent figures in a table into one invented number, and an
    // invented figure is worse than a missing one.
    const spaced = A.analyse('TAX ABATEMENTS\nThe City abated $4,312,\n905 in taxes.');
    check('a figure split with no hyphen is NOT welded into a wrong number',
      !spaced.notes[0].amounts.some((x) => x.dollars === 4312905),
      JSON.stringify(spaced.notes[0].amounts.map((x) => x.raw)));
    const src2 = fs.readFileSync(require.resolve('./abatements.js'), 'utf8');
    check('and that choice is recorded where the next person will change it',
      /invented figure is worse than a missing one/.test(src2));

    const empty = A.analyse('');
    check('empty input yields no notes rather than throwing',
      empty.headingFound === false && empty.notes.length === 0 && empty.chars === 0);
    check('and null input does not throw', A.analyse(null).notes.length === 0);
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
